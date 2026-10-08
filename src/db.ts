import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Candidate, MemoryRow } from "./types.ts";

let db: DatabaseSync | undefined;

/**
 * Schema versioning via PRAGMA user_version.
 * v0 = original release (unicode61 FTS, no keywords/absorbed_by, no recall_log).
 * v1 = trigram FTS (summary+keywords+content), memories.keywords, memories.absorbed_by,
 *      token_log.latency_ms, recall_log table.
 * v2 = profiles.maturity + profiles.status, slot_demands table (skill-slot demand loop).
 */
const SCHEMA_VERSION = 2;

function migrate(d: DatabaseSync, from: number): void {
	if (from < 1) {
		// FTS rebuild with trigram tokenizer + keywords column.
		d.exec(`
			ALTER TABLE memories ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
			ALTER TABLE memories ADD COLUMN absorbed_by INTEGER;
			ALTER TABLE token_log ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0;
			DROP TRIGGER IF EXISTS memories_ai;
			DROP TRIGGER IF EXISTS memories_ad;
			DROP TRIGGER IF EXISTS memories_au;
			DROP TABLE IF EXISTS memories_fts;
		`);
		createFts(d);
		createRecallLog(d);
		d.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
	}
	if (from < 2) {
		d.exec(`
			ALTER TABLE profiles ADD COLUMN maturity TEXT NOT NULL DEFAULT 'mature';
			ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
		`);
		createSlotDemands(d);
	}
}

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  summary, keywords, content, content='memories', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, keywords, content) VALUES (new.id, new.summary, new.keywords, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, keywords, content) VALUES('delete', old.id, old.summary, old.keywords, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, keywords, content) VALUES('delete', old.id, old.summary, old.keywords, old.content);
  INSERT INTO memories_fts(rowid, summary, keywords, content) VALUES (new.id, new.summary, new.keywords, new.content);
END;
`;

function createFts(d: DatabaseSync): void {
	d.exec(FTS_SCHEMA);
}

function createRecallLog(d: DatabaseSync): void {
	d.exec(`
CREATE TABLE IF NOT EXISTS recall_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  owner      TEXT NOT NULL DEFAULT 'default',
  query      TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'deep',
  hits       INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_recall_log_at ON recall_log(at);
	`);
}

function createSlotDemands(d: DatabaseSync): void {
	d.exec(`
CREATE TABLE IF NOT EXISTS slot_demands (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner          TEXT NOT NULL DEFAULT 'default',
  domain         TEXT NOT NULL,
  demand_count   INTEGER NOT NULL DEFAULT 1,
  last_demand_at TEXT NOT NULL,
  UNIQUE(owner, domain)
);
	`);
}

/** Record demand for domains a recall could not satisfy (feeds the skill-slot loop). */
export function bumpSlotDemand(d: DatabaseSync, owner: string, domains: string[]): void {
	const t = now();
	const stmt = d.prepare(
		`INSERT INTO slot_demands (owner, domain, demand_count, last_demand_at) VALUES (?, ?, 1, ?)
		 ON CONFLICT(owner, domain) DO UPDATE SET demand_count = demand_count + 1, last_demand_at = excluded.last_demand_at`,
	);
	for (const domain of domains.slice(0, 5)) {
		const clean = domain.trim().slice(0, 60);
		if (clean) {
			try {
				stmt.run(owner, clean, t);
			} catch {
				// best effort
			}
		}
	}
}

export function getSlotDemands(
	d: DatabaseSync,
	owner: string,
): { domain: string; demand_count: number; last_demand_at: string }[] {
	return d
		.prepare(
			`SELECT domain, demand_count, last_demand_at FROM slot_demands WHERE owner = ? ORDER BY demand_count DESC, last_demand_at DESC`,
		)
		.all(owner) as unknown as { domain: string; demand_count: number; last_demand_at: string }[];
}

export function getDb(dbPath: string): DatabaseSync {
	if (db) return db;
	mkdirSync(dirname(dbPath), { recursive: true });
	db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	// Multiple clients share one store (service + MCP stdio processes + CLI);
	// WAL allows one writer at a time — wait briefly instead of failing.
	db.exec("PRAGMA busy_timeout = 5000");
	// Detect legacy DB before creating anything: a fresh install gets the latest
	// schema directly and must NOT run migrations (its columns already exist).
	const priorVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	const hadMemories = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get();
	db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner         TEXT NOT NULL DEFAULT 'default',
  cwd           TEXT,
  kind          TEXT NOT NULL,
  domain        TEXT,
  summary       TEXT NOT NULL,
  content       TEXT NOT NULL,
  keywords      TEXT NOT NULL DEFAULT '',
  origin        TEXT NOT NULL DEFAULT 'agent_inferred',
  confidence    REAL NOT NULL DEFAULT 0.5,
  evidence      INTEGER NOT NULL DEFAULT 1,
  source        TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER,
  absorbed_by   INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned, status);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner, status);

CREATE TABLE IF NOT EXISTS distill_state (
  session_file    TEXT PRIMARY KEY,
  processed_bytes INTEGER NOT NULL DEFAULT 0,
  gist            TEXT NOT NULL DEFAULT '',
  processed_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS token_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  run_id         TEXT,
  step           TEXT NOT NULL,
  session_file   TEXT,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  latency_ms     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_token_log_at ON token_log(at);

CREATE TABLE IF NOT EXISTS memory_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  run_id  TEXT,
  action  TEXT NOT NULL,
  detail  TEXT
);

-- Second-level synthesis: theme profiles distilled FROM the memory store
-- (the person's programming style, shopping taste, ... — not per-episode fragments).
CREATE TABLE IF NOT EXISTS profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner      TEXT NOT NULL DEFAULT 'default',
  theme      TEXT NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  memory_ids TEXT NOT NULL DEFAULT '[]',
  maturity   TEXT NOT NULL DEFAULT 'mature',
  status     TEXT NOT NULL DEFAULT 'active',
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner, theme)
);
`);
	createFts(db);
	createRecallLog(db);
	createSlotDemands(db);

	if (!hadMemories) {
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	} else if (priorVersion < SCHEMA_VERSION) {
		migrate(db, priorVersion);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}
	return db;
}

export const now = (): string => new Date().toISOString();

export function insertMemory(
	d: DatabaseSync,
	c: Candidate & { source?: string | null },
	scope: { owner: string; cwd: string | null },
): number {
	const t = now();
	const r = d
		.prepare(
			`INSERT INTO memories (owner, cwd, kind, domain, summary, content, keywords, origin, confidence, evidence, source, created_at, updated_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
		)
		.run(scope.owner, scope.cwd, c.kind, c.domain ?? null, c.summary, c.content, (c.keywords ?? []).join(" "), c.origin, c.confidence, c.source ?? null, t, t, t);
	return Number(r.lastInsertRowid);
}

export function reinforceMemory(d: DatabaseSync, id: number): void {
	d.prepare(
		`UPDATE memories SET evidence = evidence + 1, last_seen_at = ?, updated_at = ?,
		 confidence = MIN(1.0, confidence + 0.05) WHERE id = ?`,
	).run(now(), now(), id);
}

export function refineMemory(
	d: DatabaseSync,
	id: number,
	summary: string | undefined,
	content: string,
	keywords?: string[],
): void {
	const kw = keywords && keywords.length > 0 ? keywords.join(" ") : null;
	if (summary) {
		d.prepare(
			`UPDATE memories SET summary = ?, content = ?, keywords = COALESCE(?, keywords), evidence = evidence + 1, updated_at = ?, last_seen_at = ? WHERE id = ?`,
		).run(summary, content, kw, now(), now(), id);
	} else {
		d.prepare(
			`UPDATE memories SET content = ?, keywords = COALESCE(?, keywords), evidence = evidence + 1, updated_at = ?, last_seen_at = ? WHERE id = ?`,
		).run(content, kw, now(), now(), id);
	}
}

export function supersedeMemory(
	d: DatabaseSync,
	oldId: number,
	c: Candidate & { source?: string | null },
	scope: { owner: string; cwd: string | null },
): number {
	const newId = insertMemory(d, c, scope);
	d.prepare(`UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`).run(
		newId,
		now(),
		oldId,
	);
	return newId;
}

export function archiveMemory(d: DatabaseSync, id: number): void {
	d.prepare(`UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`).run(now(), id);
}

export function getMemory(d: DatabaseSync, id: number): MemoryRow | undefined {
	return d.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined;
}

export function listMemories(
	d: DatabaseSync,
	opts: { status?: string; limit?: number; owner?: string } = {},
): MemoryRow[] {
	const status = opts.status ?? "active";
	const limit = opts.limit ?? 100;
	const owner = opts.owner ?? "default";
	return d
		.prepare(
			`SELECT * FROM memories WHERE status = ? AND owner = ? ORDER BY pinned DESC, last_seen_at DESC LIMIT ?`,
		)
		.all(status, owner, limit) as unknown as MemoryRow[];
}

export function getByIds(d: DatabaseSync, ids: number[]): MemoryRow[] {
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(",");
	const rows = d
		.prepare(`SELECT * FROM memories WHERE id IN (${placeholders}) AND status = 'active'`)
		.all(...ids) as unknown as MemoryRow[];
	const order = new Map(ids.map((id, i) => [id, i]));
	return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** All active memories eligible as merge/recall candidates for one owner, newest first. */
export function activeCandidates(d: DatabaseSync, days: number, owner: string): MemoryRow[] {
	const since = new Date(Date.now() - days * 86_400_000).toISOString();
	return d
		.prepare(
			`SELECT * FROM memories WHERE status = 'active' AND owner = ?
			 AND (pinned = 1 OR evidence >= 3 OR last_seen_at >= ?)
			 ORDER BY last_seen_at DESC`,
		)
		.all(owner, since) as unknown as MemoryRow[];
}

export type RecallScope = "smart" | "cwd" | "all";

/**
 * Scope filter for recall/injection:
 *  - smart: personal kinds (preference/fact) are global; project/lesson/skill_index stay in their cwd
 *  - cwd:   strict per-directory isolation
 *  - all:   no directory filtering
 */
export function scopeFilter(scope: RecallScope, cwd: string | null): { where: string; params: string[] } {
	if (scope === "all" || !cwd) return { where: "", params: [] };
	if (scope === "cwd") return { where: "AND (m.cwd = ? OR m.cwd IS NULL)", params: [cwd] };
	return {
		where: "AND (m.cwd = ? OR m.cwd IS NULL OR m.kind IN ('preference', 'fact', 'knowledge'))",
		params: [cwd],
	};
}

export interface FtsHit {
	row: MemoryRow;
	/** 1.0 = FTS BM25 hit, 0.5 = short-term LIKE fallback hit. P2 fusion scoring refines this. */
	hitScore: number;
}

/**
 * Hybrid full-store retrieval over the trigram FTS index.
 * Trigram silently misses terms shorter than 3 chars (very common in Chinese:
 * 部署, 配置...), so 2-char terms go through a LIKE fallback and results are unioned.
 * Cost is proportional to matches, not store size — no recency/evidence gate.
 */
export function ftsSearch(d: DatabaseSync, query: string, limit: number, owner: string, statuses?: string[]): MemoryRow[] {
	return ftsSearchScored(d, query, limit, owner, statuses).map((h) => h.row);
}

export function ftsSearchScored(
	d: DatabaseSync,
	query: string,
	limit: number,
	owner: string,
	statuses: string[] = ["active"],
): FtsHit[] {
	const terms = query
		.replace(/"/g, " ")
		.split(/[\s,，。.!！?？：:；;、（）()\[\]{}「」""'']+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2)
		.slice(0, 12);
	if (terms.length === 0) return [];

	const statusIn = statuses.map(() => "?").join(",");
	const ftsTerms = terms.filter((t) => t.length >= 3);
	const likeTerms = terms.filter((t) => t.length === 2);
	const hits = new Map<number, FtsHit>();

	if (ftsTerms.length > 0) {
		const match = ftsTerms.map((t) => `"${t}"`).join(" OR ");
		try {
			const rows = d
				.prepare(
					`SELECT m.*, rank FROM memories_fts f JOIN memories m ON m.id = f.rowid
					 WHERE memories_fts MATCH ? AND m.status IN (${statusIn}) AND m.owner = ?
					 ORDER BY rank LIMIT ?`,
				)
				.all(match, ...statuses, owner, limit) as unknown as (MemoryRow & { rank: number })[];
			for (const row of rows) hits.set(row.id, { row, hitScore: 1 });
		} catch {
			// FTS syntax errors must never break recall.
		}
	}

	for (const t of likeTerms) {
		try {
			const rows = d
				.prepare(
					`SELECT * FROM memories WHERE status IN (${statusIn}) AND owner = ?
					 AND (summary LIKE ? OR keywords LIKE ? OR content LIKE ?)
					 ORDER BY last_seen_at DESC LIMIT ?`,
				)
				.all(...statuses, owner, `%${t}%`, `%${t}%`, `%${t}%`, 20) as unknown as MemoryRow[];
			for (const row of rows) if (!hits.has(row.id)) hits.set(row.id, { row, hitScore: 0.5 });
		} catch {
			// ignore
		}
	}

	return [...hits.values()]
		.sort((a, b) => b.hitScore - a.hitScore || b.row.last_seen_at.localeCompare(a.row.last_seen_at))
		.slice(0, limit);
}

export function setDistillState(d: DatabaseSync, file: string, bytes: number, gist: string): void {
	d.prepare(
		`INSERT INTO distill_state (session_file, processed_bytes, gist, processed_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(session_file) DO UPDATE SET processed_bytes = excluded.processed_bytes,
		 gist = excluded.gist, processed_at = excluded.processed_at`,
	).run(file, bytes, gist, now());
}

export function getDistillState(
	d: DatabaseSync,
	file: string,
): { processed_bytes: number; gist: string } | undefined {
	return d.prepare(`SELECT processed_bytes, gist FROM distill_state WHERE session_file = ?`).get(file) as
		| { processed_bytes: number; gist: string }
		| undefined;
}

export function logTokens(
	d: DatabaseSync,
	entry: { runId?: string; step: string; sessionFile?: string; model: string; input: number; output: number; latencyMs?: number },
): void {
	d.prepare(
		`INSERT INTO token_log (at, run_id, step, session_file, model, input_tokens, output_tokens, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(now(), entry.runId ?? null, entry.step, entry.sessionFile ?? null, entry.model, entry.input, entry.output, entry.latencyMs ?? 0);
}

/** Every recall call, for demand-signal analysis (P3 槽位需求闭环) and latency observability. */
export function logRecall(
	d: DatabaseSync,
	entry: { owner: string; query: string; mode?: string; hits: number; latencyMs: number; detail?: unknown },
): void {
	try {
		d.prepare(
			`INSERT INTO recall_log (at, owner, query, mode, hits, latency_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(now(), entry.owner, entry.query.slice(0, 500), entry.mode ?? "deep", entry.hits, entry.latencyMs, entry.detail ? JSON.stringify(entry.detail) : null);
	} catch {
		// Recall logging must never break a request.
	}
}

export function logMemoryAction(d: DatabaseSync, runId: string | null, action: string, detail: unknown): void {
	d.prepare(`INSERT INTO memory_log (at, run_id, action, detail) VALUES (?, ?, ?, ?)`).run(
		now(),
		runId,
		action,
		JSON.stringify(detail),
	);
}

export function tokenUsage(d: DatabaseSync, days: number): { day: string; step: string; input: number; output: number }[] {
	const since = new Date(Date.now() - days * 86_400_000).toISOString();
	return d
		.prepare(
			`SELECT substr(at, 1, 10) AS day, step, SUM(input_tokens) AS input, SUM(output_tokens) AS output
			 FROM token_log WHERE at >= ? GROUP BY day, step ORDER BY day DESC, step`,
		)
		.all(since) as unknown as { day: string; step: string; input: number; output: number }[];
}

export interface ProfileRow {
	id: number;
	owner: string;
	theme: string;
	title: string;
	content: string;
	memory_ids: string;
	maturity: "seeding" | "mature" | string;
	status: string;
	version: number;
	created_at: string;
	updated_at: string;
}

/** Insert or update (version-bump) the profile for (owner, theme). */
export function upsertProfile(
	d: DatabaseSync,
	owner: string,
	theme: string,
	title: string,
	content: string,
	memoryIds: number[],
	maturity: "seeding" | "mature" = "mature",
): ProfileRow {
	const now = new Date().toISOString();
	d.prepare(
		`INSERT INTO profiles (owner, theme, title, content, memory_ids, maturity, version, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
		 ON CONFLICT(owner, theme) DO UPDATE SET
		   title = excluded.title, content = excluded.content, memory_ids = excluded.memory_ids,
		   maturity = excluded.maturity,
		   version = version + 1, updated_at = excluded.updated_at`,
	).run(owner, theme, title, content, JSON.stringify(memoryIds), maturity, now, now);
	return d.prepare(`SELECT * FROM profiles WHERE owner = ? AND theme = ?`).get(owner, theme) as unknown as ProfileRow;
}

export function listProfiles(d: DatabaseSync, owner: string): ProfileRow[] {
	return d.prepare(`SELECT * FROM profiles WHERE owner = ? ORDER BY updated_at DESC`).all(owner) as unknown as ProfileRow[];
}

export function getProfile(d: DatabaseSync, id: number): ProfileRow | null {
	return (d.prepare(`SELECT * FROM profiles WHERE id = ?`).get(id) as unknown as ProfileRow) ?? null;
}

export function memoryCounts(d: DatabaseSync, owner?: string): Record<string, number> {
	const rows = (
		owner
			? d.prepare(`SELECT status, COUNT(*) AS n FROM memories WHERE owner = ? GROUP BY status`).all(owner)
			: d.prepare(`SELECT status, COUNT(*) AS n FROM memories GROUP BY status`).all()
	) as unknown as {
		status: string;
		n: number;
	}[];
	const out: Record<string, number> = {};
	for (const r of rows) out[r.status] = r.n;
	return out;
}
