# Changelog

## [1.1.11] - 2026-10-26

- 模型分层配置落地：dream 层（夜间提纯/merge）kimi-for-coding→k3-256k 且不再关思考（此前 base thinking=off 一直在裸奔；实测 k3-256k 默认即带 thinking 块）；recall 层（understand/rerank/topic-summary）切 qwen3.7-flash 关思考——openai 协议分支补 enable_thinking:false 映射（400 时按既有 thinking 降级规则摘除）；生产实测召回延迟 p50 4.3s→2.8s；config.example.json 补 steps.recall 分层示例
## [1.1.10] - 2026-10-25

- pi 扩展注入时序修复：同步预算 1.2s→10s（生产实测 deep 召回延迟 p50=4.3s / p90=5.7s，1.2s 预算几乎全部落到迟到的慢通道，用户看到“回答完才注入”）；等待期间状态栏分阶段提示（正在分析→检索→整理，pi-web 前端已确认处理 setStatus 事件，不支持的 UI 静默无影响）。实测依据：T1 纯 SQL 候选只覆盖 deep 管线最终选中的 23%——LLM 层（T2 查询理解/T3 语义精排）是召回质量主体，不可用裸匹配替代；understand A/B：kimi 与 qwen3.7-flash 关思考质量相当，flash 快 3 倍（0.8-1.6s vs 2.2-4.7s），recall 层换 flash 留作可选后续
## [1.1.8] - 2026-10-21

- 横评落地：extract.md 吸收 langmem 三原则（未来行动视角书写/surprising+persistent/dense>overlapping）；synthesize-theme.md 引入 genagents 洞察层（洞察挂证据编号，无证据不入章）；安全闸保持显式（实证：纯抽象 prompt 明文存 AK）
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
