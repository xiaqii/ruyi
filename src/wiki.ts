/** wiki.ts — domain book libraries: the pull-based companion to ruyi's push-based memory.
 *  Memory answers "who is this person"; the wiki answers "what does the book say".
 *  Nothing here is ever injected into context by ruyi — agents call ruyi_wiki_ask when a
 *  task needs the books, get a distilled answer with exact quotes, and move on.
 *
 *  Layout: one SQLite file per domain under STATE_ROOT/wiki/ (tcm.db, programming.db, …).
 *  Fully decoupled from the memory store: separate files, separate schema, lazy-loaded.
 *
 *  Query = 3-level drill-down, all on the cheap recall tier (flash, thinking off):
 *    book cards (question-oriented) → chapter minis → exact passages.
 *  Ingest = strong model (dream tier by default): summaries are the foundation — they
 *  must be right the first time, because every future lookup stands on them. */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { STATE_ROOT } from "./config.ts";
import { complete } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import { now } from "./db.ts";

export function wikiDir(): string {
	const d = join(STATE_ROOT, "wiki");
	mkdirSync(d, { recursive: true });
	return d;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS books (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	author TEXT NOT NULL DEFAULT '',
	card TEXT NOT NULL DEFAULT '',
	chapters INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	book_id INTEGER NOT NULL REFERENCES books(id),
	ord INTEGER NOT NULL,
	title TEXT NOT NULL,
	mini TEXT NOT NULL DEFAULT '',
	keywords TEXT NOT NULL DEFAULT '',
	text TEXT NOT NULL,
	chars INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sections_book ON sections(book_id, ord);
`;

const dbs = new Map<string, DatabaseSync>();
export function wikiDb(library: string): DatabaseSync {
	if (!/^[a-z0-9_-]{1,40}$/i.test(library)) throw new Error(`bad library name: ${library}`);
	let db = dbs.get(library);
	if (!db) {
		db = new DatabaseSync(join(wikiDir(), library + ".db"));
		db.exec(SCHEMA);
		db.exec("DROP TABLE IF EXISTS sections_fts"); // entity lane retired: keywords ride the flash listing instead
		// keywords column for dbs created before it existed
		const cols = (db.prepare("PRAGMA table_info(sections)").all() as Array<{ name: string }>).map((c) => c.name);
		if (!cols.includes("keywords")) db.exec("ALTER TABLE sections ADD COLUMN keywords TEXT NOT NULL DEFAULT ''");
		dbs.set(library, db);
	}
	return db;
}

export function listLibraries(): string[] {
	if (!existsSync(wikiDir())) return [];
	return readdirSync(wikiDir()).filter((f) => f.endsWith(".db")).map((f) => f.slice(0, -3));
}

/** LLM call that must return JSON; tolerant of code fences and prose around it. */
async function llmJson(step: string, system: string, user: string, maxTokens = 600): Promise<Record<string, unknown>> {
	const r = await complete({ system, user, step, maxTokens });
	const m = r.text.match(/\{[\s\S]*\}/);
	if (!m) throw new Error(`${step}: no JSON in reply`);
	return JSON.parse(m[0]) as Record<string, unknown>;
}

// ---------- ingest (strong model; summaries are the foundation) ----------

export interface WikiIngestReport {
	bookId: number;
	chapters: number;
	summarized: number;
	card: string;
}

/** Ingest a directory of chapter .txt files (manifest.json preferred) as one book,
 *  then write chapter minis + the question-oriented book card. Resumable: chapters
 *  that already have a mini are skipped on re-run. */
export async function wikiIngest(opts: {
	library: string;
	title: string;
	author?: string;
	dir: string;
	verbose?: boolean;
}): Promise<WikiIngestReport> {
	const db = wikiDb(opts.library);
	const manifestPath = join(opts.dir, "manifest.json");
	const chapters: { file: string; title: string }[] = existsSync(manifestPath)
		? (JSON.parse(readFileSync(manifestPath, "utf8")) as Array<{ file: string; title: string }>).map((m) => ({ file: m.file, title: m.title }))
		: readdirSync(opts.dir).filter((f) => f.endsWith(".txt")).sort().map((f) => ({ file: f, title: f.replace(/^\d+_?/, "").replace(/\.txt$/, "") }));
	if (chapters.length === 0) throw new Error(`no chapters found in ${opts.dir}`);

	const run = db
		.prepare("INSERT INTO books (title, author, chapters, created_at) VALUES (?,?,?,?)")
		.run(opts.title, opts.author ?? "", chapters.length, now());
	const bookId = Number(run.lastInsertRowid);
	const ins = db.prepare("INSERT INTO sections (book_id, ord, title, text, chars) VALUES (?,?,?,?,?)");
	for (let i = 0; i < chapters.length; i++) {
		const ch = chapters[i]!;
		const text = readFileSync(join(opts.dir, ch.file), "utf8").trim();
		ins.run(bookId, i + 1, ch.title, text, text.length);
	}
	if (opts.verbose) console.log(`[wiki] stored ${chapters.length} chapters as book #${bookId} in ${opts.library}.db`);

	const { summarized, card } = await wikiSummarizeBook(opts.library, bookId, opts.verbose);
	return { bookId, chapters: chapters.length, summarized, card };
}

/** (Re)write missing chapter minis and the book card for one book. Exported so a
 *  failed ingest can be resumed without re-storing the text. */
export async function wikiSummarizeBook(
	library: string,
	bookId: number,
	verbose?: boolean,
): Promise<{ summarized: number; card: string }> {
	const db = wikiDb(library);
	const sections = db
		.prepare("SELECT id, ord, title, mini, keywords, text FROM sections WHERE book_id=? ORDER BY ord")
		.all(bookId) as Array<{ id: number; ord: number; title: string; mini: string; keywords: string; text: string }>;
	const upd = db.prepare("UPDATE sections SET mini=?, keywords=? WHERE id=?");
	const sysSection = loadPrompt("wiki-ingest-section");
	let summarized = 0;
	for (const s of sections) {
		if (s.mini && (s as { keywords?: string }).keywords) continue;
		try {
			const r = await llmJson("wiki-ingest", sysSection, `章节标题：${s.title}\n\n原文：\n${s.text}`, 600);
			const mini = String(r.mini ?? "").trim().slice(0, 100);
			const kw = (Array.isArray(r.keywords) ? r.keywords : []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20).join(" ");
			if (!mini) throw new Error("empty mini");
			upd.run(mini, kw, s.id);
			s.mini = mini;
			summarized++;
			if (verbose) console.log(`[wiki]   §${s.ord} ${s.title} → ${mini}${kw ? " 【" + kw + "】" : ""}`);
		} catch (e) {
			// One bad chapter must not kill a 112-chapter run — leave it for the next pass.
			if (verbose) console.warn(`[wiki]   §${s.ord} ${s.title} FAILED: ${String(e).slice(0, 100)}`);
		}
	}
	const book = db.prepare("SELECT title, author FROM books WHERE id=?").get(bookId) as { title: string; author: string };
	const listing = sections.map((s) => `${s.ord}. ${s.title} — ${s.mini}`).join("\n");
	const r = await llmJson("wiki-ingest", loadPrompt("wiki-ingest-book"), `书名：《${book.title}》${book.author ? ` 作者：${book.author}` : ""}\n\n章节定位句：\n${listing}`, 400);
	const card = String(r.card ?? "").trim().slice(0, 200);
	db.prepare("UPDATE books SET card=? WHERE id=?").run(card, bookId);
	if (verbose) console.log(`[wiki] book card: ${card}`);
	return { summarized, card };
}

// ---------- query (3-level drill-down, all flash) ----------

interface BookRow { id: number; title: string; author: string; card: string; library: string }
interface SectionRow { id: number; ord: number; title: string; mini: string; keywords: string; text?: string }

const MAX_SECTIONS = 5;
const MAX_ANSWER_CHARS = 60_000; // total source text fed to the answer step

export async function wikiAsk(opts: { question: string; library?: string; deep?: boolean }): Promise<string> {
	const libs = opts.library ? [opts.library] : listLibraries();
	const books: BookRow[] = [];
	for (const lib of libs) {
		try {
			const rows = wikiDb(lib).prepare("SELECT id, title, author, card FROM books").all() as Array<Omit<BookRow, "library">>;
			for (const r of rows) books.push({ ...r, library: lib });
		} catch {
			// a broken library db must not break the others
		}
	}
	if (books.length === 0) return "(wiki is empty — no books ingested yet)";

	// L1: which books? (up to 3, search-engine style — different angles all count)
	const bookList = books.map((b) => `[${b.library}#${b.id}] 《${b.title}》${b.author ? `（${b.author}）` : ""}：${b.card}`).join("\n");
	const p1 = await llmJson("wiki-pick", loadPrompt("wiki-pick-book"), `问题：${opts.question}\n\n藏书：\n${bookList}`);
	const rawList = Array.isArray(p1.books) ? (p1.books as Array<Record<string, unknown>>) : [];
	const chosen: BookRow[] = [];
	for (const item of rawList.slice(0, 3)) {
		const id = Number(item.id);
		const libGuess = /^([a-z0-9_-]+)/i.exec(String(item.library ?? ""))?.[1] ?? "";
		const byId = Number.isInteger(id) && id > 0 ? books.filter((b) => b.id === id) : [];
		const b = byId.find((x) => x.library === libGuess) ?? (byId.length === 1 ? byId[0] : undefined);
		if (b && !chosen.includes(b)) chosen.push(b);
	}
	if (chosen.length === 0) return `(没有哪本书适合回答这个问题${p1.reason ? "；馆员理由：" + String(p1.reason) : ""})`;

	// L2+L3 per book, in parallel. quick: one short answer per book. deep: one merged
	// distilled answer over all books' passages (synthesis IS the point of deep).
	const perBook = await Promise.all(chosen.map((b) => askOneBook(b, opts.question, opts.deep === true)));
	const hit = perBook.filter((r) => r !== null) as Array<NonNullable<(typeof perBook)[number]>>;
	if (hit.length === 0) return `选出的书里没有定位到相关章节（${chosen.map((b) => `《${b.title}》`).join("、")}）`;

	if (opts.deep) {
		const source = hit
			.map((h) => h.sections.map((s) => `【${h.book.title} · ${s.title}】\n${s.text}`).join("\n\n"))
			.join("\n\n");
		const r = await complete({
			system: loadPrompt("wiki-answer"),
			user: `问题：${opts.question}\n模式：deep（综合所有书的原文，写出蒸馏详解/示例）\n\n原文：\n${source}`,
			step: "wiki-answer",
			maxTokens: 4000,
		});
		const addr = hit.map((h) => `《${h.book.title}》（${h.book.author || "佚名"}）${h.sections.map((s) => s.title).join("、")}`).join("；");
		return `${r.text.trim()}\n\n——出处：${addr}`;
	}

	// quick: one block per book, search-results style, each with book + author
	return hit
		.map((h) => `▍《${h.book.title}》${h.book.author ? `（${h.book.author}）` : ""}\n${h.answer}\n  ——${h.sections.map((s) => s.title).join("、")}`)
		.join("\n\n");
}

/** L2 chapter-pick + L3 quick-answer for one book. Returns null when no chapter fits. */
async function askOneBook(
	book: BookRow,
	question: string,
	deep: boolean,
): Promise<{ book: BookRow; sections: Array<{ title: string; text: string }>; answer: string } | null> {
	const db = wikiDb(book.library);
	const sections = db
		.prepare("SELECT id, ord, title, mini, keywords FROM sections WHERE book_id=? ORDER BY ord")
		.all(book.id) as unknown as SectionRow[];
	if (sections.length === 0) return null;
	const secList = sections.map((s) => `${s.id}. ${s.title}${s.mini ? " — " + s.mini : ""}${s.keywords ? `【${s.keywords}】` : ""}`).join("\n");
	const p2 = await llmJson("wiki-pick", loadPrompt("wiki-pick-section"), `问题：${question}\n\n《${book.title}》章节：\n${secList}`);
	// Validate against the listing we actually showed — flash sometimes hallucinates ids
	// that belong to another book; an unvalidated IN() would silently read the wrong chapter.
	const validIds = new Set(sections.map((s) => s.id));
	const cap = deep ? 3 : MAX_SECTIONS; // deep reads several books — keep each book's share small
	const ids = (Array.isArray(p2.sections) ? p2.sections : []).map(Number).filter((n) => validIds.has(n)).slice(0, cap);
	const picked = ids.length > 0
		? (db.prepare(`SELECT id, ord, title, text FROM sections WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY ord`).all(...ids) as unknown as Array<SectionRow & { text: string }>)
		: [];
	if (picked.length === 0) return null;

	let budget = Math.floor(MAX_ANSWER_CHARS / (deep ? 3 : 1));
	const secs = picked
		.map((s) => {
			const t = s.text.slice(0, Math.max(0, budget));
			budget -= t.length;
			return { title: s.title, text: t };
		})
		.filter((x) => x.text.length > 10);
	if (secs.length === 0) return null;
	if (deep) return { book, sections: secs, answer: "" }; // merged later

	const r = await complete({
		system: loadPrompt("wiki-answer"),
		user: `问题：${question}\n模式：quick（快答）\n\n原文：\n${secs.map((s) => `【${book.title} · ${s.title}】\n${s.text}`).join("\n\n")}`,
		step: "wiki-answer",
		maxTokens: 1200,
	});
	return { book, sections: secs, answer: r.text.trim() };
}
