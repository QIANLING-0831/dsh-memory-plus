import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as host from "../lib/index.js";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function setup() {
	let plugin;
	runInNewContext(source, { window: { __ModuleLoader__: { load(row) {
		assert.equal(row.id, "dsh-memory-bundle");
		plugin = row.factory();
	} } } });
	const commands = new Map();
	const notices = [];
	const executions = [];
	const disposers = [];
	const state = { draft: "", attachmentIds: [], phase: "plain" };
	let focused = 0;
	const input = {
		state: { getSnapshot: () => state },
		setDraft(text) { state.draft = text; },
		focus() { focused++; }, notify(level, text) { notices.push({ level, text }); }
	};
	const actx = {};
	const rows = { current: { id: "current", retainedBy: { mainView: 1 } } };
	const scope = {
		effect(fn) { disposers.push(fn()); },
		locale: { register: () => () => {}, bind: () => key => key },
		shortcuts: { register(command) { commands.set(command.id, command); return () => commands.delete(command.id); } },
		sessions: {
			list: { getSnapshot: () => ({ byId: rows }) },
			scope: id => id === "current" ? actx : undefined,
			using: async (id, _owner, callback) => callback({ binding: {
				session: { getSnapshot: () => ({ openState: "open" }) }
			} })
		},
		conversation: { input: { for: ctx => { assert.equal(ctx, actx); return input; } } },
		remote: { commands: { async execute(id, line, attachments) {
			assert.equal(attachments.length, 0);
			executions.push({ id, line });
			return { ok: true, value: { result: { kind: "success", text: "result" } } };
		} } }
	};
	plugin.apply({ inject(_deps, callback) { callback(scope); } });
	const context = { modal: null, region: "editable" };
	const resolve = id => commands.get(`memoryPlus.${id}`).resolve(context);
	return { commands, notices, executions, disposers, state, rows, scope, context, resolve, focused: () => focused };
}

test("bundle has a headless-safe host entry and optional client services", () => {
	assert.doesNotThrow(() => host.apply({}));
	let plugin;
	runInNewContext(source, { window: { __ModuleLoader__: { load: row => { plugin = row.factory(); } } } });
	let waited;
	plugin.apply({ inject(deps) { waited = [...deps]; } });
	assert.ok(waited.includes("shortcuts"));
	assert.ok(waited.includes("remote"), "Cordis requires the parent remote service as well as remote.commands");
});

test("five configurable commands prepare input without sending or pinning", () => {
	const f = setup();
	assert.equal(f.commands.size, 5);
	for (const command of f.commands.values()) {
		assert.equal(command.defaults["web:linux"], undefined, "honor host Linux browser restrictions");
		assert.equal(command.modals.length, 0);
	}
	for (const [id, line] of [["search", "/memory-search "], ["pin", "/memory-pin "], ["skillPin", "/skill-pin "]]) {
		f.state.draft = "";
		f.resolve(id).run();
		assert.equal(f.state.draft, line);
	}
	assert.equal(f.focused(), 3);
	assert.equal(f.executions.length, 0);
	f.disposers.reverse().forEach(dispose => dispose());
	assert.equal(f.commands.size, 0, "unloading removes shortcuts");
});

test("existing text, attachments, and command claims survive shortcut use", () => {
	for (const state of [{ draft: "important draft" }, { attachmentIds: ["image"] }, { phase: "claimed" }, { phase: "submitting" }]) {
		const f = setup();
		Object.assign(f.state, state);
		const before = structuredClone(f.state);
		f.resolve("pin").run();
		assert.deepEqual(f.state, before);
		assert.equal(f.notices[0].text, "draft");
		assert.equal(f.executions.length, 0);
	}
});

test("read-only shortcuts target the captured session and preserve its draft", async () => {
	const f = setup();
	f.state.draft = "keep me";
	const action = f.resolve("list");
	f.rows.other = { id: "other", retainedBy: { mainView: 1 } };
	f.rows.current.retainedBy.mainView = 0;
	action.run();
	assert.equal(f.resolve("list").status, "blocked", "new current session without a scope is blocked");
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.executions, [{ id: "current", line: "/memory-list" }]);
	assert.equal(f.state.draft, "keep me");
	f.rows.current.retainedBy.mainView = 1;
	delete f.rows.other;
	f.resolve("skills").run();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(f.executions[1], { id: "current", line: "/skill-list" });
});

test("modal, terminal and missing conversation never invoke memory operations", () => {
	const f = setup();
	f.context.modal = "settings";
	assert.equal(f.resolve("pin").status, "pass");
	f.context.modal = null;
	f.context.region = "terminal";
	assert.equal(f.resolve("pin").status, "pass");
	f.context.region = "page";
	delete f.rows.current;
	assert.equal(f.resolve("pin").status, "blocked");
	assert.equal(f.executions.length, 0);
});

test("held keys do not repeat requests; missing commands and RPC errors show notices", async () => {
	for (const response of [undefined, { ok: false }, { ok: true }, { ok: true, value: { result: { kind: "error", text: "handler failed" } } }]) {
		const f = setup();
		let settle;
		f.scope.remote.commands.execute = () => new Promise(resolve => { settle = resolve; });
		f.resolve("list").run();
		assert.equal(f.resolve("list").status, "blocked");
		settle(response);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(f.notices[0].level, "error");
		assert.equal(f.resolve("list").status, "handled", "retry is possible");
	}
});
