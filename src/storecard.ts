/** storecard.ts — the store card: a "profile of the memory store itself".
 *
 *  The agent's blind spot is not knowing what it doesn't know: per-turn injection
 *  shows only WHAT WAS PICKED, never what the store COVERS. The store card fixes
 *  that — one short map of domains with hook words, shown alongside every
 *  injection, so the agent knows when probing is worthwhile.
 *
 *  Two-pass nightly generation (dream tier, thinking on — cards are the
 *  permanent routing foundation, queries may err but cards must not):
 *    pass 1: per-domain card (question-facing + hook words) — skipped when the
 *            domain's memory set is unchanged (hash in kv)
 *    pass 2: assemble the overall card from domain cards (dedup, order, size)
 *
 *  Same pattern as the wiki's book cards — proven there, borrowed here.
 */
import { createHash } from "node:crypto";
import { loadConfig } from "./config.ts";
import { getDb, getKv, listProfiles, setKv } from "./db.ts";
import { complete } from "./llm.ts";
import { loadPrompt } from "./prompts.ts";
import type { MemoryRow } from "./types.ts";

const DOMAIN_CARD_MAX = 400; // chars per domain card
const STORE_CARD_TARGET = 3000; // soft cap for the assembled card

function domainHash(mems: MemoryRow[]): string {
	const h = createHash("md5");
	for (const m of mems) h.update(`${m.id}:${m.updated_at};`);
	return h.digest("hex").slice(0, 16);
}

/** Regenerate the store card. Returns true if anything changed. */
export async function refreshStoreCard(owner = "default", opts: { verbose?: boolean } = {}): Promise<boolean> {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const mems = db
		.prepare("SELECT id, kind, domain, summary, mini, updated_at FROM memories WHERE status='active' AND owner=? ORDER BY domain, id")
		.all(owner) as unknown as MemoryRow[];

	// Group by domain; undomained memories join "general".
	const groups = new Map<string, MemoryRow[]>();
	for (const m of mems) {
		const d = (m.domain ?? "").trim() || "general";
		(groups.get(d) ?? groups.set(d, []).get(d)!).push(m);
	}

	// Pass 1: per-domain cards, hash-cached.
	const domainCards: Array<{ domain: string; count: number; card: string }> = [];
	let changed = false;
	for (const [domain, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
		const hash = domainHash(rows);
		const cacheKey = `storecard:dom:${owner}:${domain}`;
		const cached = getKv(db, cacheKey);
		if (cached) {
			try {
				const c = JSON.parse(cached) as { hash: string; card: string };
				if (c.hash === hash) {
					domainCards.push({ domain, count: rows.length, card: c.card });
					continue;
				}
			} catch { /* fall through and regenerate */ }
		}
		const listing = rows.map((m) => `[${m.kind}] ${m.mini || m.summary}`).join("\n");
		const card = (
			await complete({
				system: loadPrompt("store-card-domain"),
				user: `DOMAIN: ${domain}\nENTRIES (${rows.length}):\n${listing}\n\nWrite the domain card (<= ${DOMAIN_CARD_MAX} chars).`,
				step: "store-card",
			})
		).text.trim();
		setKv(db, cacheKey, JSON.stringify({ hash, card }));
		domainCards.push({ domain, count: rows.length, card });
		changed = true;
		if (opts.verbose) console.log(`[storecard] domain ${domain}: ${rows.length} entries → card ${card.length} chars`);
	}

	// Profiles also belong on the map — their titles+abstracts are already card-like.
	const profiles = listProfiles(db, owner).filter((p) => p.status !== "archived");
	const profileLines = profiles.map((p) => `《${p.title}》— ${p.abstract || ""}`.slice(0, 80)).join("\n");

	// Pass 2: assemble. Skip the LLM when nothing changed and a card exists.
	const domState = domainCards.map((d) => `${d.domain}:${d.count}`).join("|") + `||p:${profiles.map((p) => p.id + ":" + p.version).join(",")}`;
	const stateKey = `storecard:state:${owner}`;
	if (!changed && getKv(db, stateKey) === domState && getKv(db, `storecard:${owner}`)) return false;

	const assembled = (
		await complete({
			system: loadPrompt("store-card"),
			user: `DOMAIN CARDS:\n${domainCards.map((d) => `【${d.domain}】(${d.count} 条)\n${d.card}`).join("\n\n")}\n\nPORTRAIT CHAPTERS:\n${profileLines}\n\nAssemble the store card (target <= ${STORE_CARD_TARGET} chars).`,
			step: "store-card",
			// Thinking burns the same budget as the reply on the Kimi endpoint — with
			// the tier default (8K) a long think leaves ZERO room for the card text.
			maxTokens: 65_536,
		})
	).text.trim();
	// Never let an empty/garbage assembly overwrite a good card (Kimi occasionally
	// returns an empty completion; a missing card is better than a blank one).
	if (assembled.length < 100) {
		console.warn(`[storecard] assembly returned ${assembled.length} chars — keeping the previous card`);
		return false;
	}
	setKv(db, `storecard:${owner}`, assembled);
	setKv(db, stateKey, domState);
	setKv(db, `storecard:built:${owner}`, new Date().toISOString());
	if (opts.verbose) console.log(`[storecard] assembled ${assembled.length} chars from ${domainCards.length} domains`);
	return true;
}

/** The current store card for injection payloads (null before the first generation). */
export function getStoreCard(owner = "default"): string | null {
	const config = loadConfig();
	const db = getDb(config.dbPath);
	const card = getKv(db, `storecard:${owner}`);
	if (!card) return null;
	// Fresh strip: memories born after the card's last nightly build are not in
	// the map yet — append them so the agent's map is never a day stale.
	const built = getKv(db, `storecard:built:${owner}`) ?? new Date(Date.now() - 86_400_000).toISOString();
	const fresh = db
		.prepare(`SELECT id, summary FROM memories WHERE status = 'active' AND owner = ? AND created_at > ? ORDER BY id DESC LIMIT 8`)
		.all(owner, built) as Array<{ id: number; summary: string }>;
	if (fresh.length === 0) return card;
	return card + "\n\nNEW SINCE THIS MAP WAS BUILT (not yet woven in):\n" + fresh.map((m) => `#${m.id} ${m.summary.slice(0, 50)}`).join("\n");
}
