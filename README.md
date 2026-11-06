# Ruyi — Cross-Conversation Memory for AI Agents

**Your agent's soul, distilled.**

Every new chat starts from zero. Your setup, your tastes, the traps you already paid for — gone. Ruyi fixes that. It reads your session logs overnight and learns how you think and what you prefer. The next morning, your agent shows up knowing you.

No vector database. No embeddings. No babysitting. One Node process, one SQLite file.

## What you get

- **It knows you** — your style, your rules, your hardware, your allergies. Distilled into a short book about you, chapter by chapter
- **New chat, old topic, zero catch-up** — pick up right where you left off, weeks later
- **Cross-domain, not just code** — how you buy things, how you parent, how you manage your health. Any domain that shows up in your life grows its own chapter
- **No nagging** — an unrelated chat gets exactly 0 memories. A relevant one arrives once per conversation, never on repeat

## The numbers

| | |
|---|---|
| Memory store | **Converges, never sprawls** — raw entries get absorbed into profiles (one real store: 365 → 109 entries after one synthesis round) |
| Per-turn cost | one small-model call, ~2s, ~13K tokens of listing in / ~100 tokens out — fractions of a cent |
| Unrelated turns | selector returns empty = nothing injected, nothing wasted |
| Repeat injection | 0 — a per-conversation ledger guarantees each item arrives once |
| Dependencies | **0** runtime deps. `node:sqlite` + `node:http`. That's the whole stack |
| Uninstall | delete one directory — your agent keeps working, it just stops remembering |

## How it works (3 moving parts)

1. **Daytime — select.** A cheap fast model reads your whole store as a one-line-per-item listing plus your current topic, and points at what matters. At human scale the whole store fits in one glance — no keyword gatekeeping, nothing gets shut out.
2. **Night — distill.** A stronger model re-reads the day's session logs: extracts lessons, merges duplicates, archives the stale. Duplicates become reinforcement, not clutter.
3. **Weekly — write the book.** Everything worth keeping gets distilled into profile chapters: your identity card, your working style, your health, your craft domains. Memories are raw material; **profiles are the product**.

## Install

Best paired with [pi](https://github.com/earendil-works/pi) / [pi web](https://github.com/agegr/pi-web) — the prebuilt extension unlocks the full experience (per-turn auto-injection, tools, graceful degradation). Other agents work too.

Easiest: hand the repo URL to your agent.

> Install https://github.com/xiaqii/ruyi for me.

It reads [AGENT.README.md](AGENT.README.md) and sets everything up itself. It will ask you for exactly one thing: an LLM API key.

Or manually:

```bash
git clone https://github.com/xiaqii/ruyi
cd ruyi
bash scripts/install.sh
```

A local service runs at `http://127.0.0.1:8899`. (Node ≥ 23.6; custom directory: `bash scripts/install.sh /opt/ruyi`)

**With npm, straight from GitHub** (this repo IS the registry — no npmjs account needed on either side):

```bash
npm i -g github:xiaqii/ruyi   # puts `ruyi` on your PATH: ruyi serve / ruyi doctor / ruyi distill
```

**With Docker** (no Node needed on the host):

```bash
git clone https://github.com/xiaqii/ruyi && cd ruyi
docker compose up -d --build
```

The database lives in a mounted volume at `~/ruyi-docker/` — delete the container, lose nothing.

**Have old conversation logs?** Drop the file into `~/ruyi-inbox/` — zip, tar.gz, jsonl, txt, md, even a truncated archive. Overnight it gets slimmed (a 174MB log becomes ~1.5MB of actual human signal), filtered, and distilled. Bring your own history.

## Connect an agent

Don't wire anything yourself — let your agent do it. One sentence:

> Connect ruyi for me at `http://<host>:8899`, token is `<your-token>`.

The service itself is the manual — your agent fetches it, reads [AGENT.README.md](AGENT.README.md), picks the right connector (pi extension / MCP / single-file bridge), and wires itself up. Works with pi, Claude Code, opencode, and anything that speaks HTTP or MCP.

Then start a fresh chat and casually bring up an old problem from last month.

The moment it picks up right where you left off — you'll get it.

## Uninstall

```
systemctl disable --now ruyi ruyi-dream.timer ruyi-synthesize.timer 2>/dev/null
rm -rf ~/ruyi
```

Ruyi is a sidecar, not a dependency: down or gone, your agent behaves exactly as before.

## Repo map

- `src/` — the service (Node ≥ 23.6, TypeScript, SQLite)
- `scripts/` — `install.sh` (install), `self-update.sh` (daily self-update to tagged releases, auto-rollback), `release.sh` (release pipeline)
- `test/` — `smoke.ts` (59 zero-LLM tests), `llm-smoke.ts` (LLM-path smoke), `api-contract.ts` (47 contract tests)
- `prompts/`, `docs/`, `examples/` — prompts (live-reload, edit without restart), design docs, client connectors

---

*ruyi takes its name from the Chinese 如忆 — "as remembered".*

*作者：将军 (xiaqii) · MIT*
