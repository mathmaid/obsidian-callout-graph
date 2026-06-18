import { Editor, MarkdownFileInfo, Notice, Plugin } from "obsidian";
import { CalloutGraphSettings, DEFAULT_SETTINGS } from "./types";
import { CalloutIndex } from "./index/CalloutIndex";
import { CalloutPanelView, CALLOUT_PANEL_VIEW } from "./panel/CalloutPanelView";
import { CalloutSuggest } from "./suggest/CalloutSuggest";
import { RefModal } from "./suggest/RefModal";
import { SuggestHost } from "./suggest/host";
import { CalloutGraphSettingTab } from "./settings";

export default class CalloutGraphPlugin extends Plugin implements SuggestHost {
	settings!: CalloutGraphSettings;
	index!: CalloutIndex;

	private recent = new Map<string, number>();
	private recentSeq = 0;

	async onload() {
		await this.loadSettings();
		this.index = new CalloutIndex(this.app, () => this.settings);

		this.registerView(CALLOUT_PANEL_VIEW, (leaf) => new CalloutPanelView(leaf, this));
		this.addRibbonIcon("gem", "Open callout panel", () => this.activatePanel());

		this.addCommand({
			id: "open-callout-panel",
			name: "Open callout panel",
			callback: () => this.activatePanel(),
		});

		this.addCommand({
			id: "insert-callout-ref",
			name: "Insert callout reference",
			editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
				const path = ctx.file?.path ?? "";
				new RefModal(this.app, this, editor, path).open();
			},
		});

		this.addCommand({
			id: "callout-graph-stats",
			name: "Show callout index stats",
			callback: () => {
				const s = this.index.stats();
				const top = [...s.byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
				const lines = [
					`Callouts: ${s.nodes} (labeled ${s.labeled}) in ${s.files} files`,
					`Dependency edges: ${s.edges}`,
					...top.map(([t, c]) => `  ${t}: ${c}`),
				];
				console.log("[callout-graph] " + lines.join("\n"));
				new Notice(lines.join("\n"), 10000);
			},
		});

		this.registerEditorSuggest(new CalloutSuggest(this.app, this));
		this.addSettingTab(new CalloutGraphSettingTab(this.app, this));

		// Index lifecycle: warm-cache build on layout ready, cold-cache (re)build on first `resolved`.
		this.app.workspace.onLayoutReady(() => {
			void this.index.build();
			const ref = this.app.metadataCache.on("resolved", () => {
				void this.index.build();
				this.app.metadataCache.offref(ref);
			});
			this.registerEvent(ref);
		});

		this.registerEvent(
			this.app.metadataCache.on("changed", (file, data, cache) => {
				void this.index.reindexFile(file, data, cache);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.index.dropFile(oldPath);
				if ("extension" in file && (file as { extension: string }).extension === "md") {
					void this.index.reindexFile(file as never);
				}
			}),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.index.dropFile(file.path)));
	}

	onunload() {
		// Do not detach the panel leaf on unload (per Obsidian guidance).
	}

	async activatePanel() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(CALLOUT_PANEL_VIEW)[0];
		if (!leaf) {
			const right = workspace.getRightLeaf(false);
			if (!right) return;
			leaf = right;
			await leaf.setViewState({ type: CALLOUT_PANEL_VIEW, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	// --- SuggestHost ----------------------------------------------------------

	recordRecent(id: string) {
		this.recent.set(id, ++this.recentSeq);
	}
	recencyScore(id: string): number {
		const s = this.recent.get(id);
		if (s === undefined || this.recentSeq === 0) return 0;
		return 1.5 * (s / this.recentSeq);
	}

	// --- settings -------------------------------------------------------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}
}
