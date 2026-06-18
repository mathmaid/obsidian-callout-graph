import { basename, CalloutGraphSettings, CalloutNode } from "../types";

const TYPE_WORDS = /\b(Theorem|Lemma|Proposition|Corollary|Definition|Remark|Conjecture|Example|Exercise|Claim|Assumption)\b/gi;

/** Derive a short alias from a callout's display name (drops type words, trims to ~24 chars). */
export function aliasFrom(displayName: string): string {
	let a = displayName.replace(TYPE_WORDS, "").replace(/\s+/g, " ").trim();
	a = a.replace(/^[#\d.\s:-]+/, "").replace(/[.:,;\s]+$/, "").trim();
	if (!a) a = displayName.trim();
	if (a.length > 24) a = a.slice(0, 24).trim();
	return a;
}

/**
 * Build the wikilink text for referencing `node` from `currentPath`:
 *  - same file:            [[#^id]]
 *  - cross file, short:    [[basename#^id]]
 *  - cross file, long:     [[basename#^id|alias^id]]
 * `embed` prepends `!` for the `![[...]]` embed form.
 */
export function buildLinkText(
	node: CalloutNode,
	currentPath: string,
	settings: CalloutGraphSettings,
	embed: boolean,
): string {
	const prefix = embed ? "!" : "";
	const id = node.blockId;
	if (!id) return ""; // unlabeled callouts cannot be block-referenced

	if (node.path === currentPath) return `${prefix}[[#^${id}]]`;

	const name = basename(node.path);
	if (name.length <= settings.longNameThreshold) {
		return `${prefix}[[${name}#^${id}]]`;
	}
	const alias = aliasFrom(node.displayName);
	return `${prefix}[[${name}#^${id}|${alias}^${id}]]`;
}
