# ruyi v2 设计文档

> 目标：准确、快、消耗分级、库收敛不散列。
> 原则不变：LLM all the way down（判断靠语义不靠字符串）；零运行时依赖（node:sqlite + node:http）；对宿主 agent 完全可选（挂了不影响）。

## 0. 核心心智模型：记忆有海拔

人脑不是几十万条情景记忆的反复加载，而是「情景 → 语义 → 图式」的逐层抽象。
ruyi v2 的存储按海拔分四层：

```
L3 宪法层   ~10-20 条   pinned + 毕业习惯(evidence≥5的高信度偏好) + 画像目录指针
                        每次会话无条件注入（纯 SQL，0 tokens，<50ms）

L2 抽象层   ~5-15 章    主题画像（编程习惯 / 性能技巧 / 基础设施拓扑 / 购物流派…）
                        LLM 从 L1 反思蒸馏而来；按需加载，单次至多 1 章

L1 情景层   目标 ≤300 条 active
                        原子记忆（preference/fact/lesson/knowledge/skill_index），
                        带 keywords、证据数、置信度、时间戳。检索主力，全部进 FTS。

L0 沉积层   行数不限     absorbed（已被画像吸收）/ superseded / archived
                        永不自动加载，但保留在 FTS 里，可「考古」。
```

**核心不变量：每次加载的量与库总量脱钩。** 活跃集（L3+L2+L1-active）有界收敛；L0 随便长。

## 1. 消耗分级：token 只在值得的时候花

一次查找的成本按深度爬升，浅层试探**零 token**：

| 层级 | 机制 | 延迟 | token 成本 | 用途 |
|---|---|---|---|---|
| T0 注入 | 纯 SQL：宪法 + 最近/高证据索引 + 画像目录 | <50ms | 0 | 每次会话启动 |
| T1 快查 | trigram FTS 全库 BM25 ∪ 最近 ∪ pinned，融合打分 | <100ms | 0 | 试探性查找（fast 模式） |
| T2 查询理解 | 1 次小 LLM 调用（关思考）：query → {领域, 类型, 时间窗, 同义关键词×3-5} | +1 调用 | ~500 in / ~150 out | 仅当 T1 命中稀薄时自适应触发 |
| T3 语义重排 | 1 次 LLM 调用（关思考）：≤100 条简介 → 精选 ids + ≤1 画像章 | +1 调用 | ~4k in / ~300 out | deep 模式主路径 |
| T4 兜底深挖 | T3 返回不足且有未入选 FTS 命中时，补候选再排一轮 | +1 调用 | 少见 | 长尾问题 |

`ruyi_recall` 工具三个模式：

- **fast**：只跑 T1，0 token，亚秒返回。agent 做大量初级试探时用它；返回里带 `score_hint`，agent 自行判断是否升级。
- **deep**（默认）：T1 →（稀薄时 T2）→ T3 →（不足时 T4）。一次典型 deep = 1 次 LLM 调用。
- **excavate**：fast + `include_archived`，检索 L0 沉积层——「我以前怎么处理 X 的」考古专用。

**会话启动零前摇**（pi 扩展改造）：`before_agent_start` 只同步等 T0 注入；deep 召回后台跑，结果就绪后以会话内消息补投。LLM 端点再慢也不卡启动。

## 2. 检索：全库可及，信号融合

### 2.1 地基修复（现行 bug）

FTS5 默认 unicode61 分词把整段中文视为单 token，中文关键字匹配命中率为 0。
v2 重建 FTS 为 **trigram** 分词（CJK 子串可匹配），索引列：`summary + keywords + content`。

### 2.2 取消候选资格门槛

旧设计：`evidence≥3 OR 60天内` 才有资格进候选，超 300 才启用 FTS——
恰恰会丢掉「两年前踩过一次的坑」这类最有价值的记忆。
v2：**全部 active 记忆无条件参与 FTS 检索**（倒排索引成本 ∝ 命中数，与总量无关）。

### 2.3 融合打分

```
score = BM25相关度 × (1 + 时间衰减加分 + log(1+evidence)加分 + pinned加分 + scope匹配加分)
```

- 相关度主导：强线索唤旧忆（两年前精确命中的教训 > 昨天弱相关的笔记）
- 时间是弱提升与决胜手，不是门槛
- L2 查询理解提取到显式时间暗示（「最近」「去年」）时，时间才成为硬过滤条件

候选并集：`FTS top-60 ∪ 最近20 ∪ pinned ∪ (T2触发时: 同domain/时间窗补充)`，去重截断 ≤100 条简介给 T3。

### 2.4 为什么不上向量

个人记忆规模（L0 到几万条量级）下，trigram FTS（字面/子串）+ LLM 查询扩展（同义/语义）+ LLM 重排（最终判断）已经覆盖向量的价值；引入 sqlite-vec / embedding 服务会破坏零依赖原则并增加部署复杂度。列为 v3 候选，届时以 A/B 数据说话。

## 3. 收敛与抽象：库不无限长大

### 3.1 已有机制（保留并对齐新状态机）

- **merge**（每晚）：NEW / REINFORCE / REFINE / SUPERSEDE，增量防重
- **reorganize**（每晚）：全库视角去重、解冲突、archive 不值钱的；targetSize 超出时加大力度
- **decay**（每晚）：低置信推断 90 天无再见 → archived

### 3.2 吸收机制（v2 新增的核心一环）

synthesize 升级为「深睡」反思（每周 / 大导入后）：

1. **聚类**：对 active 记忆做语义聚类（不按 domain 标签，按意义——Python 的教训和 PHP 的教训会聚进同一个「编程习惯」主题），产出 ≤10 个主题
2. **著章**：每个主题用成员全文写/刷新画像章（现有逻辑），version+1
3. **吸收**：被章节完整覆盖的成员记忆 → `status='absorbed', absorbed_by=profile_id`：
   - 豁免：pinned、毕业习惯（evidence≥5）、30 天内仍温热的
   - 被吸收者留在 L0，FTS 可考古，不再占用活跃检索面
4. **主题演化**：聚类是每次全量重跑的，主题自然合并（Python+PHP→编程习惯）与分裂；消失的主题保留旧章（stale 好过消失），重现时刷新

### 3.3 稳态循环

```
白天：使用 → 会话日志累积
夜梦：triage→extract→verify→merge→reorganize→decay   （L1 增量治理）
周梦：synthesize + absorb                                （L1 → L2 向上抽象）
结果：L1 active 收敛在目标水位（默认300），
      人的「记忆、经验、技能」以 L2 画像章 + L3 宪法为终态，
      L0 只进不出但永不自动加载。
```

## 4. 技能槽位与需求闭环

### 4.1 原理：空槽位不加载"默认通用技能"

LLM 的通用知识在训练时已固化进权重，随每次调用免费携带。槽位为空时塞"通用教程"是花钱重复已有能力，还会稀释真正值钱的用户增量。ruyi 的价值 = 用户在通用知识之上的增量（环境、习惯、坑）。

### 4.2 槽位生命周期

```
gap(缺口) → seeding(育苗) → mature(成熟) → (久不刷新则 stale)
```

- **gap**：有需求无积累，登记在册，注入侧不动作
- **seeding**：成员记忆不足著章阈值——它们就是普通 L1 记忆走正常检索；需求强烈时夜梦可提前写"育苗章"，头部标注 `成熟度: 部分经验`
- **mature**：正式画像章，每次会话至多加载 1 章，仅在对话正好落入该领域时

### 4.3 注入语气按成熟度分级

防止部分经验以"规则"姿态带偏 LLM（instruction hierarchy 污染）：

- 育苗章：「部分过往经验，仅供参考，不作为规则」
- 成熟章：「长期形成的习惯与经验，默认遵循，除非与当前需求冲突」
- 一切注入的底线：「永不覆盖用户当下说的话」

### 4.4 需求闭环

```
白天：recall_log 记录每次查找 {判定领域, 命中数, 质量, 延迟}
       命中稀薄领域 → 需求计数+1
夜梦：triage 对需求领域段落降低放行阈值（优先捕获原料）
      synthesize 按 (需求计数, 成员数) 排序著章（优先补缺口）
周梦：缺口积累够 → 育苗章 → 成熟章，版本演化
```

用进废退：需求信号驱动巩固方向，槽位系统由此成为"待完善池子"的生产侧引擎。

### 4.5 领域隔离

画像按语义主题分章（编程/中医/运维/装机互不干扰）：T3 重排只看标题目录（约10行）挑至多 1 章；L3 宪法层只放目录不放内容；agent 可用工具主动调取任意章。

## 5. 多协议 LLM 适配

```jsonc
"llm": {
  "protocol": "anthropic",           // "anthropic" | "openai"
  "baseUrl": "...", "apiKey": "...", "model": "...",
  "thinking": "off",                 // "off" | "default" | 数字(budget)；尽力而为，被拒则降级
  "steps": {                         // 两档覆盖：回忆用快/便宜模型，做梦用聪明模型
    "recall": { "model": "...", "protocol": "...", "baseUrl": "...", "apiKey": "..." },
    "dream":  { "model": "..." }
  }
}
```

- openai 协议：`/v1/chat/completions`，覆盖 DeepSeek / 通义 / OpenAI / Moonshot / vLLM / Ollama；`max_tokens` 被拒时自动换 `max_completion_tokens`；支持 `response_format: json_object` 的端点自动启用
- anthropic 协议：保留现状；thinking 关/预算已实测可用
- step 分类：`recall` 档 = T2 查询理解 + T3 重排；`dream` 档 = triage/extract/verify/merge/reorganize/synthesize
- token 记账两协议归一化，token_log 增加 `latency_ms` 列

## 6. 健壮性与运维

- **断路器分级**：注入超时不再连累 `ruyi_remember`；按操作类型独立断路；超时档 inject 2s / recall 30s / remember 45s
- **schema migration**：`PRAGMA user_version` 驱动；v2 迁移 = 加 keywords/absorbed_by 列 + trigram FTS 重建 + keywords 回填（存量每 20 条一批调 LLM 生成）
- **ruyi doctor**：服务存活 / DB 计数 / FTS 中文自检 / LLM 连通+延迟实测 / 扩展安装检测
- **备份**：每次 dream 前 `VACUUM INTO` 快照，保留 7 份
- **安全**：默认绑 127.0.0.1；config.local.json 权限 600；data/ logs/ profiles/ 全部 gitignore
- **首梦成本控制**：`dream.initialMaxDays`（默认 14 天），放全量前提示预估量
- **多用户**：pi 扩展读 `RUYI_OWNER` 环境变量（当前硬编码 default）

## 7. 发布形态

- `scripts/install.sh`：环境检测 → 配置引导 → systemd（有 root）或 nohup+cron（无 root）→ 冒烟测试
- **AGENT.README.md**：写给 agent 的自安装手册（检测→分支→命令→每步验证→回退），人类 README 精简为三行
- pi 扩展同步更新：L0 零前摇注入、三模式 recall 工具、RUYI_OWNER

## 8. 实施分期

| 期 | 内容 | 验证 |
|---|---|---|
| P1 地基 | migration 框架、trigram FTS 重建、keywords 列+回填、absorbed_by 列、断路器分级、latency_ms、recall_log | doctor 全绿；「阿里云」用例命中 |
| P2 召回 | T1 融合打分、fast/deep/excavate 三模式、T2 自适应、扩展零前摇改造 | 真实 query 集 A/B：新旧命中率对比；延迟分布 |
| P3 抽象 | synthesize v2 吸收机制、主题演化、槽位生命周期、需求闭环（triage 倾斜 + 缺口优先）、语气分级 | 模拟两轮周梦：active 数下降、画像覆盖、缺口优先补、考古可查 |
| P4 兼容 | openai 协议、steps 两档、thinking 控制 | DeepSeek 端点实测 extract+recall 全链路 |
| P5 发布 | install.sh、AGENT.README.md、systemd 模板化、gitignore 收尾、推送 | 干净机器 clone → agent 自装成功 |

旧召回路径保留为 `recall.pipeline: "legacy"` 开关一个版本周期，用于回退与 A/B。
