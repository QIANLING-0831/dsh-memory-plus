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

## 与上游的关系（fork 声明）

本包是 [`@deepseek-ai/dsh-session-query-sqlite`](https://github.com/deepseek-ai/deepseek-harness)（MIT，代码基线 v0.1.0-rc.7）的 fork-copy，完整保留了上游的调和状态机、generation、TEMP shadow、游标、分页等全部契约。改动仅：

1. 派生库标识：`application_id = 1146308690`（与上游 1146308689 区分，防止混用），`user_version = 1`；打开已有库时对**本 fork 与上游**两种标识都执行派生表白名单校验 + 版本不一致就地 reset 重建（老库自动迁移）；
2. 新增两张 trigram FTS5 表：`persisted_docs_cjk` / `temp.live_docs_cjk`（双写索引，删除同步），表名已加入 `DERIVED_USER_TABLES` 白名单；
3. 查询路由：`containsCjk(query)` 命中 CJK → 总长 ≥ 3 走 `*_cjk` trigram 表；总长 < 3 走 LIKE 回退（`ESCAPE '\'` 转义 `%`/`_`，命中后手工标记首个命中位置用于 snippet 定位，`match_count` 按字节差统计全部出现次数）；否则走原表；
4. 类名 `CjkSessionQueryEngine`，导出常量加 `CJK_` 前缀。

其余代码与上游一致。上游更新时可 diff 同步。

## 配置

与上游 `dsh-session-query-sqlite` 相同：

| Key | 默认 | 说明 |
|---|---|---|
| `path` | 必填 | 专用派生索引 SQLite 路径（`:memory:` 支持） |
| `openAt` | `startup` | `startup` / `first-search` / `never` |
| `journalMode` | `wal` | `wal` / `delete` / `truncate` / `persist` |
| `defaultLimit` / `maxLimit` | `20` / `100` | 分页 |
| `snippetChars` | `240` | snippet 上限（Unicode 码点） |
| `readWindowMax` / `persistedReadConcurrency` | `50` / `4` | 继承自服务定义 |

## 已知限制

- **trigram 表体积约为原文 2–3 倍**：双写双表，磁盘占用高于上游；派生库可丢弃、可重建（schema version 机制保证）。
- **1–2 字中文查询走 LIKE 线性扫描**：trigram 只索引 ≥3 字符的连续子串，短查询无法走索引（FTS5 的 LIKE 优化也要求模式含 ≥3 个非通配字符），因此短查询是逐行扫描——结果正确，但大语料下较慢；3 字以上中文与混合查询走 trigram 索引不受影响。
- **LIKE 通配符已转义**：查询中的 `%` / `_` 按字面匹配（`ESCAPE '\'`），不会变成通配符。
- 混排文本（中文 + 代码）以"查询是否含 CJK"为路由依据，查询为纯 ASCII 时只搜 unicode61 表。

## 测试

```sh
node --test test/cjk.test.js
```

覆盖：中文子串命中（trigram）、中英混合命中（trigram）、1–2 字中文 LIKE 回退、LIKE 通配符转义、短查询无命中、会话级检索、持久化会话检索、无命中场景。
