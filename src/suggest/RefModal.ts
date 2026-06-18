import { App, Editor, FuzzyMatch, FuzzySuggestModal } from "obsidian";
import { basename, CalloutNode } from "../types";
import { renderCalloutRow } from "./row";
import { buildLinkText } from "./insertText";
import { SuggestHost } from "./host";

/** Command-palette / hotkey entry point: full-vault fuzzy search, insert at the cursor. */
export class RefModal extends FuzzySuggestModal<CalloutNode> {
	private host: SuggestHost;
	private editor: Editor;
	private currentPath: string;

	constructor(app: App, host: SuggestHost, editor: Editor, currentPath: string) {
		super(app);
		this.host = host;
		this.editor = editor;
		this.currentPath = currentPath;
		this.setPlaceholder("Search callouts to reference… (Shift+Enter to embed)");
	}

	getItems(): CalloutNode[] {
		return this.host.index.queryAll().filter((n) => n.blockId);
	}

	getItemText(n: CalloutNode): string {
		return `${n.displayName} ${n.type} ${n.blockId} ${basename(n.path)}`;
	}

	renderSuggestion(match: FuzzyMatch<CalloutNode>, el: HTMLElement) {
		renderCalloutRow(el, match.item);
	}

	onChooseItem(n: CalloutNode, evt: MouseEvent | KeyboardEvent) {
		const embed = evt.shiftKey === true;
		const text = buildLinkText(n, this.currentPath, this.host.settings, embed);
		if (!text) return;
		this.editor.replaceSelection(text);
		this.host.recordRecent(n.id);
	}
}
