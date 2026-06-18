// Standalone verification of the parsing engine against the REAL vault, without
// Obsidian's metadataCache. Approximates callout sections by scanning contiguous
// `>`-prefixed line blocks. Validates the first-line regex, displayName ladder,
// block-id heuristic, proof detection, and edge extraction; prints sanity counts.
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
const PROOF_START = /^\s*\*\*\s*[Pp]roof\b.*?\*\*/;
const PROOF_END = /\$\s*\\(square|blacksquare|qed)\s*\$|∎|\\qedhere/;
const NAMED_PROOF = /\*\*\s*[Pp]roof\s+of\b/;
const TYPE_PREFIXES = ["theorem","definition","proposition","corollary","conjecture","assumption","exercise","example","remark","lemma","claim","thm","def","prop","cor","conj","rmk","lem","exp","ex","clm","as"];

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
	const re = /!?\[\[([^\]|#]*)#\^([\w-]+)(\|[^\]]*)?\]\]/g;
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

// Pass 2: edges
let edges = 0, eqDropped = 0, citekeyDropped = 0, selfLoops = 0, crossFile = 0, sameFile = 0;
let proofTotal = 0, proofsWithLink = 0, namedProofs = 0;
function resolveTarget(rel, name, blockId) {
	if (name === "") { // same file
		const n = nodeById.get(`${rel}#^${blockId}`);
		return n ?? null;
	}
	const cands = nodeByNameBlock.get(`${name}#^${blockId}`);
	return cands && cands.length ? cands[0] : null;
}

for (const [rel, nodes] of nodesByFile) {
	const lines = allContent.get(rel).split("\n");
	// proof regions
	const calloutStarts = new Set(nodes.map((n) => n.start));
	const regions = [];
	for (let i = 0; i < lines.length; i++) {
		if (!PROOF_START.test(lines[i])) continue;
		proofTotal++;
		const start = i;
		let end = lines.length - 1;
		for (let j = start; j < lines.length; j++) {
			if (j > start && calloutStarts.has(j)) { end = j - 1; break; }
			if (PROOF_END.test(lines[j])) { end = j; break; }
		}
		let owner = null, headerLine = -1;
		if (NAMED_PROOF.test(lines[start])) {
			namedProofs++;
			for (const l of linksOnLine(lines[start])) {
				const t = resolveTarget(rel, l.name, l.blockId);
				if (t) { owner = t; headerLine = start; break; }
			}
		}
		if (!owner) {
			let best = null;
			for (const n of nodes) if (n.start <= start && (!best || n.start > best.start)) best = n;
			owner = best;
		}
		regions.push({ start, end, owner, headerLine });
		i = end;
	}
	// scan links
	let proofHadLink = new Set();
	for (let ln = 0; ln < lines.length; ln++) {
		const links = linksOnLine(lines[ln]);
		if (!links.length) continue;
		// owner: containing callout body, else proof region
		let owner = null, isHeader = false;
		const containing = nodes.find((n) => ln >= n.start && ln <= n.end);
		if (containing) owner = containing;
		else {
			const region = regions.find((r) => ln >= r.start && ln <= r.end);
			if (region) { owner = region.owner; if (region.headerLine === ln) isHeader = true; if (region) proofHadLink.add(region.start); }
		}
		if (!owner) continue;
		for (const l of links) {
			if (isHeader) continue;
			const t = resolveTarget(rel, l.name, l.blockId);
			if (!t) { if (l.name && !nodeByNameBlock.has(`${l.name}#^${l.blockId}`)) eqDropped++; continue; }
			if (t.id === owner.id) { selfLoops++; continue; }
			edges++;
			if (t.path === owner.path) sameFile++; else crossFile++;
		}
	}
	proofsWithLink += proofHadLink.size;
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
console.log(`Dependency edges:     ${edges}  (same-file ${sameFile}, cross-file ${crossFile})`);
console.log(`  self-loops dropped: ${selfLoops}`);
console.log(`Proofs found:         ${proofTotal}  (named ${namedProofs}, with >=1 block-link ${proofsWithLink})`);
console.log(`Plain citekey links:  ${citekeyLinks}  (these never become edges)`);
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
