/**
 * Landing page for GET / — the service URL doubles as its own manual.
 * Humans get HTML (Accept: text/html), agents/curl get Markdown.
 * NEVER put secrets here: no tokens, no internal IPs. Public by design.
 */

const MD = (host: string) => `# ruyi — long-term memory for AI agents

ruyi is a standalone memory API service. It doesn't remember what you said — it learns how
you work: your habits, preferences and hard-won lessons, carried into every new session.
All the intelligence (extraction, merging, curation) lives server-side, so any agent that
speaks HTTP or MCP — Claude Code, pi, opencode, your own scripts — plugs in as a thin client.

## 1. Install ruyi (your own instance)

If someone gave you this URL together with a token, the service is already running —
skip to section 2.

To self-host (Linux + Node >= 23.6), just hand this repo to your agent:

    https://github.com/xiaqii/ruyi

"Install this" is enough — the repo's AGENT.README.md walks the agent through cloning,
LLM key setup, the systemd service and connecting itself. Uninstall is one script, and
all data lives in a single data/ folder you can inspect or delete.

## 2. Connect your agent to ruyi

You need the service URL — https://${host} (or http://127.0.0.1:8899 for a local
install) — and the access token (localhost needs none). If you are an AI agent reading
this, follow the steps for your kind.

MCP clients (Claude Code, opencode, ...)
  Download the bridge (single file, no clone needed):
    https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/mcp-remote.mjs
  Claude Code (Windows too):
    claude mcp add ruyi -e RUYI_URL=<url> -e RUYI_TOKEN=<token> -- node <script-path>
  opencode (~/.config/opencode/opencode.jsonc):
    "mcp": { "ruyi": { "type": "local", "command": ["node", "<script-path>"],
                       "environment": { "RUYI_URL": "<url>", "RUYI_TOKEN": "<token>" } } }

pi / pi web
  Download the extension into ~/.pi/agent/extensions/ruyi.ts, set RUYI_URL and
  RUYI_TOKEN for the pi process, restart:
    https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/pi-extension/ruyi.ts

Any script / your own agent
  Plain HTTP. Field-level contract: https://github.com/xiaqii/ruyi/blob/main/API.md
  20-line reference client:
    https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/http-client.mjs

Then:
- Verify (required): open a new session, call the recall tool with "coding style".
  Content coming back means connected.
- Auth: every route except / and /health needs the header Authorization: Bearer <token>.
- Timeouts: LLM-backed routes (recall deep/excavate, remember, ingest) take seconds —
  set client timeouts to 45s+; the plain-SQL routes answer in milliseconds.
- Degradation: if ruyi is unreachable, keep working as normal — memory is an
  accessory, not a dependency.
- Optional: feed this machine's past sessions to the nightly dream (incremental,
  resumable — never paste whole logs into ingest):
    node sync-sessions.mjs --dir <your-sessions> --agent claude-code --machine <this-pc>
    https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/sync-sessions.mjs

Humans: health check at GET /health — source & docs: https://github.com/xiaqii/ruyi
`;

function mdToHtml(md: string): string {
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	let html = esc(md);
	html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
	html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>").replace(/^## (.*)$/gm, "<h2>$1</h2>");
	html = html.replace(/^={10,}$/gm, "<hr>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
	return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ruyi — long-term memory for AI agents</title>
<style>
body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f141b;color:#c9d4e3;margin:0;padding:2em;line-height:1.65}
main{max-width:860px;margin:0 auto;background:#161e29;border:1px solid #263144;border-radius:12px;padding:2em 2.5em}
h1{color:#e8b74a;font-size:1.5em;margin:.2em 0}h2{color:#7db8e8;font-size:1.1em;margin:1.4em 0 .4em}
a{color:#6cb6ff;word-break:break-all}b{color:#e6edf7}hr{border:none;border-top:1px dashed #2c3a4f;margin:1.2em 0}
pre{white-space:pre-wrap;word-break:break-word;margin:0}
</style></head><body><main><pre>${html}</pre></main></body></html>`;
}

export function landingPage(host: string, acceptHtml: boolean): { body: string; contentType: string } {
	const md = MD(host);
	return acceptHtml
		? { body: mdToHtml(md), contentType: "text/html; charset=utf-8" }
		: { body: md, contentType: "text/markdown; charset=utf-8" };
}
