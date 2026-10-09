import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import OfficialEngine from '@deepseek-ai/dsh-session-query-sqlite';
import CjkEngine from './cjk-engine.mjs';

const directory = await mkdtemp(join(tmpdir(), 'dsh-mounted-cjk-'));
const root = join(directory, 'sessions');
const id = SessionId('cold-history');
const queries = ['\u{20000}', '\u{20000}\u{20001}', '\u{20000}\u{20001}\u{20002}', 'Token消耗', '中文'];
const events = [0, 1].map(seq => ({
 seq, time: 1700000000000 + seq, type: 'user/message', surfaceOp: 'append',
 data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [
  { type: 'text', text: '这是\u{20000}\u{20001}\u{20002}\u{20003}记录，索引优化减少Token消耗的句子，中文检索 needle' }
 ] }
}));
async function context() {
 const ctx = new Context();
 await ctx.plugin(SessionStore);
 await ctx.plugin(SessionProjectionRegistry);
 await ctx.plugin(Persistence, { root, compression: 'zstd' });
 return ctx;
}
try {
 const writer = await context();
 try {
  const handle = await writer.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 });
  try { await handle.append(events); await handle.flush(); } finally { await handle.close(); }
 } finally { await writer.fiber.dispose(); }
 for (const [name, Engine] of [['official', OfficialEngine], ['cjk', CjkEngine]]) {
  const path = join(directory, `${name}.db`);
  for (let pass = 0; pass < 2; pass++) {
   const ctx = await context();
   try {
    await ctx.plugin(Engine, { path, openAt: 'first-search' });
    assert.equal(ctx.sessions.list().length, 0, 'all history must remain cold');
    assert.equal((await ctx.sessionPersistence.list()).length, 1);
    if (!pass) await assert.rejects(stat(path), { code: 'ENOENT' });
    const ascii = await ctx.sessionQuery.searchSessions({ query: 'needle' });
    assert.equal(ascii.items.length, 1, 'first real search must backfill cold history');
    assert.equal(ascii.items[0].persisted, true);
    for (const query of queries) {
     const page = await ctx.sessionQuery.searchEvents({ sessionId: id, query, limit: 1 });
     assert.equal(page.items.length, name === 'cjk' ? 1 : 0, `${name}: ${query}`);
     if (name === 'cjk') {
      assert.ok(page.items[0].snippet.includes(query));
      assert.ok(page.nextCursor);
      const next = await ctx.sessionQuery.searchEvents({ sessionId: id, query, limit: 1, cursor: page.nextCursor });
      assert.equal(next.items.length, 1);
      assert.notEqual(next.items[0].seq, page.items[0].seq);
      assert.equal(next.nextCursor, undefined);
     }
    }
    console.log(`${name}, ${pass ? 'reopened' : 'first-search'}: cold history backfilled; tested ASCII + ${queries.length} CJK queries`);
   } finally { await ctx.fiber.dispose(); }
   const db = new DatabaseSync(path, { readOnly: true });
   try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM persisted_sessions').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM persisted_docs').get().n, 2);
   } finally { db.close(); }
  }
 }
} finally { await rm(directory, { recursive: true, force: true }); }
