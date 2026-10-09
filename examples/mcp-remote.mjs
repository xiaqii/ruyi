#!/usr/bin/env node
/**
 * ruyi remote MCP bridge — a stdio MCP server that forwards to a REMOTE ruyi
 * HTTP service. Use this on machines where ruyi itself is NOT installed:
 * your agent registers a local stdio MCP server, requests go over HTTPS.
 *
 * Env:
 *   RUYI_URL    e.g. https://ruyi.example.com   (required)
 *   RUYI_TOKEN  bearer token                    (required when the service is public)
 *   RUYI_OWNER  memory namespace               (default "default")
 *
 * Claude Code (any OS):
 *   claude mcp add ruyi -e RUYI_URL=https://ruyi.example.com -e RUYI_TOKEN=xxx \
 *     -- node C:\path\to\mcp-remote.mjs
 * opencode: same command in the mcp.local entry's "command" array; env via "environment".
 *
 * Tools mirror the local MCP server (API.md is the contract): recall / list /
 * get / ingest / remember / admin.
 */

const BASE = (process.env.RUYI_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? "";
const OWNER = process.env.RUYI_OWNER ?? "default";

const TOOLS = [
	{ name: "recall", description: "Search long-term memory (past conversations) for preferences, facts, project context and lessons relevant to the current task. mode=fast: free keyword probe; deep (default): LLM rerank; excavate: also dig absorbed/archived memories.", inputSchema: { type: "object", properties: { query: { type: "string" }, k: { type: "number" }, mode: { type: "string", enum: ["fast", "deep", "excavate"] } }, required: ["query"] } },
	{ name: "list", description: "List recent long-term memory entries (one-line summaries with ids).", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
	{ name: "get", description: "Get a memory entry by id.", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
	{ name: "ingest", description: "Submit raw conversation text or notes; ruyi distills durable memories from it.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "remember", description: "Explicitly save something to long-term memory RIGHT NOW when the user asks you to remember it, or when you identify a durable rule/convention. Goes through LLM merge judgement — duplicates become reinforcement. Not for one-off task details.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["preference", "fact", "knowledge", "lesson", "skill_index"] }, summary: { type: "string" }, content: { type: "string" }, domain: { type: "string" } }, required: ["summary", "content"] } },
	{ name: "admin", description: "Manage long-term memory: forget (archive by id, recoverable via recall excavate), pin/unpin (constitution tier), stats (token report, days param), profile (list chapters, or full content with profileId).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["forget", "pin", "unpin", "stats", "profile"] }, id: { type: "number" }, days: { type: "number" }, profileId: { type: "number" } }, required: ["action"] } },
];

async function api(path, { method = "GET", body, timeoutMs = 15_000 } = {}) {
	const headers = { "content-type": "application/json" };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const res = await fetch(`${BASE}${path}`, {
		method, headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error ?? res.statusText}`);
	return json;
}

const text = (t) => ({ content: [{ type: "text", text: t }] });

async function callTool(name, args = {}) {
	if (!BASE) return text("RUYI_URL is not set — point it at your ruyi service, e.g. https://ruyi.example.com");
	switch (name) {
		case "recall": {
			const r = await api("/recall", { method: "POST", timeoutMs: 60_000, body: { query: String(args.query ?? ""), k: args.k, owner: OWNER, mode: args.mode ?? "deep" } });
			const parts = [];
			for (const p of r.profiles ?? []) parts.push(`PROFILE【${p.title}】v${p.version} (${p.maturity})\n${p.content}`);
			for (const m of r.memories ?? []) parts.push(`#${m.id} [${m.kind}${m.domain ? "/" + m.domain : ""}] ${m.summary}\n${m.content}`);
			return text(parts.join("\n\n") || "No relevant memories found.");
		}
		case "list": {
			const r = await api(`/memories?owner=${OWNER}&status=active&limit=${args.limit ?? 30}`);
			return text((r.memories ?? []).map((m) => `#${m.id} (${m.kind}, ${String(m.last_seen_at).slice(0, 10)}) ${m.summary}`).join("\n") || "(memory store is empty)");
		}
		case "get": {
			const r = await api(`/memories/${Number(args.id)}?owner=${OWNER}`);
			return text(JSON.stringify(r.memory ?? r, null, 2));
		}
		case "ingest": {
			const r = await api("/ingest", { method: "POST", timeoutMs: 120_000, body: { text: String(args.text ?? ""), owner: OWNER, source: "mcp-remote" } });
			return text(JSON.stringify(r));
		}
		case "remember": {
			const r = await api("/memories", { method: "POST", timeoutMs: 60_000, body: { kind: args.kind ?? "fact", summary: args.summary, content: args.content, domain: args.domain, owner: OWNER } });
			return text(`Saved to long-term memory as #${r.id} (${r.action}): ${args.summary}`);
		}
		case "admin": {
			switch (args.action) {
				case "forget": {
					const r = await api(`/memories/${Number(args.id)}/forget`, { method: "POST", body: {} });
					return text(r.ok ? `Memory #${args.id} archived (recoverable via recall mode=excavate).` : "failed");
				}
				case "pin":
				case "unpin": {
					const r = await api(`/memories/${Number(args.id)}/pin`, { method: "POST", body: { pinned: args.action === "pin" ? 1 : 0 } });
					return text(r.pinned ? `Memory #${args.id} pinned into the constitution tier.` : `Memory #${args.id} unpinned.`);
				}
				case "stats": {
					const r = await api(`/stats?days=${args.days ?? 7}&owner=${OWNER}`);
					const lines = [`Memory counts: ${JSON.stringify(r.counts)}`, "Token usage:"];
					for (const u of r.tokenUsage ?? []) lines.push(`- ${u.day} ${u.step}: in ${u.input} / out ${u.output}`);
					return text(lines.join("\n"));
				}
				case "profile": {
					if (typeof args.profileId === "number") {
						const p = await api(`/profiles/${args.profileId}?owner=${OWNER}`);
						return text(`《${p.title}》v${p.version} (${p.maturity})\n\n${p.content}`);
					}
					const r = await api(`/profiles?owner=${OWNER}`);
					return text((r.profiles ?? []).map((p) => `#${p.id} 《${p.title}》(${p.theme}) v${p.version} ${p.maturity}`).join("\n") || "No profile chapters yet.");
				}
				default:
					return text(`unknown admin action: ${args.action}`);
			}
		}
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", async (chunk) => {
	buf += chunk;
	let idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		try {
			switch (msg.method) {
				case "initialize":
					send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ruyi-remote", version: "1.0.0" } } });
					break;
				case "notifications/initialized":
				case "initialized":
					break;
				case "ping":
					send({ jsonrpc: "2.0", id: msg.id, result: {} });
					break;
				case "tools/list":
					send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
					break;
				case "tools/call": {
					const { name, arguments: args } = msg.params ?? {};
					try {
						send({ jsonrpc: "2.0", id: msg.id, result: await callTool(name, args) });
					} catch (err) {
						send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `ruyi error: ${err.message}` }], isError: true } });
					}
					break;
				}
				default:
					if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
			}
		} catch { /* never crash the bridge */ }
	}
});
