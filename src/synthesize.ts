/**
 * Profile synthesis ("炼丹"): integrate the memory store into per-theme profile
 * chapters — the person's thinking/methods/preferences in each facet of life.
 * Runs weekly (or after big imports); each run re-synthesizes and version-bumps.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import { getDb, listMemories, upsertProfile } from "./db.ts";
import type { MemoryRow } from "./types.ts";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";

export interface SynthesizeReport {
	themes: number;
	updated: { theme: string; title: string; version: number; members: number }[];
	skipped: boolean;
}

const MIN_MEMORIES = 10;
const MAX_THEMES = 8;
const MIN_THEME_MEMBERS = 2;

export async function runSynthesize(owner: string): Promise<SynthesizeReport> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const memories = listMemories(db, { owner, status: "active", limit: 1000 });
	const report: SynthesizeReport = { themes: 0, updated: [], skipped: false };

	if (memories.length < MIN_MEMORIES) {
		report.skipped = true;
		return report;
	}

	// Phase 1: cluster the store into themes.
	const listing = memories
		.map((m) => `[${m.id}] (${m.kind}${m.domain ? "/" + m.domain : ""}, ev${m.evidence}) ${m.summary}`)
		.join("\n");
	const clustered = await completeJson<{ themes: { theme: string; title: string; member_ids: number[] }[] }>({
		system: loadPrompt("synthesize-cluster"),
		user: `MEMORIES:\n${listing}\n\nReturn at most ${MAX_THEMES} themes.`,
		runId: `synthesize-${Date.now()}`,
		step: "synthesize-cluster",
		maxTokens: 16384,
	});

	const byId = new Map(memories.map((m) => [m.id, m]));
	const themes = (clustered.themes ?? [])
		.filter((t) => t.member_ids?.filter((id) => byId.has(id)).length >= MIN_THEME_MEMBERS)
		.slice(0, MAX_THEMES);

	// Phase 2: synthesize each theme chapter from full member contents.
	const outDir = resolve(PROJECT_ROOT, "profiles");
	mkdirSync(outDir, { recursive: true });
	for (const t of themes) {
		const members = t.member_ids.map((id) => byId.get(id)).filter((m): m is MemoryRow => !!m);
		const material = members
			.map(
				(m) =>
					`[#${m.id}] (${m.kind}, evidence ${m.evidence}, confidence ${m.confidence}, last seen ${m.last_seen_at.slice(0, 10)})\n${m.summary}\n${m.content}`,
			)
			.join("\n\n");
		const chapter = await completeJson<{ chapter: string }>({
			system: loadPrompt("synthesize-theme"),
			user: `THEME: ${t.title}\n\nMEMBER MEMORIES:\n${material}\n\nReturn ONLY JSON: {"chapter": "..."} (markdown inside the string).`,
			runId: `synthesize-${Date.now()}`,
			step: `synthesize-theme:${t.theme}`,
			maxTokens: 8192,
		});
		const content = chapter.chapter?.trim();
		if (!content) continue;

		const row = upsertProfile(db, owner, t.theme, t.title, content, members.map((m) => m.id));
		writeFileSync(
			resolve(outDir, `${t.theme}.md`),
			`# ${t.title}\n\n> ruyi profile · theme \`${t.theme}\` · v${row.version} · ${row.updated_at.slice(0, 10)} · ${members.length} memories\n\n${content}\n`,
		);
		report.updated.push({ theme: t.theme, title: t.title, version: row.version, members: members.length });
	}
	report.themes = report.updated.length;

	// Themes that disappeared from clustering keep their old profile (stale is
	// better than vanished); they will refresh next time they re-form.
	return report;
}
