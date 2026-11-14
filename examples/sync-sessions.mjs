#!/usr/bin/env node
/**
 * ruyi session sync v2 — slim locally, push line-indexed deltas to a ruyi server.
 * Self-contained; no repo clone needed.
 *
 * Flow per session file:
 *   1. decode jsonl line by line (never loads the whole file as a string)
 *   2. SLIM each line (deterministic, structure-aware — see slimLine):
 *      thinking blocks out, images out, file-history-snapshot gutted,
 *      tool_use kept as skeleton (name + path/command), tool_result capped at
 *      500 chars (error headlines are lesson-dense), any string field >50KB
 *      truncated head+tail. A line NEVER disappears — indices stay 1:1 with
 *      the original file, which is what makes line-number resume exact.
 *   3. push {machine, agent, sessionUid, fromLine, lines} — the server replies
 *      409 {storedLines} on mismatch and we resume from there. Idempotent.
 *
 * Usage:
 *   node sync-sessions.mjs                 # incremental sync of --dir
 *   node sync-sessions.mjs --status        # dry-run inventory (uploads nothing)
 *   node sync-sessions.mjs --file <path>   # one file (SessionEnd hooks)
 *
 * Options:
 *   --dir <path>      session log dir (default: ~/.claude/projects)
 *   --agent <name>    auto (default) | claude-code | pi | codex
 *   --machine <name>  source machine id (default: hostname) — keep it stable,
 *                     it is stamped on every memory from these logs
 *
 * Env: RUYI_URL (required), RUYI_TOKEN (when the service is public)
 */

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { hostname } from "node:os";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};

// Config: env vars win; else ~/.ruyi-sync.config.json (written by --install-hook,
// so the SessionEnd hook needs no environment at all).
const CONFIG_FILE = join(`${process.env.HOME ?? process.env.USERPROFILE}`, ".ruyi-sync.config.json");
const fileCfg = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
const BASE = (process.env.RUYI_URL ?? fileCfg.url ?? "").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? fileCfg.token ?? "";
const DIR = opt("dir", `${process.env.HOME ?? process.env.USERPROFILE}/.claude/projects`);
const AGENT_OPT = opt("agent", "auto");
const MACHINE = opt("machine", hostname());
const ONLY_FILE = opt("file", null);
const STATUS = args.includes("--status");
// Batching is BYTE-targeted, not line-counted: slimmed lines are normally tiny,
// but a session full of giant lines (huge pastes, retained tool output) must
// never overflow the server's body limit (8MB compressed / 32MB gunzipped).
const CHUNK_TARGET_BYTES = 4 * 1024 * 1024; // raw JSON per request — gzips far under the limit
const LINE_HARD_CAP = 2 * 1024 * 1024;      // a single line never exceeds this

/** Last-resort shrink for pathological lines: cut the longest string leaves
 *  (middle of the string kept out, head kept) until the re-encoded line fits.
 *  Never drops the line — the 1:1 line-index invariant holds. */
function shrinkToFit(text) {
	if (text.length <= LINE_HARD_CAP) return text;
	let obj;
	try {
		obj = JSON.parse(text);
	} catch {
		return `${text.slice(0, LINE_HARD_CAP)}…[ruyi-sync hard-truncated]`;
	}
	const leaves = []; // [parent, key, length]
	(function walk(v, parent, key) {
		if (typeof v === "string") {
			if (v.length > 4096) leaves.push([parent, key, v.length]);
			return;
		}
		if (Array.isArray(v)) v.forEach((x, i) => walk(x, v, i));
		else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], v, k);
	})(obj, null, null);
	leaves.sort((a, b) => b[2] - a[2]);
	let out = text;
	for (const [parent, key, len] of leaves) {
		if (out.length <= LINE_HARD_CAP) break;
		const excess = out.length - LINE_HARD_CAP + 2000;
		const keep = Math.max(500, len - excess);
		parent[key] = `${parent[key].slice(0, keep)}\n…[ruyi-sync truncated ${len - keep} chars: line exceeded the request limit]`;
		out = JSON.stringify(obj);
	}
	return out;
}

/** Slim one raw line and enforce the per-line hard cap. */
function slimLineString(ln, agent) {
	let obj;
	try {
		obj = JSON.parse(ln);
	} catch {
		return ln; // unparseable lines pass through verbatim (rare; server keeps them)
	}
	return shrinkToFit(JSON.stringify(slimLine(obj, agent)));
}
const SYNC_VERSION = "2.3.1";

/** Best-effort weekly self-update from the server (which serves the latest
 *  client files from its own checkout). Never breaks a sync run over an update. */
async function maybeSelfUpdate() {
	const now = Date.now();
	if (now - (state.lastUpdateCheck ?? 0) < 7 * 86_400_000) return;
	state.lastUpdateCheck = now;
	saveState();
	try {
		const headers = {};
		if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
		const r = await fetch(`${BASE}/clients/sync-sessions.mjs`, { headers, signal: AbortSignal.timeout(30_000) });
		if (!r.ok) return;
		const text = await r.text();
		const m = text.match(/SYNC_VERSION\s*=\s*"([\d.]+)"/);
		if (!m) return;
		const cur = SYNC_VERSION.split(".").map(Number);
		const newer = m[1].split(".").map(Number).some((n, i) => n > (cur[i] ?? 0));
		if (!newer) return;
		const tmp = `${process.argv[1]}.new`;
		writeFileSync(tmp, text);
		const { execFileSync } = await import("node:child_process");
		execFileSync(process.execPath, ["--check", tmp]); // never replace with a broken file
		writeFileSync(process.argv[1], text);
		console.error(`[ruyi-sync] self-updated to v${m[1]} — takes effect on the next run`);
	} catch { /* update is best-effort; sync must never fail because of it */ }
}

const SUPPORTED = ["claude-code", "pi", "codex"];

const STATE_FILE = join(DIR, ".ruyi-sync.json");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { files: {} };
const saveState = () => {
	mkdirSync(dirname(STATE_FILE), { recursive: true }); // fresh machines have no projects/ yet
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

// ---------------------------------------------------------------- slimming

const DROP_LINE_TYPES = new Set(["file-history-snapshot"]); // CC whole-file snapshots

function truncateStr(s) {
	if (s.length <= 50_000) return s;
	return s.slice(0, 25_000) + `\n…[${(s.length - 50_000).toLocaleString()} chars dropped]…\n` + s.slice(-25_000);
}

/** Shallow-truncate every string leaf of an object to n chars (skeleton view). */
function skeleton(v, n) {
	if (typeof v === "string") return v.slice(0, n);
	if (Array.isArray(v)) return v.map((x) => skeleton(x, n));
	if (v && typeof v === "object") {
		const out = {};
		for (const [k, x] of Object.entries(v)) out[k] = skeleton(x, n);
		return out;
	}
	return v;
}

function slimBlock(b) {
	if (!b || typeof b !== "object") return b;
	const t = b.type;
	// thinking carries no durable memory value (user decision)
	if (t === "thinking" || t === "reasoning" || t === "redacted_thinking") return { type: "thinking", stripped: true };
	if (t === "image" || t === "input_image" || t === "image_url") return { type: "image", stripped: true };
	if (t === "tool_use" || t === "function_call") {
		const name = b.name ?? "";
		const inp = b.input ?? b.arguments ?? {};
		const keep = {};
		if (typeof inp === "string") keep.args = inp.slice(0, 300);
		else if (inp && typeof inp === "object") {
			if (typeof inp.file_path === "string") keep.file_path = inp.file_path;
			if (typeof inp.command === "string") keep.command = inp.command.slice(0, 300);
			if (!Object.keys(keep).length) Object.assign(keep, skeleton(inp, 300));
		}
		return { type: "tool_use", name, input: keep };
	}
	if (t === "tool_result" || t === "function_call_output") {
		let c = b.content ?? b.output ?? "";
		if (Array.isArray(c)) c = c.map((x) => (typeof x?.text === "string" ? x.text : "")).join("\n");
		// 500 chars keeps the error headline — the single most lesson-dense payload
		return { type: "tool_result", content: String(c).slice(0, 500), truncated: String(c).length > 500 };
	}
	if (typeof b.text === "string") b = { ...b, text: truncateStr(b.text) };
	return b;
}

function slimContainer(node) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node.content)) node.content = node.content.map(slimBlock);
	if (node.message && typeof node.message === "object") slimContainer(node.message);
	for (const k of Object.keys(node)) {
		const v = node[k];
		if (typeof v === "string" && v.length > 50_000) node[k] = truncateStr(v);
	}
}

/** Slim one parsed jsonl record (in place). Never returns null — line count is sacred. */
export function slimLine(obj, agent) {
	if (DROP_LINE_TYPES.has(obj.type)) return { type: obj.type, stripped: true };
	if (agent === "codex" && obj.payload && typeof obj.payload === "object") slimContainer(obj.payload);
	else slimContainer(obj);
	// CC mirrors the tool result in a top-level `toolUseResult` field — and for
	// image reads that is the FULL base64 payload (found in production: one such
	// field alone was 387KB, dominating a whole machine's sync volume).
	if (obj.toolUseResult && typeof obj.toolUseResult === "object") {
		const tr = obj.toolUseResult;
		obj.toolUseResult = (tr.type === "image" || tr.file?.base64 || tr.image?.base64)
			? { type: "image", stripped: true }
			: skeleton(tr, 500);
	}
	return obj;
}

// ------------------------------------------------------------- format probe

function* walk(dir, rel = "") {
	for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) yield* walk(dir, r);
		else if (e.name.endsWith(".jsonl") && !r.includes("subagents/")) yield r;
	}
}

/** Read complete lines of a file as [text] without ever making one giant string
 *  (a single CC session can exceed the 512MB string cap — Buffer stays off-heap). */
function readLines(file) {
	const buf = readFileSync(file);
	const lines = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 10) {
			lines.push(buf.subarray(start, i).toString("utf8"));
			start = i + 1;
		}
	}
	// trailing partial line (session in flight) is left for the next run
	return { lines, completeBytes: start };
}

function parseFirstLine(file) {
	const fd = readFileSync(file);
	const nl = fd.indexOf(10);
	try {
		return JSON.parse(fd.subarray(0, nl > 0 ? nl : 4096).toString("utf8"));
	} catch {
		return null;
	}
}

export function detectAgent(dir) {
	for (const rel of walk(dir)) {
		const file = join(dir, rel);
		if (basename(rel).startsWith("rollout-")) {
			const first = parseFirstLine(file);
			if (first && (first.type === "session_meta" || first.payload)) return "codex";
		}
		const first = parseFirstLine(file);
		if (!first) continue;
		if (typeof first.sessionId === "string") return "claude-code";
		if (first.type === "session" && typeof first.id === "string") return "pi";
	}
	return null;
}

function uidOf(agent, first, rel) {
	if (agent === "claude-code") {
		if (typeof first?.sessionId === "string" && first.sessionId.length >= 8) return first.sessionId;
	}
	if (agent === "pi") {
		if (first?.type === "session" && typeof first.id === "string") return first.id;
	}
	if (agent === "codex") {
		const p = first?.payload ?? {};
		if (typeof p.id === "string" && p.id.length >= 8) return p.id;
		if (typeof p.session_id === "string") return p.session_id;
	}
	// last resort: filename stem carries a uuid on pi/codex
	const stem = basename(rel).replace(/\.jsonl$/, "");
	const m = stem.match(/[0-9a-f-]{16,}/i);
	if (m) return m[0];
	return null;
}

// ------------------------------------------------------------------ pushing

async function api(path, body) {
	const headers = { "content-type": "application/json", "x-ruyi-client": `sync:${MACHINE}` };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	let payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
	if (payload && payload.length > 50_000) {
		payload = gzipSync(payload);
		headers["content-encoding"] = "gzip";
	}
	const res = await fetch(`${BASE}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		body: payload,
		signal: AbortSignal.timeout(120_000),
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, json };
}

function failLoud(dir) {
	console.error(`✗ 识别不了 ${dir} 里的会话日志格式。
目前支持: ${SUPPORTED.join(" / ")}。
如果你用的是其他客户端，请把日志里的一行样例（脱敏后）发到
github.com/xiaqii/ruyi 提 issue，我们会加适配。
（没有上传任何数据，你没有白装。）`);
	process.exit(1);
}

async function syncFile(rel, agent) {
	const file = join(DIR, rel);
	const key = rel.replace(/\\/g, "/");
	const { lines } = readLines(file);
	if (lines.length === 0) return { rel, skipped: true };
	let first;
	try {
		first = JSON.parse(lines[0]);
	} catch {
		return { rel, skipped: true, reason: "unparseable head" };
	}
	const uid = uidOf(agent, first, rel);
	if (!uid) return { rel, skipped: true, reason: "no session uid" };

	let sent = state.files[key]?.lines ?? 0;
	if (sent > lines.length) sent = 0; // rotated/truncated — resend all
	if (sent === lines.length) return { rel, skipped: true };

	while (sent < lines.length) {
		const batch = [];
		let bytes = 2; // "[]"
		while (sent + batch.length < lines.length) {
			const slim = slimLineString(lines[sent + batch.length], agent);
			if (batch.length > 0 && bytes + slim.length + 1 > CHUNK_TARGET_BYTES) break;
			batch.push(slim);
			bytes += slim.length + 1;
		}
		const r = await api("/sync/session", {
			machine: MACHINE, agent, sessionKey: key, sessionUid: uid, fromLine: sent, lines: batch,
		});
		if (r.status === 409) {
			sent = r.json.storedLines ?? 0;
			continue;
		}
		if (r.status !== 200) throw new Error(`sync ${key}: HTTP ${r.status} ${r.json.error ?? ""}`);
		sent = r.json.storedLines;
		state.files[key] = { lines: sent, uid };
		saveState(); // per-chunk checkpoint: a killed run (hook timeout, Ctrl-C) resumes here
		process.stdout.write(`\r  ${basename(rel)} ${sent}/${lines.length} 行   `);
	}
	state.files[key] = { lines: sent, uid };
	saveState();
	return { rel, skipped: false, lines: sent };
}

// --------------------------------------------------------------------- main

const isMain = !!process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
// --uninstall-hook: remove the SessionEnd hook and the stored credentials.
// The script file itself and the MCP registration are removed separately
// (delete the file; `claude mcp remove ruyi`). Synced data on the server is
// NOT touched — that is accumulated memory, not client state.
if (args.includes("--uninstall-hook")) {
	const homeDir = `${process.env.HOME ?? process.env.USERPROFILE}`;
	const ccSettings = join(homeDir, ".claude", "settings.json");
	if (existsSync(ccSettings)) {
		const cfg = JSON.parse(readFileSync(ccSettings, "utf8"));
		const before = JSON.stringify(cfg);
		for (const event of ["SessionEnd", "SessionStart", "UserPromptSubmit"]) {
			if (cfg.hooks?.[event]) {
				cfg.hooks[event] = cfg.hooks[event].filter((e) => {
					const j = JSON.stringify(e);
					return !j.includes("sync-sessions.mjs") && !j.includes("ruyi-hooks");
				});
				if (!cfg.hooks[event].length) delete cfg.hooks[event];
			}
		}
		if (cfg.env) {
			delete cfg.env.RUYI_URL;
			delete cfg.env.RUYI_TOKEN;
			if (!Object.keys(cfg.env).length) delete cfg.env;
		}
		if (JSON.stringify(cfg) !== before) writeFileSync(ccSettings, JSON.stringify(cfg, null, 2));
		console.log("✓ hooks removed (SessionEnd sync + SessionStart/UserPromptSubmit injection) and env keys cleaned");
	} else {
		console.log("✓ no settings.json found (nothing to remove)");
	}
	const hooksDir = join(homeDir, ".claude", "ruyi-hooks");
	if (existsSync(hooksDir)) {
		rmSync(hooksDir, { recursive: true, force: true });
		console.log("✓ ~/.claude/ruyi-hooks/ deleted");
	}
	const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
	if (existsSync(claudeMd)) {
		const md = readFileSync(claudeMd, "utf8");
		const cleaned = md.replace(/\n*<!-- ruyi-memory-rules -->[\s\S]*?<!-- \/ruyi-memory-rules -->\n?/g, "\n");
		if (cleaned !== md) {
			writeFileSync(claudeMd, cleaned);
			console.log("✓ memory-use rules block removed from CLAUDE.md (your other content untouched)");
		}
	}
	if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE);
	console.log("✓ ~/.ruyi-sync.config.json (stored url/token) deleted");
	console.log("Remaining manual steps: delete sync-sessions.mjs itself, and remove the query bridge:");
	console.log("  claude mcp remove ruyi && delete mcp-remote.mjs");
	console.log("Server-side memories already learned are untouched (they are the point of memory).");
	process.exit(0);
}

if (!BASE) {
	console.error("RUYI_URL is not set. Example: $env:RUYI_URL='https://ruyi.example.com'");
	process.exit(1);
}
// --install-hook: one-time setup. Writes ~/.ruyi-sync.config.json (needs
// RUYI_URL/RUYI_TOKEN in env NOW) and registers a Claude Code SessionEnd hook
// so every finished conversation syncs itself. Idempotent.
if (args.includes("--install-hook")) {
	const url = process.env.RUYI_URL ?? fileCfg.url;
	const token = process.env.RUYI_TOKEN ?? fileCfg.token;
	if (!url) {
		console.error("RUYI_URL is required for --install-hook. Example:\n  $env:RUYI_URL='https://ruyi.example.com'; $env:RUYI_TOKEN='<token>'; node sync-sessions.mjs --install-hook");
		process.exit(1);
	}
	writeFileSync(CONFIG_FILE, JSON.stringify({ url, token }, null, 2));
	const homeDir = `${process.env.HOME ?? process.env.USERPROFILE}`;
	const ccSettings = join(homeDir, ".claude", "settings.json");
	mkdirSync(dirname(ccSettings), { recursive: true });
	const cfg = existsSync(ccSettings) ? JSON.parse(readFileSync(ccSettings, "utf8")) : {};
	cfg.hooks ??= {};
	cfg.hooks.SessionEnd ??= [];
	const cmd = `node ${JSON.stringify(process.argv[1])}`;
	const already = JSON.stringify(cfg.hooks.SessionEnd).includes("sync-sessions.mjs");
	if (!already) {
		cfg.hooks.SessionEnd.push({ hooks: [{ type: "command", command: cmd }] });
	}
	console.log(`✓ config written to ${CONFIG_FILE}`);
	console.log(`✓ SessionEnd hook ${already ? "already present" : "added"} in ${ccSettings}`);

	// Memory injection hooks (SessionStart opening injection + UserPromptSubmit
	// per-turn recall) — downloaded from the server so they stay current.
	const hooksDir = join(homeDir, ".claude", "ruyi-hooks");
	mkdirSync(hooksDir, { recursive: true });
	const injectHooks = [
		["cc-session-start.mjs", "session-start.mjs", "SessionStart"],
		["cc-user-prompt-submit.mjs", "user-prompt-submit.mjs", "UserPromptSubmit"],
	];
	const authHeaders = token ? { authorization: `Bearer ${token}` } : {};
	for (const [remote, local, event] of injectHooks) {
		const dest = join(hooksDir, local);
		try {
			const r = await fetch(`${url.replace(/\/+$/, "")}/clients/${remote}`, { headers: authHeaders, signal: AbortSignal.timeout(30_000) });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			writeFileSync(dest, await r.text());
		} catch (e) {
			console.error(`⚠ could not fetch ${remote} (${e.message}) — injection hooks skipped; sync still works`);
			continue;
		}
		cfg.hooks[event] ??= [];
		if (!JSON.stringify(cfg.hooks[event]).includes("ruyi-hooks")) {
			cfg.hooks[event].push({ hooks: [{ type: "command", command: `node ${JSON.stringify(dest)}` }] });
		}
		console.log(`✓ ${event} injection hook ready (${dest})`);
	}
	// The injection hooks read env; provide it via settings.json's top-level env.
	cfg.env ??= {};
	cfg.env.RUYI_URL = url.replace(/\/+$/, "");
	if (token) cfg.env.RUYI_TOKEN = token;
	writeFileSync(ccSettings, JSON.stringify(cfg, null, 2));

	// Memory-use rules: teach the model WHEN to reach for memory — tools alone
	// are not enough (it answered "I don't know" with the tools sitting there).
	const claudeMd = join(homeDir, ".claude", "CLAUDE.md");
	const RULES = [
		"<!-- ruyi-memory-rules -->",
		"## Long-term memory (ruyi)",
		"You have a ruyi long-term memory service (mcp__ruyi__* tools; some memories are also auto-injected by hooks).",
		"- BEFORE answering anything about the user themselves — preferences, possessions, past decisions, projects, habits, \"what did I say about X\" — call mcp__ruyi__probe first; if it returns pointers, fetch them with mcp__ruyi__recall, then answer. Never answer such questions from guesswork while memory tools exist.",
		"- When the user asks you to remember something, write it with mcp__ruyi__remember.",
		"- Memories already injected into this conversation need no re-fetching.",
		"<!-- /ruyi-memory-rules -->",
	].join("\n");
	const md = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
	const blockRe = /<!-- ruyi-memory-rules -->[\s\S]*?<!-- \/ruyi-memory-rules -->/;
	writeFileSync(claudeMd, blockRe.test(md) ? md.replace(blockRe, RULES) : `${md}${md.endsWith("\n") || !md ? "" : "\n"}\n${RULES}\n`);
	console.log(`✓ memory-use rules written to ${claudeMd}`);
	console.log("From now on every finished Claude Code conversation syncs itself, and every conversation starts with your memory in context.");
	console.log(`Optional backstop (daily full scan): schtasks /create /tn ruyi-sync /tr "${cmd}" /sc daily /st 23:30`);
	process.exit(0);
}

await maybeSelfUpdate();

// Hook mode: Claude Code pipes {"transcript_path": "..."} on stdin (SessionEnd).
let hookFile = ONLY_FILE;
if (!hookFile && !process.stdin.isTTY && !STATUS) {
	const raw = readFileSync(0, "utf8").trim();
	if (raw) {
		try {
			const p = JSON.parse(raw).transcript_path;
			if (typeof p === "string" && existsSync(p)) hookFile = p;
		} catch { /* not hook json */ }
		if (!hookFile) {
			// We were triggered by something (a hook, a pipe) but could not resolve
			// one session file — a full directory scan here would silently run on
			// EVERY session end. Do nothing; manual runs and --file are the
			// sanctioned full-scan paths.
			console.error("[ruyi-sync] hook payload had no usable transcript_path; skipping (run manually for a full scan)");
			process.exit(0);
		}
	}
}

const AGENT = AGENT_OPT === "auto" ? detectAgent(DIR) : AGENT_OPT;
if (!AGENT) failLoud(DIR);
if (!SUPPORTED.includes(AGENT)) failLoud(DIR);

const files = hookFile ? [relative(DIR, hookFile).replace(/\\/g, "/")] : [...walk(DIR)];

if (STATUS) {
	console.log(`格式: ${AGENT} | 目录: ${DIR} | 机器: ${MACHINE}`);
	let totalLines = 0;
	for (const rel of files) {
		const { lines } = readLines(join(DIR, rel));
		totalLines += lines.length;
		const st = state.files[rel.replace(/\\/g, "/")]?.lines ?? 0;
		console.log(`${st === lines.length ? "✓" : "↻"} ${rel}  ${lines.length} 行 (已推 ${st})`);
	}
	console.log(`共 ${files.length} 个会话文件, ${totalLines.toLocaleString()} 行 — 未上传任何数据`);
	process.exit(0);
}

let done = 0, skipped = 0, failed = 0;
console.log(`ruyi sync v2: ${files.length} 个会话文件 (${AGENT}) ${DIR} → ${BASE} (机器: ${MACHINE})`);
for (const rel of files) {
	try {
		const r = await syncFile(rel, AGENT);
		if (r.skipped) skipped++;
		else {
			done++;
			console.log(`\r✓ ${rel} (${r.lines} 行)                    `);
		}
	} catch (err) {
		failed++;
		console.error(`\n✗ ${rel}: ${err.message}`);
	}
}
console.log(`done: ${done} 已更新, ${skipped} 已同步, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
}
