# 回复 #3898：把「模型永远写不到」这一层补上

> 帖子：https://github.com/deepseek-ai/deepseek-harness/discussions/3898
> 发布路径：在 #3898 底部评论区粘贴以下正文 → Post comment

## 回复正文

@weijiafu14 谢谢这条。「结构性排除」和「prompt 里禁止」的区别，我们之前确实没做到——你这一句直接改了我们这轮的方向。

先说你说对的那半句：写 `$DSH_HOME/skills`（rank 400 + watcher）我们保留不动，你的判断和我们真机实测一致，写出的文件下一步就能被原生 `skill` 工具加载。

再说不该停在的那半句。你建议「至少用 `(managed)` 标记 + 上限兜底」，我们去核了一遍，发现那个兜底当时并不成立：`(managed)` 是按「文件在这个目录里」算的，不是按来源算的；实测里 `skill_write` 能静默覆盖人手写的同名技能，`skill_delete` 能删掉目录里任何能解析的 `.md`。所以不只是「同权」，是模型能直接改用户的文件。

于是照你给的 hermes 经验补了两层固定，都做成斜杠命令、不进模型工具表：

- skills 侧：`/skill-pin <name>` / `/skill-unpin <name>`；
- memory 侧：`/memory-pin [topic] <text>` / `/memory-unpin <fact-id|text>` / `/memory-list`——顺手把你也提到的「教训 / 纠偏」做成了 memory 的一等 topic（`lesson` / `correction`）。

技能文件现在自带 provenance（`metadata: {managed, source: model|evolve|human|legacy, pinned}`），**没有 provenance 的文件一律当用户的**；模型工具与后台 evolve 只能碰 model/evolve/legacy 写过、且未被固定的文件。memory 侧同口径：`memory_remember` 没有 `pinned` 参数，撞上你固定或手写的事实只回「未改动任何记忆」，相似度合并不再把用户行纳入候选。

为什么是命令而不是工具：DSH 的命令注册表把斜杠行直接交给 handler 对 agent 执行，**从不提交给模型**，也没有任何模型工具能派发它——所以你引用的那句「structurally impossible」在 DSH 上有对应形态，而不是靠 description 里写一句「不要覆盖用户的文件」。

两个顺带修掉的小账：固定/解除只逐行改写 `metadata` 块，其它 frontmatter 键（比如宿主的 `disable-model-invocation`）和正文逐字节保留；技能上限现在只统计托管文件，用户手写的技能既不占预算、也不能被删。

真机证据（headless profile，overlay 把 skillDir 和派生库移进 `./.dsh-verify`，预置一个手写的 `user-handbook.md` 和一个 model 写过又被固定的 `pinned-rule.md`）：

```text
skill_write  e2e-model-skill   → Skill "e2e-model-skill" created at ...e2e-skills\e2e-model-skill.md.
skill_write  e2e-model-skill   → Skill "e2e-model-skill" updated at ...e2e-skills\e2e-model-skill.md.
skill_write  user-handbook     → skill_write failed: Error: skill "user-handbook" is written by the user (source: human);
                                 model write is refused — write a new skill name instead
skill_delete user-handbook     → skill_delete failed: Error: skill "user-handbook" is written by the user (source: human);
                                 model delete is refused — write a new skill name instead
skill_write  pinned-rule       → skill_write failed: Error: skill "pinned-rule" is pinned by the user (pinned: true);
                                 model write is refused — ask the user to run /skill-unpin pinned-rule
memory_remember topic=lesson   → 已记住 (98500077-16a1-44ae-be30-1940acb35728)。
```

`skill_list` 现在如实标来源（bundled/native 技能不带标签）：

```text
- e2e-model-skill (managed:model): e2e model skill v2
- pinned-rule (pinned, managed:model): A skill the user pinned, written by a model earlier
- user-handbook (human): The user's own operating rules for this machine
```

拒绝也不是静默的：派生库 `skill_events` 按顺序记着 `created` / `refused(write)` / `refused(delete)` / `refused(pinned write)` / `updated`，每行带 `source`——「模型有没有试图改写我的规则」现在可查。两个预置用户文件事后重新读取**逐字节未变**；模型自己的推理原话是「That's fine — the tools protect.」

还有一道墙是环境给的：默认技能根 `$DSH_HOME/skills` 在会话 workspace 之外，workspace-write 会话里代理的文件工具直接写它会得到 `[sandbox: file access denied under workspace-write mode]`——通用 `write`/`edit` 工具根本够不到那个目录。边界要说清楚：**这只在 skillDir 保持在 workspace 之外时成立**；谁把它配进工作区，就只剩插件守卫这一道，而且通用文件工具能绕过插件直接改文件。同一个 caveat 也适用于把派生库配成工作区相对路径的部署。

迁移是加法，而且保守：`skill_events` 只加 `source` 列；v1 → v2 补记 provenance 时**只补事件日志里出现过的名字**（标 `legacy`），从没被插件写过的文件永远不标注——宁严勿松，不会把用户的文件误标成模型产物。

一个如实交代的缺口：headless profile 没有挂载命令 adapter，`ctx.inject(["commands"], …)` 的回调不会 resolve，所以 `/skill-pin`、`/memory-pin` 本身**没法在 headless 里触发**（插件照常启动，命令 handler 由单测覆盖）。交互式 profile 才能端到端跑命令。

最后，你那句源码注释我们直接搬回来当判据：**"makes model-authored standing instructions structurally impossible rather than merely forbidden by prompt"**。分工我们也完全同意——`pi-hermes-memory` 存 memories、我们产 skills，两边互不干扰地并存；细节写在 `docs/PROVENANCE-AND-PIN.md`，欢迎继续拍。
