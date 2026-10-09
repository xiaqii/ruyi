/**
 * Session sync layer — remote machines push their agent session logs here,
 * the nightly dream distills them. Design answers:
 *
 * - Incremental: offset-based append. Client sends only new bytes; server
 *   enforces offset continuity (409 + receivedBytes on mismatch → client resumes).
 * - Dedup: transport (offset), storage (append-once per machine/sessionKey),
 *   dream (distill_state byte offsets — each byte is LLM-processed at most once),
 *   memory (LLM merge turns duplicates into reinforcement).
 * - Machine identity: every byte lands under synced/<machine>/; the extract
 *   prompt mandates machine attribution for environment facts.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, normalize, basename } from "node:path";
import type { Config } from "./types.ts";
import { getDb, getDistillState, getSessionRegistry, setDistillState, upsertSessionRegistry } from "./db.ts";

export function syncRoot(config: Config): string {
	return join(dirname(config.dbPath), "synced");
}

/** Reject path tricks; keep only safe relative file names. */
function sanitize(name: string, allowSubdirs: boolean): string | null {
	if (!name || name.length > 200) return null;
	if (name.includes("..") || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) return null;
	if (!allowSubdirs && (name.includes("/") || name.includes("\\"))) return null;
	if (!/^[a-zA-Z0-9._\-/\\]+$/.test(name)) return null;
	return normalize(name).replace(/^[./\\]+/, "");
}

/**
 * Content-derived session identity. Same session = same uid no matter which
 * channel or path it arrives through — this is what makes cross-channel dedup
 * (manual import vs sync protocol) possible.
 */
export function extractSessionUid(agent: string, head: Buffer, filename: string): string {
	if (agent === "claude-code") {
		const firstLine = head.subarray(0, head.indexOf(10) > 0 ? head.indexOf(10) : undefined).toString("utf8");
		try {
			const sid = JSON.parse(firstLine).sessionId;
			if (typeof sid === "string" && sid.length >= 8) return sid;
		} catch {
			// fall through
		}
	}
	const stem = basename(filename).replace(/\.jsonl$/, "");
	if (stem.length >= 12) return stem; // pi filenames carry a uuid
	return createHash("sha256").update(head.subarray(0, 4096)).digest("hex").slice(0, 32);
}

export interface SyncPushBody {
	machine: string;
	agent: string;
	sessionKey: string;
	offset: number;
	data: string;
	sessionUid?: string;
	totalSize?: number;
}

export function syncPush(
	config: Config,
	body: SyncPushBody,
): { ok: true; receivedBytes: number; already?: boolean } | { ok: false; status: number; error: string; receivedBytes?: number } {
	const machine = sanitize(body.machine ?? "", false);
	const agent = sanitize(body.agent ?? "", false);
	const key = sanitize(body.sessionKey ?? "", true);
	const uid = body.sessionUid ? sanitize(body.sessionUid, false) : null;
	if (!machine || !agent || !key) return { ok: false, status: 400, error: "invalid machine/agent/sessionKey" };
	if (typeof body.offset !== "number" || body.offset < 0) return { ok: false, status: 400, error: "invalid offset" };
	if (typeof body.data !== "string") return { ok: false, status: 400, error: "data must be a string" };

	const dir = join(syncRoot(config), machine);
	mkdirSync(dir, { recursive: true });

	// remember which agent format this machine's logs use (dream reads this)
	const metaPath = join(dir, "_meta.json");
	if (!existsSync(metaPath)) writeFileSync(metaPath, JSON.stringify({ agent }), "utf8");

	let file = join(dir, key.endsWith(".jsonl") ? key : `${key}.jsonl`);

	if (uid) {
		const db = getDb(config.dbPath);
		const canonical = join(dir, `${uid}.jsonl`);
		const reg = getSessionRegistry(db, uid);
		if (!reg) {
			upsertSessionRegistry(db, uid, { agent, machine, path: canonical, bytes: 0 });
		} else if (reg.path !== canonical) {
			// This session is already known from another channel (e.g. a manual
			// import). Carry the head over so the canonical copy stays complete.
			if (!existsSync(canonical) && existsSync(reg.path)) copyFileSync(reg.path, canonical);
			// Seed the dream offset so the overlap is never distilled twice.
			const oldState = getDistillState(db, reg.path);
			if (oldState && !getDistillState(db, canonical)) {
				const size = existsSync(canonical) ? statSync(canonical).size : 0;
				setDistillState(db, canonical, Math.min(oldState.processed_bytes, size), `carried from ${reg.path}`);
			}
			upsertSessionRegistry(db, uid, { agent, machine, path: canonical, bytes: existsSync(canonical) ? statSync(canonical).size : 0 });
		}
		file = canonical;

		// Whole session already known and complete → nothing to do.
		const have = existsSync(file) ? statSync(file).size : 0;
		if (body.offset === 0 && have > 0 && typeof body.totalSize === "number" && have >= body.totalSize) {
			return { ok: true, receivedBytes: have, already: true };
		}
	}

	mkdirSync(dirname(file), { recursive: true });
	const current = existsSync(file) ? statSync(file).size : 0;
	if (body.offset !== current) {
		// offset mismatch: tell the client where to resume — never corrupt the log
		return { ok: false, status: 409, error: "offset mismatch", receivedBytes: current };
	}
	appendFileSync(file, body.data, "utf8");
	const receivedBytes = current + Buffer.byteLength(body.data, "utf8");
	if (uid) {
		upsertSessionRegistry(getDb(config.dbPath), uid, { agent, machine, path: file, bytes: receivedBytes });
	}
	return { ok: true, receivedBytes };
}

export function syncState(config: Config, machineRaw: string): { machine: string; sessions: Record<string, number> } {
	const machine = sanitize(machineRaw, false);
	const sessions: Record<string, number> = {};
	if (!machine) return { machine: machineRaw, sessions };
	const dir = join(syncRoot(config), machine);
	if (!existsSync(dir)) return { machine, sessions };
	const walk = (base: string, rel: string): void => {
		for (const e of readdirSync(join(base, rel), { withFileTypes: true })) {
			const r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(base, r);
			else if (e.name.endsWith(".jsonl")) sessions[r] = statSync(join(base, r)).size;
		}
	};
	walk(dir, "");
	return { machine, sessions };
}

/** Extra session sources for the dream: every synced machine dir. */
export function syncedSessionDirs(config: Config): { agent: string; dir: string; owner: string }[] {
	const root = syncRoot(config);
	if (!existsSync(root)) return [];
	const out: { agent: string; dir: string; owner: string }[] = [];
	for (const e of readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const dir = join(root, e.name);
		let agent = "pi";
		try {
			agent = JSON.parse(readFileSync(join(dir, "_meta.json"), "utf8")).agent ?? "pi";
		} catch {
			continue; // no meta = not a machine inbox
		}
		out.push({ agent, dir, owner: "default" });
	}
	return out;
}
