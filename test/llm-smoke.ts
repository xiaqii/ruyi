/**
 * ruyi LLM smoke — Level 2: minimal real-LLM round trip, run before each release.
 * Costs a few hundred tokens. Requires config.local.json with a working LLM.
 * Without a local config there is no real key to test against, so the smoke
 * skips cleanly (exit 0) instead of failing on the example config's fake key.
 *
 * Run: node test/llm-smoke.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { complete } from "../src/llm.ts";
import { resolveLlm } from "../src/llm.ts";
import { PROJECT_ROOT } from "../src/config.ts";

if (!existsSync(resolve(PROJECT_ROOT, "config.local.json")) && !existsSync(resolve(PROJECT_ROOT, "config.json"))) {
	console.log("llm-smoke: no config.local.json — no real LLM key to test against, skipping");
	process.exit(0);
}

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
		// Smoke = connectivity + latency, not instruction-following: any non-empty
		// reply with real usage counts as pass (models occasionally chat instead of JSON).
		const good = r.text.trim().length > 0 && r.outputTokens > 0;
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

// Real explicit write round trip: remember (LLM merge judgement) → forget cleanup
try {
	const started = Date.now();
	const res = await fetch("http://127.0.0.1:8899/memories", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			kind: "knowledge",
			summary: "llm-smoke 写路径验证",
			content: "发布前的显式写入端到端验证记忆，写完即归档。",
			domain: "test",
			owner: "default",
		}),
		signal: AbortSignal.timeout(90_000),
	});
	const j = (await res.json()) as { id?: number; action?: string };
	const goodWrite = res.ok && typeof j.id === "number" && typeof j.action === "string";
	console.log(`${goodWrite ? "✓" : "✗"} explicit write (POST /memories) — ${Date.now() - started}ms, #${j.id} (${j.action})`);
	if (!goodWrite) failed++;
	if (j.id) {
		const f = await fetch(`http://127.0.0.1:8899/memories/${j.id}/forget`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		console.log(`${f.ok ? "✓" : "✗"} cleanup forget #${j.id}`);
		if (!f.ok) failed++;
	}
} catch (err) {
	failed++;
	console.error(`✗ explicit write round trip — ${err instanceof Error ? err.message : err}`);
}

console.log(failed === 0 ? "\nllm-smoke: all passed" : `\nllm-smoke: ${failed} FAILED`);
if (failed > 0) process.exit(1);
