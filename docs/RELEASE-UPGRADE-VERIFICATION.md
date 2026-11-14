# v0.3.1 安装与升级验收

使用实际独立 `.tgz` 和官方 `dsh plugin --profile web add`，在临时 `DSH_HOME` 中验证，不修改日常会话、配置或数据库。全新安装与旧版升级分别运行。

## 全新安装

`verify-release-bundle.mjs` 用官方 CLI 安装单个 bundle，启动完整 Web profile，验证跨会话检索、带来源原文回读、工作区隔离和事实持久化；冷重启后重复核对。

## v0.3.0 → v0.3.1

`verify-release-upgrade.mjs` 的每轮完整 Web profile 都由全新的 Node 进程启动，避免同进程模块缓存掩盖包升级：

1. 安装已发布的 v0.3.0 包，配置自定义混合索引路径，写入正常历史、待删除历史、普通事实和用户固定记忆。确认旧索引确为 schema 2，保留正常 chunk ID/正文作为升级对照。
2. 停止旧进程，删除一份合成历史，保留其旧索引；用官方 CLI 在同一 profile 添加新安装包，不删库、不移除 bundle、不覆盖用户 patch。
3. 启动新版，确认加载包版本正确、schema 已升级为 3，首次查询前正常索引的 ID/正文与旧版完全相同；随后检索触发旧残留回收，删除来源的引用不可读。
4. 在实际安装包的嵌入函数处暂停索引，删除该合成来源并提交清理，再恢复任务，断言旧写入拒绝、chunks/vec/游标均未恢复。
5. 再启动一个新进程，确认正常冷历史、原文纠正、普通事实、固定记忆、自定义路径仍可用，已删来源未复活，SQLite `quick_check` 为 `ok`。

这些检查挂载发布的 DSH 0.2.0-rc.2 完整 Web profile，不通过测试桥替代安装包；不调用在线模型。并发写者与同 ID 重建的独立进程竞争由 [删除回归](DELETED-SESSION-INDEX.md) 单独覆盖。

## 复跑

```sh
npm install --prefix .dsh-verify/release-runtime --ignore-scripts --no-audit --no-fund @deepseek-ai/dsh@0.2.0-rc.2 sqlite-vec@0.1.9
node scripts/pack-release.mjs
node scripts/verify-release-bundle.mjs "$PWD/.dsh-verify/release-runtime" "$PWD/.dsh-verify/release/dsh-memory-bundle-0.3.1.tgz"
node scripts/verify-release-upgrade.mjs "$PWD/.dsh-verify/release-runtime" "$PWD/.dsh-verify/release/dsh-memory-bundle-0.3.1.tgz" https://github.com/QIANLING-0831/dsh-memory-pro/releases/download/v0.3.0/dsh-memory-bundle-0.3.0.tgz
```

发布后可把新包本地路径替换为 v0.3.1 Release 的下载 URL，验证公网安装和升级。成功时删除临时目录；失败时打印保留目录路径供排查。测试输出仅包含合成会话数据，Web 登录 URL 打印已关闭。

本地验收环境为 Linux / Node 24.21.0，`pnpm test` 152/152、包检查 8/8。发布 CI 会对实际构建资产复跑同一安装/升级脚本，全部通过后才发布。原生 Windows/macOS 桌面壳、大历史库性能及在线模型行为未在这次新增验证中覆盖。
