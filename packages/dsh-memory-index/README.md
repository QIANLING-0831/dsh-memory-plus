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
