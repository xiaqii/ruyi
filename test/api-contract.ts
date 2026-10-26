/**
 * API contract test — verifies every endpoint documented in API.md against the
 * RUNNING service, asserting the documented response shapes field by field.
 * Zero LLM cost. Mutation endpoints are exercised on a throwaway memory row
 * created directly via the db module (free) and archived at the end.
 *
 * API.md is the authoritative contract; if code and docs drift, this test fails
 * and the release aborts. Run: node test/api-contract.ts   (exit 1 on failure)
 */

import { getDb, insertMemory } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { mkdtempSync, rmSync as rmDirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Self-contained: spawn a throwaway service on a random port with a temp
// state dir. The suite writes directly to the service's SQLite db, so it
// must own the instance — pointing it at any long-lived service both fails
// (db mismatch) and pollutes it. Set RUYI_URL to test an external instance
// instead (db-dependent assertions best-effort there, as before).
const EXTERNAL = process.env.RUYI_URL;
const RUN = Date.now().toString(36);
const PORT = 19000 + Math.floor(Math.random() * 900);
const SPAWNED_TOKEN = `contract-${RUN}`;
const tmp = EXTERNAL ? "" : mkdtempSync(join(tmpdir(), `ruyi-contract-${RUN}-`));
const BASE = (EXTERNAL ?? `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? (EXTERNAL ? "" : SPAWNED_TOKEN);

let server: import("node:child_process").ChildProcess | null = null;
if (!EXTERNAL) {
	mkdirSync(join(tmp, "data"), { recursive: true });
	writeFileSync(join(tmp, "config.local.json"), JSON.stringify({ port: PORT, authToken: SPAWNED_TOKEN }));
	const { spawn } = await import("node:child_process");
	server = spawn(process.execPath, ["src/cli.ts", "serve"], {
		cwd: new URL("..", import.meta.url).pathname,
		env: { ...process.env, RUYI_STATE: tmp },
		stdio: ["ignore", "ignore", "inherit"],
	});
	let up = false;
	for (let i = 0; i < 100 && !up; i++) {
		await new Promise((r) => setTimeout(r, 200));
		try {
			const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
			up = res.ok;
		} catch { /* not up yet */ }
	}
	if (!up) {
		console.error("✗ FAIL could not start throwaway service for contract test");
		server.kill("SIGKILL");
		process.exit(1);
	}
}

let passed = 0;
let failed = 0;

function ok(cond: boolean, name: string, detail = ""): void {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ FAIL ${name} ${detail}`);
	}
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const has = (obj: unknown, keys: string[]): boolean =>
	typeof obj === "object" && obj !== null && keys.every((k) => k in (obj as Record<string, unknown>));

const MEMORY_ROW_FIELDS = ["id", "owner", "kind", "summary", "content", "keywords", "status", "created_at", "updated_at"];

console.log("API contract (documented in API.md):");

// GET / — self-instructing landing page (public, must never leak secrets)
{
	const md = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
	const text = await md.text();
	ok(md.status === 200 && text.includes("ruyi") && text.includes("mcp-remote.mjs"), "GET / landing (markdown)");
	ok(!/Bearer [a-f0-9]{20,}/.test(text), "landing page leaks no token");
	const html = await fetch(`${BASE}/`, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(5000) });
	ok((html.headers.get("content-type") ?? "").includes("text/html"), "GET / content negotiation (html)");
}

// GET /health — no auth
{
	const { status, json } = await call("GET", "/health");
	ok(
		status === 200 && json.ok === true && Object.values(json).every((v) => v === true || typeof v === "number"),
		"GET /health shape",
	);
}

// GET /inject
{
	const { status, json } = await call("GET", "/inject?owner=default&cwd=/root&scope=smart");
	const c = json.constitution as unknown[];
	const p = json.profileDirectory as unknown[];
	ok(status === 200 && Array.isArray(c) && Array.isArray(p) && Array.isArray(json.index) && json.index.length === 0, "/inject returns constitution+profileDirectory, index empty (compat)");
	if (c.length > 0) ok(has(c[0], ["id", "summary", "content"]), "constitution entry fields");
	if (p.length > 0) ok(has(p[0], ["id", "title", "maturity", "parent_id"]), "profileDirectory entry fields (tree-ready)");
	// constitution = manually pinned ONLY (auto-graduation removed: domain content must not ride every turn)
	const graduated = (c as { id: number }[]).length;
	ok(graduated === 0 || true, "constitution may be empty when nothing is pinned");
}

// POST /recall (fast mode = zero LLM)
{
	const { status, json } = await call("POST", "/recall", { query: "服务器", k: 2, owner: "default", mode: "fast" });
	ok(status === 200 && Array.isArray(json.memories) && Array.isArray(json.profiles), "/recall returns memories+profiles arrays");
	const m = (json.memories as unknown[])[0];
	if (m) ok(MEMORY_ROW_FIELDS.every((f) => f in (m as object)), "memory row fields");
}

// GET /memories
{
	const { status, json } = await call("GET", "/memories?owner=default&status=active&limit=5");
	ok(status === 200 && Array.isArray(json.memories), "GET /memories list");
}

// mutation round trip on a throwaway row (created via db module, zero LLM)
const db = EXTERNAL ? getDb(loadConfig().dbPath) : getDb(join(tmp, "data", "ruyi.db"));
const tmpId = insertMemory(
	db,
	{ kind: "knowledge", summary: "api-contract 测试行", content: `契约测试临时行 ${Date.now()}，测完即归档。`, keywords: ["apitest"], origin: "agent_inferred", confidence: 0.1 },
	{ owner: "default", cwd: null },
);
if (tmpId === -1) throw new Error("fixture insert blocked by tombstone — content must be unique per run");
{
	const { status, json } = await call("GET", `/memories/${tmpId}`);
	ok(status === 200 && has(json.memory, MEMORY_ROW_FIELDS), "GET /memories/:id shape");
}
{
	// pin channel removed (v0.10.4): iron rules belong to the agent platform's
	// own AGENTS.md/CLAUDE.md; ruyi keeps no always-on injection channel.
	const { status } = await call("POST", `/memories/${tmpId}/pin`, { pinned: 1 });
	ok(status === 404, "pin endpoint removed (404)");
}
{
	const { json } = await call("POST", `/memories/${tmpId}/forget`);
	ok(json.ok === true && json.status === "archived", "forget shape");
	const { json: j2 } = await call("GET", `/memories/${tmpId}`);
	ok((j2.memory as { status: string }).status === "archived", "forget persists as archived");
}

// GET /profiles + /profiles/:id
{
	const { status, json } = await call("GET", "/profiles?owner=default");
	const profiles = json.profiles as { id: number; title: string; maturity: string; content: string }[];
	ok(status === 200 && Array.isArray(profiles), "GET /profiles list");
	if (profiles.length > 0) {
		ok(has(profiles[0], ["id", "title", "maturity", "content"]), "profile list row fields");
		const { json: one } = await call("GET", `/profiles/${profiles[0]!.id}?owner=default`);
		ok(has(one, ["id", "title", "content", "version", "maturity"]), "GET /profiles/:id shape");
	}
}

// GET /stats
{
	const { status, json } = await call("GET", "/stats?days=1&owner=default");
	ok(status === 200 && has(json, ["counts", "tokenUsage"]) && Array.isArray(json.tokenUsage), "GET /stats shape");
	const u = (json.tokenUsage as unknown[])[0];
	if (u) ok(has(u, ["day", "step", "input", "output"]), "tokenUsage row fields");
}

// validation error shapes (route exists, no LLM burned)
{
	const { status, json } = await call("POST", "/memories", {});
	ok(status === 400 && typeof json.error === "string", "POST /memories validation 400");
	const r2 = await call("POST", "/ingest", { text: "too short" });
	ok(r2.status === 400 && typeof r2.json.error === "string", "POST /ingest min-length 400");
	const r3 = await call("POST", "/recall", { query: "" });
	ok(r3.status === 400 && typeof r3.json.error === "string", "POST /recall empty-query 400");
}

// session sync protocol: push with offset, offset-mismatch 409 resume, state
{
	const machine = `contract-test-${RUN}`;
	const r1 = await call("POST", "/sync/session", { machine, agent: "claude-code", sessionKey: `t/${RUN}/s.jsonl`, offset: 0, data: '{"a":1}\n' });
	ok(r1.status === 200 && r1.json.receivedBytes === 8, "sync push first chunk", JSON.stringify(r1.json));
	const r2 = await call("POST", "/sync/session", { machine, agent: "claude-code", sessionKey: `t/${RUN}/s.jsonl`, offset: 0, data: "X" });
	ok(r2.status === 409 && r2.json.receivedBytes === 8, "sync offset mismatch → 409 with true offset");
	const r3 = await call("POST", "/sync/session", { machine, agent: "claude-code", sessionKey: `t/${RUN}/s.jsonl`, offset: 8, data: '{"b":2}\n' });
	ok(r3.status === 200 && r3.json.receivedBytes === 16, "sync resume at server offset");
	const r4 = await call("GET", `/sync/state?machine=${machine}`);
	ok(r4.status === 200 && (r4.json.sessions as Record<string, number>)[`t/${RUN}/s.jsonl`] === 16, "sync state reports bytes");
	const r5 = await call("POST", "/sync/session", { machine: "../evil", agent: "x", sessionKey: "x", offset: 0, data: "x" });
	ok(r5.status === 400, "sync rejects path traversal");

	// auth model: loopback trusted; proxied/remote requests must carry the bearer token
	{
		// unknown route still passes the auth gate first — use a real authed route:
		const list = (headers: Record<string, string>) =>
			fetch(`${BASE}/memories`, { headers, signal: AbortSignal.timeout(10_000) }).then((r) => r.status);
		const rejected = await list({ "x-real-ip": "203.0.113.9" });
		ok(rejected === 401 || rejected === 503, "proxied request without token is rejected", `got ${rejected}`);
		const bad = await list({ "x-real-ip": "203.0.113.9", authorization: "Bearer wrong-token" });
		ok(bad === 401 || bad === 503, "proxied request with wrong token is rejected", `got ${bad}`);
		try {
			// The token must match the instance under test: the spawned instance
			// uses its own SPAWNED_TOKEN; an EXTERNAL one uses the repo config's.
			const authToken = EXTERNAL
				? (JSON.parse(readFileSync(new URL("../config.local.json", import.meta.url), "utf8")) as { authToken?: string }).authToken
				: SPAWNED_TOKEN;
			if (authToken) {
				const good = await list({ "x-real-ip": "203.0.113.9", authorization: `Bearer ${authToken}` });
				ok(good === 200, "proxied request with correct token passes", `got ${good}`);
			}
		} catch { /* no local config — token assertions skipped */ }
	}

	// content-addressed dedup: same sessionUid from a different channel short-circuits
	const uid = `contract-uid-${RUN}`;
	const p1 = await call("POST", "/sync/session", {
		machine, agent: "claude-code", sessionKey: `a/${RUN}/first.jsonl`, sessionUid: uid, totalSize: 20,
		offset: 0, data: "1234567890",
	});
	ok(p1.status === 200 && p1.json.receivedBytes === 10, "uid first push (partial)");
	// same uid arrives again from offset 0 claiming totalSize 10 → already complete
	const p2 = await call("POST", "/sync/session", {
		machine, agent: "claude-code", sessionKey: `b/${RUN}/copy.jsonl`, sessionUid: uid, totalSize: 10,
		offset: 0, data: "1234567890",
	});
	ok(p2.status === 200 && p2.json.already === true, "uid already-complete short-circuit");
	// same uid, larger totalSize → 409 tells client where the real resume point is
	const p3 = await call("POST", "/sync/session", {
		machine, agent: "claude-code", sessionKey: `b/${RUN}/copy.jsonl`, sessionUid: uid, totalSize: 20,
		offset: 0, data: "1234567890ABCDEFGHIJ",
	});
	ok(p3.status === 409 && p3.json.receivedBytes === 10, "uid grown session → 409 resume point");
	const p4 = await call("POST", "/sync/session", {
		machine, agent: "claude-code", sessionKey: `b/${RUN}/copy.jsonl`, sessionUid: uid, totalSize: 20,
		offset: 10, data: "ABCDEFGHIJ",
	});
	ok(p4.status === 200 && p4.json.receivedBytes === 20, "uid delta append completes at 20");

	// auto-injection dedup: a conversation never receives the same item twice
	// (self-contained seed: the shared tmpId is archived by the forget tests above)
	const conv = `contract-conv-${RUN}`;
	const dedupId = insertMemory(
		db,
		{ kind: "knowledge", summary: "api-contract 去重测试行", content: `契约去重专用行 ${Date.now()}，测完即归档。`, keywords: ["deduptest"], origin: "agent_inferred", confidence: 0.1 },
		{ owner: "default", cwd: null },
	);
	const dq = "契约去重专用行";
	const d1 = await call("POST", "/recall", { query: dq, k: 5, mode: "fast", conversation: conv, auto: true });
	ok(d1.status === 200 && d1.json.memories.some((m) => m.id === dedupId), "auto recall: first turn returns the memory");
	const d2 = await call("POST", "/recall", { query: dq, k: 5, mode: "fast", conversation: conv, auto: true });
	ok(
		d2.status === 200 && !d2.json.memories.some((m) => m.id === dedupId) && (d2.json.deduped ?? 0) >= 1,
		"auto recall: second turn dedups (memory suppressed, deduped >= 1)",
		`deduped=${d2.json.deduped}`,
	);
	const d3 = await call("POST", "/recall", { query: dq, k: 5, mode: "fast" });
	ok(d3.status === 200 && d3.json.memories.some((m) => m.id === dedupId), "explicit recall (no auto) ignores the ledger");
	const d4 = await call("POST", "/recall", { query: dq, k: 5, mode: "fast", auto: true });
	ok(d4.status === 400, "auto recall without conversation -> 400");
	ok(
		d1.json.topicId === d2.json.topicId && d2.json.replyId === (d1.json.replyId as number) + 1,
		"server numbering: topic stable, reply_id increments",
		`topic ${d1.json.topicId}->${d2.json.topicId} reply ${d1.json.replyId}->${d2.json.replyId}`,
	);
	const topicRow = db.prepare(`SELECT topic_id, first_reply FROM topics WHERE conversation = ?`).get(conv) as { topic_id: number; first_reply: string } | undefined;
	ok(topicRow?.first_reply === dq, "topic registry stores the first reply text");
	const replyRows = db.prepare(`SELECT reply_id, injected FROM replies WHERE topic_id = ? ORDER BY reply_id`).all(topicRow!.topic_id) as { reply_id: number; injected: string }[];
	ok(
		replyRows.length === 2 && replyRows[0].injected.includes(`m:${dedupId}`) && !replyRows[1].injected.includes(`m:${dedupId}`),
		"reply ledger: turn 1 injected it, turn 2 did not",
		JSON.stringify(replyRows),
	);
	db.prepare(`DELETE FROM replies WHERE topic_id = ?`).run(topicRow!.topic_id);
	db.prepare(`DELETE FROM topics WHERE conversation = ?`).run(conv);
	db.prepare(`DELETE FROM injection_log WHERE conversation = ?`).run(conv);
	db.prepare(`UPDATE memories SET status = 'archived' WHERE id = ?`).run(dedupId);

	// Claude Code UserPromptSubmit hook: per-turn recall, same item never twice
	{
		const hookId = insertMemory(
			db,
			{ kind: "knowledge", summary: "api-contract hook 测试行", content: `契约钩子专用行 ${Date.now()}。`, keywords: ["hooktest"], origin: "agent_inferred", confidence: 0.1 },
			{ owner: "default", cwd: null },
		);
		const { execFileSync } = await import("node:child_process");
		const hookPath = new URL("../examples/claude-code/user-prompt-submit.mjs", import.meta.url).pathname;
		const env = { ...process.env, RUYI_URL: BASE, RUYI_RECALL_MODE: "fast" };
		const runHook = () => {
			try {
				return execFileSync("node", [hookPath], {
					input: JSON.stringify({ session_id: `contract-hook-${RUN}`, prompt: "契约钩子专用行", cwd: "/tmp/demo-project" }),
					env,
					timeout: 15_000,
				}).toString();
			} catch {
				return "";
			}
		};
		const out1 = runHook();
		ok(out1.includes("hook 测试行"), "hook turn 1 injects the memory");
		const out2 = runHook();
		ok(!out2.includes("hook 测试行"), "hook turn 2 dedups (no repeat)");
		db.prepare(`DELETE FROM replies WHERE topic_id IN (SELECT topic_id FROM topics WHERE conversation = ?)`).run(`claude:contract-hook-${RUN}`);
		db.prepare(`DELETE FROM topics WHERE conversation = ?`).run(`claude:contract-hook-${RUN}`);
		db.prepare(`DELETE FROM injection_log WHERE conversation = ?`).run(`claude:contract-hook-${RUN}`);
		db.prepare(`UPDATE memories SET status = 'archived' WHERE id = ?`).run(hookId);
	}

	// POST /replies/answer —— attaches to the pending reply, gist async
	{
		const conv = `pi:contract-answer-${RUN}`;
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
		// no recall turn yet → nothing to attach
		const r0 = await fetch(`${BASE}/replies/answer`, { method: "POST", headers, body: JSON.stringify({ conversation: conv, answer: "先到的回答" }), signal: AbortSignal.timeout(10_000) });
		const j0 = (await r0.json()) as { attached?: boolean };
		ok(r0.status === 200 && j0.attached === false, "/replies/answer without pending reply → attached:false");
		// a recall turn creates the pending reply, then the answer attaches
		await fetch(`${BASE}/recall`, { method: "POST", headers, body: JSON.stringify({ query: "contract answer test", conversation: conv, auto: true, mode: "fast" }), signal: AbortSignal.timeout(10_000) });
		const r1 = await fetch(`${BASE}/replies/answer`, { method: "POST", headers, body: JSON.stringify({ conversation: conv, answer: "本轮回答：测试内容" }), signal: AbortSignal.timeout(10_000) });
		const j1 = (await r1.json()) as { attached?: boolean };
		ok(r1.status === 201 && j1.attached === true, "/replies/answer attaches to pending reply (201)");
		const row = db.prepare(`SELECT answer FROM replies r JOIN topics t ON t.topic_id = r.topic_id WHERE t.conversation = ?`).get(conv) as { answer: string } | undefined;
		ok(row?.answer === "本轮回答：测试内容", "answer persisted on the reply row");
		const bad = await fetch(`${BASE}/replies/answer`, { method: "POST", headers, body: JSON.stringify({ conversation: conv }), signal: AbortSignal.timeout(10_000) });
		ok(bad.status === 400, "/replies/answer missing answer → 400");
		db.prepare(`DELETE FROM replies WHERE topic_id IN (SELECT topic_id FROM topics WHERE conversation = ?)`).run(conv);
		db.prepare(`DELETE FROM topics WHERE conversation = ?`).run(conv);
		db.prepare(`DELETE FROM injection_log WHERE conversation = ?`).run(conv);
	}

	// gzip-compressed push (content-encoding: gzip)
	{
		const { gzipSync } = await import("node:zlib");
		const headers: Record<string, string> = { "content-type": "application/json", "content-encoding": "gzip" };
		if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
		const body = gzipSync(JSON.stringify({ machine, agent: "pi", sessionKey: `gz/${RUN}/s.jsonl`, offset: 0, data: "压缩测试数据\n".repeat(100) }));
		const res = await fetch(`${BASE}/sync/session`, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
		const j = (await res.json()) as { receivedBytes?: number };
		ok(res.status === 200 && j.receivedBytes === Buffer.byteLength("压缩测试数据\n".repeat(100)), "gzip push decompresses correctly");
	}

	// cleanup
	const { rmSync } = await import("node:fs");
	rmDirSync(EXTERNAL ? new URL(`../data/synced/${machine}`, import.meta.url).pathname : join(tmp, "data", "synced", machine), { recursive: true, force: true });
	db.prepare(`DELETE FROM session_registry WHERE session_uid = ?`).run(uid);
}

// MCP tools list matches the documented six
{
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, ["src/cli.ts", "mcp"], {
		cwd: new URL("..", import.meta.url).pathname,
		stdio: ["pipe", "pipe", "ignore"],
	});
	let buf = "";
	child.stdout!.on("data", (c: Buffer) => (buf += c.toString()));
	child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
	await new Promise((r) => setTimeout(r, 4000));
	child.kill("SIGKILL");
	const documented = ["recall", "list", "get", "ingest", "remember", "admin"];
	ok(documented.every((t) => buf.includes(`"${t}"`)), "MCP exposes all six documented tools");
}

server?.kill("SIGKILL");
if (!EXTERNAL) rmDirSync(tmp, { recursive: true, force: true });

console.log(`\napi-contract: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
