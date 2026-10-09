// Copy this script into an isolated environment containing DSH 0.2.0-rc.2.
// Usage: node verify-cjk-profile.mjs /absolute/path/to/dsh-session-query-sqlite-cjk
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

assert.ok(process.argv[2], 'provide the local plugin package path');
const home = await mkdtemp(join(tmpdir(), 'dsh-cjk-profile-'));
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_MODE = 'DISABLED';
const path = join(home, 'search.db');
const cwd = join(home, 'workspace');
const id = 'cjk-profile-history';
const text = '这是𠀀𠀁𠀂𠀃记录，索引优化减少Token消耗的句子，中文检索 needle';
const queries = ['𠀀', '𠀀𠀁', '𠀀𠀁𠀂', 'Token消耗', '中文', 'needle'];
try {
 await mkdir(cwd);
 const { prepareProfile, runProfile } = await import('./node_modules/@deepseek-ai/dsh/lib/profile-boot.js');
 const { loadLayeredEnv } = await import('@deepseek-ai/dsh-app-boot');
 prepareProfile('web');
 await promisify(execFile)(process.execPath, [
  './node_modules/@deepseek-ai/dsh/lib/bin.js', 'plugin', '--profile', 'web', 'add', resolve(process.argv[2]),
 ], { cwd: import.meta.dirname, env: process.env });
 await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify([
  { id: 'session-query-sqlite', disabled: true },
  { insert: [{ id: 'session-query-sqlite-cjk', name: 'dsh-session-query-sqlite-cjk', config: { path, openAt: 'first-search' } }] },
 ]));
 for (let pass = 0; pass < 2; pass++) {
  const { ctx } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [], args: ['--port', '0', '--no-open'] });
  try {
   assert.equal(ctx.sessionQuery.constructor.name, 'CjkSessionQueryEngine');
   if (!pass) {
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await ctx.sessionController.create({ sessionId: id, cwd });
    const session = ctx.sessions.get(id);
    session.append('turn/start', { turn: 1 });
    for (let n = 0; n < 2; n++) session.append('user/message', {
     id: `message-${n}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    }, { surfaceOp: 'append' });
    session.append('session/title', { title: 'CJK profile history', messageSeqs: [], source: { kind: 'user' } });
    await ctx.sessionProjectionCache.write(session);
   } else {
    assert.equal(ctx.sessions.get(id), undefined, 'history must be cold after reboot');
    const list = await ctx.sessionController.list();
    assert.equal(list.items.find(item => item.sessionId === id)?.blank, false);
   }
   for (const query of queries) {
    const result = await ctx.sessionController.search({ query }, new AbortController().signal);
    assert.deepEqual(result.items.map(item => item.sessionId), [id], `${pass}: ${query}`);
    assert.ok(result.items[0].snippet.includes(query));
   }
   for (const query of ['𠀐', '𠀀%', '𠀀_', '𠀀\\']) {
    assert.deepEqual((await ctx.sessionController.search({ query }, new AbortController().signal)).items, [], query);
   }
   const page = await ctx.sessionQuery.searchEvents({ sessionId: id, query: '𠀀𠀁𠀂', limit: 1 });
   assert.equal(page.items.length, 1);
   assert.ok(page.nextCursor);
   const next = await ctx.sessionQuery.searchEvents({ sessionId: id, query: '𠀀𠀁𠀂', limit: 1, cursor: page.nextCursor });
   assert.equal(next.items.length, 1);
   assert.notEqual(next.items[0].seq, page.items[0].seq);
   assert.equal(next.nextCursor, undefined);
   console.log(`Full profile ${pass ? 'cold reboot' : 'live'}: six queries, four negatives, pagination passed`);
  } finally { await ctx.fiber.dispose(); }
 }
 const db = new DatabaseSync(path, { readOnly: true });
 try {
  assert.equal(db.prepare('SELECT count(*) AS n FROM persisted_sessions').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM persisted_docs').get().n, 2);
 } finally { db.close(); }
} finally { await rm(home, { recursive: true, force: true }); }
