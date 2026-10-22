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

交互式宿主还提供用户命令 `/memory-search <关键词>`，使用相同检索服务与上面的默认限额，直接显示本会话历史结果，不请求模型。安装 bundle 的当前开发版后，可用 `Ctrl+Alt+Shift+F`（macOS：`⌘+⌥+⇧+F`）预填命令；详见根 README 的快捷键章节。

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
