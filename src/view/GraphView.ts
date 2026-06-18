import { debounce, ItemView, MarkdownRenderer, MarkdownView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import ForceGraph from "force-graph";
import type { LinkObject, NodeObject } from "force-graph";
import { forceX, forceY } from "d3-force";
import type CalloutGraphPlugin from "../main";
import { basename, CalloutNode } from "../types";
import { GraphColors, themeColors, typeColor } from "./graphPaint";
import { calloutStyle } from "../ui/calloutStyle";
import { neighborhood, nontrivialSCCs } from "../graph/analysis";

export const CALLOUT_GRAPH_VIEW = "callout-graph-view";

interface GNode extends NodeObject {
	id: string;
	label: string;
	type: string;
	color: string;
	r: number;
	unlabeled: boolean;
	isolated: boolean;
	cycle: boolean;
}
interface GLink extends LinkObject<GNode> {
	source: string | GNode;
	target: string | GNode;
}

export class GraphView extends ItemView {
	private plugin: CalloutGraphPlugin;
	private fg: ForceGraph<GNode, GLink> | null = null;
	private colors: GraphColors = themeColors();
	private fontFamily = "sans-serif";
	private curLinks: GLink[] = [];
	private resizeObs: ResizeObserver | null = null;

	private mode: "global" | "focus" = "global";
	private hops = 2;
	private showIsolated = false;
	private activeTypes = new Set<string>(); // empty = all
	private focusId: string | null = null;
	private unsub: (() => void) | null = null;

	private selectedId: string | null = null;
	private hoverId: string | null = null;
	private hlNodes = new Set<string>();
	private hlLinksOut = new Set<GLink>();
	private hlLinksIn = new Set<GLink>();

	private chipsEl!: HTMLElement;
	private warnEl!: HTMLElement;
	private graphEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private tooltipEl!: HTMLElement;
	private infoEl!: HTMLElement;

	private modeGlobalBtn!: HTMLElement;
	private modeFocusBtn!: HTMLElement;
	private isoWrap!: HTMLElement;
	private hopWrap!: HTMLElement;

	private scheduleRebuild = debounce(() => this.rebuild(), 350, false);
	private hoverPreview = debounce((id: string, x: number, y: number) => void this.showPreview(id, x, y), 180, false);

	constructor(leaf: WorkspaceLeaf, plugin: CalloutGraphPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return CALLOUT_GRAPH_VIEW;
	}
	getDisplayText() {
		return "Callout graph";
	}
	getIcon() {
		return "git-fork";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("cg-graph-root");

		this.buildToolbar(root);
		this.chipsEl = root.createDiv({ cls: "cg-graph-chips" });
		this.warnEl = root.createDiv({ cls: "cg-graph-warn cg-hidden" });

		const wrap = root.createDiv({ cls: "cg-graph-wrap" });
		this.graphEl = wrap.createDiv({ cls: "cg-graph-canvas" });
		this.emptyEl = wrap.createDiv({ cls: "cg-graph-empty cg-hidden" });
		this.tooltipEl = wrap.createDiv({ cls: "cg-graph-tooltip cg-hidden" });
		this.infoEl = wrap.createDiv({ cls: "cg-graph-info cg-hidden" });

		this.statusEl = root.createDiv({ cls: "cg-graph-status" });

		this.unsub = this.plugin.index.onRebuilt(() => this.scheduleRebuild());
		this.syncToolbar();
		window.requestAnimationFrame(() => this.rebuild());
	}

	async onClose() {
		this.unsub?.();
		this.unsub = null;
		this.resizeObs?.disconnect();
		this.resizeObs = null;
		this.fg?._destructor();
		this.fg = null;
	}

	// --- toolbar --------------------------------------------------------------

	private buildToolbar(root: HTMLElement) {
		const bar = root.createDiv({ cls: "cg-graph-toolbar" });

		const modeGroup = bar.createDiv({ cls: "cg-seg" });
		this.modeGlobalBtn = modeGroup.createDiv({ cls: "cg-seg-btn", text: "Global" });
		this.modeGlobalBtn.onclick = () => {
			this.mode = "global";
			this.syncToolbar();
			this.rebuild();
		};
		this.modeFocusBtn = modeGroup.createDiv({ cls: "cg-seg-btn", text: "Focus" });
		this.modeFocusBtn.onclick = () => this.focusCurrent();

		this.isoWrap = bar.createDiv({ cls: "cg-tb-item" });
		const isoLabel = this.isoWrap.createEl("label", { cls: "cg-toggle" });
		const iso = isoLabel.createEl("input", { attr: { type: "checkbox" } });
		iso.checked = this.showIsolated;
		iso.onchange = () => {
			this.showIsolated = iso.checked;
			this.rebuild();
		};
		isoLabel.createSpan({ text: " isolated" });

		this.hopWrap = bar.createDiv({ cls: "cg-tb-item" });
		this.hopWrap.createSpan({ text: "hops " });
		const hop = this.hopWrap.createEl("input", { attr: { type: "range", min: "1", max: "4", step: "1" } });
		hop.value = String(this.hops);
		const hopVal = this.hopWrap.createSpan({ cls: "cg-hop-val", text: String(this.hops) });
		hop.oninput = () => {
			this.hops = parseInt(hop.value, 10);
			hopVal.setText(hop.value);
			this.scheduleRebuild();
		};

		const spacer = bar.createDiv({ cls: "cg-tb-spacer" });
		spacer.style.flex = "1";

		const relayout = bar.createDiv({ cls: "cg-icon-btn", attr: { "aria-label": "Re-energize layout" } });
		setIcon(relayout, "rotate-cw");
		relayout.onclick = () => this.fg?.d3ReheatSimulation();

		const fit = bar.createDiv({ cls: "cg-icon-btn", attr: { "aria-label": "Fit to view" } });
		setIcon(fit, "maximize");
		fit.onclick = () => this.fg?.zoomToFit(400, 30);
	}

	private syncToolbar() {
		this.modeGlobalBtn.toggleClass("cg-active", this.mode === "global");
		this.modeFocusBtn.toggleClass("cg-active", this.mode === "focus");
		this.isoWrap.toggleClass("cg-hidden", this.mode !== "global");
		this.hopWrap.toggleClass("cg-hidden", this.mode !== "focus");
	}

	private renderChips(presentTypes: string[]) {
		this.chipsEl.empty();
		for (const type of presentTypes) {
			const chip = this.chipsEl.createDiv({ cls: "cg-chip" });
			chip.dataset.callout = type;
			const { color } = calloutStyle(type);
			if (color) chip.style.setProperty("--cg-chip-color", `rgb(${color})`);
			chip.createSpan({ text: type });
			if (this.activeTypes.size && !this.activeTypes.has(type)) chip.addClass("cg-chip-off");
			chip.onclick = () => {
				if (this.activeTypes.has(type)) this.activeTypes.delete(type);
				else this.activeTypes.add(type);
				this.rebuild();
			};
		}
	}

	// --- focus ----------------------------------------------------------------

	private activeMarkdown(): MarkdownView | null {
		const v = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (v) return v;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) return leaf.view;
		}
		return null;
	}

	focusCurrent() {
		const view = this.activeMarkdown();
		if (!view || !view.file) {
			new Notice("Open a note and place the cursor in a callout first.");
			return;
		}
		const line = view.editor.getCursor().line;
		const nodes = this.plugin.index.getForPath(view.file.path);
		const hit = nodes.find((n) => line >= n.startLine && line <= n.endLine) ?? nodes[0];
		if (!hit) {
			new Notice("No callouts in this note.");
			return;
		}
		this.focusId = hit.id;
		this.mode = "focus";
		this.syncToolbar();
		this.rebuild();
	}

	// --- build ----------------------------------------------------------------

	private rebuild() {
		const idx = this.plugin.index;
		const allNodes = idx.queryAll();
		const allEdges = idx.allEdges();

		const deg = new Map<string, number>();
		for (const e of allEdges) {
			deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
			deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
		}

		let visible: Set<string>;
		if (this.mode === "focus") {
			if (!this.focusId || !idx.nodeById.has(this.focusId)) {
				this.renderEmpty('Place the cursor in a callout, then click "Focus".');
				return;
			}
			visible = neighborhood(this.focusId, this.hops, allEdges);
		} else {
			visible = new Set();
			for (const n of allNodes) if (this.showIsolated || (deg.get(n.id) ?? 0) > 0) visible.add(n.id);
		}

		const typeOk = (t: string) => this.activeTypes.size === 0 || this.activeTypes.has(t);
		const nodeList = allNodes.filter((n) => visible.has(n.id) && typeOk(n.type));
		const visIds = new Set(nodeList.map((n) => n.id));
		const edgeList = allEdges.filter((e) => visIds.has(e.source) && visIds.has(e.target));

		const sccNodes = new Set<string>();
		for (const comp of nontrivialSCCs([...visIds], edgeList)) for (const id of comp) sccNodes.add(id);

		this.colors = themeColors();
		const nodes: GNode[] = nodeList.map((n) => {
			const inDeg = idx.inDegree(n.id);
			return {
				id: n.id,
				label: (n.displayName || n.type).replace(/\$/g, ""),
				type: n.type,
				color: typeColor(n.type) || this.colors.muted,
				r: 3 + Math.min(9, Math.sqrt(inDeg) * 2.2),
				unlabeled: !n.blockId,
				isolated: (deg.get(n.id) ?? 0) === 0,
				cycle: sccNodes.has(n.id),
			};
		});
		const links: GLink[] = edgeList.map((e) => ({ source: e.source, target: e.target }));

		this.selectedId = null;
		this.hlNodes.clear();
		this.hlLinksOut.clear();
		this.hlLinksIn.clear();
		this.infoEl.addClass("cg-hidden");
		this.hideTooltip();
		this.emptyEl.addClass("cg-hidden");

		this.ensureGraph();
		this.curLinks = links;
		this.fg!.backgroundColor(this.colors.bg);
		this.fg!.graphData({ nodes, links });
		window.setTimeout(() => this.fg?.zoomToFit(500, 30), 400);

		const presentTypes = [...new Set(nodeList.map((n) => n.type))].sort();
		this.renderChips(presentTypes);

		const hidden = this.mode === "global" && !this.showIsolated ? allNodes.length - nodeList.length : 0;
		this.statusEl.setText(
			`${nodeList.length} nodes · ${edgeList.length} edges` +
				(hidden > 0 ? ` · ${hidden} isolated hidden` : "") +
				(this.mode === "focus" ? ` · ${this.hops}-hop focus` : ""),
		);
		this.renderWarnings();
	}

	private renderEmpty(msg: string) {
		this.curLinks = [];
		this.ensureGraph();
		this.fg!.graphData({ nodes: [], links: [] });
		this.emptyEl.setText(msg);
		this.emptyEl.removeClass("cg-hidden");
		this.statusEl.setText("");
		this.chipsEl.empty();
		this.renderWarnings();
	}

	// --- force-graph instance -------------------------------------------------

	private ensureGraph() {
		if (this.fg) return;
		this.colors = themeColors();
		this.fontFamily = getComputedStyle(document.body).getPropertyValue("--font-text").trim() || "sans-serif";

		const fg = new ForceGraph<GNode, GLink>(this.graphEl);
		fg.nodeId("id")
			.backgroundColor(this.colors.bg)
			.nodeRelSize(4)
			.nodeVal((n) => n.r)
			.nodeLabel(() => "")
			.nodeCanvasObject((n, ctx, s) => this.paintNode(n, ctx, s))
			.nodePointerAreaPaint((n, color, ctx) => this.pointerPaint(n, color, ctx))
			.linkColor((l) => this.linkColor(l))
			.linkWidth((l) => this.linkWidth(l))
			.linkDirectionalArrowLength((l) => this.arrowLen(l))
			.linkDirectionalArrowRelPos(1)
			.linkDirectionalArrowColor((l) => this.linkColor(l))
			.onNodeClick((n) => this.selectNode(n.id))
			.onNodeHover((n) => this.onHover(n))
			.onBackgroundClick(() => this.clearSelection())
			.onNodeDragEnd((n) => {
				n.fx = n.x;
				n.fy = n.y;
			})
			.warmupTicks(20)
			.cooldownTicks(140);

		const charge = fg.d3Force("charge") as { strength?: (v: number) => void } | undefined;
		charge?.strength?.(-48);
		const link = fg.d3Force("link") as { distance?: (v: number) => void } | undefined;
		link?.distance?.(30);
		// Gentle gravity toward the origin so separate clusters stay compact (Obsidian-like).
		fg.d3Force("x", forceX(0).strength(0.09) as never);
		fg.d3Force("y", forceY(0).strength(0.09) as never);

		this.fg = fg;
		this.applySize();
		this.resizeObs = new ResizeObserver(() => this.applySize());
		this.resizeObs.observe(this.graphEl);
	}

	private applySize() {
		if (!this.fg) return;
		const w = this.graphEl.clientWidth;
		const h = this.graphEl.clientHeight;
		if (w > 0 && h > 0) this.fg.width(w).height(h);
	}

	// --- painting -------------------------------------------------------------

	private paintNode(node: GNode, ctx: CanvasRenderingContext2D, scale: number) {
		const c = this.colors;
		const sel = this.selectedId;
		const dim = sel != null && !this.hlNodes.has(node.id);
		const x = node.x ?? 0;
		const y = node.y ?? 0;
		const r = node.r;

		ctx.globalAlpha = dim ? 0.12 : node.isolated ? 0.5 : 1;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, 2 * Math.PI);
		ctx.fillStyle = node.unlabeled ? c.bg : node.color || c.muted;
		ctx.fill();
		if (node.unlabeled) {
			ctx.lineWidth = 1.2 / scale;
			ctx.strokeStyle = node.color || c.muted;
			ctx.stroke();
		}
		if (node.cycle) {
			ctx.lineWidth = 2 / scale;
			ctx.strokeStyle = c.red;
			ctx.stroke();
		}
		if (node.id === sel) {
			ctx.lineWidth = 2.5 / scale;
			ctx.strokeStyle = c.accent;
			ctx.stroke();
		}

		const showLabel = !dim && (scale > 1.3 || node.id === this.hoverId || (sel != null && this.hlNodes.has(node.id)));
		if (showLabel) {
			ctx.globalAlpha = 1;
			ctx.font = `${11 / scale}px ${this.fontFamily}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "top";
			ctx.fillStyle = c.text;
			const label = node.label.length > 30 ? node.label.slice(0, 29) + "…" : node.label;
			ctx.fillText(label, x, y + r + 1.5 / scale);
		}
		ctx.globalAlpha = 1;
	}

	private pointerPaint(node: GNode, color: string, ctx: CanvasRenderingContext2D) {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(node.x ?? 0, node.y ?? 0, node.r + 2, 0, 2 * Math.PI);
		ctx.fill();
	}

	private linkColor(l: GLink): string {
		if (this.selectedId == null) return this.colors.linkDefault;
		if (this.hlLinksOut.has(l)) return this.colors.accent;
		if (this.hlLinksIn.has(l)) return this.colors.green;
		return this.colors.linkDim;
	}
	private linkWidth(l: GLink): number {
		return this.selectedId != null && (this.hlLinksOut.has(l) || this.hlLinksIn.has(l)) ? 2 : 1;
	}
	private arrowLen(l: GLink): number {
		return this.selectedId != null && (this.hlLinksOut.has(l) || this.hlLinksIn.has(l)) ? 4 : 0;
	}

	// --- selection / info -----------------------------------------------------

	private linkEnds(l: GLink): { s: string; t: string } {
		const s = typeof l.source === "object" ? l.source.id : l.source;
		const t = typeof l.target === "object" ? l.target.id : l.target;
		return { s, t };
	}

	private selectNode(id: string) {
		this.selectedId = id;
		this.hlNodes.clear();
		this.hlLinksOut.clear();
		this.hlLinksIn.clear();
		this.hlNodes.add(id);
		for (const l of this.curLinks) {
			const { s, t } = this.linkEnds(l);
			if (s === id) {
				this.hlLinksOut.add(l);
				this.hlNodes.add(t);
			}
			if (t === id) {
				this.hlLinksIn.add(l);
				this.hlNodes.add(s);
			}
		}
		this.showInfo(id);
	}

	private clearSelection() {
		this.selectedId = null;
		this.hlNodes.clear();
		this.hlLinksOut.clear();
		this.hlLinksIn.clear();
		this.infoEl.addClass("cg-hidden");
	}

	private showInfo(id: string) {
		const node = this.plugin.index.nodeById.get(id);
		if (!node) return;
		this.infoEl.empty();
		this.infoEl.removeClass("cg-hidden");

		const title = this.infoEl.createDiv({ cls: "cg-info-title" });
		title.createSpan({ cls: "cg-suggest-type", text: node.type });
		title.createSpan({ text: " " + node.displayName });

		const inDeg = this.plugin.index.inDegree(id);
		const outDeg = this.plugin.index.outNeighbors(id).length;
		this.infoEl.createDiv({
			cls: "cg-info-meta",
			text: `${basename(node.path)}  ·  uses ${outDeg}  ·  used by ${inDeg}`,
		});

		const actions = this.infoEl.createDiv({ cls: "cg-info-actions" });
		const open = actions.createEl("button", { text: "Open in note ↗" });
		open.onclick = () => this.jump(node);
		const focus = actions.createEl("button", { text: "Focus here" });
		focus.onclick = () => {
			this.focusId = id;
			this.mode = "focus";
			this.syncToolbar();
			this.rebuild();
		};
	}

	// --- hover preview --------------------------------------------------------

	private onHover(node: GNode | null) {
		this.hoverId = node ? node.id : null;
		this.graphEl.style.cursor = node ? "pointer" : "";
		if (!node || node.x == null || node.y == null) {
			this.hoverPreview.cancel();
			this.hideTooltip();
			return;
		}
		const sc = this.fg!.graph2ScreenCoords(node.x, node.y);
		this.hoverPreview(node.id, sc.x, sc.y);
	}

	private async showPreview(id: string, x: number, y: number) {
		const node = this.plugin.index.nodeById.get(id);
		if (!node) return;
		const file = this.app.vault.getAbstractFileByPath(node.path);
		if (!(file instanceof TFile)) return;
		const content = await this.app.vault.cachedRead(file);
		const raw = content
			.split("\n")
			.slice(node.startLine, node.endLine + 1)
			.filter((l) => !/^>\s*\^[\w-]+\s*$/.test(l))
			.join("\n");
		this.tooltipEl.empty();
		this.tooltipEl.removeClass("cg-hidden");
		await MarkdownRenderer.render(this.app, raw, this.tooltipEl, node.path, this);
		this.positionTooltip(x, y);
	}

	private positionTooltip(x: number, y: number) {
		const w = this.graphEl.clientWidth;
		const h = this.graphEl.clientHeight;
		const tw = Math.min(380, w - 16);
		this.tooltipEl.style.maxWidth = tw + "px";
		let left = x + 16;
		let top = y + 16;
		if (left + tw > w) left = Math.max(8, x - tw - 16);
		const th = this.tooltipEl.clientHeight || 160;
		if (top + th > h) top = Math.max(8, h - th - 8);
		this.tooltipEl.style.left = left + "px";
		this.tooltipEl.style.top = top + "px";
	}

	private hideTooltip() {
		this.tooltipEl.addClass("cg-hidden");
		this.tooltipEl.empty();
	}

	// --- warnings -------------------------------------------------------------

	private renderWarnings() {
		this.warnEl.empty();
		const idx = this.plugin.index;
		const dups = idx.duplicateBlockIds();
		const cycles = nontrivialSCCs(
			idx.queryAll().map((n) => n.id),
			idx.allEdges(),
		);
		if (!dups.length && !cycles.length) {
			this.warnEl.addClass("cg-hidden");
			return;
		}
		this.warnEl.removeClass("cg-hidden");
		const summary = this.warnEl.createDiv({ cls: "cg-warn-summary" });
		const icon = summary.createSpan({ cls: "cg-warn-icon" });
		setIcon(icon, "alert-triangle");
		const parts: string[] = [];
		if (cycles.length) parts.push(`${cycles.length} dependency cycle${cycles.length > 1 ? "s" : ""}`);
		if (dups.length) parts.push(`${dups.length} duplicate block id${dups.length > 1 ? "s" : ""}`);
		summary.createSpan({ text: " " + parts.join(" · ") });

		const detail = this.warnEl.createDiv({ cls: "cg-warn-detail cg-hidden" });
		summary.onclick = () => detail.toggleClass("cg-hidden", !detail.hasClass("cg-hidden"));

		for (const comp of cycles.slice(0, 12)) {
			const names = comp.map((id) => this.plugin.index.nodeById.get(id)?.displayName ?? id).join("  ⇄  ");
			const row = detail.createDiv({ cls: "cg-warn-row", text: "↻ " + names });
			row.onclick = () => {
				this.focusId = comp[0];
				this.mode = "focus";
				this.hops = 1;
				this.syncToolbar();
				this.rebuild();
			};
		}
		for (const d of dups.slice(0, 12)) {
			detail.createDiv({ cls: "cg-warn-row", text: `⧉ ^${d.blockId} ×${d.count} in ${basename(d.path)}` });
		}
	}

	// --- nav ------------------------------------------------------------------

	private jump(node: CalloutNode) {
		const linktext = node.blockId ? `${basename(node.path)}#^${node.blockId}` : basename(node.path);
		void this.app.workspace.openLinkText(linktext, node.path);
	}
}
