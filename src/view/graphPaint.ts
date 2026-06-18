import { calloutStyle } from "../ui/calloutStyle";

export interface GraphColors {
	text: string;
	muted: string;
	accent: string;
	border: string;
	bg: string;
	green: string;
	red: string;
	linkDefault: string;
	linkDim: string;
}

export function themeColors(): GraphColors {
	const cv = (n: string, f: string) => getComputedStyle(document.body).getPropertyValue(n).trim() || f;
	return {
		text: cv("--text-normal", "#dcddde"),
		muted: cv("--text-muted", "#999"),
		accent: cv("--interactive-accent", "#7b6cd9"),
		border: cv("--background-modifier-border", "#444"),
		bg: cv("--background-primary", "#1e1e1e"),
		green: "#46a35e",
		red: "#ff5555",
		linkDefault: "rgba(150, 150, 150, 0.28)",
		linkDim: "rgba(150, 150, 150, 0.05)",
	};
}

/** rgb(...) color for a callout type, from the vault's callouts.css palette. */
export function typeColor(type: string): string {
	const { color } = calloutStyle(type);
	return color ? `rgb(${color})` : "";
}
