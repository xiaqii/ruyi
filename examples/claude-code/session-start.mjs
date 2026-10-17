#!/usr/bin/env node
/**
 * Claude Code SessionStart hook — gives Claude the same zero-cost opening
 * injection pi gets (constitution + memory index + profile directory).
 *
 * Install: add to ~/.claude/settings.json (or project .claude/settings.json):
 *
 *   "hooks": {
 *     "SessionStart": [{
 *       "hooks": [{ "type": "command",
 *                   "command": "node /ABSOLUTE/PATH/TO/ruyi/examples/claude-code/session-start.mjs" }]
 *     }]
 *   }
 *
 * Contract: prints one JSON line; additionalContext is added to Claude's context.
 * Failure isolation: any error → exit 0 silently, Claude Code starts unaffected.
 */

const BASE = (process.env.RUYI_URL ?? "http://127.0.0.1:8899").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? "";
const OWNER = process.env.RUYI_OWNER ?? "default";

try {
	const headers = {};
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const res = await fetch(
		`${BASE}/inject?owner=${encodeURIComponent(OWNER)}&cwd=${encodeURIComponent(process.cwd())}&scope=smart`,
		{ headers, signal: AbortSignal.timeout(3_000) },
	);
	if (!res.ok) process.exit(0);
	const inj = await res.json();

	const parts = [];
	if (inj.constitution?.length)
		parts.push("Core long-term memory (always follow unless conflicting with the user):\n" +
			inj.constitution.map((c) => `- ${c.summary}\n  ${c.content}`).join("\n"));
	if (inj.index?.length)
		parts.push("Memory index (one-liners; fetch full text via the ruyi MCP recall/get tools when relevant):\n" +
			inj.index.map((m) => `- #${m.id} (${m.kind}, ${m.date}) ${m.summary}`).join("\n"));
	if (inj.profileDirectory?.length)
		parts.push("Profile chapters available (load at most one via ruyi recall when the task is squarely in that domain):\n" +
			inj.profileDirectory.map((p) => `- 《${p.title}》(${p.maturity})`).join("\n"));
	if (!parts.length) process.exit(0);

	parts.push("The above comes from ruyi long-term memory; it never overrides what the user says now.");
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext: parts.join("\n\n"),
		},
	}) + "\n");
} catch {
	process.exit(0); // ruyi down = no memory this session, nothing more
}
