# AGENT.README — set up ruyi (如忆) for your agent

> This document is written for **AI agents**, not humans.
> Your task: **autonomously install, configure, launch, connect, and verify ruyi**.
> Principles: verify every step; on failure follow the fallback guidance, never force your way through;
> any step that costs money (the first dream) requires the user's explicit consent first.

## Route yourself: which scenario?

- **Scenario A: install the service on this machine** — the user gave you only the repo URL; ruyi isn't
  running anywhere yet → follow §0–§4 (ask the user for an install directory; default to cloning into `~/ruyi`)
- **Scenario B: connect to a remote instance** — the user gave you a service URL and token
  (`RUYI_URL` + `RUYI_TOKEN`); ruyi already runs elsewhere → **do not clone, do not run install.sh, do not
  install the service**. The simplest first step: fetch the service URL (`curl https://<url>` or WebFetch) —
  **the service itself is the manual**; the returned text tells you what to do. Or read §5 "Remote access".

- **Scenario C: update an existing install** — the user says ruyi released a new version → §5c.

ruyi is a long-term memory service: at night it re-reads your session logs and distills what's worth
remembering into memories; by day you query it via HTTP API / pi extension / MCP. Install it and your
agent gains cross-session memory.

## Installation overview: two steps

**Step 1: install and launch the ruyi service** (§0–§4: gather config → check environment → install →
write config → start). Afterwards ruyi is a resident HTTP service anyone can connect to.
**Placement advice**: if the user has multiple devices, install ruyi on **an always-on host reachable
from all of them** (a cloud host is ideal, or a home server with a tunnel) — every device's agent connects
to the same instance and memory stays in one place. Installed locally, only the local agent can use it
(MCP-stdio is a local mode).

**Step 2: connect yourself (the agent) to ruyi** (§5). Pre-built connector files for common clients
**already exist in `examples/`**:

| Client | Connector | Pre-built file |
|---|---|---|
| pi / pi web | extension (fullest: auto-injection + tools + graceful degradation) | `examples/pi-extension/ruyi.ts` |
| Claude Code | MCP | one `claude mcp add` command, or `examples/claude-code/.mcp.json` |
| opencode | MCP | `examples/opencode/opencode.jsonc` |
| other agents / custom scripts | HTTP or MCP | `examples/http-client.mjs` (20-line reference) + [API.md](API.md) |

**Windows users**: install.sh is a Unix script (systemd/nohup/cron) — don't force-run it on Windows;
the §4b manual Windows path is much faster than fighting bash.

## 0. What you need from the user

Before starting, confirm with the user (all three required):

1. **LLM endpoints — ideally TWO models** (this is the one design expectation ruyi makes):
   - **REQUIRED for a usable experience**: a cheap fast model **capable of turning thinking OFF** for the per-turn selection/probe tiers (`steps.recall` / `steps.probe`). Selection runs on every user message — with thinking on, the user waits seconds per turn all day for zero quality gain (measured). A model that cannot disable thinking makes ruyi feel broken; treat this as a hard requirement, not a preference
   - a **strong model** for the nightly distillation tier (base `llm`) — extraction quality is where money matters
   - One model alone works, but doctor will WARN: you'd be running every turn's selection on your premium model
   - Free route for the recall tier: new DashScope accounts get 1M free tokens on qwen3.7-flash; deepseek-chat and claude-haiku-4-5 also work well
   - ruyi speaks two protocols — ask which one each endpoint is:
     - `anthropic` protocol: Anthropic official, Kimi coding endpoint, etc. (path style `/v1/messages`)
     - `openai` protocol: DeepSeek, OpenAI official, Qwen, Moonshot, vLLM, Ollama, etc. (`/v1/chat/completions`)
2. **Session log directory**: ruyi dreams by reading your session logs.
   - pi: usually `~/.pi/agent/sessions` (pi web deployments may differ — confirm!)
   - Claude Code: `~/.claude/projects`
   - other agents: after confirming the log format, a parser may be needed (see §7 troubleshooting)
3. **How you (the agent) run on this machine**: pi / Claude Code / other? Determines the client in §5.

## 1. Environment check

```bash
node --version   # must be >= 23.6 (uses node:sqlite and native TypeScript)
```

If too old, guide the user to upgrade Node; do not attempt workarounds.

## 2. Install

```bash
cd <this repo>
bash scripts/install.sh
```

install.sh will: check node → `npm install` (dev deps only) → generate `config.local.json` →
(with root + systemd) install the systemd service and nightly timers, otherwise print the nohup/cron
fallback → run doctor.

Optional flags: `--dream` (run the first dream right after install — costs tokens, ask the user first),
`--no-auto-update` (disable daily self-update, on by default, see §5b).

Without root/systemd, follow the fallback printed by install.sh (nohup residency + cron night-dream).

## 3. Configure `config.local.json`

**Credentials never pass through chat.** API keys typed into a conversation end up in session logs
forever. Instead: write the config template yourself, then tell the user — "fill your key(s) into
`<dir>/config.local.json` (`llm.apiKey`, and `llm.steps.recall.apiKey` if you have a second model),
tell me when done." The file is chmod 600. When they say done, run `ruyi doctor` — it verifies both
tiers against the live endpoints and WARNs with exact fix suggestions if the recall tier is missing
or thinking isn't off. If the user says their keys already live in a local file, read that file
yourself (file reads are fine) — just never echo the key back into the conversation.

Minimal viable config (replace example values with the user's):

```jsonc
{
  "llm": {
    "protocol": "openai",                      // or "anthropic"
    "baseUrl": "https://api.deepseek.com",     // openai protocol: up to the domain or .../v1
    "apiKey": "the user's key",
    "model": "deepseek-chat",
    "thinking": "default"
  },
  "sessions": [
    { "agent": "pi", "dir": "~/.pi/agent/sessions" }   // adjust to the real path
  ]
}
```

Recommended (when the user has two models) — recall tier (selection) on a cheap fast model with thinking
off, dream tier on the smart model:

```jsonc
"llm": {
  "protocol": "anthropic", "baseUrl": "...", "apiKey": "...", "model": "claude-sonnet-4-5",
  "steps": {
    "recall": { "protocol": "openai", "baseUrl": "https://api.deepseek.com",
                "apiKey": "...", "model": "deepseek-chat", "thinking": "off" }
  }
}
```

Multi-key failover (optional): use `"apiKeys": ["primary", "backup"]` instead of a single apiKey — when a
key is rejected (401/403/429, e.g. a weekly quota runs out) the next is tried automatically and the
service never goes down. Configurable per tier.

Then:

```bash
chmod 600 config.local.json        # it contains a key
node src/cli.ts doctor             # must be all PASS (WARN acceptable if you know why)
```

doctor's LLM check really calls both model tiers once each (negligible cost) and reports latency.
If the LLM check FAILs: wrong protocol, wrong key, or wrong model name — fix per the error and rerun doctor.

## 4. Start the service

install.sh handles the systemd case. Manual case:

```bash
nohup node src/cli.ts serve >> logs/serve.log 2>&1 &
curl -s http://127.0.0.1:8899/health    # {"ok":true,...}
```

## 4b. Windows manual path (do NOT run install.sh)

The ruyi core is pure Node and cross-platform; but install.sh is a Unix script (systemd/nohup/cron) —
running it on Windows wastes time. Four manual steps instead:

```powershell
# 0. Confirm node --version >= 23.6
git clone https://github.com/xiaqii/ruyi.git; cd ruyi
npm install                          # dev deps only (typescript)
copy config.example.json config.local.json
notepad config.local.json            # fill llm.baseUrl/apiKey/model + sessions dir
node src/cli.ts doctor               # all PASS before continuing
node src/cli.ts serve                # foreground; for background use pm2 or Task Scheduler
```

Nightly dream: add a daily task in Windows "Task Scheduler" running `node <repo>\src\cli.ts distill`.
Self-update: no cron — occasionally `git pull --tags && git checkout <latest-tag>` by hand, or install a
cron via WSL/Git Bash. Client connection (§5) is platform-independent — MCP config is identical on Windows.

## 5. Connect your client

### You are pi (or pi web)

The pre-built extension is `examples/pi-extension/ruyi.ts`:

```bash
cp examples/pi-extension/ruyi.ts ~/.pi/agent/extensions/ruyi.ts   # pi web: use its actual extension dir
```

Multi-account pi web: set `RUYI_OWNER=<account>` in each account's environment to isolate memories.
Remote ruyi service: set `RUYI_URL=http://<host>:8899` and `RUYI_TOKEN=<authToken>`.
After restarting pi: memory injection appears, and the `ruyi_recall` / `ruyi_remember` / `ruyi_admin`
tools become available.

### You are Claude Code

```bash
claude mcp add ruyi -s user -- node <absolute repo path>/src/cli.ts mcp
```

(For project-level config see `examples/claude-code/.mcp.json`.)
Verify: ruyi appears in `claude mcp list`; try a recall in conversation (shown as `mcp__ruyi__recall`).

Optional but recommended — per-turn semantic injection (same as pi: every user message automatically
brings relevant memories this conversation hasn't seen; the server dedups by conversation id, so each
memory is injected at most once per conversation and the same topic goes fully silent once everything
relevant has arrived; 20s timeout with silent degradation): register
`examples/claude-code/user-prompt-submit.mjs` as a UserPromptSubmit hook in `~/.claude/settings.json`:

```json
"hooks": {
  "UserPromptSubmit": [{
    "hooks": [{ "type": "command",
                "command": "node <absolute repo path>/examples/claude-code/user-prompt-submit.mjs" }]
  }]
}
```

A SessionStart hook (`examples/claude-code/session-start.mjs`, same registration shape) optionally fetches
the profile directory once per session — though the pi-side philosophy keeps the directory server-side
with zero resident context (see docs/design-v3). Both scripts degrade silently on timeout and never block
Claude Code.

### You are opencode

The pre-built config is `examples/opencode/opencode.jsonc`; merge it into
`~/.config/opencode/opencode.jsonc` (adjust the path to the repo's absolute path):

```jsonc
{
  "mcp": {
    "ruyi": {
      "type": "local",
      "command": ["node", "<absolute repo path>/src/cli.ts", "mcp"],
      "enabled": true
    }
  }
}
```

After restarting opencode, six tools should appear in the tool list (`ruyi_recall` etc. — opencode adds
the `ruyi_` prefix automatically).

### You are on a machine without ruyi (remote access)

When ruyi runs on another machine/cloud host, connect via the **remote bridge** (single file) plus the
**sync script** (single file). Everything below is **idempotent — safe whether this machine has never
seen ruyi or already has parts installed**: detect what exists, install what is missing, re-downloading
a file is how you update it. Work through this checklist in order; ask the user for the service URL and
token up front if you do not have them (never invent them).

**Setup checklist (Claude Code shown; opencode/pi variants at the end):**

```powershell
# 0. Ask the user for RUYI_URL and RUYI_TOKEN if not provided. Never guess.

# 1. Bridge (query tools). If C:\tools\mcp-remote.mjs exists, re-download anyway (= update).
curl -o C:\tools\mcp-remote.mjs https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/mcp-remote.mjs

# 2. MCP registration. Check first: `claude mcp list` — if "ruyi" is already there, skip
#    (or re-run to refresh env). Otherwise:
claude mcp add ruyi -s user -e RUYI_URL=<url> -e RUYI_TOKEN=<token> -- node C:\tools\mcp-remote.mjs

# 3. Verify the bridge (mandatory): open a fresh conversation, call the recall tool
#    with "coding style". Content coming back = connected.

# 4. Session sync (how conversations become memories). Re-download = update.
curl -o C:\tools\sync-sessions.mjs https://cdn.jsdelivr.net/gh/xiaqii/ruyi@main/examples/sync-sessions.mjs

# 5. Dry-run inventory (uploads nothing; shows format detection + what would sync):
node C:\tools\sync-sessions.mjs --status

# 6. Automate forever (one time; writes ~/.ruyi-sync.config.json with the env you
#    currently have set, then installs: a SessionEnd sync hook — every finished
#    conversation syncs itself; SessionStart + UserPromptSubmit injection hooks
#    — memory surfaces in context automatically; CLAUDE.md memory-use rules —
#    the model learns WHEN to probe/recall instead of answering from guesswork):
$env:RUYI_URL='<url>'; $env:RUYI_TOKEN='<token>'; node C:\tools\sync-sessions.mjs --install-hook

# 7. First full sync of history (slims locally first — typically ~0.3% of raw size):
node C:\tools\sync-sessions.mjs
```

After step 7 the machine is done: conversations slim-and-push themselves at SessionEnd (increments
only), and the nightly dream distills them. A daily scheduled task is a fine backstop (the
`--install-hook` output prints a ready `schtasks` line).

Variants:
- **opencode**: bridge step 2 registers in `~/.config/opencode/opencode.jsonc` instead:
  `"mcp": { "ruyi": { "type": "local", "command": ["node", "<bridge-path>"],
  "environment": { "RUYI_URL": "<url>", "RUYI_TOKEN": "<token>" } } }`.
  No SessionEnd hook support — automate sync with a cron/Task-Scheduler entry instead (step 6 →
  scheduled daily/hourly run of `node sync-sessions.mjs`).
- **pi on another host**: instead of the bridge, install the extension
  `examples/pi-extension/ruyi.ts` into `~/.pi/agent/extensions/`, set `RUYI_URL`/`RUYI_TOKEN` in the
  pi environment, restart pi. Sync (steps 4–7) is identical, with `--agent pi --dir ~/.pi/agent/sessions`.

Notes:
- Optional per-turn injection for Claude Code (recommended): also download
  `examples/claude-code/session-start.mjs` and `examples/claude-code/user-prompt-submit.mjs`,
  register them as SessionStart / UserPromptSubmit hooks in `~/.claude/settings.json` (ready-made
  snippets in each script's header), and pass them the environment via settings.json's top-level
  `"env": {"RUYI_URL": "...", "RUYI_TOKEN": "..."}`.
- Sync dedup is three-layered (line index / session uid / memory merge): re-importing or re-syncing
  the same conversation never double-distills it. A session first imported manually (e.g. zip) and
  later synced carries its distillation offset over automatically.
- If the sync script says it cannot recognize the log format, it uploaded nothing — do not force it;
  report the format to the user.

### You are Hermes / another MCP client (ruyi installed locally)

Register `node <absolute repo path>/src/cli.ts mcp` as a stdio MCP server (check your client's MCP docs
for the registration entry point). It exposes six tools: `recall` (fast/deep/excavate modes), `list`,
`get`, `ingest`, `remember` (explicit write, via LLM merge adjudication), `admin` (forget/stats/profile
three-in-one) — forget is a soft delete (diggable via excavate) and leaves a content fingerprint
(tombstone): no write path will ever re-admit forgotten content, preventing old conversations from
re-distilling it back. Clients add the server-name prefix automatically (opencode shows `ruyi_recall`,
Claude Code shows `mcp__ruyi__recall`). The MCP process opens the same SQLite database directly
(WAL mode, multi-process safe), reading and writing the same memory as the HTTP service.

### Sharing across clients (important)

One ruyi instance is the whole family's memory hub: pi via the extension, Claude Code/opencode via MCP,
scripts via HTTP — **all sharing the same owner=default memory pool by default**: a lesson formed in
Claude Code can be recalled by pi. That's the design goal.
When isolation is needed (multiple people on one machine): set different `RUYI_OWNER` per client/account
and memories never cross.
The dream side must also see every client's sessions: add each agent's log directory to `sessions` in
`config.local.json` (parsers for pi and claude-code are built in; other formats see §7).

### Sharing across machines (one person, several hosts)

Memory-host side (once): a random `authToken` was generated at install (in `config.local.json`, mode 600).
View: `node src/cli.ts token`; rotate: `node src/cli.ts token --rotate` (then `systemctl restart ruyi`;
the old token dies immediately). External exposure additionally needs `"host": "0.0.0.0"` or a reverse
proxy/tunnel + service restart. **An exposed port without an authToken means publishing all memories.**

Agents on other machines: all switch to the HTTP API with header `Authorization: Bearer <authToken>`.
For the pi extension, two env vars suffice: `RUYI_URL=http://<host>:8899`, `RUYI_TOKEN=<authToken>`
(pi web: put them in the service environment). MCP-stdio is a local mode — remote machines must not use MCP.

### Any other agent

**The single authority for the interface contract is [API.md](API.md)** — field-level definitions of every
HTTP endpoint and MCP tool, verified field-by-field by `test/api-contract.ts` before every release; a
doc/implementation mismatch fails the release. Implement against it. Quick overview:

```
POST /recall   {"query": "...", "k": 5, "mode": "deep"}     # mode: fast (free keyword scan) / deep (LLM selection) / excavate (archaeology, incl. archived)
GET  /inject?owner=default                                   # profile directory tree, pure SQL (server-side selection material; clients need not render it resident)
Note: ruyi has no "resident injection" channel — global iron rules belong in the agent platform's own
global AGENTS.md / CLAUDE.md (natively injected every turn by the platform); ruyi supplies on relevance
only. Temporary rules for the current conversation: just say them; long-term rules get distilled into
profiles by the nightly dream.
POST /ingest   {"text": "..."}                               # submit text for dream distillation
GET  /stats?days=7
```

**Topic context on the auto path (since 0.9)**: a `conversation`+`auto` call is more than dedup — the
server maintains a rolling summary per topic plus the latest turns' raw text, fed into the selector
alongside the query. Bare follow-ups ("which ones can't he eat?") are judged against the topic's subject
instead of drifting context-free. The summary rides the selector's output (zero extra calls); only
long-silent topics rely on the low-frequency backstop — real-time and zero-waste at once.

## 5b. Daily self-update (on by default)

`scripts/self-update.sh`: checks once a day and **only upgrades to tagged official releases** (each tag
passed tsc + zero-LLM smoke tests + LLM smoke before release); after pulling, tsc + smoke run again
locally, and any failure auto-rolls back to the previous version. It never touches
`config.local.json`/`data/`/`profiles/`, and refuses to run on a dirty worktree.
install.sh installs this cron by default (daily at 04:40); `--no-auto-update` opts out, and re-running
install.sh opts back in anytime. Results land in `logs/self-update.status`
(updated/skipped/rolled-back/error); troubleshoot via `logs/self-update.log`.

**Data follows upgrades automatically**: DB schema migrations run at service start (idempotent); profile
rebuilds need no manual action — the dream pipeline re-synthesizes when the newest profile is over 7 days
old. To see a fresh profile tree right after an upgrade, run `node src/cli.ts synthesize` once manually
(costs one LLM call).

## 5c. Updating an existing install (read this when the user says "ruyi has a new version")

**First question: are you CONNECT-only or do you run the server?** Most clients are connect-only
(mcp-remote.mjs bridge → someone else's ruyi service) — for them "upgrading ruyi" means updating ONE
local bridge file, never installing anything. Only the machine that actually runs the ruyi service
follows the install-upgrade paths. Then act by type:

1. **Git-clone install** (most common — `~/ruyi` or similar with a `.git`): `cd <repo> && git pull`.
   - Client registered via **MCP stdio** (opencode / Claude Code / pi): you are DONE — the MCP server
     respawns from the updated code on every new conversation; new tools (e.g. a newly added one) appear
     in the next session automatically. No re-registration, no restart of your own process needed.
   - A **ruyi service** runs on that machine: `systemctl restart ruyi` (or leave it — the daily
     self-update at 04:40 handles tagged releases with auto-rollback, see §5b).
2. **npm global install**: `npm i -g https://github.com/xiaqii/ruyi/releases/latest/download/ruyi.tgz`
   (same restart rules as above).
3. **Remote bridge** (connect-only client: no clone, no service, only `mcp-remote.mjs` pointing at a
   remote ruyi): re-download just that file —
   `curl -LO https://raw.githubusercontent.com/xiaqii/ruyi/main/examples/mcp-remote.mjs` —
   then start a new conversation. The remote server already speaks the new API; nothing else to touch.
4. **Version check**: local = `node src/cli.ts --version`; latest =
   `git ls-remote --tags https://github.com/xiaqii/ruyi | tail -1`.

Schema migrations run automatically at service start; memories/profiles/data are never touched by updates.

## 5c. Docker form (second install path)

The repo ships a Dockerfile + docker-compose.yml. One-sentence principle: **the database always mounts a
real host directory** — delete the container, upgrade the image, lose nothing (the DB is tiny, but it's
everything).

```bash
git clone https://github.com/xiaqii/ruyi && cd ruyi
docker compose up -d --build
# After first run, edit ~/ruyi-docker/config.local.json on the host to fill the key, then docker compose restart
# Optional nightly dream: docker compose --profile dream up -d
```

Key points: the in-container service binds `0.0.0.0` (compose passes `-h 0.0.0.0`), and the port publishes
only to the host loopback `127.0.0.1:8899`; the state directory is the volume-mounted `/data`
(RUYI_STATE env var); config/data/profiles/logs all land in `~/ruyi-docker/` on the host.
Upgrade: `docker compose up -d --build` (rebuilds the new version).
Remote agent connection is identical to every other form (HTTP + token).

## 6. The first dream (ask the user first!)

The first dream reads through historical session logs — **token cost scales with log volume and can be
large**. By default only the last 14 days are processed (`dream.initialMaxDays`). Flow:

1. Tell the user the estimated scale (only the latest 200KB/file increment is read; older history is
   skipped by default, controlled by `dream.initialMaxBytes`), get consent
2. `node src/cli.ts distill` (run in the foreground to watch progress; for large volumes run in the
   background and check periodically)
3. `node src/cli.ts list` — spot-check memory quality
4. `node src/cli.ts synthesize` — generate profile chapters (auto-skips when <10 memories)
5. Run one real recall smoke test: `node src/cli.ts recall "the kind of work the user has been doing lately" --mode=deep`

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| doctor LLM FAIL | check protocol/baseUrl/apiKey/model; openai-protocol baseUrl must not include the `/chat/completions` suffix |
| recall always empty | `node src/cli.ts list` to confirm the store is non-empty; confirm the owner matches (default `default`) |
| no injection visible in pi | confirm the extension is in the right directory and pi was restarted; when the service is down pi behaves exactly as if uninstalled (by design) |
| logs not in pi/claude-code format | `src/preprocess.ts` has the parser registry — mimic an existing parser |
| Chinese unsearchable | fixed in v2 (trigram FTS); old databases migrate automatically — run doctor's FTS self-check to confirm |

## 8. After installation

Tell the user: installation complete + doctor results + memory count + night-dream time (systemd timer or
cron) + whether daily self-update is on.
Daily use requires nothing from you: work normally by day; recall via `ruyi_recall` when needed (probe with
fast, deep for important answers); when the user says "remember …" use `ruyi_remember`; at night it dreams
and grows on its own.
