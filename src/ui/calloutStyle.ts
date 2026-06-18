// Reuse the vault's callouts.css palette at runtime instead of hardcoding colors.
// Probes a hidden `.callout[data-callout=type]` element for --callout-color / --callout-icon,
// so Style Settings overrides and future snippet edits flow through automatically.

const cache = new Map<string, { color: string; icon: string }>();

export function calloutStyle(type: string): { color: string; icon: string } {
	const key = type.toLowerCase();
	const hit = cache.get(key);
	if (hit) return hit;

	const probe = document.body.createDiv({ cls: "callout" });
	probe.dataset.callout = key;
	probe.style.position = "absolute";
	probe.style.visibility = "hidden";
	probe.style.pointerEvents = "none";
	const cs = getComputedStyle(probe);
	const color = cs.getPropertyValue("--callout-color").trim(); // "241, 152, 55"
	const icon = cs.getPropertyValue("--callout-icon").trim().replace(/^lucide-/, "");
	probe.remove();

	const out = { color, icon };
	cache.set(key, out);
	return out;
}

export function clearCalloutStyleCache() {
	cache.clear();
}
