/**
 * ruyi (如忆) memory client for pi.
 *
 * Talks to the local ruyi service (default http://127.0.0.1:8899) over HTTP.
 * Fully optional: if the service is down or slow, pi works exactly as before
 * (short timeouts + per-operation circuit breakers, all failures silent).
 *
 * Injection strategy (zero blocking on conversation start):
 *   1. /inject (pure SQL, <50ms) — constitution + index + profile directory,
 *      injected into the system prompt every turn.
 *   2. /recall (LLM deep recall) raced against a small sync budget; if the
 *      endpoint is fast it lands in the system prompt immediately, otherwise
 *      it is delivered as a follow-up message when ready (no new turn triggered).
 *
 * Env:
 *   RUYI_URL    - service base URL (default http://127.0.0.1:8899)
 *   RUYI_OWNER  - memory owner namespace (default "default"); set per-account
 *                 when running a multi-user pi-web.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const BASE = (process.env.RUYI_URL ?? "http://127.0.0.1:8899").replace(/\/+$/, "");
const OWNER = process.env.RUYI_OWNER ?? "default";
const TOKEN = process.env.RUYI_TOKEN ?? ""; // bearer token, only needed for remote/shared services // per-account namespace in multi-user pi-web
const BREAKER_MS = 5 * 60_000;
/** How long we wait for deep recall before falling back to async follow-up delivery. */
const RECALL_SYNC_BUDGET_MS = 1200;

// Per-operation timeouts and circuit breakers: a slow/failed recall must not
// block remember (and vice versa). Injection stays snappy or is skipped.
const TIMEOUTS = {
	inject: 2_000,
	recall: 30_000,
	remember: 45_000, // POST /memories runs LLM merge synchronously (~10s)
	stats: 1_500,
} as const;

type Op = keyof typeof TIMEOUTS;

const breakers = new Map<Op, number>();

async function api<T>(op: Op, path: string, init?: RequestInit, timeoutMs?: number): Promise<T | null> {
	if (Date.now() < (breakers.get(op) ?? 0)) return null;
	try {
		const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
		if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
		const res = await fetch(`${BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs ?? TIMEOUTS[op]) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as T;
	} catch {
		breakers.set(op, Date.now() + BREAKER_MS);
		return null;
	}
}

const RecallParams = Type.Object({
	query: Type.String({ description: "What you are working on or looking for in long-term memory" }),
	k: Type.Optional(Type.Number({ description: "Max memories to return (default 5)" })),
	mode: Type.Optional(
		Type.Union([Type.Literal("fast"), Type.Literal("deep"), Type.Literal("excavate")], {
			description:
				"fast: free keyword scan, no LLM, sub-second — use for tentative probing; " +
				"deep (default): LLM semantic rerank of the best candidates — use when the answer matters; " +
				"excavate: like fast but also searches absorbed/archived memories (archaeology)",
		}),
	),
	scope: Type.Optional(
		Type.Union([Type.Literal("smart"), Type.Literal("cwd"), Type.Literal("all")], {
			description:
				"Memory scope: 'smart' (default: personal memories global, project memories per-directory), " +
				"'cwd' (strict current-directory only), 'all' (search everything; use when smart finds nothing)",
		}),
	),
});

interface RecallMemory {
	id: number;
	kind: string;
	domain: string | null;
	summary: string;
	content: string;
	keywords?: string;
	source: string | null;
}

interface RecallProfile {
	id: number;
	theme: string;
	title: string;
	content: string;
	maturity?: string;
	version: number;
}

interface RecallResponse {
	memories: RecallMemory[];
	profiles?: RecallProfile[];
}

interface InjectResponse {
	constitution: { id: number; summary: string; content: string }[];
	index: { id: number; date: string; kind: string; summary: string }[];
	profileDirectory?: { id: number; title: string; maturity: string }[];
}

function profileIntro(p: RecallProfile): string {
	return p.maturity === "seeding"
		? `画像《${p.title}》（部分经验积累，仅供参考，不作为规则）`
		: `画像《${p.title}》（长期形成的习惯与经验，默认遵循，除非与当前需求冲突）`;
}

function formatRecall(result: RecallResponse): string {
	const parts: string[] = [];
	for (const p of result.profiles ?? [])
		parts.push(`${profileIntro(p)} (v${p.version}):\n${p.content.slice(0, 3000)}`);
	if (result.memories.length > 0) {
		const lines = result.memories.map((m) => `- (#${m.id}, ${m.kind}) ${m.summary}\n  ${m.content}`);
		parts.push("Long-term memories judged relevant to this conversation:\n\n" + lines.join("\n"));
	}
	return parts.join("\n\n");
}

const ADVISORY =
	"\n\nUse the above when it helps; it never overrides what the user says now. More can be searched via the ruyi_recall tool.";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		// 1. Free injection (pure SQL): constitution + index + profile directory.
		const inject = await api<InjectResponse>(
			"inject",
			`/inject?owner=${encodeURIComponent(OWNER)}&cwd=${encodeURIComponent(ctx.cwd)}&scope=smart`,
		);
		if (inject) {
			const parts: string[] = [];
			if (inject.constitution.length > 0) {
				parts.push(
					"Core memory (constitution — always active):\n" +
						inject.constitution.map((c) => `- ${c.summary}\n  ${c.content}`).join("\n"),
				);
			}
			if (inject.index.length > 0) {
				parts.push(
					"Memory index (one-liners; fetch full text via ruyi_recall when one matters):\n" +
						inject.index.map((m) => `- #${m.id} (${m.kind}, ${m.date}) ${m.summary}`).join("\n"),
				);
			}
			if ((inject.profileDirectory ?? []).length > 0) {
				parts.push(
					"Profile chapters available (synthesized portraits; ruyi_recall can load at most one when the conversation is squarely in that facet):\n" +
						inject.profileDirectory!.map((p) => `- 《${p.title}》(${p.maturity === "seeding" ? "部分经验" : "成熟"})`).join("\n"),
				);
			}
			if (parts.length > 0) event.systemPromptOptions.sections["ruyi-memory"] = parts.join("\n\n") + ADVISORY;
		}

		// 2. Deep recall: race a small sync budget, else deliver as follow-up.
		const query = event.prompt.length > 2000 ? event.prompt.slice(0, 2000) : event.prompt;
		if (!query.trim()) return;
		const recallPromise = api<RecallResponse>("recall", `/recall`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query, k: 6, owner: OWNER, cwd: ctx.cwd, scope: "smart", mode: "deep" }),
		});
		const fast = await Promise.race([
			recallPromise.then((r) => ({ r, late: false as const })),
			new Promise<{ r: null; late: true }>((resolve) =>
				setTimeout(() => resolve({ r: null, late: true }), RECALL_SYNC_BUDGET_MS),
			),
		]);
		if (!fast.late) {
			// Endpoint was quick: inject straight into the system prompt this turn.
			if (fast.r && (fast.r.memories.length > 0 || (fast.r.profiles ?? []).length > 0)) {
				event.systemPromptOptions.sections["ruyi-recall"] = formatRecall(fast.r) + ADVISORY;
			}
			return;
		}
		// Slow endpoint: deliver whenever it completes, without triggering a turn.
		recallPromise.then((result) => {
			if (!result || (result.memories.length === 0 && (result.profiles ?? []).length === 0)) return;
			try {
				const card: string[] = [];
				for (const p of result.profiles ?? []) card.push(`**注入画像**：《${p.title}》v${p.version}（${p.maturity === "seeding" ? "部分经验" : "成熟"}）`);
				if (result.memories.length > 0) {
					card.push(`**注入记忆 ${result.memories.length} 条**：`);
					for (const m of result.memories) card.push(`- #${m.id} (${m.kind}) ${m.summary}`);
				}
				pi.sendMessage(
					{
						customType: "ruyi",
						content: card.join("\n") + "\n\n" + formatRecall(result) + ADVISORY,
						display: true,
						details: {
							profiles: (result.profiles ?? []).map((p) => p.id),
							memories: result.memories.map((m) => m.id),
						},
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
			} catch {
				// Delivery is best-effort; the next ruyi_recall can always fetch again.
			}
		});
	});

	pi.registerTool({
		name: "ruyi_recall",
		label: "Memory Recall",
		description:
			"Search long-term memory (past conversations) for preferences, facts, project context and lessons " +
			"relevant to the current task. Use proactively when the user's request might connect to earlier work: " +
			"their tastes, their projects, past decisions, or pitfalls encountered before. " +
			"Use mode=fast for cheap tentative probing (free, no LLM), mode=deep when the answer matters, " +
			"mode=excavate to dig through absorbed/archived memories.",
		parameters: RecallParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const result = await api<RecallResponse>("recall", `/recall`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					query: params.query,
					k: params.k,
					owner: OWNER,
					cwd: _ctx.cwd,
					scope: params.scope ?? "smart",
					mode: params.mode ?? "deep",
				}),
			});
			if (!result) {
				return {
					content: [{ type: "text", text: "Memory service is unavailable right now; continue without it." }],
					details: { count: 0, unavailable: true },
				};
			}
			if (result.memories.length === 0 && (result.profiles ?? []).length === 0) {
				return {
					content: [{ type: "text", text: "No relevant memories found." }],
					details: { count: 0 },
				};
			}
			const parts: string[] = [];
			for (const p of result.profiles ?? []) parts.push(`${profileIntro(p)} v${p.version}\n${p.content}`);
			for (const m of result.memories) {
				const head = `#${m.id} [${m.kind}${m.domain ? "/" + m.domain : ""}] ${m.summary}`;
				const src = m.source ? `\n   source: ${m.source}` : "";
				parts.push(`${head}\n   ${m.content}${src}`);
			}
			const text = parts.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { count: result.memories.length },
			};
		},

		renderCall(args, theme) {
			const mode = args.mode && args.mode !== "deep" ? ` [${args.mode}]` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("ruyi_recall ")) + theme.fg("accent", `"${args.query}"${mode}`),
				0,
				0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Recalling..."), 0, 0);
			const d = result.details as { count?: number; unavailable?: boolean } | undefined;
			if (d?.unavailable) return new Text(theme.fg("dim", "memory service unavailable"), 0, 0);
			return new Text(theme.fg("success", `${d?.count ?? 0} memories`), 0, 0);
		},
	});

	pi.registerCommand("ruyi", {
		description: "ruyi memory service status",
		handler: async (_args, ctx) => {
			const stats = await api<{ counts: Record<string, number> }>("stats", `/stats`);
			if (!stats) {
				ctx.ui.notify("ruyi service unavailable (pi is unaffected)", "warning");
				return;
			}
			ctx.ui.notify(
				`ruyi @ ${BASE} owner=${OWNER} | memories: ${JSON.stringify(stats.counts)}`,
				"info",
			);
		},
	});

	const RememberParams = Type.Object({
		kind: Type.Union(
			[
				Type.Literal("preference"),
				Type.Literal("fact"),
				Type.Literal("knowledge"),
				Type.Literal("lesson"),
				Type.Literal("skill_index"),
			],
			{ description: "Memory kind" },
		),
		summary: Type.String({ description: "One-line summary (<= 30 words)" }),
		content: Type.String({ description: "Full memory content, concrete and self-contained" }),
		domain: Type.Optional(Type.String({ description: "Short free-form tag" })),
	});

	pi.registerTool({
		name: "ruyi_remember",
		label: "Memory Write",
		description:
			"Explicitly save something to long-term memory RIGHT NOW when the user asks you to remember " +
			"it (e.g. '记住…', 'remember this'), or when you identify a durable rule/convention/skill pointer " +
			"that must not wait for the nightly distillation. Do NOT use for one-off task details.",
		parameters: RememberParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await api<{ id: number }>("remember", `/memories`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...params, owner: OWNER, cwd: ctx.cwd }),
			});
			if (!result) {
				return {
					content: [
						{
							type: "text",
							text:
								"Memory service is unavailable; the fact was NOT saved. Tell the user it will only live in this conversation.",
						},
					],
					details: { saved: false },
				};
			}
			return {
				content: [{ type: "text", text: `Saved to long-term memory as #${result.id}: ${params.summary}` }],
				details: { saved: true, id: result.id },
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("ruyi_remember ")) + theme.fg("accent", args.summary),
				0,
				0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Saving..."), 0, 0);
			const d = result.details as { saved?: boolean } | undefined;
			return d?.saved
				? new Text(theme.fg("success", "saved"), 0, 0)
				: new Text(theme.fg("warning", "not saved (service unavailable)"), 0, 0);
		},
	});

	// One consolidated admin tool instead of four flat ones: management ops are
	// rare, and every registered tool costs system-prompt tokens every turn.
	const AdminParams = Type.Object({
		action: Type.Union(
			[
				Type.Literal("forget"),
				Type.Literal("pin"),
				Type.Literal("unpin"),
				Type.Literal("stats"),
				Type.Literal("profile"),
			],
			{
				description:
					"forget = archive a memory (needs id); pin/unpin = add/remove a memory from the always-injected constitution tier (needs id); " +
					"stats = token usage report; profile = list synthesized profile chapters, or show one chapter's content (needs profileId)",
			},
		),
		id: Type.Optional(Type.Number({ description: "Memory id — required for forget/pin/unpin" })),
		days: Type.Optional(Type.Number({ description: "Report window in days for stats (default 7)" })),
		profileId: Type.Optional(Type.Number({ description: "Profile chapter id — omit to list all chapters" })),
	});

	pi.registerTool({
		name: "ruyi_admin",
		label: "Memory Admin",
		description:
			"Manage long-term memory. Use when the user asks to forget/delete something (action=forget with the memory id), " +
			"to always remember something (pin), to undo that (unpin), for a token cost report (stats), " +
			"or to inspect synthesized profile chapters (profile; pass profileId for full content). " +
			"Forgetting archives — the memory stays recoverable via ruyi_recall mode=excavate.",
		parameters: AdminParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const text = (t: string, ok = true) => ({ content: [{ type: "text" as const, text: t }], details: { ok } });
			switch (params.action) {
				case "forget": {
					if (typeof params.id !== "number") return text("forget requires a memory id.", false);
					const r = await api<{ ok: boolean }>("remember", `/memories/${params.id}/forget`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					});
					return text(
						r
							? `Memory #${params.id} archived — no longer injected or recalled (recoverable via excavate).`
							: "Memory service unavailable; nothing was changed.",
						!!r,
					);
				}
				case "pin":
				case "unpin": {
					if (typeof params.id !== "number") return text(`${params.action} requires a memory id.`, false);
					const pinned = params.action === "pin" ? 1 : 0;
					const r = await api<{ ok: boolean; pinned: number }>("remember", `/memories/${params.id}/pin`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ pinned }),
					});
					if (!r) return text("Memory service unavailable; nothing was changed.", false);
					return text(
						r.pinned
							? `Memory #${params.id} pinned into the constitution tier — injected at the start of every turn.`
							: `Memory #${params.id} unpinned — back to normal recall.`,
					);
				}
				case "stats": {
					const days = params.days ?? 7;
					const r = await api<{
						counts: Record<string, number>;
						tokenUsage: { day: string; step: string; input: number; output: number }[];
					}>("stats", `/stats?days=${days}&owner=${encodeURIComponent(OWNER)}`);
					if (!r) return text("Memory service unavailable.", false);
					const lines = [`Memory counts: ${JSON.stringify(r.counts)}`, `Token usage, last ${days} day(s):`];
					let ti = 0;
					let to = 0;
					for (const u of r.tokenUsage) {
						ti += u.input;
						to += u.output;
						lines.push(`- ${u.day} ${u.step}: in ${u.input} / out ${u.output}`);
					}
					lines.push(`Total: in ${ti} / out ${to}`);
					return text(lines.join("\n"));
				}
				case "profile": {
					if (typeof params.profileId === "number") {
						const p = await api<{ title: string; version: number; maturity: string; content: string }>(
							"stats",
							`/profiles/${params.profileId}?owner=${encodeURIComponent(OWNER)}`,
						);
						return p
							? text(`《${p.title}》v${p.version} (${p.maturity})\n\n${p.content}`)
							: text(`Profile #${params.profileId} not found (or service unavailable).`, false);
					}
					const r = await api<{ profiles: { id: number; title: string; theme: string; version: number; maturity: string; updated_at: string }[] }>(
						"stats",
						`/profiles?owner=${encodeURIComponent(OWNER)}`,
					);
					if (!r) return text("Memory service unavailable.", false);
					if (r.profiles.length === 0) return text("No profile chapters yet — they emerge from nightly dreams.");
					return text(
						["Profile chapters:", ...r.profiles.map((p) => `- #${p.id} 《${p.title}》(${p.theme}) v${p.version} ${p.maturity}, updated ${p.updated_at.slice(0, 10)}`)].join("\n"),
					);
				}
			}
		},

		renderCall(args, theme) {
			const target = args.id != null ? ` #${args.id}` : args.profileId != null ? ` #${args.profileId}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("ruyi_admin ")) + theme.fg("accent", args.action + target), 0, 0);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Working..."), 0, 0);
			const d = result.details as { ok?: boolean } | undefined;
			return d?.ok === false
				? new Text(theme.fg("warning", "failed"), 0, 0)
				: new Text(theme.fg("success", "done"), 0, 0);
		},
	});
}
