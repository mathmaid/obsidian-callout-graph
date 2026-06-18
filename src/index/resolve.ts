import { App, parseLinktext, resolveSubpath, TFile } from "obsidian";

/**
 * Resolve a wikilink string to the callout-block it targets, if any.
 * Returns `{ path, blockId }` only when the link is a block subpath (`#^id`)
 * that resolves to an existing block; otherwise null.
 *
 * Uses the canonical resolver chain (parseLinktext + getFirstLinkpathDest +
 * resolveSubpath) with the same-file empty-path special case so a block id that
 * is reused across files still resolves within its own file.
 */
export function resolveBlockTarget(
	app: App,
	linkText: string,
	sourcePath: string,
): { path: string; blockId: string } | null {
	const { path, subpath } = parseLinktext(linkText);
	if (!subpath || !/^#\^/.test(subpath)) return null; // only `#^block` subpaths

	let targetFile: TFile | null;
	if (path === "") {
		const sf = app.vault.getAbstractFileByPath(sourcePath);
		targetFile = sf instanceof TFile ? sf : null;
	} else {
		targetFile = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	}
	if (!targetFile) return null;

	const cache = app.metadataCache.getFileCache(targetFile);
	if (!cache) return null;
	const res = resolveSubpath(cache, subpath);
	if (!res || res.type !== "block") return null;
	return { path: targetFile.path, blockId: res.block.id };
}
