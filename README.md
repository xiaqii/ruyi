# Ruyi — Cross-Conversation Memory for AI Agents

You use PI / Claude Code / OpenCode — you got a smart agent.
You use Ruyi with them — you got a Jarvis~

It reads your session logs overnight, learns how you think and what you prefer, and brings it to every new conversation. No vector database. No embeddings. One Node process, one SQLite file.

## Install

Hand your agent one line:

> Install and connect https://github.com/xiaqii/ruyi for me, dir: ~/ruyi, token: random.

It reads [AGENT.README.md](AGENT.README.md), installs everything, generates a token, and wires itself in — you'll only be asked for an LLM API key.

Prefer doing it manually?

```bash
git clone https://github.com/xiaqii/ruyi && cd ruyi && bash scripts/install.sh   # Node ≥ 23.6
# or: npm i -g https://github.com/xiaqii/ruyi/releases/latest/download/ruyi.tgz
# or: docker compose up -d --build
```

Then start a fresh chat and casually bring up an old problem from last month. The moment it picks up right where you left off — you'll get it.

**Have old conversation logs?** Drop them into `~/ruyi-inbox/` — zip, tar.gz, jsonl, txt, md, even truncated archives. Overnight they get slimmed (a 174MB log becomes ~1.5MB of human signal), filtered, and distilled.

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
