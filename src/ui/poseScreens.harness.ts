/**
 * Visual harness for the webcam screens and the PiP (not part of the build).
 * poseScreens-harness.html?screen=<name>   (add &live=1 to animate the replayed skeleton)
 */
import './hud.css';
import { SessionFlow, type FlowInput, type PoseSnapshot } from '../app/flow';
import { Game } from '../game/game';
import { PoseController } from '../pose/controller';
import { decodeFixture, type PoseFixture } from '../pose/fixtures';
import type { PoseFrame, PoseStatus } from '../pose/types';
import { Hud } from './hud';
import { PosePip, pipVisibleFromUrl } from './pip';
import { PoseScreens } from './poseScreens';

const SCREENS = [
  'menu', 'menu-keyboard', 'prompt', 'starting', 'error',
  'calibrating', 'calib-back', 'calib-closer', 'calib-dark', 'calib-hold', 'calib-small', 'calib-stalled',
  'ready', 'ready-hold', 'recheck', 'playing', 'slow', 'stalled', 'summary',
] as const;
type Screen = (typeof SCREENS)[number];

const params = new URLSearchParams(location.search);
const screen = (SCREENS as readonly string[]).includes(params.get('screen') ?? '') ? (params.get('screen') as Screen) : 'calibrating';
const live = params.has('live');
if (params.has('shot')) document.body.classList.add('shot');

const nav = document.getElementById('nav')!;
for (const s of SCREENS) {
  const a = document.createElement('a');
  a.href = `?screen=${s}`;
  a.textContent = s;
  nav.append(a);
}

// ---------------------------------------------------------------- backdrop: a static Mumbai-ish track

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
  // Buildings.
  const cols = ['#c4607a', '#e0a24a', '#6b8fb8', '#d9774b', '#8a6aa8', '#58a58a'];
  let x = -20;
  let i = 0;
  while (x < W) {
    const w = 60 + ((i * 37) % 70);
    const h = 80 + ((i * 53) % 160);
    g.fillStyle = cols[i % cols.length];
    g.fillRect(x, horizon - h, w, h + 4);
    g.fillStyle = 'rgba(255,240,200,0.55)';
    for (let wy = horizon - h + 12; wy < horizon - 14; wy += 22) {
      for (let wx = x + 8; wx < x + w - 12; wx += 18) g.fillRect(wx, wy, 8, 11);
    }
    x += w + 4;
    i++;
  }
  // Ground and three lanes in perspective.
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
  for (const k of [-1, 0, 1]) {
    for (const off of [-0.3, 0.3]) {
      g.strokeStyle = '#d7d2cc';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(laneX(k + off, horizon), horizon);
      g.lineTo(laneX(k + off, H), H);
      g.stroke();
    }
  }
  // A train on the right lane.
  const ty = H * 0.5;
  g.fillStyle = '#2f7bd1';
  g.fillRect(laneX(1, ty) - 70, ty - 150, 140, 150);
  g.fillStyle = '#ffd400';
  g.fillRect(laneX(1, ty) - 70, ty - 40, 140, 14);
  g.fillStyle = '#bfe3ff';
  g.fillRect(laneX(1, ty) - 52, ty - 130, 104, 50);
}

// ---------------------------------------------------------------- pose data from the fixture

async function loadFrames(): Promise<PoseFrame[]> {
  const res = await fetch('/tests/fixtures/synth-full.json');
  return decodeFixture((await res.json()) as PoseFixture);
}

function statusAt(frames: PoseFrame[], index: number): { ctrl: PoseController; status: PoseStatus } {
  const ctrl = new PoseController();
  for (let i = 0; i <= index && i < frames.length; i++) ctrl.update(frames[i]);
  return { ctrl, status: ctrl.status };
}

function raiseRightHand(st: PoseStatus): PoseStatus {
  if (!st.pose) return st;
  const pose = st.pose.map((l) => ({ ...l }));
  pose[16] = { ...pose[16], y: pose[12].y - 0.17, x: pose[12].x + 0.03 };
  pose[14] = { ...pose[14], y: pose[12].y - 0.06, x: pose[12].x + 0.05 };
  return { ...st, pose };
}

const snap = (p: Partial<PoseSnapshot>): FlowInput => ({
  type: 'pose',
  status: {
    tracking: true,
    calibrated: false,
    mode: null,
    startProgress: 0,
    calibration: { progress: 0, bodyVisible: true, distance: 'ok' },
    dark: false,
    ...p,
  },
});

function buildFlow(s: Screen): SessionFlow {
  const f = new SessionFlow({ input: s === 'menu-keyboard' ? 'keyboard' : 'webcam', cameraId: 'usb', moveCheck: 'skip' });
  if (s === 'menu' || s === 'menu-keyboard') return f;
  f.dispatch({ type: 'startPressed' });
  if (s === 'prompt') return f;
  f.dispatch({ type: 'startPressed' });
  if (s === 'starting') return f;
  if (s === 'error') {
    f.dispatch({
      type: 'cameraFailed',
      message: 'The camera is busy. Close other apps using it (Teams, Zoom, Camera) and retry.',
    });
    return f;
  }
  f.dispatch({ type: 'cameraOk' });
  switch (s) {
    case 'calibrating':
      f.dispatch(snap({ tracking: false, calibration: { progress: 0, bodyVisible: false, distance: 'ok' } }));
      return f;
    case 'calib-back':
      f.dispatch({ type: 'chooseMode', mode: 'full' });
      f.dispatch(snap({ calibration: { progress: 0, bodyVisible: true, distance: 'back' } }));
      return f;
    case 'calib-closer':
      f.dispatch(snap({ calibration: { progress: 0, bodyVisible: true, distance: 'closer' } }));
      return f;
    case 'calib-dark':
      f.dispatch(snap({ dark: true, calibration: { progress: 0.2, bodyVisible: true, distance: 'ok' } }));
      return f;
    case 'calib-hold':
    case 'calib-stalled':
      f.dispatch(snap({ calibration: { progress: 0.62, bodyVisible: true, distance: 'ok' } }));
      return f;
    case 'calib-small':
      f.dispatch({ type: 'chooseMode', mode: 'small' });
      f.dispatch(snap({ calibration: { progress: 0.35, bodyVisible: true, distance: 'ok' } }));
      return f;
    default:
      break;
  }
  f.dispatch(snap({ calibrated: true, mode: 'full' }));
  if (s === 'ready') return f;
  if (s === 'ready-hold') {
    f.dispatch(snap({ calibrated: true, mode: 'full', startProgress: 0.6 }));
    return f;
  }
  f.dispatch({ type: 'startPressed' });
  f.dispatch({ type: 'gameState', state: 'countdown' });
  f.dispatch({ type: 'gameState', state: 'playing' });
  if (s === 'summary' || s === 'recheck') {
    f.dispatch({ type: 'gameState', state: 'caught' });
    f.dispatch({ type: 'gameState', state: 'summary' });
  }
  if (s === 'recheck') {
    f.dispatch(snap({ tracking: false, calibrated: true, mode: 'full' }));
    f.dispatch({ type: 'startGesture' });
  }
  return f;
}

function buildGame(s: Screen): Game {
  const g = new Game({ seed: 7, difficulty: 'cardio' });
  if (s === 'playing' || s === 'slow' || s === 'stalled') {
    g.state = 'playing';
    g.time = 12;
    g.speed = 14;
    g.stats.score = 1840;
    g.stats.coins = 37;
  } else if (s === 'summary' || s === 'recheck') {
    g.state = 'summary';
    g.stats.score = 4210;
    g.stats.coins = 88;
    g.stats.distance = 612;
    g.stats.jumps = 14;
    g.stats.rolls = 9;
    g.stats.timeSec = 94;
  }
  return g;
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  paintBackdrop();
  const flow = buildFlow(screen);
  const game = buildGame(screen);
  const hud = new Hud(document.getElementById('hud')!);
  hud.update(game);

  const pip = new PosePip(document.getElementById('pip')!, { visible: pipVisibleFromUrl(location.search) });
  pip.attachToggleKey(window);
  pip.setVideo(null);

  const log = (i: FlowInput) => console.info('[flow input]', JSON.stringify(i));
  const ui = new PoseScreens(document.getElementById('pose-ui')!, {
    onInput: (i) => {
      log(i);
      for (const fx of flow.dispatch(i)) console.info('[flow effect]', JSON.stringify(fx));
      render();
    },
    onSaveCamera: (id) => console.info('[save camera]', id),
  });
  ui.setCameras(
    [
      { deviceId: 'ir', label: 'Integrated IR Camera' },
      { deviceId: 'rgb', label: 'Integrated Camera' },
      { deviceId: 'usb', label: 'Logitech C920 HD Pro' },
    ],
    'usb',
  );

  const frames = await loadFrames();
  const frameIndex =
    screen === 'playing' || screen === 'slow' || screen === 'stalled' ? 240 : screen === 'calib-hold' || screen === 'calib-stalled' ? 30 : 60;
  let { status } = statusAt(frames, frameIndex);
  if (screen === 'ready' || screen === 'ready-hold') status = raiseRightHand(status);
  if (screen === 'calibrating' || screen === 'recheck') status = { ...status, pose: null, tracking: false };
  if (screen === 'slow') status = { ...status, slowPose: true, poseFps: 11 };
  const stalled = screen === 'stalled' || screen === 'calib-stalled';
  function render(): void {
    const m = flow.model;
    ui.update(m);
    pip.setLayout(m.screen === 'calibrating' || m.screen === 'ready' ? 'stage' : 'corner');
    pip.setActive(m.input === 'webcam' && (m.screen === 'calibrating' || m.screen === 'ready' || m.screen === 'playing'));
    ui.setWarnings(status.slowPose, stalled);
  }
  render();

  if (live) {
    const ctrl = new PoseController();
    let i = 0;
    let t0 = performance.now();
    const tick = (now: number) => {
      const dur = frames[frames.length - 1].t;
      const tt = (now - t0) % dur;
      if (now - t0 >= dur) {
        t0 = now;
        i = 0;
      }
      while (i < frames.length && frames[i].t <= tt) {
        ctrl.update({ ...frames[i], t: t0 + frames[i].t });
        i++;
      }
      status = ctrl.status;
      pip.update(status, false, now, frames[0].aspect);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } else {
    // Let the corner → stage transition finish so the canvas is measured at its final size.
    await new Promise((r) => setTimeout(r, 700));
    pip.update(status, stalled, performance.now(), frames[0].aspect);
  }

  await document.fonts.ready;
  (window as unknown as { __ready: boolean }).__ready = true;
}

void main();
