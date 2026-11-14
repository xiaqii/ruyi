# Changelog

## [1.8.0] - 2026-11-14

**Session sync v2 — slim-locally, line-indexed, self-maintaining clients.**
- sync-sessions.mjs rewritten: slims logs LOCALLY (thinking/images/file-snapshots stripped, tool_use skeletonized, tool_result capped at 500 chars, >50KB fields truncated, CC top-level `toolUseResult` base64 strip — the single biggest volume source), then pushes whole lines; byte-targeted batching (4MB/request), per-line 2MB hard cap, per-chunk checkpoints
- server `/sync/session` line mode: 409 line-count realign, agent whitelist (claude-code/pi/codex), machine activity ledger; oversized bodies get a clean 413 (was an opaque 500)
- one-command client lifecycle: `--install-hook` installs SessionEnd sync + SessionStart/UserPromptSubmit injection hooks + CLAUDE.md memory-use rules; `--uninstall-hook` removes all traces; weekly self-update from the server's `/clients/<file>` endpoint (SYNC_VERSION)
- distill registers every session file's content uid, and a synced session that collides with a previous manual import inherits its dream offset (verified live: a 408MB-processed archive mapped to its slimmed copy by line index, 8/8 boundary fields matching); scripts/reslim-synced.mjs re-slims already-stored files 1:1 (production: 1.52GB → 462MB)
- dream hardening: SSE stream option per tier (gateways drop long non-streaming calls), thinking-aware budgets (reorganize 256K/8h effectively no timeout), key fallback on 402/quota-worded 400
- probe/admin tool descriptions hardened: probe as-often-as-possible-and-first, profile is inspection-only never a retrieval path

## [1.7.3] - 2026-11-09

- dream: tolerate vanishing session files (ENOENT mid-scan) and actually read inbox-kept .txt (the .jsonl filter starved the inbox→dream path); selector listing in stable id order with static-first prompt layout (prefix-cache friendly; flash +3/14 on bench); store card gains a NEW-SINCE strip for memories born after the last nightly build
## [1.7.2] - 2026-11-08

- inbox streams slimming (GB-scale archives no longer hit Node's 512MB string cap); probe survives probe-tier outages gracefully; recall/probe responses carry serverTime (surfaced only on empty probes, labeled as question time); fix extension formatRecall crash (undefined res) that broke every injection; AGENT.README §5c update guide leads with connect-vs-install
## [1.7.1] - 2026-11-08

- storecard: never write an empty assembly over a good card; maxTokens 32K for assembly (Kimi thinking shares the token budget)
## [1.7.0] - 2026-11-08

- probe tier + store card — agent-initiated probing on qwen3.8-max (thinking off), per-turn injection stays flash; store map rides every injection so agents know what the store covers
## [1.6.9] - 2026-11-07

- remote clients: mcp-remote.mjs lost its pin/unpin zombie (that tier was removed long ago; server has no such route) and learned the tombstone-blocked remember response; README install section now splits the two scenarios explicitly — first machine installs, every other machine CONNECTS to the one server over HTTPS (no local instance)
## [1.6.8] - 2026-11-07

- inbox default dir: ~/ruyi-inbox → ~/ruyi/inbox (subdirectory discipline — everything ruyi lives under the one state root: data/, wiki/, inbox/); inbox dirs gitignored since the repo often IS the state root
## [1.6.7] - 2026-11-07

- release pipeline now prunes old GitHub releases after publishing (tags kept for version archaeology; the Releases page carries only the latest package)
## [1.6.6] - 2026-11-07

- main returns to pure memory: the experimental wiki (book-library lookup) moves to a long-term local branch to prove itself; public repo stays the focused memory system
## [1.6.5] - 2026-11-06

- recall tool-call discipline: the directory line made the agent re-fetch injected memories on every follow-up (374 calls/day vs 30) — tool description now states memories are auto-injected every turn and to call only for uncovered angles; 'more can be searched via ruyi_recall' footer dropped from non-empty injections (discovery lives in the tool description)
## [1.6.4] - 2026-11-06

- wiki term-hit lane: any book with a chapter keyword appearing verbatim in the question is always a candidate (deterministic complement to card-pick, not a gate) — book-level keywords can't cover every term a book argues about, and card-pick alone rejected 牛蒡子 questions despite two chapters warning against it; book cards enriched to 400 chars + 50 keywords incl. famously-criticized items
## [1.6.3] - 2026-11-06

- wiki keyword lane (user's design, replaces my FTS entity lane): k3 now writes an 80-char mini + 1-20 verbatim keywords per chapter (drugs/formulas/diseases/persons — including terms the chapter only WARNS against); flash's chapter listing carries keywords, so a question about 牛蒡子 finds the chapter whose mini never mentions it; per-chapter ingest failures skip instead of aborting the run; wiki-reindex CLI rewrites in place, resumable
## [1.6.2] - 2026-11-06

- wiki multi-book answers: book-pick now returns up to 3 books (search-engine style — different angles all count), quick mode answers per book in parallel blocks headed by title+author, deep mode merges all books' passages into one synthesized answer; off-domain rejection intact
## [1.6.1] - 2026-11-06

- wiki robustness from live two-book testing: book-pick JSON fumbles tolerated (match by id, library string only disambiguates — models emit {"library":null,"book":2}); picked section ids validated against the shown listing (flash hallucinated ids from the OTHER book, silently reading wrong chapters); pick prompt writes reason before the decision
## [1.6.0] - 2026-11-06

- wiki: pull-based book libraries — one SQLite per domain under STATE_ROOT/wiki, 3-level flash drill-down (question-oriented book cards → chapter minis → verbatim passages), quick/deep answer modes with an iron verbatim-quote rule for doses and figures; ingest rides the strong dream tier (resumable), ruyi_wiki_ask MCP tool lazy-loaded so a broken wiki can never take memory tools down; verified on 《治病法轨》 (49 chapters, 366K chars): dose lookups quote exactly, off-domain questions rejected at the book-pick level, ~¥0.01 per query
## [1.5.5] - 2026-11-06

- inbox dialogue guard: text without speaker structure (books/notes) is skipped — ruyi distills the user, not their library; explicit .lens.md opts in and is re-checked every run (skip is not a one-way door); inbox.ts comments fully English
## [1.5.4] - 2026-11-06

- readme: npm install = curl the release tarball then install the local file — npm 12 blocks remote URL/git installs entirely (EALLOWREMOTE/EALLOWGIT defaults), local files unaffected; verified end-to-end on npm 12.1
## [1.5.3] - 2026-11-06

- npm-installable for real: bin now points at compiled dist/cli.js (node refuses type-stripping inside node_modules), prepare builds on pack; release.sh attaches a prebuilt ruyi.tgz to every GitHub release so npm i -g <tarball URL> needs zero flags on npm 12 (git installs are EALLOWGIT + scripts-blocked there)
## [1.5.2] - 2026-11-06

- npm-installable straight from GitHub (bin entry, files whitelist, repo metadata — npm i -g github:xiaqii/ruyi works, zero npmjs involvement); bare 'ruyi' now prints usage instead of starting a server; USAGE text English + current; stale serve-default comment fixed
## [1.5.1] - 2026-11-06

- two-tier model expectation now explicit: doctor WARNs on single-model setups (every turn would pay thinking-model latency/cost for selection) and on recall tier with thinking left on; AGENT.README §0 presents the cheap-selection + strong-dream split upfront incl. free-quota route; config.example _llm_notes; stale step names in doctor advisory fixed
## [1.5.0] - 2026-11-06

- raw-material inbox: drop zip/tar.gz/jsonl/txt/md into ~/ruyi-inbox, nightly dream auto slims (deterministic, zero LLM — 174MB session log to 0.9%) → filters per-window keep/drop via flash (52-judgment tested prompt, 0 flips, errs toward keep) → kept text feeds the normal k3 dream pipeline; per-file×lens char offsets resume partial work; .lens.md sidecar narrows what passes the filter; daily CNY budget cap; inbox_files table tracks every run; zip salvage reads truncated archives (missing central directory) sequentially
## [1.4.2] - 2026-11-05

- docs: full English rewrite of API.md/AGENT.README.md/design-v2/design-v3 (author credit stays Chinese), staleness sweep (selector replaces understand/rerank descriptions, test counts, examples comments); db: kind whitelist at insertMemory chokepoint (an out-of-enum kind once slipped in via LLM merge and evaded all kind-based consumers)
## [1.4.1] - 2026-11-03

- 选题稳定性：recall 层默认 temperature=0.2（选择是判断题，默认采样下同一句查询会在有/无结果间翻转——生产抓获：xiaoxiao 查询一次空两次中）；llm.ts 双协议分支支持 opts.temperature 覆盖
## [1.4.0] - 2026-11-02

- 召回架构定稿（用户设计）：一次选题调用读懂整个记忆库——understand+rerank 两层合并为单个 selector 调用（新 prompt pick.md），全量清单=每条记忆的50字定位句(mini)+全部画像章节目录行(abstract)，schema v11；领域分类从门槛退休为展示字段，'归错域就永不见天日'的失败模式结构性消失；选题哲学：画像规则是底色/单条记忆只为改变答案/个人事实被直接问到就是答案/通用知识空选择即正确/拿不准就加载；extract 同步产出 mini，存量174条 k3 回填；synthesize 产 abstract+预置人物骨架（个人基础信息/精神与思想/健康与养生/生活与消费/做事与协作方式/人际与家庭为保留名，手艺领域自由生长）+身份卡特殊形态（标签行≤30字，只收本人陈述，变了改行）；实测六题全中：菜谱/天气空选择、车型号精准点#18+基础信息页、PHP题4条教训+技术栈章、佛经题命中新建精神域。修复：selector返回字符串id被过滤器误杀（Number强转）
## [1.3.1] - 2026-10-28

- 修复压缩黑洞：pi session_compact 后清空该会话 injection_log，已注入记忆可重新注入（issue #2）

## [1.3.0] - 2026-10-28

- 旧数据标准升级通道（用户裁决落地）：新 CLI audit-lessons——主语测试审计存量 lesson，k3 分批判决 ok/重写抽象/转环境事实fact/剧集归档，重写逐条 dream 层执行（数字逐字/项目只作案发现场），dry-run 先出报告 --apply 才落笔，落笔前自动备份+原文入 memory_log 可回滚；新 prompt audit-lessons/audit-rewrite；backupDb 从 distill 导出复用。首战：36 条活跃 lesson 审出 9 条——#71/#758/#897/#1049/#1144 转 fact（用户自有系统/服务器的环境属性），#190/#1025/#1117/#1135 抽象重写，#1114 剧集内容归档（已迁 GitHub issue #2）。已知局限：apply 会重新判决而非重放 dry-run 报告（LLM 非确定），计划文件重放留待后续
## [1.2.0] - 2026-10-26

- 分层话题上下文（用户定案的 gist 架构）：replies 表加 answer(原文全量)+gist(可再生视图) 字段（schema v10）；扩展 agent_end 上报 AI 回答（fire-and-forget）→ 服务端异步 flash 产 1-2 句逐轮纪要（新 prompt reply-gist：事实只出自本轮原文/禁裸代词/数字逐字/举例非主题，参照块仅用于还原指代）；组装器重写为三层——topic_summary(长效)+最后3轮用户原文(短效,单轮≤4K)+逐轮gist由新到旧填满(中效)，总预算32K；防漂移体系：单层压缩铁律(gist只从原文生成绝不链式)、代码级 grounding 检查(gist与原文须共享实词，实证抓获flash对退化输入输出垃圾)、夜间dream层(k3-256k思考)周级从原文重写活跃话题gist修复漂移(搭synthesize周闸门，新CLI regen-gists)；llm.ts openai分支补json:false选项(强制response_format会让flash把散文包成工具调用信封——实证抓获)。历史会话回放实测(数字人12轮)：gist主体精确/数字逐字/指代还原全部正确，12轮组装仅1060字符
## [1.1.17] - 2026-10-26

- 召回输入上限 16k→100k 字符（用户裁定：flash 十万字约两分钱，省钱不是约束；上限只防整份日志 dump 的病态粘贴吃光 10s 同步预算的 prefill 延迟）
## [1.1.16] - 2026-10-26

- 召回管线重构（用户定案）：T1字符串检索退出正常路径——最坏失败（好记忆进不了候选池）是致命的，且关键词无法区分讨论主题与举例提及（用显卡举例会拉来显卡记忆）；T2 understand 改为必跑（flash 足够便宜），输入=话题摘要+该话题全部用户轮原文+本轮全文（扩展取消2000字截头——长消息真问题在尾部，改16k头尾各半采样）；候选池=域通道∪recent∪pinned（纯语义邀请制，rerank终选不变）；understand prompt 重写（召回第一道闸、域判断即池门、宁多勿漏、举例非主题、话题切换另起），keywords 字段退役；FTS 仅保留在 ruyi_recall fast/excavate 与 LLM 全挂降级兜底。实测：漂移用例通过（汽车话题后问价格→domains=[汽车]），全链路约2s
## [1.1.13] - 2026-10-26

- 安装体验：recall 层代码级默认关思考（单 LLM 用户零配置获益，供应商不认参数走 400 降级自动摘除）；doctor 新增分层建议（recall 与 dream 同模型且延迟>3s 时打印实测推荐配置片段，只建议不改配置；否决自动探测供应商模型列表：端点不通用/快慢靠猜/猜错静默劣化）；修复 config.example.json 陷阱：steps 具体配置块会经 defaults 合并变成每个用户的实际配置
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
