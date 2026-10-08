<div align="center">

# 如忆 Ruyi — Long-term Memory for AI Agents

**It doesn't remember what you said. It learns how you work.**

🤖 built & maintained by [pi](https://github.com/badlogic/pi-mono) agent + Kimi k3 · MIT · zero dependencies

**✅ Verified with: pi agent · pi web · Claude Code · opencode**

[中文说明往下看](#中文说明) · [Full agent manual → AGENT.README.md](AGENT.README.md) · [Changelog](CHANGELOG.md)

</div>

---

## What makes it different

Most "memory" tools are conversation loggers — they extract facts from what you said and pile them up forever.

Ruyi builds a living **profile of how you work**. Example: you ship a feature. Ruyi doesn't memorize your code — it learns that you prefer integration tests over mocks, that you habitually forget error handling on async paths, that your architecture taste runs toward boring-and-explicit. Every lesson merges into a few stable chapters about *you*.

Next session — next month, next agent — that experience is already loaded. You stop paying for the same mistake twice.

- **Converges, never hoards.** Mature profile chapters absorb their source memories. A year in, you own a refined profile — not a landfill of 100,000 raw fragments.
- **Cheap by design.** Keywords live in SQLite FTS (free), the LLM only ever sees ≤100 one-line summaries. No vector database, no embedding costs.
- **Every token accounted.** Built-in token ledger — ask your agent "ruyi 用量报表" anytime.
- **Yours.** One SQLite file. One local process. Your own LLM key. Nothing leaves your machine except the distill calls you configured.

## Architecture

```
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ pi agent /   │   │ Claude Code  │   │   opencode   │
   │   pi web     │   │              │   │              │
   │ (extension)  │   │    (MCP)     │   │    (MCP)     │
   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │ HTTP :8899       │ stdio            │ stdio
          ▼                  ▼                  ▼
 ┌──────────────────────────────────────────────────────────┐
 │              ruyi — one small local service              │
 │                                                          │
 │   recall engine (SQLite FTS · no vector DB)              │
 │   nightly "dream": distill sessions → profile chapters   │
 │   token ledger: every LLM call logged                    │
 │                                                          │
 │   storage = ONE file: data/ruyi.db                       │
 └──────────────────────────┬───────────────────────────────┘
                            │ LLM API only for dreaming / deep recall
                            ▼
                  your own LLM key (any provider)
```

**If ruyi crashes, nothing happens.** It's a sidecar, not a dependency — your agent keeps working exactly as before, just without long-term memory for that session. Restart ruyi and everything, memories included, is back. Your agent never blocks on it.

## Install — one sentence

Tell your agent:

> 帮我安装 https://github.com/xiaqii/ruyi （想换目录就说：装到 /opt/ruyi）

That's it. Your agent reads [AGENT.README.md](AGENT.README.md) and does everything itself — dependencies, config, background service, and wiring itself up. It will ask you for exactly one thing: your LLM API key.

## Uninstall — equally boring

```
systemctl disable --now ruyi ruyi-dream.timer ruyi-synthesize.timer 2>/dev/null
rm -rf ~/ruyi        # and the ruyi lines in your agent's config
```

One process, one folder, one database file. Nothing hides anywhere else.

## Who can share one ruyi

**All of YOUR agents — yes.** pi on your desktop, Claude Code on your laptop, opencode on your server: that's the point. Your experience follows you across tools.

**Multiple machines — yes.** Run ruyi on one host, tunnel the port from the others:

```
ssh -N -L 8899:127.0.0.1:8899 your-ruyi-host
```

HTTP-based agents (pi) on the other machines then use it transparently. MCP-stdio agents are local-only for now (remote MCP is on the roadmap) — or just give each machine its own ruyi and accept they drift apart, like two notebooks.

**Multiple PEOPLE — no.** One ruyi = one person. Two people sharing one instance means your coding habits merge with theirs into one confused profile, and everything either of you remembers becomes visible to both. Unless you're close enough to share a diary — in which case, know that this is literally what you're doing.

---

## 中文说明

### 它到底干什么

大多数"记忆"工具是对话记录员——从你说的话里抠事实，越堆越多。

如忆沉淀的是**你这个人怎么干活**。举个例子：你写了一段程序，如忆不会去记代码是什么——它记住的是你的编程习惯、你的架构偏好、你常犯的错误、你为某个坑付过的学费。这些经验不断合并，最终收敛成几个关于你的稳定章节。

下次会话、下个月、换了个 agent——这些经验已经预装好了。同样的坑，不用交第二次学费。

- **收敛，不囤积**：成熟的画像章节会吸收源头记忆，活跃集合始终有界。用一年，你得到的是一份精炼画像，不是十万条碎片垃圾场。
- **省钱设计**：关键词放在 SQLite 全文索引里（检索零 token），LLM 只看 ≤100 条一行摘要。没有向量库，没有 embedding 费用。
- **每个 token 都有账**：内置账本，随时问你的 agent "ruyi 用量报表"。
- **是你的**：一个 SQLite 文件、一个本地进程、你自己的 LLM key。除了你自己配置的蒸馏调用，什么都不出你的机器。

### 挂了会怎样

什么都不会发生。如忆是挂件，不是依赖——服务挂了，你的 agent 照常工作，只是那次会话暂时没有长期记忆。重启服务，记忆全都在。agent 永远不会被它卡住。

### 安装——一句话

把项目地址给你的 agent：

> 帮我安装 https://github.com/xiaqii/ruyi （可以自定义目录：装到 /opt/ruyi）

完事。agent 自己会读 [AGENT.README.md](AGENT.README.md)，装依赖、写配置、起服务、把自己接好。它只会问你要一样东西：你的 LLM API key。

### 卸载

```
systemctl disable --now ruyi ruyi-dream.timer ruyi-synthesize.timer 2>/dev/null
rm -rf ~/ruyi        # 再删掉 agent 配置里的 ruyi 那几行
```

### 多台主机 / 多个 agent

你自己的多个 agent 共用一个如忆——可以，这正是设计目的：经验跟着你走，跨工具不丢。

多台主机：在一台机器上跑服务，其他机器 SSH 隧道转发端口（`ssh -N -L 8899:127.0.0.1:8899 主机名`），走 HTTP 的 agent（pi）就能直接用；MCP-stdio 的 agent 目前只支持本机（远程 MCP 在路线图上）。

**一个如忆只给一个人用。** 多人共用一个，画像会互相污染（你的编程习惯和他的揉成一锅），而且彼此的记忆互相可见——除非亲密到可以共用一本日记，那这就是字面意义上的共用日记。

### 更多

安装排障、配置项、多客户端接入、目录结构、开发说明：**[AGENT.README.md](AGENT.README.md)**
