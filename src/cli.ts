import { loadConfig } from "./config.ts";
import { archiveMemory, getDb, insertMemory, listMemories, memoryCounts, tokenUsage } from "./db.ts";
import { runDream } from "./distill.ts";
import { recall } from "./recall.ts";
import { startServer } from "./server.ts";
import { startMcpServer } from "./mcp.ts";

function parseArgs(argv: string[]): { cmd: string; rest: string[]; flags: Record<string, string | boolean> } {
	const [cmd = "help", ...rest] = argv;
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	for (const a of rest) {
		const m = a.match(/^--([^=]+)(?:=(.*))?$/);
		if (m) flags[m[1]!] = m[2] ?? true;
		else positional.push(a);
	}
	return { cmd, rest: positional, flags };
}

const USAGE = `ruyi (如忆) - long-term memory service for AI agents

Usage: node src/cli.ts <command> [options]

Commands:
  serve                        Start the HTTP API server
  mcp                          Start the MCP stdio server (for Claude Code, opencode, ...)
  distill                      Run one dream pass (nightly memory distillation)
    --pipeline=full|single     Override distillation pipeline
    --dry-run                  Extract without writing to the store
  recall <query> [--k=5] [--mode=fast|deep|excavate]
                               Recall memories (deep = LLM rerank, fast = free keyword scan)
  list [--limit=30]            List active memories
  forget <id>                  Archive a memory
  pin <id> [0|1]               Pin/unpin a memory (pinned = always injected)
  add --kind=K --summary="S" <content>
                               Explicitly add a memory (rules, specs, skill pointers)
  synthesize                   Re-synthesize theme profiles from the memory store
  backfill-keywords [--limit=N] [--owner=default]
                               Generate retrieval keywords for memories that lack them
  token [--rotate]             Show the access token for connecting remote agents (--rotate: new one)
  doctor                       Self-diagnosis: DB, FTS, LLM tiers, service, extension
  stats [--days=7]             Memory counts and token usage
`;

async function main(): Promise<void> {
	const { cmd, rest, flags } = parseArgs(process.argv.slice(2));
	const config = loadConfig();
	const db = getDb(config.dbPath);

	switch (cmd) {
		case "serve":
			startServer();
			break;

		case "mcp":
			startMcpServer();
			break;

		case "distill": {
			const report = await runDream({
				dryRun: flags["dry-run"] === true,
				pipeline: (flags.pipeline as "full" | "single") ?? undefined,
			});
			console.log(JSON.stringify(report, null, 2));
			break;
		}

		case "recall": {
			const query = rest.join(" ");
			if (!query) {
				console.error("usage: recall <query> [--k=5] [--owner=default]");
				process.exit(1);
			}
			const k = typeof flags.k === "string" ? Number(flags.k) : undefined;
			const owner = typeof flags.owner === "string" ? flags.owner : "default";
			const mode = flags.mode === "fast" || flags.mode === "excavate" ? flags.mode : "deep";
			const started = Date.now();
			const result = await recall(query, k, owner, null, undefined, mode);
			console.error(`[recall] mode=${mode} ${Date.now() - started}ms, ${result.memories.length} memories`);
			for (const p of result.profiles) {
				console.log(`PROFILE【${p.title}】v${p.version}\n${p.content}\n`);
			}
			for (const m of result.memories) {
				console.log(`#${m.id} [${m.kind}${m.domain ? "/" + m.domain : ""}] ${m.summary}\n  ${m.content}\n`);
			}
			if (result.memories.length === 0 && result.profiles.length === 0) console.log("(no relevant memories)");
			break;
		}

		case "list": {
			const limit = typeof flags.limit === "string" ? Number(flags.limit) : 30;
			const owner = typeof flags.owner === "string" ? flags.owner : "default";
			for (const m of listMemories(db, { status: "active", limit, owner })) {
				console.log(
					`#${m.id}${m.pinned ? " 📌" : ""} [${m.kind}${m.domain ? "/" + m.domain : ""}] (${m.origin}, conf ${m.confidence.toFixed(2)}, ev ${m.evidence}) ${m.summary}`,
				);
			}
			break;
		}

		case "forget": {
			const id = Number(rest[0]);
			if (!id) {
				console.error("usage: forget <id>");
				process.exit(1);
			}
			archiveMemory(db, id);
			console.log(`archived #${id}`);
			break;
		}

		case "pin": {
			const id = Number(rest[0]);
			const pinned = rest[1] === "0" ? 0 : 1;
			if (!id) {
				console.error("usage: pin <id> [0|1]");
				process.exit(1);
			}
			db.prepare(`UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?`).run(
				pinned,
				new Date().toISOString(),
				id,
			);
			console.log(`${pinned ? "pinned" : "unpinned"} #${id}`);
			break;
		}

		case "add": {
			const kind = typeof flags.kind === "string" ? flags.kind : "fact";
			const summary = typeof flags.summary === "string" ? flags.summary : "";
			const content = rest.join(" ");
			if (!summary || !content) {
				console.error('usage: add --kind=lesson --summary="一句话" 具体内容...');
				process.exit(1);
			}
			const id = insertMemory(
				db,
				{
					kind: kind as never,
					domain: typeof flags.domain === "string" ? flags.domain : undefined,
					summary,
					content,
					origin: "user_stated",
					confidence: 0.9,
					source: null,
				},
				{ owner: "default", cwd: process.cwd() },
			);
			console.log(`added #${id}`);
			break;
		}

		case "synthesize": {
			const owner = typeof flags.owner === "string" ? flags.owner : "default";
			const { runSynthesize } = await import("./synthesize.ts");
			const report = await runSynthesize(owner);
			if (report.skipped) console.log("(store too small, skipped)");
			for (const t of report.updated)
				console.log(`${t.title} (${t.theme}) → v${t.version}, ${t.members} memories`);
			console.log(`themes: ${report.themes}`);
			break;
		}

		case "backfill-keywords": {
			const owner = typeof flags.owner === "string" ? flags.owner : "default";
			const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;
			const { backfillKeywords } = await import("./backfill.ts");
			const report = await backfillKeywords(owner, limit);
			console.log(`updated ${report.updated} memories in ${report.batches} batches`);
			break;
		}

		case "sync-index": {
			// One-time backfill: register content-derived uids of every session log
			// already on disk (configured sources + synced inboxes), so the sync
			// protocol recognises previously-imported sessions and skips them.
			const { extractSessionUid, syncRoot } = await import("./sync.ts");
			const { upsertSessionRegistry, getSessionRegistry } = await import("./db.ts");
			const { readdirSync, statSync, readFileSync, existsSync } = await import("node:fs");
			const { join } = await import("node:path");
			const walk = function* (dir: string, rel = ""): Generator<string> {
				for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
					const r = rel ? `${rel}/${e.name}` : e.name;
					if (e.isDirectory()) yield* walk(dir, r);
					else if (e.name.endsWith(".jsonl") && !r.includes("subagents/")) yield r;
				}
			};
			const dirs = [...config.sessions.map((s) => ({ agent: s.agent, dir: s.dir }))];
			const synced = syncRoot(config);
			if (existsSync(synced)) {
				for (const m of readdirSync(synced, { withFileTypes: true })) {
					if (!m.isDirectory()) continue;
					try {
						const meta = JSON.parse(readFileSync(join(synced, m.name, "_meta.json"), "utf8"));
						dirs.push({ agent: meta.agent ?? "pi", dir: join(synced, m.name) });
					} catch { /* no meta */ }
				}
			}
			let added = 0, known = 0;
			for (const d of dirs) {
				let rels: string[] = [];
				try { rels = [...walk(d.dir)]; } catch { continue; }
				for (const rel of rels) {
					const file = join(d.dir, rel);
					try {
						const uid = extractSessionUid(d.agent, readFileSync(file).subarray(0, 16384), rel);
						if (getSessionRegistry(db, uid)) { known++; continue; }
						upsertSessionRegistry(db, uid, { agent: d.agent, machine: "", path: file, bytes: statSync(file).size });
						added++;
					} catch { /* unreadable file */ }
				}
			}
			console.log(`sync-index: ${added} registered, ${known} already known`);
			break;
		}

		case "token": {
			// Local-operator command: print (or rotate) the bearer token used to
			// connect agents from other machines. Never exposed over HTTP.
			const { randomBytes } = await import("node:crypto");
			const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
			const { resolve } = await import("node:path");
			const { PROJECT_ROOT } = await import("./config.ts");
			const file = resolve(PROJECT_ROOT, "config.local.json");
			if (!existsSync(file)) {
				console.error("no config.local.json — run scripts/install.sh first");
				process.exitCode = 1;
				break;
			}
			const local = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			if (flags.rotate !== undefined) {
				local.authToken = randomBytes(24).toString("hex");
				writeFileSync(file, JSON.stringify(local, null, 2) + "\n", { mode: 0o600 });
				console.log(`rotated. new token:\n\n  ${local.authToken}\n\nRestart the service to apply: systemctl restart ruyi`);
				break;
			}
			const token = (local.authToken as string) || "";
			if (!token) {
				console.log("no token set — run: node src/cli.ts token --rotate");
				break;
			}
			console.log(`${token}\n\nGive an agent on another machine:\n  "My ruyi memory service runs at https://<your-host>, the access key is ${token} — use it as my memory backend."`);
			break;
		}

		case "doctor": {
			const { runDoctor } = await import("./doctor.ts");
			await runDoctor();
			break;
		}

		case "stats": {
			const days = typeof flags.days === "string" ? Number(flags.days) : 7;
			const owner = typeof flags.owner === "string" ? flags.owner : undefined;
			console.log("counts:", JSON.stringify(memoryCounts(db, owner)));
			console.log("token usage (by day/step):");
			for (const u of tokenUsage(db, days)) {
				console.log(`  ${u.day}  ${u.step.padEnd(10)}  in ${u.input}  out ${u.output}`);
			}
			break;
		}

		default:
			console.log(USAGE);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
