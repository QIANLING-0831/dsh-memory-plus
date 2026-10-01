/**
 * Render the real output of `scripts/demo-cjk-search.mjs` as a self-contained
 * animated terminal SVG.
 *
 * GitHub does not render inline `<script>` in SVG, but it does render CSS
 * animations, so the recording is built from frames plus CSS keyframes. There
 * is no JavaScript in the output and every character in it came from the demo's
 * actual stdout.
 *
 * Usage:
 *   node scripts/demo-cjk-search.mjs --frames .dsh-verify/frames
 *   node scripts/render-demo-svg.mjs .dsh-verify/frames docs/demo-cjk-search.svg
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [, , framesDir, outPath] = process.argv;
if (framesDir === undefined || outPath === undefined) throw new Error("usage: node render-demo-svg.mjs <framesDir> <out.svg>");

const FRAME_MS = 260;
const HOLD_MS = 3200;
const COLS = 100;
const WRAP_INDENT = "      ";
const LINE_HEIGHT = 17;
const PAD_TOP = 44;
const PAD_LEFT = 16;
const CHAR_WIDTH = 8.4;
const FONT_SIZE = 13;

const files = (await readdir(framesDir)).filter((name) => name.endsWith(".txt")).sort();
if (files.length === 0) throw new Error(`no frames in ${framesDir}`);

const escapeXml = (text) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Display width, so CJK text stays inside the window. */
function displayWidth(text) {
	let width = 0;
	for (const character of String(text)) {
		const code = character.codePointAt(0);
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

const frames = [];
for (const file of files) {
	const content = await readFile(join(framesDir, file), "utf8");
	frames.push(content.replace(/\n$/, "").split("\n"));
}

/** Wrap a frame so no rendered line exceeds the window; returns display lines. */
function wrapFrame(frame) {
	const out = [];
	for (const line of frame) {
		let rest = line;
		let first = true;
		while (displayWidth(rest) > COLS) {
			// Prefer breaking at the last space that fits, so CJK words are not
			// split mid-word when the line has a natural break point.
			let cut = 0;
			let width = 0;
			let lastSpaceCut = 0;
			for (const character of rest) {
				const characterWidth = displayWidth(character);
				if (width + characterWidth > COLS) break;
				width += characterWidth;
				cut += character.length;
				if (character === " " && cut > 1) lastSpaceCut = cut;
			}
			const breakAt = lastSpaceCut > 0 ? lastSpaceCut : cut;
			out.push(first ? rest.slice(0, breakAt).trimEnd() : WRAP_INDENT + rest.slice(0, breakAt).trim());
			rest = rest.slice(breakAt).replace(/^\s+/, "");
			first = false;
		}
		out.push(first ? rest : WRAP_INDENT + rest);
	}
	return out;
}

const wrapped = frames.map(wrapFrame);
const totalLines = Math.max(...wrapped.map((frame) => frame.length));

const totalMs = frames.length * FRAME_MS + HOLD_MS;
const height = PAD_TOP + totalLines * LINE_HEIGHT + 22;

// One animated <text> per newly revealed display line, in frame order.
const styles = [];
const nodes = [];
let order = 0;
let previous = [];
for (let index = 0; index < wrapped.length; index += 1) {
	const frame = wrapped[index];
	// Reveal the lines this frame added; a frame never rewrites earlier lines.
	const from = previous.length === frame.length - 1 || frame.length > previous.length ? previous.length : frame.length - 1;
	for (let line = from; line < frame.length; line += 1) {
		const text = frame[line];
		const width = displayWidth(text);
		if (width > COLS) throw new Error(`wrapped line still exceeds ${COLS} columns: ${text}`);
		const startPct = ((order * FRAME_MS) / totalMs) * 100;
		const className = `l${order}`;
		styles.push(
			`.${className}{animation:${className} ${totalMs}ms steps(1,end) infinite}`,
			`@keyframes ${className}{0%,${startPct.toFixed(3)}%{opacity:0}${(startPct + 0.001).toFixed(3)}%,100%{opacity:1}}`,
		);
		const fill = text.startsWith("query ") ? "#7dd3fc" : text.trimStart().startsWith("seq ") ? "#a3e635" : "#e2e8f0";
		nodes.push(
			`<text class="${className}" x="${PAD_LEFT}" y="${PAD_TOP + line * LINE_HEIGHT}" fill="${fill}" xml:space="preserve">${escapeXml(text) || " "}</text>`,
		);
		order += 1;
	}
	previous = frame;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(PAD_LEFT * 2 + COLS * CHAR_WIDTH)}" height="${height}" viewBox="0 0 ${Math.round(PAD_LEFT * 2 + COLS * CHAR_WIDTH)} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT_SIZE}">
<title>dsh-memory-plus CJK session search — real engine output</title>
<desc>Terminal recording of scripts/demo-cjk-search.mjs. Every line is actual stdout from the real CjkSessionQueryEngine over an in-memory index.</desc>
<style>
.term{fill:#0b1020}
.chrome{fill:#1b2440}
.dot{fill:#ff5f57}
.dot2{fill:#febc2e}
.dot3{fill:#28c840}
text{white-space:pre}
${styles.join("\n")}
</style>
<rect class="term" width="100%" height="100%" rx="8"/>
<rect class="chrome" width="100%" height="28" rx="8"/>
<circle class="dot" cx="16" cy="14" r="5"/>
<circle class="dot2" cx="34" cy="14" r="5"/>
<circle class="dot3" cx="52" cy="14" r="5"/>
<text x="72" y="19" fill="#94a3b8" font-size="11">node scripts/demo-cjk-search.mjs — dsh-memory-plus</text>
${nodes.join("\n")}
</svg>
`;

await writeFile(outPath, svg, "utf8");
console.log(`wrote ${outPath}: ${frames.length} frames, ${nodes.length} animated lines, ${(svg.length / 1024).toFixed(1)} KB`);
