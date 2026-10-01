# 真机验证报告：dsh-memory-skills（技能管理器 + 后台自我进化）

> 环境：Windows + DSH（headless profile，`dsh` 0.1.0-rc.7）。
> 旧插件（CJK 检索 / 混合检索 / core 记忆）的真机结果见根 README §6 与讨论帖 #3671。
> **2026-08-21 已在本机完成技能管理器部分实测**（见 §0.1 记录）；后台进化的"蒸馏触发"仍需交互会话观察（见 §3）。

## 0. 前置

- 仓库更新到含 `dsh-memory-skills` 的版本；
- `dsh` 与 `pnpm` 需要能在 PATH 中找到（Windows 上常见缺失，两个修法）：
  - `dsh`：用 profile 内的 CLI 全路径 `node "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js"`，或把 `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\.bin` 加进 PATH；
  - `pnpm`：`AppData\Roaming\npm\pnpm.cmd` 放一个桥接 shim（内容 `@echo off` + `corepack pnpm %*`），`AppData\Roaming\npm` 已在 PATH；
- 安装（**本地路径必须带 `./` 前缀**，否则 pnpm 会当 git 依赖解析）：

```sh
dsh plugin --profile headless add ./packages/dsh-memory-bundle
dsh plugin --profile headless add ./packages/dsh-memory-skills
cd $env:DSH_HOME/profiles/headless && corepack pnpm install
dsh --profile headless --dump-config | Select-String memory-skills   # 确认进合成树
```

### 0.1 已实测记录（2026-08-21，真实 harness）

| 验证项 | 结果 |
|---|---|
| 整树启动（含 memory-skills） | ✅ `dsh --profile headless "reply with OK only"` → 模型回复 OK，exit 0 |
| `skill_write` 建技能 | ✅ 生成 `C:\Users\钱铃\.dsh\skills\verify-tool.md`，frontmatter 正确，且**实时进入会话技能目录**（系统提示可见） |
| `skill_list` | ✅ 返回 `- verify-tool (managed): verification skill for testing` |
| `skill_delete` | ✅ 删除文件，目录实时清空 |
| `skill_events` 日志 | ✅ 派生库记录 `created` / `deleted`（含会话 ID 与时间戳） |
| 主循环无干扰 | ✅ 三次一次性任务均正常完成，无额外输出/卡顿 |

> 修复过程中发现并解决的真机问题：① cordis 加载器读**命名导出**（`export default apply` 会让 inject 失效 → `cannot get property "tools" without inject`），已移除默认导出；② `dsh plugin add` 的本地路径必须 `./` 前缀（`anchorPathSpec` 只锚定 `.`/`..` 开头）。

## 1. 技能管理器（模型工具）验证

新建/继续一个会话，向模型提出：

> 请用 skill_write 创建一个技能 `pnpm-recovery`：内容为「遇到 lockfile 不一致时运行 `pnpm install --no-frozen-lockfile` 后重新构建」，描述一句话，whenToUse 写「当 pnpm install 失败时」。

**预期**（已实测同类流程）：
1. 返回 `Skill "pnpm-recovery" created at <path>`；
2. 文件出现在 `$env:DSH_HOME\skills\pnpm-recovery.md`，内容为 DSH 原生格式：

```markdown
---
name: "pnpm-recovery"
description: "..."
whenToUse: "当 pnpm install 失败时"
---
<正文>
```

3. 让模型执行 `skill_list`，应能看到 `pnpm-recovery (managed)`；
4. 让模型执行 `skill_delete` 再 `skill_list`，技能消失、文件删除。

**记录**：✅（2026-08-21 实测 verify-tool 全流程）

## 2. 技能对 agent 可见性验证（关键：写入即进会话技能目录）

保持 `pnpm-recovery.md` 存在，在新会话里问模型：

> 你有哪些可用技能？遇到 pnpm lockfile 不一致时该怎么做？

**预期**：模型能通过原生技能目录（`skill` 工具/会话目录）发现并加载 `pnpm-recovery`，并按其内容回答——证明写出的文件被 DSH 内置 `dsh-skill-filesystem`（user-dsh 根，rank 400）自动拾取，无需重启。

**记录**：✅ / ❌

## 3. 后台自我进化验证

### 3.1 临时调小进化间隔（便于观察）

编辑 profile 的 `dsh-memory-skills` 配置（或在 `cordis.patch.yml` 中临时加上）：

```yaml
- id: memory-skills
  name: dsh-memory-skills
  config:
    path: ./.dsh-verify/memory-skills.db
    evolveIntervalMs: 10000     # 临时：10 秒一轮
    evolveCooldownMs: 30000
    evolveMinAssistantChars: 40 # 临时：短消息也参与
```

### 3.2 制造"可复用技能"回合

在会话里完成一段**可重复的过程**，例如：

1. 让模型解决一个带具体步骤的问题（如：构建报错 → 定位 → 修复 → 验证成功）；
2. 确保最后一步是模型输出了较长的总结性回答（≥ 阈值）。

### 3.3 观察

**预期**（10–60 秒内）：
1. `$env:DSH_HOME\skills\` 下出现模型蒸馏出的新技能文件（名字/内容由反思决定，也可能是"不值得沉淀"的跳过）；
2. 事件日志可查。SQLite 派生库（默认 `$env:DSH_HOME\memory-skills.db`）用 sqlite3 查看：

```sh
sqlite3 "$env:DSH_HOME\memory-skills.db" "SELECT kind, name, substr(reason,1,60), datetime(created_at/1000,'unixepoch','localtime') FROM skill_events ORDER BY created_at DESC LIMIT 10;"
```

**预期**：出现 `created` / `updated`（或合理数量的 `skipped`，reason 为"no skill-worthy pattern"）。

**记录**：✅ / ❌（贴 `skill_events` 输出）

## 4. 稳定性验证（后台不干扰主循环）

- 进化触发期间，正常对话不应卡顿、不应出现模型额外输出或历史污染；
- `skill_events` 不应出现 `error` 堆积（若有，贴报错）。

**记录**：✅ / ❌

## 5. 卸载韧性验证

1. 临时禁用 `dsh-memory-skills` 行后重启 profile；
2. 技能文件仍在 `$env:DSH_HOME\skills\`，且仍能被 agent 加载（纯 Markdown，不依赖插件状态）。

**记录**：✅ / ❌

---

## 结果汇总

| # | 项目 | 结果 |
|---|---|---|
| 1 | skill_write / skill_list / skill_delete 工具 | ✅ 2026-08-21 实测 |
| 2 | 技能文件格式（frontmatter）正确 | ✅ 实测 |
| 3 | 写入即进会话技能目录（新会话可加载） | ✅ 实测（系统提示实时可见） |
| 4 | 后台进化自动蒸馏技能 | ⏳ 需交互会话观察（单测已覆盖逻辑） |
| 5 | skill_events 日志可查 | ✅ 实测（created/deleted） |
| 6 | 主循环无干扰 / 无 error 堆积 | ✅ 实测 |
| 7 | 卸载后技能文件保留 | ⏳ 未测（纯 Markdown，设计保证） |

发现问题请附输出，反馈到仓库 issue 或讨论帖。

---

# 附录 A：宿主版本契约（issue #1）

> 触发：issue #1（DSH Desktop 2.0.4 / `TypeError: this.ctx.sessionQuery.observeSession is not a function`；同帖评论区里 0.1.5-rc.3 宿主上的历史加载失败是同一个根因）。

## A.1 根因

`ctx.sessionQuery` 由本仓的 `dsh-session-query-sqlite-cjk` 提供，它是 `SessionQueryEngine` 的**继承子类**；而宿主（`dsh-api-session-controller`、gateway、`readSession`/fork/resume）把这个服务当作**它自己安装的那份** `@deepseek-ai/dsh-session-query` 来调用。当两边的 `@deepseek-ai/dsh-session-query` 不是同一份时：

- 引擎继承的基类没有 `observeSession()`（该方法自 upstream **0.1.2-rc.1** 起才在基类上，fork 此前 pin 的是 `^0.1.0-rc.7`），
- 宿主拿到的是一个 "看起来像 sessionQuery、但缺方法" 的对象，
- 于是会话列表把 cold session 降级为 visible 并逐条告警，历史/恢复/fork 一并受损。

## A.2 三处修复

1. peer/dev 依赖统一到宿主当代版本 `^0.1.5-rc.3`（cordis `^4.0.2`）：保证与宿主解析成**同一份** `dsh-session-query`，`observeSession()` 由基类提供。
2. 活会话日志读取归一化：`session.events`（0.1.0 线）与 `session.snapshotEvents()`（0.1.1+）两者都认，都不认则**显式抛错**。
3. 持久化读取适配两代 API：`listSnapshots()`/`inspect()`（0.1.0–0.1.1）与 `list()`/`open()`/`read()`（0.1.3+）。

三者共同的失败模式都是**静默**：观察异常被 best-effort 的检索 catch 成空结果，"链路坏了" 与 "没有命中" 无法区分。

## A.3 复现与验证

```powershell
# 1) 全量单测（含 issue #1 三条回归）
node --test --experimental-test-isolation=none `
  packages/dsh-session-query-sqlite-cjk/test/cjk.test.js `
  packages/dsh-memory-index/test/memory-index.test.js
```

**红→绿交叉验证（已做）**：在 `packages/dsh-session-query-sqlite-cjk/node_modules/@deepseek-ai/dsh-session-query`
位置临时放一个 re-export 真实模块、但把基类 `observeSession` 抹成 `undefined` 的替身（等价于旧 peer 解析出另一份基类的状态），

```powershell
node packages/dsh-session-query-sqlite-cjk/test/cjk.test.js
# → AssertionError: CjkSessionQueryEngine must inherit observeSession from the mounted @deepseek-ai/dsh-session-query
```

确认该回归**确实会因为缺少 `observeSession` 变红**（而不是永远绿），再换回 `^0.1.5-rc.3` 得到 16/16 绿。

| # | 验证项 | 结果 |
|---|---|---|
| A1 | `CjkSessionQueryEngine.prototype.observeSession` 是函数，且能对真实形态活会话完成 observation | ✅ 单测（`@deepseek-ai/dsh-session-query@0.1.5-rc.3`） |
| A2 | 只提供 `header` + `snapshotEvents()` 的会话仍可检索到 | ✅ 单测 |
| A3 | `list()`/`open()`/`read()` 一代持久化仍可检索到只剩持久化记录的会话 | ✅ 单测 |
| A4 | 两代都不认时显式报错，而非静默 0 命中 | ✅ 单测（`assert.rejects`） |
| A5 | 全仓单测 | ✅ 69/69 |
| A6 | 真实 DSH 进程（会话列表 / 历史 / 恢复） | ⏳ 待宿主侧实测确认 |

> A6 需要在装有本 bundle 的 profile 上实测：本次改动只做到"契约级 + 单测级"验证，未在真实宿主进程中复现 issue #1 的场景（该宿主版本 `@deepseek-ai/dsh-desktop` 不在本机）。

---

# 附录 B：来源守卫与固定层真机验证（2026-10-01）

> 触发：讨论 [#3898](https://github.com/deepseek-ai/deepseek-harness/discussions/3898#discussioncomment-18204894) 的评论建议留一个"模型永远写不到"的层。设计、审计与边界见 [`docs/PROVENANCE-AND-PIN.md`](PROVENANCE-AND-PIN.md)；本附录只记**怎么跑、跑出什么**。

## B.0 环境与前置

- DSH headless profile，8 个包全部 `link:` 到本仓库工作区（改代码即生效）；
- overlay 把 `skillDir` 与派生库全部移进工作区，便于取证与复现：

```yaml
# .dsh-verify/e2e-patch.yml
- id: memory-skills
  name: dsh-memory-skills
  config:
    path: ./.dsh-verify/e2e-memory-skills.db
    skillDir: ./.dsh-verify/e2e-skills
    evolveEnabled: false
- id: memory-core
  name: dsh-memory-core
  config:
    path: ./.dsh-verify/e2e-memory-core.db
```

- 预置两个 fixture：`e2e-skills/user-handbook.md`（人手写，无 provenance）、`e2e-skills/pinned-rule.md`（`metadata: {managed: true, source: "model", pinned: true}`）；
- 运行命令（两次会话，同一 overlay）：

```powershell
dsh --profile headless --patch ./.dsh-verify/e2e-patch.yml "<让模型依次尝试越权写入并原样回报工具输出>"
```

## B.1 结果

| # | 验证项 | 结果 |
|---|---|---|
| B1 | 模型创建自己的技能 | ✅ `Skill "e2e-model-skill" created at …\e2e-skills\e2e-model-skill.md.` |
| B2 | 模型更新自己的技能 | ✅ `Skill "e2e-model-skill" updated at …`（`skill_list` 显示 `e2e model skill v2`） |
| B3 | 模型覆盖**用户手写**技能 | ✅ 拒绝：`is written by the user (source: human); model write is refused` |
| B4 | 模型删除**用户手写**技能 | ✅ 拒绝：`model delete is refused` |
| B5 | 模型覆盖**被固定**技能 | ✅ 拒绝：`is pinned by the user (pinned: true); model write is refused — ask the user to run /skill-unpin pinned-rule` |
| B6 | 两个用户文件事后状态 | ✅ 重新读取**逐字节未变** |
| B7 | `skill_list` 来源标注 | ✅ `e2e-model-skill (managed:model)` / `pinned-rule (pinned, managed:model)` / `user-handbook (human)`；bundled 技能不带标签 |
| B8 | 拒绝的审计留痕 | ✅ `skill_events` 顺序：`created` → `refused(write)` → `refused(delete)` → `refused(pinned write)` → `updated`，每行带 `source=model` |
| B9 | 新 topic 走真实工具 schema | ✅ `memory_remember(topic: lesson)` → `已记住 (98500077-…)`；`core_facts` 行：`topic=lesson, pinned=0, source=model` |
| B10 | 无命令 adapter 时插件仍启动 | ✅ headless 没有 `ctx.commands`，`ctx.inject(["commands"], …)` 不 resolve，插件照常 boot |
| B11 | 单测 | ✅ 全仓 **86/86**（其中 skills 20、core 19） |
| B12 | **宿主侧兼容**：带 `metadata` 块的文件是否仍被 `dsh-skill-filesystem` 正常发现与加载 | ✅ 放进项目根 `.dsh/skills/`（rank 100）后**无需重启**即出现在会话技能目录，`skill` 工具返回的正文正是文件正文（`metadata` 块被正确剥离） |

### B.1.1 B12 的取证过程

```powershell
# 1) 在项目根写一个带 provenance 的技能文件（项目根 = 含 .git 的目录）
#    .dsh/skills/provenance-host-check.md
#    frontmatter: name / description / whenToUse / metadata{managed,source}
#    body: PROVENANCE-HOST-CHECK-OK-7F3A2B

# 2) 本会话的可用技能目录在写入后立即刷新（无需重启），新增条目：
#    - provenance-host-check: Verifies the host loader still accepts a skill file that carries
#      this plugin's provenance metadata block

# 3) 用 skill 工具加载该技能，返回：
#    <skill_instructions>
#    PROVENANCE-HOST-CHECK-OK-7F3A2B
#    </skill_instructions>

# 4) 删除该文件后，技能目录同样立即移除该条目（watcher 双向生效）
```

意义：`metadata` 是宿主**文档中列为可选键**的 provider 私有元数据通道（`parseSkillFile → optionalMetadata`），实测确认它不是"我们的私有扩展"——写了 provenance 的技能仍是被宿主正常识别的原生技能，且正文与元数据分离正确。这是本方案的**前置假设**，所以单列一条。

**B10 的边界**：正因 headless 没有命令面，`/skill-pin` `/skill-unpin` `/memory-pin` `/memory-unpin` `/memory-list` **没有端到端真机验证**，只有 handler 级单测（`registerSkillCommands` / `registerMemoryCommands`）。命令面需要在交互式 profile（web/tui）里手工过一遍。

## B.2 复现命令

```powershell
# 单测（沙箱内必须用单进程隔离，逐文件 spawn 会被拦）
node --test --experimental-test-isolation=none `
  packages/dsh-session-query-sqlite-cjk/test/cjk.test.js `
  packages/dsh-tool-result-dedup/test/dedup.test.js `
  packages/dsh-memory-index/test/memory-index.test.js `
  packages/dsh-memory-tool/test/memory-tool.test.js `
  packages/dsh-compaction-locator/test/compaction-locator.test.js `
  packages/dsh-memory-core/test/memory-core.test.js `
  packages/dsh-memory-skills/test/skills.test.js
# ℹ tests 86 / ℹ pass 86 / ℹ fail 0

# 审计轨迹取证
node -e "const{DatabaseSync}=require('node:sqlite');const s=new DatabaseSync('.dsh-verify/e2e-memory-skills.db');console.table(s.prepare('SELECT kind,name,source,substr(reason,1,52) reason FROM skill_events ORDER BY created_at').all())"
```

## B.3 已有的相反实证（墙 (b)）

同一套沙箱在 **workspace-write** 会话里拒绝对默认技能根的写入：

```text
write C:\Users\钱铃\.dsh\skills\sandbox-probe.md
→ [sandbox: file access denied under workspace-write mode]
```

即默认技能根在会话 workspace 之外，通用 `write`/`edit` 工具够不到；该保护在把 `skillDir` 配置进工作区时失效（见 PROVENANCE-AND-PIN §5）。

## B.4 未验证项（照实列出）

1. **交互式命令面端到端**（B10 的边界，需 web/tui profile 手工验证）；
2. **v1 → v2 真实库升级**：迁移逻辑有单测（构造 v1 库后打开，行与列齐备、`migrated=true`、重开不再迁移），但没有在"真机跑过一段时间、积累了大量 `skill_events`"的库上验证过；
3. **Windows 之外的宿主**：未在 Linux/macOS 上跑过。

