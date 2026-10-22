// Capture real DSH pages in a disposable, already-installed web profile.
// Usage: DSH_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/capture-shortcuts-demo.mjs <runtime-dir> <DSH_HOME>
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.argv[2] && process.argv[3], 'provide runtime-dir and a disposable DSH_HOME with this checkout installed in its web profile');
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(process.argv[2]);
const home = resolve(process.argv[3]);
await stat(join(home, 'profiles/web/package.json'));
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_MODE = 'DISABLED';
const workspace = join(home, 'demo-workspace');
await mkdir(workspace, { recursive: true });
process.chdir(workspace);
const require = createRequire(join(runtime, 'package.json'));
const cli = dirname(require.resolve('@deepseek-ai/dsh/package.json'));
const hostVersion = JSON.parse(await readFile(join(cli, 'package.json'), 'utf8')).version;
const { runProfile } = await import(pathToFileURL(join(cli, 'lib/profile-boot.js')));
const { loadLayeredEnv } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const { chromium } = await import(process.env.DSH_PLAYWRIGHT_MODULE ?? 'playwright');
const output = join(root, 'docs/shortcuts-captures');
await mkdir(output, { recursive: true });
const items = [
  { id: 'search', title: '搜索会话历史', letter: 'F', command: 'memory-search', args: '索引优化' },
  { id: 'list', title: '查看常驻记忆', letter: 'M', command: 'memory-list' },
  { id: 'pin', title: '固定一条记忆', letter: 'P', command: 'memory-pin', args: 'convention 发布前必须运行测试。', verify: 'memory-list', verifyKey: 'M' },
  { id: 'skills', title: '查看可用技能', letter: 'S', command: 'skill-list' },
  { id: 'skillPin', title: '固定一个技能', letter: 'K', command: 'skill-pin', args: 'release-check', verify: 'skill-list', verifyKey: 'S' }
];
const manifest = {
  host: hostVersion, target: 'Windows 浏览器网页版',
  capture: 'Linux Chromium；navigator.platform=Win32；非 Windows 实机录屏',
  theme: 'DSH 原生深色主题', viewport: { width: 1280, height: 760 },
  syntheticData: true, scenes: []
};
let browser;
const { ctx } = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [], args: ['--port', '0', '--no-open'] });
try {
  await ctx.memoryCore.pin({ workspace, content: '回答使用中文。', topic: 'preference' });
  await ctx.memoryCore.remember({ workspace, content: '项目使用 pnpm 管理依赖。', topic: 'environment' });
  if (!ctx.memorySkills.listManaged().some(skill => skill.name === 'release-check')) ctx.memorySkills.writeSkill({ name: 'release-check', description: '发布前检查', content: '发布前运行测试。' });
  if (!ctx.memorySkills.listManaged().some(skill => skill.name === 'project-style')) ctx.memorySkills.writeSkill({ name: 'project-style', description: '项目风格约定', content: '遵循现有代码风格。' });
  ctx.memorySkills.pinSkill('release-check', false);
  ctx.memorySkills.pinSkill('project-style', true);
  for (const [index, item] of items.entries()) {
    item.sessionId = `shortcut-capture-${Date.now()}-${index}`;
    item.sessionTitle = `${index + 1}. ${item.title} · 演示 ${Date.now().toString().slice(-4)}`;
    await ctx.sessionController.create({ sessionId: item.sessionId, cwd: workspace });
    const session = ctx.sessions.get(item.sessionId);
    session.append('turn/start', { turn: 1 });
    session.append('user/message', { id: `fixture-${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '项目记录：索引优化可以减少Token消耗。' }] }, { surfaceOp: 'append' });
    session.append('session/title', { title: item.sessionTitle, messageSeqs: [], source: { kind: 'user' } });
    await ctx.sessionProjectionCache.write(session);
  }
  browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'zh-CN', colorScheme: 'dark', reducedMotion: 'reduce', viewport: manifest.viewport });
  await context.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'Win32' }));
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}/`));
  await page.getByRole('treeitem').first().waitFor();
  for (const names of [/^(Continue|继续)$/, /^(Configure later|稍后配置)$/]) {
    const button = page.getByRole('button', { name: names });
    const present = await button.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false);
    if (present) await button.click();
  }
  const group = page.getByRole('treeitem').first();
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  assert.equal(await page.locator('body[data-ds-dark-theme]').count(), 1, 'capture the actual native dark theme');
  const input = page.locator('[contenteditable="true"][role="textbox"]');
  const card = () => page.locator('div[data-variant="others"]').last();
  const press = letter => page.keyboard.press(`Control+Alt+Shift+Key${letter}`);
  for (const item of items) {
    await page.getByText(item.sessionTitle, { exact: true }).first().click();
    await input.waitFor();
    await delay(200);
    assert.equal(await input.innerText(), '');
    const scene = { ...item, binding: `Ctrl + Alt + Shift + ${item.letter}`, steps: [] };
    delete scene.sessionId;
    const capture = async (name, action, effect, focus, duration = 2400) => {
      const box = await focus.boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0);
      const file = `shortcuts-captures/${item.id}-${scene.steps.length}.png`;
      await page.screenshot({ path: join(root, 'docs', file), animations: 'disabled' });
      scene.steps.push({ name, action, effect, file, focus: box, duration });
    };
    const execute = async (command, trigger) => {
      const session = ctx.sessions.get(item.sessionId);
      const from = session.snapshotEvents().length;
      await trigger();
      const deadline = Date.now() + 10000;
      let done;
      while (!done) {
        const events = session.snapshotEvents().slice(from);
        const run = events.find(event => event.type === 'command/run' && event.data.name === command);
        done = run && events.find(event => event.type === 'command/done' && event.data.commandId === run.data.commandId);
        if (Date.now() > deadline) throw new Error(`${command}: no new result`);
        if (!done) await delay(50);
      }
      assert.equal(done.data.kind, 'success', done.data.text);
      await card().filter({ hasText: command }).waitFor();
      await delay(160);
      return done.data.text;
    };
    await capture('操作前', '暂不按键', '底部输入框为空。对话区还没有本次命令的结果。', input, 1800);
    if (item.args) {
      await press(item.letter);
      assert.equal(await input.innerText(), `/${item.command} `);
      await capture('快捷键的直接效果', `同时按 ${scene.binding}`, `底部输入框自动填入 /${item.command}，并获得焦点。此时还没有执行命令。`, input, 3000);
      await page.keyboard.insertText(item.args);
      assert.equal(await input.innerText(), `/${item.command} ${item.args}`);
      await capture('手动补全参数', `手动输入：${item.args}`, '这一步的文字由用户输入，不是快捷键自动生成。', input, 2600);
      scene.result = await execute(item.command, () => page.keyboard.press('Enter'));
      await capture('手动确认后的结果', '手动按 Enter', `对话区新增 ${item.command} 结果行。底部输入框已清空。`, card(), 3000);
    } else {
      scene.result = await execute(item.command, () => press(item.letter));
      await capture('快捷键的直接效果', `同时按 ${scene.binding}`, `对话区新增 ${item.command} 结果行，默认折叠；没有打开独立窗口。`, card(), 3000);
    }
    if (item.verify) {
      await execute(item.verify, () => press(item.verifyKey));
      await capture('再次查看，核对固定状态', `再按 Ctrl + Alt + Shift + ${item.verifyKey}`, `对话区新增 ${item.verify} 结果行。接下来点击展开，核对 pinned 标记。`, card(), 2600);
    }
    const row = card().locator('[data-disclosure-row]');
    if (await row.getAttribute('data-expandable') === 'true') {
      await row.click();
      assert.equal(await row.getAttribute('aria-expanded'), 'true');
      await capture('鼠标展开全文', '鼠标点击刚出现的结果行', item.verify ? '展开列表后，可以看到新增的 pinned 固定标记。' : '展开后显示完整命令结果。展开是这一步鼠标点击的效果。', card(), 4500);
    }
    const events = ctx.sessions.get(item.sessionId).snapshotEvents();
    assert.equal(events.filter(event => event.type === 'user/message').length, 1, 'commands must not create model messages');
    manifest.scenes.push(scene);
    await writeFile(join(root, 'docs/shortcuts-demo.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`captured ${item.id}: ${scene.steps.length} real page states`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: 5 shortcuts, exact drafts, human confirmation, real result cards, expansion and no model messages');
} finally {
  await browser?.close();
  await ctx.fiber.dispose();
}
