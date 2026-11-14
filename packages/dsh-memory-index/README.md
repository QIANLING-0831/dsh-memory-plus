# dsh-memory-index

DSH 的混合记忆检索服务（`ctx.memorySearch`）：**FTS5 词法臂 + 本地嵌入向量臂 → RRF 融合**，对会话旧内容做精确 + 语义召回。

## 能力

- **向量臂**：sqlite-vec `vec0` 表（node:sqlite `loadExtension`，需 `allowExtension: true`），事件即切块 + 语境前缀（`[type @ seq]`，Anthropic contextual-retrieval 风格，零额外 LLM 成本）；
- **词法臂**：复用已注册的 `ctx.sessionQuery`（推荐搭配 `dsh-session-query-sqlite-cjk`，中文可用）；
- **融合**：RRF（k=60 默认），命中标记 `matched: {lexical, vector}`；
- **增量索引**：按会话 `last_seq` 只嵌入新事件，`indexSession()` 幂等；
- **删除回收（主分支，尚未包含在 v0.3.0 发布包）**：检索/回读前核对宿主活/冷会话列表，回收已消失来源的 chunks、向量和游标；提交时的删除代数校验阻止在途旧写入恢复数据；
- **容错**：任一臂失败自动降级，`search()` 在普通失败时返回空列表，取消信号仍抛出。

## 安装

```sh
dsh plugin --profile web add dsh-session-query-sqlite-cjk   # 词法臂（中文）
dsh plugin --profile web add dsh-memory-index               # 本服务
```

配置（`cordis.patch.yml`）：

```yaml
plugins:
  - name: dsh-memory-index
    config:
      # path 可省略；需要隔离 profile 时设置绝对路径
      dims: 512
      topK: 5
      maxChars: 2000
      embedder:
        kind: transformers            # 生产：本地 bge 嵌入
        model: BAAI/bge-small-zh-v1.5
        remoteHost: https://hf-mirror.com   # 国内镜像（可选）
```

- `embedder.kind: "char-overlap"`（默认）：确定性字符重叠嵌入，**离线评估用，非生产**；
- `kind: "transformers"`：需额外安装 `@huggingface/transformers`（可选依赖，首次运行下载 ONNX 模型约 100MB）。

未配置 `path` 时复用当前目录已有的 `.dsh-verify/memory-index.db`，否则使用 `$DSH_HOME/memory-index.db`（未设置或为空时为 `~/.dsh`）。持久库启用 WAL 和 5 秒锁等待；并发索引在写入事务内复核进度，避免重复插入。共享数据库时使用相同的模型与 `dims`。

## 已知坑（已踩实）

1. **node:sqlite 必须 `new DatabaseSync(path, { allowExtension: true })`** 否则 `loadExtension` 报 "extension loading is not allowed"；
2. **node:sqlite 把 JS number 绑定为 REAL**，sqlite-vec 的 rowid 要求 INTEGER → 插入用 `CAST(? AS INTEGER)`（或 BigInt）；
3. FTS5 `highlight()` 不接受 schema 限定表名（`temp.live_docs` 会被当列名）——见 CJK 包；
4. **活 `Session` 没有 `events` 数组**：0.1.0 线只有 `events` getter，0.1.1+ 改成 `snapshotEvents()`。文档构建与文件标签提取必须使用同一份归一化后的 `events`，否则仍会抛错并被 `search()` 吞成空结果。测试 stub 只暴露真实的 `snapshotEvents()` 契约，避免再次漏修；
5. **`readSession()` 的返回里 header 字段名是 `session`**（不是 `header`）：`{ session, inheritedEventCount, events }`，取错会拿到 `undefined` 并在 `session.header` 上抛错——同样被上面那个 catch 吞掉。本包用 `loaded.session ?? loaded.header` 兼容两代；
6. **best-effort 不等于静默**：活会话检索与持久化索引失败都会 `logger.warn`，包含会话 id 和错误信息；logger 自身抛错也不会破坏检索调用。

## 测试

```sh
node --test test/memory-index.test.js
```

## 同工作区搜索与原文回读

`searchWorkspace({sessionId, query, limit?, maxChars?}, exec)` 以当前活会话的绝对 cwd 为范围，通过宿主 `sessionQuery.listSessions()` 发现活/冷历史；同工作区来源按需增量索引。候选沿用每会话的词法与向量召回，再跨会话重排（词法按源内名次、向量按距离，RRF 融合，时间破同分）。向量候选在 kNN 前按会话限制，其他工作区不能挤占候选。

返回 `{items, partial, unavailableSessionIds, degradedSessionIds}`。每项带 `sourceId/sessionId/sessionTitle/seq/time`。发现来源失败会报错；单个来源或召回臂失败会标记 partial，不隐瞒成零命中。

`readWorkspaceEvent({sessionId, sourceId, before?, after?, maxChars?}, exec)` 通过宿主 `readEvent()` 回读有界原文窗口，先后检查列表及实际读取 header 的工作区归属。不会以旧派生索引授予已删除/已迁移会话的访问。只返回公开文本，不含模型 reasoning、请求头或二进制附件。

首次查询会读取同工作区历史并生成嵌入，大语料耗时取决于历史量；目前没有后台预热或查询级嵌入复用。详见 [范围及验收](../../docs/WORKSPACE-RECALL.md)。

## 删除后的索引生命周期（主分支）

schema 2 → 3 只增加 `session_fences`，保留原有正常索引。`pruneDeletedSessions(signal?)` 返回回收的已索引会话数；`search()`、工作区搜索和原文回读会自动调用。清理在同一 SQLite 写事务里删除 chunks、vec 和 `session_index`，并推进该会话的代数。每次索引在嵌入前登记代数，嵌入后重新核对当前来源，在提交锁内复核代数；已删除/替换的快照会拒绝写入，工作区搜索据此报告 partial。

宿主没有独立删除通知，因此离线删除在下次检索/回读或显式清理时回收；不把 `session/disposed` 当作删除。清单读取失败时保留数据，可列出但暂时不可读的来源也不会被当作已删除。只保留 ID、代数和删除标记作为屏障，不保存已删除正文。共享数据库的进程必须使用此实现并连接同一逻辑会话库；旧版写者不受屏障保护。外部文件系统删除与 SQLite 提交不是跨存储原子操作，最终来源检查之后发生的外部删除由下一次清理收敛。[回归与真实宿主验证](../../docs/DELETED-SESSION-INDEX.md)。
