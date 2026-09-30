import { loadConfig } from "./config.ts";
import { ftsSearch, getByIds, getDb, getProfile, listProfiles, scopeFilter, type ProfileRow, type RecallScope } from "./db.ts";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import type { MemoryRow } from "./types.ts";

export interface InjectPayload {
	constitution: { id: number; summary: string; content: string }[];
	index: { id: number; date: string; kind: string; summary: string }[];
}

/** Layers 1+2: pinned "constitution" + a bounded one-line index of recent/high-evidence memories. */
export function getInject(owner: string, cwd: string | null, scope: RecallScope): InjectPayload {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const sf = scopeFilter(scope, cwd);

	// Constitution = pinned entries + "graduated habits": preferences repeatedly
	// confirmed across conversations (evidence >= 5) with high confidence.
	const pinned = db
		.prepare(
			`SELECT id, summary, content FROM memories m
			 WHERE status = 'active' AND owner = ? ${sf.where}
			 AND (pinned = 1 OR (kind = 'preference' AND evidence >= 5 AND confidence >= 0.8))
			 ORDER BY pinned DESC, confidence DESC, evidence DESC LIMIT ?`,
		)
		.all(owner, ...sf.params, config.inject.constitutionMax) as unknown as {
		id: number;
		summary: string;
		content: string;
	}[];

	const since = new Date(Date.now() - config.inject.indexDays * 86_400_000).toISOString();
	const index = db
		.prepare(
			`SELECT id, last_seen_at, kind, summary FROM memories m
			 WHERE status = 'active' AND pinned = 0 AND owner = ? ${sf.where}
			 AND (evidence >= 3 OR last_seen_at >= ?)
			 ORDER BY last_seen_at DESC LIMIT ?`,
		)
		.all(owner, ...sf.params, since, config.inject.indexMax) as unknown as {
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

export interface RecallResult {
	memories: MemoryRow[];
	profiles: ProfileRow[];
}

/**
 * Layer 3: two-stage LLM recall. Stage 1 gathers candidates (recent + high-evidence,
 * FTS prefilter only when the store is large); stage 2 lets the LLM pick what is
 * genuinely relevant to the current context — memories and, when the conversation
 * sits squarely inside one facet of the person, at most one profile chapter.
 */
export async function recall(
	query: string,
	k: number | undefined,
	owner: string,
	cwd: string | null = null,
	scope?: RecallScope,
): Promise<RecallResult> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const limit = Math.min(k ?? config.inject.recallK, 20);
	const effectiveScope = scope ?? config.recall.defaultScope;
	const sf = scopeFilter(effectiveScope, cwd);

	const since = new Date(Date.now() - config.inject.recallCandidateDays * 86_400_000).toISOString();
	let candidates = db
		.prepare(
			`SELECT * FROM memories m WHERE status = 'active' AND owner = ? ${sf.where}
			 AND (pinned = 1 OR evidence >= 3 OR last_seen_at >= ?)
			 ORDER BY last_seen_at DESC`,
		)
		.all(owner, ...sf.params, since) as unknown as MemoryRow[];
	if (candidates.length > config.inject.recallCandidateMax) {
		candidates = ftsSearch(db, query, 100, owner).filter((m) => candidates.some((c) => c.id === m.id));
	}
	if (candidates.length === 0) return { memories: [], profiles: [] };

	const listing = candidates
		.map((m) => `[id ${m.id}] (${m.kind}, ${m.last_seen_at.slice(0, 10)}) ${m.summary}`)
		.join("\n");

	const profiles = listProfiles(db, owner);
	const profileBlock =
		profiles.length > 0
			? "\n\nPROFILES:\n" + profiles.map((p) => `[id ${p.id}] (${p.title}) — synthesized portrait of this facet`).join("\n")
			: "";

	const picked = await completeJson<{ ids?: number[]; profile_ids?: number[] }>({
		system: loadPrompt("rerank"),
		user: `CONTEXT:\n${query}\n\nCANDIDATES:\n${listing}${profileBlock}\n\nReturn at most ${limit} memory ids and at most 1 profile id.`,
		step: "rerank",
	});
	const ids = Array.isArray(picked.ids) ? picked.ids : [];
	const profileIds = Array.isArray(picked.profile_ids) ? picked.profile_ids : [];
	return {
		memories: getByIds(db, ids.slice(0, limit)).filter((m) => m.owner === owner),
		profiles: profileIds
			.map((id) => getProfile(db, id))
			.filter((p): p is ProfileRow => !!p && p.owner === owner)
			.slice(0, 1),
	};
}
