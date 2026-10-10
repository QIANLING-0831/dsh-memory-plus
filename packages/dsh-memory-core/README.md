# dsh-memory-core

DSH 跨会话核心记忆（`ctx.memoryCore`）：**workspace 级持久事实**（用户偏好 / 项目约定 / 环境事实 / 决策 / **教训与纠偏**），通过**稳定的 system-prompt section** 注入每次请求——内容只在事实变化时改变，**KV 前缀缓存不受影响**（这是 Phase 1 接缝分析后唯一 KV 安全的注入形态）；并且有一条**只有人写得进去、模型改不动**的固定层。

## 能力

- **`memory_remember` 工具**：模型显式写入事实（Mem0 式 ADD），内容哈希去重 + 字符重叠相似度合并（相似事实更新而非重复）；
- **稳定注入**：`## Persistent Memory (workspace: <cwd>)` 块随 agent 的 session cwd 自动归属 workspace，每次请求都可见（头块，约 0.5–1.5K token）；
- **固定层（用户专属）**：`/memory-pin` 写入的常驻指令排在块首、标 `[pinned]`，**任何模型侧写入都不能修改或删除它**；
- **教训可沉淀**：`lesson` / `correction` 是正式 topic（"哪里错了、下次别这么干"），不是塞进 general 的杂项；
- **跨会话**：同一 workspace 的新会话冷启动即有记忆；
- **有界**：`maxFacts` 上限（默认 50），固定项优先、其余按更新时间倒序。

## 用户层：模型写不进去的那一层

这块 section 位于每次请求的最前面，写在这里的一条事实就是**常驻指令**——正是模型不该能替自己写的内容。两条规则把这件事做成结构性的：

1. `memory_remember` **没有 `pinned` 参数**；`remember()` 只对 `human` actor 认 `pinned`，而 `human` 只由斜杠命令传入。模型**根本无法创建固定事实**。
2. 工具写入**永不修改**用户写的行（`source: 'human'`）或固定的行（`pinned = 1`）：内容完全相同只是确认、不改动；相似度合并**直接跳过**这些行。删除需要 `human` actor。

| 命令（`ctx.commands`，只对 agent 执行，不会变成模型消息） | 作用 |
|---|---|
| `/memory-pin [topic] <text>` | 固定一条常驻记忆（topic 可选，必须是已知分类） |
| `/memory-unpin <fact-id \| text>` | 移除一条你写入/固定的记忆 |
| `/memory-list` | 列出本工作区的常驻记忆（固定项标 `[pinned]`，附短 id） |

注入块在存在用户行时会多一行提示，让模型知道边界：

```markdown
## Persistent Memory (workspace: C:\proj)
Entries marked [pinned] were written by the user and cannot be changed by any tool.
- [pinned] [preference] 用户偏好中文回复
- [convention] 使用 pnpm 管理依赖
```

## 安装

```sh
dsh plugin --profile web add dsh-memory-core
```

```yaml
plugins:
  - name: dsh-memory-core
    config:
      # path 可省略；需要隔离 profile 时设置绝对路径
      similarityThreshold: 0.9      # 相似合并阈值
      maxFacts: 50                  # 注入块事实上限
      sectionOrder: 50              # system prompt 内位置
```

未配置 `path` 时复用当前目录已有的 `.dsh-verify/memory-core.db`，否则使用 `$DSH_HOME/memory-core.db`（未设置或为空时为 `~/.dsh`）。旧库中的普通记忆和固定记忆都保留原文件，不自动重建；迁移前应停止 DSH、备份数据库并配置绝对路径。持久库启用 WAL 和 5 秒锁等待。

## 模型视角

```
memory_remember(content: "教训：删目录前先确认解析出的绝对路径", topic: "lesson")
→ "已记住 (uuid)。"

## Persistent Memory (workspace: C:\proj)
- [preference] 用户偏好中文回复
- [lesson] Windows 上删目录前先确认解析出的绝对路径
```

## 升级与迁移

派生库 schema v1 → v2 是**加列式**迁移（新增 `pinned`、`source`，默认 `0` / `'model'`），**不重建、不丢行**——记忆是这个包里唯一无法重新生成的数据。更新版本号高于本版时会显式报错而不是猜。

## 范围说明

- 自动从对话提取事实**刻意延后**（LLM 成本 + 噪声风险）：只做显式写入；
- 与 `dsh-memory-tool`（会话内召回）互补：**core = 常驻稳定事实，memory_search = 按需精确召回**（Letta 的 core/recall 分层）；
- `/memory-pin` 的思路来自 Hermes Agent（把永久置顶做成命令而非工具），由 [pi2dsh](https://github.com/weijiafu14/pi2dsh) 维护者在 [discussion #3898](https://github.com/deepseek-ai/deepseek-harness/discussions/3898#discussioncomment-18204894) 的评论中提出；设计与实测见 [`docs/PROVENANCE-AND-PIN.md`](../../docs/PROVENANCE-AND-PIN.md)。

## 测试

```sh
node --test --experimental-test-isolation=none test/memory-core.test.js   # 19/19
```

覆盖：去重/相似合并/上限/渲染、`lesson` & `correction` topic、固定层的三条规则（同内容不改、相似不合并、删除需 human）、注入块顺序与标记、v1→v2 迁移不丢数据、三条命令的处理器。
