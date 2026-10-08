/**
 * Profile synthesis ("炼丹") v2: integrate the memory store into per-theme
 * profile chapters — the person's thinking/methods/preferences in each facet.
 *
 * v2 changes (see docs/design-v2.md §3.2):
 *  - Absorption: members fully covered by a MATURE chapter are demoted to
 *    status='absorbed' (linked via absorbed_by), leaving the active working
 *    set small. Pinned, graduated habits (evidence>=5) and warm (<30d)
 *    memories are exempt.
 *  - Maturity tiers: chapters with >= 5 members are 'mature', smaller ones
 *    'seeding' (marked as partial experience; no absorption).
 *  - Chapters never shrink: previous members (incl. already-absorbed ones)
 *    always join the re-synthesis material.
 *  - Demand priority: slot_demands (domains recall users keep asking about
 *    but finding little) steer the clustering prompt.
 * Runs weekly (or after big imports); each run re-synthesizes and version-bumps.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import { getDb, getSlotDemands, listMemories, listProfiles, logMemoryAction, upsertProfile } from "./db.ts";
import type { MemoryRow } from "./types.ts";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";

export interface SynthesizeReport {
	themes: number;
	updated: { theme: string; title: string; version: number; members: number; maturity: string; absorbed: number }[];
	skipped: boolean;
}

const MIN_MEMORIES = 10;
const MAX_THEMES = 10;
const MIN_THEME_MEMBERS = 2;
const MATURE_MEMBERS = 5;
/** Absorption exempts memories seen within this window (still warm). */
const ABSORB_WARM_DAYS = 30;

/** A memory is eligible for absorption into a profile chapter. */
function absorbable(m: MemoryRow, nowMs: number): boolean {
	if (m.status !== "active") return false;
	if (m.pinned === 1) return false;
	if (m.evidence >= 5) return false;
	const ageMs = nowMs - new Date(m.last_seen_at).getTime();
	return ageMs > ABSORB_WARM_DAYS * 86_400_000;
}

export async function runSynthesize(owner: string): Promise<SynthesizeReport> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const memories = listMemories(db, { owner, status: "active", limit: 2000 });
	const existingProfiles = listProfiles(db, owner);
	const demands = getSlotDemands(db, owner).slice(0, 10);
	const report: SynthesizeReport = { themes: 0, updated: [], skipped: false };

	if (memories.length < MIN_MEMORIES) {
		report.skipped = true;
		return report;
	}

	// Phase 1: cluster the store into themes (semantic, not by domain tag —
	// Python lessons and PHP lessons SHOULD land in one "编程习惯" theme).
	const listing = memories
		.map(
			(m) =>
				`[${m.id}] (${m.kind}${m.domain ? "/" + m.domain : ""}, ev${m.evidence}) ${m.summary}${m.keywords ? ` [${m.keywords}]` : ""}`,
		)
		.join("\n");
	const existingBlock =
		existingProfiles.length > 0
			? "\n\nEXISTING THEMES (keep their theme key stable when memories still fit):\n" +
				existingProfiles.map((p) => `- ${p.theme}: ${p.title}`).join("\n")
			: "";
	const demandBlock =
		demands.length > 0
			? "\n\nDEMANDED DOMAINS (the user keeps needing these; prefer forming themes that cover them):\n" +
				demands.map((d) => `- ${d.domain} (demand x${d.demand_count})`).join("\n")
			: "";
	const clustered = await completeJson<{ themes: { theme: string; title: string; member_ids: number[] }[] }>({
		system: loadPrompt("synthesize-cluster"),
		user: `MEMORIES:\n${listing}${existingBlock}${demandBlock}\n\nReturn at most ${MAX_THEMES} themes.`,
		runId: `synthesize-${Date.now()}`,
		step: "synthesize-cluster",
		maxTokens: 16384,
	});

	const byId = new Map(memories.map((m) => [m.id, m]));
	const profileByTheme = new Map(existingProfiles.map((p) => [p.theme, p]));
	const themes = (clustered.themes ?? [])
		.filter((t) => t.member_ids?.filter((id) => byId.has(id)).length >= MIN_THEME_MEMBERS)
		.slice(0, MAX_THEMES);

	// Phase 2: synthesize each theme chapter from full member contents.
	// Previous members (including absorbed ones) always rejoin the material,
	// so chapters grow monotonically instead of forgetting what they absorbed.
	const outDir = resolve(PROJECT_ROOT, "profiles");
	mkdirSync(outDir, { recursive: true });
	const nowMs = Date.now();
	const absorbStmt = db.prepare(
		`UPDATE memories SET status = 'absorbed', absorbed_by = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
	);

	for (const t of themes) {
		const prev = profileByTheme.get(t.theme);
		const prevMemberIds: number[] = prev ? (JSON.parse(prev.memory_ids || "[]") as number[]) : [];
		const activePicks = t.member_ids.filter((id) => byId.has(id));
		const memberIds = [...new Set([...prevMemberIds, ...activePicks])];
		// Fetch all members regardless of status (active + already-absorbed).
		const memberRows = memberIds
			.map((id) => byId.get(id) ?? (db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined))
			.filter((m): m is MemoryRow => !!m && m.owner === owner && m.status !== "superseded" && m.status !== "archived");
		if (memberRows.length < MIN_THEME_MEMBERS) continue;

		const maturity = memberRows.length >= MATURE_MEMBERS ? "mature" : "seeding";
		const material = memberRows
			.map(
				(m) =>
					`[#${m.id}] (${m.kind}, evidence ${m.evidence}, confidence ${m.confidence}, last seen ${m.last_seen_at.slice(0, 10)})\n${m.summary}\n${m.content}`,
			)
			.join("\n\n");
		const chapter = await completeJson<{ chapter: string }>({
			system: loadPrompt("synthesize-theme"),
			user: `THEME: ${t.title}\n\nMATURITY: ${maturity} (${memberRows.length} member memories)\n\nMEMBER MEMORIES:\n${material}\n\nReturn ONLY JSON: {"chapter": "..."} (markdown inside the string).`,
			runId: `synthesize-${Date.now()}`,
			step: `synthesize-theme:${t.theme}`,
			maxTokens: 8192,
		});
		const content = chapter.chapter?.trim();
		if (!content) continue;

		const row = upsertProfile(db, owner, t.theme, t.title, content, memberRows.map((m) => m.id), maturity);

		// Absorption: only mature chapters absorb, only eligible members.
		let absorbed = 0;
		if (maturity === "mature") {
			const t0 = new Date().toISOString();
			for (const m of memberRows) {
				if (!absorbable(m, nowMs)) continue;
				absorbStmt.run(row.id, t0, m.id);
				absorbed++;
			}
			if (absorbed > 0) logMemoryAction(db, null, "ABSORB", { profile: row.id, theme: t.theme, absorbed });
		}

		writeFileSync(
			resolve(outDir, `${t.theme}.md`),
			`# ${t.title}\n\n> ruyi profile · theme \`${t.theme}\` · v${row.version} · ${row.updated_at.slice(0, 10)} · ${memberRows.length} memories · ${maturity === "seeding" ? "部分经验（积累中）" : "成熟"}${absorbed > 0 ? ` · absorbed ${absorbed}` : ""}\n\n${content}\n`,
		);
		report.updated.push({
			theme: t.theme,
			title: t.title,
			version: row.version,
			members: memberRows.length,
			maturity,
			absorbed,
		});
	}
	report.themes = report.updated.length;

	// Themes that disappeared from clustering keep their old profile (stale is
	// better than vanished); they will refresh next time they re-form.
	return report;
}
