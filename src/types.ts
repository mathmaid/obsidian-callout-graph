export interface CalloutNode {
	/** Canonical key: `${path}#^${blockId}`, or `${path}#L${startLine}` when unlabeled. */
	id: string;
	/** TFile.path of the containing note. */
	path: string;
	/** Block id without the leading `^`, e.g. "thm-hk-dS". null when the callout has no id. */
	blockId: string | null;
	/** Lowercased callout type tag, e.g. "theorem". */
	type: string;
	/** Raw first-line title after the `[!type]` tag (may be empty). */
	title: string;
	/** Resolved readable label (paren name > title-minus-type > id-minus-prefix > type+ordinal). */
	displayName: string;
	/** 0-based start line of the callout section. */
	startLine: number;
	/** 0-based end line of the callout section. */
	endLine: number;
	/** Plain-text body excerpt for list rendering. */
	contentPreview: string;
}

export interface CalloutGraphSettings {
	/** Basename length above which the inserter uses the alias form. */
	longNameThreshold: number;
	/** Ranking boost weight applied to log1p(referenceCount). */
	inDegreeWeight: number;
	/** Editor-suggest trigger string. Default ";;" — "@" is taken by latex-suite Greek snippets. */
	triggerString: string;
	/** Per-file, per-proof fold states. true = folded, false = open. */
	proofFoldStates: Record<string, Record<string, boolean>>;
}

export const DEFAULT_SETTINGS: CalloutGraphSettings = {
	longNameThreshold: 30,
	inDegreeWeight: 0.5,
	triggerString: ";;",
	proofFoldStates: {},
};

export function basename(path: string): string {
	const file = path.split("/").pop() ?? path;
	return file.replace(/\.md$/i, "");
}
