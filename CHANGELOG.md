# CHANGELOG

All notable changes to ruyi (如忆). Semver versioning; every release passes
typecheck + zero-LLM smoke + LLM smoke before tagging.

## [0.7.2] - 2026-10-09

- README 重写：纯英文两段式（①安装 ruyi——独立记忆 API 服务是什么 ②连接 agent——MCP/pi/HTTP 三接法+共享规则），去掉双语与架构大图，更简洁
## [0.7.1] - 2026-10-09

- 落地页重写：纯英文两段式——①安装 ruyi（独立记忆 API 服务是什么）②连接 agent 到 ruyi；去掉中英混排与冗余小节
## [0.7.0] - 2026-10-09

- 鉴权收归 ruyi 自身：本机直连（无代理头的回环）自动放行，经反代/隧道或局域网来源必须 bearer token，未配 token 时远程一律 503 失败即关闭；nginx 回归纯反代；配套 frps proxyBindAddr=127.0.0.1 封堵隧道端口直连漏洞
## [0.6.0] - 2026-10-09

- 同步层 v2：gzip 压缩传输（5-10x）+ 内容寻址去重（sessionUid 注册表，跨渠道同会话零传输/只补增量，继承做梦断点）+ sync-index 回填命令 + 提炼 prompt 强化代码任务抽象规则
## [0.5.0] - 2026-10-09

- 会话同步层：POST /sync/session（偏移量追加+409续传+路径消毒）+ GET /sync/state 对账 + data/synced/<machine>/ 自动成为做梦源；发送端 examples/sync-sessions.mjs（增量、进度、续传、UTF-8 字节边界安全）
## [0.4.0] - 2026-10-09

- GET / 自说明落地页：服务地址即说明书（HTML/Markdown 内容协商，公网开放，不含任何密钥）；远程接入简化到一句话
## [0.3.0] - 2026-10-09

- 公网接入能力：examples/mcp-remote.mjs 远程 MCP 桥（stdio→HTTPS，单文件自包含）；文档推荐云主机集中部署；远程接入配方（Claude Code/opencode/任意 agent）
## [0.2.15] - 2026-10-09

- Claude Code SessionStart hook（examples/claude-code/session-start.mjs）：开局自动注入宪法层+记忆索引，3s 超时静默降级；AGENT.README 补接入说明
## [0.2.14] - 2026-10-09

- MCP 工具名去 ruyi_ 前缀（客户端自动拼服务器名：opencode 显示 ruyi_recall、Claude Code 显示 mcp__ruyi__recall），opencode 实测确认；smoke 同步断言新名
## [0.2.13] - 2026-10-09

- 安装文档拆为明确两步（装服务/接agent）；examples/ 预制 opencode+claude-code 接入配置与 20 行 http-client 参考实现；新增 Windows 手动路径（§4b）；本机 opencode 经 MCP 实测联通
## [0.2.12] - 2026-10-09

- install.sh node 版本检查精确到 23.6（原来只看大版本，23.0-23.5 会误放行进而在运行时失败）
## [0.2.11] - 2026-10-09

- API.md 接口契约（HTTP 14 端点 + MCP 6 工具字段级定义）+ test/api-contract.ts 契约测试 22 项（发布门禁，文档与实现不一致即失败）；llm-smoke 增加真实写入-归档回路
## [0.2.10] - 2026-10-09

- MCP 补齐写与管理面：ruyi_remember（与 HTTP 共用 explicitRemember 裁决管线）+ ruyi_admin（forget/pin/unpin/stats/profile）；server.ts 消除重复的显式写入逻辑
## [0.2.9] - 2026-10-08

- pi 扩展新增 ruyi_admin 合并管理工具（forget/pin/unpin/stats/profile 五合一，省每轮工具 schema token）
## [0.2.8] - 2026-10-08

- 自动更新改为默认开启（--no-auto-update 退出）；README 英文区清除中文残留（cost report）
## [0.2.7] - 2026-10-08

- fix: self-update 的 git describe 参数笔误（--exact-tags→--exact-match --tags）；克隆环境全路径实测通过
## [0.2.6] - 2026-10-08

- 每日自更新脚本（只升到测试过的 release tag，tsc+smoke 门控，失败自动回滚，脏树拒绝）+ install.sh --with-auto-update 旗标 + 文档
## [0.2.5] - 2026-10-08

- 可选 bearer 鉴权（authToken 配置 + RUYI_URL/RUYI_TOKEN 扩展支持）：多机共享一个 ruyi 的官方姿势；README 英文安装句修正、多机段落改为 HTTP+key 方案
## [0.2.4] - 2026-10-08

- README 重构：英上中下双语排版、架构示意图、崩溃隔离说明、多机共享指南、一人一实例警告、一句话安装
## [0.2.3] - 2026-10-08

- chore: CHANGELOG 去除未实际发布的 0.2.1 幽灵条目（发布脚本中途失败残留）
## [0.2.2] - 2026-10-08

- docs: README 恢复并更新 Repo map，补全 scripts/(release.sh, compare-distill.ts) 与 test/ 测试入口说明（关联 issue #1）；llm-smoke 在无本地配置时优雅跳过而非拿示例假 key 必败

## [0.2.0] - 2026-10-08

- v2 架构落地：trigram 中文 FTS + keywords 检索、分级召回(fast/deep/excavate)、画像吸收机制、需求闭环、双协议 LLM(anthropic/openai)、doctor 自检、AGENT.README 自安装手册、零前摇 pi 扩展；修复 token 记账漏算缓存命中
