# dsh-memory

DeepSeek Harness（DSH）记忆优化的社区插件集（`dsh-plugin`）：中文可用的会话全文检索、工具结果去重、混合记忆检索、跨会话核心记忆、近无损压缩、**技能管理器 + 后台自我进化**。Phase 0–3 已落地，并在真实 harness（headless profile）中集成验证，69 个单测通过。

> **宿主版本要求**：DSH `0.1.5-rc.3` 及同代更新版本（cordis `^4.0.2`）。`ctx.sessionQuery` 由本仓的 CJK 插件作为上游 `SessionQueryEngine` 的**继承子类**提供，必须与宿主解析成同一份 `@deepseek-ai/dsh-session-query`，否则宿主会拿到缺少 `observeSession()` 的服务实例——详见 [issue #1](https://github.com/QIANLING-0831/dsh-memory-plus/issues/1) 与 `packages/dsh-session-query-sqlite-cjk/README.md` 的「宿主版本契约」。

---

## 0. 为什么不是"第 16 个记忆插件"

DSH 记忆插件半年内涌现 20+（dsh-memory-evolve 205⭐ / dsh-mnemon 136⭐ / dsh-noema 116⭐ …），但绝大多数是**单点功能插件**，且几乎都建立在官方 `sessionQuery` 之上——而官方 unicode61 的中文缺陷意味着**整个生态的中文召回都是坏的**。

本仓库的定位是**记忆全家桶 + 修地基**：

1. **CJK 检索修复（生态唯一）**：trigram 双表 + 1–2 字 LIKE 回退——20+ 记忆插件共同受益（实测 0 命中 → 全命中）；
2. **技能自我进化**：`skill_write/delete/list` + 后台反思蒸馏（Hermes 式学习循环，请求路径零开销）；
3. **Token 去重**：工具结果哈希去重，纯省输入 Token；
4. **KV-safe 稳定注入**：基于源码级验证（`buildRequest` deepFreeze / KV 前缀缓存 / 持久化路径）的注入纪律；
5. **compaction 来源定位**：近无损压缩 + 摘要可溯源。

生态盘点（20+ 项目对照表 + license 自查）：[`docs/DSH-MEMORY-ECOSYSTEM.md`](docs/DSH-MEMORY-ECOSYSTEM.md)。

---

## 1. 插件一览

| 包 | 作用 | 阶段 |
|---|---|---|
| [`dsh-session-query-sqlite-cjk`](packages/dsh-session-query-sqlite-cjk) | 中文可用的会话全文检索 provider：FTS5 双 tokenizer 双表（unicode61 + trigram），按查询是否含 CJK 自动路由 | Phase 0 |
| [`dsh-tool-result-dedup`](packages/dsh-tool-result-dedup) | 工具结果哈希去重：重复结果（git status / ls / 重复 read）替换为指针，节省输入 Token | Phase 0 |
| [`dsh-memory-index`](packages/dsh-memory-index) | 混合记忆检索服务 `ctx.memorySearch`：sqlite-vec 向量臂 + FTS5 词法臂 → RRF 融合；事件级增量嵌入；file 词条过滤 | Phase 1 |
| [`dsh-memory-tool`](packages/dsh-memory-tool) | 模型可调用的 `memory_search` 工具：会话旧内容混合召回，输出有界 | Phase 1 |
| [`dsh-compaction-locator`](packages/dsh-compaction-locator) | 近无损压缩：每个 `<compacted-summary>` 追加 Exact Sources 定位符（spill 路径 / 文件路径 / seq 区间） | Phase 2 |
| [`dsh-memory-core`](packages/dsh-memory-core) | 跨会话核心记忆：workspace 事实库 + 稳定 system-prompt section 注入（KV 安全）+ `memory_remember` 工具 | Phase 2 |
| [`dsh-memory-skills`](packages/dsh-memory-skills) | 技能管理器 + 后台自我进化：`skill_write/delete/list` 写 DSH 原生技能文件；定时反思从完成回合蒸馏可复用技能（Hermes 式学习循环） | Phase 3 |
| [`dsh-memory-bundle`](packages/dsh-memory-bundle) | 元 bundle：一键安装以上全部插件，自动禁用 base 的 session-query / compaction 行 | 集成 |

---

## 2. 背景：DSH 记忆链路的现状与缺陷

### 2.1 `unicode61` tokenizer 对中文基本不可用（上游缺陷）

`dsh-session-query-sqlite` 用 FTS5 `unicode61` tokenizer，对 CJK 文本**不切词**：连续汉字被索引为单个 token。实测（node:sqlite + FTS5）：

| 场景（文档 `索引优化减少Token消耗的句子`） | unicode61（上游） | trigram（本插件） |
|---|---|---|
| 查询 `Token消耗` | ❌ 0 命中 | ✅ 命中 |
| 查询 `"索引优化"`（整句短语） | ❌ 0 命中（必须完整复现整句） | ✅ 命中 |

### 2.2 记忆链路是"只出不进"

- **compaction**：有损摘要，旧细节在摘要后丢失（除非当时被 spill）；
- **spill**：大结果移出上下文，但召回靠模型自己 `read`/`grep` 猜路径；
- **索引**（FTS5）只服务调用方主动搜索，**从未接回模型上下文**。

**核心洞察**：把"索引变成记忆 → 上下文的通道"——旧内容可精确找回，上下文尾部就能留短、压缩频率下降、相同内容不重复发送。

---

## 3. 架构：三层记忆数据库 + 词条索引 + 增量驱动

### 3.1 三层分层

| 层 | 内容 | 写语义 | 存储 |
|---|---|---|---|
| working | 当前上下文（surface 游标） | 每步滑动 | 不建库，就是上下文本身 |
| archival | 旧事件全文（shadowed/log-only） | **只追加**（日志不可变，派生 tag 可更新） | 派生 SQLite：chunks + vec0 向量 + FTS5 |
| core | 跨会话蒸馏事实（偏好/约定/环境/决策） | **CRUD**：哈希去重 + 相似度合并 | 派生 SQLite：core_facts |
| dedup | 工具结果哈希表 | 命中即指针化 | 进程级内存（Phase 0 MVP） |

> 为什么 archival 只追加：DSH 事件日志是事实源，surface fold 对替换/删除有引用完整性校验；对历史事件的"更新"只允许发生在派生层。

### 3.2 词条（Entry）标记 —— 全部来自事件自带元数据，零额外 LLM 成本

| 标记 | 来源 | 用途 |
|---|---|---|
| `tool:<name>` | 事件 toolName | 按工具类型过滤 |
| `file:<path>` | tool/call 的 `path`/`file_path` 参数（JSON 字符串） | **实体级定位**（"改过 src/a.ts 的所有内容"） |
| `type:<eventType>` | 事件类型 | 层内分流 |
| `surface:<...>` | surface fold 分类 | 检索范围 |
| `hash:<sha256>` | 内容规范化哈希 | 去重键 |
| `seq:<n-m>` | 日志区间 | 指针化、追溯 |

### 3.3 增量驱动的建立/更新参数（与 token 压力压缩解耦）

| 参数 | 默认 | 含义 |
|---|---|---|
| `index.batchEvents` / `index.batchBytes` | `16` / `64KB` | 事件增量批量落库 |
| `index.embedBatch` | `8` | 嵌入批量（异步、脱热路径） |
| `core.extractEveryTurns` | `5` | core 层提取节奏（当前为显式写入） |
| `core.similarityMerge` | `0.92` | 相似事实合并阈值 |
| `recall.injectBudgetRatio` | `0.04` | 注入预算（当前未启用自动注入，见 §6.3） |

### 3.4 查询管线（两级检索 + 注入前去重）

```
Stage 1  词条精确过滤（file:/tool:/hash: 零嵌入）→ 候选集
Stage 2  混合检索：FTS5 词法 + 向量语义 → RRF 融合 → 重排
Stage 3  合并候选 → 已在上下文的替换为指针 → 预算裁剪
```

---

## 4. 安装

> **尚未发布到 npm**。三种方式均可下载/安装；Release 源码包见 [Releases](https://github.com/QIANLING-0831/dsh-memory-plus/releases)（Source code zip）。

### 方式一：克隆 + 一键脚本（推荐，已验证）

```sh
git clone https://github.com/QIANLING-0831/dsh-memory-plus.git
cd dsh-memory
# Windows：
.\scripts\install.ps1 -Profile headless
# Linux/macOS：等价命令见 scripts/ 目录
```

### 方式二：克隆 + 手动安装

```sh
git clone https://github.com/QIANLING-0831/dsh-memory-plus.git
cd dsh-memory
dsh plugin --profile <profile> add ./packages/dsh-memory-bundle
dsh plugin --profile <profile> add ./packages/dsh-session-query-sqlite-cjk ./packages/dsh-tool-result-dedup ./packages/dsh-memory-index ./packages/dsh-memory-tool ./packages/dsh-compaction-locator ./packages/dsh-memory-core ./packages/dsh-memory-skills
cd $env:DSH_HOME/profiles/<profile> && pnpm install
```

> 注意：`dsh plugin add` 的本地路径参数必须带 `./` 前缀（裸写 `packages/...` 会被 pnpm 当成 git 依赖）。需要 `dsh` 和 `pnpm` 都在 PATH（pnpm 可用 `corepack pnpm` 桥接）。

> **宿主版本要求：DSH `0.1.5-rc.3` 及以后同代版本（cordis `^4.0.2`）。**
> 本仓所有包都已在 peerDependencies 中声明这一代版本。这不是形式要求：`ctx.sessionQuery` 由本仓的 `dsh-session-query-sqlite-cjk` 作为 `SessionQueryEngine` 的**继承子类**提供，若它与宿主解析成**两份不同的** `@deepseek-ai/dsh-session-query`，宿主拿到的服务实例会缺少 `observeSession()`，表现为会话列表/历史/恢复/fork 失败（issue #1）。装完后如果宿主版本不符，插件包自身会因 peer 不匹配报警——请以报警为准，不要降级 peer 声明。细节见 [`packages/dsh-session-query-sqlite-cjk/README.md`](packages/dsh-session-query-sqlite-cjk/README.md) 的「宿主版本契约」。

### 方式三：下载 Release 源码包

到 [Releases](https://github.com/QIANLING-0831/dsh-memory-plus/releases) 下载 `Source code (zip)` → 解压 → 按方式二从解压目录安装。

安装后各插件默认配置见 [`packages/dsh-memory-bundle/cordis.patch.yml`](packages/dsh-memory-bundle/cordis.patch.yml)（派生库路径为相对路径，生产建议改绝对路径）。生产嵌入需在 `memory-index` 配置 `embedder.kind: transformers` 并安装 `@huggingface/transformers`（当前默认 `char-overlap` 评估嵌入；国内模型下载用 `remoteHost: https://hf-mirror.com`）。

---

## 5. 使用

模型获得五个记忆/技能工具：

- `memory_search(query, limit, max_chars, file?)`：对本会话旧内容做混合（词法 + 语义）召回，snippet 严格有界；
- `memory_remember(content, topic?)`：写入跨会话持久事实，自动出现在该 workspace 后续请求的系统提示顶部（`## Persistent Memory` 区块）；
- `skill_write(name, description, whenToUse?, content)`：创建/更新可复用技能（写 DSH 原生技能文件，**立即进入会话技能目录**）；
- `skill_delete(name)` / `skill_list()`：删除 / 列出技能。

**后台自我进化**：`dsh-memory-skills` 定时（默认 60s）扫描已完成回合，按每会话水位线 + 冷却期 + 启发式门槛触发一次 LLM 反思（"这段回合是否产生可复用技能？"），命中即自动写入技能文件——fire-and-forget，请求路径零开销，全部动作记入派生库 `skill_events` 日志。

`<compacted-summary>` 压缩块自带定位符（`## Exact Sources (locators)`），模型可用 `read <spill file>` 或 `memory_search` 恢复精确内容。

---

## 6. 真机验证（`dsh --profile headless`，独立测试 profile）

### 6.1 结果

| 项目 | 结果 |
|---|---|
| 整树启动（7 插件已验证 + `memory-skills` 待验证） | ✅ |
| `memory_remember` 写入 | ✅ 返回「已记住 (uuid)」 |
| `memory_search` 混合召回（中文查询） | ✅ 命中 3 条真实会话记录 |
| **跨会话持久化**（新会话系统提示注入） | ✅ 逐字可见 |
| 技能工具 + 后台自我进化（`dsh-memory-skills`） | ⏳ 验证步骤见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md) |

跨会话实测输出（新会话）：

```
## Persistent Memory (workspace: C:\Users\钱铃\Desktop\ai\DSH\plus)
- [preference] 用户偏好中文回复
```

### 6.2 集成中发现的 3 个问题（单测覆盖不到，对官方/插件开发者有参考价值）

1. **Service 注册模式**：cordis `Service` 构造器签名是 `(ctx, name)`——把 config 当 name 传会注册成 `[object Object]` 并冲突；正确写法 `super(ctx, "name")` + `ctx.plugin(Class, config)`；
2. **工具注册时机**：类插件的构造器里 `ctx.tools` 尚未解析——需用函数插件入口（apply）注册工具；
3. **同步渲染要求**：system-prompt section 的 `text` 是**同步**调用——派生库需在构造器同步打开，否则新进程区块为空。

### 6.3 自动注入的接缝分析（v0.1-rc.7，源码实证，三条路径不可行）

| 候选注入点 | 否决原因 |
|---|---|
| `agent/pre-step` messages | 会被 `session.append("user/message", {surfaceOp:"append"})` 变成**持久化历史**，每步重发，Token 反膨胀 |
| `llm/stream` 改 messages | 请求被 `deepFreeze`，且 waterfall 默认闭包锁死原对象，无法替换/变更 |
| system-prompt section 注入易变内容 | 非持久化内容只能进 system prompt（请求最前），**每次变化让 KV 前缀缓存整段失效** |

因此采用"模型主动调用 `memory_search` + **稳定的** core section"形态（Letta 式分层）；**稳定性 = 注入安全性**（内容不变则 KV 前缀不变）。

---

## 7. 开发

本仓库是 pnpm workspace：

```sh
corepack pnpm install
corepack pnpm test        # 69 个单测（node --test，7 个包：CJK 16 / core 12 / skills 10 / 混合检索 8 / 工具 8 / 压缩 8 / 去重 7）
```

每个插件遵循 DSH 插件形态（`name` / `inject` / `Config` / `apply`，或 Service 类 + `super(ctx, name)`），测试覆盖检索、去重、压缩定位符、事实库、技能管理与后台进化等核心逻辑。

---

## 8. 发布状态

- **尚未发布到 npm**。`.github/workflows/publish.yml`（tag 触发 + OIDC Trusted Publishing，无长期令牌）已就绪，但需先在 npm 侧为各包配置 Trusted Publisher 后才能生效；在此之前请以 Git 方式安装。
- deepseek-ai/deepseek-harness 官方仓库暂不接受外部 PR，本仓库以独立插件生态方式贡献；上游 `unicode61` 中文检索缺陷可在官方 Discussions 反馈。

---

## 9. 开源参照

| 项目 | 借鉴点 | 对应实现 |
|---|---|---|
| [Mem0](https://github.com/oligodendrocyte/mem0) | 混合检索（BM25+向量）、记忆条目增删改、去重 | 词条过滤、core 事实库、RRF 融合 |
| [Letta / MemGPT](https://deepwiki.com/letta-ai/letta/3-memory-system)（[Memory is not recall](https://forum.letta.com/t/memory-is-not-recall/70/3)） | core / archival / recall 三层分离；召回靠模型主动调用 | §3.1 分层 + `memory_search` 工具 |
| [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | 上下文化切块（事件 + 工具/文件元数据，零额外 LLM 成本） | embedding 的语境前缀 |
| [Zep（时态知识图谱）](https://arxiv.org/html/2501.13956v1) | 实体/关系随对话增量维护 | file 词条索引（简化版） |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | SQLite 内嵌向量检索（契合单 owner 派生库） | 向量臂 |

---

## 10. 路线图与遗留

- ✅ Phase 0：CJK 检索修复 + 工具结果去重
- ✅ Phase 1：混合检索服务 + `memory_search` 工具
- ✅ Phase 2：近无损压缩 + 跨会话核心记忆 + file 实体索引
- ✅ Phase 3：技能管理器 + 后台自我进化（Hermes 式学习循环落地，见 `dsh-memory-skills`）
- ⏳ 遗留：compaction-locator / dedup / memory-skills 的真机触发验证（见 [`docs/VERIFICATION.md`](docs/VERIFICATION.md)）；bge 真嵌入验证；自动 recall 注入待 DSH 提供"非持久化 + 尾部追加"接缝

---

## License

MIT。`dsh-session-query-sqlite-cjk` 为 `@deepseek-ai/dsh-session-query-sqlite`（MIT）的 fork。
