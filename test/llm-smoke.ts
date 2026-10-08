/**
 * ruyi LLM smoke — Level 2: minimal real-LLM round trip, run before each release.
 * Costs a few hundred tokens. Requires config.local.json with a working LLM.
 *
 * Run: node test/llm-smoke.ts
 */

import { complete } from "../src/llm.ts";
import { resolveLlm } from "../src/llm.ts";

let failed = 0;

async function check(step: string): Promise<void> {
	const llm = resolveLlm(step);
	const started = Date.now();
	try {
		const r = await complete({
			system: 'Reply with ONLY the JSON object {"ok":true}.',
			user: "ping",
			step,
			maxTokens: 256,
			timeoutMs: 90_000,
		});
		const ms = Date.now() - started;
		const good = r.text.includes("ok");
		console.log(`${good ? "✓" : "✗"} ${step} tier (${llm.protocol}/${llm.model}) — ${ms}ms, ${r.inputTokens}+${r.outputTokens} tokens`);
		if (!good) failed++;
	} catch (err) {
		failed++;
		console.error(`✗ ${step} tier (${llm.protocol}/${llm.model}) — ${err instanceof Error ? err.message : err}`);
	}
}

console.log("LLM smoke (both tiers):");
await check("rerank"); // recall tier
await check("extract"); // dream tier

// Real recall through the running service
try {
	const started = Date.now();
	const res = await fetch("http://127.0.0.1:8899/recall", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ query: "服务器部署", k: 2, owner: "default", mode: "deep" }),
		signal: AbortSignal.timeout(90_000),
	});
	const j = (await res.json()) as { memories?: unknown[] };
	console.log(`${res.ok ? "✓" : "✗"} deep recall via service — ${Date.now() - started}ms, ${j.memories?.length ?? 0} memories`);
	if (!res.ok) failed++;
} catch (err) {
	failed++;
	console.error(`✗ deep recall via service — ${err instanceof Error ? err.message : err}`);
}

console.log(failed === 0 ? "\nllm-smoke: all passed" : `\nllm-smoke: ${failed} FAILED`);
if (failed > 0) process.exit(1);
