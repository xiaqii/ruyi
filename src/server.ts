import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gunzipSync } from "node:zlib";
import { loadConfig } from "./config.ts";
import {
	archiveMemory,
	getDb,
	getMemory,
	getProfile,
	listMemories,
	listProfiles,
	memoryCounts,
	tokenUsage,
} from "./db.ts";
import type { Candidate } from "./types.ts";
import { runDream, distillText, explicitRemember } from "./distill.ts";
import { syncPush, syncState } from "./sync.ts";
import { getInject, recall } from "./recall.ts";
import { runSynthesize } from "./synthesize.ts";
import { landingPage } from "./landing.ts";

const MAX_BODY = 8 * 1024 * 1024; // compressed or plain
const MAX_BODY_GUNZIPPED = 32 * 1024 * 1024; // zip-bomb guard

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	let buf = Buffer.concat(chunks);
	if (req.headers["content-encoding"] === "gzip") {
		buf = gunzipSync(buf, { maxOutputLength: MAX_BODY_GUNZIPPED });
	}
	return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

function ownerOf(url: URL, body?: Record<string, unknown>): string {
	const fromBody = typeof body?.owner === "string" ? body.owner : null;
	return url.searchParams.get("owner") ?? fromBody ?? "default";
}

function cwdOf(url: URL, body?: Record<string, unknown>): string | null {
	const fromBody = typeof body?.cwd === "string" ? body.cwd : null;
	return url.searchParams.get("cwd") ?? fromBody ?? null;
}

function scopeOf(url: URL, body?: Record<string, unknown>): "smart" | "cwd" | "all" | undefined {
	const raw = url.searchParams.get("scope") ?? (typeof body?.scope === "string" ? body.scope : null);
	return raw === "cwd" || raw === "all" || raw === "smart" ? raw : undefined;
}

let dreamRunning = false;

export function startServer(): void {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	// Optional bearer auth — required when the service is reachable beyond localhost.
	const authToken = config.authToken ?? "";

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		try {
			// Landing: the service URL doubles as its own manual (no secrets inside).
			if (req.method === "GET" && path === "/") {
				const host = req.headers.host ?? "ruyi.local";
				const { body, contentType } = landingPage(host, (req.headers.accept ?? "").includes("text/html"));
				res.writeHead(200, { "content-type": contentType });
				return res.end(body);
			}

			if (req.method === "GET" && path === "/health") {
				return send(res, 200, { ok: true, ...memoryCounts(db) });
			}

			if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
				return send(res, 401, { error: "missing or invalid bearer token" });
			}

			if (req.method === "GET" && path === "/inject") {
				return send(res, 200, getInject(ownerOf(url), cwdOf(url), scopeOf(url) ?? "smart"));
			}

			if (req.method === "POST" && path === "/recall") {
				const body = await readBody(req);
				const query = typeof body.query === "string" ? body.query : "";
				if (!query.trim()) return send(res, 400, { error: "query is required" });
				const k = typeof body.k === "number" ? body.k : undefined;
				const mode = body.mode === "fast" || body.mode === "excavate" ? body.mode : "deep";
				const result = await recall(query, k, ownerOf(url, body), cwdOf(url, body), scopeOf(url, body), mode);
				return send(res, 200, result);
			}

			if (req.method === "GET" && path === "/memories") {
				const status = url.searchParams.get("status") ?? "active";
				const limit = Number(url.searchParams.get("limit") ?? "100");
				return send(res, 200, { memories: listMemories(db, { status, limit, owner: ownerOf(url) }) });
			}

			// Explicit write: conversation-independent entries (rules, specs, skill pointers).
			// Goes through the same LLM merge judgement as nightly distillation, so
			// repeated writes reinforce/refine instead of duplicating.
			if (req.method === "POST" && path === "/memories") {
				const body = await readBody(req);
				const summary = typeof body.summary === "string" ? body.summary.trim() : "";
				const content = typeof body.content === "string" ? body.content.trim() : "";
				const kind = typeof body.kind === "string" ? body.kind : "fact";
				if (!summary || !content) return send(res, 400, { error: "summary and content are required" });
				const owner = ownerOf(url, body);
				const scope = { owner, cwd: cwdOf(url, body) };
				const candidate: Candidate = {
					kind: kind as never,
					domain: typeof body.domain === "string" ? body.domain : undefined,
					summary,
					content,
					origin: "user_stated",
					confidence: typeof body.confidence === "number" ? body.confidence : 0.9,
				};

				const result = await explicitRemember(candidate, scope);
				return send(res, result.action === "new" || result.action === "superseded" ? 201 : 200, result);
			}

			const idMatch = path.match(/^\/memories\/(\d+)(\/(pin|forget))?$/);
			if (idMatch) {
				const id = Number(idMatch[1]);
				const sub = idMatch[3];
				if (req.method === "GET" && !sub) {
					const m = getMemory(db, id);
					return m ? send(res, 200, { memory: m }) : send(res, 404, { error: "not found" });
				}
				if (req.method === "POST" && sub === "pin") {
					const body = await readBody(req);
					const pinned = body.pinned === false || body.pinned === 0 ? 0 : 1;
					db.prepare(`UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?`).run(
						pinned,
						new Date().toISOString(),
						id,
					);
					return send(res, 200, { ok: true, id, pinned });
				}
				if (req.method === "POST" && sub === "forget") {
					archiveMemory(db, id);
					return send(res, 200, { ok: true, id, status: "archived" });
				}
			}

			// Generic ingestion: any agent submits raw conversation text,
			// ruyi runs the full distillation pipeline on it.
			if (req.method === "POST" && path === "/ingest") {
				const body = await readBody(req);
				const text = typeof body.text === "string" ? body.text.trim() : "";
				if (text.length < 50) return send(res, 400, { error: "text too short (min 50 chars)" });
				const source = typeof body.source === "string" ? body.source : "api-ingest";
				const result = await distillText(text, { owner: ownerOf(url, body), cwd: cwdOf(url, body) }, source);
				return send(res, 200, result);
			}

			if (req.method === "GET" && path === "/profiles") {
				return send(res, 200, { profiles: listProfiles(db, ownerOf(url)) });
			}

			const profileMatch = path.match(/^\/profiles\/(\d+)$/);
			if (req.method === "GET" && profileMatch) {
				const p = getProfile(db, Number(profileMatch[1]));
				return p && p.owner === ownerOf(url) ? send(res, 200, p) : send(res, 404, { error: "not found" });
			}

			if (req.method === "POST" && path === "/synthesize") {
				const body = await readBody(req);
				const report = await runSynthesize(ownerOf(url, body));
				return send(res, 200, report);
			}

			if (req.method === "POST" && path === "/distill") {
				if (dreamRunning) return send(res, 409, { error: "a dream run is already in progress" });
				dreamRunning = true;
				runDream()
					.catch(() => {})
					.finally(() => {
						dreamRunning = false;
					});
				return send(res, 202, { started: true });
			}

			// Session sync: remote machines push session-log deltas here for the nightly dream.
			if (req.method === "GET" && path === "/sync/state") {
				return send(res, 200, syncState(config, url.searchParams.get("machine") ?? ""));
			}
			if (req.method === "POST" && path === "/sync/session") {
				const body = (await readBody(req)) as unknown as Parameters<typeof syncPush>[1];
				const r = syncPush(config, body);
				if (!r.ok) return send(res, r.status, { error: r.error, receivedBytes: r.receivedBytes });
				return send(res, 200, r);
			}

			if (req.method === "GET" && path === "/stats") {
				const days = Number(url.searchParams.get("days") ?? "7");
				return send(res, 200, {
					counts: memoryCounts(db, url.searchParams.get("owner") ?? undefined),
					tokenUsage: tokenUsage(db, days),
				});
			}

			return send(res, 404, { error: "not found" });
		} catch (err) {
			return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
		}
	});

	server.listen(config.port, config.host, () => {
		console.log(`[ruyi] listening on http://${config.host}:${config.port}`);
	});
}
