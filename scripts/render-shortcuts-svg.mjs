// Annotated real-page screenshot sequences, one Windows Web action per SVG.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const input = process.argv[2] ?? fileURLToPath(new URL('../docs/shortcuts-demo.json', import.meta.url));
const output = process.argv[3] ?? fileURLToPath(new URL('../docs/shortcuts-effects.svg', import.meta.url));
const demo = JSON.parse(await readFile(input, 'utf8'));
assert.equal(demo.target, 'Windows 浏览器网页版');
assert.equal(demo.scenes.length, 5);
const files = ['shortcuts-effects.svg', 'shortcuts-memory-list.svg', 'shortcuts-memory-pin.svg', 'shortcuts-skill-list.svg', 'shortcuts-skill-pin.svg'];
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const text = (x, y, value, css = 'body') => `<text x="${x}" y="${y}" class="${css}">${escape(value)}</text>`;
function wrap(value, width) {
  const lines = [];
  let line = '';
  let size = 0;
  for (const token of value.match(/[A-Za-z0-9_/+.\-]+|\s+|[^\s]/gu) ?? []) {
    const advance = [...token].reduce((sum, character) => sum + (/[^\x00-\x7f]/u.test(character) ? 2 : 1), 0);
    if (size + advance > width && line) { lines.push(line.trimEnd()); line = ''; size = 0; }
    if (!line && /^\s+$/u.test(token)) continue;
    line += token;
    size += advance;
  }
  if (line) lines.push(line);
  return lines;
}

for (const [index, scene] of demo.scenes.entries()) {
  const total = scene.steps.reduce((sum, step) => sum + step.duration, 0);
  const styles = [];
  const defs = [];
  const groups = [];
  let time = 0;
  for (const [n, step] of scene.steps.entries()) {
    const png = await readFile(join(dirname(input), step.file));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const { x, y, width, height } = step.focus;
    assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= demo.viewport.width + 1 && y + height <= demo.viewport.height + 1);
    const from = time / total * 100;
    const to = (time + step.duration) / total * 100;
    const points = from === 0
      ? `0%,${(to - 0.001).toFixed(3)}%{opacity:1}${to.toFixed(3)}%,100%{opacity:0}`
      : `0%,${(from - 0.001).toFixed(3)}%{opacity:0}${from.toFixed(3)}%,${(to - 0.001).toFixed(3)}%{opacity:1}${to.toFixed(3)}%,100%{opacity:0}`;
    styles.push(`.s${n}{animation:s${n} ${total}ms linear infinite}@keyframes s${n}{${points}}`);
    defs.push(`<image id="shot${n}" width="${demo.viewport.width}" height="${demo.viewport.height}" href="data:image/png;base64,${png.toString('base64')}"/>`);
    const cx = Math.min(demo.viewport.width - 960, Math.max(0, x + width / 2 - 480));
    const cy = Math.min(demo.viewport.height - 180, Math.max(0, y + height / 2 - 90));
    const outline = `<rect x="${x - 3}" y="${Math.max(0, y - 3)}" width="${width + 6}" height="${height + 6}" rx="5" fill="none" stroke="#ffb957" stroke-width="3"/>`;
    const titleLines = wrap(step.name, 22);
    const actionLines = wrap(step.action, 26);
    const effectLines = wrap(step.effect, 26);
    assert.ok(titleLines.length <= 2 && actionLines.length <= 5 && effectLines.length <= 10);
    groups.push(`<g class="step s${n} ${n === 0 ? 'first' : ''} ${n === scene.steps.length - 1 ? 'poster' : ''}">
<svg x="24" y="178" width="944" height="560.5" viewBox="0 0 ${demo.viewport.width} ${demo.viewport.height}"><use href="#shot${n}"/>${outline}</svg>
${text(1010, 210, `第 ${n + 1} 步 / 共 ${scene.steps.length} 步`, 'muted')}
${titleLines.map((line, i) => text(1010, 246 + i * 27, line, 'stepTitle')).join('\n')}
${text(1010, 320, '你需要做什么', 'label')}
${actionLines.map((line, i) => text(1010, 350 + i * 25, line, 'action')).join('\n')}
${text(1010, 498, '屏幕上的变化', 'label')}
${effectLines.map((line, i) => text(1010, 528 + i * 21, line, 'body')).join('\n')}
<svg x="24" y="800" width="1232" height="231" viewBox="${cx} ${cy} 960 180"><use href="#shot${n}"/>${outline}</svg>
</g>`);
    time += step.duration;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1120" viewBox="0 0 1280 1120" role="img" aria-labelledby="title desc">
<title id="title">Windows 浏览器网页版：${escape(scene.title)}，${escape(scene.binding)}</title>
<desc id="desc">真实 DSH ${escape(demo.host)} 网页截图的逐帧演示。采集于 Linux Chromium 的 Windows 按键模式，不是原生 Windows 录屏。完整按键、手动操作和每一步的实际界面变化持续标明。橙框与放大区是讲解标注。</desc>
<defs>${defs.join('\n')}</defs>
<style>
text{font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif}
.title{fill:#eef4ff;font-size:28px;font-weight:700}.subtitle{fill:#a4b5d1;font-size:14px}
.keys{fill:#c9ddff;font-size:25px;font-family:ui-monospace,Consolas,monospace;font-weight:600}
.keyLabel{fill:#a5bbe0;font-size:14px}.stepTitle{fill:#f2f6ff;font-size:20px;font-weight:600}
.label{fill:#99accb;font-size:15px}.muted{fill:#97a9c9;font-size:15px}
.action{fill:#ffcb82;font-size:17px}.body{fill:#d3ddee;font-size:16px}.footer{fill:#a6b7d2;font-size:14px}
.step{opacity:0}.first{opacity:1}
${styles.join('\n')}
.progress{animation:progress ${total}ms linear infinite;transform-origin:24px 1050px;transform:scaleX(0)}
@keyframes progress{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@media(prefers-reduced-motion:reduce){.step{animation:none!important;display:none}.poster{display:inline;opacity:1}.progress{animation:none}}
</style>
<rect width="1280" height="1120" rx="14" fill="#0b1222"/>
${text(24, 42, `Windows 网页版 · ${scene.title}`, 'title')}
${text(24, 72, '适用：Windows 浏览器网页版  |  素材采集：Linux Chromium，Windows 按键模式（非 Windows 实机录屏）', 'subtitle')}
<rect x="24" y="92" width="944" height="57" rx="9" fill="#1c3052" stroke="#395b8d"/>
${text(42, 114, '该功能的完整快捷键：同时按住下面四个键', 'keyLabel')}
${text(42, 140, scene.binding, 'keys')}
${text(1010, 114, `${index + 1} / 5 个功能`, 'muted')}
${text(1010, 140, `每 ${total / 1000} 秒循环`, 'muted')}
${text(24, 166, `真实 DSH ${demo.host} 网页（深色主题）`, 'label')}
<rect x="992" y="178" width="264" height="560.5" rx="10" fill="#152037" stroke="#2a3d5a"/>
${text(24, 778, '橙框区域放大 · 同一张真实截图，橙框与说明为外加讲解标注', 'label')}
${groups.join('\n')}
<rect x="24" y="1050" width="1232" height="3" rx="1.5" fill="#273850"/>
<rect class="progress" x="24" y="1050" width="1232" height="3" rx="1.5" fill="#7db7ff"/>
${text(24, 1080, '每段只演示一个功能。橙色文字是你的操作；右侧说明是屏幕实际发生的变化。', 'footer')}
${text(24, 1105, '这是网页页面逐帧截图，不含操作系统桌面或浏览器工具栏。演示数据为合成；功能尚未发布。', 'footer')}
</svg>\n`;
  assert.doesNotMatch(svg, /<script|undefined/);
  const destination = index === 0 ? output : join(dirname(output), files[index]);
  await writeFile(destination, svg);
  console.log(`${destination}: ${scene.steps.length} real screenshots, ${total / 1000}s`);
}
