# 记忆插件套件宿主验证

验证日期：2026-10-10。环境：Linux x64、Node 24.21.0、SQLite 3.53.4、发布的 DSH `0.2.0-rc.2`，安装脚本使用 Corepack / pnpm 12.10.1。应用数据在独立 `DSH_HOME` 中，未使用日常 profile。

| 检查 | 结果 |
|---|---|
| 全仓自动测试 | 119/119，含 snapshotEvents、多连接/多进程索引、旧库保留和安装失败路径 |
| 发布前包检查 | 8/8；未发布 npm 包 |
| 真实 CLI 安装 | `scripts/install.sh web` 安装 bundle 与 7 个插件，manifest 和最终配置通过 |
| 完整 Web profile 启动 | 正式 Loader 启动成功，5 个记忆/技能工具已注册 |
| 中文全文检索 | `中文检索`、`Token消耗`、`𠀀𠀁𠀂` 在活会话与冷历史中命中 |
| 混合记忆召回 | 真实 `Session.snapshotEvents()` 产生可用检索结果，重启后仍能召回 |
| 跨会话核心记忆 | 普通事实、用户固定事实重启后可读；系统提示区块包含它们 |
| 用户保护 | 模型侧删除固定记忆和固定技能被拒绝；技能拒绝事件记入审计库 |
| 原生技能发现 | 写入的 Markdown 技能可在 Web profile 的 standard preset scope 中读取 |
| 默认存储 | 四个数据库均写入独立 `DSH_HOME`；WAL 与 `PRAGMA integrity_check` 全部通过 |
| CJK 持久化回归 | 真实 JSONL/zstd 冷历史、首次搜索回填、重开与查询契约通过 |

本次修复补齐真实 Session 的事件兼容，避免并发索引重复写入，并把会话头变化后的删除与重建放入同一事务。新安装默认使用 `DSH_HOME`；已有工作目录下的 `.dsh-verify` 数据库继续原地使用。核心记忆提示缓存会检测其他连接的写入。

## 复跑完整套件

需要 Node 24、已安装的 DSH `0.2.0-rc.2` 和 Corepack 或 pnpm。先按 [CJK 宿主验证](CJK-HOST-VERIFICATION.md#复跑)准备独立宿主依赖目录 `.dsh-verify/host-rc2`。下面从仓库根目录运行，用临时 home 安装和测试，不替换日常 DSH 数据。

```sh
verify_home=$(mktemp -d)
DSH_HOME="$verify_home" DSH_TELEMETRY_MODE=DISABLED bash scripts/install.sh web
cp scripts/verify-memory-profile.mjs .dsh-verify/host-rc2/
node .dsh-verify/host-rc2/verify-memory-profile.mjs "$verify_home"
```

`install.sh` 调用 PATH 上的真实 `dsh` CLI；该 CLI 应与独立宿主版本一致。脚本保留临时 home，便于检查配置、SQLite 和技能文件；检查结束后可删除这个临时目录。

成功输出包含 `Full memory profile live`、`Full memory profile cold reboot` 和四库完整性检查通过。Web profile 的原生技能 provider 位于 agent preset scope 中，验证脚本按这个作用域查询，并等待文件监听器刷新。每次运行生成独立会话、workspace 和技能名称，可在同一测试 home 复跑。

## 范围

验证使用真实宿主服务、插件 Loader、会话持久化与原生技能 provider，不调用付费模型或需要 API Key。后台技能进化的模型判断和压缩摘要生成由自动测试覆盖，本次没有在线模型端到端验证。macOS/Windows 桌面壳仍需对应平台测试。CJK Web 界面的既有验证记录见 [CJK 宿主验证](CJK-HOST-VERIFICATION.md)。


## Release 安装回归（2026-10-17）

针对 awesome-dsh-plugin/awesome-dsh-plugin#7186 的安装反馈，采用推荐方案 A：发布可直接由单条 `dsh plugin add` 安装的版本化 Release 包。`scripts/pack-release.mjs` 将七个实现插件的 `lib/` 与许可证装进独立 bundle，通过 `dsh-memory-bundle/<plugin>` 子路径导出；patch 使用这些导出。外部运行依赖和宿主 peer 声明被合并，宿主包继续保持 peer 身份。产物不包含 workspace / file / link 依赖，也不捆绑宿主副本。

本地 `.tgz` 安装验证环境：Linux x64、Node 24.21.0、Corepack / pnpm 12.10.1、发布的 DSH 0.2.0-rc.2。使用全新临时 `DSH_HOME`，执行一次 `dsh plugin --profile web add /absolute/path/dsh-memory-bundle-0.2.2.tgz`；不执行任何额外安装命令，也不注册七个插件包。

- 单条安装命令成功，profile 仅声明一个 `dsh-memory-bundle` 依赖。
- `scripts/verify-memory-profile.mjs` 的首次启动、冷重启均通过：中文检索、混合召回、常驻事实、固定保护、原生技能与审计。
- 四个默认数据库路径、WAL 与 SQLite 完整性检查通过。
- 打包回归检查七个实现入口逐字一致、patch 子路径、MIT 许可证、无本地依赖协议、外部运行依赖、宿主 peer 与 SHA256SUMS。

macOS / Windows 的安装与桌面壳尚未实机复跑；真实嵌入模型下载未在本次验证中覆盖。

### 公开 Release URL 复测

[v0.2.2 发布流程](https://github.com/QIANLING-0831/dsh-memory-plus/actions/runs/39018044126) 在 123 项测试和 8 个包检查全部通过后发布 `.tgz` 与 `SHA256SUMS`。随后再次使用全新的临时 `DSH_HOME`，直接运行：

```sh
dsh plugin --profile web add https://github.com/QIANLING-0831/dsh-memory-plus/releases/download/v0.2.2/dsh-memory-bundle-0.2.2.tgz
```

命令退出码为 0，profile 的 dependencies 仅有指向公开 URL 的 `dsh-memory-bundle`。没有运行额外 `pnpm install` 或逐包添加命令。对该安装再次执行 `verify-memory-profile.mjs`，首次启动、冷重启、四个默认数据库路径、WAL 和 SQLite 完整性检查全部通过。源码 checkout 不参与运行时解析。
