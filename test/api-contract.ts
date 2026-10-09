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

const BASE = (process.env.RUYI_URL ?? "http://127.0.0.1:8899").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? "";

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
	ok(status === 200 && json.ok === true && typeof json.active === "number", "GET /health shape");
}

// GET /inject
{
	const { status, json } = await call("GET", "/inject?owner=default&cwd=/root&scope=smart");
	const c = json.constitution as unknown[];
	const i = json.index as unknown[];
	const p = json.profileDirectory as unknown[];
	ok(status === 200 && Array.isArray(c) && Array.isArray(i) && Array.isArray(p), "/inject returns constitution+index+profileDirectory");
	if (c.length > 0) ok(has(c[0], ["id", "summary", "content"]), "constitution entry fields");
	if (i.length > 0) ok(has(i[0], ["id", "date", "kind", "summary"]), "index entry fields");
	if (p.length > 0) ok(has(p[0], ["id", "title", "maturity"]), "profileDirectory entry fields");
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
const config = loadConfig();
const db = getDb(config.dbPath);
const tmpId = insertMemory(
	db,
	{ kind: "knowledge", summary: "api-contract 测试行", content: "契约测试临时行，测完即归档。", keywords: ["apitest"], origin: "agent_inferred", confidence: 0.1 },
	{ owner: "default", cwd: null },
);
{
	const { status, json } = await call("GET", `/memories/${tmpId}`);
	ok(status === 200 && has(json.memory, MEMORY_ROW_FIELDS), "GET /memories/:id shape");
}
{
	const { json } = await call("POST", `/memories/${tmpId}/pin`, { pinned: 1 });
	ok(json.ok === true && json.pinned === 1, "pin shape");
	const { json: j2 } = await call("POST", `/memories/${tmpId}/pin`, { pinned: 0 });
	ok(j2.pinned === 0, "unpin shape");
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
	const machine = "contract-test";
	const r1 = await call("POST", "/sync/session", { machine, agent: "claude-code", sessionKey: "t/s.jsonl", offset: 0, data: '{"a":1}\n' });
	ok(r1.status === 200 && r1.json.receivedBytes === 8, "sync push first chunk", JSON.stringify(r1.json));
	const r2 = await call("POST", "/sync/session", { machine, agent: "claude-code", sessionKey: "t/s.jsonl", offset: 0, data: "X" });
	ok(r2.status === 409 && r2.json.receivedBytes === 8, "sync offset mismatch → 409 with true offset");
	const r3 = await call("POST", "/sync/session", { machine, agent: "claude-code", sessionKey: "t/s.jsonl", offset: 8, data: '{"b":2}\n' });
	ok(r3.status === 200 && r3.json.receivedBytes === 16, "sync resume at server offset");
	const r4 = await call("GET", `/sync/state?machine=${machine}`);
	ok(r4.status === 200 && (r4.json.sessions as Record<string, number>)["t/s.jsonl"] === 16, "sync state reports bytes");
	const r5 = await call("POST", "/sync/session", { machine: "../evil", agent: "x", sessionKey: "x", offset: 0, data: "x" });
	ok(r5.status === 400, "sync rejects path traversal");
	// cleanup
	const { rmSync } = await import("node:fs");
	rmSync(new URL("../data/synced/contract-test", import.meta.url).pathname, { recursive: true, force: true });
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

console.log(`\napi-contract: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
