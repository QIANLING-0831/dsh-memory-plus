# DSH 记忆插件生态快照（2026-08 实测盘点）

> 数据来源：GitHub API（stars/license 为查询当日值）+ npm 检索。
> 一句话结论：**本仓库（dsh-memory-plus）是生态里唯一在修"记忆地基"（CJK 全文检索）的全家桶**——先重点介绍本项目，再简列生态其余项目。

---

## 1. ⭐ 本仓库：dsh-memory-plus（重点）

**https://github.com/QIANLING-0831/dsh-memory-plus**

**一句话定位**：唯一在修 DSH 记忆地基（CJK 全文检索）+ 唯一做 Token 去重 + 唯一有 KV-safe 注入论证 + **已补齐技能自我进化**的**记忆全家桶**——不是"又一个记忆插件"。

### 全家桶组成（8 包 / 69 单测）

| 包 | 功能 | 生态唯一性 |
|---|---|---|
| **dsh-session-query-sqlite-cjk** | 中文可用的 `sessionQuery` 后端：trigram 双表 + 1–2 字中文 **LIKE 回退**（三级路由） | ✅ **生态唯一修 CJK 检索** |
| **dsh-tool-result-dedup** | 工具结果哈希去重（git status / ls / 重复 read → 指针），纯省输入 Token | ✅ 少有人做 |
| **dsh-memory-skills** | **技能管理器 + 后台自我进化**：`skill_write/delete/list` 写 DSH 原生技能文件；定时反思蒸馏可复用技能（Hermes 式学习循环，后台、KV-free） | ✅ 自进化已有 evolve（205⭐）先例，但本包与全家桶其他包形成完整地基 |
| **dsh-memory-index** | sqlite-vec 向量臂 + FTS5 词法臂 → **RRF 融合**；事件级增量嵌入；文件词条标签+过滤 | 混合检索（与多家重叠） |
| **dsh-memory-tool** | 模型可调用的 `memory_search`：会话旧内容混合召回，输出严格有界 | 与 dsh-memo 等重叠 |
| **dsh-compaction-locator** | 近无损压缩：每个 `<compacted-summary>` 追加 **Exact Sources 定位符**（spill 路径/文件/seq 区间） | 与 StrataGate 思路接近但独立实现 |
| **dsh-memory-core** | 跨会话核心记忆：workspace 事实库 + **KV-safe 稳定 section 注入** + `memory_remember` | ✅ 注入纪律唯一有源码级论证 |
| **dsh-memory-bundle** | 元 bundle：一键安装全家桶，自动禁用 base 冲突行 | — |

### 为什么值得先看：4 个"别人没有"

1. **CJK 检索修复（生态唯一）**——20+ 记忆插件几乎都建立在官方 `sessionQuery` 之上，而 unicode61 的中文缺陷意味着**整个生态的中文召回都是坏的**（`"Token消耗"`、`"索引优化"` 0 命中）；本仓库用 trigram + LIKE 回退修好地基，**所有记忆插件共同受益**。实测：unicode61 0 命中 → 本仓库全命中（含 1–2 字查询），16 单测全绿。
2. **技能自我进化**——`dsh-memory-skills`：模型可调用的 `skill_write/delete/list` 写 DSH 原生技能文件（写入即进会话技能目录），后台定时反思从完成回合蒸馏可复用技能；请求路径零开销（fire-and-forget），全部动作有日志。
3. **Token 去重**——`dsh-tool-result-dedup` 从输入侧省 Token，与记忆检索正交，生态少见。
4. **KV-safe 稳定注入**——基于源码级验证（`buildRequest` deepFreeze / KV 前缀缓存失效 / 持久化日志污染）得出的注入纪律；多数"每步自动注入"型插件会踩同一道墙（如 dsh-layered-memory）。
5. **compaction 来源定位**——近无损压缩 + 每条摘要可溯源到 spill 文件/seq 区间，记忆可审计。

### 验证与测试

- **69 单测**（7 包，node --test）：CJK 检索 16、core 12、技能管理器/进化 10、混合检索 8、tool 8、compaction 8、去重 7；
- **宿主版本要求**：DSH `>=0.1.5-rc.3 <0.3.0`（cordis `^4.0.1`），已在 0.1.5-rc.3 与 **0.2.0-rc.2** 上验证。CJK 后端是上游 `SessionQueryEngine` 的继承子类，peer 必须与宿主解析成同一份，否则宿主会拿到缺 `observeSession()` 的 `ctx.sessionQuery`（issue #1，已修）；0.2.0 起宿主还有 install/boot 前的 peer 门禁，声明范围不匹配会拒绝加载整棵树（issue #3，已修）；
- 真机验证报告（独立测试 profile，`docs/VERIFICATION.md`）：整树启动、`memory_search` 中文命中真实会话、跨会话持久化逐字注入，附录 A 为宿主契约修复的复现与验证；
- CJK 实测对照表（unicode61 vs trigram vs LIKE 回退）见 `packages/dsh-session-query-sqlite-cjk/README.md`。

### 与 Top 竞品的定位对照（一行版）

| | 定位 | 我们 vs 它 |
|---|---|---|
| **dsh-memory-plus（本仓库）** | 记忆**地基**：CJK 检索 + 去重 + KV-safe 注入 + compaction 定位 | — |
| dsh-memory-evolve（205⭐） | Hermes 式**自进化**：技能自我进化 + 五轨记忆 | 方向不同：它做上层进化，我们修下层地基；可互补 |
| dsh-mnemon（136⭐） | 三层记忆**控制平面** + WebUI | 它工程化全面，但我们有它没有的 CJK 检索 |
| dsh-noema（116⭐） | durable **可检视**记忆 + recall | 它强调检视性，我们强调检索质量与 Token 成本 |

### 已知短板（诚实版，正在补）

星标少（2⭐）、npm 发布闭环未完成、无演示素材——**根因是曝光不足而非功能缺失**（英文 README 已补，见 [`README.en.md`](../README.en.md)）。

---

## 2. 生态其余项目简表（一句话 + License）

| 项目 | Stars | License | 一句话 |
|---|---|---|---|
| [csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve) | 205 | MIT | Hermes 式自进化：**技能自我进化 + 技能管理器**、五轨记忆、回合内自我审查 |
| [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | 136 | MIT | 三层记忆控制平面：runtime context + 项目文档 + 可插拔长期记忆 + WebUI |
| [ZSeven-W/dsh-noema](https://github.com/ZSeven-W/dsh-noema) | 116 | MIT | durable 可检视长期记忆 + recall 工具 + 设置页 |
| [Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) | 27 | MIT | 七层 SQLite 跨会话记忆（有 B 站教程） |
| [FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory) | 23 | MIT | AGI 长期记忆基础设施：持续学习 + 可审计信任 |
| [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) | 21 | BSD-3-Clause | 三层**自动**记忆，proactive |
| [Qinling-Melon-Farmers/dsh-memoir](https://github.com/Qinling-Melon-Farmers/dsh-memoir) | 17 | Apache-2.0 | 会话归纳 + 经验教训 → `PROJECT_MEMORY.md` |
| [seriousz158/dsh-memory](https://github.com/seriousz158/dsh-memory) | 11 | MIT | 跨会话记忆插件 |
| [detongz/dsh-client-ui-obsidian-memory](https://github.com/detongz/dsh-client-ui-obsidian-memory) | 9 | MIT | DSH 记忆 ↔ Obsidian 双向桥 |
| [zhujunpeng12/dsh-memory-system](https://github.com/zhujunpeng12/dsh-memory-system) | 8 | MIT | 本地优先持久记忆基础设施（hot/cold 分层） |
| [Classicoke/cleverer-dsh](https://github.com/Classicoke/cleverer-dsh) | 7 | MIT | 11 插件 + 6 skills 执行纪律套件（非记忆为主） |
| [ccch713/deepddw](https://github.com/ccch713/deepddw) | 6 | MIT | DSH for Teams：记忆 + 知识库 + 局域网部署 |
| [Scorp1o117/dsh-tdai-memory](https://github.com/Scorp1o117/dsh-tdai-memory) | 6 | MIT | 记忆插件（npm: dsh-tdai-memory） |
| [nanpaidashi/dsh-honcho-sync](https://github.com/nanpaidashi/dsh-honcho-sync) | 6 | MIT | 会话自动同步到 **Honcho** 记忆服务 |
| [Culeot/dsh-agent-memory](https://github.com/Culeot/dsh-agent-memory) | 5 | MIT | 跨会话长期记忆 |
| [wangyihao0001-oss/dsh-task-memory](https://github.com/wangyihao0001-oss/dsh-task-memory) | 5 | MIT | 任务隔离记忆（限定任务边界） |
| [lesliechowsh/dsh-memo](https://github.com/lesliechowsh/dsh-memo) | 5 | MIT | sessionQuery 上的 `memo_search/remember/stats`（**同样受 unicode61 缺陷影响**） |
| [Zephyr-vibe/dsh-personalize](https://github.com/Zephyr-vibe/dsh-personalize) | 5 | MIT | per-host 个性化 + 本地长期记忆 |
| [Quophic/dsh-persona-memory](https://github.com/Quophic/dsh-persona-memory) | 4 | **NOASSERTION** | 人设记忆（⚠️ 许可不明） |
| [says693/dsh-log-memory](https://github.com/says693/dsh-log-memory) | 4 | MIT | 定时提醒保存聊天记录（娱乐向） |
| [JunNanLYS/dsh-layered-memory](https://github.com/JunNanLYS/dsh-layered-memory) | 3 | MIT | 对话自动蒸馏事实/场景/画像 + **每步注入**（踩 KV 缓存坑） |
| [chenhw7/dsh-memory](https://github.com/chenhw7/dsh-memory) | 1 | MIT | 记忆插件（npm: @chenhw7/dsh-memory） |
| [diqierjia/StrataGate-AgentMemory](https://github.com/diqierjia/StrataGate-AgentMemory) | 1 | MIT | Event/Element 卡片 + 证据门控召回 + 来源追踪 |

### npm-only（GitHub 仓库未定位，许可待自查）

`dsh-anchor`、`dsh-engram`（心理学/神经科学"条件记忆"学习插件）、`agentmemory-dsh`、`dsh-memory-pyramid`、`@kiwifruit/dsh-memory`、`@jhp830901/dsh-memoria`。

### 商业 / 托管

**TencentDB Agent Memory**（腾讯云托管，[已有 DSH 接入帖](https://www.cnblogs.com/utest2025/p/22551002)）。

---

## 3. Hermes 四层记忆思路迁移到 DSH：已有对标

| Hermes Agent 记忆层 | DSH 生态现状 |
|---|---|
| 短期上下文 | DSH 原生，无需插件 |
| 长期向量记忆（历史混合检索） | 🔴 红海（10+ 家，含本仓库 memory-index） |
| 用户记忆自动蒸馏（facts/preferences） | 🔴 dsh-layered-memory / dsh-auto-memory / FuRongJun / dsh-engram |
| **Skills 自进化 / 学习循环** | 🔴 dsh-memory-evolve（205⭐）已完整实现；**本仓库 dsh-memory-skills（新增）以"技能管理器 + 后台反思蒸馏"形态补齐同一能力** |

**结论**：Hermes 式自进化不再是别人的专利——`dsh-memory-skills` 已并入本仓库全家桶（与 evolve 定位互补：evolve 是五轨大而全的单体，本包是小而聚焦的技能管理器 + 后台进化）。**本仓库的完整差异化 = CJK 检索（生态唯一）+ Token 去重 + KV-safe 注入 + compaction 定位 + 技能自我进化**。

---

## 4. License 合规自查项

1. **本项目（已补）**：2026-08 起仓库根目录含 MIT `LICENSE`（版权 QIANLING-0831）；
2. **Quophic/dsh-persona-memory**：`NOASSERTION`——许可不明，禁止直接抄代码；
3. **npm-only 六包**（dsh-anchor / dsh-engram / agentmemory-dsh / dsh-memory-pyramid / @kiwifruit/dsh-memory / @jhp830901/dsh-memoria）：未核实，发布页自查；
4. 其余全部 MIT（个别 BSD-3-Clause / Apache-2.0）——与本项目 MIT 均兼容；**引用代码须保留原作者版权声明**；
5. 上游 `@deepseek-ai/dsh-session-query-sqlite`（MIT）fork 关系见 `packages/dsh-session-query-sqlite-cjk/README.md`。
