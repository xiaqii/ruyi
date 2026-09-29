import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.ts";
import { archiveMemory, getDb, getMemory, listMemories, memoryCounts, tokenUsage } from "./db.ts";
import { runDream } from "./distill.ts";
import { getInject, recall } from "./recall.ts";

const MAX_BODY = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, data: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(data));
}

function ownerOf(url: URL, body?: Record<string, unknown>): string {
	const fromBody = typeof body?.owner === "string" ? body.owner : null;
	return url.searchParams.get("owner") ?? fromBody ?? "default";
}

let dreamRunning = false;

export function startServer(): void {
	const config = loadConfig();
	const db = getDb(config.dbPath);

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		try {
			if (req.method === "GET" && path === "/health") {
				return send(res, 200, { ok: true, ...memoryCounts(db) });
			}

			if (req.method === "GET" && path === "/inject") {
				return send(res, 200, getInject(ownerOf(url)));
			}

			if (req.method === "POST" && path === "/recall") {
				const body = await readBody(req);
				const query = typeof body.query === "string" ? body.query : "";
				if (!query.trim()) return send(res, 400, { error: "query is required" });
				const k = typeof body.k === "number" ? body.k : undefined;
				const memories = await recall(query, k, ownerOf(url, body));
				return send(res, 200, { memories });
			}

			if (req.method === "GET" && path === "/memories") {
				const status = url.searchParams.get("status") ?? "active";
				const limit = Number(url.searchParams.get("limit") ?? "100");
				return send(res, 200, { memories: listMemories(db, { status, limit, owner: ownerOf(url) }) });
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
