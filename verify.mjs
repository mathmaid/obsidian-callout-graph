// Standalone verification of the parsing engine against the REAL vault, without
// Obsidian's metadataCache. Approximates callout sections by scanning contiguous
// `>`-prefixed line blocks. Validates the first-line regex, displayName ladder,
// block-id heuristic, and reference counting; prints sanity counts.
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";

// Vault path from argv[2], OBSIDIAN_VAULT, or the gitignored .deploy-target.json.
function resolveVault() {
	if (process.argv[2]) return process.argv[2];
	if (process.env.OBSIDIAN_VAULT) return process.env.OBSIDIAN_VAULT;
	if (existsSync(".deploy-target.json")) {
		try {
			return JSON.parse(readFileSync(".deploy-target.json", "utf8")).vault ?? null;
		} catch {
			return null;
		}
	}
	return null;
}
const VAULT = resolveVault();
if (!VAULT) {
	console.error("No vault configured. Pass a path as the first arg, set OBSIDIAN_VAULT, or create .deploy-target.json.");
	process.exit(1);
}
const SKIP = new Set([".obsidian", ".trash", ".git", ".claude", "node_modules"]);

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (name.endsWith(".md")) out.push(p);
	}
	return out;
}

const CALLOUT_FIRST = /^>\s*\[!([A-Za-z]+)\]([+-]?)\s*(.*?)\s*$/;
const BLOCKID_LINE = /^>\s*\^([\w-]+)\s*$/;
const TYPE_PREFIXES =["theorem","definition","proposition","corollary","conjecture","assumption","exercise","example","remark","lemma","claim","thm","def","prop","cor","conj","rmk","lem","exp","ex","clm","as"];

function basename(p) { return (p.split("/").pop() ?? p).replace(/\.md$/i, ""); }

function resolveDisplayName(type, title, blockId, ord) {
	const paren = title.match(/\(([^)]*)\)/);
	if (paren) {
		const inner = paren[1].replace(/\[\[[^\]]*\]\]/g, "")
			.replace(/,?\s*(Theorem|Lemma|Proposition|Corollary|Definition|Remark|Section|Eq\.?|Equation|Chapter|p\.)\s*[\d.~-]*/gi, "")
			.replace(/\s+/g, " ").replace(/^[,;.\s]+|[,;.\s]+$/g, "").trim();
		if (inner && !/^\d/.test(inner)) return inner;
	}
	let t = title.replace(/\([^)]*\)/g, "").replace(/\[\[[^\]]*\]\]/g, "").trim();
	t = t.replace(new RegExp("^" + type + "\\b[\\s.:]*", "i"), "").trim().replace(/^[.:,;\s]+|[.:,;\s]+$/g, "").trim();
	if (t && /[A-Za-z0-9一-鿿]/.test(t)) return t;
	if (blockId) {
		let b = blockId;
		const low = blockId.toLowerCase();
		for (const p of TYPE_PREFIXES) if (low.startsWith(p + "-")) { b = blockId.slice(p.length + 1); break; }
		const looksRandom = !b.includes("-") && b.length <= 8 && (/\d/.test(b) || !/[aeiou]/i.test(b));
		if (b && !looksRandom) return b;
	}
	return `${type} #${ord}`;
}

// Parse one file into callout nodes by scanning contiguous `>` blocks.
function parseFile(path, content) {
	const lines = content.split("\n");
	const nodes = [];
	const ordinals = new Map();
	let i = 0;
	while (i < lines.length) {
		if (!/^>/.test(lines[i])) { i++; continue; }
		const start = i;
		let end = i;
		while (end + 1 < lines.length && /^>/.test(lines[end + 1])) end++;
		const m = lines[start].match(CALLOUT_FIRST);
		if (m) {
			const type = m[1].toLowerCase();
			const title = (m[3] ?? "").trim();
			let blockId = null;
			for (let j = start; j <= end; j++) {
				const bm = lines[j].match(BLOCKID_LINE);
				if (bm && !/^eq-/i.test(bm[1])) blockId = bm[1]; // last non-eq wins
			}
			const ord = (ordinals.get(type) ?? 0) + 1;
			ordinals.set(type, ord);
			const displayName = resolveDisplayName(type, title, blockId, ord);
			const id = blockId ? `${path}#^${blockId}` : `${path}#L${start}`;
			nodes.push({ id, path, blockId, type, title, displayName, start, end });
		}
		i = end + 1;
	}
	return nodes;
}

// All block-id wikilinks on a line: [[...#^id]] or [[#^id]] (and embeds).
function linksOnLine(line) {
	const out = [];
	const re = /(?<!!)\[\[([^\]|#]*)#\^([\w-]+)(\|[^\]]*)?\]\]/g;
	let m;
	while ((m = re.exec(line))) out.push({ name: m[1].trim(), blockId: m[2] });
	return out;
}

const files = walk(VAULT);
const allContent = new Map();
const nodesByFile = new Map();
const nodeById = new Map();
const nodeByNameBlock = new Map(); // `${basename}#^${id}` -> node[]

// Pass 1: nodes
for (const f of files) {
	const rel = f.slice(VAULT.length + 1);
	const content = readFileSync(f, "utf8");
	allContent.set(rel, content);
	const nodes = parseFile(rel, content);
	if (nodes.length) {
		nodesByFile.set(rel, nodes);
		for (const n of nodes) {
			nodeById.set(n.id, n);
			if (n.blockId) {
				const k = `${basename(rel)}#^${n.blockId}`;
				if (!nodeByNameBlock.has(k)) nodeByNameBlock.set(k, []);
				nodeByNameBlock.get(k).push(n);
			}
		}
	}
}

// Pass 2: references — every [[#^id]] link anywhere (incl. prose), counted raw.
let refs = 0, nonCalloutDropped = 0, selfRefs = 0, crossFile = 0, sameFile = 0;
function resolveTarget(rel, name, blockId) {
	if (name === "") { // same file
		const n = nodeById.get(`${rel}#^${blockId}`);
		return n ?? null;
	}
	const cands = nodeByNameBlock.get(`${name}#^${blockId}`);
	return cands && cands.length ? cands[0] : null;
}

for (const [rel, content] of allContent) {
	const lines = content.split("\n");
	const nodes = nodesByFile.get(rel) ?? []; // callouts in THIS file (for self-ref check)
	for (let ln = 0; ln < lines.length; ln++) {
		for (const l of linksOnLine(lines[ln])) {
			const t = resolveTarget(rel, l.name, l.blockId);
			if (!t) { nonCalloutDropped++; continue; } // equation / citekey / non-callout / unresolved
			// self-reference: link written inside the very callout it points to
			if (t.path === rel && ln >= t.start && ln <= t.end) { selfRefs++; continue; }
			refs++;
			if (t.path === rel) sameFile++; else crossFile++;
		}
	}
}

// also count plain citekey links [[Key]] (no #^) for context
let citekeyLinks = 0;
for (const content of allContent.values()) {
	const m = content.match(/(?<!!)\[\[[^\]#|]+\]\]/g);
	if (m) citekeyLinks += m.length;
}

let labeled = 0;
const byType = new Map();
for (const n of nodeById.values()) {
	if (n.blockId) labeled++;
	byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
}

console.log("=== Callout index sanity (standalone, line-scan approximation) ===");
console.log(`Files scanned:        ${files.length}`);
console.log(`Files with callouts:  ${nodesByFile.size}`);
console.log(`Callouts (nodes):     ${nodeById.size}   (plan target ~1,879)`);
console.log(`  labeled (^id):      ${labeled}   (plan target ~1,301)`);
console.log(`  unlabeled:          ${nodeById.size - labeled}`);
console.log(`References:           ${refs}  (same-file ${sameFile}, cross-file ${crossFile})`);
console.log(`  self-refs dropped:  ${selfRefs}`);
console.log(`  non-callout links:  ${nonCalloutDropped}  (equation / citekey / unresolved targets)`);
console.log(`Plain citekey links:  ${citekeyLinks}  (these are never counted)`);
console.log("Top types:");
for (const [t, c] of [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
	console.log(`  ${t.padEnd(12)} ${c}`);
}
console.log("\nSample displayNames (first 15 labeled):");
let shown = 0;
for (const n of nodeById.values()) {
	if (!n.blockId) continue;
	console.log(`  [${n.type}] "${n.displayName}"   <- ^${n.blockId}  |  title: "${n.title.slice(0, 50)}"`);
	if (++shown >= 15) break;
}
