import { setIcon } from "obsidian";
import { basename, CalloutNode } from "../types";
import { calloutStyle } from "../ui/calloutStyle";

/** Shared one-line renderer for a callout in a suggest list (plain text, no MarkdownRender). */
export function renderCalloutRow(el: HTMLElement, node: CalloutNode) {
	el.addClass("cg-suggest-row");
	const { color, icon } = calloutStyle(node.type);

	const iconEl = el.createSpan({ cls: "cg-suggest-icon" });
	if (icon) setIcon(iconEl, icon);
	if (color) iconEl.style.color = `rgb(${color})`;

	const main = el.createDiv({ cls: "cg-suggest-main" });
	const title = main.createDiv({ cls: "cg-suggest-title" });
	title.createSpan({ cls: "cg-suggest-type", text: node.type });
	title.createSpan({ text: " " + node.displayName });

	const meta = main.createDiv({ cls: "cg-suggest-meta" });
	meta.createSpan({ cls: "cg-suggest-file", text: basename(node.path) });
	if (node.contentPreview) {
		meta.createSpan({ cls: "cg-suggest-preview", text: " · " + node.contentPreview });
	}
}
