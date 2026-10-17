# Changelog

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
