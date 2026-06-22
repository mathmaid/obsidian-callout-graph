import { debounce, ItemView, MarkdownRenderer, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { basename, CalloutNode } from "../types";
import type CalloutGraphPlugin from "../main";
import { NotePickerModal } from "./NotePickerModal";

export const CALLOUT_PANEL_VIEW = "callout-review-panel";

export class CalloutPanelView extends ItemView {
	private plugin: CalloutGraphPlugin;

	private following = true; // true: track the active editor; false: pinned to pinnedPath
	private pinnedPath: string | null = null;
	private currentPath: string | null = null;
	private currentLines: string[] = [];
	private currentNodes: CalloutNode[] = [];
	private renderToken = 0;
	private unsub: (() => void) | null = null;

	private observer: IntersectionObserver | null = null;
	private pendingRender = new Map<Element, { raw: string; path: string }>();
	private scheduleRefresh = debounce(() => void this.refresh(), 400, false);

	private pinBtn!: HTMLElement;
	private titleEl!: HTMLElement;
	private listEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: CalloutGraphPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return CALLOUT_PANEL_VIEW;
	}
	getDisplayText() {
		return "Callouts";
	}
	getIcon() {
		return "gem";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("cg-panel");

		const bar = root.createDiv({ cls: "cg-panel-bar" });
		this.pinBtn = bar.createDiv({ cls: "cg-icon-btn cg-pin-btn" });
		setIcon(this.pinBtn, "pin");
		this.pinBtn.onclick = () => this.togglePin();

		this.titleEl = bar.createDiv({ cls: "cg-panel-note", attr: { "aria-label": "Pick another note" } });
		this.titleEl.onclick = () => this.openPicker();

		const pick = bar.createDiv({ cls: "cg-icon-btn", attr: { "aria-label": "Pick another note" } });
		setIcon(pick, "search");
		pick.onclick = () => this.openPicker();

		this.listEl = root.createDiv({ cls: "cg-panel-list" });

		// Navigation (note switch) refreshes immediately; content edits / index rebuilds
		// are debounced so typing doesn't re-render the panel on every keystroke.
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
			if (this.following) void this.refresh();
		}));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => {
			if (this.currentPath && file.path === this.currentPath) this.scheduleRefresh();
		}));
		this.unsub = this.plugin.index.onRebuilt(() => this.scheduleRefresh());

		this.updatePinButton();
		void this.refresh();
	}

	async onClose() {
		this.unsub?.();
		this.unsub = null;
		this.observer?.disconnect();
		this.observer = null;
	}

	private targetPath(): string | null {
		if (this.following) {
			const f = this.app.workspace.getActiveFile();
			return f && f.extension === "md" ? f.path : null;
		}
		return this.pinnedPath;
	}

	async refresh() {
		const path = this.targetPath();
		if (!path) return; // nothing to show; keep previous content
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		this.currentPath = path;
		const content = await this.app.vault.cachedRead(file);
		if (this.currentPath !== path) return; // raced with another switch
		this.currentLines = content.split("\n");
		this.currentNodes = this.plugin.index.getForPath(path);
		this.titleEl.setText(basename(path));
		this.renderList();
	}

	private togglePin() {
		if (this.following) {
			this.following = false;
			this.pinnedPath = this.currentPath;
		} else {
			this.following = true;
			this.pinnedPath = null;
		}
		this.updatePinButton();
		void this.refresh();
	}

	private openPicker() {
		const items = this.plugin.index.pathsWithCallouts();
		new NotePickerModal(this.app, items, (path) => {
			this.following = false;
			this.pinnedPath = path;
			this.updatePinButton();
			void this.refresh();
		}).open();
	}

	private updatePinButton() {
		this.pinBtn.toggleClass("cg-pinned", !this.following);
		this.pinBtn.setAttribute(
			"aria-label",
			this.following ? "Following active note — click to pin this note" : "Pinned — click to follow the active note",
		);
	}

	// --- list rendering (viewport-lazy) ---------------------------------------

	private renderList() {
		this.renderToken++;
		this.observer?.disconnect();
		this.pendingRender.clear();
		this.listEl.empty();

		if (this.currentNodes.length === 0) {
			this.listEl.createDiv({ cls: "cg-empty", text: "No callouts in this note." });
			return;
		}

		this.observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					const data = this.pendingRender.get(e.target);
					if (!data) continue;
					this.pendingRender.delete(e.target);
					this.observer?.unobserve(e.target);
					const el = e.target as HTMLElement;
					el.empty();
					void MarkdownRenderer.render(this.app, data.raw, el, data.path, this);
				}
			},
			{ root: this.listEl, rootMargin: "300px 0px" },
		);

		for (const node of this.currentNodes) {
			const { el, raw, path } = this.renderCardShell(node);
			this.pendingRender.set(el, { raw, path });
			this.observer.observe(el);
		}
	}

	private renderCardShell(node: CalloutNode): { el: HTMLElement; raw: string; path: string } {
		const card = this.listEl.createDiv({ cls: "cg-card" });
		card.dataset.callout = node.type;

		const meta = card.createDiv({ cls: "cg-card-bar" });
		const refs = this.plugin.index.referenceCount(node.id);
		const ref = meta.createSpan({ cls: "cg-card-ref", attr: { "aria-label": `Referenced ${refs} times` } });
		ref.setText("\u{1F4E5} " + refs);
		const jump = meta.createSpan({ cls: "cg-card-jump", attr: { "aria-label": "Open in note" } });
		setIcon(jump, "arrow-up-right");
		jump.onclick = () => this.jump(node);

		const body = card.createDiv({ cls: "cg-card-callout" });
		// Lightweight placeholder (gives the card height for the observer; replaced on render).
		body.createDiv({ cls: "cg-card-ph", text: node.displayName });
		// Drop `> ^block-id` lines so they don't render as literal "^id" text in the preview.
		const raw = this.currentLines
			.slice(node.startLine, node.endLine + 1)
			.filter((l) => !/^>\s*\^[\w-]+\s*$/.test(l))
			.join("\n");
		return { el: body, raw, path: node.path };
	}

	private jump(node: CalloutNode) {
		const linktext = node.blockId ? `${basename(node.path)}#^${node.blockId}` : basename(node.path);
		void this.app.workspace.openLinkText(linktext, node.path);
	}
}
