#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook — per-turn semantic recall, same behavior
 * as the pi extension: every user message is checked against long-term memory,
 * and only memories NEW to this conversation are injected (server-side dedup
 * via the conversation id; repeat candidates short-circuit without an LLM call).
 *
 * Install: add to ~/.claude/settings.json (or project .claude/settings.json):
 *
 *   "hooks": {
 *     "UserPromptSubmit": [{
 *       "hooks": [{ "type": "command",
 *                   "command": "node /ABSOLUTE/PATH/TO/ruyi/examples/claude-code/user-prompt-submit.mjs" }]
 *     }]
 *   }
 *
 * Env: RUYI_URL (default http://127.0.0.1:8899), RUYI_TOKEN, RUYI_OWNER,
 *      RUYI_RECALL_MODE (default "deep"; "fast" = keyword-only, zero LLM).
 * Contract: stdin = hook JSON ({session_id, prompt, cwd, ...}); stdout = one
 * JSON line whose additionalContext is added to Claude's context.
 * Failure isolation: any error/timeout → exit 0 silently, nothing is injected.
 */

const BASE = (process.env.RUYI_URL ?? "http://127.0.0.1:8899").replace(/\/+$/, "");
const TOKEN = process.env.RUYI_TOKEN ?? "";
const OWNER = process.env.RUYI_OWNER ?? "default";
const MODE = process.env.RUYI_RECALL_MODE ?? "deep";
const TIMEOUT_MS = MODE === "deep" ? 20_000 : 3_000; // deep = LLM-bound

try {
	const input = JSON.parse(await new Promise((resolve, reject) => {
		let s = "";
		process.stdin.on("data", (c) => (s += c));
		process.stdin.on("end", () => resolve(s));
		process.stdin.on("error", reject);
		setTimeout(() => reject(new Error("stdin timeout")), 2_000);
	}));
	const sessionId = typeof input.session_id === "string" ? input.session_id : "";
	const prompt = typeof input.prompt === "string" ? input.prompt : "";
	if (!sessionId || !prompt.trim()) process.exit(0);

	const headers = { "content-type": "application/json" };
	if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
	const res = await fetch(`${BASE}/recall`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			query: prompt.length > 2000 ? prompt.slice(0, 2000) : prompt,
			k: 6,
			owner: OWNER,
			cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
			scope: "smart",
			mode: MODE,
			conversation: `claude:${sessionId}`,
			auto: true,
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) process.exit(0);
	const r = await res.json();
	const memories = r.memories ?? [];
	const profiles = r.profiles ?? [];
	if (memories.length === 0 && profiles.length === 0) process.exit(0);

	const parts = [];
	for (const p of profiles)
		parts.push(`Long-term profile 《${p.title}》(v${p.version}):\n${String(p.content).slice(0, 3000)}`);
	if (memories.length > 0) {
		parts.push(
			"Long-term memories relevant to this message (first time injected in this conversation):\n\n" +
				memories.map((m) => `- (#${m.id}, ${m.kind}) ${m.summary}\n  ${m.content}`).join("\n"),
		);
	}
	let note = "The above comes from ruyi long-term memory; it never overrides what the user says now.";
	if ((r.deduped ?? 0) > 0) note = `(ruyi skipped ${r.deduped} already-injected item(s) for this conversation.) ` + note;

	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "UserPromptSubmit",
			additionalContext: parts.join("\n\n") + "\n\n" + note,
		},
	}) + "\n");
} catch {
	process.exit(0); // ruyi down = no memory this turn, nothing more
}
