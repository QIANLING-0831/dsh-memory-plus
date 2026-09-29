# dsh-memory-index

DSH 的混合记忆检索服务（`ctx.memorySearch`）：**FTS5 词法臂 + 本地嵌入向量臂 → RRF 融合**，对会话旧内容做精确 + 语义召回。

## 能力

- **向量臂**：sqlite-vec `vec0` 表（node:sqlite `loadExtension`，需 `allowExtension: true`），事件即切块 + 语境前缀（`[type @ seq]`，Anthropic contextual-retrieval 风格，零额外 LLM 成本）；
- **词法臂**：复用已注册的 `ctx.sessionQuery`（推荐搭配 `dsh-session-query-sqlite-cjk`，中文可用）；
- **融合**：RRF（k=60 默认），命中标记 `matched: {lexical, vector}`；
- **增量索引**：按会话 `last_seq` 只嵌入新事件，`indexSession()` 幂等；
- **容错**：任一臂失败自动降级，`search()` 永不抛错（返回空列表）。

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
      path: ~/.dsh/memory-index.db   # 专用派生库，单一 owner
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

## 已知坑（已踩实）

1. **node:sqlite 必须 `new DatabaseSync(path, { allowExtension: true })`** 否则 `loadExtension` 报 "extension loading is not allowed"；
2. **node:sqlite 把 JS number 绑定为 REAL**，sqlite-vec 的 rowid 要求 INTEGER → 插入用 `CAST(? AS INTEGER)`（或 BigInt）；
3. FTS5 `highlight()` 不接受 schema 限定表名（`temp.live_docs` 会被当列名）——见 CJK 包；
4. **活 `Session` 没有 `events` 数组**：0.1.0 线只有 `events` getter，0.1.1+ 改成 `snapshotEvents()`。`indexSession` 必须 `session.events ?? session.snapshotEvents()`，否则拿到 `undefined`、fold 抛错，而 `search()` 的 best-effort `catch` 会把它变成"永远 0 命中"——症状与"没有匹配"完全一样。为什么之前单测没抓住：stub 手工构造了 `{ header, events }`，用测试假设替代了真机契约；
5. **`readSession()` 的返回里 header 字段名是 `session`**（不是 `header`）：`{ session, inheritedEventCount, events }`，取错会拿到 `undefined` 并在 `session.header` 上抛错——同样被上面那个 catch 吞掉。本包用 `loaded.session ?? loaded.header` 兼容两代；
6. **best-effort 不等于静默**：`_ensureSessionIndexed` 的 catch 现在会 `logger.warn`，检索失败也带 stack 输出；否则"链路坏了"永远无法与"没命中"区分。

## 测试

```sh
node --test test/memory-index.test.js
```
