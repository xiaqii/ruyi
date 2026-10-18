/**
 * ruyi (如忆) memory client for pi.
 *
 * Talks to the local ruyi service (default http://127.0.0.1:8899) over HTTP.
 * Fully optional: if the service is down or slow, pi works exactly as before
 * (short timeouts + per-operation circuit breakers, all failures silent).
 *
 * Injection strategy (zero blocking on conversation start):
 * *   1. No static layer at all (v0.10.4): nothing rides the system prompt
 *      unconditionally — not even a directory. Iron rules = platform AGENTS.md.
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
	deduped?: number;
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
		// Zero static layer: nothing rides the system prompt unconditionally.
		// Iron rules belong to the agent platform's own AGENTS.md/CLAUDE.md;
		// everything topical arrives via per-turn semantic recall (deduped per
		// conversation) or explicit ruyi_* tool calls.

		// Deep recall: race a small sync budget, else deliver as follow-up.
		// conversation+auto = automatic injection path: the server dedups items
		// already injected into THIS conversation and skips the LLM call entirely
		// when nothing new could surface.
		const conversation = `pi:${ctx.sessionManager.getSessionId()}`;
		const query = event.prompt.length > 2000 ? event.prompt.slice(0, 2000) : event.prompt;
		if (!query.trim()) return;
		const recallPromise = api<RecallResponse>("recall", `/recall`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query, k: 6, owner: OWNER, cwd: ctx.cwd, scope: "smart", mode: "deep", conversation, auto: true }),
		});
		const fast = await Promise.race([
			recallPromise.then((r) => ({ r, late: false as const })),
			new Promise<{ r: null; late: true }>((resolve) =>
				setTimeout(() => resolve({ r: null, late: true }), RECALL_SYNC_BUDGET_MS),
			),
		]);
		if (!fast.late) {
			// Endpoint was quick: return the recall block as a custom message — pi
			// places it right after this turn's user prompt (tail append, visible to
			// the model this same run). NEVER the system prompt: it sits at token 0,
			// and any per-turn change there invalidates provider prefix caching for
			// the entire conversation — worse than editing an early turn.
			if (fast.r && (fast.r.memories.length > 0 || (fast.r.profiles ?? []).length > 0)) {
				const nProf = (fast.r.profiles ?? []).length;
				const header = `**加载记忆 ${fast.r.memories.length} 条${nProf ? `、画像 ${nProf} 篇` : ""}**（已进本轮上下文）\n\n`;
				return {
					message: {
						customType: "ruyi",
						content: header + formatRecall(fast.r) + ADVISORY,
						display: true,
						details: {
							profiles: (fast.r.profiles ?? []).map((p) => p.id),
							memories: fast.r.memories.map((m) => m.id),
						},
					},
				};
			}
			return;
		}
		// Slow endpoint: deliver whenever it completes, without triggering a turn.
		recallPromise.then((result) => {
			if (!result || (result.memories.length === 0 && (result.profiles ?? []).length === 0)) return;
			try {
				// Compact card only — the model already has the full text in the system
				// prompt on fast turns; on slow turns one-liners + ruyi_recall on demand
				// is the index philosophy anyway. No full-text dump in the display.
				const card: string[] = [];
				for (const p of result.profiles ?? []) card.push(`**加载画像**：《${p.title}》v${p.version}（${p.maturity === "seeding" ? "部分经验" : "成熟"}）`);
				if (result.memories.length > 0) {
					card.push(`**加载记忆 ${result.memories.length} 条**：`);
					result.memories.forEach((m, i) => card.push(`${i + 1}. #${m.id} (${m.kind}) ${m.summary}`));
				}
				if ((result.deduped ?? 0) > 0) card.push(`_（本对话已加载过的 ${result.deduped} 条不再重复）_`);
				pi.sendMessage(
					{
						customType: "ruyi",
						content: card.join("\n") + "\n\n" + ADVISORY,
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
			"Query the user's long-term memory. CALL THIS whenever the request touches the user's past work, decisions, tastes, " +
			"projects, machines or habits; when the user references earlier context (\"继续\", \"上次\", \"老规矩\"); before giving " +
			"advice in a domain the user has history in (coding style, ops, buying, health); or when the user asks what you remember. " +
			"SKIP only for fully self-contained questions (syntax, generic how-to). " +
			"mode=fast is a free keyword probe (cheap tentative check), mode=deep (default) is semantic search, " +
			"mode=excavate also digs absorbed/archived memories; scope=\"all\" searches every directory's memories. " +
			"One deep call usually settles it — escalate to excavate or scope=\"all\" only when deep misses.",
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
				theme.fg("toolTitle", theme.bold("保存记忆 ")) + theme.fg("accent", args.summary),
				0,
				0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "保存中..."), 0, 0);
			const d = result.details as { saved?: boolean; id?: number } | undefined;
			return d?.saved
				? new Text(theme.fg("success", `已保存记忆 1 条（#${d.id}）`), 0, 0)
				: new Text(theme.fg("warning", "保存失败（记忆服务不可用）"), 0, 0);
		},
	});

	// One consolidated admin tool instead of four flat ones: management ops are
	// rare, and every registered tool costs system-prompt tokens every turn.
	const AdminParams = Type.Object({
		action: Type.Union(
			[
				Type.Literal("forget"),
				Type.Literal("stats"),
				Type.Literal("profile"),
			],
			{
				description:
					"forget = archive a memory (needs id); " +
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
			"for a token cost report (stats), " +
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
							? `记忆 #${params.id} 已归档——不再加载/召回（excavate 模式可恢复）。`
							: "记忆服务不可用，未做任何改动。",
						!!r,
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
