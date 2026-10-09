# ruyi 接口契约（API Contract）

本文档是 ruyi 对外接口的**唯一权威定义**，与代码同步维护：每次发布前 `test/api-contract.ts`
会对运行中的服务逐个端点验证文档里声明的响应结构，不一致则发布失败。
agent 要自写脚本/扩展对接 ruyi，照本文档实现即可正常工作。

两条接入面，能力等价：

| 接入面 | 适合 | 传输 |
|---|---|---|
| **HTTP API** | 任何能发 HTTP 的 agent/脚本（含远程机器） | `http://<host>:<port>`（默认 `127.0.0.1:8899`） |
| **MCP stdio** | Claude Code / opencode 等原生支持 MCP 的客户端（本机） | `node <repo>/src/cli.ts mcp` |

## 通用约定

- **鉴权**：服务端 `config.local.json` 设了 `authToken` 时，除 `GET /health` 外所有请求必须带请求头
  `Authorization: Bearer <authToken>`，否则 401。未设 `authToken`（纯本机部署）则无需任何头。
- **owner**：所有接口接受 `owner` 参数（query 或 body），缺省 `"default"`。同一人的多个 agent 用同一个
  owner 共享记忆池；不同人/需要隔离时用不同 owner。
- **错误**：统一 `{"error": "..."}` + 非 200 状态码。
- **超时建议**（重要）：纯 SQL 接口（inject/list/get/pin/forget/stats/profiles/recall-fast）百毫秒内返回，
  客户端超时 5 秒足够；**带 LLM 的接口**（recall-deep/excavate、POST /memories、ingest、synthesize、distill）
  耗时取决于 LLM，**客户端超时必须 ≥45 秒**，并建议实现熔断降级——服务不可用时 agent 应照常工作，
  只是本次没有长期记忆。ruyi 是挂件不是依赖，永远不要让 agent 阻塞在记忆服务上。

## HTTP 端点一览

| 方法 路径 | 作用 | LLM |
|---|---|---|
| GET `/health` | 存活 + 各状态记忆条数（无需鉴权） | 无 |
| GET `/inject` | 开场注入包：宪法层 + 记忆索引 + 画像目录 | 无 |
| POST `/recall` | 语义召回记忆与画像章节 | fast 无 / deep、excavate 有 |
| GET `/memories` | 列记忆（一行摘要） | 无 |
| POST `/memories` | 显式写入一条记忆（经 LLM 合并裁决） | 有 |
| GET `/memories/:id` | 取单条全文 | 无 |
| POST `/memories/:id/pin` | 钉入/移出宪法层 | 无 |
| POST `/memories/:id/forget` | 归档（软删除，可 excavate 找回） | 无 |
| POST `/ingest` | 提交原始文本走做梦提炼管线 | 有 |
| POST `/sync/session` | 推送会话日志增量（偏移量追加，断点续传） | 无 |
| GET `/sync/state` | 查询某机器各会话的已收字节数（对账） | 无 |
| GET `/profiles` | 列画像章节（摘要） | 无 |
| GET `/profiles/:id` | 取画像章节全文 | 无 |
| POST `/synthesize` | 立即重炼画像（通常由夜间 timer 驱动） | 有 |
| POST `/distill` | 立即做一次梦（异步，202） | 有 |
| GET `/stats` | 记忆条数 + token 用量报表 | 无 |

---

### GET /inject —— 开场注入（每轮会话必调）

```
GET /inject?owner=default&cwd=/path/to/project&scope=smart
```

| 参数 | 值 | 说明 |
|---|---|---|
| `owner` | string | 缺省 `default` |
| `cwd` | string | 当前工作目录，用于目录隔离 |
| `scope` | `smart`(默认) / `cwd` / `all` | smart=全局可见+本目录记忆；cwd=严格本目录；all=全库 |

响应 `200`：

```json
{
  "constitution": [{ "id": 8, "summary": "一行摘要", "content": "完整内容（pinned 记忆，永远注入）" }],
  "index": [{ "id": 361, "date": "2026-10-08", "kind": "fact", "summary": "一行摘要（≤100条，最近/常用优先）" }],
  "profileDirectory": [{ "id": 3, "title": "AI agent 与记忆系统", "maturity": "mature" }]
}
```

**用法**：把三段拼进系统提示。constitution 是铁律级；index 是目录（要全文用 `/memories/:id` 或 recall）；
profileDirectory 是画像章节清单（对话明显属于某领域时用 `/recall` 加载对应章节，一次最多一章）。
纯 SQL，任意高频调用无负担。

### POST /recall —— 语义召回

```json
{
  "query": "当前任务的自然语言描述",
  "k": 6,
  "owner": "default",
  "cwd": "/path/to/project",
  "scope": "smart",
  "mode": "deep"
}
```

| 字段 | 说明 |
|---|---|
| `query` | 必填，非空 |
| `k` | 返回记忆条数上限，缺省由服务端配置（6） |
| `mode` | `fast`=纯关键词零 LLM 试探；`deep`(默认)=海选+LLM 精选+按需加载画像章节；`excavate`=连已吸收/归档的旧记忆也挖 |

响应 `200`：

```json
{
  "memories": [{ "id": 86, "owner": "default", "cwd": null, "kind": "fact", "domain": "...",
                 "summary": "...", "content": "...", "keywords": "...",
                 "origin": "user_stated", "confidence": 0.9, "evidence": 3, "source": null,
                 "pinned": 0, "status": "active", "superseded_by": null, "absorbed_by": null,
                 "created_at": "...", "updated_at": "...", "last_seen_at": "..." }],
  "profiles": [{ "id": 3, "owner": "default", "theme": "agent-memory", "title": "...", "content": "章节全文",
                 "memory_ids": "[...]", "version": 2, "maturity": "mature", "status": "active",
                 "created_at": "...", "updated_at": "..." }]
}
```

无命中时 `memories` 与 `profiles` 均为空数组（不是错误）。

### POST /memories —— 显式写入（"记住这个"）

```json
{
  "kind": "preference",
  "summary": "一行摘要（≤30词）",
  "content": "完整内容，具体且自足",
  "domain": "可选标签",
  "owner": "default",
  "cwd": null,
  "confidence": 0.9
}
```

`kind` ∈ `preference | fact | knowledge | lesson | skill_index`（缺省 `fact`）。
写入前会经与夜间做梦**相同的 LLM 合并裁决**，重复内容变成印证而非新条目。**耗时约 10 秒级，超时务必 ≥45 秒。**

响应 `200/201`：`{ "id": 400, "action": "new" | "reinforced" | "refined" | "superseded" }`

### GET /memories —— 列表

`GET /memories?owner=default&status=active&limit=100` → `{ "memories": [MemoryRow...] }`
`status` ∈ `active`(默认) `| absorbed | superseded | archived`。

### GET /memories/:id

→ `{ "memory": MemoryRow }`，不存在 `404`。

### POST /memories/:id/pin

body `{ "pinned": 1 }`（或 `0` 取消）→ `{ "ok": true, "id": 8, "pinned": 1 }`
pinned=1 的记忆进入宪法层，每次 `/inject` 都带全文。**只钉真正的铁律。**

### POST /memories/:id/forget

→ `{ "ok": true, "id": 400, "status": "archived" }`。归档=软删除：不再注入/召回，
但 `recall mode=excavate` 仍能挖到。

### POST /ingest —— 提交原料

```json
{ "text": "原始对话/笔记文本（≥50字符）", "source": "来源标记", "owner": "default", "cwd": null }
```

同步跑完整提炼管线（triage→提炼→合并），响应为提炼报告（JSON）。适合没有配置
`sessions` 目录的 agent 主动上交对话记录。

### GET /profiles · GET /profiles/:id

`/profiles?owner=default` → `{ "profiles": [ProfileRow...] }`（含 content 全文，列表较长）。
`/profiles/:id?owner=default` → 单个 ProfileRow（含全文）。

### POST /synthesize · POST /distill

管理触发口，通常不需要 agent 调（夜间 timer 自动跑）。`/synthesize` body `{ "owner": "default" }`，
同步返回重炼报告；`/distill` 异步（`202 {"started": true}`，已有梦在跑则 `409`）。

### GET /stats —— 报表

`GET /stats?days=7&owner=default` →

```json
{
  "counts": { "active": 364, "archived": 9, "superseded": 27 },
  "tokenUsage": [{ "day": "2026-10-08", "step": "extract", "input": 12345, "output": 678 }]
}
```

### POST /sync/session —— 会话日志增量同步

远程机器把 agent 会话日志推给 ruyi（夜间做梦提炼的原料）。偏移量追加 + 内容寻址去重：

```json
{ "machine": "win11-laptop", "agent": "claude-code", "sessionKey": "proj-a/abc.jsonl",
  "sessionUid": "从内容提取的会话唯一 ID", "totalSize": 23245,
  "offset": 12345, "data": "新增的字节" }
```

- `machine`：来源机器标识（稳定不变，提炼出的环境事实会标注它）；`agent`：日志格式（`claude-code`/`pi`）；
  `sessionKey`：会话文件的相对路径
- `sessionUid`：内容寻址的会话身份（claude-code 取首行 `sessionId`，pi 取文件名 uuid）。同一 uid
  无论从哪条渠道到来都指向同一份服务端存储——手工导入过的会话再经同步协议推送时**零传输跳过**
  （`{"already": true}`）或只补真实增量
- `offset` 必须等于服务端已存字节数，否则 `409 {"receivedBytes": <真实值>}`——客户端从该处续传
- 响应 `200 {"receivedBytes": <新总量>}`；字节必须按 UTF-8 字符边界切分（参考 `examples/sync-sessions.mjs`）
- **压缩**：请求体 >50KB 时应 gzip（`content-encoding: gzip`），会话文本压缩率约 5-10 倍；
  服务端解压上限 32MB（防压缩炸弹）
- 数据落在服务端 `data/synced/<machine>/` 下，自动成为夜间做梦的会话源；已被其他渠道提炼过的
  重叠部分会继承原字节断点，不会被 LLM 重复提炼
- 一次性回填：换了新同步机制的机器，先在服务端跑一次 `node src/cli.ts sync-index`
  把已有会话源注册进 UID 表

### GET /sync/state —— 对账

`GET /sync/state?machine=win11-laptop` → `{ "machine": "...", "sessions": { "proj-a/abc.jsonl": 23245 } }`

参考发送端实现：`examples/sync-sessions.mjs`（增量、进度显示、断点续传、状态对账 `--status`）。

---

## MCP 工具（stdio）

启动：`node <repo>/src/cli.ts mcp`。协议版本 `2024-11-05`，标准 JSON-RPC 行式 stdio。
六个工具，参数与 HTTP 语义一一对应（工具名不含前缀——客户端会自动拼上服务器名，opencode 里显示为 `ruyi_recall`，Claude Code 里为 `mcp__ruyi__recall`）：

| 工具 | 对应 HTTP | 参数（* 必填） |
|---|---|---|
| `recall` | POST /recall | `query`*, `k`, `mode`(fast/deep/excavate), `owner` |
| `list` | GET /memories | `limit`, `owner` |
| `get` | GET /memories/:id | `id`* |
| `ingest` | POST /ingest | `text`*, `owner`, `cwd` |
| `remember` | POST /memories | `summary`*, `content`*, `kind`, `domain`, `owner` |
| `admin` | pin/forget/stats/profiles | `action`*(forget/pin/unpin/stats/profile), `id`, `days`, `profileId`, `owner` |

客户端配置示例（Claude Code：`claude mcp add ruyi -- node <repo>/src/cli.ts mcp`；
opencode/其他 MCP 客户端同理，见各自文档）。

## 推荐的 agent 对接姿势（最小可用集成）

1. **每轮开场**：调 `/inject`，三段拼进系统提示（零成本，必做）。
2. **需要回忆时**：`/recall`——试探用 `mode=fast`（免费），重要答案用 `deep`，考古用 `excavate`。
3. **用户说"记住……"**：`POST /memories`（超时 ≥45 秒）。
4. **上交对话原料**：要么把会话日志目录写进服务端 `config.local.json` 的 `sessions`（夜间自动做梦，
   推荐），要么主动 `POST /ingest`。
5. **故障隔离**：所有调用设超时 + 熔断（连续失败暂停调用几分钟）；服务挂了 agent 必须照常工作。

参考实现：`examples/pi-extension/ruyi.ts`（pi 扩展，含熔断降级、超时分级、异步注入竞速的完整写法）。
