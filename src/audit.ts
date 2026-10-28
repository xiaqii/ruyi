/**
 * Standard-upgrade audit: re-judge existing lessons against the current
 * extraction standard (the subject test) and repair the clearly-unfit ones.
 * Born when the "lesson must be abstract" rule landed on a store that already
 * held project-flavored lessons — prompts only govern NEW extractions, so old
 * data needs a sweep channel. Dry-run by default; --apply writes with the
 * original row preserved in memory_log (rollback path) after a DB backup.
 */
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import { getDb, now } from "./db.ts";
import { backupDb } from "./distill.ts";
import { loadConfig } from "./config.ts";

export type Verdict = "ok" | "rewrite" | "fact" | "archive";

export interface AuditItem {
	id: number;
	verdict: Verdict;
	reason: string;
	summary: string;
	newSummary?: string;
	newContent?: string;
}

export interface AuditReport {
	scanned: number;
	items: AuditItem[];
	applied: boolean;
}

const BATCH = 12;

export async function runLessonAudit(opts: { apply?: boolean; limit?: number } = {}): Promise<AuditReport> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const rows = db
		.prepare(`SELECT id, summary, content FROM memories WHERE kind = 'lesson' AND status = 'active' ORDER BY id`)
		.all() as unknown as { id: number; summary: string; content: string }[];
	const scoped = opts.limit ? rows.slice(0, opts.limit) : rows;
	const report: AuditReport = { scanned: scoped.length, items: [], applied: false };

	// Stage 1: batch triage (dream tier — judgment quality is the whole point)
	const verdicts = new Map<number, { verdict: Verdict; reason: string }>();
	for (let i = 0; i < scoped.length; i += BATCH) {
		const batch = scoped.slice(i, i + BATCH);
		const out = await completeJson<{ verdicts: { id: number; verdict: Verdict; reason: string }[] }>({
			system: loadPrompt("audit-lessons"),
			user: JSON.stringify(batch.map((r) => ({ id: r.id, summary: r.summary, content: r.content }))),
			step: "audit-triage",
			maxTokens: 4000,
		});
		for (const v of out.verdicts ?? []) verdicts.set(v.id, { verdict: v.verdict, reason: v.reason ?? "" });
	}

	// Stage 2: individual rewrites (dream tier), verbatim-fact discipline
	for (const r of scoped) {
		const v = verdicts.get(r.id);
		if (!v || v.verdict === "ok") continue;
		const item: AuditItem = { id: r.id, verdict: v.verdict, reason: v.reason, summary: r.summary };
		if (v.verdict === "rewrite") {
			try {
				const rw = await completeJson<{ summary: string; content: string }>({
					system: loadPrompt("audit-rewrite"),
					user: JSON.stringify({ id: r.id, summary: r.summary, content: r.content }),
					step: "audit-rewrite",
					maxTokens: 2000,
				});
				if (rw.summary?.trim() && rw.content?.trim()) {
					item.newSummary = rw.summary.trim();
					item.newContent = rw.content.trim();
				} else {
					item.verdict = "ok";
					item.reason = `${v.reason}（重写产出为空，跳过）`;
				}
			} catch (err) {
				item.verdict = "ok";
				item.reason = `${v.reason}（重写失败：${err instanceof Error ? err.message : String(err)}）`;
			}
		}
		report.items.push(item);
	}

	if (!opts.apply || report.items.length === 0) return report;

	// Apply: backup first, original row preserved in memory_log for rollback
	const backup = backupDb(config.dbPath, config.dream.keepBackups ?? 7);
	if (backup) console.log(`[audit] pre-apply backup: ${backup}`);
	const runId = `audit-${crypto.randomUUID().slice(0, 8)}`;
	const at = now();
	for (const item of report.items) {
		const old = db.prepare(`SELECT kind, summary, content FROM memories WHERE id = ?`).get(item.id) as
			| { kind: string; summary: string; content: string }
			| undefined;
		if (!old) continue;
		const trail = JSON.stringify({ old_kind: old.kind, old_summary: old.summary, old_content: old.content, reason: item.reason });
		if (item.verdict === "rewrite" && item.newSummary && item.newContent) {
			db.prepare(`UPDATE memories SET summary = ?, content = ?, updated_at = ? WHERE id = ?`).run(item.newSummary, item.newContent, at, item.id);
			db.prepare(`INSERT INTO memory_log (at, run_id, action, detail) VALUES (?, ?, ?, ?)`).run(at, runId, "AUDIT_REWRITE", `#${item.id} ${trail}`);
		} else if (item.verdict === "fact") {
			db.prepare(`UPDATE memories SET kind = 'fact', updated_at = ? WHERE id = ?`).run(at, item.id);
			db.prepare(`INSERT INTO memory_log (at, run_id, action, detail) VALUES (?, ?, ?, ?)`).run(at, runId, "AUDIT_RECLASSIFY", `#${item.id} lesson→fact ${trail}`);
		} else if (item.verdict === "archive") {
			db.prepare(`UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`).run(at, item.id);
			db.prepare(`INSERT INTO memory_log (at, run_id, action, detail) VALUES (?, ?, ?, ?)`).run(at, runId, "AUDIT_ARCHIVE", `#${item.id} 剧集内容出清 ${trail}`);
		}
	}
	report.applied = true;
	return report;
}
