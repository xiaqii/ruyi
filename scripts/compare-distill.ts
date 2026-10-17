/**
 * A/B comparison: run both distillation pipelines ("single" one-shot vs "full"
 * extract→verify→merge) on the same session and print both action sets side by side.
 *
 * Usage: node scripts/compare-distill.ts <session-file.jsonl>
 */

import { runDream } from "../src/distill.ts";
import type { MergeAction } from "../src/types.ts";

const file = process.argv[2];
if (!file) {
	console.error("usage: node scripts/compare-distill.ts <session-file.jsonl>");
	process.exit(1);
}

function fmt(actions: MergeAction[]): string {
	if (actions.length === 0) return "  (no memories extracted)";
	return actions
		.map((a) => {
			const c = a.candidate;
			const head =
				a.action === "NEW"
					? "NEW"
					: `${a.action} #${(a as { id: number }).id}`;
			return `  ${head.padEnd(14)} [${c.kind}/${c.origin} ${c.confidence.toFixed(2)}] ${c.summary}`;
		})
		.join("\n");
}

const collected: Record<string, MergeAction[]> = {};
for (const pipeline of ["single", "full"] as const) {
	console.log(`\n=== pipeline: ${pipeline} ===`);
	const report = await runDream({
		dryRun: true,
		pipeline,
		onlySession: file,
		fullReprocess: true,
		onActions: (_f, p, actions) => {
			collected[p] = actions;
		},
	});
	console.log(fmt(collected[pipeline] ?? []));
	console.log(
		`  tokens: in ${report.inputTokens} / out ${report.outputTokens}` +
			(report.errors.length ? `\n  errors: ${report.errors.join("; ")}` : ""),
	);
}
