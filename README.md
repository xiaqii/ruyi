# ruyi (如忆)

> 🤖 本系统完全由 [pi agent](https://github.com/earendil-works/pi-coding-agent) + Kimi k3 构建，日常维护（issue 处理、bug 修复）也将由 pi 自动完成。
> 🤖 Built entirely by pi agent + Kimi k3 — maintenance (issue triage, bug fixes) is automated by pi as well.

**让你的 agent 拥有长期的、跨对话的、智能的、适应场景的记忆、经验、技能与认知。**
**Give your agent long-term, cross-conversation, intelligent, context-aware memory, experience, skills and understanding.**

## 安装 / Install

最简单的安装方式：把这个仓库丢给你的 agent，让它读 [AGENT.README.md](AGENT.README.md)，它会自动完成安装（你可以告诉它装在哪里，否则默认装到 `~/ruyi`）。

Easiest install: hand this repo to your agent and let it read [AGENT.README.md](AGENT.README.md) — it installs itself (tell it where to clone, or it defaults to `~/ruyi`).

## 这是什么 / What it is

你的 agent 每次对话结束就把你忘了。ruyi 给它一个像人一样的记忆：

- **夜里"做梦"**：重读当天的会话，把值得记住的提炼出来，和已有的记忆合并、去重、纠错
- **定期"反思"**：把散落的记忆向上抽象成分领域的经验画像（编程习惯、运维经验、健康知识……互不混在一起）
- **白天精准回忆**：只加载和当前任务相关的那几条，其余的一律不塞

Your agent forgets you after every conversation. ruyi gives it a human-like memory: it dreams at night (distilling the day's conversations into memories), reflects periodically (condensing scattered memories into per-domain skill profiles), and recalls during the day (loading only the few memories relevant to the task at hand).

## 特点 / Why ruyi

- **查找分级，便宜的免费**：试探性查找走数据库索引，零 token、毫秒返回；只有需要 LLM 判断时才花 token
- **记忆会长大也会收敛**：重复出现的偏好会变强，过时的会被取代，被画像吸收的旧记忆自动退出活跃集——库不会无限膨胀
- **缺什么补什么**：查不到的领域会记下"需求信号"，夜梦优先补这些短板
- **挂了不拖累 agent**：独立本地服务，超时和熔断都有，服务停了 agent 照常工作
- **随便什么模型**：Anthropic 协议、OpenAI 协议都支持（DeepSeek、Kimi、Claude、通义、本地 vLLM/Ollama……）；可以"做梦用聪明模型、回忆用便宜快模型"
- **零依赖**：Node ≥ 23.6 + SQLite，没有别的

## 它是怎么工作的 / How it works

```
白天  你干活 ──► 会话日志
夜里  做梦 ──► 提炼 → 验证 → 合并 → 去重 → 归档     （记忆库治理）
每周  反思 ──► 聚类 → 写成画像章 → 吸收底层记忆      （经验向上抽象）
白天  回忆 ──► 免费索引初筛 → 稀疏时扩展查询 → LLM 精选  （分级成本）
```

记忆分四层：宪法层（核心规则，每次必带）→ 画像层（分领域经验，按场景至多加载一章）→ 原子记忆（检索主力）→ 沉积层（被吸收/归档的，只在考古时翻）。活跃集始终收敛，装得再久也不乱。

## 文档 / Docs

- [AGENT.README.md](AGENT.README.md) — 给 agent 看的自安装手册（安装就看这个）
- [docs/design-v2.md](docs/design-v2.md) — 完整设计文档

## Repo map

```
src/            服务本体：server, recall, distill, synthesize, reorganize, decay, llm, db, mcp, doctor…
prompts/        全部 LLM prompt（开放、原则式）
examples/pi-extension/ruyi.ts   pi 客户端扩展
systemd/        服务/定时器单元（含 install.sh 用的模板）
scripts/        install.sh 安装、release.sh 发布管线、compare-distill.ts 提炼效果对比
test/           smoke.ts 零 LLM 测试（34 项）、llm-smoke.ts LLM 链路冒烟
docs/design-v2.md               完整 v2 设计文档
AGENT.README.md                 给 agent 的自安装手册
```

## License

MIT
