// Records the README demo: a whole short run (title screen, the intro cinematic, a bot-played run, getting
// caught, the summary) as a folder of numbered JPEG frames, at any frame rate, however slow your computer is.
//
//   node scripts/record-demo.mjs <url> <out-dir>
//   e.g. npm run build && npx vite preview --port 4173      (in another terminal)
//        node scripts/record-demo.mjs "http://127.0.0.1:4173/?autopilot&intro=always&quality=high" demo-frames
//        ffmpeg -framerate 120 -i demo-frames/f%06d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p demo.mp4
//
// How it gets a true 120 fps from a laptop that cannot render 120 fps: the page's clock is replaced. Before
// the game loads, `performance.now` and `requestAnimationFrame` are swapped for a virtual clock that only
// moves when this script says so, one 1/FPS step at a time; CSS animations and transitions are stepped on
// the same clock. After every step the script takes a screenshot. So each frame is rendered as slowly as it
// needs to be and the result still plays back at exactly FPS.
//
// Needs Node 22+ (global WebSocket) and a local Chrome or Chromium. No dependencies.
//
// env: SHOT_SIZE=1280x720   CSS size of the page            SHOT_SCALE=1.5   device pixel ratio (1.5 -> 1920x1080)
//      FPS=120              frames per second of the video  CHROME=/path/to/chrome
//      MENU_SECONDS=1.5     hold on the title screen        BOT_SECONDS=11   how long the bot plays before it lets go
//      TAIL_SECONDS=3       hold on the summary             MAX_SECONDS=55   safety stop
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/record-demo.mjs <url> <out-dir>');
  process.exit(2);
}

const num = (name, fallback) => (process.env[name] === undefined ? fallback : Number(process.env[name]));
const [width, height] = (process.env.SHOT_SIZE || '1280x720').split('x').map(Number);
const scale = num('SHOT_SCALE', 1.5);
const FPS = num('FPS', 120);
const MENU_SECONDS = num('MENU_SECONDS', 1.5);
const BOT_SECONDS = num('BOT_SECONDS', 11);
const TAIL_SECONDS = num('TAIL_SECONDS', 3);
const MAX_SECONDS = num('MAX_SECONDS', 55);

function findChrome() {
  const isFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = candidates.find(isFile);
  if (!found) {
    console.error('No Chrome found. Set CHROME=/path/to/chrome.');
    process.exit(2);
  }
  return found;
}

/** Runs in the page before anything else: a clock that only moves when `__advance(ms)` is called. */
const VIRTUAL_CLOCK = `(() => {
  let now = 0, nextId = 1;
  const queue = new Map();
  const births = new WeakMap();
  performance.now = () => now;
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
  window.__advance = (ms) => {
    now += ms;
    const run = [...queue]; queue.clear();
    for (const [, cb] of run) { try { cb(now); } catch (e) { console.error(e); } }
    // CSS animations and transitions run on the document timeline, which we do not control: park each one
    // and set its time from the virtual clock instead.
    for (const a of document.getAnimations()) {
      let born = births.get(a);
      if (born === undefined) { born = now; births.set(a, born); }
      if (a.playState === 'running') a.pause();
      a.currentTime = now - born;
    }
    const hud = document.getElementById('hud');
    return hud ? hud.dataset.state || '' : '';
  };
})();`;

const port = 9500 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'demo-'));
const chrome = spawn(
  findChrome(),
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    // Without these a WebGL canvas renders black in headless Chrome.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    `--window-size=${width},${height}`,
    '--hide-scrollbars',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = async (code) => {
  try {
    ws?.close();
  } catch {}
  try {
    chrome.kill('SIGKILL');
    await new Promise((r) => {
      chrome.once('exit', r);
      setTimeout(r, 3000);
    });
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(code);
};
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));

try {
  mkdirSync(out, { recursive: true });
  let target;
  for (let i = 0; i < 200 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {}
    if (!target) await sleep(50);
  }
  if (!target) throw new Error('Chrome never opened its debugging port');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: VIRTUAL_CLOCK });
  await send('Page.navigate', { url });

  let ready = false;
  for (let i = 0; i < 300 && !ready; i += 1) {
    ready = await evaluate(`!!document.querySelector('.hud-nav-play') && document.fonts.check('20px "Lilita One"')`);
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error('The game never finished loading');
  // The bot starts switched off, so the title screen is shown instead of skipped.
  await evaluate('window.subwayBot && (window.subwayBot.enabled = false)');

  const step = 1000 / FPS;
  const marks = {};
  let pressed = false;
  let botFrom = -1;
  let botOff = false;
  let summaryAt = -1;
  let lastState = '';
  let frames = 0;
  const started = Date.now();

  for (let f = 0; f < MAX_SECONDS * FPS; f += 1) {
    const state = await evaluate(`window.__advance(${step})`);
    if (state !== lastState) {
      marks[`${state || 'none'}@${(f / FPS).toFixed(2)}s`] = f;
      lastState = state;
    }
    if (!pressed && f >= MENU_SECONDS * FPS) {
      pressed = true;
      await evaluate(`document.querySelector('.hud-nav-play').click()`);
    }
    if ((state === 'countdown' || state === 'playing') && botFrom < 0) {
      botFrom = f;
      await evaluate('window.subwayBot && (window.subwayBot.enabled = true)');
    }
    if (botFrom >= 0 && !botOff && f - botFrom >= BOT_SECONDS * FPS) {
      botOff = true;
      await evaluate('window.subwayBot && (window.subwayBot.enabled = false)');
      marks.botLetsGo = f;
    }
    if (state === 'summary' && summaryAt < 0) summaryAt = f;

    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93, optimizeForSpeed: true });
    writeFileSync(join(out, `f${String(f).padStart(6, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
    frames = f + 1;
    if (f % FPS === 0) console.log(`${(f / FPS).toFixed(0).padStart(3)} s  ${state || '-'}  ${frames} frames  (${((Date.now() - started) / 1000).toFixed(0)} s elapsed)`);
    if (summaryAt >= 0 && f - summaryAt >= TAIL_SECONDS * FPS) break;
  }

  writeFileSync(join(out, 'marks.json'), JSON.stringify({ fps: FPS, frames, marks, pageErrors }, null, 2));
  console.log(`Done: ${frames} frames = ${(frames / FPS).toFixed(1)} s at ${FPS} fps in ${out}`);
  if (!existsSync(join(out, 'f000000.jpg'))) throw new Error('no frames were written');
  await finish(0);
} catch (err) {
  console.error('record-demo failed:', err.message);
  await finish(1);
}
