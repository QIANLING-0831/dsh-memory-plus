# dsh-session-query-sqlite-cjk

CJK 可用的 `ctx.sessionQuery` 后端：继承 `@deepseek-ai/dsh-session-query` 服务定义的 SQLite FTS5 provider，**双 tokenizer 双表**索引——上游 `unicode61` 表（英文/代码原样）+ 新增 `trigram` 表（中文子串召回），查询**按内容自动路由**，并对 1–2 字中文查询提供 **LIKE 回退**。

## 为什么需要它

上游 `dsh-session-query-sqlite` 用 FTS5 `unicode61` tokenizer，**不切中文**：连续汉字被当成一个 token，且查询被整体包成单个短语——所以只有完整复现整句才能命中，`"Token消耗"`、`"索引优化"` 这类子串查询必然 0 命中。

实测（node:sqlite，FTS5，与 DSH 同一引擎，文档为「索引优化减少Token消耗的句子」）：

| 查询 | unicode61（上游） | trigram（本包） | LIKE 回退（本包，<3 字中文） |
|---|---|---|---|
| `Token消耗`（9 字，中英混合） | 0 | ✅ 命中 | — |
| `索引优化`（4 字） | 0 | ✅ 命中 | — |
| `中文分词`（4 字） | 0 | ✅ 命中 | — |
| 完整整句 | ✅ 命中（唯一方式） | ✅ 命中 | — |
| `消耗`（2 字） | 0 | 0 ⚠️ | ✅ 命中 |
| `索引`（2 字） | 0 | 0 ⚠️ | ✅ 命中 |
| `优`（1 字） | 0 | 0 ⚠️ | ✅ 命中 |

> 路由规则：查询含 CJK 字符且总长 < 3（无法构成任何 trigram）→ LIKE 回退；含 CJK 且总长 ≥ 3 → trigram 表（混合查询如 `Token消耗` 的 CJK 部分虽只有 2 字，但整体 ≥3 字符可构成合法 trigram，直接命中）；纯 ASCII → 走 unicode61 表，行为与上游完全一致。

CJK 检测包含 Unicode `Script=Han`（包括扩展平面的汉字，如 `𠀀` / U+20000），并保留原有 BMP 汉字、兼容汉字、平假名/片假名和 Hangul 音节范围。长度按 Unicode 码点计数：`𠀀`、`𠀀𠀁` 走 LIKE，`𠀀𠀁𠀂` 走 trigram，不把 UTF-16 代理对算成两个字符。

## 与上游的关系（fork 声明）

本包是 [`@deepseek-ai/dsh-session-query-sqlite`](https://github.com/deepseek-ai/deepseek-harness)（MIT，fork 基线 **v0.1.5-rc.3**，已在 **0.2.0-rc.2** 上交叉验证）的 fork-copy，完整保留了上游的调和状态机、generation、TEMP shadow、游标、分页等全部契约。改动仅：

1. 派生库标识：`application_id = 1146308690`（与上游 1146308689 区分，防止混用），`user_version = 1`；打开已有库时对**本 fork 与上游**两种标识都执行派生表白名单校验 + 版本不一致就地 reset 重建（老库自动迁移）；
2. 新增两张 trigram FTS5 表：`persisted_docs_cjk` / `temp.live_docs_cjk`（双写索引，删除同步），表名已加入 `DERIVED_USER_TABLES` 白名单；
3. 查询路由：`containsCjk(query)` 命中 CJK → 总长 ≥ 3 走 `*_cjk` trigram 表；总长 < 3 走 LIKE 回退（`ESCAPE '\'` 转义 `%`/`_`，命中后手工标记首个命中位置用于 snippet 定位，`match_count` 按字节差统计全部出现次数）；否则走原表；
4. 类名 `CjkSessionQueryEngine`，导出常量加 `CJK_` 前缀；
5. 宿主契约适配（见下节）：会话日志读取经 `sessionEvents()` 归一化，持久化读取同时支持两代 API。

其余代码与上游一致。上游更新时可 diff 同步。

## 宿主版本契约（必读）

`ctx.sessionQuery` 是**继承子类**实现的：本引擎 `extends SessionQueryEngine`，而宿主（`dsh-api-session-controller` / gateway / `readSession` 等）直接把 `ctx.sessionQuery` 当作它自己安装的那个 `@deepseek-ai/dsh-session-query` 来调用。两件事必须同时成立：

1. **本包声明的 peer 版本必须与宿主提供的 `@deepseek-ai/dsh-session-query` 解析成同一份**（当前声明 `>=0.1.5-rc.3 <0.3.0`）。否则本引擎继承的是另一份基类，宿主拿到的是一个没有 `observeSession()` 的服务实例，表现为：
   `api-session.list: small cold observation for "..." failed; serving it as visible: TypeError: this.ctx.sessionQuery.observeSession is not a function`
   即会话列表/历史/恢复/fork 全部降级或失败（issue #1）。

   > **0.2.0 起多了一道硬门禁**：宿主的 `@deepseek-ai/dsh-app-boot` 在**安装与启动前**用 `evaluatePluginCompatibility()` 逐个校验 `@deepseek-ai/dsh*` peer 是否满足运行时版本，不满足就拒绝加载整棵树，报
   > `Plugin dsh-memory-bundle@0.1.0 is incompatible with DSH 0.2.0-rc.2`（issue #3）。
   > 注意 semver 规则：`^0.1.5-rc.3` = `>=0.1.5-rc.3 <0.2.0`，**不含 0.2.0**；因此必须写成 `>=0.1.5-rc.3 <0.3.0`。上界停在 `<0.3.0` 是有意的——只有 0.1.5-rc.3 与 0.2.0-rc.2 实际跑过，0.3.0 应该**报错让人来验证**。
2. **会话与持久化的方法集按代适配**，不要假设单一写法：

| 依赖 | 老一代（0.1.0 / 0.1.1） | 当前代（0.1.3+ / 0.2.x，含 0.1.5-rc.3、0.2.0-rc.2） | 本包处理 |
|---|---|---|---|
| 活会话日志 | `session.events` getter | `session.snapshotEvents()`（另有 `inheritedEventCount`、`seq`） | `sessionEvents()` 两者都认，都不认则**显式报错**（不再退化成"0 命中"） |
| 持久化列举 | `persistence.listSnapshots()` | `persistence.list({ signal })` | `listPersistedSnapshots()` 两者都认 |
| 冷会话读取 | `persistence.inspect(id, signal)` → `{ meta, events }` | `persistence.open(id, 'read')` + `handle.read()` | `readPersistedLog()` 两者都认 |
| 服务定义 Config | `persistedInspectConcurrency` | `persistedReadConcurrency` + `preparedSessionCacheSize` | 都暴露；旧拼写仍被 `resolveConfig` 接受 |

> 为什么"两代都认"而不是只跟上最新：这些不一致**不会抛出到用户可见的日志里**。`searchSessions`/`searchEvents` 是 best-effort，观察失败的异常会被上层 catch 成空结果，于是"索引/观察链路坏了"和"确实没有命中"长得一模一样——这正是 issue #1 里 CJK 检索静默失效的原因。现在两条路径都在测试里各有一个 stub 覆盖。

## 与宿主 `sessionPersistence` 的取舍

当前代 `readPersistedLog` 走 `open(id, 'read')` + `handle.read()`：拿到的是**存储里的原始连续日志**，不含上游 `readColdSessionLog` 会追加的"中断回合闭合事件"。因此仅当一个会话的写入进程在回合中途崩溃、留下未闭合尾部时，本包索引到的该会话折叠结果与上游官方后端**略有差异**（可搜索文本仍然命中，只影响这一个受损尾部的 fold）。这是为保持 fork 体积小做的取舍；若需要完全一致，可改为依赖 `readColdSessionLog`。

## 配置

与上游 `dsh-session-query-sqlite` 相同：

| Key | 默认 | 说明 |
|---|---|---|
| `path` | `$DSH_HOME/session-query-cjk.db` | 当前目录已有 `.dsh-verify/session-query-cjk.db` 时复用旧库；支持显式绝对路径与 `:memory:` |
| `openAt` | `startup` | `startup` / `first-search` / `never` |
| `journalMode` | `wal` | `wal` / `delete` / `truncate` / `persist` |
| `defaultLimit` / `maxLimit` | `20` / `100` | 分页 |
| `snippetChars` | `240` | snippet 上限（Unicode 码点） |
| `readWindowMax` / `persistedReadConcurrency` | `50` / `4` | 继承自服务定义（旧拼写 `persistedInspectConcurrency` 仍接受） |
| `preparedSessionCacheSize` | `5` | 继承自服务定义（冷会话观察缓存） |

`openAt` 控制数据库打开时机，不负责后台索引。`first-search` 在首次调用 `searchSessions()` / `searchEvents()` 前不创建数据库；`startup` 只提前打开数据库。实际搜索会同步活会话及已挂载 `sessionPersistence` 列出的历史会话，因此首次搜索会回填冷历史，后续搜索按 revision 增量更新。活会话优先使用连接内的 TEMP 索引，关闭连接后 TEMP 表消失。仅看到磁盘上的 `persisted_sessions` / `persisted_docs` 为 0 不足以判定回填失败；若实际搜索仍无结果，检查 `sessionPersistence` 是否挂载、是否能列出历史，以及搜索是否报错。`0.2.0-rc.2` 的侧边栏会在输入非空查询后调用正文搜索；默认配置 `openAt: never` 会禁用该后端，不能据此认为侧边栏只检索标题。

## 已知限制

- **trigram 表体积约为原文 2–3 倍**：双写双表，磁盘占用高于上游；派生库可丢弃、可重建（schema version 机制保证）。
- **1–2 字中文查询走 LIKE 线性扫描**：trigram 只索引 ≥3 字符的连续子串，短查询无法走索引（FTS5 的 LIKE 优化也要求模式含 ≥3 个非通配字符），因此短查询是逐行扫描——结果正确，但大语料下较慢；3 字以上中文与混合查询走 trigram 索引不受影响。
- **LIKE 通配符已转义**：查询中的 `%` / `_` 按字面匹配（`ESCAPE '\'`），不会变成通配符。
- 混排文本（中文 + 代码）以"查询是否含 CJK"为路由依据，查询为纯 ASCII 时只搜 unicode61 表。

## 测试

```sh
node --test test/cjk.test.js
```

覆盖：中文子串命中（trigram）、中英混合命中（trigram）、1–2 字中文 LIKE 回退、LIKE 通配符转义、短查询无命中、会话级检索、持久化会话检索、无命中场景，以及 issue #1 的三条回归：

扩展汉字回归通过活会话、两代持久化 API 分别验证 1/2/3 码点查询的事件分页、snippet 和会话级命中；另验证短查询通配符转义、`first-search` 首次回填磁盘索引及关闭后重开检索。持久化 API 在这些单测中由 stub 提供，不能替代桌面宿主实测。

另外已通过真实 JSONL/zstd 持久化与完整 `0.2.0-rc.2` Web profile 验证正式 Loader、peer 门禁、活会话、冷重启、搜索 API、分页和侧边栏正文检索。复跑脚本与测试范围见 [CJK 宿主验证](../../docs/CJK-HOST-VERIFICATION.md)；未验证 macOS/Windows Electron 桌面壳。

- **继承宿主 `observeSession` 契约**：直接断言 `CjkSessionQueryEngine.prototype.observeSession` 是函数，并对一个真实形态的活会话完成一次完整 observation（宿主 `dsh-api-session-controller` 的入口）。
- **活会话契约**：stub 只提供 `header` + `snapshotEvents()`（无 `events` 数组），检索仍须命中——旧测试手工构造 `{ header, events }`，用测试假设替代了真机契约，因此漏掉了这个 bug。
- **两代持久化 API**：`list()`/`open()`/`read()` 与 `listSnapshots()`/`inspect()` 各一个 stub，都必须能检索到只剩持久化记录的会话。

### 跨版本交叉验证

这套测试跑通过三代真实依赖，不是只对着一个版本写的：

| 依赖来源 | 结果 |
|---|---|
| 仓库 devDeps `@deepseek-ai/dsh-session-query@0.1.5-rc.3` | ✅ 16/16 |
| 仓库 devDeps 升到 `0.2.0-rc.2`（cordis 4.0.4） | ✅ 16/16 |
| 真实 0.2.0-rc.2 依赖树（独立安装的 `dsh-session` / `dsh-session-query` / `dsh-session-persistence`） | ✅ 16/16 |

宿主侧门禁也单独验证过：用**本机真实安装的** `@deepseek-ai/dsh-app-boot@0.2.0-rc.2` 里的 `evaluatePluginCompatibility()` 逐个跑本仓 8 个包的 `package.json`，全部 PASS（此前 `^0.1.5-rc.3` 会被判 REJECT，即 issue #3）。
