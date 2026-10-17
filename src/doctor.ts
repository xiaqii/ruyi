/**
 * `ruyi doctor` — self-diagnosis for fresh installs and troubleshooting.
 * Checks: DB, FTS (incl. Chinese), LLM connectivity+latency (both tiers),
 * session dirs, service. Prints PASS/WARN/FAIL per check; exit code 1 on FAIL.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { getDb, ftsSearch, memoryCounts } from "./db.ts";
import { resolveLlm } from "./llm.ts";

type Status = "PASS" | "WARN" | "FAIL";

function line(status: Status, label: string, detail = ""): boolean {
	const icon = status === "PASS" ? "✓" : status === "WARN" ? "!" : "✗";
	console.log(`${icon} [${status}] ${label}${detail ? ` — ${detail}` : ""}`);
	return status !== "FAIL";
}

async function checkLlm(step: string): Promise<boolean> {
	const llm = resolveLlm(step);
	const started = Date.now();
	try {
		const { complete } = await import("./llm.ts");
		const r = await complete({
			system: "Reply with ONLY the JSON object {\"ok\":true}.",
			user: "ping",
			step,
			maxTokens: 256,
			timeoutMs: 60_000,
		});
		const ms = Date.now() - started;
		const parsed = r.text.includes("ok");
		return line(
			ms < 30_000 ? "PASS" : "WARN",
			`LLM ${step} tier (${llm.protocol}/${llm.model})`,
			`${ms}ms, ${r.inputTokens}+${r.outputTokens} tokens${parsed ? "" : ", unexpected reply"}`,
		);
	} catch (err) {
		return line("FAIL", `LLM ${step} tier (${llm.protocol}/${llm.model})`, err instanceof Error ? err.message.slice(0, 200) : String(err));
	}
}

export async function runDoctor(): Promise<void> {
	const config = loadConfig();
	let ok = true;

	// 1. DB + counts
	try {
		const db = getDb(config.dbPath);
		const counts = memoryCounts(db);
		ok = line("PASS", "database", `${config.dbPath} · ${JSON.stringify(counts)}`) && ok;

		// 2. FTS Chinese self-test (trigram sanity)
		const probe = db
			.prepare(`SELECT id FROM memories WHERE status = 'active' LIMIT 1`)
			.get() as { id: number } | undefined;
		if (probe) {
			const row = db.prepare(`SELECT summary FROM memories WHERE id = ?`).get(probe.id) as { summary: string };
			const term = row.summary.replace(/[^\u4e00-\u9fff]/g, "").slice(0, 3) || row.summary.split(/\s+/)[0] || "";
			if (term.length >= 3) {
				const hits = ftsSearch(db, term, 5, "default");
				ok = line(hits.length > 0 ? "PASS" : "FAIL", "FTS Chinese retrieval", `probe "${term}" → ${hits.length} hits`) && ok;
			} else {
				line("WARN", "FTS Chinese retrieval", "no suitable probe term found");
			}
		} else {
			line("WARN", "FTS Chinese retrieval", "store is empty — nothing to probe");
		}
	} catch (err) {
		ok = line("FAIL", "database", err instanceof Error ? err.message : String(err)) && ok;
	}

	// 3. Session dirs
	for (const s of config.sessions) {
		const exists = existsSync(s.dir);
		ok = line(exists ? "PASS" : "WARN", `session dir (${s.agent})`, s.dir + (exists ? "" : " — not found")) && ok;
	}

	// 4. LLM tiers
	ok = (await checkLlm("rerank")) && ok;
	ok = (await checkLlm("extract")) && ok;

	// 5. pi extension presence
	const ext = resolve(homedir(), ".pi/agent/extensions/ruyi.ts");
	line(existsSync(ext) ? "PASS" : "WARN", "pi extension", existsSync(ext) ? ext : `not at ${ext} (install per AGENT.README.md)`);

	// 6. Service (when doctor runs out-of-process)
	try {
		const res = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(2000) });
		ok = line(res.ok ? "PASS" : "WARN", "HTTP service", `http://${config.host}:${config.port}`) && ok;
	} catch {
		line("WARN", "HTTP service", `not reachable at http://${config.host}:${config.port} (start with: node src/cli.ts serve)`);
	}

	console.log(ok ? "\ndoctor: all critical checks passed" : "\ndoctor: FAILURES above need attention");
	if (!ok) process.exit(1);
}
