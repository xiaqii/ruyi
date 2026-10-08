# CHANGELOG

All notable changes to ruyi (如忆). Semver versioning; every release passes
typecheck + zero-LLM smoke + LLM smoke before tagging.

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
