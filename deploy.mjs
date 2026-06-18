// Copies the 3 runtime artifacts into your Obsidian vault's plugin directory.
// Source stays here (outside the vault); only main.js + manifest.json + styles.css
// land in the vault. Configure the vault path in a local, gitignored .deploy-target.json:
//   { "vault": "/absolute/path/to/your/vault" }
// or set the OBSIDIAN_VAULT environment variable.
import { copyFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

function resolveVault() {
	if (process.env.OBSIDIAN_VAULT) return process.env.OBSIDIAN_VAULT;
	if (existsSync(".deploy-target.json")) {
		try {
			const cfg = JSON.parse(readFileSync(".deploy-target.json", "utf8"));
			if (cfg.vault) return cfg.vault;
		} catch {
			/* fall through */
		}
	}
	return null;
}

const vault = resolveVault();
if (!vault) {
	console.error(
		"No vault configured. Create .deploy-target.json with {\"vault\": \"/path/to/vault\"} " +
			"or set OBSIDIAN_VAULT.",
	);
	process.exit(1);
}

const dest = join(vault, ".obsidian", "plugins", "callout-graph");
mkdirSync(dest, { recursive: true });

for (const f of ["main.js", "manifest.json", "styles.css"]) {
	if (!existsSync(f)) {
		console.error(`  ! missing ${f} — run \`npm run build\` first`);
		process.exit(1);
	}
	copyFileSync(f, join(dest, f));
	console.log(`  ✓ ${f} -> vault`);
}
console.log("Deployed. Toggle the plugin off/on in Obsidian (or install Hot-Reload).");
