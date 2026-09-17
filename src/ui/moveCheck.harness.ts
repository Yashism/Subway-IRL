/**
 * Visual harness for the Move Check screens (not part of the build; no camera, no logic).
 * moveCheck-harness.html?state=<name>
 */
import './hud.css';
import { MOVE_ORDER, type MoveCheckModel, type MoveCheckSummary, type MoveId, type MoveStepModel } from '../pose/moveCheckTypes';
import type { PlayMode } from '../pose/types';
import { MoveCheckScreen } from './moveCheckScreen';

const STATES = [
  'jog', 'jog-near', 'left', 'right', 'jump', 'roll', 'hover',
  'near-miss', 'skippable', 'summary', 'summary-skipped',
  'small-jog', 'small-left', 'small-jump', 'small-roll', 'small-summary',
] as const;
type State = (typeof STATES)[number];

const params = new URLSearchParams(location.search);
const state = (STATES as readonly string[]).includes(params.get('state') ?? '') ? (params.get('state') as State) : 'jog';
if (params.has('shot')) document.body.classList.add('shot');

const nav = document.getElementById('nav')!;
for (const s of STATES) {
  const a = document.createElement('a');
  a.href = `?state=${s}`;
  a.textContent = s;
  nav.append(a);
}

// ---------------------------------------------------------------- fixture models

const LABELS: Record<MoveId, string> = {
  jog: 'Jog in place',
  left: 'Step left',
  right: 'Step right',
  jump: 'Jump',
  roll: 'Squat',
  hover: 'Both hands up',
};

const HOW: Record<PlayMode, Record<MoveId, string>> = {
  full: {
    jog: 'Jog in place — lift your knees',
    left: 'Step to your LEFT',
    right: 'Step to your RIGHT',
    jump: 'Jump up!',
    roll: 'Squat down / duck',
    hover: 'Both hands up!',
  },
  small: {
    jog: 'Jog in place, or pump your arms',
    left: 'Lean your shoulders LEFT',
    right: 'Lean your shoulders RIGHT',
    jump: 'Jump, or hop on your toes',
    roll: 'Duck your head down',
    hover: 'Both hands up!',
  },
};

const PEAKS: Record<MoveId, number> = { jog: 0.21, left: 0.63, right: 0.58, jump: 0.24, roll: 0.41, hover: 1 };

function step(mode: PlayMode, id: MoveId, over: Partial<MoveStepModel> = {}): MoveStepModel {
  return {
    id,
    status: 'todo',
    label: LABELS[id],
    how: HOW[mode][id],
    hint: null,
    canSkip: false,
    canAccept: false,
    progress: 0,
    peak: null,
    steps: id === 'jog' ? { seen: 0, needed: 4 } : null,
    ...over,
  };
}

/** A model with `at` active and everything before it done. */
function model(mode: PlayMode, at: MoveId, over: Partial<MoveStepModel> = {}): MoveCheckModel {
  const index = MOVE_ORDER.indexOf(at);
  const steps = MOVE_ORDER.map((id, i) =>
    i < index
      ? step(mode, id, { status: 'done', progress: 1, peak: PEAKS[id], steps: id === 'jog' ? { seen: 4, needed: 4 } : null })
      : i === index
        ? step(mode, id, { status: 'active', ...over })
        : step(mode, id),
  );
  return { mode, index, steps, summary: null };
}

function summary(mode: PlayMode, skipped: readonly MoveId[], asymmetry: string | null): MoveCheckModel {
  const steps = MOVE_ORDER.map((id) =>
    skipped.includes(id)
      ? step(mode, id, { status: 'skipped', progress: 0.62 })
      : step(mode, id, { status: 'done', progress: 1, peak: PEAKS[id], steps: id === 'jog' ? { seen: 4, needed: 4 } : null }),
  );
  const s: MoveCheckSummary = {
    mode,
    steps,
    tuned: mode === 'full' ? { kneeLift: 0.115, laneEnter: 0.33, jumpRise: 0.132, rollDrop: 0.225 } : { wristPump: 0.12, leanDeg: 11 },
    asymmetryNote: asymmetry,
  };
  return { mode, index: steps.length, steps, summary: s };
}

const MODELS: Record<State, MoveCheckModel> = {
  jog: model('full', 'jog', { steps: { seen: 2, needed: 4 }, progress: 0.5 }),
  'jog-near': model('full', 'jog', { steps: { seen: 1, needed: 4 }, progress: 0.62, hint: 'Almost — lift those knees a bit higher', canSkip: true }),
  left: model('full', 'left', { progress: 0.35 }),
  right: model('full', 'right', { progress: 0 }),
  jump: model('full', 'jump', { progress: 0.8, peak: 0.12 }),
  roll: model('full', 'roll', { progress: 1, peak: 0.41 }),
  hover: model('full', 'hover', { progress: 0.45 }),
  'near-miss': model('full', 'left', { progress: 0.68, peak: 0.34, hint: 'Almost — go a bit further' }),
  skippable: model('full', 'jump', { progress: 0.55, peak: 0.08, hint: 'Almost — go a bit further', canSkip: true, canAccept: true }),
  summary: summary('full', [], null),
  'summary-skipped': summary('full', ['jump'], 'Your left step is much smaller than your right — we used the bigger one.'),
  'small-jog': model('small', 'jog', { steps: { seen: 3, needed: 4 }, progress: 0.75 }),
  'small-left': model('small', 'left', { progress: 0.42, hint: 'Almost — lean a little further', canSkip: true, canAccept: true }),
  'small-jump': model('small', 'jump', { progress: 0.9 }),
  'small-roll': model('small', 'roll', { progress: 0.2 }),
  'small-summary': summary('small', ['jump', 'roll'], null),
};

// ---------------------------------------------------------------- backdrop

function paintBackdrop(): void {
  const c = document.getElementById('backdrop') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  const horizon = H * 0.42;
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#ff9a5a');
  sky.addColorStop(0.6, '#ffc58a');
  sky.addColorStop(1, '#ffe2b8');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, horizon);
  const cols = ['#c4607a', '#e0a24a', '#6b8fb8', '#d9774b', '#8a6aa8', '#58a58a'];
  let x = -20;
  let i = 0;
  while (x < W) {
    const w = 60 + ((i * 37) % 70);
    const h = 80 + ((i * 53) % 160);
    g.fillStyle = cols[i % cols.length];
    g.fillRect(x, horizon - h, w, h + 4);
    x += w + 4;
    i++;
  }
  const ground = g.createLinearGradient(0, horizon, 0, H);
  ground.addColorStop(0, '#9c8f7e');
  ground.addColorStop(1, '#6d6152');
  g.fillStyle = ground;
  g.fillRect(0, horizon, W, H - horizon);
  const vx = W / 2;
  const laneX = (k: number, y: number) => vx + k * ((y - horizon) / (H - horizon)) * W * 0.62;
  for (const k of [-1.5, -0.5, 0.5, 1.5]) {
    g.fillStyle = '#4b3f35';
    g.beginPath();
    g.moveTo(laneX(k - 0.02, horizon), horizon);
    g.lineTo(laneX(k + 0.02, horizon), horizon);
    g.lineTo(laneX(k + 0.05, H), H);
    g.lineTo(laneX(k - 0.05, H), H);
    g.fill();
  }
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  paintBackdrop();
  const log = (what: string) => () => console.info('[move check]', what);
  const ui = new MoveCheckScreen(document.getElementById('move-check')!, {
    skipStep: log('skipStep'),
    acceptBest: log('acceptBest'),
    skipAll: log('skipAll'),
    redo: log('redo'),
    resetTuning: log('resetTuning'),
    start: log('start'),
  });
  ui.update(MODELS[state]);
  await document.fonts.ready;
  (window as unknown as { __ready: boolean }).__ready = true;
}

void main();
