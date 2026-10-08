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

### 你是 Claude Code / 其他 MCP 客户端

把 `node <仓库绝对路径>/src/cli.ts mcp` 注册为 stdio MCP server，
它暴露 `ruyi_recall`（三模式）、`ruyi_list`、`ruyi_get`、`ruyi_ingest`。

### 任何其他 agent

直接 HTTP（这是通用接口）：

```
POST /recall   {"query": "...", "k": 5, "mode": "deep"}     # mode: fast(免费)/deep/excavate
GET  /inject?owner=default                                   # 宪法+索引+画像目录，纯SQL
POST /ingest   {"text": "..."}                               # 提交文本做梦蒸馏
GET  /stats?days=7
```

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

告诉用户：安装完成 + doctor 结果 + 记忆条数 + 夜梦时间（systemd timer 或 cron）。
日常使用你什么都不用管：白天正常干活，需要回忆时用 `ruyi_recall`（试探用 fast，重要用 deep），
用户说"记住……"时用 `ruyi_remember`，夜间它自己做梦成长。
