/** inbox.ts — raw-material intake: drop big files (zip/tar.gz/jsonl/txt/md) into <state>/inbox (default ~/ruyi/inbox);
 *  before each dream run: slim (pure code) → filter (flash keep/drop only) → kept text joins
 *  the normal dream pipeline (k3 extraction). Principle: flash NEVER extracts memories — it
 *  only filters; extraction quality always lives in the dream tier.
 *  Resume: inbox_files records per-(file×lens) char offsets; re-drops/lenses don't interfere.
 *  Dialogue guard: ruyi extracts from conversations — text with no speaker structure (books,
 *  notes) is skipped unless the user opts in with an explicit .lens.md. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, openSync, readSync, writeSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { inflateRawSync, gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig, STATE_ROOT } from "./config.ts";

/** Where filtered "kept" text lives — registered as a text session source for the dream. */
export function inboxKeptDir(): string {
	return join(STATE_ROOT, "inbox-kept");
}
import { complete } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import { now, getDb } from "./db.ts";

// ---------- format detection & unpacking (zero deps) ----------

/** Fast fingerprint: size + mtime + head/tail 64K hash — seconds even for GB files; catches both replacement and appends. */
function fingerprint(path: string): string {
	const st = statSync(path);
	const h = createHash("sha256").update(String(st.size)).update(String(st.mtimeMs));
	const fd = openSync(path, "r");
	const buf = Buffer.alloc(65536);
	const head = readSync(fd, buf, 0, 65536, 0);
	h.update(buf.subarray(0, head));
	if (st.size > 65536) {
		const tail = readSync(fd, buf, 0, 65536, Math.max(0, st.size - 65536));
		h.update(buf.subarray(0, tail));
	}
	closeSync(fd);
	return h.digest("hex").slice(0, 16);
}

interface UnpackedEntry { name: string; data: Buffer }

/** zip: scan local headers sequentially — the central directory lives at the tail, so a truncated zip still yields its intact prefix. */
export function unpackZip(data: Buffer): UnpackedEntry[] {
	const out: UnpackedEntry[] = [];
	let pos = 0;
	while (pos + 30 <= data.length) {
		if (data.readUInt32LE(pos) !== 0x04034b50) {
			const nxt = data.indexOf(Buffer.from([0x50,0x4b,0x03,0x04]), pos + 1);
			if (nxt === -1) break;
			pos = nxt; continue;
		}
		const flag = data.readUInt16LE(pos + 6);
		const method = data.readUInt16LE(pos + 8);
		const csize = data.readUInt32LE(pos + 18);
		const nlen = data.readUInt16LE(pos + 26);
		const elen = data.readUInt16LE(pos + 28);
		const name = data.subarray(pos + 30, pos + 30 + nlen).toString("utf8");
		const start = pos + 30 + nlen + elen;
		try {
			if (flag & 0x08) {
				// data descriptor: the inflate stream self-terminates at the data end
				const chunk = data.subarray(start);
				// inflateRawSync needs an end; probing chunk-by-chunk isn't worth it — just try to EOF
				const content = inflateRawSync(chunk, { finishFlush: 4 /* throws when Z_SYNC_FLUSH can't end it */ , maxOutputLength: 512 * 1024 * 1024 });
				out.push({ name, data: content });
				break; // can't reliably resync after a descriptor entry — stop (truncated zips already salvaged the bulk)
			}
			const raw = data.subarray(start, start + csize);
			if (raw.length < csize) break; // file body truncated
			out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
			pos = start + csize;
		} catch { break; }
	}
	return out;
}

/** tar.gz = gunzip + 512-byte header walk (ustar) */
export function unpackTarGz(data: Buffer): UnpackedEntry[] {
	const tar = gunzipSync(data, { maxOutputLength: 4 * 1024 * 1024 * 1024 });
	const out: UnpackedEntry[] = [];
	let pos = 0;
	while (pos + 512 <= tar.length) {
		const name = tar.subarray(pos, pos + 100).toString("utf8").replace(/\0.*$/, "");
		if (!name) break;
		const size = parseInt(tar.subarray(pos + 124, pos + 136).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
		const type = tar.subarray(pos + 156, pos + 157).toString("utf8");
		pos += 512;
		if (type === "0" || type === "") {
			out.push({ name, data: tar.subarray(pos, pos + size) });
		}
		pos += Math.ceil(size / 512) * 512;
	}
	return out;
}

// ---------- slimming (pure code) ----------

const B64_RE = /data:image\/[a-zA-Z0-9+]+;base64,[A-Za-z0-9+/=\s]{200,}/g;
const CODE_RE = /```[a-zA-Z]*\n[\s\S]*?```/g;

function cleanText(t: string): string {
	return t.replace(B64_RE, "[图片]").replace(CODE_RE, "[代码块]").trim();
}

interface JsonlEntry {
	type?: string;
	isSidechain?: boolean;
	parentUuid?: string | null;
	message?: { role?: string; content?: unknown };
	role?: string;
	content?: unknown;
}

function extractTexts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const b of content) {
		if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
			out.push(String((b as { text?: string }).text ?? ""));
		}
	}
	return out;
}

/** Session jsonl (claude-code / pi) → 【用户】/【AI】 dialogue stream; thinking, tools, code all dropped. */
/** Line-by-line over a Buffer — never materializes the whole file as one string
 *  (Node caps strings at ~512MB; real CC session logs reach 800MB each). */
function* iterLines(buf: Buffer): Generator<string> {
	let start = 0;
	while (start < buf.length) {
		let nl = buf.indexOf(0x0a, start);
		if (nl === -1) nl = buf.length;
		yield buf.subarray(start, nl).toString("utf8");
		start = nl + 1;
	}
}

function slimJsonl(text: string): string {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let j: JsonlEntry;
		try { j = JSON.parse(line); } catch { continue; }
		const m = j.message ?? j;
		const role = m.role ?? (j.type === "user" || j.type === "assistant" ? j.type : undefined);
		if (role !== "user" && role !== "assistant") continue;
		const body = cleanText(extractTexts(m.content).join("\n"));
		if (body.length < 2) continue;
		if (body.startsWith("<command-") || body.startsWith("<local-command")) continue;
		out.push(`【${role === "user" ? "用户" : "AI"}】${body}`);
	}
	return out.join("\n\n");
}

/** Buffer variant of slimJsonl for huge entries. */
function slimJsonlBuffer(buf: Buffer): string {
	const out: string[] = [];
	for (const line of iterLines(buf)) {
		if (!line.trim()) continue;
		let j: JsonlEntry;
		try { j = JSON.parse(line); } catch { continue; }
		const m = j.message ?? j;
		const role = m.role ?? (j.type === "user" || j.type === "assistant" ? j.type : undefined);
		if (role !== "user" && role !== "assistant") continue;
		const body = cleanText(extractTexts(m.content).join("\n"));
		if (body.length < 2) continue;
		if (body.startsWith("<command-") || body.startsWith("<local-command")) continue;
		out.push(`【${role === "user" ? "用户" : "AI"}】${body}`);
	}
	return out.join("\n\n");
}

/** Is this text a session jsonl? Sample the first 50 lines for a message line — headers are often metadata lines. */
function looksLikeSessionJsonlBuf(buf: Buffer): boolean {
	return looksLikeSessionJsonl(buf.subarray(0, 65536).toString("utf8"));
}

function looksLikeSessionJsonl(text: string): boolean {
	let checked = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (checked++ > 50) break;
		try {
			const j = JSON.parse(line) as JsonlEntry;
			if (j && typeof j === "object" && (("parentUuid" in j && j.message) || (j.type === "message" && j.message))) return true;
		} catch { /* not json */ }
	}
	return false;
}

function slimOne(name: string, data: Buffer): { format: string; text: string } | null {
	const ext = name.toLowerCase();
	if (!/\.(jsonl|txt|md|log)$/.test(ext) && !ext.includes(".")) { /* extensionless files get a try too */ }
	else if (!/\.(jsonl|txt|md|log)$/.test(ext)) return null;
	if (looksLikeSessionJsonlBuf(data)) {
		const slim = slimJsonlBuffer(data);
		return slim.length >= 50 ? { format: "session-jsonl", text: slim } : null;
	}
	const cleaned = cleanText(data.toString("utf8"));
	return cleaned.length >= 50 ? { format: "text", text: cleaned } : null;
}

// ---------- inbox main flow ----------

export interface InboxReport {
	scanned: number;
	slimmed: number;
	windowsFiltered: number;
	windowsKept: number;
	budgetStopped: boolean;
	errors: string[];
}

/** CNY spent on inbox-filter today (token_log aggregated by step × price table). */
function spentTodayCny(d: DatabaseSync, pricePerMIn: number, pricePerMOut: number): number {
	const day = now().slice(0, 10);
	const row = d.prepare(
		"SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM token_log WHERE step='inbox-filter' AND at>=?"
	).get(day) as { i: number; o: number } | undefined;
	return ((row?.i ?? 0) * pricePerMIn + (row?.o ?? 0) * pricePerMOut) / 1e6;
}

export async function runInbox(opts: { verbose?: boolean } = {}): Promise<InboxReport> {
	const config = loadConfig();
	const dir = config.inbox.dir;
	const report: InboxReport = { scanned: 0, slimmed: 0, windowsFiltered: 0, windowsKept: 0, budgetStopped: false, errors: [] };
	if (!existsSync(dir)) return report;
	const d = getDb(config.dbPath);
	const slimDir = join(STATE_ROOT, "inbox-slim");
	const keptDir = inboxKeptDir();
	mkdirSync(slimDir, { recursive: true });
	mkdirSync(keptDir, { recursive: true });
	const insert = d.prepare(
		`INSERT INTO inbox_files (path, content_hash, format, raw_bytes, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'pending', ?, ?)
		 ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, raw_bytes=excluded.raw_bytes,
		 status=CASE WHEN inbox_files.content_hash!=excluded.content_hash THEN 'pending' ELSE inbox_files.status END, updated_at=excluded.updated_at`
	);

	for (const f of readdirSync(dir)) {
		if (f.endsWith(".lens.md")) continue; // lens sidecars are not raw material
		const path = join(dir, f);
		if (!statSync(path).isFile()) continue;
		report.scanned++;
		const fp = fingerprint(path);
		const row = d.prepare("SELECT * FROM inbox_files WHERE path=?").get(f) as { content_hash: string; status: string } | undefined;
		if (row && row.content_hash === fp && row.status === "done") continue;
		insert.run(f, fp, "", statSync(path).size, now(), now());
	}

	// process pending/slimmed files one by one ('skipped' is re-checked every run: adding a
	// .lens.md later revives a skipped book — the opt-in must not be a one-way door)
	const pending = d.prepare("SELECT * FROM inbox_files WHERE status IN ('pending','slimmed','filtering','skipped') ORDER BY id").all() as Array<{
		id: number; path: string; status: string; lens_offsets: string; filter_stats: string;
	}>;
	for (const row of pending) {
		const path = join(dir, row.path);
		if (!existsSync(path)) continue;
		try {
			// A skipped file without a lens stays skipped (cheap no-op until a lens appears).
			if (row.status === "skipped" && !existsSync(join(dir, row.path.replace(/\.[^.]+$/, "") + ".lens.md"))) continue;
			if (row.status === "skipped") {
				d.prepare("UPDATE inbox_files SET status='slimmed', updated_at=? WHERE id=?").run(now(), row.id);
				row.status = "slimmed";
			}
			// ① slim (deterministic, zero LLM)
			if (row.status === "pending") {
				const raw = readFileSync(path);
				let entries: UnpackedEntry[];
				if (raw.subarray(0, 2).toString("latin1") === "PK") entries = unpackZip(raw);
				else if (raw[0] === 0x1f && raw[1] === 0x8b) entries = unpackTarGz(raw);
				else entries = [{ name: row.path, data: raw }];
				const slimPath = join(slimDir, row.path.replace(/[^\w.-]+/g, "_") + ".slim.txt");
				// Stream to disk chunk by chunk: accumulating one giant string dies at
				// Node's ~512MB string limit on multi-GB archives (real: 1.3GB zip).
				const fd = openSync(slimPath, "w");
				let totalLen = 0;
				try {
					for (const e of entries) {
						const s = slimOne(e.name, e.data);
						if (!s) continue;
						const chunk = `\n\n===== ${e.name} =====\n\n${s.text}`;
						writeSync(fd, chunk);
						totalLen += chunk.length;
					}
				} finally {
					closeSync(fd);
				}
				d.prepare("UPDATE inbox_files SET status='slimmed', slim_chars=?, format=?, updated_at=? WHERE id=?")
					.run(totalLen, "auto", now(), row.id);
				report.slimmed++;
				row.status = "slimmed";
				if (opts.verbose) console.log(`[inbox] slimmed ${row.path}: ${(statSync(path).size / 1e6).toFixed(1)}MB → ${(totalLen / 1e3).toFixed(0)}K chars`);
			}

			// ② filter (flash keep/drop; lenses decide what passes)
			const slimPath = join(slimDir, row.path.replace(/[^\w.-]+/g, "_") + ".slim.txt");
			if (!existsSync(slimPath)) continue;
			const slimText = readFileSync(slimPath, "utf8");
			const lensFile = join(dir, row.path.replace(/\.[^.]+$/, "") + ".lens.md");
			// Dialogue guard: ruyi distills the USER — speaker turns are the authority signal.
			// Books/notes have no speakers; letting them through would file external knowledge as
			// personal memory and break convergence. Explicit .lens.md = user opted in (e.g.
			// a lens of "keep only my margin notes").
			const hasDialogue = /【(?:用户|AI)】|^(?:User|Human|Assistant)\s*[:：]/m.test(slimText);
			if (!hasDialogue && !existsSync(lensFile)) {
				d.prepare("UPDATE inbox_files SET status='skipped', error=?, updated_at=? WHERE id=?")
					.run("no dialogue structure — ruyi extracts from conversations; books/notes need an explicit .lens.md to be processed", now(), row.id);
				report.errors.push(row.path + ": skipped (no dialogue structure)");
				if (opts.verbose) console.log(`[inbox] skipped ${row.path}: no dialogue structure (books need a .lens.md)`);
				continue;
			}
			const lenses = existsSync(lensFile)
				? readFileSync(lensFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
				: ["default"];
			const offsets = JSON.parse(row.lens_offsets || "{}") as Record<string, number>;
			const stats = JSON.parse(row.filter_stats || "{}") as Record<string, number>;
			const price = config.inbox.prices["qwen3.7-flash"] ?? [0.2, 0.8];
			const basePrompt = loadPrompt("inbox-filter");

			let allDone = true;
			for (const lens of lenses) {
				let off = offsets[lens] ?? 0;
				if (off >= slimText.length) continue;
				const keptPath = join(keptDir, row.path.replace(/[^\w.-]+/g, "_") + `--${lens === "default" ? "默认" : createHash("md5").update(lens).digest("hex").slice(0, 8)}.txt`);
				const lensNote = lens === "default" ? "" : `\n\n本轮只保留与以下视角相关的片段：${lens}`;
				let consumed = 0;
				while (off < slimText.length) {
					if (spentTodayCny(d, price[0], price[1]) >= config.inbox.dailyBudgetCny) {
						report.budgetStopped = true; allDone = false; break;
					}
					if (consumed >= config.inbox.nightlyFilterChars) { allDone = false; break; }
					const win = slimText.slice(off, off + config.inbox.windowChars);
					if (win.trim().length < 200) { off += win.length; continue; }
					const r = await completeSafe(basePrompt + lensNote, win);
					report.windowsFiltered++;
					stats.windows = (stats.windows ?? 0) + 1;
					if (r?.keep === true) {
						appendFileSync(keptPath, win + "\n\n");
						report.windowsKept++;
						stats.kept = (stats.kept ?? 0) + 1;
					}
					off += win.length;
					consumed += win.length;
				}
				offsets[lens] = off;
				if (off < slimText.length) allDone = false;
			}
			d.prepare("UPDATE inbox_files SET status=?, lens_offsets=?, filter_stats=?, updated_at=? WHERE id=?")
				.run(allDone ? "done" : "filtering", JSON.stringify(offsets), JSON.stringify(stats), now(), row.id);
		} catch (e) {
			report.errors.push(`${row.path}: ${String(e).slice(0, 200)}`);
			d.prepare("UPDATE inbox_files SET status='error', error=?, updated_at=? WHERE id=?")
				.run(String(e).slice(0, 500), now(), row.id);
		}
	}
	return report;
}

async function completeSafe(system: string, user: string): Promise<{ keep?: boolean } | null> {
	try {
		const r = await complete({ system, user, step: "inbox-filter", maxTokens: 400 });
		return JSON.parse(r.text) as { keep?: boolean };
	} catch {
		return { keep: true }; // filter failure errs toward keeping (a miss is forever, extra cost isn't)
	}
}
