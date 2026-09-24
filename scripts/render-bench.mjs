#!/usr/bin/env node
/**
 * Measures what a frame costs the browser's main thread, for xterm's old
 * canvas addon and for the renderer that replaced it, on output shaped like
 * Herdr's.
 *
 * Each scenario writes a Herdr-like screen, then drives frames of output
 * fenced in ?2026 the way Herdr fences them, and times xterm's call into the
 * renderer for every frame:
 *
 *   idle    tab highlight, three agents' spinners, a clock, one typed key
 *   scroll  one pane's text moving up a line every frame, as an agent streams
 *   switch  a different screen every frame, as when switching workspaces
 *
 * It needs Playwright and its Chromium, which are not dependencies of this
 * repository:
 *
 *   npm install -g playwright && npx playwright install chromium
 *   node scripts/render-bench.mjs [--frames 120] [--only idle,scroll,switch]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(REPO, 'packages/relay/web');

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const FRAMES = Number(option('frames', 120));
const SCENARIOS = option('only', 'idle,scroll,switch').split(',');
const CONFIGS = [
  { label: 'desktop 200x55 @1x', dpr: 1, cols: 200, rows: 55, width: 1900, height: 1000 },
  { label: 'desktop 200x55 @2x', dpr: 2, cols: 200, rows: 55, width: 1900, height: 1000 },
  { label: 'phone 48x40 @3x', dpr: 3, cols: 48, rows: 40, width: 420, height: 860 },
];

async function loadPlaywright() {
  const candidates = ['playwright', path.join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright')];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // next
    }
  }
  process.stderr.write('render-bench: Playwright is not installed. Run: npm install -g playwright\n');
  process.exit(1);
}

const PAGE = `
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { HerdrRenderer } from ${JSON.stringify(path.join(WEB, 'src/render/HerdrRenderer.ts'))};

// Emulated device scales report CSS pixels as the device-pixel box; both
// renderers would then draw into a canvas of the wrong size. Without the
// field both fall back to the size they computed.
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class extends NativeResizeObserver {
  constructor(callback) {
    super((entries, observer) => callback(entries.map((entry) => ({ target: entry.target, contentRect: entry.contentRect, contentBoxSize: entry.contentBoxSize })), observer));
  }
};

const ESC = '\\x1b';
const params = new URLSearchParams(location.search);
const kind = params.get('kind');
const scenario = params.get('scenario');
const cols = Number(params.get('cols'));
const rows = Number(params.get('rows'));
const fg = (r, g, b) => ESC + '[38;2;' + r + ';' + g + ';' + b + 'm';
const bg = (r, g, b) => ESC + '[48;2;' + r + ';' + g + ';' + b + 'm';
const paneWidth = Math.floor(cols / 3);
const WORDS = 'the quick brown fox jumps over the lazy dog while agents write code and tests'.split(' ');

function paneLine(n, width) {
  let text = fg(166, 227, 161) + '⏺ ' + fg(205, 214, 244);
  let length = 2;
  for (let i = 0; length < width - 1; i++) {
    const word = WORDS[(n * 7 + i) % WORDS.length] + ' ';
    text += word;
    length += word.length;
  }
  return text.slice(0, text.length - (length - (width - 1)));
}

function screen(seed) {
  let s = ESC + '[?1049h' + ESC + '[H' + ESC + '[2J';
  s += bg(30, 30, 46) + fg(205, 214, 244) + (' 1 main  2 logs  3 agents  #' + seed).padEnd(cols) + ESC + '[0m';
  for (let r = 1; r < rows - 1; r++) {
    for (let p = 0; p < 3; p++) {
      const width = p === 2 ? cols - paneWidth * 2 : paneWidth;
      s += ESC + '[' + (r + 1) + ';' + (p * paneWidth + 1) + 'H' + fg(88, 91, 112);
      if (r === 1) s += '╭' + '─'.repeat(width - 2) + '╮';
      else if (r === rows - 2) s += '╰' + '─'.repeat(width - 2) + '╯';
      else s += '│' + paneLine(r + seed + p, width - 1) + fg(88, 91, 112) + ESC + '[' + (r + 1) + ';' + (p * paneWidth + width) + 'H│';
    }
  }
  s += ESC + '[' + rows + ';1H' + bg(49, 50, 68) + fg(186, 194, 222) + ' herdr · 3 agents · 12:00:00 '.padEnd(cols) + ESC + '[0m';
  return s;
}

const SPIN = '✻✽✶✢·';
function frame(i) {
  let s = ESC + '[?2026h';
  if (scenario === 'switch') {
    s += screen(i + 1);
  } else if (scenario === 'scroll') {
    // The middle pane's text moves up a line.
    for (let r = 2; r < rows - 2; r++) {
      s += ESC + '[' + (r + 1) + ';' + (paneWidth + 2) + 'H' + paneLine(r + i + 1, paneWidth - 1);
    }
  } else {
    s += ESC + '[1;' + (2 + (i % 3) * 7) + 'H' + bg(137, 180, 250) + fg(30, 30, 46) + (1 + (i % 3)) + ESC + '[0m';
    for (let p = 0; p < 3; p++) {
      s += ESC + '[' + (rows - 4) + ';' + (p * paneWidth + 3) + 'H' + fg(250, 179, 135) + SPIN[(i + p) % SPIN.length] + ' Working… (' + (i % 60) + 's)';
    }
    s += ESC + '[' + rows + ';' + (cols - 10) + 'H' + bg(49, 50, 68) + fg(186, 194, 222) + '12:00:' + String(i % 60).padStart(2, '0') + ESC + '[0m';
    s += ESC + '[' + (rows - 3) + ';' + (5 + (i % 40)) + 'H' + fg(205, 214, 244) + String.fromCharCode(97 + (i % 26));
  }
  return s + ESC + '[?2026l';
}

const term = new Terminal({ cols, rows, fontSize: 13, lineHeight: 1.15, fontFamily: 'monospace', allowProposedApi: true });
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';
term.open(document.getElementById('terminal'));
if (kind === 'canvas') term.loadAddon(new CanvasAddon());
else HerdrRenderer.install(term);

const renderer = term._core._renderService._renderer.value;
const renderRows = renderer.renderRows.bind(renderer);
const times = [];
renderer.renderRows = (start, end) => {
  const began = performance.now();
  renderRows(start, end);
  times.push(performance.now() - began);
};

term.write(screen(0));
window.run = async (frames) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  times.length = 0;
  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => term.write(frame(i), () => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    mean: times.reduce((a, b) => a + b, 0) / times.length,
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
};
window.ready = true;
`;

async function main() {
  const { chromium } = await loadPlaywright();
  const esbuild = require(require.resolve('esbuild', { paths: [WEB, REPO] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-render-bench-'));
  try {
    const entry = path.join(dir, 'page.js');
    fs.writeFileSync(entry, PAGE);
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      outfile: path.join(dir, 'bundle.js'),
      format: 'iife',
      target: 'es2022',
      logLevel: 'warning',
      nodePaths: [path.join(WEB, 'node_modules'), path.join(REPO, 'node_modules')],
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
    });
    fs.copyFileSync(require.resolve('@xterm/xterm/css/xterm.css', { paths: [WEB] }), path.join(dir, 'xterm.css'));
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css">' +
        '<style>body{margin:0;background:#000}#terminal{width:100vw;height:100vh}</style>' +
        '<div id="terminal"></div><script src="bundle.js"></script>',
    );

    const browser = await chromium.launch();
    const format = (ms) => `${ms.toFixed(2).padStart(6)} ms`;
    process.stdout.write(`${FRAMES} frames per run; main-thread time in the renderer per frame (mean / p95)\n\n`);
    for (const scenario of SCENARIOS) {
      process.stdout.write(`${scenario}\n`);
      for (const config of CONFIGS) {
        const results = {};
        for (const kind of ['canvas', 'herdr']) {
          const page = await browser.newPage({ viewport: { width: config.width, height: config.height }, deviceScaleFactor: config.dpr });
          const url = new URL(pathToFileURL(path.join(dir, 'index.html')));
          url.search = new URLSearchParams({ kind, scenario, cols: config.cols, rows: config.rows }).toString();
          await page.goto(url.href);
          await page.waitForFunction(() => window.ready);
          results[kind] = await page.evaluate((frames) => window.run(frames), FRAMES);
          await page.close();
        }
        process.stdout.write(
          `  ${config.label.padEnd(20)} canvas addon ${format(results.canvas.mean)} / ${format(results.canvas.p95)}` +
            `   new renderer ${format(results.herdr.mean)} / ${format(results.herdr.p95)}\n`,
        );
      }
    }
    await browser.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`render-bench: ${error.stack || error.message}\n`);
  process.exit(1);
});
