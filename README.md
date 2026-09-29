# ruyi (如忆)

**如忆** — "as remembered". An agent-agnostic long-term memory service for AI coding agents and assistants.

Your agent forgets everything between conversations. ruyi gives it a human-like memory: it **dreams** — every night it re-reads the day's conversations, distills what's worth remembering, consolidates it against everything it already knows — and during the day it recalls precisely the few memories that matter for the task at hand.

## Design philosophy

- **LLM all the way down.** Extraction, verification, consolidation and recall ranking are all done by an LLM, not string matching. Relevance is judged by meaning, not keywords.
- **Memory is governed, not just stored.** Entries carry confidence, evidence counts and origin labels (`user_stated` vs `agent_inferred`). Repeated observations reinforce; contradictions supersede; stale inferences decay and archive. The store stays small and sharp no matter how long you use it.
- **Bounded injection, always.** The agent gets a fixed-budget "constitution + index" block every session, plus an on-demand recall tool. Memory never floods the context or steers the conversation.
- **Fully optional for the host agent.** ruyi is a separate local service. If it is down, slow, or returns garbage, the agent is completely unaffected (short timeouts + circuit breaker).
- **Multi-user ready.** Every memory belongs to an `owner` (isolation boundary) and records its source `cwd`. One ruyi instance can serve many accounts on a shared host without leaking between them.

## Architecture

```
            ┌────────────────────────────────────────────┐
            │              ruyi service                  │
            │         (127.0.0.1:8899, localhost)        │
            │                                            │
  nightly   │   SQLite (WAL)                             │
  dream ───▶│     ▲          ▲               ▲           │
  (distill, │     │          │               │           │
   verify,  │  HTTP API   MCP stdio        CLI           │
   merge,   │     │          │               │           │
   decay)   └─────┼──────────┼───────────────┼───────────┘
                  │          │               │
            pi extension   Claude Code,   humans (audit,
            (~/.pi/agent/  opencode,      forget, pin)
             extensions/    any MCP agent
             ruyi.ts)
```

- **Zero runtime dependencies.** Plain Node ≥ 23.6 (native TypeScript + `node:sqlite` + `node:http`). `typescript`/`@types/node` are dev-only for `tsc --noEmit`.
- **LLM**: any Anthropic-compatible `/v1/messages` endpoint (Anthropic, Kimi, ...). Configured in `config.local.json`.

## Memory pipeline ("dreaming")

Runs nightly via systemd timer (or `node src/cli.ts distill`):

1. **Incremental scan** — session logs are append-only; only new bytes are processed. Each session keeps a rolling "gist" so new segments are distilled with context.
2. **Extract** — the LLM pulls candidate memories (preference / fact / project / lesson / skill_index) with evidence quotes. Empty output is valid; most segments yield nothing.
3. **Verify** — a second LLM pass drops hallucinated, one-off, or unsafe candidates and recalibrates confidence/origin. (`pipeline: "single"` does both in one pass; A/B script included: `scripts/compare-distill.ts`.)
4. **Merge** — each candidate is judged against the existing store: `NEW` / `REINFORCE` (evidence+1) / `REFINE` (merge details) / `SUPERSEDE` (archive the contradicted old entry).
5. **Decay** — low-confidence agent inferences untouched for 90 days are archived automatically.

Every LLM call is token-accounted (`token_log` table + `logs/usage-*.jsonl`).

## Recall (3 layers)

| Layer | What | Budget | How |
|---|---|---|---|
| Constitution | pinned core entries | ≤ 5 | injected every session |
| Index | one-line summaries, recent + high-evidence | ≤ 20 | injected every session |
| Recall | two-stage: candidate list → LLM picks the genuinely relevant few | ≤ 5 | agent calls `ruyi_recall` tool |

## Install

```bash
git clone <repo> /app/ruyi && cd /app/ruyi
npm install            # dev-only deps (typescript)
cp config.example.json config.local.json
# edit config.local.json: llm.baseUrl / apiKey / model, session dirs

node src/cli.ts distill     # first dream over existing session logs
node src/cli.ts serve       # start the API
```

systemd (service + nightly timer):

```bash
sudo cp systemd/*.service systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ruyi.service ruyi-dream.timer
```

## Client integrations

### pi (extension)

Copy `examples/pi-extension/ruyi.ts` to `~/.pi/agent/extensions/ruyi.ts`. It injects the constitution+index into the system prompt and registers the `ruyi_recall` tool and `/ruyi` command. If ruyi is down, pi behaves exactly as if the extension weren't there.

Env: `RUYI_URL` (default `http://127.0.0.1:8899`), `RUYI_OWNER` (default `default`).

### Any MCP agent (Claude Code, opencode, ...)

```bash
node /app/ruyi/src/cli.ts mcp
```

Register it as an MCP stdio server; it exposes `ruyi_recall`, `ruyi_list`, `ruyi_get`.

### Plain HTTP — the universal interface

Any agent (or script) that can make an HTTP call can use ruyi: submit raw text
to `/ingest` for distillation, query `/recall` for memories, poll `/inject`
for the constitution+index block. This is what makes ruyi a memory *center*
rather than a plugin.

```
GET  /health
GET  /inject?owner=default
POST /recall            {"query": "...", "k": 5, "owner": "default"}
GET  /memories?owner=default&status=active
GET  /memories/:id
POST /memories/:id/pin  {"pinned": true}
POST /memories/:id/forget
POST /ingest            generic ingestion: {"text": "...", "cwd": "..."} → full distill pipeline
POST /distill
GET  /stats?days=7
```

## Session log parsers

Currently supported: **pi** (`~/.pi/agent/sessions/**/*.jsonl`). Parsers are pluggable — add one in `src/preprocess.ts` and a source entry in `config.local.json`:

```json
"sessions": [{ "agent": "pi", "dir": "~/.pi/agent/sessions", "owner": "default" }]
```

## CLI

```bash
node src/cli.ts list                 # browse the store
node src/cli.ts recall "query"       # test recall
node src/cli.ts pin <id>             # pin = always injected
node src/cli.ts forget <id>          # archive
node src/cli.ts stats                # counts + token usage
```

## Privacy

- Everything stays on your machine: SQLite file + your own LLM endpoint.
- Secrets are excluded at distillation time (instructively and by verification), and the store is plain SQL you can audit and edit.
- `config.local.json`, `data/` and `logs/` are gitignored. Never commit them.

## License

MIT
