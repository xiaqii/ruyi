# CHANGELOG

All notable changes to ruyi (如忆). Semver versioning; every release passes
typecheck + zero-LLM smoke + LLM smoke before tagging.

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
