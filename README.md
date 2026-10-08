# ruyi (如忆)

**如忆** — "as remembered". An agent-agnostic long-term memory service for AI coding agents and assistants.

Your agent forgets everything between conversations. ruyi gives it a human-like memory: it **dreams** — every night it re-reads the day's conversations, distills what's worth remembering, consolidates it against everything it already knows, and periodically **reflects** scattered memories upward into abstract skill/experience profiles. During the day it recalls precisely the few memories that matter — at graded cost, from free keyword probes to deep semantic recall.

> **安装 / Install**: 把这个仓库丢给你的 agent，让它读 [AGENT.README.md](AGENT.README.md) 并自主完成安装。
> （Clone this repo and hand it to your agent — it installs itself from AGENT.README.md.）

## Design philosophy

- **Memory has altitude.** L3 constitution (pinned core) / L2 profile chapters (abstracted skills & experience, per-domain) / L1 atomic memories / L0 sediment (absorbed & archived, searchable but never auto-loaded). The active working set converges; the archive may grow forever.
- **Cost is graded; tokens are spent only on judgement.** Retrieval runs on indexes (free); only the LLM judgement steps cost tokens. Tentative probes (`fast` mode) cost **zero** tokens and return sub-second.
- **LLM all the way down.** Extraction, verification, consolidation, query understanding and recall ranking are done by an LLM, not string matching. Relevance is judged by meaning, not keywords.
- **Memory is governed, not just stored.** Confidence, evidence counts, origin labels (`user_stated` vs `agent_inferred`). Repeated observations reinforce; contradictions supersede; absorbed knowledge retires upward into profiles; stale inferences decay.
- **Fully optional for the host agent.** A separate local service with short timeouts + per-operation circuit breakers; if it's down, the agent behaves exactly as before.
- **Demand-driven growth.** Recalls that find nothing register *demand signals*; nightly/weekly dreams prioritize filling those gaps (用进废退).

## Architecture

```
            ┌────────────────────────────────────────────┐
            │              ruyi service                  │
            │         (127.0.0.1:8899, localhost)        │
            │                                            │
  nightly   │   SQLite (WAL, trigram FTS)                │
  dream ───▶│     ▲          ▲               ▲           │
  (triage,  │     │          │               │           │
   extract, │  HTTP API   MCP stdio        CLI           │
   verify,  │     │          │               │           │
   merge,   └─────┼──────────┼───────────────┼───────────┘
   decay)         │          │               │
  weekly ───▶ pi extension   Claude Code,   humans (audit,
  reflect       (~/.pi/agent/ opencode,      forget, pin,
  (synthesize   extensions/   any MCP agent  doctor)
   + absorb)    ruyi.ts)
```

- **Zero runtime dependencies.** Plain Node ≥ 23.6 (native TypeScript + `node:sqlite` + `node:http`).
- **LLM**: any Anthropic-compatible (`/v1/messages`) or OpenAI-compatible (`/v1/chat/completions`) endpoint — Anthropic, Kimi, DeepSeek, OpenAI, Qwen, Moonshot, vLLM, Ollama. Two tiers supported: a cheap/fast model for recall, a smart one for dreams (`llm.steps`).

## Recall (graded cost)

| Tier | What | Cost | Latency |
|---|---|---|---|
| T0 inject | constitution + index + profile directory (every session) | 0 tokens | <50ms |
| T1 fast | trigram FTS full-store BM25 ∪ recent ∪ pinned, fusion scoring | 0 tokens | <100ms |
| T2 understand | query → domains/kinds/synonym keywords (only when T1 is sparse) | ~0.6k tokens | 1 LLM call |
| T3 rerank | LLM picks the genuinely relevant few from ≤100 summaries | ~3-4k tokens | 1 LLM call |
| T4 fallback | one more round when T3 came back thin | rare | 1 LLM call |

Modes: `fast` (T1 only — probe freely), `deep` (T1→T3, default), `excavate` (T1 incl. absorbed/archived — archaeology).

Session start (pi extension) never blocks: T0 injects synchronously; deep recall races a 1.2s budget, otherwise lands as a silent follow-up message when ready.

## The dreams (how memory converges)

- **Nightly**: incremental scan → triage (skip empty segments) → extract (candidates with evidence quotes + keywords) → verify (drop hallucinations) → merge (NEW/REINFORCE/REFINE/SUPERSEDE) → reorganize (global dedup/conflict curation) → decay (stale inferences archive).
- **Weekly reflect**: cluster active memories into semantic themes → write/refresh profile chapters (编程习惯, 运维, 中医… — domains never co-load) → **absorb** covered members into the chapter (active set shrinks back). Chapters carry maturity tiers (seeding/mature) with matching advisory tone.
- Every LLM call is token- and latency-accounted (`token_log`, `logs/usage-*.jsonl`); every recall is logged (`recall_log`) as demand signal.

## Repo map

```
src/            service: server, recall, distill, synthesize, reorganize, decay, llm, db, mcp, doctor
prompts/        all LLM prompts (open, principle-style)
examples/pi-extension/ruyi.ts   pi client extension
systemd/        service/timer units (+ templates used by install.sh)
scripts/        install.sh, import/A-B helpers
docs/design-v2.md               the full v2 design document
AGENT.README.md                 self-install manual FOR your agent
```

## License

MIT
