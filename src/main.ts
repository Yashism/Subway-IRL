import './ui/hud.css';
import { SessionFlow, type FlowEffect, type InputMode, type ModeChoice } from './app/flow';
import { AppLoop } from './app/loop';
import { fixtureReplay, loadSession, PoseRuntime, sessionReplay } from './app/poseRuntime';
import { ProfileStore, type RunRecord } from './app/profile';
import { Autopilot } from './game/autopilot';
import type { Difficulty } from './game/config';
import { Game } from './game/game';
import { FixedStepper } from './game/loop';
import { KeyboardInput } from './input/keyboard';
import { listCameras } from './pose/camera';
import type { Thresholds } from './pose/thresholds';
import type { PlayMode } from './pose/types';
import type { SessionRecording } from './telemetry/messages';
import { TelemetryPublisher } from './telemetry/publisher';
import { Hud, menuNotice, openMonitorWindow } from './ui/hud';
import { PosePip, pipVisibleFromUrl } from './ui/pip';
import { PoseScreens } from './ui/poseScreens';
import { isLineId } from './world/stations';
import { WorldView, type ToneChoice } from './world/worldView';

// ---------------------------------------------------------------- URL options
//   ?input=keyboard|webcam   webcam is the default (falls back to keys without a camera)
//   ?autopilot               bot demo (implies keyboard); ?autopilot=0 is off
//   ?posereplay=<fixture>    pose frames from tests/fixtures/<fixture>.json instead of the camera
//   ?session=<file>          replay a monitor recording from tests/fixtures/sessions/
//   ?mode=full|small         force the play mode; ?monitor opens the live monitor
//   ?difficulty= ?seed= ?god ?jog ?tone= ?line= ?pip=0 ?perf ?saveAutopilot

const params = new URLSearchParams(location.search);
const flagOn = (name: string): boolean => {
  if (!params.has(name)) return false;
  return !['0', 'off', 'false', 'no'].includes((params.get(name) ?? '').toLowerCase());
};

// A recorded session replays with the settings it was recorded with.
const sessionFile = params.get('session');
let session: SessionRecording | null = null;
let bootError = '';
if (sessionFile) {
  try {
    session = await loadSession(sessionFile);
  } catch (err) {
    bootError = err instanceof Error ? err.message : String(err);
  }
}

const sessionMeta = session?.meta ?? null;

const DIFFICULTIES: Difficulty[] = ['chill', 'cardio', 'beast'];
const requested = (sessionMeta?.difficulty ?? params.get('difficulty')) as Difficulty | null;
const difficulty: Difficulty = requested && DIFFICULTIES.includes(requested) ? requested : 'cardio';
const seedParam = Number(params.get('seed'));
const seed = sessionMeta ? sessionMeta.seed : Number.isFinite(seedParam) && params.has('seed') ? seedParam : Math.floor(Math.random() * 1e6);

const game = new Game({ seed, difficulty, god: params.has('god') });
const keyboard = new KeyboardInput();
keyboard.jogEnabled = params.has('jog');
keyboard.attach(window);
const autopilotOn = flagOn('autopilot');
const autopilot = autopilotOn ? new Autopilot(game) : null;

// ---------------------------------------------------------------- pose pipeline

const replayName = session ? (sessionFile ?? 'session') : (params.get('posereplay') ?? '');
const replay = session ? sessionReplay(session) : replayName ? fixtureReplay(replayName) : null;
const modeParam = params.get('mode');
const forcedMode: PlayMode | null = sessionMeta
  ? ((sessionMeta.mode as PlayMode | null) ?? null)
  : modeParam === 'full' || modeParam === 'small'
    ? modeParam
    : null;
const runtime = new PoseRuntime({
  replay,
  replayName,
  controller: {
    forcedMode,
    sensitivity: sessionMeta?.sensitivity,
    thresholds: sessionMeta?.thresholds as Partial<Thresholds> | undefined,
  },
});
const initialInput: InputMode =
  autopilotOn || (params.get('input') === 'keyboard' && !replay && !sessionFile) ? 'keyboard' : 'webcam';
const flow = new SessionFlow({
  input: initialInput,
  cameraId: runtime.savedCameraId(),
  modeChoice: (forcedMode ?? 'auto') as ModeChoice,
});

// ---------------------------------------------------------------- view

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const TONES: ToneChoice[] = ['neutral', 'agx', 'aces'];
const toneParam = params.get('tone') as ToneChoice | null;
const lineParam = params.get('line');
const world = new WorldView(canvas, {
  seed,
  tone: toneParam && TONES.includes(toneParam) ? toneParam : undefined,
  line: isLineId(lineParam) ? lineParam : undefined,
});
const hud = new Hud(document.getElementById('hud')!);
const stepper = new FixedStepper();

// The pose UI stacks above the HUD, so it goes after #hud in the DOM.
const pipRoot = document.body.appendChild(document.createElement('div'));
const uiRoot = document.body.appendChild(document.createElement('div'));
const screens = new PoseScreens(uiRoot, {
  onInput: (i) => loop.dispatch(i),
  onSaveCamera: (id) => runtime.saveCameraId(id),
});
const pip = new PosePip(pipRoot, { visible: pipVisibleFromUrl(location.search) });
pip.attachToggleKey(window);
runtime.sampleLuma = (t) => pip.sampleLuma(t);

/** The PiP holds the camera video only while it is showing; otherwise the video is parked (still playing). */
let pipHasVideo = false;
function syncPipVideo(show: boolean): void {
  const want = show && runtime.video !== null && runtime.running;
  if (want === pipHasVideo) return;
  pipHasVideo = want;
  pip.setVideo(want ? runtime.video : null);
  if (!want) runtime.parkVideo();
}

// ---------------------------------------------------------------- telemetry (live monitor)

const telemetry = new TelemetryPublisher();
const inputLabel = (): string =>
  autopilotOn ? 'autopilot' : runtime.isReplay ? `replay:${runtime.replayName}` : flow.input;
const currentMode = (): string | null => runtime.ctrl.baseline?.mode ?? runtime.ctrl.forcedMode ?? null;
let metaKey = '';
function sendMeta(): void {
  const ctrl = runtime.ctrl;
  metaKey = `${inputLabel()}|${currentMode()}`;
  telemetry.meta({
    seed,
    difficulty,
    input: inputLabel(),
    mode: currentMode(),
    sensitivity: ctrl.sensitivity,
    thresholds: { ...(ctrl.th as unknown as Record<string, number>) },
  });
}
runtime.onFrame = (f, events) => {
  telemetry.frame(f);
  telemetry.poseEvents(events, f.t);
};

/** Counts recalibrations the flow asked for, so a monitor request can tell whether the flow handled it. */
let recalibrations = 0;
telemetry.onControl((msg) => {
  const ctrl = runtime.ctrl;
  const before = recalibrations;
  switch (msg.kind) {
    case 'setSensitivity':
      ctrl.sensitivity = msg.value;
      break;
    case 'setThreshold':
      if (msg.key in ctrl.th) (ctrl.th as unknown as Record<string, number>)[msg.key] = msg.value;
      break;
    case 'recalibrate':
      loop.dispatch({ type: 'recalibrate' });
      if (recalibrations === before) runtime.recalibrate();
      break;
    case 'forceMode':
      loop.dispatch({ type: 'chooseMode', mode: msg.mode ?? 'auto' });
      if (ctrl.forcedMode !== msg.mode) ctrl.forcedMode = msg.mode;
      if (recalibrations === before) runtime.recalibrate();
      break;
  }
  sendMeta();
});
window.addEventListener('pagehide', () => {
  telemetry.close();
  runtime.stop();
});

// ---------------------------------------------------------------- session flow effects

function openCamera(cameraId: string | null): void {
  runtime.start(cameraId).then(
    (ok) => {
      if (!ok) return;
      screens.setCameras(runtime.cameras, runtime.activeCameraId);
      loop.dispatch({ type: 'cameraOk' });
      sendMeta();
    },
    (err: unknown) => {
      console.warn('Camera or pose model failed to start:', err);
      loop.dispatch({ type: 'cameraFailed', message: runtime.describeError(err) });
    },
  );
}
runtime.onCameraEnded = () =>
  loop.dispatch({ type: 'cameraFailed', message: 'The camera stopped. Plug it back in or pick another camera, then retry.' });

function onEffect(fx: FlowEffect): void {
  switch (fx.type) {
    case 'openCamera':
      openCamera(fx.cameraId);
      break;
    case 'stopCamera':
      runtime.stop();
      syncPipVideo(false);
      sendMeta();
      break;
    case 'recalibrate':
      recalibrations++;
      runtime.recalibrate();
      break;
    case 'setForcedMode':
      runtime.ctrl.forcedMode = fx.mode;
      sendMeta();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- saved profile

// Autopilot and pose-replay runs are demos: not saved unless ?saveAutopilot is set.
const profile = new ProfileStore();
const saveRuns = !(autopilot || runtime.isReplay) || params.has('saveAutopilot');
hud.setProfile(profile.profile, null);

/** Records the run that just ended; called once per run, on entering the summary. */
function recordRun(): void {
  if (!saveRuns) {
    hud.setProfile(profile.profile, null);
    return;
  }
  const s = game.stats;
  const run: RunRecord = {
    at: Date.now(),
    score: s.score,
    coins: s.coins,
    distance: s.distance,
    timeSec: s.timeSec,
    jumps: s.jumps,
    rolls: s.rolls,
    laneChanges: s.laneChanges,
    steps: s.steps,
    hoverboardsUsed: s.hoverboardsUsed,
    caughtReason: game.caughtReason,
    difficulty,
    seed,
    input: autopilot ? 'autopilot' : flow.input,
  };
  const result = profile.recordRun(run);
  hud.setProfile(profile.profile, result);
}

const loop: AppLoop = new AppLoop({
  game,
  flow,
  keyboard,
  autopilot,
  pose: runtime,
  telemetry,
  onEffect,
  onGameEvent: (e) => {
    if (e.type === 'state' && e.state === 'summary') recordRun();
  },
  stallMs: runtime.ctrl.th.lostMs,
});

Object.assign(window as unknown as Record<string, unknown>, {
  __game: game,
  __world: world,
  __profile: profile,
  __flow: flow,
  __runtime: runtime,
  __loop: loop,
  __telemetry: telemetry,
});

// ---------------------------------------------------------------- live monitor shortcut

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  openMonitorWindow();
});
if (flagOn('monitor') && !openMonitorWindow()) {
  // Popup blocked without a user gesture: open on the first key or click instead.
  const once = () => {
    window.removeEventListener('keydown', once, true);
    window.removeEventListener('pointerdown', once, true);
    openMonitorWindow();
  };
  window.addEventListener('keydown', once, true);
  window.addEventListener('pointerdown', once, true);
}

// ---------------------------------------------------------------- page lifecycle

const perf = params.has('perf') ? document.body.appendChild(document.createElement('div')) : null;
if (perf) perf.className = 'hud-perf';
let fps = 60;

function resize(): void {
  world.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}
resize();
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) loop.pauseGame();
});

// The GPU can drop the context (driver reset, too many tabs). preventDefault lets the browser
// restore it; three.js re-uploads its resources then, and the player resumes with Enter.
let contextLost = false;
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  contextLost = true;
  loop.pauseGame();
  console.warn('WebGL context lost; game paused until it is restored.');
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  resize();
  console.warn('WebGL context restored; press Enter to resume.');
});

// ---------------------------------------------------------------- boot: pick the input

let fallback = '';
function fallBackToKeyboard(reason: string): void {
  if (flow.input !== 'webcam' || flow.screen !== 'menu') return;
  fallback = reason;
  loop.dispatch({ type: 'useKeyboard' });
  sendMeta();
}

async function boot(): Promise<void> {
  sendMeta();
  if (bootError) {
    // A missing ?session file: show it on the camera error screen (Retry reloads nothing useful; keys still work).
    loop.dispatch({ type: 'startPressed' });
    loop.dispatch({ type: 'cameraFailed', message: bootError });
    return;
  }
  if (flow.input !== 'webcam') return;
  if (runtime.isReplay) {
    // No explainer for a replay: straight to calibration with the replayed body.
    loop.dispatch({ type: 'startPressed' });
    loop.dispatch({ type: 'startPressed' });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) return fallBackToKeyboard('This browser cannot use a camera');
  let cams: Awaited<ReturnType<typeof listCameras>> = [];
  try {
    cams = await listCameras();
  } catch {
    cams = [];
  }
  if (cams.length === 0) return fallBackToKeyboard('No camera found');
  // Permission already granted: open the camera now, so a raised hand works from the menu.
  try {
    const perm = await navigator.permissions.query({ name: 'camera' as PermissionName });
    if (perm.state === 'granted' && flow.screen === 'menu' && flow.input === 'webcam' && !runtime.running) openCamera(null);
  } catch {
    // Permissions API without "camera" (Firefox): wait for Enter.
  }
}
void boot();

// ---------------------------------------------------------------- frame loop

let last = performance.now();
function frame(now: number): void {
  const dt = Math.max(0, (now - last) / 1000);
  last = now;
  const steps = stepper.advance(dt);
  loop.beginFrame();
  for (let i = 0; i < steps; i++) loop.step(stepper.stepSec, now);
  loop.endFrame(now);

  const m = flow.model;
  screens.update(m);
  const webcam = m.input === 'webcam';
  const st = loop.status;
  screens.setWarnings(webcam && flow.cameraReady && !!st?.slowPose, loop.stalled);
  const setup = m.screen === 'calibrating' || m.screen === 'ready';
  const pipOn = webcam && flow.cameraReady && (setup || m.screen === 'playing');
  pip.setActive(pipOn);
  pip.setLayout(setup ? 'stage' : 'corner');
  syncPipVideo(pipOn);
  if (pipOn && st) pip.update(st, loop.stalled, now, runtime.aspect);

  if (game.state === 'menu') {
    hud.setInputNotice(
      menuNotice({ input: m.input, cameraReady: flow.cameraReady, replay: runtime.replayName, autopilot: autopilotOn, fallback }),
    );
  }
  if (`${inputLabel()}|${currentMode()}` !== metaKey) sendMeta();

  if (!contextLost) world.render(game, dt, loop.frameEvents);
  hud.update(game);
  if (perf && dt > 0) {
    fps += (1 / dt - fps) * 0.05;
    const s = world.stats;
    const pose = runtime.running ? `  pose ${runtime.backend} ${runtime.fps} fps` : '';
    perf.textContent = `${fps.toFixed(0)} fps  ${s.calls} calls  ${(s.triangles / 1000).toFixed(1)}k tris  dpr ${s.pixelRatio}\nseed ${seed}  ${difficulty}  s=${game.s.toFixed(0)}${pose}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
