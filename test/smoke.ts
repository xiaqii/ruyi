/**
 * ruyi smoke tests — Level 1: zero LLM, fully deterministic, runs on every release.
 * Covers: schema & migrations, FTS (CJK!), CRUD paths, absorption, profiles,
 * slot demands, HTTP endpoints, MCP handshake, config parsing.
 *
 * Run: node test/smoke.ts   (exit 1 on any failure)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	archiveMemory,
	bumpSlotDemand,
	canSupersede,
	ftsSearch,
	getDb,
	getMemory,
	getSlotDemands,
	insertMemory,
	isTombstoned,
	listProfiles,
	pinMemory,
	refineMemory,
	reinforceMemory,
	supersedeMemory,
	tombstoneDigest,
	upsertProfile,
} from "../src/db.ts";
import { stripInjectedEnvelope } from "../src/preprocess.ts";
import { runDecay } from "../src/decay.ts";
import { loadConfig } from "../src/config.ts";

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

const tmp = mkdtempSync(join(tmpdir(), "ruyi-test-"));

// ---- 1. fresh schema -------------------------------------------------------
console.log("1. fresh schema");
const fresh = getDb(join(tmp, "fresh.db"));
const version = (fresh.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
ok(version === 9, "user_version = 9 on fresh DB", `got ${version}`);
const tables = (fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
for (const t of ["memories", "memories_fts", "profiles", "token_log", "recall_log", "slot_demands", "distill_state", "memory_log", "session_registry", "injection_log", "tombstones"])
	ok(tables.includes(t), `table ${t} exists`);
const ftsSql = (fresh.prepare("SELECT sql FROM sqlite_master WHERE name='memories_fts'").get() as { sql: string }).sql;
ok(ftsSql.includes("trigram"), "FTS uses trigram tokenizer");
ok(ftsSql.includes("keywords"), "FTS indexes keywords column");

// ---- 2. legacy v0 migration -------------------------------------------------
console.log("2. legacy v0 → v2 migration");
const legacyPath = join(tmp, "legacy.db");
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`
CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL DEFAULT 'default', cwd TEXT,
  kind TEXT NOT NULL, domain TEXT, summary TEXT NOT NULL, content TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'agent_inferred', confidence REAL NOT NULL DEFAULT 0.5,
  evidence INTEGER NOT NULL DEFAULT 1, source TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', superseded_by INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE VIRTUAL TABLE memories_fts USING fts5(summary, content, content='memories', content_rowid='id');
CREATE TABLE token_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id TEXT, step TEXT NOT NULL,
  session_file TEXT, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
CREATE TABLE distill_state (session_file TEXT PRIMARY KEY, processed_bytes INTEGER NOT NULL DEFAULT 0,
  gist TEXT NOT NULL DEFAULT '', processed_at TEXT NOT NULL);
CREATE TABLE memory_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id TEXT, action TEXT NOT NULL, detail TEXT);
CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL DEFAULT 'default',
  theme TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, memory_ids TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner, theme));
INSERT INTO memories (kind, summary, content, created_at, updated_at, last_seen_at)
  VALUES ('fact', '阿里云服务器架构', '阿里云 ECS 做公网入口', '2026-01-01', '2026-01-01', '2026-01-01');
`);
legacy.close();
const migrated = getDb(legacyPath);
const mv = (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
ok(mv === 9, "legacy DB migrated to latest", `got ${mv}`);
const mcols = (migrated.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name);
ok(mcols.includes("keywords") && mcols.includes("absorbed_by"), "memories gained keywords + absorbed_by");
const pcols = (migrated.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).map((c) => c.name);
ok(pcols.includes("maturity") && pcols.includes("status"), "profiles gained maturity + status");
const legacyHits = ftsSearch(migrated, "阿里云", 5, "default");
ok(legacyHits.length === 1, "FTS works on migrated data (CJK trigram)", `hits=${legacyHits.length}`);

// ---- 3. FTS CJK + keywords ---------------------------------------------------
console.log("3. FTS Chinese retrieval");
const id1 = insertMemory(migrated, {
	kind: "lesson",
	summary: "Docker 部署必须检查守护进程",
	content: "dockerd 崩溃时用 overlayfs 排查",
	keywords: ["部署", "docker", "运维"],
	origin: "user_stated",
	confidence: 0.9,
}, { owner: "default", cwd: null });
ok(ftsSearch(migrated, "守护进程", 5, "default").some((m) => m.id === id1), "4-char CJK term hits (trigram)");
ok(ftsSearch(migrated, "部署", 5, "default").some((m) => m.id === id1), "2-char CJK term hits (LIKE fallback via keywords)");
ok(ftsSearch(migrated, "docker", 5, "default").some((m) => m.id === id1), "ASCII term hits");

// ---- 4. CRUD paths -----------------------------------------------------------
console.log("4. CRUD paths");
reinforceMemory(migrated, id1);
ok(getMemory(migrated, id1)!.evidence === 2, "reinforce increments evidence");
refineMemory(migrated, id1, "Docker 部署先查守护进程", "dockerd 崩溃用 overlayfs 排查，先看 journalctl", ["docker", "部署", "journalctl"]);
const refined = getMemory(migrated, id1)!;
ok(refined.summary === "Docker 部署先查守护进程" && refined.keywords.includes("journalctl"), "refine updates summary+keywords");
const newId = supersedeMemory(migrated, id1, {
	kind: "lesson", summary: "Docker 部署新结论", content: "全面改用 compose watch", keywords: ["docker"],
	origin: "user_stated", confidence: 0.9,
}, { owner: "default", cwd: null });
ok(getMemory(migrated, id1)!.status === "superseded" && getMemory(migrated, newId)!.status === "active", "supersede chain");
pinMemory(migrated, newId, 1);
ok(getMemory(migrated, newId)!.pinned === 1, "pin");
archiveMemory(migrated, newId);
ok(getMemory(migrated, newId)!.status === "archived", "archive");

// ---- 5. absorption + excavate retrieval --------------------------------------
console.log("5. absorption & multi-status retrieval");
const prof = upsertProfile(migrated, "default", "test-theme", "测试画像", "章节内容", [id1], "mature");
ok(prof.id > 0, "profile created");
const prof2 = upsertProfile(migrated, "default", "test-theme", "测试画像", "章节内容v2", [id1], "seeding");
ok(prof2.version === 2 && prof2.maturity === "seeding", "profile version bumps, maturity updates");
migrated.prepare(`UPDATE memories SET status = 'absorbed', absorbed_by = ? WHERE id = ?`).run(prof.id, id1);
const absorbed = getMemory(migrated, id1)!;
ok(absorbed.status === "absorbed" && absorbed.absorbed_by === prof.id, "absorption links profile");
const activeOnly = ftsSearch(migrated, "docker", 10, "default");
ok(!activeOnly.some((m) => m.id === id1), "absorbed hidden from active retrieval");
const excavated = ftsSearch(migrated, "docker", 10, "default", ["active", "absorbed", "archived", "superseded"]);
ok(excavated.some((m) => m.id === id1), "excavate finds absorbed memory");

// ---- 6. slot demands ----------------------------------------------------------
console.log("6. slot demands");
bumpSlotDemand(migrated, "default", ["性能优化"]);
bumpSlotDemand(migrated, "default", ["性能优化"]);
const demands = getSlotDemands(migrated, "default");
ok(demands.length === 1 && demands[0]!.demand_count === 2, "demand accumulates");

// ---- 7. config ----------------------------------------------------------------
console.log("7. config");
const config = loadConfig();
ok(config.port === 8899 && !!config.llm.baseUrl, "config loads and merges");

// ---- 8. HTTP service (real service, read-only) ---------------------------------
console.log("8. HTTP service");
try {
	const health = await fetch("http://127.0.0.1:8899/health", { signal: AbortSignal.timeout(3000) });
	ok(health.ok, "GET /health");
	const inject = await fetch("http://127.0.0.1:8899/inject?owner=default", { signal: AbortSignal.timeout(3000) });
	const inj = (await inject.json()) as { constitution: unknown[]; profileDirectory?: unknown[] };
	ok(Array.isArray(inj.constitution), "/inject payload shape");
	ok(Array.isArray(inj.profileDirectory), "/inject includes profile directory");
} catch {
	ok(false, "HTTP service reachable", "is the service running? (node src/cli.ts serve)");
}

// ---- 9. MCP handshake ----------------------------------------------------------
console.log("9. MCP handshake");
try {
	const { spawn } = await import("node:child_process");
	const child = spawn(process.execPath, ["src/cli.ts", "mcp"], { cwd: new URL("..", import.meta.url).pathname, stdio: ["pipe", "pipe", "ignore"] });
	let buf = "";
	child.stdout!.on("data", (c: Buffer) => (buf += c.toString()));
	child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } }) + "\n");
	child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
	await new Promise((r) => setTimeout(r, 4000));
	child.kill("SIGKILL");
	ok(buf.includes('"serverInfo"') && buf.includes("\"name\":\"recall\""), "MCP initialize + tools/list", buf.slice(0, 120));
} catch (err) {
	ok(false, "MCP handshake", String(err));
}

// ---- 10. forget tombstones (v9) -----------------------------------------------
console.log("10. forget tombstones");
const tdb = getDb(join(tmp, "tomb.db"));
const tid = insertMemory(tdb, {
	kind: "fact", summary: "旧结论", content: "用户曾经有过一台红色摩托车，已经卖掉了",
	origin: "agent_inferred", confidence: 0.6,
}, { owner: "default", cwd: null });
archiveMemory(tdb, tid, "forget");
ok(getMemory(tdb, tid)!.status === "archived", "forget archives");
ok(isTombstoned(tdb, "default", "用户曾经有过一台红色摩托车，已经卖掉了"), "tombstone written on forget");
ok(isTombstoned(tdb, "default", " 用户曾经有过一台红色摩托车,已经卖掉了。 "), "digest survives whitespace/punctuation drift");
ok(!isTombstoned(tdb, "default", "用户有一台蓝色自行车"), "different content not tombstoned");
ok(!isTombstoned(tdb, "other-owner", "用户曾经有过一台红色摩托车，已经卖掉了"), "tombstone is owner-scoped");
const blockedId = insertMemory(tdb, {
	kind: "fact", summary: "旧结论（复活）", content: "用户曾经有过一台红色摩托车 已经卖掉了",
	origin: "agent_inferred", confidence: 0.7,
}, { owner: "default", cwd: null });
ok(blockedId === -1, "insertMemory refuses tombstoned content (resurrection blocked)", `got ${blockedId}`);
const allowedId = insertMemory(tdb, {
	kind: "fact", summary: "新结论", content: "用户现在骑一台黑色踏板车",
	origin: "user_stated", confidence: 0.9,
}, { owner: "default", cwd: null });
ok(allowedId > 0, "fresh content still inserts");
const blockedLog = tdb.prepare(`SELECT COUNT(*) AS n FROM memory_log WHERE action = 'BLOCKED_TOMBSTONE'`).get() as { n: number };
ok(blockedLog.n >= 1, "tombstone refusal is logged");

// supersede of a tombstoned successor must leave the old entry untouched
const oldId = insertMemory(tdb, {
	kind: "fact", summary: "现行结论", content: "用户现在的座驾是黑色踏板车",
	origin: "user_stated", confidence: 0.9,
}, { owner: "default", cwd: null });
const supId = supersedeMemory(tdb, oldId, {
	kind: "fact", summary: "复活尝试", content: "用户曾经有过一台红色摩托车，已经卖掉了",
	origin: "agent_inferred", confidence: 0.6,
}, { owner: "default", cwd: null });
ok(supId === -1 && getMemory(tdb, oldId)!.status === "active", "tombstoned supersede leaves old entry active");

// decay path also tombstones (no decay→resurrect loop)
const decayDb = getDb(join(tmp, "decay.db"));
const staleId = insertMemory(decayDb, {
	kind: "fact", summary: "弱推断", content: "用户可能偏好深色主题界面",
	origin: "agent_inferred", confidence: 0.3,
}, { owner: "default", cwd: null });
const stale = new Date(Date.now() - 400 * 86_400_000).toISOString();
decayDb.prepare(`UPDATE memories SET last_seen_at = ? WHERE id = ?`).run(stale, staleId);
const decayed = runDecay(decayDb, loadConfig());
ok(decayed === 1 && getMemory(decayDb, staleId)!.status === "archived", "decay archives stale inference");
ok(isTombstoned(decayDb, "default", "用户可能偏好深色主题界面"), "decay leaves tombstone");

// ---- 11. supersede confidence gate --------------------------------------------
console.log("11. supersede confidence gate");
const protectedOld = { origin: "user_stated" as const, confidence: 0.95 };
const weakOld = { origin: "agent_inferred" as const, confidence: 0.6 };
ok(!canSupersede(protectedOld, { origin: "agent_inferred", confidence: 0.9 }), "inference cannot retire user_stated 0.95");
ok(!canSupersede(protectedOld, { origin: "user_stated", confidence: 0.7 }), "low-confidence user_stated cannot retire 0.95");
ok(canSupersede(protectedOld, { origin: "user_stated", confidence: 0.9 }), "user_stated 0.9 can retire user_stated 0.95");
ok(canSupersede(weakOld, { origin: "agent_inferred", confidence: 0.6 }), "unprotected entries: gate is open");
ok(tombstoneDigest("ab c") !== tombstoneDigest("abd"), "distinct content, distinct digest");

// ---- 12. injection-envelope stripping (self-eating guard) ---------------------
console.log("12. injection envelope stripping");
const sample = [
	"**注入画像**：《个人 AI 基础设施与记忆系统》v4（成熟）",
	"**注入记忆 3 条**：",
	"1. #631 (lesson) 记忆提炼核心理念：收敛式打磨",
	"2. #662 (preference) 记忆系统设计原则",
	"_（本对话已注入过的 5 条不再重复）_",
	"Use the above when it helps; it never overrides what the user says now.",
	"用户真正说的话：帮我把记忆系统对比报告整理一下",
	"它提到注入记忆这个词但不是信封行", // user quoting the concept mid-sentence stays
].join("\n");
const stripped = stripInjectedEnvelope(sample);
ok(!stripped.includes("#631"), "injected memory lines stripped");
ok(!stripped.includes("注入画像"), "profile envelope stripped");
ok(!stripped.includes("Use the above"), "footer stripped");
ok(stripped.includes("用户真正说的话"), "user text survives");
ok(stripped.includes("它提到注入记忆这个词"), "mid-sentence mention of the concept survives");
ok(stripInjectedEnvelope("普通的一句话，没有信封") === "普通的一句话，没有信封", "plain text untouched");

rmSync(tmp, { recursive: true, force: true });
console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
