// Online black-box continuation eval. Only synthetic history is sent to the model.
// Usage: node scripts/eval-workspace-recall.mjs RUNTIME OUTPUT_DIR [REPEATS=3]
// Requires a logged-in `codex` CLI. Reads auth through the CLI, never copies credentials.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { prepareWorkspaceRuntime } from "./lib/workspace-runtime.mjs";

const serverMode = process.argv[2] === "--serve";
const runtime = resolve(process.argv[serverMode ? 3 : 2]);
const { context, SESSION_FORMAT_VERSION } = await prepareWorkspaceRuntime(runtime);
const script = fileURLToPath(import.meta.url);
const tools = ["memory_search", "memory_search_workspace", "memory_read"];

if (serverMode) {
	const home = resolve(process.argv[4]);
	const ctx = await context(home);
	const current = ctx.sessions.create(`new-${randomUUID()}`, { meta: { cwd: join(home, "workspace") } });
	const exec = { agent: { session: current }, signal: new AbortController().signal };
	const lines = createInterface({ input: process.stdin });
	try {
		for await (const line of lines) {
			const request = JSON.parse(line);
			if (request.id === undefined) continue;
			let result;
			try {
				switch (request.method) {
					case "initialize": result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "workspace-recall-eval", version: "1" } }; break;
					case "ping": result = {}; break;
					case "tools/list": result = { tools: tools.map(name => {
						const tool = ctx.tools.get(name);
						return { name, description: tool.description, inputSchema: tool.parameters, annotations: { readOnlyHint: true, destructiveHint: false } };
					}) }; break;
					case "tools/call": {
						assert.ok(tools.includes(request.params.name));
						const text = await ctx.tools.get(request.params.name).execute(request.params.arguments ?? {}, exec);
						await appendFile(join(home, "calls.jsonl"), JSON.stringify({ name: request.params.name, arguments: request.params.arguments, result: text }) + "\n");
						result = { content: [{ type: "text", text }] };
						break;
					}
					default: throw new Error(`Unsupported method ${request.method}`);
				}
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
			} catch (error) {
				process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } }) + "\n");
			}
		}
	} finally { await ctx.memorySearch.close(); await ctx.fiber.dispose(); }
} else {
	const output = resolve(process.argv[3]);
	const repeats = Number(process.argv[4] ?? 3);
	const model = process.env.RECALL_EVAL_MODEL ?? "gpt-6.1-sol";
	assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5);
	await mkdir(output, { recursive: true });
	const cases = [
		{ name: "storage", prompt: "继续上次那个离线诊断包的存储方案，按最后定下的做法列三条下一步，带上讨论来源，简短点。", topic: "离线诊断包存储方案", draft: "建议使用 Redis，集中式服务便于管理。", correction: "纠正前面的方案：最终采用 SQLite，不用 Redis。诊断包要在断网机器独立运行，不能依赖外部服务。", expected: ["SQLite", "断网|离线|外部服务"] },
		{ name: "port", prompt: "接着上次星桥本地索引服务的讨论，把最终监听端口和接入注意事项给我，附来源。", topic: "星桥本地索引服务", draft: "先把监听端口设为 7311，客户端稍后按这个接。", correction: "端口纠正：7311 被别的进程占用，最后确定改用 8647。客户端和健康检查地址都要同步更新，只监听 127.0.0.1。", expected: ["8647", "127\\.0\\.0\\.1"] },
		{ name: "retention", prompt: "上次青岚导出器的日志保留策略最后怎么定的？按那个结论继续安排实现，标一下依据。", topic: "青岚导出器日志保留策略", draft: "初稿保留 30 天，方便追踪历史导出问题。", correction: "更正并以此为准：普通日志最终只留 7 天，之前 30 天的方案作废；用户手动导出的排障包不跟随自动清理。", expected: ["7\\s*天", "排障包"] }
	];
	const results = [];
	trials: for (let repeat = 1; repeat <= repeats; repeat++) for (const fixture of cases) {
		const trial = `${fixture.name}-${repeat}`;
		const home = await mkdtemp(join(tmpdir(), "dsh-online-recall-"));
		const clientDir = join(home, "client");
		await mkdir(clientDir);
		const oldId = `discussion-${randomUUID()}`;
		const canary = `FOREIGN_ONLY_${randomUUID()}`;
		const texts = [fixture.topic + "：" + fixture.draft, "先记下草案，等环境确认。", "还有一个无关的界面布局问题，稍后单独开会话。", fixture.correction];
		const writer = await context(home);
		try {
			for (const [id, cwd, contents] of [[oldId, join(home, "workspace"), texts], [`private-${randomUUID()}`, join(home, "workspace-private"), [fixture.topic + "：最终方案是 " + canary]]]) {
				const header = { version: SESSION_FORMAT_VERSION, id, cwd, createdAt: 1794600000000, isSeeded: false, delegationDepth: 0 };
				const handle = await writer.sessionPersistence.create(header);
				try {
					await handle.append(contents.map((text, seq) => ({ seq, time: header.createdAt + seq * 1000, type: "user/message", surfaceOp: "append", data: { id: `m-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } })));
					await handle.flush();
				} finally { await handle.close(); }
			}
		} finally { await writer.memorySearch.close(); await writer.fiber.dispose(); }
		const instructions = join(clientDir, "instructions.txt");
		await writeFile(instructions, "你是一个项目助手。根据可用信息准确回答用户，不要编造缺失的历史背景。\n");
		const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "-C", clientDir, "-s", "read-only", "--json", "-m", model,
			"-c", "features.shell_tool=false", "-c", "features.view_image=false", "-c", 'web_search="disabled"',
			"-c", `model_instructions_file=${JSON.stringify(instructions)}`,
			"-c", `mcp_servers.recall.command=${JSON.stringify(process.execPath)}`,
			"-c", `mcp_servers.recall.args=${JSON.stringify([script, "--serve", runtime, home])}`,
			"-c", 'mcp_servers.recall.default_tools_approval_mode="approve"',
			"-c", "mcp_servers.recall.required=true", "-o", join(output, `${trial}.answer.txt`), fixture.prompt];
		const stdout = createWriteStream(join(output, `${trial}.events.jsonl`));
		const stderr = createWriteStream(join(output, `${trial}.stderr.log`));
		const child = spawn("codex", args, { cwd: clientDir, stdio: ["ignore", "pipe", "pipe"], detached: true });
		child.stdout.pipe(stdout); child.stderr.pipe(stderr);
		const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} }, 180000);
		const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
		clearTimeout(timer);
		const answer = await readFile(join(output, `${trial}.answer.txt`), "utf8").catch(() => "");
		const calls = (await readFile(join(home, "calls.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
		const correctionSource = `dsh-memory:${oldId}:3`;
		const checks = {
			completed: code === 0,
			searched: calls.some(call => call.name === "memory_search_workspace"),
			readOriginal: calls.some(call => call.name === "memory_read" && call.result.includes(correctionSource)),
			correctedAnswer: fixture.expected.every(pattern => new RegExp(pattern, "i").test(answer)),
			citesCorrection: answer.includes(correctionSource),
			isolated: !JSON.stringify(calls).includes(canary) && !answer.includes(canary)
		};
		const passed = Object.values(checks).every(Boolean);
		const result = { trial, passed, checks, prompt: fixture.prompt, answer, calls, fixtureHome: home, correctionSource };
		results.push(result);
		await writeFile(join(output, `${trial}.json`), JSON.stringify(result, null, 2));
		await writeFile(join(output, "summary.json"), JSON.stringify({ provider: "Codex CLI (ChatGPT auth)", model, repeats, passed: results.filter(r => r.passed).length, total: results.length, results: results.map(({ calls, ...rest }) => rest) }, null, 2));
		console.log(`${trial}: ${passed ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
		if (!passed) { process.exitCode = 1; break trials; }
	}
}
