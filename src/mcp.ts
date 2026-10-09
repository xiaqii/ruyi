import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import {
	archiveMemory,
	getDb,
	getMemory,
	getProfile,
	listMemories,
	listProfiles,
	memoryCounts,
	pinMemory,
	tokenUsage,
} from "./db.ts";
import { recall } from "./recall.ts";
import { distillText, explicitRemember } from "./distill.ts";

/**
 * Minimal MCP (Model Context Protocol) stdio server exposing ruyi recall tools.
 * Lets MCP-capable agents (Claude Code, opencode, ...) use ruyi without a custom plugin.
 */

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: number | string;
	method: string;
	params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
	{
		name: "recall",
		description:
			"Search long-term memory for preferences, facts, project context and lessons relevant to the current task. Returns full memory entries.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "What you are working on / looking for" },
				k: { type: "number", description: "Max memories to return (default 5)" },
				mode: {
					type: "string",
					enum: ["fast", "deep", "excavate"],
					description:
						"fast: free keyword retrieval, no LLM, for tentative probing; deep (default): LLM semantic rerank; excavate: like fast but includes absorbed/archived memories (archaeology)",
				},
				owner: { type: "string", description: "Memory owner namespace (default 'default')" },
			},
			required: ["query"],
		},
	},
	{
		name: "list",
		description: "List recent long-term memory entries (one-line summaries with ids).",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number", description: "Max entries (default 30)" },
				owner: { type: "string", description: "Memory owner namespace (default 'default')" },
			},
		},
	},
	{
		name: "get",
		description: "Get a memory entry by id.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "number", description: "Memory id" } },
			required: ["id"],
		},
	},
	{
		name: "ingest",
		description:
			"Submit raw conversation text or notes to the memory center; ruyi distills durable preferences/facts/lessons from it.",
		inputSchema: {
			type: "object",
			properties: {
				text: { type: "string", description: "Raw text to distill" },
				owner: { type: "string", description: "Memory owner namespace (default 'default')" },
				cwd: { type: "string", description: "Working directory the content relates to" },
			},
			required: ["text"],
		},
	},
	{
		name: "remember",
		description:
			"Explicitly save something to long-term memory RIGHT NOW when the user asks you to remember it, or when you identify a durable rule/convention that must not wait for the nightly distillation. Goes through the same LLM merge judgement as nightly dreams — duplicates become reinforcement. Do NOT use for one-off task details.",
		inputSchema: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["preference", "fact", "knowledge", "lesson", "skill_index"], description: "Memory kind" },
				summary: { type: "string", description: "One-line summary (<= 30 words)" },
				content: { type: "string", description: "Full memory content, concrete and self-contained" },
				domain: { type: "string", description: "Short free-form tag" },
				owner: { type: "string", description: "Memory owner namespace (default 'default')" },
			},
			required: ["summary", "content"],
		},
	},
	{
		name: "admin",
		description:
			"Manage long-term memory. action=forget archives a memory by id (recoverable via recall mode=excavate); pin/unpin adds/removes a memory from the always-injected constitution tier; stats returns the token usage report; profile lists synthesized profile chapters or shows one chapter (pass profileId).",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["forget", "pin", "unpin", "stats", "profile"], description: "Management action" },
				id: { type: "number", description: "Memory id — required for forget/pin/unpin" },
				days: { type: "number", description: "Report window in days for stats (default 7)" },
				profileId: { type: "number", description: "Profile chapter id — omit to list chapters" },
				owner: { type: "string", description: "Memory owner namespace (default 'default')" },
			},
			required: ["action"],
		},
	},
];

function reply(id: number | string | undefined, result: unknown): void {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id: number | string | undefined, code: number, message: string): void {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function toolResult(text: string): { content: { type: string; text: string }[] } {
	return { content: [{ type: "text", text }] };
}

async function handleToolCall(
	id: number | string | undefined,
	params: { name?: string; arguments?: Record<string, unknown> } | undefined,
): Promise<void> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const name = params?.name;
	const args = params?.arguments ?? {};
	const owner = typeof args.owner === "string" ? args.owner : "default";

	switch (name) {
		case "recall": {
			const query = String(args.query ?? "");
			const k = typeof args.k === "number" ? args.k : undefined;
			const mode = args.mode === "fast" || args.mode === "excavate" ? args.mode : "deep";
			const result = await recall(query, k, owner, null, undefined, mode);
			if (result.memories.length === 0 && result.profiles.length === 0)
				return reply(id, toolResult("No relevant memories found."));
			const parts: string[] = [];
			for (const p of result.profiles) parts.push(`PROFILE【${p.title}】v${p.version} (${p.maturity})\n${p.content}`);
			for (const m of result.memories)
				parts.push(`#${m.id} [${m.kind}${m.domain ? "/" + m.domain : ""}] ${m.summary}\n${m.content}`);
			return reply(id, toolResult(parts.join("\n\n")));
		}
		case "list": {
			const limit = typeof args.limit === "number" ? args.limit : 30;
			const memories = listMemories(db, { status: "active", limit, owner });
			const text = memories.map((m) => `#${m.id} (${m.kind}, ${m.last_seen_at.slice(0, 10)}) ${m.summary}`).join("\n");
			return reply(id, toolResult(text || "(memory store is empty)"));
		}
		case "get": {
			const m = getMemory(db, Number(args.id));
			if (!m || m.owner !== owner) return reply(id, toolResult("Not found."));
			return reply(id, toolResult(JSON.stringify(m, null, 2)));
		}
		case "ingest": {
			const text = String(args.text ?? "");
			const cwd = typeof args.cwd === "string" ? args.cwd : null;
			const result = await distillText(text, { owner, cwd }, "mcp-ingest");
			return reply(id, toolResult(JSON.stringify(result)));
		}
		case "remember": {
			const summary = String(args.summary ?? "").trim();
			const content = String(args.content ?? "").trim();
			if (!summary || !content) return replyError(id, -32602, "summary and content are required");
			const kind = typeof args.kind === "string" ? args.kind : "fact";
			const result = await explicitRemember(
				{
					kind: kind as never,
					domain: typeof args.domain === "string" ? args.domain : undefined,
					summary,
					content,
					origin: "user_stated",
					confidence: 0.9,
				},
				{ owner, cwd: typeof args.cwd === "string" ? args.cwd : null },
			);
			return reply(id, toolResult(`Saved to long-term memory as #${result.id} (${result.action}): ${summary}`));
		}
		case "admin": {
			const action = String(args.action ?? "");
			switch (action) {
				case "forget": {
					const mid = Number(args.id);
					if (!mid) return replyError(id, -32602, "forget requires a memory id");
					archiveMemory(db, mid);
					return reply(id, toolResult(`Memory #${mid} archived (recoverable via ruyi_recall mode=excavate).`));
				}
				case "pin":
				case "unpin": {
					const mid = Number(args.id);
					if (!mid) return replyError(id, -32602, `${action} requires a memory id`);
					pinMemory(db, mid, action === "pin" ? 1 : 0);
					return reply(id, toolResult(action === "pin" ? `Memory #${mid} pinned into the constitution tier.` : `Memory #${mid} unpinned.`));
				}
				case "stats": {
					const days = typeof args.days === "number" ? args.days : 7;
					const usage = tokenUsage(db, days);
					let ti = 0;
					let to = 0;
					const lines = [`Memory counts: ${JSON.stringify(memoryCounts(db, owner))}`, `Token usage, last ${days} day(s):`];
					for (const u of usage) {
						ti += u.input;
						to += u.output;
						lines.push(`- ${u.day} ${u.step}: in ${u.input} / out ${u.output}`);
					}
					lines.push(`Total: in ${ti} / out ${to}`);
					return reply(id, toolResult(lines.join("\n")));
				}
				case "profile": {
					if (typeof args.profileId === "number") {
						const p = getProfile(db, args.profileId);
						if (!p || p.owner !== owner) return reply(id, toolResult("Profile not found."));
						return reply(id, toolResult(`《${p.title}》v${p.version} (${p.maturity})\n\n${p.content}`));
					}
					const profiles = listProfiles(db, owner);
					if (profiles.length === 0) return reply(id, toolResult("No profile chapters yet — they emerge from nightly dreams."));
					return reply(
						id,
						toolResult(profiles.map((p) => `#${p.id} 《${p.title}》(${p.theme}) v${p.version} ${p.maturity}, updated ${p.updated_at.slice(0, 10)}`).join("\n")),
					);
				}
				default:
					return replyError(id, -32602, `unknown action: ${action}`);
			}
		}
		default:
			return replyError(id, -32601, `unknown tool: ${name}`);
	}
}

export function startMcpServer(): void {
	const rl = createInterface({ input: process.stdin });
	rl.on("line", async (line) => {
		let msg: JsonRpcRequest;
		try {
			msg = JSON.parse(line) as JsonRpcRequest;
		} catch {
			return;
		}
		try {
			switch (msg.method) {
				case "initialize":
					return reply(msg.id, {
						protocolVersion: PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "ruyi", version: "0.1.0" },
					});
				case "notifications/initialized":
				case "initialized":
					return;
				case "ping":
					return reply(msg.id, {});
				case "tools/list":
					return reply(msg.id, { tools: TOOLS });
				case "tools/call":
					return await handleToolCall(msg.id, msg.params as { name?: string; arguments?: Record<string, unknown> });
				default:
					if (msg.id !== undefined) return replyError(msg.id, -32601, `method not found: ${msg.method}`);
			}
		} catch (err) {
			if (msg.id !== undefined) replyError(msg.id, -32603, err instanceof Error ? err.message : String(err));
		}
	});
}
