import { App, CachedMetadata, TFile } from "obsidian";
import { CalloutGraphSettings, CalloutNode } from "../types";
import {
	extractPreview,
	isNamedProof,
	isProofEnd,
	isProofStart,
	parseCalloutFirstLine,
	resolveDisplayName,
} from "./parse";
import { resolveBlockTarget } from "./resolve";

interface ProofRegion {
	start: number;
	end: number;
	ownerId: string;
	headerLinkLine: number; // line of the named-proof locator link (excluded from edges); -1 if none
}

export class CalloutIndex {
	private app: App;
	private getSettings: () => CalloutGraphSettings;

	/** node id -> node */
	nodeById = new Map<string, CalloutNode>();
	/** file path -> nodes in document order */
	nodesByPath = new Map<string, CalloutNode[]>();
	/** authoritative out-edges, owned by the source */
	edgesBySource = new Map<string, Set<string>>();
	/** derived reverse index, rebuilt from edgesBySource */
	reverseEdges = new Map<string, Set<string>>();

	private listeners = new Set<() => void>();
	built = false;
	private building = false;
	private pending = false;

	constructor(app: App, getSettings: () => CalloutGraphSettings) {
		this.app = app;
		this.getSettings = getSettings;
	}

	// --- events ---------------------------------------------------------------

	onRebuilt(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}
	private emit() {
		for (const cb of this.listeners) cb();
	}

	// --- queries --------------------------------------------------------------

	queryAll(): CalloutNode[] {
		return [...this.nodeById.values()];
	}
	getForFile(file: TFile): CalloutNode[] {
		return this.getForPath(file.path);
	}
	getForPath(path: string): CalloutNode[] {
		return (this.nodesByPath.get(path) ?? []).slice().sort((a, b) => a.startLine - b.startLine);
	}
	/** All notes that contain at least one callout, with their callout counts. */
	pathsWithCallouts(): { path: string; count: number }[] {
		const out: { path: string; count: number }[] = [];
		for (const [path, nodes] of this.nodesByPath) out.push({ path, count: nodes.length });
		out.sort((a, b) => a.path.localeCompare(b.path));
		return out;
	}
	inDegree(id: string): number {
		return this.reverseEdges.get(id)?.size ?? 0;
	}
	outNeighbors(id: string): string[] {
		return [...(this.edgesBySource.get(id) ?? [])];
	}
	inNeighbors(id: string): string[] {
		return [...(this.reverseEdges.get(id) ?? [])];
	}
	stats() {
		let labeled = 0;
		const byType = new Map<string, number>();
		let edges = 0;
		for (const n of this.nodeById.values()) {
			if (n.blockId) labeled++;
			byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
		}
		for (const s of this.edgesBySource.values()) edges += s.size;
		return { nodes: this.nodeById.size, labeled, edges, files: this.nodesByPath.size, byType };
	}

	// --- build ----------------------------------------------------------------

	/** Public entry: serializes overlapping full builds (warm-cache + cold-cache `resolved`). */
	async build() {
		if (this.building) {
			this.pending = true;
			return;
		}
		this.building = true;
		try {
			await this._buildAll();
		} finally {
			this.building = false;
			if (this.pending) {
				this.pending = false;
				await this.build();
			}
		}
	}

	private async _buildAll() {
		this.nodeById.clear();
		this.nodesByPath.clear();
		this.edgesBySource.clear();
		this.reverseEdges.clear();

		const files = this.app.vault.getMarkdownFiles();
		const contentByPath = new Map<string, string>();

		// Pass 1: nodes for every file (edges need all nodes present first).
		// No gate on section.type — callouts are identified by the first-line regex
		// inside parseFileNodes, so we make no assumption about how Obsidian types them.
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache || !cache.sections || cache.sections.length === 0) continue;
			const content = await this.app.vault.cachedRead(file);
			this.parseFileNodes(file, content, cache);
			if (this.nodesByPath.get(file.path)?.length) contentByPath.set(file.path, content);
		}

		// Pass 2: edges.
		for (const file of files) {
			const content = contentByPath.get(file.path);
			if (content === undefined) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			this.parseFileEdges(file, content, cache);
		}

		this.rebuildReverse();
		this.built = true;
		this.emit();
	}

	async reindexFile(file: TFile, data?: string, cache?: CachedMetadata | null) {
		if (this.building) {
			this.pending = true; // the in-flight full build will subsume this edit
			return;
		}
		const old = this.nodesByPath.get(file.path) ?? [];
		for (const n of old) {
			this.nodeById.delete(n.id);
			this.edgesBySource.delete(n.id);
		}
		this.nodesByPath.delete(file.path);

		const fileCache = cache ?? this.app.metadataCache.getFileCache(file);
		if (fileCache && fileCache.sections && fileCache.sections.length) {
			const content = data ?? (await this.app.vault.cachedRead(file));
			this.parseFileNodes(file, content, fileCache);
			this.parseFileEdges(file, content, fileCache);
		}
		this.rebuildReverse();
		this.emit();
	}

	dropFile(path: string) {
		if (this.building) {
			this.pending = true;
			return;
		}
		const old = this.nodesByPath.get(path) ?? [];
		for (const n of old) {
			this.nodeById.delete(n.id);
			this.edgesBySource.delete(n.id);
		}
		this.nodesByPath.delete(path);
		this.rebuildReverse();
		this.emit();
	}

	// --- parsing --------------------------------------------------------------

	private parseFileNodes(file: TFile, content: string, cache: CachedMetadata) {
		const lines = content.split("\n");
		const blocks = cache.blocks ?? {};
		const ordinals = new Map<string, number>();
		const nodes: CalloutNode[] = [];

		for (const section of cache.sections ?? []) {
			const startLine = section.position.start.line;
			let endLine = section.position.end.line;
			const parsed = parseCalloutFirstLine(lines[startLine] ?? "");
			if (!parsed) continue; // first line isn't `> [!type] ...` -> not a callout

			// Extend over any trailing `>`-quoted lines the section boundary might have
			// excluded (defensive: a callout ending in a display $$...$$ could otherwise
			// drop its final `> ^id` line out of range and read as unlabeled).
			while (endLine + 1 < lines.length && /^>/.test(lines[endLine + 1])) endLine++;

			// The callout's own id is the last in-range block id that is NOT an equation (`eq-`).
			let blockId: string | null = null;
			let bestLine = -1;
			for (const id in blocks) {
				const bl = blocks[id].position.start.line;
				if (bl < startLine || bl > endLine) continue;
				if (/^eq-/i.test(id)) continue;
				if (bl > bestLine) {
					bestLine = bl;
					blockId = id;
				}
			}

			const ord = (ordinals.get(parsed.type) ?? 0) + 1;
			ordinals.set(parsed.type, ord);
			const displayName = resolveDisplayName(parsed.type, parsed.title, blockId, ord);
			const preview = extractPreview(lines.slice(startLine, endLine + 1));
			const id = blockId ? `${file.path}#^${blockId}` : `${file.path}#L${startLine}`;

			nodes.push({
				id, path: file.path, blockId, type: parsed.type, title: parsed.title,
				displayName, startLine, endLine, contentPreview: preview,
			});
		}

		if (nodes.length === 0) return;
		for (const n of nodes) this.nodeById.set(n.id, n);
		this.nodesByPath.set(file.path, nodes);
	}

	private detectProofRegions(filePath: string, lines: string[], cache: CachedMetadata, nodes: CalloutNode[]): ProofRegion[] {
		const headingLines = new Set((cache.headings ?? []).map((h) => h.position.start.line));
		const calloutStarts = new Set(nodes.map((n) => n.startLine));
		const links = cache.links ?? [];
		const regions: ProofRegion[] = [];

		for (let i = 0; i < lines.length; i++) {
			if (!isProofStart(lines[i])) continue;
			const start = i;
			let end = lines.length - 1;
			for (let j = start; j <= lines.length - 1; j++) {
				if (j > start && (headingLines.has(j) || calloutStarts.has(j))) {
					end = j - 1;
					break;
				}
				if (isProofEnd(lines[j])) {
					end = j;
					break;
				}
			}

			let ownerId: string | null = null;
			let headerLinkLine = -1;
			if (isNamedProof(lines[start])) {
				for (const l of links) {
					if (l.position.start.line !== start) continue;
					const t = resolveBlockTarget(this.app, l.link, filePath);
					if (!t) continue;
					const tid = `${t.path}#^${t.blockId}`;
					if (this.nodeById.has(tid)) {
						ownerId = tid;
						headerLinkLine = start;
						break;
					}
				}
			}
			if (!ownerId) {
				// bare proof: nearest preceding callout in this file
				let best: CalloutNode | null = null;
				for (const n of nodes) {
					if (n.startLine <= start && (!best || n.startLine > best.startLine)) best = n;
				}
				ownerId = best ? best.id : null;
			}

			if (ownerId) regions.push({ start, end, ownerId, headerLinkLine });
			i = end; // skip past this region
		}
		return regions;
	}

	private parseFileEdges(file: TFile, content: string, cache: CachedMetadata) {
		const settings = this.getSettings();
		const nodes = this.nodesByPath.get(file.path) ?? [];
		if (nodes.length === 0) return;
		const lines = content.split("\n");
		const links = cache.links ?? [];
		const proofRegions = this.detectProofRegions(file.path, lines, cache, nodes);

		for (const link of links) {
			const line = link.position.start.line;

			// Determine the owning callout.
			let ownerId: string | null = null;
			const containing = nodes.find((n) => line >= n.startLine && line <= n.endLine);
			if (containing) {
				if (!settings.bodyLinksAsEdges) continue;
				ownerId = containing.id;
			} else {
				const region = proofRegions.find((r) => line >= r.start && line <= r.end);
				if (region) {
					if (region.headerLinkLine === line) continue; // locator, not a dependency
					ownerId = region.ownerId;
				}
			}
			if (!ownerId) continue;

			const target = resolveBlockTarget(this.app, link.link, file.path);
			if (!target) continue;
			const targetId = `${target.path}#^${target.blockId}`;
			if (!this.nodeById.has(targetId)) continue; // target block is not a callout
			if (targetId === ownerId) continue; // self-loop
			this.addEdge(ownerId, targetId);
		}
	}

	// --- edge bookkeeping -----------------------------------------------------

	private addEdge(source: string, target: string) {
		let set = this.edgesBySource.get(source);
		if (!set) {
			set = new Set();
			this.edgesBySource.set(source, set);
		}
		set.add(target);
	}

	private rebuildReverse() {
		this.reverseEdges.clear();
		for (const [source, targets] of this.edgesBySource) {
			for (const t of targets) {
				let set = this.reverseEdges.get(t);
				if (!set) {
					set = new Set();
					this.reverseEdges.set(t, set);
				}
				set.add(source);
			}
		}
	}
}
