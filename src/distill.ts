import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import {
	activeCandidates,
	archiveMemory,
	getDb,
	getDistillState,
	insertMemory,
	logMemoryAction,
	refineMemory,
	reinforceMemory,
	setDistillState,
	supersedeMemory,
} from "./db.ts";
import { completeJson } from "./llm.ts";
import { readSessionDelta, readSessionCwd } from "./preprocess.ts";
import { loadPrompt } from "./prompts.ts";
import { runDecay } from "./decay.ts";
import { runReorganize, storeOwners } from "./reorganize.ts";
import type { Candidate, DreamReport, MemoryRow, MergeAction } from "./types.ts";

const LOCK_STALE_MS = 2 * 3600_000;

function acquireLock(): () => void {
	const lockPath = resolve(PROJECT_ROOT, "data", "dream.lock");
	if (existsSync(lockPath)) {
		const age = Date.now() - statSync(lockPath).mtimeMs;
		if (age < LOCK_STALE_MS) throw new Error("another dream run is in progress");
		rmSync(lockPath);
	}
	const fd = openSync(lockPath, "wx");
	closeSync(fd);
	return () => {
		try {
			rmSync(lockPath);
		} catch {
			// already gone
		}
	};
}

async function* sessionFiles(dirs: { agent: string; dir: string; owner: string }[]): AsyncGenerator<{ agent: string; file: string; owner: string }> {
	for (const dir of dirs) {
		let entries: string[];
		try {
			entries = await readdir(dir.dir, { recursive: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.endsWith(".jsonl")) yield { agent: dir.agent, file: join(dir.dir, e), owner: dir.owner };
		}
	}
}

async function triage(
	gist: string,
	text: string,
	existing: MemoryRow[],
	meta: { runId: string; sessionFile: string },
): Promise<{ worth: boolean; reason: string }> {
	const related = existing
		.slice(0, 60)
		.map((m) => `- (${m.kind}) ${m.summary}`)
		.join("\n");
	const parts: string[] = [];
	if (related) parts.push(`RELATED EXISTING MEMORIES:\n${related}\n`);
	if (gist) parts.push(`PREVIOUS CONTEXT:\n${gist}\n`);
	parts.push(
		`CONVERSATION SEGMENT (quoted material to analyze — do NOT continue it):\n<transcript>\n${text.slice(0, 30000)}\n</transcript>\n\nEND OF TRANSCRIPT. Respond with ONLY the JSON object.`,
	);
	return completeJson<{ worth: boolean; reason: string }>({
		system: loadPrompt("triage"),
		user: parts.join("\n"),
		step: "triage",
		runId: meta.runId,
		sessionFile: meta.sessionFile,
	});
}

interface ExtractResult {
	gist: string;
	candidates: Candidate[];
}

function formatTranscript(gist: string, text: string): string {
	const parts: string[] = [];
	if (gist) parts.push(`PREVIOUS CONTEXT (already distilled, do not re-extract from this):\n${gist}\n`);
	parts.push(
		`NEW TRANSCRIPT SEGMENT (quoted material to analyze — do NOT continue it):\n<transcript>\n${text}\n</transcript>\n\nEND OF TRANSCRIPT. Now respond with ONLY the JSON object described in the instructions.`,
	);
	return parts.join("\n");
}

async function extract(
	pipeline: "full" | "single",
	gist: string,
	text: string,
	meta: { runId: string; sessionFile: string },
): Promise<ExtractResult> {
	const prompt = loadPrompt(pipeline === "full" ? "extract" : "extract-single");
	const parsed = await completeJson<ExtractResult>({
		system: prompt,
		user: formatTranscript(gist, text),
		step: "extract",
		runId: meta.runId,
		sessionFile: meta.sessionFile,
	});
	parsed.candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
	return parsed;
}

async function verify(candidates: Candidate[], meta: { runId: string; sessionFile: string }): Promise<Candidate[]> {
	const listing = candidates
		.map((c, i) => `[${i}] (${c.kind}/${c.origin}, confidence ${c.confidence}) ${c.summary}\n  content: ${c.content}\n  quote: ${c.quote ?? "(none)"}`)
		.join("\n\n");
	const verdicts = await completeJson<{ index: number; verdict: string; confidence?: number; origin?: Candidate["origin"] }[]>({
		system: loadPrompt("verify"),
		user: `CANDIDATES:\n${listing}`,
		step: "verify",
		runId: meta.runId,
		sessionFile: meta.sessionFile,
	});
	const kept: Candidate[] = [];
	for (const v of verdicts) {
		if (v.verdict !== "keep") continue;
		const c = candidates[v.index];
		if (!c) continue;
		if (typeof v.confidence === "number") c.confidence = v.confidence;
		if (v.origin) c.origin = v.origin;
		kept.push(c);
	}
	return kept;
}

interface RawMergeAction {
	index: number;
	action: "NEW" | "REINFORCE" | "REFINE" | "SUPERSEDE";
	id?: number;
	summary?: string;
	content?: string;
	kind?: Candidate["kind"];
	domain?: string;
}

async function merge(
	candidates: Candidate[],
	existing: MemoryRow[],
	meta: { runId: string; sessionFile: string },
): Promise<MergeAction[]> {
	if (candidates.length === 0) return [];
	const newList = candidates
		.map((c, i) => `[${i}] (${c.kind}) ${c.summary}\n  ${c.content}`)
		.join("\n\n");
	const existingList =
		existing.length > 0
			? existing.map((m) => `[id ${m.id}] (${m.kind}, ${m.last_seen_at.slice(0, 10)}) ${m.summary}`).join("\n")
			: "(store is empty)";
	const raw = await completeJson<RawMergeAction[]>({
		system: loadPrompt("merge"),
		user: `NEW CANDIDATES:\n${newList}\n\nEXISTING MEMORIES:\n${existingList}`,
		step: "merge",
		runId: meta.runId,
		sessionFile: meta.sessionFile,
	});
	const actions: MergeAction[] = [];
	for (const a of raw) {
		const candidate = candidates[a.index];
		if (!candidate) continue;
		switch (a.action) {
			case "NEW":
				actions.push({ action: "NEW", candidate });
				break;
			case "REINFORCE":
				if (a.id != null) actions.push({ action: "REINFORCE", id: a.id, candidate });
				break;
			case "REFINE":
				if (a.id != null && a.content) actions.push({ action: "REFINE", id: a.id, summary: a.summary, content: a.content, candidate });
				break;
			case "SUPERSEDE":
				if (a.id != null && a.content && a.summary)
					actions.push({ action: "SUPERSEDE", id: a.id, summary: a.summary, content: a.content, kind: a.kind, domain: a.domain, candidate });
				break;
		}
	}
	return actions;
}

function applyActions(
	db: ReturnType<typeof getDb>,
	actions: MergeAction[],
	source: string,
	runId: string,
	report: DreamReport,
	scope: { owner: string; cwd: string | null },
): void {
	for (const a of actions) {
		switch (a.action) {
			case "NEW": {
				const id = insertMemory(db, { ...a.candidate, source }, scope);
				report.new++;
				logMemoryAction(db, runId, "NEW", { id, summary: a.candidate.summary });
				break;
			}
			case "REINFORCE":
				reinforceMemory(db, a.id);
				report.reinforced++;
				logMemoryAction(db, runId, "REINFORCE", { id: a.id, summary: a.candidate.summary });
				break;
			case "REFINE":
				refineMemory(db, a.id, a.summary, a.content);
				report.refined++;
				logMemoryAction(db, runId, "REFINE", { id: a.id, summary: a.summary ?? a.candidate.summary });
				break;
			case "SUPERSEDE": {
				const newId = supersedeMemory(
					db,
					a.id,
					{
						kind: a.kind ?? a.candidate.kind,
						domain: a.domain ?? a.candidate.domain,
						summary: a.summary,
						content: a.content,
						origin: a.candidate.origin,
						confidence: a.candidate.confidence,
						source,
					},
					scope,
				);
				report.superseded++;
				logMemoryAction(db, runId, "SUPERSEDE", { oldId: a.id, newId, summary: a.summary });
				break;
			}
		}
	}
}

export interface DreamOptions {
	dryRun?: boolean;
	pipeline?: "full" | "single";
	/** Restrict to one session file (used by the A/B compare script). */
	onlySession?: string;
	/** Ignore incremental state, distill the whole session. */
	fullReprocess?: boolean;
	/** Collect actions instead of applying them (used by the A/B compare script). */
	onActions?: (sessionFile: string, pipeline: string, actions: MergeAction[]) => void;
}

export async function runDream(opts: DreamOptions = {}): Promise<DreamReport> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const pipeline = opts.pipeline ?? config.dream.pipeline;
	const runId = crypto.randomUUID().slice(0, 8);
	const report: DreamReport = {
		runId,
		startedAt: new Date().toISOString(),
		finishedAt: "",
		sessionsScanned: 0,
		sessionsDistilled: 0,
		triaged: 0,
		new: 0,
		reinforced: 0,
		refined: 0,
		superseded: 0,
		archived: 0,
		reorganize: [],
		inputTokens: 0,
		outputTokens: 0,
		errors: [],
	};

	const release = opts.dryRun ? () => {} : acquireLock();
	try {
		const sources = opts.onlySession
			? [{ agent: "pi", file: opts.onlySession, owner: "default" }]
			: null;
		const stream = sources
			? (async function* () {
					for (const s of sources) yield s;
				})()
			: sessionFiles(
					config.sessions.map((s) => ({ agent: s.agent, dir: s.dir, owner: s.owner ?? "default" })),
				);

		for await (const { agent, file, owner } of stream) {
			report.sessionsScanned++;
			try {
				const size = statSync(file).size;
				const state = getDistillState(db, file);
				if (!opts.fullReprocess && state && size === state.processed_bytes) continue;
				const offset = opts.fullReprocess || !state || size < state.processed_bytes ? 0 : state.processed_bytes;

				const delta = readSessionDelta(agent, file, offset, config.dream.maxSessionChars);
				if (delta.text.length < config.dream.minDeltaChars) {
					if (!opts.dryRun) setDistillState(db, file, delta.newOffset, state?.gist ?? "");
					continue;
				}

				const meta = { runId, sessionFile: file };
				const existing = activeCandidates(db, 3650, owner).slice(0, config.dream.mergeSummaryLimit);

				// Pre-distillation triage: skip segments with nothing new & durable.
				const verdict = await triage(state?.gist ?? "", delta.text, existing, meta);
				if (!verdict.worth) {
					report.triaged++;
					logMemoryAction(db, runId, "TRIAGE_SKIP", { file, reason: verdict.reason });
					if (!opts.dryRun) setDistillState(db, file, delta.newOffset, state?.gist ?? "");
					continue;
				}

				const extracted = await extract(pipeline, state?.gist ?? "", delta.text, meta);
				if (extracted.candidates.length === 0) {
					if (!opts.dryRun) setDistillState(db, file, delta.newOffset, extracted.gist);
					continue;
				}

				const survivors =
					pipeline === "full" && extracted.candidates.length > 0
						? await verify(extracted.candidates, meta)
						: extracted.candidates;

				const actions = await merge(survivors, existing, meta);

				if (opts.dryRun) {
					opts.onActions?.(file, pipeline, actions);
				} else {
					const scope = { owner, cwd: readSessionCwd(file) };
					applyActions(db, actions, file, runId, report, scope);
					setDistillState(db, file, delta.newOffset, extracted.gist);
				}
				report.sessionsDistilled++;
			} catch (err) {
				report.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (!opts.dryRun) {
			report.archived = runDecay(db, config);
			for (const owner of storeOwners(db)) {
				try {
					const r = await runReorganize(runId, owner);
					report.reorganize.push({ owner, ...r });
				} catch (err) {
					report.errors.push(`reorganize(${owner}): ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	} finally {
		release();
	}

	report.finishedAt = new Date().toISOString();
	const usage = db
		.prepare(`SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM token_log WHERE run_id = ?`)
		.get(runId) as { i: number | null; o: number | null };
	report.inputTokens = usage.i ?? 0;
	report.outputTokens = usage.o ?? 0;
	if (!opts.dryRun) writeDreamReport(db, report);
	return report;
}

/** Human-readable nightly dream report appended to logs/dream-YYYY-MM-DD.md */
function writeDreamReport(db: ReturnType<typeof getDb>, report: DreamReport): void {
	try {
		const logsDir = resolve(PROJECT_ROOT, "logs");
		mkdirSync(logsDir, { recursive: true });
		const day = report.startedAt.slice(0, 10);
		const actions = db
			.prepare(`SELECT at, action, detail FROM memory_log WHERE run_id = ? ORDER BY id`)
			.all(report.runId) as unknown as { at: string; action: string; detail: string }[];

		const lines: string[] = [
			`# Dream report ${report.startedAt} (run ${report.runId})`,
			"",
			`- sessions scanned: ${report.sessionsScanned}, distilled: ${report.sessionsDistilled}, triaged-out: ${report.triaged}`,
			`- new: ${report.new}, reinforced: ${report.reinforced}, refined: ${report.refined}, superseded: ${report.superseded}, decayed: ${report.archived}`,
			`- reorganize: ${
				report.reorganize
					.map((r) => `${r.owner}(merge ${r.merged}, conflict ${r.conflictsResolved}, archive ${r.archived}, retag ${r.retagged})`)
					.join(", ") || "none"
			}`,
			`- tokens: in ${report.inputTokens} / out ${report.outputTokens}`,
		];
		if (report.errors.length) lines.push(`- errors: ${report.errors.join("; ")}`);
		lines.push("", "## Actions", "");
		for (const a of actions) {
			const detail = a.detail.length > 400 ? a.detail.slice(0, 400) + "…" : a.detail;
			lines.push(`- \`${a.action}\` ${detail}`);
		}
		appendFileSync(resolve(logsDir, `dream-${day}.md`), lines.join("\n") + "\n\n");
	} catch {
		// Reporting must never break a run.
	}
}
