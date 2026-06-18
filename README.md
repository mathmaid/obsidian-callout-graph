# Callout Dependency Graph

An [Obsidian](https://obsidian.md) plugin for note vaults built around **callouts** — theorems, lemmas, definitions, propositions, and the like. It indexes every callout in the vault and gives you three things:

1. **A reference inserter** — find and link any callout from anywhere without remembering where it lives or what its block id is.
2. **A side panel** — browse all callouts of any note at a glance (just the statements, no proofs), to review or to consult while writing elsewhere.
3. **A dependency graph** *(in progress)* — visualize which results depend on which, with edges parsed from the `[[#^block-id]]` links you actually write.

It is designed for a mathematical research vault: callouts of the form `> [!theorem] Theorem (Name).` with a trailing `> ^thm-id` block id, cross-referenced via `[[note#^thm-id]]` wikilinks. Node colors reuse your existing `callouts.css` palette.

## Features

### 1. Reference inserter

- **Inline:** type the trigger string (default `;;`) in the editor to open a fuzzy search over every labeled callout in the vault — by readable name, type, block id, or file. Selecting one inserts the correct link:
  - same note → `[[#^id]]`
  - other note → `[[note#^id]]`
  - long filename → alias form `[[note#^id|Name^id]]`
  - `Shift`+Enter inserts the embed form `![[...]]`
- **Command palette:** *"Insert callout reference"* opens the same search as a modal (bindable to a hotkey).
- Ranking favors same-note callouts, recently used ones, and frequently-cited ones.

> The default trigger is `;;` rather than `@@` because the [LaTeX Suite](https://github.com/artisticat1/obsidian-latex-suite) plugin commonly binds `@` to Greek-letter snippets. Change it in settings if you like.

### 2. Callout side panel

- Lists every callout of a note in document order, rendered with their native callout styling and math.
- **Not locked to the active note:** click the note name or the search icon to view any other note's callouts; pin (📌) to keep a reference note open while you write elsewhere.
- Each card shows how many times the callout is referenced, and a jump button to open it in place.
- Viewport-lazy rendering + debounced refresh keep it fast on large, math-heavy notes.

### 3. Dependency graph *(in progress)*

Edges are derived **only** from real `[[#^...]]` wikilinks: if the proof (or body) of result *A* links to result *B*, then *A* depends on *B*. No edges are fabricated. The graph grows as you add links while writing.

## How callouts are parsed

- A callout is any section whose first line matches `> [!type] Title`.
- Its block id is the trailing `> ^type-id` line (equation ids `^eq-...` are ignored).
- A readable label is derived from: a parenthesized proper name → the title minus its type word → the block id minus its prefix → `Type #n`.
- An edge `A → B` is added when a `[[#^id]]` link inside *A*'s body, or inside the proof attached to *A*, resolves to another callout *B*. Links to equation blocks and to Zotero citekeys never create edges; self-loops are dropped.

## Build & install

```bash
npm install
npm run build          # type-check + bundle to main.js
```

Then copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/callout-graph/` and enable the plugin in Obsidian.

For local development, configure your vault once in a (gitignored) `.deploy-target.json`:

```json
{ "vault": "/absolute/path/to/your/vault" }
```

and use:

```bash
npm run deploy         # build, then copy the 3 artifacts into your vault
npm run dev            # esbuild watch (rebuild on change)
node verify.mjs        # sanity-check the parser against your vault, no Obsidian needed
```

## License

MIT — see [LICENSE](LICENSE).
