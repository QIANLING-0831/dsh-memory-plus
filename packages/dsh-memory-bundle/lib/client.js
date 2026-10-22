// DSH's browser module protocol. No Node imports or additional UI framework.
window.__ModuleLoader__.load({
	id: "dsh-memory-bundle",
	factory: () => ({
		apply(ctx) {
			// Older and headless hosts can keep using every memory service.
			ctx.inject(["shortcuts", "sessions", "conversation", "remote", "remote.commands", "locale"], (scope) => {
				const zh = {
					search: "记忆：搜索会话历史", list: "记忆：查看常驻记忆", pin: "记忆：固定一条记忆",
					skills: "记忆：查看可用技能", skillPin: "记忆：固定一个技能",
					noSession: "请先打开一个会话。", busy: "该命令正在执行。",
					draft: "已保留当前草稿。请先处理草稿，再使用此快捷键。",
					unavailable: "记忆命令不可用，请检查 Memory Plus 插件是否已加载。"
				};
				const en = {
					search: "Memory: search session history", list: "Memory: list persistent memories", pin: "Memory: pin a memory",
					skills: "Memory: list available skills", skillPin: "Memory: pin a skill",
					noSession: "Open a conversation first.", busy: "This command is already running.",
					draft: "Your draft is preserved. Finish it before using this shortcut.",
					unavailable: "Memory command unavailable. Check that Memory Plus is loaded."
				};
				scope.effect(() => scope.locale.register("memoryPlus", { zh, en }));
				const t = scope.locale.bind("memoryPlus");
				const pending = new Set();
				let active = true;
				scope.effect(() => () => { active = false; });
				const actions = [
					["search", "KeyF", "memory-search", true],
					["list", "KeyM", "memory-list", false],
					["pin", "KeyP", "memory-pin", true],
					["skills", "KeyS", "skill-list", false],
					["skillPin", "KeyK", "skill-pin", true]
				];
				for (const [id, code, command, prepare] of actions) {
					const binding = { code, modifiers: ["primary", "alt", "shift"] };
					scope.effect(() => scope.shortcuts.register({
						id: `memoryPlus.${id}`, label: () => t(id), aliases: [command, "memory plus"],
						defaults: {
							"desktop:windows": binding, "desktop:macos": binding, "desktop:linux": binding,
							"web:windows": binding, "web:macos": binding
						},
						regions: ["page", "editable"], modals: [],
						resolve(context) {
							// Desktop can prioritize application bindings over terminal/modal owners.
							if (context.modal !== null || context.region === "terminal") return { status: "pass" };
							const current = Object.values(scope.sessions.list.getSnapshot().byId)
								.find(row => (row.retainedBy.mainView ?? 0) > 0);
							const actx = current && scope.sessions.scope(current.id);
							if (!actx) return { status: "blocked", reason: t("noSession") };
							const input = scope.conversation.input.for(actx);
							const key = `${current.id}:${command}`;
							if (pending.has(key)) return { status: "blocked", reason: t("busy") };
							return { status: "handled", run() {
								if (prepare) {
									const state = input.state.getSnapshot();
									if (state.draft || state.attachmentIds.length || state.phase !== "plain") {
										input.notify("info", t("draft"));
									} else {
										input.setDraft(`/${command} `);
									}
									input.focus();
									return;
								}
								pending.add(key);
								void scope.sessions.using(current.id, { source: "memoryShortcut" }, async (reference) => {
									if (reference.binding.session.getSnapshot().openState !== "open") throw new Error(t("noSession"));
									const result = await scope.remote.commands.execute(current.id, `/${command}`, []);
									if (!result?.ok || !result.value) throw new Error(t("unavailable"));
									if (result.value.result.kind === "error") throw new Error(result.value.result.text);
								}).catch(error => {
									if (active && scope.sessions.scope(current.id) === actx) input.notify("error", String(error.message ?? error));
								}).finally(() => { pending.delete(key); });
							} };
						}
					}));
				}
			});
		}
	})
});
