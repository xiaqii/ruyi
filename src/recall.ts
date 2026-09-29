import { loadConfig } from "./config.ts";
import { activeCandidates, ftsSearch, getByIds, getDb } from "./db.ts";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import type { MemoryRow } from "./types.ts";

export interface InjectPayload {
	constitution: { id: number; summary: string; content: string }[];
	index: { id: number; date: string; kind: string; summary: string }[];
}

/** Layers 1+2: pinned "constitution" + a bounded one-line index of recent/high-evidence memories. */
export function getInject(owner: string): InjectPayload {
	const config = loadConfig();
	const db = getDb(config.dbPath);

	const pinned = db
		.prepare(
			`SELECT id, summary, content FROM memories
			 WHERE status = 'active' AND pinned = 1 AND owner = ?
			 ORDER BY confidence DESC, evidence DESC LIMIT ?`,
		)
		.all(owner, config.inject.constitutionMax) as unknown as { id: number; summary: string; content: string }[];

	const since = new Date(Date.now() - config.inject.indexDays * 86_400_000).toISOString();
	const index = db
		.prepare(
			`SELECT id, last_seen_at, kind, summary FROM memories
			 WHERE status = 'active' AND pinned = 0 AND owner = ?
			 AND (evidence >= 3 OR last_seen_at >= ?)
			 ORDER BY last_seen_at DESC LIMIT ?`,
		)
		.all(owner, since, config.inject.indexMax) as unknown as {
		id: number;
		last_seen_at: string;
		kind: string;
		summary: string;
	}[];

	return {
		constitution: pinned,
		index: index.map((m) => ({ id: m.id, date: m.last_seen_at.slice(0, 10), kind: m.kind, summary: m.summary })),
	};
}

/**
 * Layer 3: two-stage LLM recall. Stage 1 gathers candidates (recent + high-evidence,
 * FTS prefilter only when the store is large); stage 2 lets the LLM pick what is
 * genuinely relevant to the current context.
 */
export async function recall(query: string, k: number | undefined, owner: string): Promise<MemoryRow[]> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const limit = Math.min(k ?? config.inject.recallK, 20);

	let candidates = activeCandidates(db, config.inject.recallCandidateDays, owner);
	if (candidates.length > config.inject.recallCandidateMax) {
		candidates = ftsSearch(db, query, 100, owner);
	}
	if (candidates.length === 0) return [];

	const listing = candidates
		.map((m) => `[id ${m.id}] (${m.kind}, ${m.last_seen_at.slice(0, 10)}) ${m.summary}`)
		.join("\n");

	const { ids } = await completeJson<{ ids: number[] }>({
		system: loadPrompt("rerank"),
		user: `CONTEXT:\n${query}\n\nCANDIDATES:\n${listing}\n\nReturn at most ${limit} ids.`,
		step: "rerank",
	});
	if (!Array.isArray(ids) || ids.length === 0) return [];
	return getByIds(db, ids.slice(0, limit)).filter((m) => m.owner === owner);
}
