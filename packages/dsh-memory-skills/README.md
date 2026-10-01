# dsh-memory-skills

DSH 的**技能管理器 + 后台自我进化**插件：模型可直接调用的 `skill_write` / `skill_delete` / `skill_list` 工具持久化 **DSH 原生技能文件**（Markdown + YAML frontmatter），同时一个**后台定时反思循环**从已完成的 agent 回合中蒸馏可复用技能——写入即被会话技能目录识别，零核心修改；并且**每一条来源可审计、用户手写与固定的技能模型改不动**。

## 三个能力

### 1. 技能管理器（模型可调用）

| 工具 | 作用 |
|---|---|
| `skill_write` | 创建/更新**模型自己写的**技能（kebab-case 名称 + 一句话描述 + 可选 whenToUse + Markdown 正文） |
| `skill_delete` | 删除**模型自己写的**技能 |
| `skill_list` | 列出可用技能，并如实标注来源：`(managed:model)` / `(managed:evolve)` / `(human)` / `(pinned)` |

技能文件写入 `skillDir`（默认 `$DSH_HOME/skills`，即 DSH 内置 `dsh-skill-filesystem` 的 **user-dsh 根，rank 400**，目录自带 watcher 自动失效缓存）——所以**写出的技能立刻出现在会话技能目录里**，agent 下一步就能通过原生 `skill` 工具加载。

### 2. 后台自我进化（Hermes 式学习循环）

- 定时（默认 60s）扫描 live 会话，按**每会话水位线**（SQLite `skill_evolve_state`）只处理新回合；
- 启发式门槛 + **冷却期**（默认 60s）+ 窗口（默认最近 12 条事件）控制 LLM 成本；
- 触发时向模型（`ctx.llm.stream`，可用 `evolveProvider`/`evolveModel` 覆盖）发起一次**严格 JSON 契约**的反思："这段回合是否产生了可复用技能？"；
- 命中则原子写入/更新技能文件，写入的 provenance 是 `source: "evolve"`，全部动作记入 `skill_events` 日志（`engine.log()` 可查）。

设计要点：反思在**请求路径之外**（fire-and-forget 定时器），不打断主循环、不污染会话历史、不动 KV 前缀缓存；技能文件是纯 Markdown，**卸载插件也不丢**。

### 3. 来源与保护：模型写不到的那一层

每个由本插件写入的文件都带一段 `metadata` frontmatter（正是宿主 `dsh-skill-filesystem` 文档里给 provider 专用元数据留的键，会经 `SkillSummary.metadata` 暴露给消费方）：

```markdown
---
name: "pnpm-recovery"
description: "lockfile 不一致时的恢复流程"
metadata:
  managed: true
  source: "evolve"     # model | evolve | human | legacy
  pinned: true         # 用户固定后才有
---
```

| 文件来源 | 模型工具可否改写/删除 | `skill_list` 标注 |
|---|---|---|
| `source: model`（模型工具写的） | ✅ 可以 | `(managed:model)` |
| `source: evolve`（后台蒸馏写的） | ✅ 可以 | `(managed:evolve)` |
| `source: legacy`（旧版本插件写的，迁移时补齐） | ✅ 可以 | `(managed:legacy)` |
| `source: human`（用户用 `/skill-pin` 标记过、或被人工改写接手） | ❌ 拒绝 | `(human)` 或 `(pinned, human)` |
| **没有任何 provenance**（用户手写的 `.md`） | ❌ 拒绝 | 无标注（等同原生技能） |
| `pinned: true`（用户固定） | ❌ 拒绝（含后台进化） | `(pinned, …)` |

- 拒绝是**结构性**的：模型只有一个写入通道（`skill_write`），而它先做归属校验；被拒绝时返回可读原因，并往 `skill_events` 写一条 **`refused`** 审计记录——"模型是否试图改我的规则"是可查的。
- **宿主侧兼容已实测**：`metadata` 是宿主 `dsh-skill-filesystem` 文档里给 provider 私有元数据留的可选键（`parseSkillFile → optionalMetadata`，只强制 `name` + `description`）。把带 provenance 的文件放进项目技能根后，会话技能目录**无需重启**即出现该技能，`skill` 工具返回的正文正是文件正文（`metadata` 块被正确剥离）。取证见 [`docs/VERIFICATION.md`](../../docs/VERIFICATION.md) 附录 B（B12）。
- 技能数量上限 `maxSkills` **只统计插件管理的文件**，用户手写的技能不占用模型预算。
- 用户手写的技能文件在普通写入路径上**从不被重写**：pin/unpin 只按行替换 `metadata` 块，其它 frontmatter 键（例如宿主的 `disable-model-invocation`）与正文逐字节保留。

### 4. 人写的通道：斜杠命令（模型够不到）

| 命令 | 作用 |
|---|---|
| `/skill-pin <skill-name>` | 固定一个技能：此后模型工具与后台进化都不能改写或删除它 |
| `/skill-unpin <skill-name>` | 解除固定 |

命令走 `@deepseek-ai/dsh-commands`（`ctx.commands`）：斜杠命令**只对 agent 执行，永远不会变成模型消息**，也没有任何模型工具能派发它——这正是 hermes 把 `/memory-pin` 做成命令而非工具的原因。`commands` 是可选服务：headless profile 没有命令适配器时，插件照常启动，只是不注册命令（`ctx.inject(["commands"], …)`）。

## 配置

| Key | 默认 | 说明 |
|---|---|---|
| `path` | `$DSH_HOME/memory-skills.db` | 派生库（进化状态 + 事件日志），`:memory:` 支持 |
| `skillDir` | `$DSH_HOME/skills` | 技能文件目录（DSH filesystem provider 的 user-dsh 根） |
| `enabled` | `true` | 总开关（工具 + 进化） |
| `maxSkills` | `50` | 托管技能上限（不含用户手写文件） |
| `evolveEnabled` | `true` | 后台进化开关 |
| `evolveIntervalMs` | `60000` | 轮询间隔 |
| `evolveCooldownMs` | `60000` | 每会话最小进化间隔 |
| `evolveWindowEvents` | `12` | 反思输入窗口（最近 N 条事件） |
| `evolveMinAssistantChars` | `120` | 助手消息短于此长度不触发反思 |
| `evolveProvider` / `evolveModel` | 空 | LLM 覆盖（空=继承会话） |
| `evolveMaxTokens` | `1024` | 反思输出上限 |
| `evolvePrompt` | 内置 | 反思 system prompt（严格 JSON 契约） |

## 升级与迁移

派生库 schema 从 v1 升到 v2 是**加列式**迁移（`skill_events` 增加 `source`），不删任何审计数据；升级时按事件日志把**本插件曾经写过的**文件补上 `source: "legacy"`——日志里没有的文件一律不动（那是用户的）。旧版本写的技能因此保持可被模型更新。

## 安装

```sh
dsh plugin --profile <profile> add packages/dsh-memory-skills
```

或通过 `dsh-memory-bundle` 一键安装（已含本插件）。

## 测试

```sh
node --test --experimental-test-isolation=none test/skills.test.js   # 20/20
```

覆盖：技能文件读写/校验/上限、frontmatter 往返（含 `metadata` 块与未知键保留）、来源守卫（手写文件、固定文件、human 改写接手）、pin/unpin 命令、`refused` 审计、v1→v2 迁移与 provenance 补齐、后台进化的水位线/冷却/被固定技能拒绝、工具执行。

## 与生态的关系

- 技能文件格式与 [dsh-skill-filesystem](https://github.com/deepseek-ai/deepseek-harness) 原生兼容（`name` / `description` / `whenToUse` / `metadata`）；
- 与 `dsh-memory-evolve`（205⭐）同赛道但定位互补：evolve 是"五轨记忆 + 技能自进化"大而全的单体；本插件是 dsh-memory-plus 全家桶里**小而聚焦**的技能管理器 + 后台进化；
- "模型永远写不到的那一层"这个设计取自 Hermes Agent 的 `/memory-pin`（把永久置顶做成斜杠命令而非工具），由 [pi2dsh](https://github.com/weijiafu14/pi2dsh) 维护者在 [discussion #3898](https://github.com/deepseek-ai/deepseek-harness/discussions/3898#discussioncomment-18204894) 的评论中提出；本包与 `dsh-memory-core` 分别把它落到了技能层与常驻记忆层。设计与实测见 [`docs/PROVENANCE-AND-PIN.md`](../../docs/PROVENANCE-AND-PIN.md)。

### 已知限制

- 若把 `skillDir` 指到**会话工作区内**，模型的通用 `write`/`edit` 工具也能直接落盘（沙箱不再拦），此时只剩插件守卫这一道墙；
- 模型更新一个插件管理的技能文件时是**整段重渲染** frontmatter：在这种文件上手加的额外键不会被保留（用户手写文件不在此列，它们根本不会被模型重写）。
