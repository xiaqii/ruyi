/** inbox.ts — 原料收件箱：用户把大文件（zip/tar.gz/jsonl/txt/md）丢进 ~/ruyi-inbox，
 *  夜梦开始前自动 瘦身(纯程序) → 筛选(flash 只判留/丢) → kept 文本进入正常做梦管线(k3 提取)。
 *  原则:flash 永远不提取记忆(只做筛选);提取质量永远走 dream 层。
 *  断点:inbox_files 表按 (文件×镜片) 记录字符偏移,重传/续传/多镜片互不干扰。 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, openSync, readSync, closeSync } from "node:fs";
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

// ---------- 格式识别与解包（零依赖） ----------

/** 快速指纹:大小+mtime+首尾 64K 哈希（GB 级文件秒级完成;替换/追加都能识别） */
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

/** zip 顺序扫描 local headers——中央目录在文件尾,截断的 zip 也能救出完整部分 */
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
				// data descriptor: 用 inflate 流自终止找数据尾
				const chunk = data.subarray(start);
				// inflateRawSync 需要知道结束——用流式逐块试探不划算,直接尝试到文件尾
				const content = inflateRawSync(chunk, { finishFlush: 4 /* Z_SYNC_FLUSH 无效时抛 */ , maxOutputLength: 512 * 1024 * 1024 });
				out.push({ name, data: content });
				break; // descriptor 模式下无法可靠继续扫描,到此为止（截断场景已救出大头）
			}
			const raw = data.subarray(start, start + csize);
			if (raw.length < csize) break; // 文件体截断
			out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
			pos = start + csize;
		} catch { break; }
	}
	return out;
}

/** tar.gz = gunzip + 512 字节头 walk（ustar） */
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

// ---------- 瘦身（纯程序） ----------

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

/** 会话 jsonl（claude-code / pi 通用）→ 【用户】/【AI】对话流；思考、工具、代码全丢 */
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

/** 判断一段文本是不是会话 jsonl（采样前 50 行找消息行——文件头常是元信息行） */
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
	if (!/\.(jsonl|txt|md|log)$/.test(ext) && !ext.includes(".")) { /* 无扩展名也试 */ }
	else if (!/\.(jsonl|txt|md|log)$/.test(ext)) return null;
	const text = data.toString("utf8");
	if (looksLikeSessionJsonl(text)) {
		const slim = slimJsonl(text);
		return slim.length >= 50 ? { format: "session-jsonl", text: slim } : null;
	}
	const cleaned = cleanText(text);
	return cleaned.length >= 50 ? { format: "text", text: cleaned } : null;
}

// ---------- 收件箱主流程 ----------

export interface InboxReport {
	scanned: number;
	slimmed: number;
	windowsFiltered: number;
	windowsKept: number;
	budgetStopped: boolean;
	errors: string[];
}

/** 今天 inbox-filter 已花的人民币（token_log 按当日 step 聚合 × 单价表） */
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
		if (f.endsWith(".lens.md")) continue; // 镜片伴生文件不是原料
		const path = join(dir, f);
		if (!statSync(path).isFile()) continue;
		report.scanned++;
		const fp = fingerprint(path);
		const row = d.prepare("SELECT * FROM inbox_files WHERE path=?").get(f) as { content_hash: string; status: string } | undefined;
		if (row && row.content_hash === fp && row.status === "done") continue;
		insert.run(f, fp, "", statSync(path).size, now(), now());
	}

	// 逐文件处理 pending/slimmed
	const pending = d.prepare("SELECT * FROM inbox_files WHERE status IN ('pending','slimmed','filtering') ORDER BY id").all() as Array<{
		id: number; path: string; status: string; lens_offsets: string; filter_stats: string;
	}>;
	for (const row of pending) {
		const path = join(dir, row.path);
		if (!existsSync(path)) continue;
		try {
			// ① 瘦身（pending 状态才做）
			if (row.status === "pending") {
				const raw = readFileSync(path);
				let entries: UnpackedEntry[];
				if (raw.subarray(0, 2).toString("latin1") === "PK") entries = unpackZip(raw);
				else if (raw[0] === 0x1f && raw[1] === 0x8b) entries = unpackTarGz(raw);
				else entries = [{ name: row.path, data: raw }];
				const slimPath = join(slimDir, row.path.replace(/[^\w.-]+/g, "_") + ".slim.txt");
				let total = "";
				for (const e of entries) {
					const s = slimOne(e.name, e.data);
					if (s) total += `\n\n===== ${e.name} =====\n\n${s.text}`;
				}
				writeFileSync(slimPath, total.trim());
				d.prepare("UPDATE inbox_files SET status='slimmed', slim_chars=?, format=?, updated_at=? WHERE id=?")
					.run(total.length, "auto", now(), row.id);
				report.slimmed++;
				row.status = "slimmed";
				if (opts.verbose) console.log(`[inbox] slimmed ${row.path}: ${(statSync(path).size / 1e6).toFixed(1)}MB → ${(total.length / 1e3).toFixed(0)}K字`);
			}

			// ② 筛选（flash 判留/丢;镜片决定留什么）
			const slimPath = join(slimDir, row.path.replace(/[^\w.-]+/g, "_") + ".slim.txt");
			if (!existsSync(slimPath)) continue;
			const slimText = readFileSync(slimPath, "utf8");
			const lensFile = join(dir, row.path.replace(/\.[^.]+$/, "") + ".lens.md");
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
		return { keep: true }; // 筛选器故障时保守放行（宁多留不漏）
	}
}
