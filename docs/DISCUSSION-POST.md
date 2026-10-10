# 社区分享稿

分享地址：[DeepSeek Harness · Show Your Plugins! · #8593](https://github.com/deepseek-ai/deepseek-harness/discussions/8593)。更新已有项目帖，保留原有 CJK 技术记录。

标题：**DSH｜dsh-memory-plus｜中文检索、跨会话记忆与可复用技能插件集**

以下为介绍正文。

---

> **非官方社区项目 / Unofficial community project**：由社区独立开发维护，未经 DeepSeek 官方审核或背书。

**项目地址：[QIANLING-0831/dsh-memory-plus](https://github.com/QIANLING-0831/dsh-memory-plus)** · MIT 开源 · 当前从 Git 安装

如果你使用 DSH 时遇到“中文历史搜不到”“压缩后想找回之前的细节”“新会话又要重复说明项目规则”，欢迎试试 **dsh-memory-plus**。它是一套可以一起安装、也可以按需组合的记忆插件：7 个功能包，加 1 个安装 bundle。

### 能帮你做什么

- **搜索中文历史**：支持中文子串、中英混排、1–2 字短查询和扩展汉字。例如历史里有 `索引优化减少Token消耗的句子`，可以直接搜 `Token消耗`。
- **找回早期细节**：`memory_search` 把全文检索与向量召回合并，返回长度有界的会话片段；压缩摘要附上来源定位符，方便继续追溯。
- **保留项目规则和偏好**：workspace 范围内的核心记忆会出现在后续请求的系统提示中。`/memory-pin` 固定的规则不能被模型工具改写或删除。
- **复用技能**：`skill_write` 写入 DSH 原生 Markdown 技能，支持来源记录、`/skill-pin` 和拒绝操作的审计日志；另外提供后台技能提炼功能。
- **减少重复上下文**：重复工具结果可替换为引用。实际 Token 收益取决于你的任务，欢迎分享对照体验。

### 检索演示

![CJK search: mixed text, supplementary Han and short queries](https://raw.githubusercontent.com/QIANLING-0831/dsh-memory-plus/main/docs/demo-cjk-search.svg)

演示来自真实引擎对合成会话的查询输出；扩展汉字以 Unicode 转义显示，避免字体缺字。完整宿主和 Web 界面验证见下方报告。

### 2026-10-10 更新与实测

这次补齐了真实 `Session.snapshotEvents()` 的索引兼容，修复并发索引重复写入和重建的事务问题；新安装默认把数据库放到 `DSH_HOME`，已存在的旧库继续使用，核心记忆缓存也能感知其他连接的更新。

- **119/119 自动测试、8/8 包检查通过**，包含多进程 SQLite 并发与安装失败路径。
- **Linux + 发布的 DSH 0.2.0-rc.2 完整 Web profile 通过**：正式 CLI 安装、真实会话的中文与混合检索、跨会话事实、固定内容保护、原生技能发现、审计日志及冷重启。
- **四个数据库完整性检查通过**；另复测了真实 JSONL/zstd 冷历史与首次搜索回填。

[完整套件验证与复跑脚本](https://github.com/QIANLING-0831/dsh-memory-plus/blob/main/docs/MEMORY-HOST-VERIFICATION.md) · [CJK 宿主及 Web 界面验证](https://github.com/QIANLING-0831/dsh-memory-plus/blob/main/docs/CJK-HOST-VERIFICATION.md)

本次宿主测试没有调用在线模型；后台技能提炼和压缩摘要的模型生成没有在线端到端验证。macOS/Windows 桌面壳仍欢迎社区协助验证。

### 安装试用

需要 Node 24、已安装的 DSH CLI，以及 Corepack 或 pnpm。包声明支持 DSH `>=0.1.5-rc.3 <0.3.0`，完整套件此次实测为 `0.2.0-rc.2`。

```sh
git clone https://github.com/QIANLING-0831/dsh-memory-plus.git
cd dsh-memory-plus
bash scripts/install.sh web
# headless 用户改为：bash scripts/install.sh headless
```

Windows PowerShell 的安装方法、旧数据库路径说明和单包配置见 [中文 README](https://github.com/QIANLING-0831/dsh-memory-plus/blob/main/README.md) / [English README](https://github.com/QIANLING-0831/dsh-memory-plus/blob/main/README.en.md)。

欢迎试用，觉得有帮助也欢迎 **Star** 支持。遇到问题请在 [Issues](https://github.com/QIANLING-0831/dsh-memory-plus/issues) 附上 DSH / Node 版本、系统、profile 和最小复现；也欢迎分享你希望记忆插件解决的实际场景。

**English:** dsh-memory-plus is an unofficial MIT plugin suite for Chinese session search, bounded hybrid recall, workspace memory, traceable compaction and reusable native skills. User-pinned facts and skills are protected from model-side edits. The latest changes passed 119 automated tests, all 8 package checks, and installation/live/cold-reboot checks in the published DSH 0.2.0-rc.2 Web host on Linux. Install from Git; [English documentation](https://github.com/QIANLING-0831/dsh-memory-plus/blob/main/README.en.md) includes setup and storage compatibility details. Feedback and contributions are welcome.
