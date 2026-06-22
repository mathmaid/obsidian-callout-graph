import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	prepareFuzzySearch,
	TFile,
} from "obsidian";
import { basename, CalloutNode } from "../types";
import { renderCalloutRow } from "./row";
import { buildLinkText } from "./insertText";
import { SuggestHost } from "./host";

const SAME_FILE_BOOST = 3;
const LIMIT = 50;

export class CalloutSuggest extends EditorSuggest<CalloutNode> {
	private host: SuggestHost;

	constructor(app: App, host: SuggestHost) {
		super(app);
		this.host = host;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const trig = this.host.settings.triggerString || ";;";
		const sub = editor.getLine(cursor.line).slice(0, cursor.ch);
		const idx = sub.lastIndexOf(trig);
		if (idx === -1) return null;
		const query = sub.slice(idx + trig.length);
		if (/[\]\n]/.test(query)) return null;
		if (query.includes(trig)) return null;
		return { start: { line: cursor.line, ch: idx }, end: cursor, query };
	}

	getSuggestions(context: EditorSuggestContext): CalloutNode[] {
		const idx = this.host.index;
		const all = idx.queryAll().filter((n) => n.blockId);
		const currentPath = context.file?.path ?? "";
		const q = context.query.trim();
		const w = this.host.settings.inDegreeWeight;

		if (!q) {
			return all
				.map((n) => ({
					n,
					s:
						(n.path === currentPath ? SAME_FILE_BOOST : 0) +
						this.host.recencyScore(n.id) +
						Math.log1p(idx.referenceCount(n.id)) * w,
				}))
				.sort((a, b) => b.s - a.s)
				.slice(0, LIMIT)
				.map((x) => x.n);
		}

		const matcher = prepareFuzzySearch(q);
		const scored: { n: CalloutNode; s: number }[] = [];
		for (const n of all) {
			const hay = `${n.displayName} ${n.type} ${n.blockId} ${basename(n.path)}`;
			const r = matcher(hay);
			if (!r) continue;
			let s = r.score;
			if (n.path === currentPath) s += SAME_FILE_BOOST;
			s += Math.log1p(idx.referenceCount(n.id)) * w;
			s += this.host.recencyScore(n.id);
			scored.push({ n, s });
		}
		scored.sort((a, b) => b.s - a.s);
		return scored.slice(0, LIMIT).map((x) => x.n);
	}

	renderSuggestion(value: CalloutNode, el: HTMLElement) {
		renderCalloutRow(el, value);
	}

	selectSuggestion(value: CalloutNode, evt: MouseEvent | KeyboardEvent) {
		const ctx = this.context;
		if (!ctx) return;
		const embed = evt.shiftKey === true;
		const text = buildLinkText(value, ctx.file?.path ?? "", this.host.settings, embed);
		if (!text) return;
		ctx.editor.replaceRange(text, ctx.start, ctx.end);
		ctx.editor.setCursor({ line: ctx.start.line, ch: ctx.start.ch + text.length });
		this.host.recordRecent(value.id);
	}
}
