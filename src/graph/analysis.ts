export interface Edge {
	source: string;
	target: string;
}

/** Undirected N-hop neighborhood of a center node over the directed edge set. */
export function neighborhood(centerId: string, hops: number, edges: Edge[]): Set<string> {
	const adj = new Map<string, Set<string>>();
	const add = (a: string, b: string) => {
		let s = adj.get(a);
		if (!s) {
			s = new Set();
			adj.set(a, s);
		}
		s.add(b);
	};
	for (const e of edges) {
		add(e.source, e.target);
		add(e.target, e.source);
	}
	const seen = new Set<string>([centerId]);
	let frontier = [centerId];
	for (let h = 0; h < hops; h++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const nb of adj.get(id) ?? []) {
				if (!seen.has(nb)) {
					seen.add(nb);
					next.push(nb);
				}
			}
		}
		frontier = next;
	}
	return seen;
}

/**
 * Tarjan's strongly-connected-components, iterative (no recursion depth limit).
 * Returns only non-trivial components (size > 1) — real dependency cycles.
 */
export function nontrivialSCCs(nodeIds: string[], edges: Edge[]): string[][] {
	const adj = new Map<string, string[]>();
	for (const id of nodeIds) adj.set(id, []);
	for (const e of edges) {
		const a = adj.get(e.source);
		if (a && adj.has(e.target)) a.push(e.target);
	}

	let counter = 0;
	const idx = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const out: string[][] = [];

	for (const start of nodeIds) {
		if (idx.has(start)) continue;
		const callStack: { v: string; i: number }[] = [{ v: start, i: 0 }];
		while (callStack.length) {
			const frame = callStack[callStack.length - 1];
			const v = frame.v;
			if (frame.i === 0) {
				idx.set(v, counter);
				low.set(v, counter);
				counter++;
				stack.push(v);
				onStack.add(v);
			}
			const neighbors = adj.get(v) ?? [];
			if (frame.i < neighbors.length) {
				const w = neighbors[frame.i];
				frame.i++;
				if (!idx.has(w)) {
					callStack.push({ v: w, i: 0 });
				} else if (onStack.has(w)) {
					low.set(v, Math.min(low.get(v)!, idx.get(w)!));
				}
			} else {
				if (low.get(v) === idx.get(v)) {
					const comp: string[] = [];
					let w: string;
					do {
						w = stack.pop()!;
						onStack.delete(w);
						comp.push(w);
					} while (w !== v);
					if (comp.length > 1) out.push(comp);
				}
				callStack.pop();
				if (callStack.length) {
					const parent = callStack[callStack.length - 1].v;
					low.set(parent, Math.min(low.get(parent)!, low.get(v)!));
				}
			}
		}
	}
	return out;
}
