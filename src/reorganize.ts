import type { DatabaseSync } from "node:sqlite";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import { archiveMemory, getDb, insertMemory, logMemoryAction, now } from "./db.ts";
import { loadConfig } from "./config.ts";
import type { MemoryRow } from "./types.ts";

interface ReorgPlan {
	merge_duplicates?: { ids: number[]; summary: string; content: string }[];
	resolve_conflict?: { keep_id: number; drop_id: number; reason?: string }[];
	archive?: { id: number; reason?: string }[];
	retag?: { id: number; kind?: MemoryRow["kind"]; domain?: string }[];
}

export interface ReorgReport {
	merged: number;
	conflictsResolved: number;
	archived: number;
	retagged: number;
}

/**
 * Nightly global curation: the LLM sees the whole store and fixes what
 * per-session distillation cannot — cross-conversation duplicates,
 * contradictions, and entries that no longer earn their place.
 */
export async function runReorganize(runId: string, owner: string): Promise<ReorgReport> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const report: ReorgReport = { merged: 0, conflictsResolved: 0, archived: 0, retagged: 0 };

	const memories = db
		.prepare(`SELECT * FROM memories WHERE status = 'active' AND owner = ? ORDER BY id`)
		.all(owner) as unknown as MemoryRow[];
	if (memories.length < 10) return report; // too small to need curation

	const overBudget = memories.length > config.dream.targetSize;

	const listing = memories
		.map(
			(m) =>
				`[id ${m.id}] (${m.kind}${m.domain ? "/" + m.domain : ""}, seen ${m.last_seen_at.slice(0, 10)}, evidence ${m.evidence}, confidence ${m.confidence.toFixed(2)}, ${m.origin})\n  summary: ${m.summary}\n  content: ${m.content}`,
		)
		.join("\n\n");

	const plan = await completeJson<ReorgPlan>({
		system: loadPrompt("reorganize"),
		user:
			(overBudget
				? `STORE SIZE NOTICE: there are ${memories.length} active entries, above the target of ~${config.dream.targetSize}. Be noticeably more aggressive with merge_duplicates and archive this run; the store should converge, not grow without bound.\n\n`
				: "") + `ACTIVE MEMORIES:\n${listing}`,
		step: "reorganize",
		runId,
	});

	const valid = new Set(memories.map((m) => m.id));

	for (const merge of plan.merge_duplicates ?? []) {
		const ids = merge.ids.filter((id) => valid.has(id));
		if (ids.length < 2 || !merge.summary || !merge.content) continue;
		const sources = ids.map((id) => memories.find((m) => m.id === id)!).filter(Boolean);
		const best = sources.reduce((a, b) => (a.confidence >= b.confidence ? a : b));
		const newId = insertMemory(
			db,
			{
				kind: best.kind,
				domain: best.domain ?? undefined,
				summary: merge.summary,
				content: merge.content,
				origin: best.origin,
				confidence: Math.max(...sources.map((s) => s.confidence)),
				source: sources.find((s) => s.source)?.source ?? null,
			},
			{ owner, cwd: best.cwd },
		);
		db.prepare(`UPDATE memories SET evidence = ? WHERE id = ?`).run(
			sources.reduce((sum, s) => sum + s.evidence, 0),
			newId,
		);
		db.prepare(`UPDATE memories SET last_seen_at = ? WHERE id = ?`).run(
			sources.map((s) => s.last_seen_at).sort().at(-1)!,
			newId,
		);
		const t = now();
		for (const id of ids) {
			db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`).run(newId, t, id);
		}
		logMemoryAction(db, runId, "REORG_MERGE", { ids, newId, summary: merge.summary });
		report.merged++;
	}

	for (const c of plan.resolve_conflict ?? []) {
		if (!valid.has(c.keep_id) || !valid.has(c.drop_id) || c.keep_id === c.drop_id) continue;
		db.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`).run(
			c.keep_id,
			now(),
			c.drop_id,
		);
		logMemoryAction(db, runId, "REORG_CONFLICT", { keep: c.keep_id, drop: c.drop_id, reason: c.reason });
		report.conflictsResolved++;
	}

	for (const a of plan.archive ?? []) {
		if (!valid.has(a.id)) continue;
		archiveMemory(db, a.id);
		logMemoryAction(db, runId, "REORG_ARCHIVE", { id: a.id, reason: a.reason });
		report.archived++;
	}

	for (const r of plan.retag ?? []) {
		if (!valid.has(r.id) || (!r.kind && !r.domain)) continue;
		db.prepare(`UPDATE memories SET kind = COALESCE(?, kind), domain = COALESCE(?, domain), updated_at = ? WHERE id = ?`).run(
			r.kind ?? null,
			r.domain ?? null,
			now(),
			r.id,
		);
		logMemoryAction(db, runId, "REORG_RETAG", { id: r.id, kind: r.kind, domain: r.domain });
		report.retagged++;
	}

	return report;
}

/** Distinct owners present in the store (reorg runs per owner to respect isolation). */
export function storeOwners(db: DatabaseSync): string[] {
	const rows = db.prepare(`SELECT DISTINCT owner FROM memories`).all() as unknown as { owner: string }[];
	return rows.map((r) => r.owner);
}
