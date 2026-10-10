// Copy into an isolated environment containing @deepseek-ai/dsh 0.2.0-rc.2.
// First install the bundle into a disposable DSH_HOME with scripts/install.sh.
// Usage: node verify-memory-profile.mjs /absolute/path/to/disposable/DSH_HOME
// No model requests or API keys are needed. The home is retained for inspection.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.argv[2], 'provide the disposable DSH_HOME used for installation');
const home = resolve(process.argv[2]);
await stat(join(home, 'profiles/web/package.json'));
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_MODE = 'DISABLED';
const cwd = await mkdtemp(join(home, 'verification-workspace-'));
process.chdir(cwd);

const { runProfile } = await import('./node_modules/@deepseek-ai/dsh/lib/profile-boot.js');
const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot');
const id = `memory-profile-${randomUUID()}`;
const message = '中文检索：索引优化减少Token消耗，𠀀𠀁𠀂扩展汉字。';
const fact = '验证项目的回答使用中文。';
const rule = '发布之前必须运行测试。';
const skillName = id;
const queries = ['中文检索', 'Token消耗', '𠀀𠀁𠀂'];
const tools = ['memory_search', 'memory_remember', 'skill_write', 'skill_delete', 'skill_list'];

for (let pass = 0; pass < 2; pass++) {
  const { ctx } = await runProfile({
    environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [],
    args: ['--port', '0', '--no-open'],
  });
  try {
    assert.equal(ctx.sessionQuery.constructor.name, 'CjkSessionQueryEngine');
    for (const name of tools) assert.ok(ctx.tools.get(name), `${name} must be registered`);
    for (const [service, file] of [
      [ctx.sessionQuery, 'session-query-cjk.db'], [ctx.memorySearch, 'memory-index.db'],
      [ctx.memoryCore, 'memory-core.db'], [ctx.memorySkills, 'memory-skills.db'],
    ]) assert.equal(service.config.path, join(home, file));

    if (!pass) {
      await ctx.sessionController.create({ sessionId: id, cwd });
      const session = ctx.sessions.get(id);
      assert.equal(session.events, undefined, 'exercise the real snapshotEvents() API');
      session.append('turn/start', { turn: 1 });
      session.append('user/message', {
        id: 'memory-profile-message', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: message }],
      }, { surfaceOp: 'append' });
      await ctx.sessionProjectionCache.write(session);
      await ctx.memoryCore.remember({ workspace: cwd, content: fact, topic: 'preference' });
      const pinned = await ctx.memoryCore.pin({ workspace: cwd, content: rule, topic: 'convention' });
      await assert.rejects(ctx.memoryCore.forget(pinned.factId), /only the user/);
      ctx.memorySkills.writeSkill({
        name: skillName, description: 'Real-profile verification fixture',
        content: 'Run the project tests before publishing.',
      });
      ctx.memorySkills.pinSkill(skillName, true);
      assert.throws(() => ctx.memorySkills.deleteSkill(skillName), /pinned|user/i);
    } else {
      assert.equal(ctx.sessions.get(id), undefined, 'read persisted history after a cold reboot');
    }

    for (const query of queries) {
      const found = await ctx.sessionController.search({ query }, new AbortController().signal);
      assert.ok(found.items.some(item => item.sessionId === id), query);
    }
    const hits = await ctx.memorySearch.search({ sessionId: id, query: '中文检索', limit: 3 });
    assert.ok(hits.some(hit => hit.snippet.includes(message)), 'real session must produce memory_search hits');
    assert.ok(hits.some(hit => hit.matched.lexical && hit.matched.vector), 'both retrieval arms must contribute');
    if (!pass) {
      const result = await ctx.tools.get('memory_search').execute({ query: '中文检索' }, {
        agent: ctx.agents.get(id), signal: new AbortController().signal,
      });
      assert.ok(result.includes(message), 'registered memory_search tool returns the real session text');
    }
    assert.ok(ctx.memoryCore.renderBlock(cwd).includes(fact));
    assert.ok(ctx.memoryCore.renderBlock(cwd).includes(`[pinned] [convention] ${rule}`));
    assert.equal(ctx.memoryCore.list(cwd).length, 2);
    assert.equal(ctx.memorySkills.listManaged().find(skill => skill.name === skillName)?.pinned, true);
    // Web profiles mount filesystem discovery in the agent preset's scope.
    const scope = await ctx.agentPresets.acquireScope();
    try {
      let visible = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        visible = (await ctx.skills.list({ cwd, scope: scope.key })).some(skill => skill.name === skillName);
        if (visible) break;
        await delay(500);
      }
      assert.ok(visible, 'managed skill becomes visible to the native skill provider');
    } finally { await scope[Symbol.asyncDispose](); }
    assert.ok(ctx.memorySkills.log().some(event => event.kind === 'refused' && event.name === skillName));
    console.log(`Full memory profile ${pass ? 'cold reboot' : 'live'}: CJK search, hybrid recall, core facts, pinned protection, native skills and audit passed`);
  } finally {
    await ctx.fiber.dispose();
  }
}

for (const file of ['session-query-cjk.db', 'memory-index.db', 'memory-core.db', 'memory-skills.db']) {
  const db = new DatabaseSync(join(home, file), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal', file);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', file);
  } finally { db.close(); }
}
console.log('All four default database paths, WAL mode and SQLite integrity checks passed');
