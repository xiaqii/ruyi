import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { getDb, getMemory, listMemories } from "./db.ts";
import { recall } from "./recall.ts";
import { distillText } from "./distill.ts";

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
		name: "ruyi_recall",
		description:
			"Search long-term memory for preferences, facts, project context and lessons relevant to the current task. Returns full memory entries.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "What you are working on / looking for" },
				k: { type: "number", description: "Max memories to return (default 5)" },
				owner: { type: "string", description: "Memory owner namespace (default 'default')" },
			},
			required: ["query"],
		},
	},
	{
		name: "ruyi_list",
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
		name: "ruyi_get",
		description: "Get a memory entry by id.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "number", description: "Memory id" } },
			required: ["id"],
		},
	},
	{
		name: "ruyi_ingest",
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
		case "ruyi_recall": {
			const query = String(args.query ?? "");
			const k = typeof args.k === "number" ? args.k : undefined;
			const result = await recall(query, k, owner);
			if (result.memories.length === 0 && result.profiles.length === 0)
				return reply(id, toolResult("No relevant memories found."));
			const parts: string[] = [];
			for (const p of result.profiles) parts.push(`PROFILE【${p.title}】v${p.version}\n${p.content}`);
			for (const m of result.memories)
				parts.push(`#${m.id} [${m.kind}${m.domain ? "/" + m.domain : ""}] ${m.summary}\n${m.content}`);
			return reply(id, toolResult(parts.join("\n\n")));
		}
		case "ruyi_list": {
			const limit = typeof args.limit === "number" ? args.limit : 30;
			const memories = listMemories(db, { status: "active", limit, owner });
			const text = memories.map((m) => `#${m.id} (${m.kind}, ${m.last_seen_at.slice(0, 10)}) ${m.summary}`).join("\n");
			return reply(id, toolResult(text || "(memory store is empty)"));
		}
		case "ruyi_get": {
			const m = getMemory(db, Number(args.id));
			if (!m || m.owner !== owner) return reply(id, toolResult("Not found."));
			return reply(id, toolResult(JSON.stringify(m, null, 2)));
		}
		case "ruyi_ingest": {
			const text = String(args.text ?? "");
			const cwd = typeof args.cwd === "string" ? args.cwd : null;
			const result = await distillText(text, { owner, cwd }, "mcp-ingest");
			return reply(id, toolResult(JSON.stringify(result)));
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
