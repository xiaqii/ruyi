# ruyi v2 design document

> **Status: historical design document.** This records the v2 architecture decisions of early
> October 2026 (altitude layering, cost tiering, convergence mechanisms) — these mechanisms remain
> the foundation of the current architecture. Evolution after v2 is tracked in
> [CHANGELOG](../CHANGELOG.md): 0.3 remote MCP bridge → 0.4 self-describing landing page →
> 0.5/0.6 session sync layer → 0.7 auth moved server-side → 0.8 per-conversation injection ledger
> + topics/replies turn-by-turn bookkeeping. **Note: the tiered T0–T4 retrieval described below was
> superseded in v1.4 by a single selector call reading the whole-store listing (every memory's
> one-line "mini" + every chapter's abstract) — keyword retrieval no longer gates the candidate
> pool.** Where individual "future tense" descriptions conflict with the present, the present wins.

> Goals: accurate, fast, cost-tiered, a store that converges instead of sprawling.
> Unchanged principles: LLM all the way down (judgement by semantics, not strings); zero runtime
> dependencies (node:sqlite + node:http); fully optional for the host agent (its failure changes nothing).

## 0. Core mental model: memory has altitude

The human brain doesn't reload hundreds of thousands of episodic memories; it abstracts
"episode → semantic → schema" layer by layer. ruyi v2 stores by altitude in four layers:

```
L3 constitution   ~10-20 entries   pinned + graduated habits (high-confidence preferences with
                                   evidence≥5) + profile directory pointers
                                   unconditionally injected per session (pure SQL, 0 tokens, <50ms)

L2 abstraction    ~5-15 chapters   thematic profiles (coding habits / performance tricks /
                                   infrastructure topology / shopping philosophy…)
                                   distilled by the LLM reflecting over L1; loaded on demand,
                                   at most 1 chapter per turn

L1 episode        target ≤300 active
                                   atomic memories (preference/fact/lesson/knowledge/skill_index),
                                   with keywords, evidence count, confidence, timestamps.
                                   The retrieval workhorse; everything in FTS.

L0 sediment       unlimited rows   absorbed (folded into profiles) / superseded / archived
                                   never auto-loaded, but kept in FTS for "archaeology".
```

**Core invariant: the amount loaded per turn is decoupled from total store size.** The active set
(L3+L2+L1-active) converges bounded; L0 grows freely.

## 1. Cost tiering: tokens are spent only when worth it

Lookup cost climbs with depth; shallow probes cost **zero tokens**:

| Tier | Mechanism | Latency | Token cost | Use |
|---|---|---|---|---|
| T0 inject | pure SQL: constitution + recent/high-evidence index + profile directory | <50ms | 0 | every session start |
| T1 fast lookup | trigram FTS whole-store BM25 ∪ recent ∪ pinned, fused scoring | <100ms | 0 | tentative probes (fast mode) |
| T2 query understanding | 1 small LLM call (thinking off): query → {domain, kind, time window, 3-5 synonymous keywords} | +1 call | ~500 in / ~150 out | adaptively triggered only when T1 hits are thin |
| T3 semantic rerank | 1 LLM call (thinking off): ≤100 one-line briefs → chosen ids + ≤1 profile chapter | +1 call | ~4k in / ~300 out | deep mode main path |
| T4 fallback deep-dig | when T3 returns too few and unscored FTS hits remain, add candidates and rerank again | +1 call | rare | long-tail questions |

The `ruyi_recall` tool's three modes:

- **fast**: T1 only, 0 tokens, sub-second. For the agent's bulk preliminary probing; returns a
  `score_hint` so the agent can decide whether to upgrade.
- **deep** (default): T1 → (T2 when thin) → T3 → (T4 when insufficient). A typical deep = 1 LLM call.
- **excavate**: fast + `include_archived`, digging the L0 sediment — archaeology for "how did I
  handle X before".

**Zero-wait session start** (pi extension rework): `before_agent_start` synchronously awaits only
T0 injection; deep recall runs in the background and is delivered as an in-conversation message when
ready. However slow the LLM endpoint, startup never stalls.

## 2. Retrieval: whole store reachable, fused signals

### 2.1 Foundation repair (live bug)

FTS5's default unicode61 tokenizer treats an entire Chinese passage as one token — Chinese keyword
matching had a 0% hit rate. v2 rebuilds FTS as **trigram** tokenization (CJK substrings matchable),
index columns: `summary + keywords + content`.

### 2.2 Candidate eligibility gates removed

Old design: only `evidence≥3 OR within 60 days` qualified for candidacy, FTS enabled only past
300 entries — precisely the design to lose "the trap I stepped into once two years ago", the most
valuable kind of memory. v2: **all active memories participate in FTS unconditionally** (inverted
index cost ∝ matches, independent of total size).

### 2.3 Fused scoring

```
score = BM25 relevance × (1 + recency boost + log(1+evidence) boost + pinned boost + scope-match boost)
```

- Relevance dominates: a strong clue recalls an old memory (a two-year-old exact-hit lesson beats
  yesterday's weakly related note)
- Time is a weak boost and tiebreaker, never a gate
- Only when T2 query understanding extracts an explicit time hint ("recently", "last year") does
  time become a hard filter

Candidate union: `FTS top-60 ∪ recent 20 ∪ pinned ∪ (when T2 fires: same-domain/time-window
supplements)`, deduped and truncated to ≤100 one-line briefs for T3.

### 2.4 Why no vectors

At personal-memory scale (L0 up to tens of thousands), trigram FTS (literal/substring) + LLM query
expansion (synonym/semantics) + LLM rerank (final judgement) already cover the value of vectors;
introducing sqlite-vec / an embedding service would break the zero-dependency principle and add
deployment complexity. Listed as a v3 candidate, to be decided by A/B data.

## 3. Convergence and abstraction: the store doesn't grow forever

### 3.1 Existing mechanisms (kept, aligned to the new state machine)

- **merge** (nightly): NEW / REINFORCE / REFINE / SUPERSEDE — incremental dedup
- **reorganize** (nightly): whole-store dedup, conflict resolution, archiving the worthless;
  pushes harder when over targetSize
- **decay** (nightly): low-confidence inferences unseen for 90 days → archived

### 3.2 The absorption mechanism (v2's core addition)

synthesize upgrades to "deep sleep" reflection (weekly / after large imports):

1. **Cluster**: semantically cluster active memories (not by domain tag, by meaning — a Python
   lesson and a PHP lesson cluster into the same "coding habits" theme), producing ≤10 themes
2. **Author chapters**: write/refresh a profile chapter per theme from members' full text (existing
   logic), version+1
3. **Absorb**: member memories fully covered by a chapter → `status='absorbed', absorbed_by=profile_id`:
   - exemptions: pinned, graduated habits (evidence≥5), anything still warm within 30 days
   - the absorbed stay in L0, diggable via FTS, no longer occupying the active retrieval surface
4. **Theme evolution**: clustering reruns from scratch each time; themes merge naturally
   (Python+PHP → coding habits) and split; vanished themes keep their old chapters (stale beats
   gone) and refresh on reappearance

### 3.3 Steady-state loop

```
Daytime: use → session logs accumulate
Night dream: triage→extract→verify→merge→reorganize→decay   (L1 incremental governance)
Week dream: synthesize + absorb                              (L1 → L2 upward abstraction)
Result: L1 active converges at the target waterline (default 300);
        one's "memories, experience, skills" end state = L2 profile chapters + L3 constitution;
        L0 is write-only and never auto-loads.
```

## 4. Skill slots and the demand loop

### 4.1 Principle: an empty slot does not load a "default generic skill"

An LLM's general knowledge was frozen into its weights at training time and comes free with every
call. Stuffing "generic tutorials" into an empty slot pays to duplicate existing capability and
dilutes the truly valuable user increment. ruyi's value = the user's increment over general
knowledge (environment, habits, traps).

### 4.2 Slot lifecycle

```
gap → seeding → mature → (stale if unrefreshed for long)
```

- **gap**: demand without accumulation; registered, no injection-side action
- **seeding**: member memories below the chapter threshold — they're ordinary L1 memories on the
  normal retrieval path; under strong demand the night dream may pre-write a "seeding chapter"
  headed `maturity: partial experience`
- **mature**: a formal profile chapter, at most 1 loaded per session, only when the conversation
  lands in its domain

### 4.3 Injection tone graded by maturity

Preventing partial experience from steering the LLM in the posture of "rules" (instruction
hierarchy pollution):

- seeding chapter: "partial past experience, for reference only, not rules"
- mature chapter: "long-formed habits and experience; follow by default unless they conflict with
  current needs"
- the floor under all injection: "never overrides what the user says right now"

### 4.4 The demand loop

```
Daytime: recall_log records each lookup {judged domain, hit count, quality, latency}
         thin-hit domains → demand count +1
Night dream: triage lowers the pass threshold on demand-domain passages (capture material first)
         synthesize orders chapter-writing by (demand count, member count) (fill gaps first)
Week dream: enough gap accumulation → seeding chapter → mature chapter, versions evolve
```

Use it or lose it: demand signals drive the direction of consolidation; the slot system becomes the
production-side engine of a "to-be-completed pool".

### 4.5 Domain isolation

Profiles chapter by semantic theme (coding/photography/ops/language-learning don't interfere):
T3 rerank reads only the title directory (~10 lines) and picks at most 1 chapter; the L3
constitution layer holds the directory, not the content; the agent can pull any chapter via tools.

## 5. Multi-protocol LLM adaptation

```jsonc
"llm": {
  "protocol": "anthropic",           // "anthropic" | "openai"
  "baseUrl": "...", "apiKey": "...", "model": "...",
  "thinking": "off",                 // "off" | "default" | number(budget); best-effort, degrades on rejection
  "steps": {                         // two-tier override: recall on a fast/cheap model, dream on a smart one
    "recall": { "model": "...", "protocol": "...", "baseUrl": "...", "apiKey": "..." },
    "dream":  { "model": "..." }
  }
}
```

- openai protocol: `/v1/chat/completions`, covering DeepSeek / Qwen / OpenAI / Moonshot / vLLM /
  Ollama; auto-switches to `max_completion_tokens` when `max_tokens` is rejected; auto-enables
  `response_format: json_object` where supported
- anthropic protocol: as before; thinking off/budget verified live
- step classification: `recall` tier = selection-side steps; `dream` tier =
  triage/extract/verify/merge/reorganize/synthesize
- token accounting normalized across both protocols; token_log gains a `latency_ms` column

## 6. Robustness and operations

- **Graded circuit breakers**: injection timeouts no longer drag down `ruyi_remember`; independent
  breakers per operation type; timeouts inject 2s / recall 30s / remember 45s
- **schema migration**: driven by `PRAGMA user_version`; the v2 migration = add keywords/absorbed_by
  columns + trigram FTS rebuild + keywords backfill (existing entries batched 20 per LLM call)
- **ruyi doctor**: service liveness / DB counts / FTS Chinese self-check / LLM connectivity+latency
  live test / extension install detection
- **Backups**: `VACUUM INTO` snapshot before every dream, 7 retained
- **Security**: binds 127.0.0.1 by default; config.local.json mode 600; data/ logs/ profiles/ all
  gitignored
- **First-dream cost control**: `dream.initialMaxDays` (default 14 days); estimated volume is shown
  before unleashing the full corpus
- **Multi-user**: the pi extension reads the `RUYI_OWNER` env var (schema already carries the owner
  field, currently always default; multi-user can return in future)

## 7. Release form

- `scripts/install.sh`: environment check → config guidance → systemd (with root) or nohup+cron
  (without) → smoke test
- **AGENT.README.md**: the self-install manual written for agents (detect → branch → commands →
  verify each step → fallbacks); the human README takes the "experience, not technology" route
  (zero-friction old topics in new chats, no repeat injection, five knowledge kinds, profile
  convergence); all details live in the AGENT doc
- pi extension updated in step: L0 zero-wait injection, three-mode recall tool, RUYI_OWNER

## 8. Implementation phases

| Phase | Content | Verification |
|---|---|---|
| P1 foundation | migration framework, trigram FTS rebuild, keywords column+backfill, absorbed_by column, graded breakers, latency_ms, recall_log | doctor all green; the "Aliyun" use case hits |
| P2 recall | T1 fused scoring, fast/deep/excavate modes, adaptive T2, extension zero-wait rework | real query-set A/B: old vs new hit rates; latency distribution |
| P3 abstraction | synthesize v2 absorption, theme evolution, slot lifecycle, demand loop (triage tilt + gap priority), tone grading | two simulated week-dreams: active count drops, profile coverage, gaps filled first, archaeology works |
| P4 compatibility | openai protocol, two steps tiers, thinking control | DeepSeek endpoint live-tested through extract+recall end to end |
| P5 release | install.sh, AGENT.README.md, systemd templating, gitignore finish, push | clean-machine clone → agent self-installs successfully |

The old recall pipeline was kept as the `recall.pipeline: "legacy"` switch for one version cycle,
for rollback and A/B.
