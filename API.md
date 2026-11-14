# ruyi API Contract

This document is the **single authoritative definition** of ruyi's external interface, maintained in
lockstep with the code: before every release, `test/api-contract.ts` verifies the response structure
of every endpoint declared here against a running service — any mismatch fails the release.
If your agent wants to integrate with ruyi via its own scripts/extensions, implementing against this
document is sufficient.

Two integration surfaces with equivalent capability:

| Surface | Best for | Transport |
|---|---|---|
| **HTTP API** | any agent/script that can make HTTP requests (incl. remote machines) | `http://<host>:<port>` (default `127.0.0.1:8899`) |
| **MCP stdio** | clients with native MCP support (Claude Code / opencode, local machine) | `node <repo>/src/cli.ts mcp` |

## General conventions

- **Auth**: ruyi does its own auth, independent of any reverse proxy. Local direct connections
  (127.0.0.1 without proxy headers) are auto-allowed; requests arriving via a proxy/tunnel (carrying
  `X-Real-IP` / `X-Forwarded-For`) or from the LAN must carry `Authorization: Bearer <authToken>`
  (configured in the server's `config.local.json`), otherwise 401; if no token is configured,
  remote requests get 503 (fail-closed). `GET /` and `GET /health` are always public.
- **owner**: every endpoint accepts an `owner` parameter (query or body), default `"default"`.
  Multiple agents of the same person share one memory pool via the same owner; use different
  owners for different people or isolation needs.
- **Errors**: uniform `{"error": "..."}` + non-200 status code.
- **Timeout guidance** (important): pure-SQL endpoints (inject/list/get/forget/stats/profiles/
  recall-fast) return in hundreds of milliseconds — a 5s client timeout is plenty. **LLM-backed
  endpoints** (recall-deep/excavate, POST /memories, ingest, synthesize, distill) take as long as
  the LLM takes — **client timeout must be ≥45 seconds**, with circuit-breaking recommended: when
  the service is unavailable the agent should work exactly as before, just without long-term memory
  this turn. ruyi is a sidecar, not a dependency; never let an agent block on the memory service.

## HTTP endpoint overview

| Method Path | Purpose | LLM |
|---|---|---|
| GET `/health` | liveness + memory counts by status (no auth) | none |
| GET `/inject` | opening bundle: profile directory tree | none |
| POST `/recall` | semantic recall of memories & profile chapters | fast: none / deep, excavate: yes |
| GET `/memories` | list memories (one-line summaries) | none |
| POST `/memories` | explicitly write one memory (via LLM merge adjudication) | yes |
| GET `/memories/:id` | fetch one memory in full | none |
| POST `/memories/:id/forget` | archive (soft delete, excavatable) | none |
| POST `/ingest` | submit raw text into the dream distillation pipeline | yes |
| POST `/sync/session` | push session-log increments (offset append, resumable) | none |
| GET `/sync/state` | query stored byte counts per session on a machine (reconciliation) | none |
| GET `/profiles` | list profile chapters (summaries) | none |
| GET `/profiles/:id` | fetch one profile chapter in full | none |
| POST `/synthesize` | re-distill profiles now (normally driven by the nightly timer) | yes |
| POST `/distill` | run one dream now (async, 202) | yes |
| GET `/stats` | memory counts + token usage report | none |

---

### GET /inject — profile directory tree (cheap, call freely)

```
GET /inject?owner=default&cwd=/path/to/project&scope=smart
```

| Param | Value | Notes |
|---|---|---|
| `owner` | string | default `default` |
| `cwd` | string | current working directory, for directory scoping |
| `scope` | `smart`(default) / `cwd` / `all` | smart = globally visible + this directory's memories; cwd = strictly this directory; all = whole store |

Response `200`:

```json
{
  "constitution": [],
  "profileDirectory": [{ "id": 3, "title": "AI agents & memory systems", "maturity": "mature", "parent_id": null },
                       { "id": 71, "title": "Testing & release discipline", "maturity": "mature", "parent_id": 76 }]
}
```

**Usage**: the `constitution` field is retired (always empty since v0.10.4 — global iron rules belong in the
agent platform's own AGENTS.md/CLAUDE.md). `profileDirectory` is the **classification index** of profile
chapters: a two-level tree (`parent_id` null = domain index chapter; otherwise it points at the parent
domain), render grouped by parent_id; fetch full text via `/recall` or `/profiles/:id`.
There is no static memory index anymore — topic-relevant content arrives per-turn via `/recall` semantic
injection. Pure SQL; call at any frequency.
Since v1.4 the directory tree primarily serves as **server-side selection material** (the selector reads
the listing to pick chapters); thin clients need not render it into context at all — the pi philosophy is
zero-resident context, with discovery and selection entirely server-side. Clients that want a directory
(e.g. a one-shot session-start Claude hook) may still fetch it themselves.

### POST /recall — semantic recall

```json
{
  "query": "natural-language description of the current task",
  "k": 6,
  "owner": "default",
  "cwd": "/path/to/project",
  "scope": "smart",
  "mode": "deep"
}
```

| Field | Notes |
|---|---|
| `query` | required, non-empty |
| `k` | max memories returned; server-configured default (6) |
| `mode` | `fast` = pure keyword probe, zero LLM; `deep` (default) = one selector LLM call over a whole-store listing (every active memory's one-line "mini" + every chapter's abstract), picks what matters; `excavate` = also dig absorbed/archived memories |
| `conversation` | **required when paired with `auto`** — the caller's unique conversation id (e.g. `pi:<sessionId>`). The server assigns it an internal `topic_id` (autoincrement) and numbers each turn a `reply_id`; the injection ledger records what was actually injected each turn. `auto=true` without it returns `400` |
| `auto` | optional; `true` marks the **automatic injection** path: the server filters items already injected into this conversation (response carries a `deduped` count), and short-circuits with an empty result — skipping the LLM call entirely — when every candidate was already injected. The response also carries `topicId`/`replyId` (server-assigned turn numbers). **Do not** pass these two parameters for agent-initiated tool queries |

**Topic context (since 0.9)**: calls carrying `conversation` get the topic's rolling summary plus the most
recent turns' raw text fed into the selector alongside the query, so bare follow-ups ("which ones can't he
eat?") are judged against the topic's subject. The summary rides along on the selector's output (zero extra
calls); long-silent topics are backstopped by low-frequency increments. Fully transparent to the caller:
omit `conversation` and behavior is unchanged.

Response `200`:

```json
{
  "memories": [{ "id": 86, "owner": "default", "cwd": null, "kind": "fact", "domain": "...",
                 "summary": "...", "content": "...", "keywords": "...",
                 "origin": "user_stated", "confidence": 0.9, "evidence": 3, "source": null,
                 "pinned": 0, "status": "active", "superseded_by": null, "absorbed_by": null,
                 "created_at": "...", "updated_at": "...", "last_seen_at": "..." }],
  "profiles": [{ "id": 3, "owner": "default", "theme": "agent-memory", "title": "...", "content": "...",
                 "memory_ids": "[...]", "version": 2, "maturity": "mature", "status": "active",
                 "created_at": "...", "updated_at": "..." }]
}
```

On no hits, `memories` and `profiles` are both empty arrays (not an error).

### POST /replies/answer — report the assistant's answer (raw material for per-turn gists)

After each turn the agent reports its answer (fire-and-forget); the server attaches it to the
conversation's latest unanswered reply row and asynchronously distills a 1–2 sentence gist (recall tier,
off the injection path). Gists together with the raw answers form the layered topic context for future
recall (topic_summary + per-turn gists + the last 3 user turns verbatim, assembled under a 32K budget) —
answer-side entities of bare follow-ups ("and its price?") stay anchored instead of drifting.

```json
{ "conversation": "pi:<sessionId>", "answer": "the assistant's full answer this turn" }
```

| Field | Notes |
|---|---|
| `conversation` | required, same identifier as /recall |
| `answer` | required; truncated to 20000 chars and secret-redacted server-side (raw text kept in full) |

Response: `201 {"attached":true}` when attached to a pending reply; `200 {"attached":false}` when the
conversation has no pending reply (e.g. this turn triggered no recall) — both normal. Gist failure never
leaves a hole: assembly falls back to truncated raw text for that turn.

The nightly pipeline re-writes gists of active topics weekly from the raw answers using the dream tier
(thinking model), repairing daytime fast-model drift (gists are a regenerable view; raw text is the only
source of truth). Manual trigger: `ruyi regen-gists [--days 7] [--limit 150]`.

### POST /injection-log/clear — client compaction notice (reset the injection ledger)

When an agent client compacts its context (e.g. pi's session_compact), injected memory cards leave the
model's context, but the injection_log still counts them as injected — without a reset they would silently
never be re-sent (long conversations quietly lose memory). This endpoint clears only the conversation's
injection-dedup ledger so memories can be re-injected on the next turn; topics/replies history is kept.

```json
{ "conversation": "pi:<sessionId>" }
```

Response `200 {"cleared": <rows deleted>}`; missing conversation returns 400. The pi extension calls this
fire-and-forget on the session_compact event.

### POST /memories — explicit write ("remember this")

```json
{
  "kind": "preference",
  "summary": "one-line summary (≤30 words)",
  "content": "full content, concrete and self-contained",
  "domain": "optional tag",
  "owner": "default",
  "cwd": null,
  "confidence": 0.9
}
```

`kind` ∈ `preference | fact | knowledge | lesson | skill_index` (default `fact`).
Writes go through the **same LLM merge adjudication** as the nightly dream — duplicate content becomes
reinforcement rather than a new entry. **Takes ~10s; client timeout must be ≥45 seconds.**

Response `200/201`: `{ "id": 400, "action": "new" | "reinforced" | "refined" | "superseded" }`

### GET /memories — list

`GET /memories?owner=default&status=active&limit=100` → `{ "memories": [MemoryRow...] }`
`status` ∈ `active`(default) `| absorbed | superseded | archived`.

### GET /memories/:id

→ `{ "memory": MemoryRow }`, `404` if missing.

### POST /memories/:id/forget

→ `{ "ok": true, "id": 400, "status": "archived" }`. Archiving = soft delete: no longer injected/recalled,
but still diggable via `recall mode=excavate`. Also leaves a **tombstone** (a content fingerprint, never
the text): every write path (dream/remember/ingest/merge) rejects the same content thereafter, so a
forgotten memory can't be re-distilled back to life from old logs.

### POST /ingest — submit raw material

```json
{ "text": "raw conversation/notes text (≥50 chars)", "source": "origin tag", "owner": "default", "cwd": null }
```

Runs the full distillation pipeline synchronously (triage → extract → merge); the response is the
distillation report (JSON). Suitable for agents without a configured `sessions` directory to hand in
conversation records proactively.

### GET /profiles · GET /profiles/:id

`/profiles?owner=default` → `{ "profiles": [ProfileRow...] }` (full `content` included; the list is long).
`/profiles/:id?owner=default` → a single ProfileRow (full text).

### POST /synthesize · POST /distill

Admin triggers; agents normally don't call these (the nightly timer does). `/synthesize` body
`{ "owner": "default" }`, returns the re-distillation report synchronously; `/distill` is async
(`202 {"started": true}`, or `409` if a dream is already running).

### GET /stats — reports

`GET /stats?days=7&owner=default` →

```json
{
  "counts": { "active": 364, "archived": 9, "superseded": 27 },
  "tokenUsage": [{ "day": "2026-10-08", "step": "extract", "input": 12345, "output": 678 }]
}
```

### POST /sync/session — session-log incremental sync

Remote machines push agent session logs to ruyi (raw material for nightly dreaming). Offset append +
content-addressed dedup:

```json
{ "machine": "win11-laptop", "agent": "claude-code", "sessionKey": "proj-a/abc.jsonl",
  "sessionUid": "unique session id extracted from content", "totalSize": 23245,
  "offset": 12345, "data": "the new bytes" }
```

- `machine`: source machine identifier (stable; distilled environment facts are tagged with it);
  `agent`: log format (`claude-code`/`pi`); `sessionKey`: relative path of the session file
- `sessionUid`: content-addressed session identity (claude-code: first line's `sessionId`; pi: filename
  uuid). The same uid arriving via any channel points at the same server-side storage — a session
  previously imported by hand and later pushed via the sync protocol is **skipped with zero transfer**
  (`{"already": true}`) or topped up with only the true increment
- `offset` must equal the server's stored byte count, otherwise `409 {"receivedBytes": <actual>}` —
  the client resumes from that offset
- Response `200 {"receivedBytes": <new total>}`; bytes must be split on UTF-8 character boundaries
  (see `examples/sync-sessions.mjs`)

**Line mode (v2, preferred)** — clients slim locally and push whole JSONL lines instead of bytes:

```json
{ "machine": "win11-laptop", "agent": "pi", "sessionKey": "sess/abc.jsonl",
  "sessionUid": "…", "fromLine": 400, "lines": ["{…}", "{…}"] }
```

- `fromLine` must equal the server's stored line count for that session, otherwise
  `409 {"storedLines": <actual>}` — the client resumes from that line index
- `agent` is whitelisted in line mode (`claude-code`/`pi`/`codex`); unknown formats are rejected loudly
- Response `200 {"storedLines": <new total>}`; slimming must never drop lines — line indexes stay 1:1
  between the original file and the server copy
- **Compression**: request bodies >50KB should be gzipped (`content-encoding: gzip`) — session text
  compresses ~5–10×; the server's decompression ceiling is 32MB (zip-bomb guard)
- Data lands under `data/synced/<machine>/` on the server and automatically becomes a dream session
  source; portions already distilled via other channels inherit the original byte offset and are not
  re-distilled by the LLM
- One-time backfill: a machine switching to the new sync mechanism should first run
  `node src/cli.ts sync-index` on the server to register existing session sources in the UID table

### GET /sync/state — reconciliation

`GET /sync/state?machine=win11-laptop` → `{ "machine": "...", "sessions": { "proj-a/abc.jsonl": 23245 } }`

Reference sender implementation: `examples/sync-sessions.mjs` (incremental, progress display, resumable,
`--status` reconciliation).

---

## MCP tools (stdio)

Launch: `node <repo>/src/cli.ts mcp`. Protocol version `2024-11-05`, standard JSON-RPC line-based stdio.
Six tools, parameters mapping one-to-one onto HTTP semantics (tool names carry no prefix — clients add
the server name automatically: shown as `ruyi_recall` in opencode, `mcp__ruyi__recall` in Claude Code):

| Tool | HTTP equivalent | Parameters (* required) |
|---|---|---|
| `recall` | POST /recall | `query`*, `k`, `mode`(fast/deep/excavate), `owner` |
| `list` | GET /memories | `limit`, `owner` |
| `get` | GET /memories/:id | `id`* |
| `ingest` | POST /ingest | `text`*, `owner`, `cwd` |
| `remember` | POST /memories | `summary`*, `content`*, `kind`, `domain`, `owner` |
| `admin` | pin/forget/stats/profiles | `action`*(forget/stats/profile), `id`, `days`, `profileId`, `owner` |

Client config examples (Claude Code: `claude mcp add ruyi -s user -- node <repo>/src/cli.ts mcp`;
opencode and other MCP clients analogous — see their docs).

## Recommended minimal agent integration

1. **Per user turn**: `POST /recall` with `conversation`+`auto:true` — server-side selection, dedup,
   and topic context all included (the reference implementation races a sync budget and degrades
   gracefully; see `examples/pi-extension/ruyi.ts`).
2. **When remembering is needed**: `/recall` — probe with `mode=fast` (free), use `deep` for important
   answers, `excavate` for archaeology.
3. **User says "remember …"**: `POST /memories` (timeout ≥45s).
4. **Hand in conversation material**: either point the server's `config.local.json` `sessions` at the
   log directory (nightly dreams, recommended), or actively `POST /ingest`, or run
   `examples/sync-sessions.mjs` from remote machines.
5. **Fault isolation**: every call gets a timeout + circuit breaker (pause calling for a few minutes
   after consecutive failures); if the service is down the agent must work exactly as before.
6. **On client context compaction**: `POST /injection-log/clear` so dedup doesn't permanently silence
   compacted-away memories.

Reference implementation: `examples/pi-extension/ruyi.ts` (pi extension; the full treatment — circuit
breaking, tiered timeouts, async injection racing, compaction reset, answer reporting).
