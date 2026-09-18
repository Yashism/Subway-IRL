/**
 * The audition harness: audio-lab.html. Not part of the game build.
 *
 * Two halves. The LIVE half runs the real director and engine off sliders, so a human can move the
 * run speed, drift their cadence or let the idle clock run out and hear what happens. The OFFLINE
 * half renders the same code through `OfflineAudioContext` and draws the waveforms, so the whole
 * thing can also be judged in a screenshot by someone who cannot hear it — a cue that renders
 * silence, clips, or is noise where it should be a tone is visible on the page.
 */
import { Director, type DirectorFrame } from './director';
import { AudioEngine } from './engine';
import { SampleBank } from './loader';
import { allSampleNames, CUE_SAMPLES } from './manifest';
import { AudioSettingsStore } from './settings';
import { CUES, MIX_CHANNELS, type AudioSettings, type CueName, type MixChannel } from './types';
import type { ActivityStatus } from '../input/commands';
import type { GameState } from '../game/game';

// ------------------------------------------------------------------ small helpers

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Deterministic randomness for the offline renders, so two screenshots can be compared. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stats {
  peak: number;
  rms: number;
  tonality: number;
}

function analyse(d: Float32Array, sampleRate: number): Stats {
  let peak = 0;
  let peakIdx = 0;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) {
      peak = a;
      peakIdx = i;
    }
    sum += d[i] * d[i];
  }
  // Normalised autocorrelation around the loudest moment: the tone/noise test the unit tests use.
  const win = Math.min(2048, d.length);
  const start = Math.max(0, Math.min(d.length - win, peakIdx - 64));
  let best = 0;
  for (let lag = Math.floor(sampleRate / 4000); lag < Math.min(win / 2, sampleRate / 120); lag++) {
    let r = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i + lag < win; i++) {
      const a = d[start + i];
      const b = d[start + i + lag];
      r += a * b;
      ea += a * a;
      eb += b * b;
    }
    const den = Math.sqrt(ea * eb);
    if (den > 1e-12) best = Math.max(best, r / den);
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, d.length)), tonality: best };
}

/** Min/max per column, plus an RMS envelope: the shape of the sound at a glance. */
function drawWave(canvas: HTMLCanvasElement, data: Float32Array, hot = false): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 80;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  g.fillStyle = '#0a0c10';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#222a35';
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  // ±1 markers, so "does it clip" is readable off the picture.
  g.strokeStyle = '#3a2430';
  for (const y of [h * 0.04, h * 0.96]) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }

  const step = data.length / w;
  const env: number[] = [];
  g.fillStyle = hot ? '#ffb545' : '#4fd0c0';
  for (let x = 0; x < w; x++) {
    const from = Math.floor(x * step);
    const to = Math.min(data.length, Math.floor((x + 1) * step));
    let lo = 0;
    let hi = 0;
    let sq = 0;
    for (let i = from; i < to; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sq += v * v;
    }
    env.push(Math.sqrt(sq / Math.max(1, to - from)));
    const y0 = h / 2 - hi * (h / 2) * 0.92;
    const y1 = h / 2 - lo * (h / 2) * 0.92;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.strokeStyle = hot ? '#fff0d0' : '#d0fff6';
  g.globalAlpha = 0.65;
  g.beginPath();
  env.forEach((e, x) => {
    const y = h / 2 - e * (h / 2) * 0.92 * 2;
    x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  });
  g.stroke();
  g.globalAlpha = 1;
}

// ------------------------------------------------------------------ offline rendering

const OFFLINE_RATE = 44100;

/**
 * The recordings, decoded once on their own context and reused by every offline render. An
 * AudioBuffer is not bound to the context that decoded it, so one fetch-and-decode pass covers the
 * whole page instead of one per card.
 */
let labBank: SampleBank | null = null;

async function loadLabBank(): Promise<void> {
  const Ctor = (globalThis as { OfflineAudioContext?: OfflineCtor }).OfflineAudioContext;
  if (!Ctor) return;
  const bank = new SampleBank(new Ctor(1, 128, OFFLINE_RATE));
  await bank.load(allSampleNames());
  labBank = bank;
  const c = bank.counts;
  $('bankState').textContent =
    `samples: ${c.loaded} loaded` + (c.failed ? `, ${c.failed} FAILED (${[...bank.failed].join(', ')})` : '');
  if (c.failed) $('bankState').style.color = '#ff6b5e';
}

/** True when this cue will play a recording rather than its synth patch. */
function isSampled(cue: CueName): boolean {
  const spec = CUE_SAMPLES[cue];
  return !!(spec && labBank && labBank.has(spec.layers[0].file));
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/**
 * Renders `seconds` of the engine. `perFrame` is stepped at 60 Hz through the render, using
 * `OfflineAudioContext.suspend`, which is the only way to drive a scheduler through an offline
 * render — the context's clock does not move until it is rendering.
 */
async function renderOffline(
  seconds: number,
  build: (engine: AudioEngine) => void,
  perFrame?: (engine: AudioEngine, t: number) => void,
  settings?: Partial<AudioSettings>,
  synthOnly = false,
): Promise<Float32Array> {
  const Ctor = (globalThis as { OfflineAudioContext?: OfflineCtor }).OfflineAudioContext;
  if (!Ctor) return new Float32Array(1);
  const ctx = new Ctor(1, Math.round(OFFLINE_RATE * seconds), OFFLINE_RATE);
  const engine = new AudioEngine(ctx, {
    reverb: true,
    settings: { master: 1, music: 1, sfx: 1, muted: false, ...settings },
    bank: synthOnly ? null : labBank,
  });
  engine.start();
  build(engine);
  if (perFrame) {
    const quantum = 128 / OFFLINE_RATE;
    const frames = Math.floor(seconds * 60);
    for (let i = 1; i < frames; i++) {
      // Suspension times have to sit on a render quantum or the context refuses them.
      const t = Math.round((i / 60 / quantum) * 1) * quantum;
      if (t >= seconds) break;
      void ctx.suspend(t).then(() => {
        perFrame(engine, t);
        engine.update();
        void ctx.resume();
      });
    }
  }
  const buf = await ctx.startRendering();
  return buf.getChannelData(0);
}

/** One offline render, drawn with its numbers under it. */
async function card(
  host: HTMLElement,
  title: string,
  note: string,
  seconds: number,
  render: () => Promise<Float32Array>,
  onPlay?: () => void,
  hot = false,
): Promise<void> {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `<div class="name"><b>${title}</b><span class="hint">${note}</span></div>
    <canvas height="86" style="height:86px;margin-top:6px"></canvas>
    <div class="stats">rendering…</div>`;
  host.append(el);
  const data = await render();
  const canvas = el.querySelector('canvas') as HTMLCanvasElement;
  drawWave(canvas, data, hot);
  const s = analyse(data, OFFLINE_RATE);
  const bad = s.peak < 0.004 ? ' · SILENT' : s.peak > 1 ? ' · CLIPS' : '';
  (el.querySelector('.stats') as HTMLElement).textContent =
    `${seconds.toFixed(1)}s · peak ${s.peak.toFixed(3)} · rms ${s.rms.toFixed(4)} · tonal ${s.tonality.toFixed(2)}${bad}`;
  if (bad) (el.querySelector('.stats') as HTMLElement).style.color = '#ff6b5e';
  if (onPlay) {
    const b = document.createElement('button');
    b.textContent = '▶';
    b.style.marginLeft = '6px';
    b.onclick = onPlay;
    (el.querySelector('.name') as HTMLElement).append(b);
  }
}

// ------------------------------------------------------------------ the live half

const store = new AudioSettingsStore(null);
let settings: AudioSettings = store.get();
let engine: AudioEngine | null = null;
let analyser: AnalyserNode | null = null;
let scopeData = new Float32Array(1024);

const director = new Director(
  {
    cue: (c, g, r) => engine?.cue(c, g, r),
    mix: (c, v) => {
      liveLevels[c] = v;
      engine?.mix(c, solo === null || solo === c || c === 'music' ? v : 0);
    },
    tempo: (b) => engine?.tempo(b),
    transport: (r) => engine?.transport(r),
  },
  { random: Math.random },
);

const liveLevels = {} as Record<MixChannel, number>;
for (const c of MIX_CHANNELS) liveLevels[c] = 0;
let solo: MixChannel | null = null;

const activity: ActivityStatus = {
  tracksJogging: true,
  msSinceStep: 300,
  cadenceSpm: 150,
  steps: 0,
  squatting: false,
  lost: false,
};

const frame: DirectorFrame = {
  dt: 1 / 60,
  state: 'playing',
  countdown: 0,
  speedFraction: 0.4,
  idleMs: 0,
  idleLevel: 'ok',
  chaserGap: 12,
  joshValue: 0,
  joshActive: false,
  airborne: false,
  hoverboard: false,
  rocket: false,
  magnet: false,
  activity,
};

const STATES: GameState[] = ['menu', 'countdown', 'playing', 'paused', 'caught', 'summary'];

function enable(): void {
  if (engine) {
    void (engine.ctx as AudioContext).resume();
    return;
  }
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  engine = new AudioEngine(ctx, { settings, reverb: true });
  engine.start();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  scopeData = new Float32Array(analyser.fftSize);
  engine.tap.connect(analyser);
  director.resync();
  // The live half gets its own bank on the live context, so what you hear is what ships.
  const live = new SampleBank(ctx);
  engine.attachBank(live);
  void live.load(allSampleNames());
  $('enable').textContent = '▶ Audio on';
  $('enable').classList.remove('primary');
}

function buildControls(): void {
  const stateRow = $('stateRow');
  for (const s of STATES) {
    const b = document.createElement('button');
    b.textContent = s;
    b.onclick = () => {
      frame.state = s;
      if (s === 'countdown') frame.countdown = 3;
      for (const el of stateRow.querySelectorAll('button')) el.classList.remove('on');
      b.classList.add('on');
    };
    if (s === frame.state) b.classList.add('on');
    stateRow.append(b);
  }

  const toggles = $('toggles');
  const flags: [string, keyof DirectorFrame][] = [
    ['josh', 'joshActive'],
    ['hoverboard', 'hoverboard'],
    ['rocket', 'rocket'],
    ['magnet', 'magnet'],
    ['airborne', 'airborne'],
  ];
  for (const [label, key] of flags) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => {
      (frame as unknown as Record<string, boolean>)[key as string] = !(
        frame as unknown as Record<string, boolean>
      )[key as string];
      b.classList.toggle('on');
    };
    toggles.append(b);
  }

  const fire = $('fireRow');
  for (const [label, fn] of [
    ['coin ×8', () => coinLine(8)],
    ['jump', () => director.fire('jump', 0.6, 1)],
    ['stumble', () => director.fire('stumble', 0.8, 1)],
    ['whistle', () => director.fire('whistle', 0.8, 1.05)],
    ['train pass', () => director.trainPass(1)],
    ['caught', () => director.fire('caught', 1, 1)],
    ['move ok', () => director.fire('moveOk', 0.7, 1)],
  ] as [string, () => void][]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    fire.append(b);
  }

  const meters = $('meters');
  for (const c of MIX_CHANNELS) {
    const row = document.createElement('div');
    row.className = 'meterRow';
    row.innerHTML = `<span>${c}</span><span class="bar${
      ['music', 'drone', 'tabla', 'bass', 'riff', 'josh'].includes(c) ? ' music' : ''
    }"><i data-ch="${c}"></i></span><span class="val" data-val="${c}">0.00</span>`;
    meters.append(row);
  }

  const soloRow = $('soloRow');
  for (const c of ['none', ...MIX_CHANNELS] as (MixChannel | 'none')[]) {
    const b = document.createElement('button');
    b.textContent = c;
    if (c === 'none') b.classList.add('on');
    b.onclick = () => {
      solo = c === 'none' ? null : c;
      for (const el of soloRow.querySelectorAll('button')) el.classList.remove('on');
      b.classList.add('on');
      director.resync();
    };
    soloRow.append(b);
  }

  const bind = (id: string, apply: (v: number) => void, fmt: (v: number) => string) => {
    const el = $<HTMLInputElement>(id);
    const out = $(`${id}Val`);
    const run = () => {
      apply(Number(el.value));
      out.textContent = fmt(Number(el.value));
    };
    el.oninput = run;
    run();
  };
  bind('speed', (v) => (frame.speedFraction = v), (v) => v.toFixed(2));
  bind(
    'idle',
    (v) => {
      frame.idleMs = v;
      frame.idleLevel = v >= 2000 ? 'caught' : v >= 1000 ? 'warn' : 'ok';
    },
    (v) => `${v | 0}ms`,
  );
  bind('gap', (v) => (frame.chaserGap = v), (v) => `${v.toFixed(1)}m`);
  bind(
    'cadence',
    (v) => {
      activity.cadenceSpm = v;
      activity.tracksJogging = v > 0;
      activity.msSinceStep = v > 0 ? 60000 / Math.max(1, v) : 5000;
    },
    (v) => `${v | 0} spm`,
  );

  const vol = (id: string, key: keyof AudioSettings) => {
    const el = $<HTMLInputElement>(id);
    el.value = String(settings[key]);
    el.oninput = () => {
      settings = store.set({ [key]: Number(el.value) } as Partial<AudioSettings>);
      engine?.applySettings(settings);
    };
  };
  vol('vMaster', 'master');
  vol('vMusic', 'music');
  vol('vSfx', 'sfx');
  $('mute').onclick = () => {
    settings = store.set({ muted: !settings.muted });
    engine?.applySettings(settings);
    $('mute').classList.toggle('on', settings.muted);
    $('mute').textContent = settings.muted ? 'muted' : 'mute';
  };
  $('enable').onclick = enable;
}

/** A coin line, one every 160 ms, so the streak ladder can be heard climbing. */
let coinsLeft = 0;
let coinTimer = 0;
function coinLine(n: number): void {
  coinsLeft = n;
  coinTimer = 0;
}

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frame.dt = dt;
  if (frame.state === 'countdown') frame.countdown = Math.max(0, frame.countdown - dt);
  if (coinsLeft > 0) {
    coinTimer -= dt;
    if (coinTimer <= 0) {
      director.update(frame, [{ type: 'coin' }]);
      coinsLeft--;
      coinTimer = 0.16;
    }
  }
  director.update(frame, []);
  engine?.update();

  for (const c of MIX_CHANNELS) {
    const bar = document.querySelector(`i[data-ch="${c}"]`) as HTMLElement | null;
    const val = document.querySelector(`[data-val="${c}"]`) as HTMLElement | null;
    if (bar) bar.style.width = `${clamp01(liveLevels[c]) * 100}%`;
    if (val) val.textContent = liveLevels[c].toFixed(2);
  }

  const p = director.pulse;
  $('pulseInfo').textContent =
    `jog pulse ${p.bpm.toFixed(1)} spm · player ${activity.cadenceSpm | 0} · ` +
    `run asks ${p.demand(frame.speedFraction).toFixed(0)} · lead +${p.lead.toFixed(1)} · ` +
    (p.locked ? 'LOCKED ON' : 'not locked');

  if (analyser) {
    analyser.getFloatTimeDomainData(scopeData);
    drawWave($<HTMLCanvasElement>('scope'), scopeData, true);
    let peak = 0;
    for (const v of scopeData) peak = Math.max(peak, Math.abs(v));
    $('outBar').style.width = `${clamp01(peak) * 100}%`;
    $('outVal').textContent = peak.toFixed(3);
  } else {
    $('outVal').textContent = 'off';
  }
  $('ctxState').textContent = engine ? `context ${(engine.ctx as AudioContext).state}` : 'no context yet';
  requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ the offline half

async function renderBeds(): Promise<void> {
  const host = $('beds');
  const cases: [string, string, Partial<DirectorFrame>][] = [
    ['start of the run', 'speed 0.00 — drone + tabla + the tick', { speedFraction: 0 }],
    ['warmed up', 'speed 0.35 — the bayan arrives', { speedFraction: 0.35 }],
    ['fast', 'speed 0.70 — the riff arrives', { speedFraction: 0.7 }],
    ['flat out', 'speed 1.00 — everything, plus wind', { speedFraction: 1 }],
    [
      'Josh meter up',
      'speed 0.70, coins doubled — the shimmer',
      { speedFraction: 0.7, joshActive: true, joshValue: 1 },
    ],
    [
      'idle warning',
      '1.7 s idle — the bed thins, the heart comes up',
      { speedFraction: 0.7, idleMs: 1700, idleLevel: 'warn' },
    ],
    ['paused', 'drone only', { speedFraction: 0.7, state: 'paused' }],
    ['the TT is on you', 'speed 0.7, gap 3 m — footsteps and whistles', { speedFraction: 0.7, chaserGap: 3 }],
  ];
  for (const [title, note, over] of cases) {
    await card(host, title, note, 4, () => renderBed(over, 4));
  }
}

/** Renders four seconds of the bed with the director driving, exactly as the game would. */
function renderBed(over: Partial<DirectorFrame>, seconds: number, only?: MixChannel): Promise<Float32Array> {
  let d: Director | null = null;
  // A fixed base, not the live frame: two renders of the same case have to look the same.
  const f: DirectorFrame = {
    dt: 1 / 60,
    state: 'playing',
    countdown: 0,
    speedFraction: 0.5,
    idleMs: 0,
    idleLevel: 'ok',
    chaserGap: 12,
    joshValue: 0,
    joshActive: false,
    airborne: false,
    hoverboard: false,
    rocket: false,
    magnet: false,
    activity: { tracksJogging: true, cadenceSpm: 160, msSinceStep: 375, steps: 0, squatting: false, lost: false },
    ...over,
  };
  return renderOffline(
    seconds,
    (e) => {
      d = new Director(
        {
          // A soloed layer shows only that layer: a whistle landing in the middle of the
          // "chaser footsteps" card would look like part of the pattern.
          cue: (c, g, r) => only === undefined && e.cue(c, g, r),
          mix: (c, v) => e.mix(c, only === undefined || c === only || c === 'music' ? v : 0),
          tempo: (b) => e.tempo(b),
          transport: (r) => e.transport(r),
        },
        { random: seeded(7) },
      );
    },
    () => d?.update(f, []),
  );
}

async function renderLayers(): Promise<void> {
  const host = $('layers');
  const solos: [MixChannel, string][] = [
    ['drone', 'tanpura: drone + the four-string pluck cycle'],
    ['tabla', 'dayan: na / tin / ke, keherwa'],
    ['bass', 'bayan: the low drum with its bend'],
    ['riff', 'the minor-pentatonic phrase'],
    ['josh', 'the double-coins shimmer'],
    ['pulse', 'the jog tick — one per footfall, accented per stride'],
    ['heartbeat', 'the idle clock'],
    ['chaserSteps', 'the TT running'],
    ['ambience', 'the station bed'],
    ['wind', 'rail rumble and speed'],
  ];
  for (const [ch, note] of solos) {
    const over: Partial<DirectorFrame> =
      ch === 'heartbeat'
        ? { speedFraction: 0.7, idleMs: 1900, idleLevel: 'warn' }
        : ch === 'chaserSteps'
          ? { speedFraction: 0.7, chaserGap: 3 }
          : ch === 'josh'
            ? { speedFraction: 1, joshActive: true, joshValue: 1 }
            : { speedFraction: 1 };
    await card(host, ch, note, 4, () => renderBed(over, 4, ch));
  }
}

async function renderCues(): Promise<void> {
  const host = $('cues');
  for (const cue of CUES) {
    // The train runs 5.5 s; a 3 s window would cut it off half way up its own swell.
    const seconds = cue === 'trainPass' ? 6 : cue === 'caught' || cue === 'introWhistle' ? 3 : 2;
    const sampled = isSampled(cue);
    await card(
      host,
      cue,
      sampled ? 'recorded' : 'synth',
      seconds,
      () => renderOffline(seconds, (e) => e.cue(cue, 1, 1)),
      () => {
        enable();
        director.fire(cue, 1, 1);
      },
      sampled,
    );
  }
}

/**
 * The same cue rendered both ways: this is the check that a file going missing degrades the sound
 * rather than removing it.
 */
async function renderFallbacks(): Promise<void> {
  const host = $('fallbacks');
  for (const cue of ['whistle', 'coin', 'land', 'caught', 'go', 'stumble'] as CueName[]) {
    const seconds = cue === 'caught' ? 3 : 2;
    await card(host, `${cue} — recorded`, 'file present', seconds,
      () => renderOffline(seconds, (e) => e.cue(cue, 1, 1)), undefined, true);
    await card(host, `${cue} — fallback`, 'file missing', seconds,
      () => renderOffline(seconds, (e) => e.cue(cue, 1, 1), undefined, undefined, true));
  }
}

// ------------------------------------------------------------------ boot

buildControls();
requestAnimationFrame(tick);
void (async () => {
  await loadLabBank();
  await renderBeds();
  await renderLayers();
  await renderCues();
  await renderFallbacks();
  document.body.dataset.ready = 'yes';
})();
