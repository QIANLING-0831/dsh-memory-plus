# dsh-memory-tool

模型可调用的 `memory_search` 工具：对当前会话的**旧内容（归档记忆）**做混合词法+语义召回，返回**有界 snippet**。让模型在细节被挤出上下文后仍能精确取回（路径、命令、报错串、决策）——Letta 式"recall 靠模型主动调用"，零注入成本、零 KV-cache 风险。

## 安装

```sh
dsh plugin --profile web add dsh-memory-index   # 依赖服务
dsh plugin --profile web add dsh-memory-tool    # 本工具
```

## 配置

```yaml
plugins:
  - name: dsh-memory-tool
    config:
      defaultLimit: 3        # 默认返回条数（1-8）
      defaultMaxChars: 600   # 每条 snippet 上限字符（100-4000）
```

## 模型视角

交互式宿主还提供用户命令 `/memory-search <关键词>`，使用相同检索服务与上面的默认限额，直接显示本会话历史结果，不请求模型。安装 bundle 的v0.3.0 bundle 已包含后，可用 `Ctrl+Alt+Shift+F`（macOS：`⌘+⌥+⇧+F`）预填命令；详见根 README 的快捷键章节。

```
memory_search(query: "EPERM src/a.ts", limit: 3, max_chars: 600)
→ "1. [seq 42, tool/result, earlier, lexical+vector]
     错误信息: EPERM 在 src/a.ts 写入失败 ..."
```

- 输出严格有界（limit × maxChars）；
- 命中标记 `lexical`/`vector` 帮助模型判断召回来源；
- 任何失败返回提示语，绝不报错中断。

## 为什么是"工具"而不是"自动注入"

DSH v0.1-rc.7 的扩展点里没有"非持久化 + KV 友好 + 尾部追加"的注入接缝（详见根提案文档第 9 节）：`agent/pre-step` 注入会变成持久化历史、`llm/stream` 的请求是 deepFreeze 且 waterfall 闭包锁死、system-prompt section 会打断 KV 前缀缓存。模型主动调用是本阶段最诚实、零风险的形态；自动注入留待 DSH 提供接缝或 Phase 2 评审。

## 测试

```sh
node --test test/memory-tool.test.js
```

## 同工作区跨会话对话（v0.3.0 bundle 已包含）

- `memory_search_workspace(query, limit?, max_chars?)`：默认最多 3 条、每条 600 个 Unicode 码点；最大 8 条、每条 4000。
- `memory_read(source_id, before?, after?, max_chars?)`：默认前后各 3 个原始事件、总正文 6000 码点；最多前后各 10 个事件、12000 码点。事件数不等于消息数。

来源格式为 `dsh-memory:<编码后的会话ID>:<事件seq>`，可以复制给 `memory_read`，也可在回答里引用。它是持久日志定位标识，**不是已实现的 UI 点击跳转链接**。

工作区取自当前活会话的绝对 `cwd`，不接受模型指定工作区。搜索涵盖同工作区当前和其他会话，默认不跨工作区。读取旧消息不会恢复或启动旧 Agent。历史文字作为证据，不作为新的用户指令或授权。

搜索/回读失败会明确返回 unavailable；单个来源或召回臂失败会报告 PARTIAL，不能当作“没有历史”。取消信号继续向宿主传播。保留旧 `memory_search` 与 `/memory-search` 的当前会话用途。

完整示例、限制和复跑方式见 [跨会话检索说明](../../docs/WORKSPACE-RECALL.md)。
