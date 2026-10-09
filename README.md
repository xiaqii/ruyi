# 如忆 Ruyi — Long-term Memory for AI Agents

**It doesn't remember what you said. It learns how you work.**

✅ Verified with: pi agent · pi web · Claude Code · opencode · MIT · zero dependencies

Ruyi is a small, standalone memory API service. Most "memory" tools are conversation loggers that pile up facts forever. Ruyi distills **how you work** — your habits, preferences, and hard-won lessons — into a few stable profile chapters that every new session starts with. Ship a feature and ruyi won't memorize your code; it will learn that you prefer integration tests over mocks and keep forgetting error handling on async paths. Next month, next machine, next agent — that experience is already loaded. You stop paying for the same mistake twice.

- **Converges, never hoards** — mature profile chapters absorb their source memories; a year in, you own a refined profile, not a landfill of fragments.
- **Cheap by design** — keywords live in SQLite FTS (free), the LLM only ever sees ≤100 one-line summaries. No vector DB, no embedding costs. Every token is logged — ask your agent for a cost report anytime.
- **Yours** — one process, one SQLite file, your own LLM key. A sidecar, not a dependency: if ruyi is down, your agent works exactly as before, just without memory for that session.

## 1. Install ruyi

Tell your agent:

> Install https://github.com/xiaqii/ruyi for me.

That's it. Your agent reads [AGENT.README.md](AGENT.README.md) and does everything itself — dependencies, config, background service, self-updates, and wiring itself up. It will ask you for exactly one thing: your LLM API key. (Requires Linux + Node ≥ 23.6. Prefer a custom directory? Just say so: *install it to /opt/ruyi*.)

**Uninstall is equally boring:**

```
systemctl disable --now ruyi ruyi-dream.timer ruyi-synthesize.timer 2>/dev/null
rm -rf ~/ruyi        # and the ruyi lines in your agent's config
```

## 2. Connect an agent to ruyi

A local install connects your agent automatically. For anything else you need two things: the **service URL** (e.g. `https://ruyi.example.com`, or `http://127.0.0.1:8899` locally) and the **access token** (localhost needs none).

- **MCP clients** (Claude Code, opencode, …): use [examples/mcp-remote.mjs](examples/mcp-remote.mjs), a single-file stdio→HTTPS bridge — no repo clone needed.
  `claude mcp add ruyi -e RUYI_URL=<url> -e RUYI_TOKEN=<token> -- node <script-path>`
- **pi / pi web**: put [examples/pi-extension/ruyi.ts](examples/pi-extension/ruyi.ts) in `~/.pi/agent/extensions/`, set `RUYI_URL` + `RUYI_TOKEN`, restart.
- **Any script / your own agent**: plain HTTP. [API.md](API.md) is the authoritative, test-enforced contract; [examples/http-client.mjs](examples/http-client.mjs) is a 20-line reference client.

Or just tell your agent: *"My ruyi memory service runs at \<url\>, the access key is \<token\> — use it as my memory backend"* — and it will set itself up. Either way, verify by asking it to recall something.

**Sharing rules.** All of *your* agents on all of *your* machines: yes, that's the point — one always-on host every device can reach, and your experience follows you everywhere. Multiple *people* on one ruyi: no. Two people sharing one instance merges your habits into one confused profile, and everything either of you remembers becomes visible to both — unless you're close enough to share a diary, which is literally what that would be.

---

Full manual (config, multi-client wiring, session sync, troubleshooting): **[AGENT.README.md](AGENT.README.md)** · Changelog: **[CHANGELOG.md](CHANGELOG.md)**
