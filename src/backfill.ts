/**
 * Backfill retrieval keywords for memories that predate the keywords column.
 * Batches 20 memories per LLM call; safe to re-run (only fills empty keywords).
 */

import { loadConfig } from "./config.ts";
import { getDb, logMemoryAction } from "./db.ts";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import type { MemoryRow } from "./types.ts";

const BATCH = 20;

export async function backfillKeywords(owner: string, limit?: number): Promise<{ updated: number; batches: number }> {
	const config = loadConfig();
	const db = getDb(config.dbPath);

	const sql =
		`SELECT * FROM memories WHERE keywords = '' AND status != 'archived' AND owner = ? ORDER BY id` +
		(limit ? ` LIMIT ${Number(limit)}` : "");
	const rows = db.prepare(sql).all(owner) as unknown as MemoryRow[];
	if (rows.length === 0) return { updated: 0, batches: 0 };

	let updated = 0;
	let batches = 0;
	const update = db.prepare(`UPDATE memories SET keywords = ?, updated_at = ? WHERE id = ? AND keywords = ''`);

	for (let i = 0; i < rows.length; i += BATCH) {
		const batch = rows.slice(i, i + BATCH);
		const listing = batch.map((m) => `[id ${m.id}] (${m.kind}) ${m.summary}\n${m.content.slice(0, 300)}`).join("\n\n");
		try {
			const result = await completeJson<{ keywords: { id: number; keywords: string[] }[] }>({
				system: loadPrompt("backfill-keywords"),
				user: `MEMORIES:\n${listing}`,
				step: "backfill-keywords",
				runId: `backfill-${Date.now()}`,
			});
			batches++;
			const byId = new Map((result.keywords ?? []).map((k) => [k.id, k.keywords]));
			const t = new Date().toISOString();
			for (const m of batch) {
				const kws = byId.get(m.id);
				if (!Array.isArray(kws) || kws.length === 0) continue;
				const kw = kws.map((k) => String(k).trim()).filter(Boolean).slice(0, 8).join(" ");
				if (!kw) continue;
				update.run(kw, t, m.id);
				updated++;
			}
			console.log(`[backfill] batch ${batches}: ${i + batch.length}/${rows.length}`);
		} catch (err) {
			console.error(`[backfill] batch at ${i} failed, skipping: ${err instanceof Error ? err.message : err}`);
		}
	}
	logMemoryAction(db, null, "BACKFILL_KEYWORDS", { updated, batches });
	return { updated, batches };
}

/**
 * Backfill one-line positioning handles (mini) for memories that predate the
 * mini column. Batches 20 per call; safe to re-run (only fills empty minis).
 * Dream tier: this line is the store's front door — quality matters.
 */
export async function backfillMinis(owner: string, limit?: number): Promise<{ updated: number; batches: number }> {
	const config = loadConfig();
	const db = getDb(config.dbPath);

	const sql =
		`SELECT * FROM memories WHERE mini = '' AND status = 'active' AND owner = ? ORDER BY id` +
		(limit ? ` LIMIT ${Number(limit)}` : "");
	const rows = db.prepare(sql).all(owner) as unknown as MemoryRow[];
	if (rows.length === 0) return { updated: 0, batches: 0 };

	let updated = 0;
	let batches = 0;
	const update = db.prepare(`UPDATE memories SET mini = ?, updated_at = ? WHERE id = ? AND mini = ''`);

	for (let i = 0; i < rows.length; i += BATCH) {
		const batch = rows.slice(i, i + BATCH);
		const listing = batch.map((m) => ({ id: m.id, summary: m.summary, content: m.content.slice(0, 500) }));
		try {
			const result = await completeJson<{ minis: { id: number; mini: string }[] }>({
				system: loadPrompt("backfill-mini"),
				user: JSON.stringify(listing),
				step: "backfill-mini",
				maxTokens: 4000,
			});
			batches++;
			const byId = new Map((result.minis ?? []).map((x) => [x.id, x.mini]));
			const t = new Date().toISOString();
			for (const m of batch) {
				const mini = String(byId.get(m.id) ?? "").trim().slice(0, 60);
				if (!mini) continue;
				update.run(mini, t, m.id);
				updated++;
			}
			console.log(`[backfill-mini] batch ${batches}: ${i + batch.length}/${rows.length}`);
		} catch (err) {
			console.error(`[backfill-mini] batch at ${i} failed, skipping: ${err instanceof Error ? err.message : err}`);
		}
	}
	logMemoryAction(db, null, "BACKFILL_MINIS", { updated, batches });
	return { updated, batches };
}
