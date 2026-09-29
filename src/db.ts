import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Candidate, MemoryRow } from "./types.ts";

let db: DatabaseSync | undefined;

export function getDb(dbPath: string): DatabaseSync {
	if (db) return db;
	mkdirSync(dirname(dbPath), { recursive: true });
	db = new DatabaseSync(dbPath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner         TEXT NOT NULL DEFAULT 'default',
  cwd           TEXT,
  kind          TEXT NOT NULL,
  domain        TEXT,
  summary       TEXT NOT NULL,
  content       TEXT NOT NULL,
  origin        TEXT NOT NULL DEFAULT 'agent_inferred',
  confidence    REAL NOT NULL DEFAULT 0.5,
  evidence      INTEGER NOT NULL DEFAULT 1,
  source        TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned, status);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner, status);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  summary, content, content='memories', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, content) VALUES (new.id, new.summary, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content) VALUES('delete', old.id, old.summary, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content) VALUES('delete', old.id, old.summary, old.content);
  INSERT INTO memories_fts(rowid, summary, content) VALUES (new.id, new.summary, new.content);
END;

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
  output_tokens  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_log_at ON token_log(at);

CREATE TABLE IF NOT EXISTS memory_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  run_id  TEXT,
  action  TEXT NOT NULL,
  detail  TEXT
);
`);
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
			`INSERT INTO memories (owner, cwd, kind, domain, summary, content, origin, confidence, evidence, source, created_at, updated_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
		)
		.run(scope.owner, scope.cwd, c.kind, c.domain ?? null, c.summary, c.content, c.origin, c.confidence, c.source ?? null, t, t, t);
	return Number(r.lastInsertRowid);
}

export function reinforceMemory(d: DatabaseSync, id: number): void {
	d.prepare(
		`UPDATE memories SET evidence = evidence + 1, last_seen_at = ?, updated_at = ?,
		 confidence = MIN(1.0, confidence + 0.05) WHERE id = ?`,
	).run(now(), now(), id);
}

export function refineMemory(d: DatabaseSync, id: number, summary: string | undefined, content: string): void {
	if (summary) {
		d.prepare(
			`UPDATE memories SET summary = ?, content = ?, evidence = evidence + 1, updated_at = ?, last_seen_at = ? WHERE id = ?`,
		).run(summary, content, now(), now(), id);
	} else {
		d.prepare(
			`UPDATE memories SET content = ?, evidence = evidence + 1, updated_at = ?, last_seen_at = ? WHERE id = ?`,
		).run(content, now(), now(), id);
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
		where: "AND (m.cwd = ? OR m.cwd IS NULL OR m.kind IN ('preference', 'fact'))",
		params: [cwd],
	};
}

export function ftsSearch(d: DatabaseSync, query: string, limit: number, owner: string): MemoryRow[] {
	// Escape double quotes for FTS5; OR-join terms for broad candidate generation.
	const terms = query
		.replace(/"/g, " ")
		.split(/[\s,，。.!！?？:：;；]+/)
		.filter((t) => t.length >= 2)
		.slice(0, 12);
	if (terms.length === 0) return [];
	const match = terms.map((t) => `"${t}"`).join(" OR ");
	try {
		return d
			.prepare(
				`SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
				 WHERE memories_fts MATCH ? AND m.status = 'active' AND m.owner = ?
				 ORDER BY rank LIMIT ?`,
			)
			.all(match, owner, limit) as unknown as MemoryRow[];
	} catch {
		return [];
	}
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
	entry: { runId?: string; step: string; sessionFile?: string; model: string; input: number; output: number },
): void {
	d.prepare(
		`INSERT INTO token_log (at, run_id, step, session_file, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(now(), entry.runId ?? null, entry.step, entry.sessionFile ?? null, entry.model, entry.input, entry.output);
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
