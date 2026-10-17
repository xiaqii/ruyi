# Ruyi (如忆) — Long-term Memory for AI Agents

**I tried several heavyweight agent-memory products. None felt right. So I wrote my own.**

They all arrived with vector databases, embeddings, pages of config. After all that setup, my agent forgot things just the same.

So I built ruyi. Used it, tweaked it, kept using it — and somewhere along the way realized: this actually works.

My agent remembers now. Work feels normal again. Putting it here in case friends find it useful.

- **It knows you better over time** — you work by day; overnight it merges duplicates, drops what's stale, and distills your habits into profiles
- **New chat, old topic, zero catch-up** — no re-explaining your setup, your tastes, or the traps you've already paid for
- **No nagging** — unrelated chats get zero memories; relevant ones arrive once, never on repeat

## Install ruyi

**From source.** Easiest: hand the repo URL to your agent:

> Install https://github.com/xiaqii/ruyi for me.

It reads [AGENT.README.md](AGENT.README.md) and sets everything up itself. It will ask you for exactly one thing: an LLM API key.

Or do it manually:

```bash
git clone https://github.com/xiaqii/ruyi
cd ruyi
bash scripts/install.sh
```

A local service runs at `http://127.0.0.1:8899`. (Node ≥ 23.6; custom directory: `bash scripts/install.sh /opt/ruyi`)

**With Docker** (no Node needed on the host):

```bash
git clone https://github.com/xiaqii/ruyi && cd ruyi
docker compose up -d --build
```

The database lives in a mounted volume at `~/ruyi-docker/` — delete the container, lose nothing.

## Uninstall

```
systemctl disable --now ruyi ruyi-dream.timer ruyi-synthesize.timer 2>/dev/null
rm -rf ~/ruyi
```

**Your agent keeps working — it just stops remembering.** Ruyi is a sidecar, not a dependency: down or gone, your agent behaves exactly as before.

## Connect an agent

Don't wire anything yourself — let your agent do it. Give it one sentence:

> Connect ruyi for me at `http://<host>:8899`, token is `<your-token>`.

Same machine as the install? Even simpler:

> Connect ruyi for me at `http://127.0.0.1:8899`.

The service itself is the manual — your agent fetches it, reads [AGENT.README.md](AGENT.README.md), picks the right connector (pi extension / MCP / single-file bridge), and wires itself up. It will tell you when it's done; ask it to recall something old to prove it.

Prefer to wire things by hand? The connectors live in [examples/](examples/): pi extension, Claude Code MCP, opencode config, and a single-file remote bridge.

Once connected, start a fresh chat and casually bring up an old problem from last month.

The moment it picks up right where you left off — you'll get it.

---

More (config, troubleshooting, every client): [AGENT.README.md](AGENT.README.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · MIT

## Repo map

- `src/` — the service (Node ≥ 23.6, TypeScript, SQLite)
- `scripts/` — `install.sh` (install), `self-update.sh` (self-update), `release.sh` (release pipeline), `compare-distill.ts` (distill A/B helper)
- `test/` — `smoke.ts` (34 zero-LLM tests), `llm-smoke.ts` (LLM-path smoke), `api-contract.ts`
- `prompts/`, `docs/`, `examples/` — prompts, design docs, client connectors
