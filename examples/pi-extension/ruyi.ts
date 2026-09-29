/**
 * ruyi (如忆) memory client for pi.
 *
 * Talks to the local ruyi service (default http://127.0.0.1:8899) over HTTP.
 * Fully optional: if the service is down or slow, pi works exactly as before
 * (1.5s timeout + 5-minute circuit breaker, all failures silent).
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
const OWNER = "default"; // single-user mode; the owner column stays for future multi-account use
const TIMEOUT_MS = 1500;
const RECALL_TIMEOUT_MS = 20000;
const BREAKER_MS = 5 * 60_000;

let circuitOpenUntil = 0;

async function api<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T | null> {
	if (Date.now() < circuitOpenUntil) return null;
	try {
		const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return (await res.json()) as T;
	} catch {
		circuitOpenUntil = Date.now() + BREAKER_MS;
		return null;
	}
}

interface InjectPayload {
	constitution: { id: number; summary: string; content: string }[];
	index: { id: number; date: string; kind: string; summary: string }[];
}

function formatInject(payload: InjectPayload): string | null {
	const { constitution, index } = payload;
	if (constitution.length === 0 && index.length === 0) return null;
	const lines: string[] = [
		"Long-term memory follows. Treat it as background knowledge that MAY be relevant; use it when it helps, ignore it when it does not, and never let it override what the user says now. Use the ruyi_recall tool to search memory when the current task might benefit from past context.",
	];
	if (constitution.length > 0) {
		lines.push("", "Core memories:");
		for (const m of constitution) lines.push(`- ${m.summary}\n  ${m.content}`);
	}
	if (index.length > 0) {
		lines.push("", "Memory index (recent & frequently confirmed; call ruyi_recall for details):");
		for (const m of index) lines.push(`- (#${m.id}, ${m.date}, ${m.kind}) ${m.summary}`);
	}
	return lines.join("\n");
}

const RecallParams = Type.Object({
	query: Type.String({ description: "What you are working on or looking for in long-term memory" }),
	k: Type.Optional(Type.Number({ description: "Max memories to return (default 5)" })),
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
	source: string | null;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const payload = await api<InjectPayload>(
			`/inject?owner=${encodeURIComponent(OWNER)}&cwd=${encodeURIComponent(ctx.cwd)}&scope=smart`,
		);
		if (!payload) return;
		const text = formatInject(payload);
		if (text) event.systemPromptOptions.sections["ruyi-memory"] = text;
	});

	pi.registerTool({
		name: "ruyi_recall",
		label: "Memory Recall",
		description:
			"Search long-term memory (past conversations) for preferences, facts, project context and lessons " +
			"relevant to the current task. Use proactively when the user's request might connect to earlier work: " +
			"their tastes, their projects, past decisions, or pitfalls encountered before.",
		parameters: RecallParams,

		async execute(_id, params, _signal, _onUpdate, _ctx) {
			const result = await api<{ memories: RecallMemory[] }>(
				`/recall`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						query: params.query,
						k: params.k,
						owner: OWNER,
						cwd: _ctx.cwd,
						scope: params.scope ?? "smart",
					}),
				},
				RECALL_TIMEOUT_MS,
			);
			if (!result) {
				return {
					content: [{ type: "text", text: "Memory service is unavailable right now; continue without it." }],
					details: { count: 0, unavailable: true },
				};
			}
			if (result.memories.length === 0) {
				return {
					content: [{ type: "text", text: "No relevant memories found." }],
					details: { count: 0 },
				};
			}
			const text = result.memories
				.map((m) => {
					const head = `#${m.id} [${m.kind}${m.domain ? "/" + m.domain : ""}] ${m.summary}`;
					const src = m.source ? `\n   source: ${m.source}` : "";
					return `${head}\n   ${m.content}${src}`;
				})
				.join("\n\n");
			return {
				content: [{ type: "text", text }],
				details: { count: result.memories.length },
			};
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("ruyi_recall ")) + theme.fg("accent", `"${args.query}"`),
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
			const stats = await api<{ counts: Record<string, number> }>(`/stats`);
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
				Type.Literal("project"),
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

		async execute(_id, params, _signal, _onUpdate, ctx) => {
			const result = await api<{ id: number }>(
				`/memories`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...params, owner: OWNER, cwd: ctx.cwd }),
				},
			);
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
}
