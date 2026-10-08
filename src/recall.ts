import { loadConfig } from "./config.ts";
import {
	bumpSlotDemand,
	ftsSearchScored,
	getByIds,
	getDb,
	getProfile,
	listProfiles,
	logRecall,
	scopeFilter,
	type FtsHit,
	type ProfileRow,
	type RecallScope,
} from "./db.ts";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import type { MemoryRow } from "./types.ts";

export type RecallMode = "fast" | "deep" | "excavate";

export interface InjectPayload {
	constitution: { id: number; summary: string; content: string }[];
	index: { id: number; date: string; kind: string; summary: string }[];
	profileDirectory: { id: number; title: string; maturity: string }[];
}

/** Layers 1+2: pinned "constitution" + bounded index + profile directory. Pure SQL, zero tokens. */
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
		profileDirectory: listProfiles(db, owner).map((p) => ({ id: p.id, title: p.title, maturity: p.maturity })),
	};
}

export interface RecallResult {
	memories: MemoryRow[];
	profiles: ProfileRow[];
}

// ---------------------------------------------------------------------------
// T1: free candidate retrieval + fusion scoring (no LLM)
// ---------------------------------------------------------------------------

const PERSONAL_KINDS = new Set(["preference", "fact", "knowledge"]);

function scopeOk(m: MemoryRow, scope: RecallScope, cwd: string | null): boolean {
	if (scope === "all" || !cwd) return true;
	if (scope === "cwd") return m.cwd === cwd || m.cwd === null;
	return m.cwd === cwd || m.cwd === null || PERSONAL_KINDS.has(m.kind);
}

interface CandidatePool {
	rows: MemoryRow[];
	scores: Map<number, number>;
	/** How many rows came from real FTS hits (vs LIKE fallback / recency channel). */
	ftsHitCount: number;
}

/**
 * Full-store retrieval: trigram FTS (BM25) ∪ recent ∪ pinned, fused with
 * recency / evidence / pinned boosts. Cost is proportional to matches, not
 * store size — every active memory is reachable, no recency/evidence gate.
 */
function gatherCandidates(
	db: ReturnType<typeof getDb>,
	query: string,
	owner: string,
	scope: RecallScope,
	cwd: string | null,
	opts: { excavate?: boolean; extraQuery?: string; domains?: string[]; timeFrom?: string } = {},
): CandidatePool {
	const statuses = opts.excavate ? ["active", "absorbed", "superseded", "archived"] : ["active"];
	const hits = new Map<number, FtsHit>();
	for (const h of ftsSearchScored(db, query, 60, owner, statuses)) hits.set(h.row.id, h);
	if (opts.extraQuery) {
		for (const h of ftsSearchScored(db, opts.extraQuery, 60, owner, statuses)) {
			if (!hits.has(h.row.id)) hits.set(h.row.id, h);
		}
	}

	const rows = new Map<number, MemoryRow>();
	for (const h of hits.values()) rows.set(h.row.id, h.row);

	const statusIn = statuses.map(() => "?").join(",");
	// Recency channel: "working-memory warmth" even when no keyword overlaps.
	const recent = db
		.prepare(
			`SELECT * FROM memories WHERE status IN (${statusIn}) AND owner = ? ORDER BY last_seen_at DESC LIMIT 20`,
		)
		.all(...statuses, owner) as unknown as MemoryRow[];
	for (const m of recent) if (!rows.has(m.id)) rows.set(m.id, m);
	// Pinned channel: constitution members are always candidates.
	const pinned = db
		.prepare(`SELECT * FROM memories WHERE status IN (${statusIn}) AND owner = ? AND pinned = 1`)
		.all(...statuses, owner) as unknown as MemoryRow[];
	for (const m of pinned) if (!rows.has(m.id)) rows.set(m.id, m);
	// Domain channel (T2-driven): same-domain memories when query understanding fired.
	if (opts.domains && opts.domains.length > 0) {
		const domIn = opts.domains.map(() => "?").join(",");
		const sameDomain = db
			.prepare(
				`SELECT * FROM memories WHERE status IN (${statusIn}) AND owner = ? AND domain IN (${domIn})
				 ORDER BY evidence DESC, last_seen_at DESC LIMIT 30`,
			)
			.all(...statuses, owner, ...opts.domains) as unknown as MemoryRow[];
		for (const m of sameDomain) if (!rows.has(m.id)) rows.set(m.id, m);
	}

	// Fusion scoring: relevance dominates; time is a weak boost + tiebreaker, never a gate.
	const nowMs = Date.now();
	const scores = new Map<number, number>();
	let ftsHitCount = 0;
	const out: MemoryRow[] = [];
	for (const m of rows.values()) {
		if (!scopeOk(m, scope, cwd)) continue;
		if (opts.timeFrom && m.last_seen_at < opts.timeFrom) continue;
		const hit = hits.get(m.id);
		const base = hit ? hit.hitScore : 0.2;
		if (hit && hit.hitScore >= 1) ftsHitCount++;
		const ageDays = Math.max(0, (nowMs - new Date(m.last_seen_at).getTime()) / 86_400_000);
		const recencyBoost = 0.3 * Math.pow(0.5, ageDays / 30); // half-life 30d
		const evidenceBoost = 0.1 * Math.log1p(m.evidence);
		const pinnedBoost = m.pinned ? 0.5 : 0;
		scores.set(m.id, base * (1 + recencyBoost + evidenceBoost + pinnedBoost));
		out.push(m);
	}
	out.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
	return { rows: out, scores, ftsHitCount };
}

// ---------------------------------------------------------------------------
// T2: query understanding (one small LLM call, only when T1 is sparse)
// ---------------------------------------------------------------------------

interface Understanding {
	domains?: string[];
	kinds?: string[];
	keywords?: string[];
	time_from?: string;
	demand_domain?: string;
}

let domainCache: { at: number; list: { domain: string; n: number }[] } | undefined;

function domainTaxonomy(db: ReturnType<typeof getDb>, owner: string): { domain: string; n: number }[] {
	if (domainCache && Date.now() - domainCache.at < 60_000) return domainCache.list;
	const list = db
		.prepare(
			`SELECT domain, COUNT(*) n FROM memories WHERE status = 'active' AND owner = ? AND domain IS NOT NULL
			 GROUP BY domain ORDER BY n DESC LIMIT 40`,
		)
		.all(owner) as unknown as { domain: string; n: number }[];
	domainCache = { at: Date.now(), list };
	return list;
}

async function understand(
	db: ReturnType<typeof getDb>,
	query: string,
	owner: string,
): Promise<Understanding> {
	const taxonomy = domainTaxonomy(db, owner);
	const domainBlock =
		taxonomy.length > 0 ? taxonomy.map((d) => `${d.domain} (${d.n})`).join(", ") : "(no domains yet)";
	try {
		return await completeJson<Understanding>({
			system: loadPrompt("understand"),
			user: `QUERY:\n${query}\n\nKNOWN DOMAINS (domain, memory count):\n${domainBlock}`,
			step: "understand",
			maxTokens: 1024,
		});
	} catch {
		return {}; // understanding is a best-effort boost; recall must go on
	}
}

// ---------------------------------------------------------------------------
// T3: LLM rerank (existing philosophy: relevance judged by meaning)
// ---------------------------------------------------------------------------

async function rerank(
	db: ReturnType<typeof getDb>,
	query: string,
	candidates: MemoryRow[],
	limit: number,
	owner: string,
): Promise<{ ids: number[]; profileIds: number[] }> {
	if (candidates.length === 0) return { ids: [], profileIds: [] };
	const listing = candidates
		.map((m) => `[id ${m.id}] (${m.kind}, ${m.last_seen_at.slice(0, 10)}) ${m.summary}`)
		.join("\n");
	const profiles = listProfiles(db, owner);
	const profileBlock =
		profiles.length > 0
			? "\n\nPROFILES:\n" +
				profiles
					.map((p) => `[id ${p.id}] (${p.title}, ${p.maturity === "seeding" ? "partial" : "mature"}) — synthesized portrait of this facet`)
					.join("\n")
			: "";
	const picked = await completeJson<{ ids?: number[]; profile_ids?: number[] }>({
		system: loadPrompt("rerank"),
		user: `CONTEXT:\n${query}\n\nCANDIDATES:\n${listing}${profileBlock}\n\nReturn at most ${limit} memory ids and at most 1 profile id.`,
		step: "rerank",
	});
	return {
		ids: Array.isArray(picked.ids) ? picked.ids : [],
		profileIds: Array.isArray(picked.profile_ids) ? picked.profile_ids : [],
	};
}

// ---------------------------------------------------------------------------
// Public entry: fast / deep / excavate
// ---------------------------------------------------------------------------

export async function recall(
	query: string,
	k: number | undefined,
	owner: string,
	cwd: string | null = null,
	scope?: RecallScope,
	mode: RecallMode = "deep",
): Promise<RecallResult> {
	const startedAt = Date.now();
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const limit = Math.min(k ?? config.inject.recallK, 20);
	const effectiveScope = scope ?? config.recall.defaultScope;

	// fast / excavate: T1 only, zero tokens.
	if (mode !== "deep") {
		const pool = gatherCandidates(db, query, owner, effectiveScope, cwd, { excavate: mode === "excavate" });
		const memories = pool.rows.slice(0, limit);
		logRecall(db, {
			owner,
			query,
			mode,
			hits: memories.length,
			latencyMs: Date.now() - startedAt,
			detail: { candidates: pool.rows.length, ftsHits: pool.ftsHitCount },
		});
		return { memories, profiles: [] };
	}

	// deep: T1 → (sparse? T2) → T3 → (insufficient? T4)
	let pool = gatherCandidates(db, query, owner, effectiveScope, cwd);
	let usedT2 = false;
	let understanding: Understanding = {};
	if (pool.ftsHitCount < 3) {
		understanding = await understand(db, query, owner);
		usedT2 = true;
		const extraQuery = (understanding.keywords ?? []).join(" ");
		if (extraQuery || (understanding.domains ?? []).length > 0) {
			const expanded = gatherCandidates(db, query, owner, effectiveScope, cwd, {
				extraQuery,
				domains: understanding.domains,
				timeFrom: understanding.time_from,
			});
			// merge pools, keep best score
			const scores = new Map(pool.scores);
			const byId = new Map(pool.rows.map((m) => [m.id, m]));
			for (const m of expanded.rows) {
				const s = expanded.scores.get(m.id) ?? 0;
				if ((scores.get(m.id) ?? 0) < s) scores.set(m.id, s);
				if (!byId.has(m.id)) byId.set(m.id, m);
			}
			const merged = [...byId.values()].sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
			pool = { rows: merged, scores, ftsHitCount: Math.max(pool.ftsHitCount, expanded.ftsHitCount) };
		}
	}

	const candidateCap = Math.min(config.inject.recallCandidateMax, 100);
	let candidates = pool.rows.slice(0, candidateCap);
	let { ids, profileIds } = await rerank(db, query, candidates, limit, owner);

	// T4: sparse result with unused candidates left → one more round.
	let rounds = 1;
	if (ids.length < Math.max(1, Math.floor(limit / 2)) && pool.rows.length > candidates.length) {
		const extra = pool.rows.slice(candidateCap, candidateCap * 2);
		if (extra.length > 0) {
			rounds = 2;
			const second = await rerank(db, query, extra, limit - ids.length, owner);
			ids = [...ids, ...second.ids];
			if (profileIds.length === 0) profileIds = second.profileIds;
		}
	}

	const result = {
		memories: getByIds(db, ids.slice(0, limit)).filter((m) => m.owner === owner),
		profiles: profileIds
			.map((id) => getProfile(db, id))
			.filter((p): p is ProfileRow => !!p && p.owner === owner)
			.slice(0, 1),
	};

	// Demand signal: only a deep recall that found NOTHING registers demand
	// (a single perfect hit is success, not demand). demand_domain is free-form
	// and may name an area the store has never covered.
	if (result.memories.length === 0 && usedT2 && understanding.demand_domain) {
		bumpSlotDemand(db, owner, [understanding.demand_domain]);
	}

	logRecall(db, {
		owner,
		query,
		mode: "deep",
		hits: result.memories.length,
		latencyMs: Date.now() - startedAt,
		detail: {
			candidates: candidates.length,
			ftsHits: pool.ftsHitCount,
			t2: usedT2,
			domains: understanding.domains,
			rounds,
			profiles: result.profiles.length,
		},
	});
	return result;
}
