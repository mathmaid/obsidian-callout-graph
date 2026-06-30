import { codeFolding, foldEffect, foldedRanges, foldService, foldState, unfoldEffect } from "@codemirror/language";
import { EditorSelection, Extension, StateEffect, Text as CMText } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { App, Editor, editorInfoField, MarkdownPostProcessorContext, TFile } from "obsidian";

const PROOF_START_RE = /^\s*\*\*(Proof(?:\s+of\b.*)?):\*\*\s*$/i;
const MAX_PROOF_BLOCKS = 400;
const scheduled = new WeakSet<HTMLElement>();

interface ProofRange {
	startLine: number;
	endLine: number;
	title: string;
}

interface EditorProofRange extends ProofRange {
	from: number;
	to: number;
}

export interface ToggleProofFoldResult {
	count: number;
	action: "folded" | "unfolded" | "unavailable";
}

export interface ProofFoldStateStore {
	get(path: string, key: string): boolean | undefined;
	set(path: string, key: string, folded: boolean): void;
}

export function proofFoldExtension(store: ProofFoldStateStore): Extension {
	const statePlugin = ViewPlugin.fromClass(
		class {
			private applyTimer: number | null = null;
			private applying = false;
			private applyAttempts = 0;

			constructor(
				private view: EditorView,
				private foldStore: ProofFoldStateStore,
			) {
				this.scheduleApply();
			}

			update(update: ViewUpdate) {
				if (update.docChanged) {
					this.applyAttempts = 0;
					this.scheduleApply();
				}
				if (!this.applying) this.persistExplicitFoldEffects(update);
			}

			destroy() {
				if (this.applyTimer !== null) window.clearTimeout(this.applyTimer);
			}

			private scheduleApply(delay = 100) {
				if (this.applyTimer !== null) window.clearTimeout(this.applyTimer);
				this.applyTimer = window.setTimeout(() => {
					this.applyTimer = null;
					this.applyStoredFoldState();
				}, delay);
			}

			private applyStoredFoldState() {
				const path = editorSourcePath(this.view);
				const ranges = findEditorProofRanges(this.view.state.doc);
				if ((!path || ranges.length === 0) && this.applyAttempts < 5) {
					this.applyAttempts++;
					this.scheduleApply(150);
					return;
				}
				if (!path) return;

				const effects: StateEffect<unknown>[] = [];
				let needsFoldState = false;

				for (const range of ranges) {
					const stored = this.foldStore.get(path, proofStateKey(range));
					if (stored === undefined) continue;

					const folded = isFolded(this.view, range);
					if (stored && !folded) {
						effects.push(foldEffect.of({ from: range.from, to: range.to }));
						needsFoldState = true;
					} else if (!stored && folded) {
						effects.push(unfoldEffect.of({ from: range.from, to: range.to }));
					}
				}

				if (effects.length === 0) return;
				if (needsFoldState && !this.view.state.field(foldState, false)) {
					effects.push(StateEffect.appendConfig.of(codeFolding()));
				}

				this.applying = true;
				this.view.dispatch({ effects });
				this.applying = false;
			}

			private persistExplicitFoldEffects(update: ViewUpdate) {
				const path = editorSourcePath(this.view);
				if (!path) return;

				const ranges = findEditorProofRanges(update.state.doc);
				for (const transaction of update.transactions) {
					for (const effect of transaction.effects) {
						const folded = effect.is(foldEffect) ? true : effect.is(unfoldEffect) ? false : null;
						if (folded === null) continue;

						const target = effect.value as { from: number; to: number };
						const range = ranges.find((proof) => proof.from === target.from && proof.to === target.to);
						if (range) this.foldStore.set(path, proofStateKey(range), folded);
					}
				}
			}
		},
	);

	return [
		foldService.of((state, lineStart) => {
			const line = state.doc.lineAt(lineStart);
			const range = findProofRangeFromDoc(state.doc, line.number - 1);
			return range ? { from: range.from, to: range.to } : null;
		}),
		statePlugin.of(store),
	];
}

export function scheduleProofFolding(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext, store: ProofFoldStateStore) {
	if (el.closest(".cg-panel, .cg-proof-fold")) return;

	const container = findRenderContainer(el);
	if (!container || scheduled.has(container)) return;

	scheduled.add(container);
	window.setTimeout(() => {
		scheduled.delete(container);
		void foldProofsInRenderedMarkdown(app, container, ctx.sourcePath, store);
	}, 50);
}

export async function foldProofsInRenderedMarkdown(app: App, root: HTMLElement, sourcePath: string, store: ProofFoldStateStore) {
	if (root.closest(".cg-proof-fold")) return;

	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!(file instanceof TFile)) return;

	const content = await app.vault.cachedRead(file);
	const ranges = findProofRanges(content.split("\n"));
	if (ranges.length === 0) return;

	for (const range of ranges) {
		wrapRenderedRange(root, range, sourcePath, store);
	}
}

export function toggleRenderedProofs(container: HTMLElement): number {
	const proofs = Array.from(container.querySelectorAll<HTMLDetailsElement>("details.cg-proof-fold"));
	if (proofs.length === 0) return 0;
	const shouldOpen = proofs.some((proof) => !proof.open);
	for (const proof of proofs) proof.open = shouldOpen;
	return proofs.length;
}

export function toggleEditorProofs(editor: Editor, store?: ProofFoldStateStore): ToggleProofFoldResult {
	const view = getEditorView(editor);
	if (!view) return { count: 0, action: "unavailable" };

	const ranges = findEditorProofRanges(view.state.doc);
	if (ranges.length === 0) return { count: 0, action: "folded" };

	const allFolded = ranges.every((range) => isFolded(view, range));
	const folded = !allFolded;
	dispatchFoldEffects(view, ranges, folded);
	persistEditorRanges(view, ranges, folded, store);
	return { count: ranges.length, action: allFolded ? "unfolded" : "folded" };
}

export function toggleEditorProofAtCursor(editor: Editor, store?: ProofFoldStateStore): ToggleProofFoldResult {
	const view = getEditorView(editor);
	if (!view) return { count: 0, action: "unavailable" };

	const cursor = editor.getCursor();
	const range = findEditorProofRanges(view.state.doc).find((proof) => cursor.line >= proof.startLine && cursor.line <= proof.endLine);
	if (!range) return { count: 0, action: "folded" };

	const folded = isFolded(view, range);
	const nextFolded = !folded;
	dispatchFoldEffects(view, [range], nextFolded);
	persistEditorRanges(view, [range], nextFolded, store);
	return { count: 1, action: folded ? "unfolded" : "folded" };
}

function findProofRanges(lines: string[]): ProofRange[] {
	const ranges: ProofRange[] = [];

	for (let i = 0; i < lines.length; i++) {
		const start = lines[i].match(PROOF_START_RE);
		if (!start) continue;

		const title = start[1].trim() + ".";
		const limit = Math.min(lines.length, i + MAX_PROOF_BLOCKS);
		for (let j = i + 1; j < limit; j++) {
			if (/^\s*\$\\square\$\s*$/.test(lines[j])) {
				ranges.push({ startLine: i, endLine: j, title });
				i = j;
				break;
			}
			if (j > i + 1 && PROOF_START_RE.test(lines[j])) break;
		}
	}

	return ranges;
}

function findEditorProofRanges(doc: CMText): EditorProofRange[] {
	const ranges: EditorProofRange[] = [];

	for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber++) {
		const range = findProofRangeFromDoc(doc, lineNumber - 1);
		if (!range) continue;
		ranges.push(range);
		lineNumber = range.endLine + 1;
	}

	return ranges;
}

function findProofRangeFromDoc(doc: CMText, startLine: number): EditorProofRange | null {
	if (startLine < 0 || startLine >= doc.lines) return null;

	const start = doc.line(startLine + 1);
	const match = start.text.match(PROOF_START_RE);
	if (!match) return null;

	const limit = Math.min(doc.lines, startLine + MAX_PROOF_BLOCKS);
	for (let lineNumber = startLine + 2; lineNumber <= limit; lineNumber++) {
			const line = doc.line(lineNumber);
			if (/^\s*\$\\square\$\s*$/.test(line.text)) {
				const from = start.to;
				const to = line.to;
				if (from >= to) return null;
			return {
				startLine,
				endLine: lineNumber - 1,
				title: match[1].trim() + ".",
				from,
				to,
			};
		}
		if (lineNumber > startLine + 2 && PROOF_START_RE.test(line.text)) break;
	}

	return null;
}

function wrapRenderedRange(root: HTMLElement, range: ProofRange, sourcePath: string, store: ProofFoldStateStore) {
	const start = elementForLine(root, range.startLine, range.endLine, "first");
	const end = elementForLine(root, range.startLine, range.endLine, "last");
	if (!start || !end || start.closest(".cg-proof-fold")) return;

	const common = nearestCommonAncestor(start, end, root);
	if (!common) return;

	const first = childUnder(common, start);
	const last = childUnder(common, end);
	if (!first || !last || first.parentElement !== common || last.parentElement !== common) return;
	if (last.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) return;

	const details = document.createElement("details");
	details.className = "cg-proof-fold";
	details.dataset.cgProofFold = "true";
	details.open = store.get(sourcePath, proofStateKey(range)) === false;

	const summary = document.createElement("summary");
	summary.className = "cg-proof-fold-summary";
	summary.textContent = range.title;
	details.appendChild(summary);

	const body = document.createElement("div");
	body.className = "cg-proof-fold-body";
	details.appendChild(body);

	details.addEventListener("toggle", () => {
		store.set(sourcePath, proofStateKey(range), !details.open);
	});

	common.insertBefore(details, first);

	let block: Element | null = first;
	while (block) {
		const next: Element | null = block.nextElementSibling;
		body.appendChild(block);
		if (block === last) break;
		block = next;
	}

	const titleBlock = findProofTitleBlock(body);
	if (titleBlock) {
		removeProofMarker(titleBlock);
		if (isEmptyBlock(titleBlock)) titleBlock.remove();
	}
}

function findRenderContainer(el: HTMLElement): HTMLElement | null {
	return el.closest<HTMLElement>(".markdown-reading-view, .markdown-preview-view") ?? el.parentElement;
}

function elementForLine(
	root: HTMLElement,
	startLine: number,
	endLine: number,
	side: "first" | "last",
): HTMLElement | null {
	const candidates = Array.from(root.querySelectorAll<HTMLElement>("[data-line]"))
		.map((el) => ({ el, line: parseLine(el) }))
		.filter((item): item is { el: HTMLElement; line: number } =>
			item.line !== null && item.line >= startLine && item.line <= endLine,
		);

	if (candidates.length === 0) return null;
	return side === "first" ? candidates[0].el : candidates[candidates.length - 1].el;
}

function parseLine(el: HTMLElement): number | null {
	const raw = el.dataset.line;
	if (!raw) return null;
	const line = Number.parseInt(raw, 10);
	return Number.isFinite(line) ? line : null;
}

function nearestCommonAncestor(a: HTMLElement, b: HTMLElement, stop: HTMLElement): HTMLElement | null {
	let cur: HTMLElement | null = a;
	while (cur) {
		if (cur.contains(b)) return cur;
		if (cur === stop) break;
		cur = cur.parentElement;
	}
	return stop.contains(a) && stop.contains(b) ? stop : null;
}

function childUnder(parent: HTMLElement, node: HTMLElement): Element | null {
	let cur: Element | null = node;
	while (cur && cur.parentElement !== parent) cur = cur.parentElement;
	return cur;
}

function removeProofMarker(block: HTMLElement) {
	const first = firstSignificantChild(block);
	if (!(first instanceof HTMLElement) || first.tagName !== "STRONG") return;
	first.remove();

	while (block.firstChild instanceof Text && block.firstChild.data.trim() === "") {
		block.firstChild.remove();
	}
	if (block.firstElementChild?.tagName === "BR") block.firstElementChild.remove();
	if (block.firstChild instanceof Text) {
		block.firstChild.data = block.firstChild.data.replace(/^\s+/, "");
	}
}

function findProofTitleBlock(body: HTMLElement): HTMLElement | null {
	const blocks = Array.from(body.querySelectorAll<HTMLElement>("p, li"));
	return blocks.find((block) => hasProofTitle(block)) ?? null;
}

function hasProofTitle(block: HTMLElement): boolean {
	const first = firstSignificantChild(block);
	if (!(first instanceof HTMLElement) || first.tagName !== "STRONG") return false;
	const text = normalizeSpace(first.textContent ?? "");
	return /^Proof(?:\s+of\b.*)?:$/i.test(text);
}

function firstSignificantChild(block: HTMLElement): ChildNode | null {
	for (const child of Array.from(block.childNodes)) {
		if (child instanceof Text && child.data.trim() === "") continue;
		return child;
	}
	return null;
}

function isEmptyBlock(block: HTMLElement): boolean {
	return normalizeSpace(block.textContent ?? "") === "" && block.querySelector("img, svg, canvas, mjx-container, table, pre, code") === null;
}

function normalizeSpace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function getEditorView(editor: Editor): EditorView | null {
	const cm = (editor as Editor & { cm?: EditorView }).cm;
	if (!cm || typeof cm.dispatch !== "function" || !cm.state) return null;
	return cm;
}

function editorSourcePath(view: EditorView): string | null {
	const info = view.state.field(editorInfoField, false);
	return info?.file?.path ?? null;
}

function isFolded(view: EditorView, range: EditorProofRange): boolean {
	let found = false;
	foldedRanges(view.state).between(range.from, range.to, (from, to) => {
		if (from === range.from && to === range.to) found = true;
	});
	return found;
}

function dispatchFoldEffects(view: EditorView, ranges: EditorProofRange[], folded: boolean) {
	const effects: StateEffect<unknown>[] = ranges.map((range) =>
		(folded ? foldEffect : unfoldEffect).of({ from: range.from, to: range.to }),
	);

	if (folded && !view.state.field(foldState, false)) {
		effects.push(StateEffect.appendConfig.of(codeFolding()));
	}

	const selection = folded ? selectionOutsideFoldedRanges(view, ranges) : null;
	view.dispatch(selection ? { effects, selection } : { effects });
}

function proofStateKey(range: ProofRange): string {
	return `v3:${range.startLine}:${range.endLine}:${range.title}`;
}

function persistEditorRanges(view: EditorView, ranges: EditorProofRange[], folded: boolean, store?: ProofFoldStateStore) {
	if (!store) return;
	const path = editorSourcePath(view);
	if (!path) return;

	for (const range of ranges) {
		store.set(path, proofStateKey(range), folded);
	}
}

function selectionOutsideFoldedRanges(view: EditorView, ranges: EditorProofRange[]): EditorSelection | null {
	for (const selection of view.state.selection.ranges) {
		const containingRange = ranges.find((range) => selection.head > range.from && selection.head <= range.to);
		if (containingRange) return EditorSelection.single(containingRange.from);
	}
	return null;
}
