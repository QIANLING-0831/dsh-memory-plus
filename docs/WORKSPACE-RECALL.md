# 同工作区跨会话搜索与原文回读

DSH Memory Pro v0.3.0 安装包包含以下两个工具。按根 README 安装或升级 Release 包并重启实际使用的 profile 后，模型可看到它们；无需额外服务或新增数据库。旧 `memory_search`、`/memory-search` 仍只搜索当前会话。

## 使用场景

会话 A 先讨论 Redis，随后纠正为 SQLite。新会话 B 里说：

> 继续上次的存储方案，先确认最终选型和原因，给出原始讨论来源。

模型应先调用：

```text
memory_search_workspace({query: "存储方案"})
→ [dsh-memory:old-discussion:0] 会话标题 | 时间 | user/message
  存储方案先考虑 Redis。

memory_read({source_id: "dsh-memory:old-discussion:0"})
→ [dsh-memory:old-discussion:0] 存储方案先考虑 Redis。
  [dsh-memory:old-discussion:1] 纠正：最终决定 SQLite，不用 Redis，因为项目需要离线部署。
```

随后依据第二条原文继续，引用 `dsh-memory:old-discussion:1`。不能只根据最先命中的旧方案作答。如果回读窗口被截断或可能漏掉后续变更，应扩展窗口或继续搜索“纠正/最终决定”等关键词。

这是模型按需调用工具的能力，不会自动启动旧会话，不会把全部历史注入每轮提示，也不保证任意模型都会主动调用工具。

## 来源与工作区边界

- 工作区由当前活会话绝对 `cwd` 决定，按宿主平台的路径规则规范化；不是项目名、路径前缀或模型传入的目录。两个子目录或不同 symlink 路径不会自动合并；工作区改名后的旧路径也不会自动迁移。
- 可搜索同工作区活会话和磁盘历史，读取优先使用宿主的实时来源。每次回读都重新核对归属，引用不是访问权限。
- 来源引用由会话 ID 和原始事件 seq 组成，回读窗口包含每条事件自己的引用、类型和时间。它是可复制的定位标识，不提供聊天界面的点击跳转、高亮。
- 原文只含公开的消息/工具文本；不读 reasoning、system 消息、请求头和二进制附件。截断会明确标记，正文限额按 Unicode 码点计算。
- 新工具不写长期事实或修改用户记忆。历史中的指令/审批只作引文，不能代替当前授权。

## 检索与失败行为

沿用现有每会话增量索引，不新增库 schema。查询时发现工作区来源，逐个召回，然后跨会话 RRF 重排；词法候选按源内名次、向量候选按距离排序，时间只用于同分次序。每会话贡献有限候选，不是全语料统一 BM25 排序。

默认 `char-overlap` 仍是离线评估嵌入，不能据此声称生产语义检索效果；需要真实语义召回时配置现有 transformers 嵌入。

首次查询会读取同工作区历史并建立嵌入，后续只嵌入新增事件；目前每次仍要发现和读取来源，且逐会话执行查询。大历史库的冷启动延迟尚未做规模基准。宿主原有的持久化读取与 sessionQuery 对账限制依然存在。

单个来源不可读或检索臂失效时返回 `PARTIAL`，不能将空结果视为没有历史。来源发现失败、工作区不明、跨工作区引用、非法窗口等明确返回 unavailable；取消继续传播。应用日志只记事件名、ID、数量、状态与耗时，不记录查询和原文。

## 验证与复跑

自动测试：

```sh
pnpm test
pnpm check:publish
```

真实 JSONL/zstd 持久化验证需一个独立 runtime（不修改日常 DSH_HOME）：

```sh
npm install --prefix .dsh-verify/workspace-host --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2 sqlite-vec@0.1.9
node scripts/verify-workspace-recall.mjs "$PWD/.dsh-verify/workspace-host"
```

脚本创建临时会话库：旧讨论 A、另一个工作区的私有讨论，以及冷重启后的新会话 B。执行真实工具定义的搜索和回读，断言能找到最终纠正及原因、保留来源，并拒绝其他工作区引用；重开派生索引后再执行一次。临时会话库结束后删除，输出包含合成数据的检索/回读记录。

该脚本验证工具与真实存储链路，不调用在线模型，也不代表已经验证自然语言模型会自主检索、推理或生成正确续聊回答。原生 Windows/macOS 桌面壳和新版本宿主仍需各自复测。

### 本次结果（2026-11-14）

- Node 24.21.0 / Linux，自动测试 141/141；8/8 包发布检查通过。
- 发布的 DSH 0.2.0-rc.2 真实 services：SessionStore、JSONL/zstd Persistence、CJK SessionQuery、MemorySearch、SystemPrompt、Tools 注册及插件 apply 均已挂载。
- 首次冷历史回填和重开派生索引两轮通过；新会话得到旧讨论及其后续纠正，并可回读 `dsh-memory:old-discussion:1` 的 SQLite 最终决定和离线部署原因。
- 跨工作区搜索不返回私有讨论，直接构造私有来源引用也被拒绝。中文 1/2 字、混排和扩展汉字 1/2/3 码点词法检索通过。
- 这是挂载 services 的存储/工具验证，未启动完整 Web profile、原生桌面壳，也未调用在线模型生成续聊回答。

### 在线模型跟进

在线模型的自主检索、后续纠正识别和带引用续聊，使用独立模型会话另行验证，见 [在线验收方法与结果](ONLINE-RECALL-EVAL.md)。原有离线脚本保持不调用模型。
