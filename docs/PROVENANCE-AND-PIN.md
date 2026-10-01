# 出处标记与人工固定层：让「模型永远写不到」在 DSH 上真正成立

> 触发：GitHub 用户 [@weijiafu14](https://github.com/weijiafu14)（[pi2dsh](https://github.com/weijiafu14/pi2dsh) 维护者）在讨论 [deepseek-ai/deepseek-harness #3898](https://github.com/deepseek-ai/deepseek-harness/discussions/3898#discussioncomment-18204894)（评论时间 2026-08-30）下提出的设计经验。
> 本文记录：他指出的结构性缺口 → 修复前的实测审计 → 实现（provenance 守卫 + 人工固定层）→ 两道墙的真机证据 → 已知边界。
> 相邻文档：[`docs/VERIFICATION.md`](VERIFICATION.md)（工具面真机验证）、[`docs/DSH-MEMORY-ECOSYSTEM.md`](DSH-MEMORY-ECOSYSTEM.md)（生态定位）。

---

## 1. 背景：评论说了什么

评论的落点是一段 Hermes 源码经验（原文引用）：

> 它有一条设计经验或许对你的 3.2（反思 → 写技能）有用：hermes 把「永久置顶」类内容**结构性**挡在模型写入路径之外——`/memory-pin` 故意做成斜杠命令而非工具，源码注释原话 "makes model-authored standing instructions structurally impossible rather than merely forbidden by prompt"；后台蒸馏只能写普通记忆。你的 evolve 循环直接往 `$DSH_HOME/skills` 写，模型产出的技能和人手写的技能同权——长期跑下来或许值得留一个「模型永远写不到」的层，或至少像你已做的那样用 `(managed)` 标记 + 上限兜底。

拆成三条，逐条对照本仓库：

| # | 评论观点 | 本轮处置 |
|---|---|---|
| 1 | 直接写 `$DSH_HOME/skills`（user-dsh 根，rank 400 + watcher）是宿主侧正确姿势 | 采纳其判断，不改；见 [`docs/VERIFICATION.md`](VERIFICATION.md) §0.1 实测 |
| 2 | 建议留一个「模型永远写不到」的层 | ✅ 本轮实现：skill 侧固定层 + memory 侧固定层（§3） |
| 3 | 「至少像你已做的那样用 `(managed)` 标记 + 上限兜底」 | ⚠️ 该前提当时不成立（`(managed)` 按目录判定、非按来源）→ 本轮改为**按 provenance 判定**，上限只算托管文件（§2、§3.2） |

---

## 2. 审计：修复前的三个洞（实测）

用一个临时脚本直接调 `SkillStore`（不经过 harness），在技能目录里放一个人手写的 `my-handwritten-rule.md`，然后走模型路径：

| # | 洞 | 实测结果 | 根因（修复前代码） |
|---|---|---|---|
| 1 | `skill_delete` 能删掉目录里**任何**能解析的 `.md`，包括人手写的 | `delete() → true`，文件消失 | `delete()` 只判断 `read()` 是否成功，无归属校验 |
| 2 | `skill_write` 能静默**覆盖**人手写的同名技能 | `write() → {created:false}`，正文被替换为模型内容 | `write()` 只判断「文件是否存在」，不判断是谁写的 |
| 3 | `skill_list` 把该目录里**每个** `.md` 都标成 `(managed)` | 人手写文件被列表标为 `(managed)` | `listAvailable()` 的 `managed` 来自「在这个目录里」，与来源无关 |

结论：评论里「模型产出的技能和人手写的技能同权」是**低估**——当时模型不只是同权，而是能直接覆盖/删除用户手写的技能文件；`(managed)` 标记也不具备它看起来的含义。

---

## 3. 实现

### 3.1 provenance：插件写的文件自带出处

插件写的技能文件在 frontmatter 里带一个嵌套 `metadata` 块——这正是宿主 `@deepseek-ai/dsh-skill-filesystem` 为 provider 私有元数据预留的键（并会通过 `SkillSummary.metadata` 透出）：

```markdown
---
name: "pnpm-recovery"
description: "..."
whenToUse: "..."
metadata:
  managed: true
  source: "model"
---

<正文>
```

| 字段 | 取值 | 含义 |
|---|---|---|
| `managed` | `true` / 缺省 | 本插件写过这个文件 |
| `source` | `"model"` / `"evolve"` / `"human"` / `"legacy"` | 谁写的（`legacy` = 迁移期补记的旧文件） |
| `pinned` | `true` / 缺省 | 用户固定，模型不可改写 |

**没有 provenance 的文件一律视为用户手写**（fail-safe）：`parseSkillFile()` 在 `managed` 缺失或 `false` 时给出 `source: "human"`、`modelWritable: false`。

### 3.2 守卫规则表

`SkillStore` 的每次变更都带一个 `actor`（`model` / `evolve` / `human`）；`model` 与 `evolve` 是模型侧。守卫由 `assertModelMayTouch()` 实施：

| 目标文件 | 模型工具（`skill_write`/`skill_delete`） | 后台 evolve | 人工命令（`/skill-pin`、`/skill-unpin`、人工 `write`） |
|---|---|---|---|
| 无 `metadata`（用户手写） | ❌ 拒绝 | ❌ 拒绝 | ✅（固定时标注 `source: human`） |
| `managed: true` + `source: model`/`evolve` | ✅ | ✅ | ✅ |
| `managed: true` + `source: legacy`（迁移补记） | ✅ | ✅ | ✅ |
| 任意 + `pinned: true` | ❌ 拒绝 | ❌ 拒绝 | ✅（可解除固定） |

拒绝时抛出可读错误（模型工具把它原样返回给模型）：

```
skill "X" is written by the user (source: human); model write is refused — write a new skill name instead
skill "X" is pinned by the user (pinned: true); model write is refused — ask the user to run /skill-unpin X
```

**上限账本同时修正**：`maxSkills` 现在只统计 `managed` 文件（`count()` = `listManaged().length`），用户手写的文件既不占预算、也不能被删。

### 3.3 命令面：为什么固定只给斜杠命令

`/skill-pin <name>`、`/skill-unpin <name>` 经 `ctx.inject(["commands"], …)` 注册。`@deepseek-ai/dsh-commands` 是交互 UI 服务：斜杠行由 handler 直接对 agent 执行，**从不提交给模型**，也没有任何模型工具能派发它——这正是评论引用的那句 "structurally impossible rather than merely forbidden by prompt" 在 DSH 上的对应形态。

### 3.4 审计日志：拒绝也要留痕

`skill_events` 新增 `source` 列，并为每一次被拒的尝试写入 `refused` 行（`reason` 形如 `model write refused: <原始错误>`）。事件 `kind` 全集：`created` / `updated` / `deleted` / `refused` / `pinned` / `unpinned` / `migrated` / `skipped` / `cap` / `invalid` / `protected`；`source` 取值 `model` / `evolve` / `human` / `system`。

「模型是否试图改写我的规则」这个问题因此可审计：只有归属拒绝会记 `refused`，参数校验类失败（如 kebab-case 不合法）不记，避免噪声。

### 3.5 迁移：v1 → v2 只做加法

| 项 | 行为 |
|---|---|
| `skill_events` | `ALTER TABLE … ADD COLUMN source TEXT`（不重建、不清空） |
| 补记范围 | **只补记事件日志里出现过的名字**（`kind IN ('created','updated')`），标为 `source: "legacy"` |
| 从未被本插件写过的文件 | **永不标注**，保持 `source: human`（宁严勿松） |
| 记录 | 写一条 `migrated` 事件（`source: system`，reason 含补记文件数） |
| 向前兼容 | 库的 `user_version` 高于当前版本时显式报错拒绝启动，不静默降级 |

### 3.6 memory 侧：常驻注入段也有固定层

`dsh-memory-core` 的 section 位于每次请求最前，写在里面的内容就是**常驻指令**——正是评论所说的「永久置顶」类内容。本轮同口径加固：

| 改动 | 说明 |
|---|---|
| 新列 | `core_facts.pinned INTEGER NOT NULL DEFAULT 0`、`core_facts.source TEXT NOT NULL DEFAULT 'model'` |
| 迁移 | v1 → v2 加法迁移，旧行回落为 `pinned = 0` / `source = 'model'`（v1 只有模型写入口） |
| 新 topic | 增加 `lesson`、`correction`（对应评论提到的「教训 / 纠偏」），共 7 类；未知分类回落 `general` |
| 模型写不动用户行 | 哈希命中用户行 → 返回 `changed: false`（工具回「未改动任何记忆」）；相似度合并不再把用户行纳入候选（`pinned = 0 AND source != 'human'`）；`forget()` 对用户行抛错 |
| 模型造不出固定行 | `memory_remember` **没有** `pinned` 参数；`remember()` 只在 `actor: human` 时才认 `pinned` |
| 命令面 | `/memory-pin [topic] <text>`、`/memory-unpin <fact-id \| text>`、`/memory-list` |
| 注入渲染 | 用户行排最前（`ORDER BY pinned DESC, updated_at DESC`），行首标 `[pinned] `，并在块头加一句「标记 [pinned] 的条目由用户写入，任何工具都不能修改」 |

---

## 4. 两道墙与实测证据

固定层不是一道墙，而是两道，且互相独立。

### 4.1 墙 (a)：插件守卫（真机 headless 实测）

环境：headless profile + overlay 把 `skillDir` 与派生库移入 `./.dsh-verify`，预置**两个**文件——`user-handbook.md`（人手写，无 provenance）、`pinned-rule.md`（`metadata: {managed: true, source: "model", pinned: true}`），跑真实模型调用（第一轮创建技能，第二轮更新自己的技能并依次尝试越权）。原始工具返回：

```text
skill_write  e2e-model-skill   → Skill "e2e-model-skill" created at ...e2e-skills\e2e-model-skill.md.        (第一轮)
skill_write  e2e-model-skill   → Skill "e2e-model-skill" updated at ...e2e-skills\e2e-model-skill.md.        (第二轮：更新自己的技能)
skill_write  user-handbook     → skill_write failed: Error: skill "user-handbook" is written by the user (source: human);
                                 model write is refused — write a new skill name instead
skill_delete user-handbook     → skill_delete failed: Error: skill "user-handbook" is written by the user (source: human);
                                 model delete is refused — write a new skill name instead
skill_write  pinned-rule       → skill_write failed: Error: skill "pinned-rule" is pinned by the user (pinned: true);
                                 model write is refused — ask the user to run /skill-unpin pinned-rule
memory_remember topic=lesson   → 已记住 (98500077-16a1-44ae-be30-1940acb35728)。
```

`skill_list` 原文（bundled / native 技能不带任何标签）：

```text
- e2e-model-skill (managed:model): e2e model skill v2
- pinned-rule (pinned, managed:model): A skill the user pinned, written by a model earlier
- user-handbook (human): The user's own operating rules for this machine
```

**审计轨迹**——派生库 `skill_events` 按时间顺序（即「模型到底试过什么」）：

| # | kind | name | source | reason |
|---|---|---|---|---|
| 1 | `created` | `e2e-model-skill` | `model` | — |
| 2 | `refused` | `user-handbook` | `model` | `model write refused: …` |
| 3 | `refused` | `user-handbook` | `model` | `model delete refused: …` |
| 4 | `refused` | `pinned-rule` | `model` | `model write refused: …` |
| 5 | `updated` | `e2e-model-skill` | `model` | — |

同一次运行里 `core_facts` 新增一行：`topic=lesson`、`content=教训：真机验证前先确认 profile 目录可写`、`pinned=0`、`source=model`——新增的 `lesson` topic 走真实工具 schema 即可生效（而 `/memory-pin` 本身在 headless 里无法触发，见 §4.5）。

事后核对：两个预置用户文件重新读取后**逐字节未变**；新技能文件带 `metadata` 块；模型自己在推理里写了一句「That's fine — the tools protect.」；该 profile 没有命令 adapter，插件照常启动（§4.5 的优雅降级证据）。

### 4.2 墙 (b)：DSH 文件沙箱（实测）

在 workspace-write 会话中，代理的文件写入工具尝试直接写默认技能根（`$DSH_HOME/skills`）：

```text
write C:\Users\钱铃\.dsh\skills\sandbox-probe.md
→ [sandbox: file access denied under workspace-write mode]
```

即：默认技能根（`$DSH_HOME/skills`）位于会话 workspace **之外**，通用 `write`/`edit` 工具根本够不到——即使插件守卫被绕过也没有落点。

### 4.3 宿主侧兼容性（实测：provenance 不破坏原生技能发现）

这是本方案的前置假设——如果带 `metadata` 块的文件不再是"宿主能认的技能"，固定层就毫无意义。实测：把带 provenance 的文件放进项目技能根（`<项目根>/.dsh/skills`，rank 100）后，

| 观察 | 结果 |
|---|---|
| 会话技能目录 | ✅ **无需重启**立即出现该技能（描述取自 frontmatter，watcher 生效） |
| `skill` 工具加载 | ✅ 返回的 `skill_instructions` 正好是文件正文（`metadata` 块被宿主正确剥离，未混入指令） |
| 删除文件后 | ✅ 目录条目立即消失（watcher 双向） |

依据：宿主 `dsh-skill-filesystem` 把 `metadata` 列为可选 frontmatter 键（`parseSkillFile → optionalMetadata`），只强制 `name` + `description`。也就是说 provenance 走的是**宿主自己留的元数据通道**，不是私有扩展。取证命令与原始输出见 [`docs/VERIFICATION.md`](VERIFICATION.md) 附录 B（B12）。

### 4.4 单测与命令面覆盖

| 包 | 测试文件 | 用例数 |
|---|---|---|
| `dsh-memory-skills` | `test/skills.test.js` | 20 |
| `dsh-memory-core` | `test/memory-core.test.js` | 19 |
| 全仓（7 个包） | — | 86/86 绿（改动前 69） |

本轮实测（两个改动包，沙箱内可用写法——runner 的逐文件子进程 spawn 会被沙箱拦掉）：

```sh
node --test --experimental-test-isolation=none \
  packages/dsh-memory-skills/test/skills.test.js \
  packages/dsh-memory-core/test/memory-core.test.js
# ℹ tests 39 / ℹ pass 39 / ℹ fail 0
```

新增用例覆盖：手写文件拒绝改写/删除且逐字节不变、拒绝入日志、pin 冻结模型工具与 evolve、人工改写收编文件、pin 保留其它 frontmatter 键与正文、上限只算托管文件、v1→v2 只补记日志里的名字、后台进化撞固定文件被记 `protected`、`formatSkillLine` 标签、命令注册与幂等固定（skills）；lesson/correction、固定事实不可被模型改写/删除、固定行渲染在前、unpin 按 id/文本、迁移不丢事实、三条命令（core）。

### 4.5 命令面未做端到端（明确声明）

headless profile **没有挂载命令 adapter**，`ctx.inject(["commands"], …)` 的回调永远不会 resolve——因此 `/skill-pin`、`/memory-pin` 这类命令**无法在 headless 真机里触发**，只有交互式 profile 才有。插件本身照常启动（§4.1 的真机运行已证明），命令 handler 的行为由单测直接调用覆盖（`registerSkillCommands` / `registerMemoryCommands`）。这条限制是环境事实，不是待办：命令面**没有**端到端真机验证。

---

## 5. 边界与已知限制

| # | 限制 | 后果 |
|---|---|---|
| 1 | **`skillDir` 若被配置到 workspace 之内，墙 (b) 失效** | 只剩墙 (a)；且此时通用文件工具能直接改该目录下的文件，**不经插件、因而绕过墙 (a)**。默认值（`$DSH_HOME/skills`）在 workspace 外，两道墙同时生效 |
| 2 | 内存库路径同理 | bundle 默认把派生库放在工作区相对路径 `./.dsh-verify/…`，不受沙箱保护，只有插件守卫（§3.6）在手；生产部署建议改绝对路径 |
| 3 | 命令面无端到端 | 见 §4.5：交互 profile 才有命令 adapter |
| 4 | 模型更新**托管**文件会整段重渲 frontmatter | `name`/`description`/`whenToUse`/`metadata` 之外的手工附加键（在托管文件上）不保留；`/skill-pin` 走的是逐行改写 `metadata` 块，其它键与正文逐字节保留 |
| 5 | 迁移依赖事件日志 | 日志丢失的旧托管文件会被当作 `human`（宁严勿松），模型不能再改写它，需人工 `/skill-unpin` 或手工改文件 |
| 6 | 命令面只在交互式 profile 有 | `/skill-pin` `/memory-pin` 等需要 web/tui 的命令 adapter；headless 下不注册、也不报错 |

---

## 6. 归因与许可

- 本仓库整体 **MIT**（根 `LICENSE`）。
- **只借鉴思路，未取用代码**：评论指出的「永久置顶内容结构性排除在模型写入路径之外」来自 Hermes / [`pi-hermes-memory`](https://www.npmjs.com/package/pi-hermes-memory)（Pi 生态），由 [@weijiafu14](https://github.com/weijiafu14) 在 [pi2dsh](https://github.com/weijiafu14/pi2dsh) 中维护；我们在 DSH 上以自己的实现落地了同一结构（skill 侧 `/skill-pin`、memory 侧 `/memory-pin`），未复制其代码。
- 引用出处：[discussion #3898 评论](https://github.com/deepseek-ai/deepseek-harness/discussions/3898#discussioncomment-18204894)（2026-08-30）；文中 "makes model-authored standing instructions structurally impossible rather than merely forbidden by prompt" 为该作者转述的 Hermes 源码注释原文。
- 相关回帖：[`docs/REPLY-3898.md`](REPLY-3898.md)。
