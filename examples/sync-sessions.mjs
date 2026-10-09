#!/usr/bin/env node
/**
 * ruyi session sync — push this machine's agent session logs to a ruyi server
 * for nightly dream distillation. Self-contained; no repo clone needed.
 *
 * Usage:
 *   node sync-sessions.mjs                      # incremental scan of --dir (progress shown)
 *   node sync-sessions.mjs --file <path>        # sync one file (SessionEnd hooks)
 *   node sync-sessions.mjs --status             # show local vs server byte counts
 *
 * Options:
 *   --dir <path>      session log dir (default: ~/.claude/projects)
 *   --agent <name>    log format: claude-code (default) | pi
 *   --machine <name>  source machine id (default: hostname) — stamped on every
 *                     memory extracted from these logs; keep it stable!
 *
 * Env: RUYI_URL (required), RUYI_TOKEN (when the service is public)
 *
 * Design: offset-based incremental append. Only new bytes are sent; the server
 * enforces offset continuity (a mismatch returns the true offset and the client
 * resumes there). Idempotent, resumable, safe to run anytime.
 */

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { hostname } from "node:os";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};

const BASE = (process.env.RUYI_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? "";
const DIR = opt("dir", `${process.env.HOME ?? process.env.USERPROFILE}/.claude/projects`);
const AGENT = opt("agent", "claude-code");
const MACHINE = opt("machine", hostname());
const ONLY_FILE = opt("file", null);
const STATUS = args.includes("--status");
const CHUNK = 900_000; // bytes per request — keeps JSON bodies ~1MB

if (!BASE) {
	console.error("RUYI_URL is not set. Example: $env:RUYI_URL='https://ruyi.example.com'");
	process.exit(1);
}

const STATE_FILE = join(DIR, ".ruyi-sync.json");
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { files: {} };
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

async function api(path, body) {
	const headers = { "content-type": "application/json" };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const res = await fetch(`${BASE}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(120_000),
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, json };
}

function* walk(dir, rel = "") {
	for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
		const r = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) yield* walk(dir, r);
		else if (e.name.endsWith(".jsonl") && !r.includes("subagents/")) yield r;
	}
}

/** Slice buf[start .. start+maxLen] but never split a multi-byte UTF-8 char. */
function utf8SafeEnd(buf, start, maxLen) {
	let end = Math.min(start + maxLen, buf.length);
	while (end > start && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
	return end;
}

async function syncFile(rel) {
	const file = join(DIR, rel);
	const size = statSync(file).size;
	const key = rel.replace(/\\/g, "/");
	let sent = state.files[key] ?? 0;
	if (sent > size) sent = 0; // file was truncated/rotated — resend whole
	if (sent === size) return { rel, skipped: true };

	const buf = readFileSync(file); // Buffer; offsets are BYTES (server counts bytes)
	while (sent < size) {
		const end = utf8SafeEnd(buf, sent, CHUNK);
		const chunk = buf.subarray(sent, end).toString("utf8");
		const r = await api("/sync/session", { machine: MACHINE, agent: AGENT, sessionKey: key, offset: sent, data: chunk });
		if (r.status === 409) {
			sent = r.json.receivedBytes; // server knows the truth — resume from there
			continue;
		}
		if (r.status !== 200) throw new Error(`sync ${key}: HTTP ${r.status} ${r.json.error ?? ""}`);
		sent = r.json.receivedBytes;
		process.stdout.write(`\r  ${basename(rel)} ${(sent / 1024).toFixed(0)}/${(size / 1024).toFixed(0)} KB   `);
	}
	state.files[key] = sent;
	saveState();
	return { rel, skipped: false, bytes: size };
}

if (STATUS) {
	const r = await api(`/sync/state?machine=${encodeURIComponent(MACHINE)}`);
	const server = r.json.sessions ?? {};
	const rows = Object.keys(state.files).map((k) => {
		const local = state.files[k];
		const srv = server[k] ?? 0;
		return `${srv === local ? "✓" : "↻"} ${k}  local ${local}B / server ${srv}B`;
	});
	console.log(rows.join("\n") || "(no sync history)");
	process.exit(0);
}

const files = ONLY_FILE ? [relative(DIR, ONLY_FILE).replace(/\\/g, "/")] : [...walk(DIR)];
let done = 0, skipped = 0, failed = 0;
console.log(`ruyi sync: ${files.length} session file(s) from ${DIR} → ${BASE} (machine: ${MACHINE})`);
for (const rel of files) {
	try {
		const r = await syncFile(rel);
		if (r.skipped) skipped++;
		else {
			done++;
			console.log(`\r✓ ${rel} (${((r.bytes ?? 0) / 1024).toFixed(0)} KB)                    `);
		}
	} catch (err) {
		failed++;
		console.error(`\n✗ ${rel}: ${err.message}`);
	}
}
console.log(`done: ${done} updated, ${skipped} already in sync, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
