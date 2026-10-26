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
	getReplies,
	getTopicSummary,
	setReplyGist,
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

const CONTEXT_BUDGET = 32_000;

/**
 * Layered topic context (long → mid → short term), assembled within 32K chars:
 *  1. topic summary (long-term: what this conversation is about)
 *  2. last 3 user turns verbatim, ≤4K each (short-term: the exact live wording)
 *  3. per-turn gists, newest first, until the budget runs out (mid-term)
 * A reply without a gist yet (or whose gist failed) contributes its raw user
 * text, clipped. Everything here is a regenerable view over replies — the raw
 * turns are the permanent record.
 */
export function assembleTopicContext(db: ReturnType<typeof getDb>, topicId: number, summary: string): string {
	const replies = getReplies(db, topicId);
	if (!summary && replies.length === 0) return "";
	const parts: string[] = [];
	let used = 0;
	const push = (s: string): boolean => {
		if (used + s.length > CONTEXT_BUDGET) return false;
		parts.push(s);
		used += s.length;
		return true;
	};
	if (summary) push(`话题概要：${summary}`);
	const verbatim = replies.slice(-3);
	const verbatimIds = new Set(verbatim.map((r) => r.reply_id));
	push(
		`最近用户轮原文：\n${verbatim.map((r) => `${r.reply_id}. ${clip(r.query.replace(/\s+/g, " "), 4000)}`).join("\n")}`,
	);
	const gistLines: string[] = [];
	for (const r of [...replies].reverse()) {
		if (verbatimIds.has(r.reply_id)) continue;
		const line = `${r.reply_id}. ${r.gist || `用户：${clip(r.query.replace(/\s+/g, " "), 300)}`}`;
		if (used + line.length + 20 > CONTEXT_BUDGET) break;
		gistLines.push(line);
		used += line.length;
	}
	if (gistLines.length > 0) push(`逐轮纪要（新→旧）：\n${gistLines.join("\n")}`);
	return parts.join("\n");
}

/** The current query anchored against the assembled topic context. */
function withTopicContext(query: string, context: string): string {
	if (!context) return query;
	return `${query}\n\n【本话题上下文】\n${context}`;
}

/**
 * Generate (or regenerate) the 1-2 sentence gist of one Q+A reply pair.
 * Daytime: recall tier (flash) — fast and off the critical path. Nightly
 * regeneration uses step "gist-regen" (dream tier → k3-class thinking) to
 * rewrite drifted gists from the raw turns (gist = regenerable view, never a chain).
 */
export async function generateReplyGist(
	db: ReturnType<typeof getDb>,
	topicId: number,
	replyId: number,
	opts: { dream?: boolean } = {},
): Promise<boolean> {
	const row = db
		.prepare(`SELECT query, answer FROM replies WHERE topic_id = ? AND reply_id = ?`)
		.get(topicId, replyId) as { query: string; answer: string } | undefined;
	if (!row || !row.answer) return false;
	const summary = getTopicSummary(db, topicId);
	const recent = getReplies(db, topicId)
		.filter((r) => r.reply_id < replyId && r.gist)
		.slice(-3)
		.map((r) => `${r.reply_id}. ${r.gist}`);
	const ref = [summary && `话题概要：${summary}`, recent.length > 0 && `最近纪要：\n${recent.join("\n")}`].filter(Boolean).join("\n");
	const result = await complete({
		system: loadPrompt("reply-gist"),
		user: `${ref ? `REFERENCE（仅供还原指代，不可取事实）：\n${ref}\n\n` : ""}USER（原文）：\n${clip(row.query, 8000)}\n\nASSISTANT（原文）：\n${clip(row.answer, 8000)}`,
		step: opts.dream ? "gist-regen" : "reply-gist",
		maxTokens: 200,
		json: false, // prose output — forced JSON makes flash wrap it in envelopes
	});
	const gist = result.text.trim();
	if (!gist) return false;
	// Grounding guard (learned from a live failure: flash once answered
	// "[2025.10]" for a degenerate fragment): the gist must share at least one
	// real token with the raw source — verbatim-grounding, enforced in code.
	const source = `${row.query}\n${row.answer}`;
	const tokens = gist.match(/[\u4e00-\u9fff]{2,}|[A-Za-z0-9]{4,}/g) ?? [];
	if (tokens.length === 0 || !tokens.some((t) => source.includes(t))) return false;
	setReplyGist(db, topicId, replyId, gist);
	return true;
}

/**
 * Nightly gist regeneration (dream tier, k3-class thinking): rewrite the gists
 * of recently-active topics from their raw turns. Daytime gists (flash) are
 * views over the raw record — regeneration is the drift-repair loop.
 */
export async function regenRecentGists(
	db: ReturnType<typeof getDb>,
	opts: { days?: number; max?: number } = {},
): Promise<number> {
	const days = opts.days ?? 7;
	const max = opts.max ?? 150;
	const rows = db
		.prepare(
			`SELECT r.topic_id, r.reply_id FROM replies r JOIN topics t ON t.topic_id = r.topic_id
			 WHERE r.answer != '' AND t.last_seen_at > datetime('now', ?)
			 ORDER BY r.topic_id DESC, r.reply_id ASC LIMIT ?`,
		)
		.all(`-${days} days`, max) as unknown as { topic_id: number; reply_id: number }[];
	let n = 0;
	for (const r of rows) {
		try {
			if (await generateReplyGist(db, r.topic_id, r.reply_id, { dream: true })) n++;
		} catch {
			// Keep the old gist; tomorrow is another run.
		}
	}
	return n;
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
	const contextQuery = turn ? withTopicContext(query, assembleTopicContext(db, turn.topicId, topicSummary)) : query;
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
