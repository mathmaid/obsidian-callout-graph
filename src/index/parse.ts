// Pure string helpers for callout parsing. No Obsidian API here.

const CALLOUT_FIRST_LINE = /^>\s*\[!([A-Za-z]+)\]([+-]?)\s*(.*?)\s*$/;

/** Block-id prefixes used in this vault, longest-first so "lemma" is tried before "lem". */
const TYPE_PREFIXES = [
	"theorem", "definition", "proposition", "corollary", "conjecture",
	"assumption", "exercise", "example", "remark", "lemma", "claim",
	"thm", "def", "prop", "cor", "conj", "rmk", "lem", "exp", "ex", "clm", "as",
];

export function parseCalloutFirstLine(line: string): { type: string; title: string } | null {
	const m = line.match(CALLOUT_FIRST_LINE);
	if (!m) return null;
	return { type: m[1].toLowerCase(), title: (m[3] ?? "").trim() };
}

function capitalize(s: string): string {
	return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Readable label fallback ladder:
 *  1. parenthesized proper name (strip [[citekey]] and ", Theorem 3.5" citations)
 *  2. title minus leading type word and parenthetical/citation noise
 *  3. block id minus its type prefix
 *  4. capitalized type + per-file ordinal
 */
export function resolveDisplayName(
	type: string,
	title: string,
	blockId: string | null,
	ordinal: number,
): string {
	// 1. parenthesized proper name — but NOT a leading number (e.g. exercise points "(15分)", "(25')")
	const paren = title.match(/\(([^)]*)\)/);
	if (paren) {
		const inner = paren[1]
			.replace(/\[\[[^\]]*\]\]/g, "")
			.replace(/,?\s*(Theorem|Lemma|Proposition|Corollary|Definition|Remark|Section|Eq\.?|Equation|Chapter|p\.)\s*[\d.~-]*/gi, "")
			.replace(/\s+/g, " ")
			.replace(/^[,;.\s]+|[,;.\s]+$/g, "")
			.trim();
		if (inner && !/^\d/.test(inner)) return inner;
	}
	// 2. title minus parenthetical groups, wikilinks, and a leading type word
	let t = title.replace(/\([^)]*\)/g, "").replace(/\[\[[^\]]*\]\]/g, "").trim();
	t = t.replace(new RegExp("^" + type + "\\b[\\s.:]*", "i"), "").trim();
	t = t.replace(/^[.:,;\s]+|[.:,;\s]+$/g, "").trim();
	if (t && /[A-Za-z0-9一-鿿]/.test(t)) return t;
	// 3. block id minus type prefix — unless what's left looks like a random hex id
	//    (no dash, short, and either has a digit or no vowel: "b27z2r", "2cu5", "qpyyxq")
	if (blockId) {
		let b = blockId;
		const low = blockId.toLowerCase();
		for (const p of TYPE_PREFIXES) {
			if (low.startsWith(p + "-")) {
				b = blockId.slice(p.length + 1);
				break;
			}
		}
		const looksRandom = !b.includes("-") && b.length <= 8 && (/\d/.test(b) || !/[aeiou]/i.test(b));
		if (b && !looksRandom) return b;
	}
	// 4. type + ordinal
	return `${capitalize(type)} #${ordinal}`;
}

/** Build a plain-text excerpt from a callout's raw lines (strips `>`, `[!type]`, and `^id` lines). */
export function extractPreview(bodyLines: string[]): string {
	const out: string[] = [];
	for (let i = 0; i < bodyLines.length; i++) {
		let l = bodyLines[i].replace(/^>+\s?/, "");
		if (i === 0) l = l.replace(/^\s*\[![A-Za-z]+\]([+-]?)\s*/, "");
		if (/^\s*\^[\w-]+\s*$/.test(l)) continue; // drop block-id lines
		out.push(l);
	}
	let text = out.join(" ").replace(/\s+/g, " ").trim();
	if (text.length > 220) text = text.slice(0, 220) + "…";
	return text;
}
