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
 *   claude mcp add ruyi -s user -e RUYI_URL=https://ruyi.example.com -e RUYI_TOKEN=xxx \
 *     -- node C:\path\to\mcp-remote.mjs
 * opencode: same command in the mcp.local entry's "command" array; env via "environment".
 *
 * Tools mirror the local MCP server (API.md is the contract): recall / list /
 * get / ingest / remember / admin.
 */

const BASE = (process.env.RUYI_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? "";

// Best-effort weekly self-update from the server (same /clients endpoint the
// sync script uses). Runs once at process start; the refreshed file takes
// effect when the client spawns the next MCP session. Never breaks startup.
try {
	const { existsSync, readFileSync, writeFileSync, statSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { execFileSync } = await import("node:child_process");
	const stamp = join(`${process.env.HOME ?? process.env.USERPROFILE}`, ".ruyi-remote.update");
	const stale = !existsSync(stamp) || Date.now() - statSync(stamp).mtimeMs > 7 * 86_400_000;
	if (stale && process.argv[1]) {
		writeFileSync(stamp, String(Date.now()));
		const hdrs = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};
		const res = await fetch(`${BASE}/clients/mcp-remote.mjs`, { headers: hdrs, signal: AbortSignal.timeout(15_000) });
		if (res.ok) {
			const text = await res.text();
			if (text !== readFileSync(process.argv[1], "utf8")) {
				const tmp = `${process.argv[1]}.new`;
				writeFileSync(tmp, text);
				execFileSync(process.execPath, ["--check", tmp]);
				writeFileSync(process.argv[1], text);
			}
		}
	}
} catch { /* self-update is best-effort */ }
const OWNER = process.env.RUYI_OWNER ?? "default";

const TOOLS = [
	{ name: "recall", description: "Search the user's long-term memory and get the entries back — use whenever the answer depends on who this user is, or the user references earlier context. Empty result is normal. Pass ids/profile_ids for a zero-LLM direct fetch. mode: fast = keyword only, deep = semantic (default), excavate = include archived.", inputSchema: { type: "object", properties: { query: { type: "string" }, ids: { type: "array", items: { type: "number" } }, profile_ids: { type: "array", items: { type: "number" } }, k: { type: "number" }, mode: { type: "string", enum: ["fast", "deep", "excavate"] } }, required: ["query"] } },
	{ name: "remember", description: "Explicitly save something to long-term memory RIGHT NOW when the user asks you to remember it, or when you identify a durable rule/convention. Goes through LLM merge judgement — duplicates become reinforcement. Not for one-off task details.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["preference", "fact", "knowledge", "lesson", "skill_index"] }, visibility: { type: "string", enum: ["personal", "project"], description: "personal crosses directories; project stays in its cwd" }, summary: { type: "string" }, content: { type: "string" }, domain: { type: "string" } }, required: ["summary", "content"] } },
	{ name: "admin", description: "Manage long-term memory: forget (archive by id, recoverable via recall mode=excavate), stats (token report, days param), profile (list chapters, or full content with profileId).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["forget", "stats", "profile"] }, id: { type: "number" }, days: { type: "number" }, profileId: { type: "number" } }, required: ["action"] } },
];

async function api(path, { method = "GET", body, timeoutMs = 15_000 } = {}) {
	const headers = { "content-type": "application/json", "x-ruyi-client": "mcp-bridge" };
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
			const r = await api("/recall", { method: "POST", timeoutMs: 60_000, body: { query: String(args.query ?? ""), k: args.k, ids: args.ids, profile_ids: args.profile_ids, owner: OWNER, mode: args.mode ?? "deep" } });
			const parts = [];
			for (const p of r.profiles ?? []) parts.push(`PROFILE【${p.title}】v${p.version} (${p.maturity})\n${p.content}`);
			for (const m of r.memories ?? []) parts.push(`#${m.id} [${m.kind}${m.domain ? "/" + m.domain : ""}] ${m.summary}\n${m.content}`);
			return text(parts.join("\n\n") || `No relevant memories found — safe to answer without memory context.${r.serverTime ? ` (提问发生于 ${r.serverTime} — 这是提问时间，不是任何记忆的时间)` : ""}`);
		}
		case "remember": {
			const r = await api("/memories", { method: "POST", timeoutMs: 60_000, body: { kind: args.kind ?? "fact", summary: args.summary, content: args.content, domain: args.domain, owner: OWNER } });
			if (r.action === "blocked") return text("Blocked: this content was previously forgotten (tombstone) — not re-saved. If it genuinely matters now, say so explicitly and rephrase it.");
			return text(`Saved to long-term memory as #${r.id} (${r.action}): ${args.summary}`);
		}
		case "admin": {
			switch (args.action) {
				case "forget": {
					const r = await api(`/memories/${Number(args.id)}/forget`, { method: "POST", body: {} });
					return text(r.ok ? `Memory #${args.id} archived (recoverable via recall mode=excavate).` : "failed");
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
