# ruyi v3 design exploration: pure abstract profiles + two-level index + subagent boundaries

> Architecture-direction research proposed by the user on 2026-10-15. **Status: implemented
> (v0.10.0, 2026-10-16)** — two-level profile tree + abstraction mandate + chapter retirement all
> landed; item E (no self-built runtime, no explicit two-hop) stands as concluded.
> *Follow-up: v1.4 (2026-11) further replaced the FTS→understand→rerank pipeline with a single
> selector call over the whole-store listing; the "two-level browse" question (F5) dissolved
> entirely — the selector reads everything at once.*

## The user's conception, abstracted

1. **Product view**: ruyi's output = a purely abstract "user profile set" (methodology / habits /
   tastes / experience). Project codenames never enter profiles; at most they exist as queryable,
   unimportant historical facts.
2. **Organization view**: each direction starts with a category index (e.g. a programming master
   index: performance / documentation / naming…); the AI judges the index first, then loads
   subcategory profiles on demand. Trade two requests for a smaller single request.
3. **Injection view**: neither index nor memory is injected twice (per-conversation dedup, both
   levels enter the ledger).
4. **Architecture view**: the assemble/query/understand process must not pollute the main
   conversation; consider subagents or even a self-built AI; asked whether pi web can host a
   subagent pattern.

## Key empirical findings

### F1. Two-level retrieval already exists, server-side — zero main-conversation pollution
Deep recall happens entirely inside the ruyi server: FTS wide-net → query understanding → LLM
rerank (reading only ≤100 one-line briefs) → final selection returned. The main conversation never
sees the candidate list, only the results.
**The requirement "retrieval assembly must not pollute the main conversation" is already met — the
ruyi server IS that subagent.** The user's imagined explicit two-hop ruyi_recall(index) →
ruyi_recall(memory) would actually be worse: the intermediate index would enter the main
conversation's context, plus an extra tool round-trip.

### F2. pi web can host subagents; no self-built AI needed
pi has no built-in task/subagent tool, but:
- `pi --mode json --print` can programmatically spawn one-shot sessions (verified live: the session
  appears in pi web's list and can be taken over by a human);
- the SDK's `createAgentSession` (Node/TS) creates full sessions programmatically.
An extension delegate tool wraps it. "Outsource heavy work to a subagent" closes inside the pi
ecosystem; a self-built runtime is not worth it for this goal.
Cost math: a subagent carries its own system prompt + tool overhead ~2-5k tokens per run — worth it
only when intermediate products far exceed that (good for "read 20 files and summarize", bad for
"look up one memory").

### F3. Project pollution, measured (28 chapters / 62,413 chars scanned)
The project codenames genuinely needing governance are few (single-digit chapters).
The following are NOT pollution — they're legitimate vocabulary, and abstracting them away would
destroy executability:
- technology/platform words: engines, frameworks, SaaS platforms — the user's activity domains;
- own infrastructure: ruyi, pi-web, server ledgers — the ports/paths/machine models in the
  "Server Ops" / "ruyi Deployment" chapters are executability itself, "digital real-estate ledgers"
  rather than project content.
Boundary rule: **project codenames (one-off ventures / product names) get abstracted; technology
platforms and own infrastructure keep their concreteness.**

### F4. Convergence is working
Active memories 365 → 109 (absorbed into profiles). Two-level profiles will strengthen absorption
further.

### F5. Directory scale decides one hop is enough
28 chapter titles ≈ 1.5k chars, well inside the rerank budget (≤100 lines). **Two-level browsing
(domain first, then subchapter) is unnecessary until the directory exceeds ~100 lines**; but
two-level storage organization has direct value for auto-differentiation and load granularity
(load a 500-char subchapter on demand, not a 2400-char mega-chapter).

## The plan (ordered by value/risk)

### A. De-projectification governance (low risk, high gain, pure prompt + content)
- synthesize / extract / reorganize prompts gain the abstraction mandate: profiles hold only
  methodology/habits/tastes/experience; project codenames are rewritten as abstract lessons
  ("project X requires per-account independently generated material pools" → "content-matrix
  operations: shared copy gets accounts banned together; every account must generate independently");
  project facts may exist only as fact/project memories: queryable, never profile material, never
  routinely injected.
- One-time cleansing: the LLM rewrites 28 chapters (28 cheap calls), **with a per-chapter diff
  report shown to the user before finalizing**.
- The nightly reorganize enforces the same rule incrementally; no new accumulation.

### B. Two-level profile organization (migration v6, medium risk)
- `profiles.parent_id` (nullable): domain chapters (master index) → subchapters.
- synthesize clusters domains first, splits subchapters when density suffices (continuing v0.9.8's
  auto-differentiation, plus a merge layer); subchapters under 300 chars don't stand alone (guard
  against shredding related experience).
- The directory renders as a two-level one-line tree; rerank stays single-hop (directory ≤100
  lines), auto-degrading to two hops over budget.
- Ledger item = `p:<id>` unchanged; domain chapters and subchapters both enter the ledger; old
  ledgers stay valid.

### C. Should the static menu (index+directory, ~2k chars/turn) inject only once per conversation
- Status quo: re-sent every turn but prefix-cache hits make the marginal cost ≈ 1/10 price —
  negligible.
- Switching to historical-message injection: saves the cache-read price, but the menu is lost after
  compaction, which is hard to detect.
- **Recommendation: keep the status quo** (this deviates from the user's "index never re-injects" —
  an intentional deviation requiring the user's call).

### D. delegate subagent tool (independent small feature, last / optional)
An extension tool spawns a `pi --mode json` one-shot session to execute heavy tasks, returning only
the result to the main conversation.

### E. Not doing
- self-built agent runtime (the retrieval subagent is already the ruyi server);
- explicit two-hop ruyi_recall(index→memory) (worse than server-side single-hop, see F1).

## Risks
- over-abstraction losing executable detail → F3 whitelist + cleansing diff report for human review;
- subchapters too fine, shredding related experience → 300-char floor;
- cleansing damaging traceability → only profile text is rewritten; source memories untouched.
