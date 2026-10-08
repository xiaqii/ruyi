# CHANGELOG

All notable changes to ruyi (如忆). Semver versioning; every release passes
typecheck + zero-LLM smoke + LLM smoke before tagging.

## [0.2.2] - 2026-10-08

- docs: README 恢复并更新 Repo map，补全 scripts/(release.sh, compare-distill.ts) 与 test/ 测试入口说明（关联 issue #1）；llm-smoke 在无本地配置时优雅跳过而非拿示例假 key 必败

## [0.2.0] - 2026-10-08

- v2 架构落地：trigram 中文 FTS + keywords 检索、分级召回(fast/deep/excavate)、画像吸收机制、需求闭环、双协议 LLM(anthropic/openai)、doctor 自检、AGENT.README 自安装手册、零前摇 pi 扩展；修复 token 记账漏算缓存命中
