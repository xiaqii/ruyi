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
  recall <query> [--k=5]       Two-stage LLM recall (for testing)
  list [--limit=30]            List active memories
  forget <id>                  Archive a memory
  pin <id> [0|1]               Pin/unpin a memory (pinned = always injected)
  add --kind=K --summary="S" <content>
                               Explicitly add a memory (rules, specs, skill pointers)
  synthesize                   Re-synthesize theme profiles from the memory store
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
			const result = await recall(query, k, owner);
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
