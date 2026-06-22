import { App, CachedMetadata, TFile } from "obsidian";
import { CalloutNode } from "../types";
import {
	extractPreview,
	parseCalloutFirstLine,
	resolveDisplayName,
} from "./parse";
import { resolveBlockTarget } from "./resolve";

export class CalloutIndex {
	private app: App;

	/** node id -> node */
	nodeById = new Map<string, CalloutNode>();
	/** file path -> nodes in document order */
	nodesByPath = new Map<string, CalloutNode[]>();
	/** authoritative: source file path -> (target callout id -> # of links to it in that file) */
	private refsByFile = new Map<string, Map<string, number>>();
	/** derived total reference count per callout, rebuilt from refsByFile */
	private refCount = new Map<string, number>();

	private listeners = new Set<() => void>();
	built = false;
	private building = false;
	private pending = false;

	constructor(app: App) {
		this.app = app;
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
	/** Total number of [[#^id]] links across the vault that point to this callout. */
	referenceCount(id: string): number {
		return this.refCount.get(id) ?? 0;
	}
	stats() {
		let labeled = 0;
		const byType = new Map<string, number>();
		let references = 0;
		for (const n of this.nodeById.values()) {
			if (n.blockId) labeled++;
			byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
		}
		for (const m of this.refsByFile.values()) for (const c of m.values()) references += c;
		return { nodes: this.nodeById.size, labeled, references, files: this.nodesByPath.size, byType };
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
		this.refsByFile.clear();
		this.refCount.clear();

		const files = this.app.vault.getMarkdownFiles();

		// Pass 1: nodes for every file (refs need all target nodes present first).
		// No gate on section.type — callouts are identified by the first-line regex
		// inside parseFileNodes, so we make no assumption about how Obsidian types them.
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache || !cache.sections || cache.sections.length === 0) continue;
			const content = await this.app.vault.cachedRead(file);
			this.parseFileNodes(file, content, cache);
		}

		// Pass 2: references from EVERY file — a note may cite callouts in prose
		// without containing any callout of its own.
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			this.parseFileRefs(file, cache);
		}

		this.rebuildRefCount();
		this.built = true;
		this.emit();
	}

	async reindexFile(file: TFile, data?: string, cache?: CachedMetadata | null) {
		if (this.building) {
			this.pending = true; // the in-flight full build will subsume this edit
			return;
		}
		const old = this.nodesByPath.get(file.path) ?? [];
		for (const n of old) this.nodeById.delete(n.id);
		this.nodesByPath.delete(file.path);
		this.refsByFile.delete(file.path);

		const fileCache = cache ?? this.app.metadataCache.getFileCache(file);
		if (fileCache && fileCache.sections && fileCache.sections.length) {
			const content = data ?? (await this.app.vault.cachedRead(file));
			this.parseFileNodes(file, content, fileCache);
			this.parseFileRefs(file, fileCache);
		}
		this.rebuildRefCount();
		this.emit();
	}

	dropFile(path: string) {
		if (this.building) {
			this.pending = true;
			return;
		}
		const old = this.nodesByPath.get(path) ?? [];
		for (const n of old) this.nodeById.delete(n.id);
		this.nodesByPath.delete(path);
		this.refsByFile.delete(path);
		this.rebuildRefCount();
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

	private parseFileRefs(file: TFile, cache: CachedMetadata) {
		const links = cache.links ?? [];
		if (links.length === 0) return;
		const perTarget = new Map<string, number>();

		for (const link of links) {
			const target = resolveBlockTarget(this.app, link.link, file.path);
			if (!target) continue; // not a #^block link (equation / citekey / unresolved)
			const targetId = `${target.path}#^${target.blockId}`;
			const targetNode = this.nodeById.get(targetId);
			if (!targetNode) continue; // target block is not a callout
			// Skip self-references: a link written inside the very callout it points to.
			const line = link.position.start.line;
			if (target.path === file.path && line >= targetNode.startLine && line <= targetNode.endLine) continue;
			perTarget.set(targetId, (perTarget.get(targetId) ?? 0) + 1);
		}

		if (perTarget.size) this.refsByFile.set(file.path, perTarget);
	}

	// --- reference bookkeeping ------------------------------------------------

	private rebuildRefCount() {
		this.refCount.clear();
		for (const perTarget of this.refsByFile.values()) {
			for (const [targetId, c] of perTarget) {
				this.refCount.set(targetId, (this.refCount.get(targetId) ?? 0) + c);
			}
		}
	}
}
