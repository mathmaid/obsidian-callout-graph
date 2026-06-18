import { App, FuzzyMatch, FuzzySuggestModal } from "obsidian";
import { basename } from "../types";

type Item = { path: string; count: number };

/** Pick any note that contains callouts, to view it in the panel (decoupled from the active editor). */
export class NotePickerModal extends FuzzySuggestModal<Item> {
	private items: Item[];
	private onChoose: (path: string) => void;

	constructor(app: App, items: Item[], onChoose: (path: string) => void) {
		super(app);
		this.items = items;
		this.onChoose = onChoose;
		this.setPlaceholder("Pick a note to view its callouts…");
	}

	getItems(): Item[] {
		return this.items;
	}
	getItemText(i: Item): string {
		return i.path;
	}
	renderSuggestion(match: FuzzyMatch<Item>, el: HTMLElement) {
		el.addClass("cg-pick-row");
		el.createDiv({ cls: "cg-pick-name", text: basename(match.item.path) });
		el.createDiv({ cls: "cg-pick-meta", text: `${match.item.count} callouts · ${match.item.path}` });
	}
	onChooseItem(i: Item) {
		this.onChoose(i.path);
	}
}
