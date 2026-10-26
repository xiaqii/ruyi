import { loadConfig } from "./config.ts";
import {
	bumpSlotDemand,
	ftsSearchScored,
	getByIds,
	getDb,
	getInjectedItems,
	getOrCreateTopic,
	getProfile,
	getRecentQueries,
	getTopicSummary,
	listProfiles,
	logInjections,
	logRecall,
	logReply,
	scopeFilter,
	setTopicSummary,
	turnsSinceSummary,
	type FtsHit,
	type ProfileRow,
	type RecallScope,
} from "./db.ts";
import { complete, completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import type { MemoryRow } from "./types.ts";

export type RecallMode = "fast" | "deep" | "excavate";

export interface InjectPayload {
	constitution: { id: number; summary: string; content: string }[];
	/** @deprecated always empty — static index removed; kept for old-client compat. */
	index: never[];
	profileDirectory: { id: number; title: string; maturity: string; parent_id: number | null; gist?: string }[];
}

/** Static layer: manually pinned "constitution" + profile directory (the category
 *  index agents browse on demand). Pure SQL, zero tokens. Deliberately minimal —
 *  everything topic-relevant arrives via per-turn semantic recall instead. */
export function getInject(owner: string, cwd: string | null, scope: RecallScope): InjectPayload {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const sf = scopeFilter(scope, cwd);

	// Constitution = manually pinned entries ONLY. The old auto-graduation rule
	// (preference evidence>=5 + confidence>=0.8) let domain-specific content ride
	// every conversation's system prompt — violating the zero-injection principle.
	const pinned = db
		.prepare(
			`SELECT id, summary, content FROM memories m
			 WHERE status = 'active' AND owner = ? ${sf.where} AND pinned = 1
			 ORDER BY confidence DESC, evidence DESC LIMIT ?`,
		)
		.all(owner, ...sf.params, config.inject.constitutionMax) as unknown as {
		id: number;
		summary: string;
		content: string;
	}[];

	return {
		constitution: pinned,
		// index removed from the static layer; kept as an empty array so older
		// clients (which read inject.index.length) degrade gracefully.
		index: [] as never[],
		profileDirectory: listProfiles(db, owner).map((p) => ({
			id: p.id,
			title: p.title,
			maturity: p.maturity,
			parent_id: p.parent_id ?? null,
			// Domain index chapters carry their orientation line into the menu —
			// the agent reads the index page before choosing a subchapter.
			...(!p.parent_id && p.content && p.content.length <= 200 ? { gist: p.content } : {}),
		})),
	};
}

export interface RecallResult {
	memories: MemoryRow[];
	profiles: ProfileRow[];
	/** Items suppressed because this conversation already received them (auto-inject only). */
	deduped?: number;
	/** Server-side topic/reply numbering of this turn (auto-inject only). */
	topicId?: number;
	replyId?: number;
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

/**
 * LLM-driven candidate pool (deep mode): the domain channel opened by query
 * understanding ∪ recent ∪ pinned. NO string retrieval in the normal path —
 * keyword matching cannot tell a subject from an example (a turn that uses
 * "显卡" as an analogy is not about GPUs), and its worst failure (a good
 * memory never entering the pool) is fatal. Every candidate here was invited
 * by meaning; the reranker makes the final call.
 */
function gatherChannels(
	db: ReturnType<typeof getDb>,
	owner: string,
	scope: RecallScope,
	cwd: string | null,
	opts: { domains?: string[]; timeFrom?: string } = {},
): CandidatePool {
	const rows = new Map<number, MemoryRow>();
	const push = (list: MemoryRow[]) => {
		for (const m of list) if (!rows.has(m.id)) rows.set(m.id, m);
	};
	push(
		db
			.prepare(`SELECT * FROM memories WHERE status = 'active' AND owner = ? ORDER BY last_seen_at DESC LIMIT 20`)
			.all(owner) as unknown as MemoryRow[],
	);
	push(
		db.prepare(`SELECT * FROM memories WHERE status = 'active' AND owner = ? AND pinned = 1`).all(owner) as unknown as MemoryRow[],
	);
	if (opts.domains && opts.domains.length > 0) {
		const domIn = opts.domains.map(() => "?").join(",");
		push(
			db
				.prepare(
					`SELECT * FROM memories WHERE status = 'active' AND owner = ? AND domain IN (${domIn})
					 ORDER BY evidence DESC, last_seen_at DESC LIMIT 40`,
				)
				.all(owner, ...opts.domains) as unknown as MemoryRow[],
		);
	}
	const out: MemoryRow[] = [];
	for (const m of rows.values()) {
		if (!scopeOk(m, scope, cwd)) continue;
		if (opts.timeFrom && m.last_seen_at < opts.timeFrom) continue;
		out.push(m);
	}
	// Recency/evidence order only decides what makes the candidate cap;
	// relevance is entirely the reranker's call.
	out.sort((a, b) => b.evidence - a.evidence || b.last_seen_at.localeCompare(a.last_seen_at));
	return { rows: out.slice(0, 120), scores: new Map(), ftsHitCount: 0 };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Topic context: rolling summary + the user's turns of this topic, so a bare follow-up query
// ("which parts can't be eaten?") is read against the topic, not in a vacuum.
// ---------------------------------------------------------------------------

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The current query plus the topic's gist and the user's OWN turns, full text
 *  (user turns are short — 20 of them is still small). Anchors bare follow-ups
 *  against the topic: understanding judges the subject, never the bare words. */
function withTopicContext(query: string, summary: string, recent: string[]): string {
	if (!summary && recent.length === 0) return query;
	const parts: string[] = [query, "", "【本话题上下文】"];
	if (summary) parts.push(`话题概要：${summary}`);
	if (recent.length > 0)
		parts.push(`本话题用户逐轮原文：\n${recent.map((q, i) => `${i + 1}. ${clip(q.replace(/\s+/g, " "), 2000)}`).join("\n")}`);
	return parts.join("\n");
}

/**
 * Fallback gist refresh for turns where rerank didn't run (short-circuit / fast mode).
 * Incremental by construction: only the turns since the last refresh are sent, and
 * trivial chatter (< 15 chars of new content) skips the LLM entirely.
 */
async function refreshSummaryFallback(
	db: ReturnType<typeof getDb>,
	topicId: number,
	replyId: number,
): Promise<void> {
	try {
		const stale = turnsSinceSummary(db, topicId);
		if (stale < 8) return;
		const turns = getRecentQueries(db, topicId, Math.min(stale, 12));
		if (turns.join("").replace(/\s+/g, "").length < 15) return; // 打字太少，不提取
		const old = getTopicSummary(db, topicId);
		const turnBlock = turns.map((q, i) => `${i + 1}. ${clip(q.replace(/\s+/g, " "), 200)}`).join("\n");
		const result = await complete({
			system: loadPrompt("topic-summary"),
			user: `OLD SUMMARY:\n${old || "(empty)"}\n\nNEW TURNS since last refresh:\n${turnBlock}`,
			step: "topic-summary",
			maxTokens: 200,
		});
		const summary = result.text.trim();
		if (summary) setTopicSummary(db, topicId, summary, replyId);
	} catch {
		// Summary is a best-effort boost; never let it break recall.
	}
}

// T2: query understanding (one small LLM call, only when T1 is sparse)
// ---------------------------------------------------------------------------

interface Understanding {
	domains?: string[];
	kinds?: string[];
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
	alreadyBlock?: string,
	profileMax = 3,
): Promise<{ ids: number[]; profileIds: number[]; gist: string | null }> {
	if (candidates.length === 0) return { ids: [], profileIds: [], gist: null };
	const listing = candidates
		.map((m) => `[id ${m.id}] (${m.kind}, ${m.last_seen_at.slice(0, 10)}) ${m.summary}`)
		.join("\n");
	const profiles = listProfiles(db, owner);
	const profileById = new Map(profiles.map((p) => [p.id, p]));
	const profileLabel = (p: ProfileRow) =>
		p.parent_id && profileById.get(p.parent_id)
			? `${profileById.get(p.parent_id)!.title} / ${p.title}`
			: `${p.title} — domain index: ${p.content.slice(0, 120)}`;
	const profileBlock =
		profiles.length > 0
			? "\n\nPROFILES:\n" +
				profiles
					.map((p) => `[id ${p.id}] (${profileLabel(p)}, ${p.maturity === "seeding" ? "partial" : "mature"}) — synthesized portrait of this facet`)
					.join("\n")
			: "";
	const already = alreadyBlock
		? `\n\nALREADY INJECTED:\n${alreadyBlock}`
		: "";
	const picked = await completeJson<{ ids?: number[]; profile_ids?: number[]; topic_gist?: string | null }>({
		system: loadPrompt("rerank"),
		user: `CONTEXT:\n${query}\n\nCANDIDATES:\n${listing}${profileBlock}${already}\n\nReturn at most ${limit} memory ids, up to ${profileMax} profile ids (fewer when the turn is narrow; zero when none apply), and the topic_gist.`,
		step: "rerank",
	});
	return {
		ids: Array.isArray(picked.ids) ? picked.ids : [],
		profileIds: Array.isArray(picked.profile_ids) ? picked.profile_ids : [],
		gist: typeof picked.topic_gist === "string" ? picked.topic_gist : null,
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
	opts?: { conversation?: string; auto?: boolean },
): Promise<RecallResult> {
	const startedAt = Date.now();
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const limit = Math.min(k ?? config.inject.recallK, 20);
	const effectiveScope = scope ?? config.recall.defaultScope;

	// Auto-injection dedup: a conversation never receives the same item twice.
	// The ledger also lets us skip the LLM entirely when nothing new could surface.
	const ledger = opts?.auto && opts.conversation ? getInjectedItems(db, opts.conversation) : null;
	const turn = ledger && opts?.conversation ? getOrCreateTopic(db, opts.conversation, query) : null;
	const topicSummary = turn ? getTopicSummary(db, turn.topicId) : "";
	const recent = turn ? getRecentQueries(db, turn.topicId, 40) : [];
	const contextQuery = withTopicContext(query, topicSummary, recent);
	const logNew = (memories: MemoryRow[], profiles: ProfileRow[]) => {
		if (!ledger || !opts?.conversation || !turn) return;
		const items = [...memories.map((m) => `m:${m.id}`), ...profiles.map((p) => `p:${p.id}`)];
		logInjections(db, opts.conversation, items);
		logReply(db, turn.topicId, turn.replyId, query, items);
		void refreshSummaryFallback(db, turn.topicId, turn.replyId);
	};

	// fast / excavate: T1 only, zero tokens.
	if (mode !== "deep") {
		let pool = gatherCandidates(db, query, owner, effectiveScope, cwd, { excavate: mode === "excavate" });
		let suppressed = 0;
		if (ledger) {
			const before = pool.rows.length;
			pool = { ...pool, rows: pool.rows.filter((m) => !ledger.has(`m:${m.id}`)) };
			suppressed = before - pool.rows.length;
		}
		const memories = pool.rows.slice(0, limit);
		logRecall(db, {
			owner,
			query,
			mode,
			hits: memories.length,
			latencyMs: Date.now() - startedAt,
			detail: { candidates: pool.rows.length, ftsHits: pool.ftsHitCount, deduped: suppressed },
		});
		logNew(memories, []);
		return { memories, profiles: [], deduped: suppressed, topicId: turn?.topicId, replyId: turn?.replyId };
	}

	// deep: T2 (always — string retrieval no longer gates query understanding;
	// its worst failure, a good memory never entering the pool, is fatal)
	// → channel candidates (domains ∪ recent ∪ pinned, zero FTS in the normal
	//   path) → dedup → T3 → T4. FTS survives only in mode=fast/excavate
	//   (explicit keyword-scan tool calls) and as degraded fallback when the
	//   LLM is down (变笨但不断线).
	const understanding = await understand(db, contextQuery, owner);
	const usedT2 = true;
	let pool = gatherChannels(db, owner, effectiveScope, cwd, {
		domains: understanding.domains,
		timeFrom: understanding.time_from,
	});

	// Dedup pre-filter + LLM short-circuit: if every candidate was already
	// injected into this conversation, the LLM could only pick repeats —
	// skip the call entirely (zero tokens, zero noise).
	let suppressed = 0;
	if (ledger) {
		const before = pool.rows.length;
		pool = { ...pool, rows: pool.rows.filter((m) => !ledger.has(`m:${m.id}`)) };
		suppressed = before - pool.rows.length;
		if (before > 0 && pool.rows.length === 0) {
			logRecall(db, {
				owner,
				query,
				mode: "deep",
				hits: 0,
				latencyMs: Date.now() - startedAt,
				detail: { shortCircuit: "ledger", deduped: suppressed },
			});
			if (turn) {
				logReply(db, turn.topicId, turn.replyId, query, []);
				void refreshSummaryFallback(db, turn.topicId, turn.replyId);
			}
			return { memories: [], profiles: [], deduped: suppressed, topicId: turn?.topicId, replyId: turn?.replyId };
		}
	}

	const candidateCap = Math.min(config.inject.recallCandidateMax, 100);
	let candidates = pool.rows.slice(0, candidateCap);

	// Give the ranker visibility into what this conversation already has, so it
	// rejects candidates that merely restate injected facts (returns empty).
	let alreadyBlock: string | undefined;
	if (ledger && ledger.size > 0) {
		const memIds = [...ledger].filter((i) => i.startsWith("m:")).map((i) => Number(i.slice(2)));
		const lines = getByIds(db, memIds).map((m) => `[id ${m.id}] ${m.summary}`);
		for (const i of ledger) {
			if (!i.startsWith("p:")) continue;
			const p = getProfile(db, Number(i.slice(2)));
			if (p) lines.push(`[profile ${p.id}] ${p.title}`);
		}
		if (lines.length > 0) alreadyBlock = lines.join("\n");
	}

	const profileMax = config.inject.profileMax ?? 3;
	let ids: number[];
	let profileIds: number[];
	let gist: string | null;
	let degraded = false;
	try {
		({ ids, profileIds, gist } = await rerank(db, contextQuery, candidates, limit, owner, alreadyBlock, profileMax));
	} catch (err) {
		// Graceful degradation: LLM down/quota out → pool order (recency/evidence),
		// no profiles. 变笨但不断线.
		degraded = true;
		console.error(`[ruyi] rerank failed, degraded to pool ordering: ${err instanceof Error ? err.message : err}`);
		ids = candidates.slice(0, limit).map((m) => m.id);
		profileIds = [];
		gist = null;
	}
	// Piggybacked gist: the rerank call already holds the topic context, so a fresh
	// summary costs ~80 output tokens and zero extra calls.
	if (turn && gist?.trim()) setTopicSummary(db, turn.topicId, gist.trim(), turn.replyId);

	// T4: sparse result with unused candidates left → one more round.
	let rounds = 1;
	if (ids.length < Math.max(1, Math.floor(limit / 2)) && pool.rows.length > candidates.length) {
		const extra = pool.rows.slice(candidateCap, candidateCap * 2);
		if (extra.length > 0) {
			rounds = 2;
			try {
				const second = await rerank(db, contextQuery, extra, limit - ids.length, owner, alreadyBlock, profileMax - profileIds.length);
				ids = [...ids, ...second.ids];
				profileIds = [...new Set([...profileIds, ...second.profileIds])].slice(0, profileMax);
			} catch { /* second round is a bonus; first-round results stand */ }
		}
	}

	const result = {
		memories: getByIds(db, ids.slice(0, limit)).filter((m) => m.owner === owner),
		profiles: profileIds
			.map((id) => getProfile(db, id))
			.filter((p): p is ProfileRow => !!p && p.owner === owner)
			.slice(0, profileMax),
	};

	// Demand signal: only a deep recall that found NOTHING registers demand
	// (a single perfect hit is success, not demand). demand_domain is free-form
	// and may name an area the store has never covered.
	if (result.memories.length === 0 && usedT2 && understanding.demand_domain) {
		bumpSlotDemand(db, owner, [understanding.demand_domain]);
	}

	const freshProfiles = ledger ? result.profiles.filter((p) => !ledger.has(`p:${p.id}`)) : result.profiles;
	suppressed += result.profiles.length - freshProfiles.length;
	logNew(result.memories, freshProfiles);
	const final: RecallResult = { memories: result.memories, profiles: freshProfiles, deduped: suppressed, topicId: turn?.topicId, replyId: turn?.replyId };
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
			profiles: freshProfiles.length,
			deduped: suppressed,
			...(degraded ? { degraded: true } : {}),
		},
	});
	return final;
}
