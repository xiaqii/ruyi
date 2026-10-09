# AGENT.README — 把 ruyi（如忆）装给 agent 用

> 这份文档是写给 **AI agent** 的，不是写给人的。
> 你的用户把这个仓库 clone 到了某台机器上，并把你指向这里。
> 你的任务：**自主完成 ruyi 的安装、配置、启动、接入和验证**。
> 原则：每一步都验证，失败就按指引回退，不要硬闯；涉及花钱的步骤（首次做梦）必须先征得用户同意。
>
> 如果仓库还没 clone：先问用户安装目录；用户没指定就 clone 到 `~/ruyi`。

ruyi 是一个长期记忆服务：它在夜间重读你的会话日志，把值得记住的东西蒸馏成记忆，
白天你通过 HTTP API / pi 扩展 / MCP 查询它。装上它，你就有了跨会话的记忆。

## 0. 你需要从用户那里拿到的信息

开始之前，向用户确认（缺一不可）：

1. **LLM 端点三要素**：`baseUrl`、`apiKey`、`model`
   - ruyi 支持两种协议，问清用户的端点属于哪种：
     - `anthropic` 协议：Anthropic 官方、Kimi coding 端点等（路径风格 `/v1/messages`）
     - `openai` 协议：DeepSeek、OpenAI 官方、通义、Moonshot、vLLM、Ollama 等（`/v1/chat/completions`）
   - 如果用户有两个模型（一个聪明一个便宜），建议：聪明的给 dream 档，便宜的给 recall 档（见 §3 的 `steps`）
2. **会话日志目录**：ruyi 靠读你的会话日志做梦。
   - pi：通常是 `~/.pi/agent/sessions`（pi web 部署时可能是别的路径，确认！）
   - Claude Code：`~/.claude/projects`
   - 其他 agent：确认日志格式后可能需要加 parser（见 §7 故障排查）
3. **这台机器上你（agent）的运行方式**：pi / Claude Code / 其他？决定 §5 接哪种客户端。

## 1. 环境检查

```bash
node --version   # 必须 >= 23.6（用了 node:sqlite 和原生 TS）
```

不够就引导用户升级 Node，不要尝试绕过。

## 2. 安装

```bash
cd <本仓库目录>
bash scripts/install.sh
```

install.sh 会：检查 node → `npm install`（仅 dev 依赖）→ 生成 `config.local.json` →
（有 root + systemd 时）装 systemd 服务和夜间定时器，否则打印 nohup/cron 备选方案 → 跑 doctor。

可选旗标：`--dream`（装完立刻做首次梦，要花 token，先问用户）、`--no-auto-update`（关掉每日自动更新，默认开，见 §5b）。

没有 root/systemd 时，按 install.sh 输出的备选方案执行（nohup 常驻 + cron 夜梦）。

## 3. 配置 `config.local.json`

最小可用配置（把示例值换成用户的）：

```jsonc
{
  "llm": {
    "protocol": "openai",                      // 或 "anthropic"
    "baseUrl": "https://api.deepseek.com",     // openai 协议写到域名或 .../v1
    "apiKey": "用户的key",
    "model": "deepseek-chat",
    "thinking": "default"
  },
  "sessions": [
    { "agent": "pi", "dir": "~/.pi/agent/sessions" }   // 按实际路径改
  ]
}
```

推荐（用户有两个模型时）——recall 档（查询理解+重排）用便宜快模型并关思考，dream 档用聪明模型：

```jsonc
"llm": {
  "protocol": "anthropic", "baseUrl": "...", "apiKey": "...", "model": "claude-sonnet-4-5",
  "steps": {
    "recall": { "protocol": "openai", "baseUrl": "https://api.deepseek.com",
                "apiKey": "...", "model": "deepseek-chat", "thinking": "off" }
  }
}
```

写完后：

```bash
chmod 600 config.local.json        # 里面有 key
node src/cli.ts doctor             # 必须全 PASS（WARN 可接受但要知道为什么）
```

doctor 的 LLM 检查会真实调用两个档位的模型各一次（花费可忽略），并报告延迟。
如果 LLM 检查 FAIL：协议选错、key 错、模型名错，按报错修正后重跑 doctor。

## 4. 启动服务

install.sh 已处理 systemd 场景。手动场景：

```bash
nohup node src/cli.ts serve >> logs/serve.log 2>&1 &
curl -s http://127.0.0.1:8899/health    # {"ok":true,...}
```

## 5. 接入你的客户端

### 你是 pi（或 pi web）

```bash
cp examples/pi-extension/ruyi.ts ~/.pi/agent/extensions/ruyi.ts   # pi web 按实际扩展目录
```

多账号 pi web：给每个账号的环境设 `RUYI_OWNER=<账号名>`，记忆互相隔离。
重启 pi 后：系统提示里会出现记忆注入，`ruyi_recall` / `ruyi_remember` 工具可用，`/ruyi` 命令查状态。

### 你是 Claude Code

```bash
claude mcp add ruyi -- node <仓库绝对路径>/src/cli.ts mcp
```

验证：`claude mcp list` 里能看到 ruyi；对话中试一次 `ruyi_recall`。

### 你是 opencode

在 `~/.config/opencode/opencode.jsonc` 加：

```jsonc
{
  "mcp": {
    "ruyi": {
      "type": "local",
      "command": ["node", "<仓库绝对路径>/src/cli.ts", "mcp"],
      "enabled": true
    }
  }
}
```

重启 opencode 后工具列表里应出现 `ruyi_*`。

### 你是 Hermes / 其他 MCP 客户端

把 `node <仓库绝对路径>/src/cli.ts mcp` 注册为 stdio MCP server（具体注册入口查你所在客户端的 MCP 文档）。
它暴露 `ruyi_recall`（fast/deep/excavate 三模式）、`ruyi_list`、`ruyi_get`、`ruyi_ingest`。
MCP 进程直接打开同一个 SQLite 库（WAL 模式，多进程安全），与 HTTP 服务读写同一份记忆。

### 多客户端共用（重要）

一个 ruyi 实例就是全家的记忆中心：pi 走扩展、Claude Code/opencode 走 MCP、脚本走 HTTP，**默认共享同一个 owner=default 的记忆池**——Claude Code 里形成的经验，pi 也能回忆到，这正是设计目的。
需要隔离时（多人共用一台机器）：给不同客户端/账号设不同的 `RUYI_OWNER`，记忆互不串。
做梦侧也要让所有客户端的会话都被读到：在 `config.local.json` 的 `sessions` 里加各 agent 的日志目录（pi 和 claude-code 的解析器内置；其他格式见 §7）。

### 多机共享（同一人的多台主机）

记忆主机侧（跑一次）：`config.local.json` 里设 `"host": "0.0.0.0"` + `"authToken": "<长随机串>"`，重启服务。**暴露了端口就必须设 authToken**，否则等于把全部记忆公开。

其他机器上的 agent：全部改走 HTTP 接口（下节），请求头加 `Authorization: Bearer <authToken>`。pi 扩展设两个环境变量即可：`RUYI_URL=http://<主机>:8899`、`RUYI_TOKEN=<authToken>`（pi web 用户写进服务的环境）。MCP-stdio 是本机模式，远程机器不要用 MCP 接。

### 任何其他 agent

**接口契约的唯一权威是 [API.md](API.md)**——每个 HTTP 端点和 MCP 工具的字段级定义都在那里，
且每次发布由 `test/api-contract.ts` 逐字段验证，文档与实现不一致则发布失败。自写脚本/扩展对接照它实现即可。
简要一览：

```
POST /recall   {"query": "...", "k": 5, "mode": "deep"}     # mode: fast(免费)/deep/excavate
GET  /inject?owner=default                                   # 宪法+索引+画像目录，纯SQL
POST /ingest   {"text": "..."}                               # 提交文本做梦蒸馏
GET  /stats?days=7
```

## 5b. 每日自动更新（默认开启）

`scripts/self-update.sh`：每天检查一次，**只升级到打了 tag 的正式发布版**（每个 tag 发布前已过 tsc + 34 项零 LLM 测试 + LLM 冒烟）；拉取后本地再过一遍 tsc + smoke，任何一关失败自动回滚到原版本。不碰 `config.local.json`/`data/`/`profiles/`，工作区不干净时拒绝执行。
install.sh 默认就会装上这个 cron（每天 04:40）；用户明确不要时用 `--no-auto-update`，事后想开随时重跑 install.sh 即可。
结果写在 `logs/self-update.status`（updated/skipped/rolled-back/error），排障看 `logs/self-update.log`。

## 6. 首次做梦（必须先问用户！）

第一次做梦会通读历史会话日志，**消耗的 tokens 与日志量成正比，可能很多**。
默认只处理最近 14 天（`dream.initialMaxDays`）。流程：

1. 告诉用户预估规模（只看最近 200KB/文件的增量，老历史默认跳过，`dream.initialMaxBytes` 控制），征得同意
2. 告诉用户预估规模，征得同意
3. `node src/cli.ts distill`（前台跑，能看到进度；量大时放后台并定时检查）
4. `node src/cli.ts list` 抽查记忆质量
5. `node src/cli.ts synthesize` 生成画像章（记忆 <10 条会自动跳过）
6. 跑一次真实 recall 冒烟：`node src/cli.ts recall "用户最近常做的工作类型" --mode=deep`

## 7. 故障排查

| 症状 | 处理 |
|---|---|
| doctor LLM FAIL | 检查 protocol/baseUrl/apiKey/model；openai 协议 baseUrl 不含 `/chat/completions` 后缀 |
| recall 永远空 | `node src/cli.ts list` 确认库非空；确认 owner 一致（默认 `default`） |
| pi 里看不到注入 | 确认扩展在正确目录、pi 已重启；服务挂时 pi 表现与未安装相同（设计如此） |
| 日志不是 pi/claude-code 格式 | `src/preprocess.ts` 里有 parser 注册点，照现有 parser 仿一个 |
| 中文搜不到 | 该 bug 已在 v2 修复（trigram FTS）；老库升级会自动迁移，跑 doctor 的 FTS 自检确认 |

## 8. 装完之后

告诉用户：安装完成 + doctor 结果 + 记忆条数 + 夜梦时间（systemd timer 或 cron）+ 是否开了每日自动更新。
日常使用你什么都不用管：白天正常干活，需要回忆时用 `ruyi_recall`（试探用 fast，重要用 deep），
用户说"记住……"时用 `ruyi_remember`，夜间它自己做梦成长。
