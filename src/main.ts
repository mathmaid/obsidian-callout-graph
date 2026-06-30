import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin } from "obsidian";
import { CalloutGraphSettings, DEFAULT_SETTINGS } from "./types";
import { CalloutIndex } from "./index/CalloutIndex";
import { CalloutPanelView, CALLOUT_PANEL_VIEW } from "./panel/CalloutPanelView";
import { CalloutSuggest } from "./suggest/CalloutSuggest";
import { RefModal } from "./suggest/RefModal";
import { SuggestHost } from "./suggest/host";
import { CalloutGraphSettingTab } from "./settings";
import {
	ProofFoldStateStore,
	proofFoldExtension,
	scheduleProofFolding,
	toggleEditorProofAtCursor,
	toggleEditorProofs,
	toggleRenderedProofs,
} from "./proof/ProofFolding";

export default class CalloutGraphPlugin extends Plugin implements SuggestHost {
	settings!: CalloutGraphSettings;
	index!: CalloutIndex;

	private recent = new Map<string, number>();
	private recentSeq = 0;
	private proofStateSaveTimer: number | null = null;
	private proofFoldStore: ProofFoldStateStore = {
		get: (path, key) => this.getProofFoldState(path, key),
		set: (path, key, folded) => this.setProofFoldState(path, key, folded),
	};

	async onload() {
		await this.loadSettings();
		this.index = new CalloutIndex(this.app);

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
			id: "toggle-proof-folds",
			name: "Toggle all proof folds in current view",
			checkCallback: (checking) => this.toggleProofFolds(checking),
		});
		this.addCommand({
			id: "toggle-proof-fold-at-cursor",
			name: "Toggle proof fold at cursor",
			editorCheckCallback: (checking, editor) => this.toggleProofFoldAtCursor(checking, editor),
		});

		this.addCommand({
			id: "callout-graph-stats",
			name: "Show callout index stats",
			callback: () => {
				const s = this.index.stats();
				const top = [...s.byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
				const lines = [
					`Callouts: ${s.nodes} (labeled ${s.labeled}) in ${s.files} files`,
					`References: ${s.references}`,
					...top.map(([t, c]) => `  ${t}: ${c}`),
				];
				console.log("[callout-graph] " + lines.join("\n"));
				new Notice(lines.join("\n"), 10000);
			},
		});

		this.registerEditorSuggest(new CalloutSuggest(this.app, this));
		this.registerEditorExtension(proofFoldExtension(this.proofFoldStore));
		this.registerMarkdownPostProcessor((el, ctx) => scheduleProofFolding(this.app, el, ctx, this.proofFoldStore), 100);
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
		if (this.proofStateSaveTimer !== null) {
			window.clearTimeout(this.proofStateSaveTimer);
			this.proofStateSaveTimer = null;
			void this.saveSettings();
		}
	}

	private toggleProofFolds(checking: boolean): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return false;
		if (checking) return true;

		if (view.getMode() === "source") {
			const result = toggleEditorProofs(view.editor, this.proofFoldStore);
			const message =
				result.action === "unavailable"
					? "Editor folding is unavailable in this view."
					: result.count === 0
						? "No proofs found in the current editor."
						: `${result.action === "folded" ? "Folded" : "Unfolded"} ${result.count} proof${result.count === 1 ? "" : "s"}.`;
			new Notice(message);
			return true;
		}

		const container = view.containerEl;
		const count = toggleRenderedProofs(container);
		const message = count === 0 ? "No folded proofs in the current view." : `Toggled ${count} proof${count === 1 ? "" : "s"}.`;
		new Notice(message);
		return true;
	}

	private toggleProofFoldAtCursor(checking: boolean, editor: Editor): boolean {
		if (checking) return true;

		const result = toggleEditorProofAtCursor(editor, this.proofFoldStore);
		const message =
			result.action === "unavailable"
				? "Editor folding is unavailable in this view."
				: result.count === 0
					? "No proof found at the cursor."
					: `${result.action === "folded" ? "Folded" : "Unfolded"} current proof.`;
		new Notice(message);
		return true;
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
		const data = (await this.loadData()) as Partial<CalloutGraphSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...data,
			proofFoldStates: data?.proofFoldStates ?? {},
		};
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	private setProofFoldState(path: string, key: string, folded: boolean) {
		const states = this.settings.proofFoldStates;
		states[path] ??= {};
		if (states[path][key] === folded) return;

		states[path][key] = folded;
		this.scheduleProofStateSave();
	}

	private getProofFoldState(path: string, key: string): boolean | undefined {
		const states = this.settings.proofFoldStates[path];
		if (!states) return undefined;
		if (states[key] !== undefined) return states[key];

		if (key.startsWith("v3:")) {
			const legacyKey = key.slice(3);
			if (states[legacyKey] === true) return true;
			if (states[`v2:${legacyKey}`] === true) return true;
		}

		return undefined;
	}

	private scheduleProofStateSave() {
		if (this.proofStateSaveTimer !== null) window.clearTimeout(this.proofStateSaveTimer);
		this.proofStateSaveTimer = window.setTimeout(() => {
			this.proofStateSaveTimer = null;
			void this.saveSettings();
		}, 50);
	}
}
