# Changelog

## [1.1.6] - 2026-10-20

- reorganize 覆盖断言核验：归档理由声称已被 #X 覆盖时必须逐点核对，未覆盖细节先并入 #X 否则禁止归档
## [1.1.5] - 2026-10-20

- reorganize 覆盖断言核验
## [1.1.2] - 2026-10-18

- pi 扩展显示文案中文化：注入记忆X条→加载记忆X条（含画像/去重提示），remember 工具渲染→保存记忆/已保存记忆1条（#id）/保存失败，admin forget 反馈中文。仓库副本 label 保持英文（产品策略），运行副本纯中文
## [1.1.1] - 2026-10-18

- pi 扩展注入位置修复：快路径（≤2s 命中）不再写 systemPromptOptions.sections（系统提示词位于 token 0，逐轮变化会让全对话的前缀缓存从头部整体失效），改为返回 custom 消息——pi 将其落在当前用户消息之后（纯尾部追加、本轮即可见、历史轮字节不动，前缀缓存最大化保留）。快慢两路注入位置语义统一；零静态足迹现在是完全意义上的（系统提示词永不被触碰）。另修 llm-smoke 自毒化：forget 留墓碑，固定测试内容会被后续运行的墓碑检查拒写，改为每轮唯一内容
## [1.1.0] - 2026-10-18

Hardening pass inspired by a source-level study of hippo-memory, ClawMem and
Mnemo Cortex. All four changes enforce decisions already made — no new
judgement logic, no new LLM calls.

- **Forget tombstones (schema v9).** Archiving a memory (forget / reorganize /
  decay) now leaves a content fingerprint in a `tombstones` table (hash only,
  never the forgotten text). Every write surface funnels through
  `insertMemory`, which refuses tombstoned content — a forgotten memory can no
  longer be resurrected by the nightly dream re-reading old logs. Migration
  backfills fingerprints for memories archived before v9.
- **Supersede confidence gate.** A high-confidence (≥0.8) `user_stated` entry
  can only be retired by another high-confidence user-stated candidate; an
  inference is demoted to REINFORCE and the refusal is logged
  (`BLOCKED_SUPERSEDE` / `BLOCKED_CONFLICT`). Applies to dream-time merge,
  explicit remember, and nightly reorganize conflict resolution.
- **Excavate status markers.** MCP recall labels non-active entries
  (`[已归档]` / `[已被 #N 取代]` / `[已并入 #N]`) so archaeology mode reads
  history as history, not as current truth.
- **Self-eating guard.** Session preprocessing strips ruyi's own injection
  envelopes (`**注入记忆**` / `**注入画像**` blocks and their footers) before
  the dream ever sees them — the system no longer distills its own output as
  if it were user signal.
- Dream report gains a `blocked` counter; 25 new smoke tests (59 total).
- `RUYI_STATE` now takes precedence over the repo checkout's `config.local.json`
  (explicit env override wins; fixes the self-contained contract suite on machines
  where the repo is also the live install).

## [1.0.4] - 2026-10-17

- docs: README 补 Repo map；test: api-contract 自带一次性服务实例，修复对运行环境状态的依赖（关联 issue #1）

## [1.0.3] - 2026-10-17

- docs: README 补 Repo map；test: api-contract 自带一次性服务实例，修复对运行环境状态的依赖（关联 issue #1）

## [1.0.2] - 2026-10-17

Single-commit fresh history. ruyi is a generic memory system: product code
contains no personal/private integrations (those live as machine-local scripts,
e.g. the privacy pre-commit gate). This release scrubs one such leak.

## [1.0.0] - 2026-10-17

First public release under a fresh, single-commit history.

如忆 (ruyi) — an agent-agnostic long-term memory service for AI agents:
nightly LLM distillation of session logs into a converging memory store,
a two-level abstract profile tree, server-side retrieval with per-conversation
injection dedup, bearer-token auth for cross-machine sharing, and a thin-client
integration model (register the ruyi_* tools — nothing else). Zero static
footprint: unrelated conversations get zero injected content.

See README.md for install & agent connection, AGENT.README.md for the
agent-facing contract, API.md for field-level details.
