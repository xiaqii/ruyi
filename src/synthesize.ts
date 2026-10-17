/**
 * Profile synthesis ("炼丹") v3: integrate the memory store into a TWO-LEVEL
 * profile tree — domain index chapters (总索引) with subchapters beneath them.
 *
 * v3 changes (see docs/design-v3-abstract-profiles.md):
 *  - Two levels: domains (short orientation chapter, the "index page") each
 *    holding subchapters (the loadable experience sets). Loading 《肾病》 beats
 *    loading an entire domain; loading a subchapter beats loading a 2400-char umbrella.
 *  - Abstraction mandate (in the prompts): chapters hold methodology / habits /
 *    preferences / lessons ONLY. Project codenames are rewritten into abstract
 *    lessons; tech platforms and the user's own infrastructure stay concrete.
 *  - Retirement: active chapters untouched by this run whose members are all
 *    covered by the new tree are ARCHIVED (recoverable) — no more stale ghosts
 *    lingering in the directory after the taxonomy shifts.
 *  - Absorption: members fully covered by a MATURE subchapter are demoted to
 *    status='absorbed' (linked via absorbed_by), leaving the active working set
 *    small. Pinned, hot (evidence>=5) and warm (<30d) memories are exempt.
 *  - Chapters never shrink: previous members (incl. already-absorbed ones)
 *    always join the re-synthesis material. Clustering sees active + absorbed.
 *  - Demand priority: slot_demands steer the clustering prompt.
 * Runs weekly (or after big imports); each run re-synthesizes and version-bumps.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, STATE_ROOT } from "./config.ts";
import { getDb, getSlotDemands, listMemories, listProfiles, logMemoryAction, upsertProfile } from "./db.ts";
import type { MemoryRow } from "./types.ts";
import { completeJson } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";

export interface SynthesizeReport {
	domains: number;
	updated: { theme: string; title: string; version: number; members: number; maturity: string; absorbed: number }[];
	retired: { theme: string; title: string }[];
	skipped: boolean;
}

const MIN_MEMORIES = 10;
const MAX_DOMAINS = 12;
const MAX_SUBS_PER_DOMAIN = 6;
const MIN_THEME_MEMBERS = 2;
const MATURE_MEMBERS = 5;
/** Absorption exempts memories seen within this window (still warm). */
const ABSORB_WARM_DAYS = 30;

/** A memory is eligible for absorption into a profile subchapter. */
function absorbable(m: MemoryRow, nowMs: number): boolean {
	if (m.status !== "active") return false;
	if (m.pinned === 1) return false;
	if (m.evidence >= 5) return false;
	const ageMs = nowMs - new Date(m.last_seen_at).getTime();
	return ageMs > ABSORB_WARM_DAYS * 86_400_000;
}

interface ClusterSub { theme: string; title: string; member_ids: number[] }
interface ClusterDomain { theme: string; title: string; gist?: string; subs: ClusterSub[] }

export async function runSynthesize(owner: string): Promise<SynthesizeReport> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	// Cluster over active + absorbed: absorbed memories were fully covered by
	// older chapters; a rebuilt tree must still see them or content is lost.
	const memories = [
		...listMemories(db, { owner, status: "active", limit: 2000 }),
		...listMemories(db, { owner, status: "absorbed", limit: 2000 }),
	];
	const existingProfiles = listProfiles(db, owner);
	const demands = getSlotDemands(db, owner).slice(0, 10);
	const report: SynthesizeReport = { domains: 0, updated: [], retired: [], skipped: false };

	if (memories.length < MIN_MEMORIES) {
		report.skipped = true;
		return report;
	}

	// Phase 1: cluster the store into a domain tree (semantic, not by domain tag —
	// Python lessons and PHP lessons SHOULD land in one "编程习惯" subchapter).
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
			? "\n\nDEMANDED DOMAINS (the user keeps needing these; prefer forming subchapters that cover them):\n" +
				demands.map((d) => `- ${d.domain} (demand x${d.demand_count})`).join("\n")
			: "";
	const clustered = await completeJson<{ domains: ClusterDomain[] }>({
		system: loadPrompt("synthesize-cluster"),
		user: `MEMORIES:\n${listing}${existingBlock}${demandBlock}\n\nReturn at most ${MAX_DOMAINS} domains.`,
		runId: `synthesize-${Date.now()}`,
		step: "synthesize-cluster",
		maxTokens: 16384,
	});

	const byId = new Map(memories.map((m) => [m.id, m]));
	const profileByTheme = new Map(existingProfiles.map((p) => [p.theme, p]));
	const touched = new Set<string>();
	const covered = new Set<number>();
	const outDir = resolve(STATE_ROOT, "profiles");
	mkdirSync(outDir, { recursive: true });
	const nowMs = Date.now();
	const absorbStmt = db.prepare(
		`UPDATE memories SET status = 'absorbed', absorbed_by = ?, updated_at = ? WHERE id = ? AND status = 'active'`,
	);
	const fetchMemory = (id: number): MemoryRow | undefined =>
		byId.get(id) ?? (db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined);

	const domains = (clustered.domains ?? [])
		.map((d) => ({
			...d,
			theme: String(d.theme ?? "").replaceAll("/", "-").trim(),
			subs: (d.subs ?? [])
				.map((s) => ({ ...s, theme: String(s.theme ?? "").replaceAll("/", "-").trim() }))
				.filter((s) => s.member_ids?.filter((id) => byId.has(id)).length >= MIN_THEME_MEMBERS)
				.slice(0, MAX_SUBS_PER_DOMAIN),
		}))
		.filter((d) => d.theme && d.subs.length > 0)
		.slice(0, MAX_DOMAINS);

	for (const dom of domains) {
		// Domain index chapter: short orientation (the "index page"), generated by
		// the clustering pass. Never absorbs; members tracked for coverage only.
		const domPrev = profileByTheme.get(dom.theme);
		const domMemberIds = [
			...new Set([
				...(domPrev ? (JSON.parse(domPrev.memory_ids || "[]") as number[]) : []),
				...dom.subs.flatMap((s) => s.member_ids.filter((id) => byId.has(id))),
			]),
		];
		const domMaturity = domMemberIds.length >= MATURE_MEMBERS ? "mature" : "seeding";
		const domRow = upsertProfile(db, owner, dom.theme, dom.title, (dom.gist ?? "").trim() || dom.title, domMemberIds, domMaturity, null);
		touched.add(dom.theme);
		for (const id of domMemberIds) covered.add(id);
		report.updated.push({ theme: dom.theme, title: dom.title, version: domRow.version, members: domMemberIds.length, maturity: domMaturity, absorbed: 0 });

		// Subchapters: the loadable experience sets, synthesized from full member
		// contents. Previous members (incl. absorbed) always rejoin the material.
		for (const sub of dom.subs) {
			const subTheme = `${dom.theme}/${sub.theme}`;
			const prev = profileByTheme.get(subTheme);
			const prevMemberIds: number[] = prev ? (JSON.parse(prev.memory_ids || "[]") as number[]) : [];
			const memberIds = [...new Set([...prevMemberIds, ...sub.member_ids.filter((id) => byId.has(id))])];
			const memberRows = memberIds
				.map((id) => fetchMemory(id))
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
				user: `THEME: ${dom.title} / ${sub.title}\n\nMATURITY: ${maturity} (${memberRows.length} member memories)\n\nMEMBER MEMORIES:\n${material}\n\nReturn ONLY JSON: {"chapter": "..."} (markdown inside the string).`,
				runId: `synthesize-${Date.now()}`,
				step: `synthesize-theme:${subTheme}`,
				maxTokens: 8192,
			});
			const content = chapter.chapter?.trim();
			if (!content) continue;

			const row = upsertProfile(db, owner, subTheme, sub.title, content, memberRows.map((m) => m.id), maturity, domRow.id);
			touched.add(subTheme);
			for (const m of memberRows) covered.add(m.id);

			// Absorption: only mature subchapters absorb, only eligible members.
			let absorbed = 0;
			if (maturity === "mature") {
				const t0 = new Date().toISOString();
				for (const m of memberRows) {
					if (!absorbable(m, nowMs)) continue;
					absorbStmt.run(row.id, t0, m.id);
					absorbed++;
				}
				if (absorbed > 0) logMemoryAction(db, null, "ABSORB", { profile: row.id, theme: subTheme, absorbed });
			}

			writeFileSync(
				resolve(outDir, `${subTheme.replaceAll("/", "-")}.md`),
				`# ${dom.title} / ${sub.title}\n\n> ruyi profile · theme \`${subTheme}\` · v${row.version} · ${row.updated_at.slice(0, 10)} · ${memberRows.length} memories · ${maturity === "seeding" ? "部分经验（积累中）" : "成熟"}${absorbed > 0 ? ` · absorbed ${absorbed}` : ""}\n\n${content}\n`,
			);
			report.updated.push({ theme: subTheme, title: `${dom.title} / ${sub.title}`, version: row.version, members: memberRows.length, maturity, absorbed });
		}
	}
	report.domains = domains.length;

	// Retirement: archive an untouched chapter when the new tree clearly
	// supersedes it — a same-title chapter exists, or >=50% of its loadable
	// members are covered by new chapters. Chapters holding mostly-uncovered
	// content stay (stale is better than vanished); their members remain
	// individually recallable either way — nothing is ever deleted.
	const nowIso = new Date().toISOString();
	const newTitles = new Set([...touched].map((t) => profileByTheme.get(t)?.title ?? ""));
	for (const u of report.updated) newTitles.add(u.title);
	for (const p of listProfiles(db, owner)) {
		if (touched.has(p.theme)) continue;
		const ids = JSON.parse(p.memory_ids || "[]") as number[];
		const loadable = ids.filter((id) => {
			const m = fetchMemory(id);
			return m && (m.status === "active" || m.status === "absorbed");
		});
		const cov = loadable.filter((id) => covered.has(id)).length;
		const superseded = newTitles.has(p.title) || (loadable.length > 0 && cov / loadable.length >= 0.5) || loadable.length === 0;
		if (superseded) {
			db.prepare(`UPDATE profiles SET status = 'archived', updated_at = ? WHERE id = ?`).run(nowIso, p.id);
			report.retired.push({ theme: p.theme, title: p.title });
		}
	}
	return report;
}
