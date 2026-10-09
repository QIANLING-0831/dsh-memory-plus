# CJK 宿主验证

对应讨论：[扩展汉字路由](https://github.com/deepseek-ai/deepseek-harness/discussions/8593#discussioncomment-18753839)、[首次回填与 unicode61](https://github.com/deepseek-ai/deepseek-harness/discussions/1999#discussioncomment-18774000)。

环境：Linux x64，Node 24.21.0 / SQLite 3.53.4，发布的 DSH `0.2.0-rc.2`；同时核对源码标签 `dsh-v0.2.0-rc.2`（`639ed015397290b3745d163aafe02ffee4aa3f84`）。

| 检查 | 结果 |
|---|---|
| 全仓单测 / 发布检查 | 97/97；8/8 包 |
| CJK 单测，0.1.5-rc.3 / 0.2.0-rc.2 | 两组均 27/27 |
| 官方 SQLite + 真实 JSONL/zstd 冷历史 | 首次 ASCII 查询回填 1 个会话、2 条正文；关闭后重开仍可检索 |
| 官方 unicode61 对照 | `needle` 命中；扩展汉字 1/2/3 码点、`Token消耗`、`中文` 均无命中 |
| CJK + 真实 JSONL/zstd | 同一组查询命中，分页和重开通过 |
| 完整 Web profile | 正式插件安装、Loader/peer 门禁、SessionController 创建会话、宿主持久化、投影缓存、活会话和冷重启通过 |
| 完整 profile 查询 | 六种正例、四种负例、snippet、事件分页均通过；冷重启后磁盘 1 个会话、2 条正文 |
| 实际 Web 界面 | 上述六种正例与四种负例通过；点击结果可恢复正文 |

全仓复查还暴露了技能日志的同毫秒排序问题：`created_at` 相同时，旧事件可能排在前面。已增加 `rowid DESC` 次序，并让现有回归测试固定同一时间戳验证最新事件和 `limit: 1`，测试总数仍为 97。

实际界面同时验证了官方后端的 `needle` 正文命中和 `Token消耗` 无命中。第一次真实搜索后，官方磁盘库有 3 个历史会话、3 条正文。因此未复现“`first-search` 下冷历史必定不回填”。这个结果不能替代原报告者的桌面配置、日志和历史文件诊断。

`openAt` 控制打开时机；索引在实际搜索时同步。活会话优先进入连接内 TEMP 表，不能只用磁盘表计数判断搜索是否工作。该版本侧边栏的非空查询会调用正文搜索，默认 `openAt: never` 才禁用该后端。

## 复跑

需要 Node 24 和 pnpm（正式插件安装命令调用 pnpm）。在仓库根目录执行；依赖与应用数据隔离在 `.dsh-verify/host-rc2` 和脚本创建的临时目录，脚本结束后清理临时应用数据。

```sh
mkdir -p .dsh-verify/host-rc2
printf '{"private":true,"type":"module"}\n' > .dsh-verify/host-rc2/package.json
npm install --prefix .dsh-verify/host-rc2 --ignore-scripts --no-audit --no-fund \
  @deepseek-ai/dsh@0.2.0-rc.2 @deepseek-ai/cordis@4.0.4 \
  @deepseek-ai/dsh-session@0.2.0-rc.2 \
  @deepseek-ai/dsh-session-projection@0.2.0-rc.2 \
  @deepseek-ai/dsh-session-query@0.2.0-rc.2 \
  @deepseek-ai/dsh-session-persistence@0.2.0-rc.2 \
  @deepseek-ai/dsh-session-persistence-jsonl@0.2.0-rc.2 \
  @deepseek-ai/dsh-session-query-sqlite@0.2.0-rc.2 \
  @deepseek-ai/schemastery@3.18.2
cp packages/dsh-session-query-sqlite-cjk/lib/index.js .dsh-verify/host-rc2/cjk-engine.mjs
cp scripts/verify-cjk-host.mjs scripts/verify-cjk-profile.mjs .dsh-verify/host-rc2/
node .dsh-verify/host-rc2/verify-cjk-host.mjs
node .dsh-verify/host-rc2/verify-cjk-profile.mjs "$PWD/packages/dsh-session-query-sqlite-cjk"
```

`verify-cjk-host.mjs` 比较官方与 CJK 引擎，使用真正的 JSONL/zstd 持久化而非 stub。`verify-cjk-profile.mjs` 使用发布 CLI 的正式 profile 启动入口，通过 `dsh plugin --profile web add` 安装本地包，再走正式 Loader 与搜索 API。测试会话包含 `turn/start`，并调用宿主投影缓存的 durability barrier，保证冷历史可见且缓存对应已落盘的日志；不会调用模型或需要 API Key。

界面复核应在隔离 profile 中进行：依次搜索 `𠀀`、`𠀀𠀁`、`𠀀𠀁𠀂`、`Token消耗`、`中文`、`needle`，检查正文 snippet；负例 `𠀐`、`𠀀%`、`𠀀_`、`𠀀\` 必须为空。每次等待查询完成，不能用上一查询残留的结果判定通过。

## 范围

本次修复社区 CJK 包的扩展汉字路由，不改变官方 unicode61 后端或索引 schema。测试覆盖完整 Web 宿主与桌面共用的插件和前端路径，未运行 macOS/Windows Electron 桌面壳。该标签的桌面构建目标不支持 Linux；本机源码构建另外因缺少 `cc` 而失败。桌面平台特有问题仍需在对应系统复现。
