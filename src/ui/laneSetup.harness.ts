/**
 * Visual harness for the lane-spots setup (not part of the build; no camera, no logic).
 * laneSetup-harness.html?state=<name>
 */
import './hud.css';
import { HINT_LOST, type LaneSetupModel } from '../pose/laneSetup';
import { LaneSetupScreen } from './laneSetupScreen';

const STATES = [
  'centre', 'centre-hold', 'left-hold', 'left-further', 'right-wrong', 'right-taken', 'lost', 'edge', 'summary',
] as const;
type State = (typeof STATES)[number];

const params = new URLSearchParams(location.search);
const state = (STATES as readonly string[]).includes(params.get('state') ?? '') ? (params.get('state') as State) : 'centre';
if (params.has('shot')) document.body.classList.add('shot');

const nav = document.getElementById('nav')!;
for (const s of STATES) {
  const a = document.createElement('a');
  a.href = `?state=${s}`;
  a.textContent = s;
  nav.append(a);
}

// ---------------------------------------------------------------- fixture models

const HOW = {
  centre: 'Stand where you want the centre lane',
  left: 'Step to where you want the left lane',
  right: 'Step to where you want the right lane',
} as const;
const LABEL = { centre: 'Centre', left: 'Left', right: 'Right' } as const;
const INDEX = { centre: 0, left: 1, right: 2 } as const;

function model(step: 'centre' | 'left' | 'right', over: Partial<LaneSetupModel> = {}): LaneSetupModel {
  return {
    step,
    index: INDEX[step],
    label: LABEL[step],
    how: HOW[step],
    spots: { centre: step === 'centre' ? null : 0.08, left: step === 'right' ? -0.64 : null, right: null },
    live: 0,
    hold: 0,
    blocked: null,
    hint: null,
    taken: false,
    result: null,
    ...over,
  };
}

const MODELS: Record<State, LaneSetupModel> = {
  centre: model('centre', { live: 0.02 }),
  'centre-hold': model('centre', { live: 0.08, hold: 0.55 }),
  'left-hold': model('left', { live: -0.6, hold: 0.4 }),
  'left-further': model('left', { live: -0.06, blocked: 'tooClose', hint: 'Step further left' }),
  'right-wrong': model('right', { live: -0.3, blocked: 'wrongSide', hint: 'Step further right' }),
  'right-taken': model('right', { live: 0.58, hold: 1, taken: true, spots: { centre: 0.08, left: -0.64, right: 0.58 } }),
  lost: model('left', { live: null, hint: HINT_LOST }),
  edge: model('right', { live: 1.9, hold: 0.2 }),
  summary: {
    ...model('right'),
    step: null,
    index: 3,
    live: 0.1,
    spots: { centre: 0.08, left: -0.64, right: 0.58 },
    result: { left: -0.64, centre: 0.08, right: 0.58 },
  },
};

// ---------------------------------------------------------------- backdrop (the same street as the move-check harness)

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
  sky.addColorStop(1, '#ffe2b8');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, horizon);
  const cols = ['#c4607a', '#e0a24a', '#6b8fb8', '#d9774b', '#8a6aa8', '#58a58a'];
  for (let x = -20, i = 0; x < W; i++) {
    const w = 60 + ((i * 37) % 70);
    const h = 80 + ((i * 53) % 160);
    g.fillStyle = cols[i % cols.length];
    g.fillRect(x, horizon - h, w, h + 4);
    x += w + 4;
  }
  const ground = g.createLinearGradient(0, horizon, 0, H);
  ground.addColorStop(0, '#9c8f7e');
  ground.addColorStop(1, '#6d6152');
  g.fillStyle = ground;
  g.fillRect(0, horizon, W, H - horizon);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  paintBackdrop();
  const log = (what: string) => () => console.info('[lane setup]', what);
  const ui = new LaneSetupScreen(document.getElementById('lane-setup')!, { save: log('save'), redo: log('redo'), cancel: log('cancel') });
  ui.update(MODELS[state]);
  await document.fonts.ready;
  // Park every looping animation at its start, and let the one-shot entrances land.
  for (const a of document.getAnimations()) {
    if (a.effect?.getComputedTiming().iterations === Infinity) {
      a.currentTime = 0;
      a.pause();
    } else a.finish();
  }
  (window as unknown as { __ready: boolean }).__ready = true;
}

void main();
