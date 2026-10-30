import './ui/hud.css';
import { GameAudio } from './audio';
import { SessionFlow, type FlowEffect, type InputMode, type ModeChoice, type MoveCheckPolicy } from './app/flow';
import { IntroRunner, introMode, shouldPlayIntro } from './app/intro';
import { applyLiveSettings } from './app/liveSettings';
import { AppLoop } from './app/loop';
import { LaneSetupSession } from './app/laneSetupSession';
import { MoveCheckSession } from './app/moveCheckSession';
import { fixtureReplay, loadSession, PoseRuntime, sessionReplay, STALL_MS } from './app/poseRuntime';
import { ProfileStore } from './app/profile';
import { ProgressionStore, dailyView, fmtCoins, levelProgress, shopItem, shopModel } from './app/progression';
import { RunSession, type RunBoosts } from './app/session';
import { GestureUnlock, soundAllowed } from './app/sound';
import { SettingsStore, applyUrlFlags, type GameSettings } from './app/settings';
import { Autopilot } from './game/autopilot';
import { DEFAULT_OBSTACLES, OBSTACLE_AMOUNTS, obstacleLevel, type Difficulty, type ObstacleAmount, type ObstacleSettings } from './game/config';
import { Game } from './game/game';
import { FixedStepper } from './game/loop';
import { KeyboardInput } from './input/keyboard';
import { listCameras } from './pose/camera';
import { warmPoseAssets } from './pose/landmarker';
import { LivePoseSource } from './pose/liveSource';
import { cleanLaneSpots } from './pose/laneSpots';
import type { Thresholds } from './pose/thresholds';
import type { PlayMode } from './pose/types';
import type { SessionRecording } from './telemetry/messages';
import { TelemetryPublisher } from './telemetry/publisher';
import { Hud, menuNotice, openMonitorWindow } from './ui/hud';
import { LaneSetupScreen } from './ui/laneSetupScreen';
import { MissionBoard, renderMissionList, renderMissionToast } from './ui/missionCard';
import { MoveCheckScreen, renderSummaryCard } from './ui/moveCheckScreen';
import { PosePip, isStalled, pipVisibleFromUrl } from './ui/pip';
import { PoseScreens, cameraOptions } from './ui/poseScreens';
import { SettingsScreen, type SettingsView } from './ui/settings';
import { ShopScreen } from './ui/shop';
import { WorkoutScreen } from './ui/workout';
import { FrameLimiter, RenderScale } from './app/frameBudget';
import { setOutlineStrength } from './world/render/materials';
import type { PoseSample, Wander } from './wander';
import type { RunnerPalette } from './world/models/characters';
import { WorldView, type ToneChoice } from './world/worldView';

// ---------------------------------------------------------------- URL options
//   ?input=keyboard|webcam   webcam is the default (falls back to keys without a camera)
//   ?autopilot               bot demo (implies keyboard); ?autopilot=0 is off
//   ?posereplay=<fixture>    pose frames from tests/fixtures/<fixture>.json instead of the camera
//   ?session=<file>          replay a monitor recording from tests/fixtures/sessions/
//   ?mode=full|small         force the play mode; ?monitor opens the live monitor
//   ?movecheck=skip|force    never / always run the guided move check after calibration
//   ?intro=always|off        force / suppress the intro cinematic (default: once per session)
//   ?mute ?vol=0.5 ?nosamples   the mixer; ?audio forces sound on for an autopilot/replay demo
//   ?difficulty= ?obstacles=1..5 ?amount=few|normal|lots ?seed= ?god ?tone= ?line= ?sens= ?reduced
//   ?lanes=auto|spots        full-body lanes: automatic, or the player's recorded lane spots
//   ?pip=0 ?perf ?saveAutopilot
//   ?poses=2                 track two people instead of one (slower; default is one)
//   ?fps=N ?fps=0            cap the drawn frame rate (default ~60; 0 = every refresh)
//   ?scale=off               keep the render resolution fixed instead of adapting it to the GPU
//   ?wander                  boot straight into Wander, the free-roam mode (see src/wander/); the menu's
//                            Wander item does the same. Esc leaves it. Nothing in it is scored or saved.
//   ?jog                     debug: J fakes jog steps. Holding J also suppresses the idle catch in
//                            webcam mode, because the keyboard then claims to track jogging.

const params = new URLSearchParams(location.search);
// One tracked person is much cheaper; ?poses=2 is for a room where someone else may walk through.
LivePoseSource.numPoses = params.get('poses') === '2' ? 2 : 1;
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

// ---------------------------------------------------------------- the player's settings
//
// The saved settings are the baseline for everything below (difficulty, line, sensitivity, play
// mode, comfort). URL flags win over them for this session only and are never written back, so a
// shared link cannot change someone's saved game; a recorded session wins over both, because a
// replay must show what the player actually experienced.

const settingsStore = new SettingsStore();
let settings: GameSettings = settingsStore.override(applyUrlFlags(settingsStore.get(), location.search));
/**
 * The mixer, built at boot and silent until `unlock()` runs inside a real gesture. It owns
 * `subway-irl.audio.v1` (and `?mute` / `?vol=`), so the settings screen's sliders read and write
 * through it rather than keeping a second copy of the same four numbers.
 */
const audio = new GameAudio();

const DIFFICULTIES: Difficulty[] = ['chill', 'cardio', 'beast'];
const requested = (sessionMeta?.difficulty ?? null) as Difficulty | null;
const difficulty: Difficulty = requested && DIFFICULTIES.includes(requested) ? requested : settings.difficulty;
const seedParam = Number(params.get('seed'));
const seed = sessionMeta ? sessionMeta.seed : Number.isFinite(seedParam) && params.has('seed') ? seedParam : Math.floor(Math.random() * 1e6);
/** The seed normal runs use; the daily challenge borrows `game.options.seed` and hands it back. */
const baseSeed = seed;

/** The player's obstacle settings, or a recorded session's, so its replay lays the same track. */
const playerObstacles = (): ObstacleSettings => ({ level: settings.obstacleLevel, amount: settings.obstacleAmount });
const sessionObstacles = sessionMeta?.obstacles;
const obstacles: ObstacleSettings = sessionObstacles
  ? { level: obstacleLevel(sessionObstacles.level), amount: OBSTACLE_AMOUNTS.includes(sessionObstacles.amount as ObstacleAmount) ? (sessionObstacles.amount as ObstacleAmount) : 'normal' }
  : sessionMeta
    ? { ...DEFAULT_OBSTACLES }
    : playerObstacles();

const game = new Game({ seed, difficulty, god: params.has('god'), obstacles });
const keyboard = new KeyboardInput();
keyboard.jogEnabled = params.has('jog');
/** Detached while a full-screen overlay is up, so Enter cannot start a run behind it. */
let detachKeyboard: (() => void) | null = keyboard.attach(window);
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
/** The play mode in force: a recorded session, then `?mode=`, then the saved setting. */
const initialMode: PlayMode | null = forcedMode ?? (settings.mode === 'auto' ? null : settings.mode);
/** A recorded session decides lanes with the spots it was played with — or automatically, without any. */
const sessionSpots = sessionMeta ? cleanLaneSpots(sessionMeta.laneSpots) : null;
const runtime = new PoseRuntime({
  replay,
  replayName,
  controller: {
    forcedMode: initialMode,
    sensitivity: sessionMeta?.sensitivity ?? settings.sensitivity,
    thresholds: sessionMeta?.thresholds as Partial<Thresholds> | undefined,
    laneSpots: sessionSpots,
  },
});
const initialInput: InputMode =
  autopilotOn || (params.get('input') === 'keyboard' && !replay && !sessionFile) ? 'keyboard' : 'webcam';

// ---------------------------------------------------------------- move check (?movecheck=skip|force)

const movecheckParam = params.get('movecheck');
const movecheckPolicy: MoveCheckPolicy = movecheckParam === 'skip' || movecheckParam === 'force' ? movecheckParam : 'auto';
// A recorded session replays with the thresholds it was played with: its meta wins over any tuning
// saved on this machine, so the replay shows what the player actually experienced.
const replayingSession = !!sessionMeta?.thresholds;

const moveCheck = new MoveCheckSession({
  thresholds: runtime.ctrl.th,
  controller: runtime.ctrl,
  onStart: () => loop.dispatch({ type: 'startPressed' }),
  onTuningChanged: () => {
    flow.setMoveCheckSeen(moveCheck.seen);
    sendMeta();
  },
  onTelemetry: (mode, event, t) => {
    telemetry.moveCheck(mode, event, t);
    // A move that landed gets a confirmation; the whole check gets its small fanfare.
    if (event.phase === 'result' && event.result === 'done') audio.moveCheck('ok');
    else if (event.phase === 'done') audio.moveCheck('fanfare');
  },
});

// ---------------------------------------------------------------- lane spots

/**
 * The lane-spots setup. Only Save writes anything: it records the spots and switches Lanes to My
 * spots, which `applySettings` then puts in force on the controller. Every other way out of the
 * setup — Cancel, Home, Esc, a recalibration, a camera failure — leaves the saved spots alone.
 */
const lanes = new LaneSetupSession({
  onSaved: () => {
    audio.moveCheck('fanfare');
    applySettings(settingsStore.set({ lanes: 'spots' }));
    syncOverlays();
  },
  onDone: () => loop.dispatch({ type: 'lanesDone' }),
});

const flow = new SessionFlow({
  input: initialInput,
  cameraId: runtime.savedCameraId(),
  modeChoice: (forcedMode ?? settings.mode) as ModeChoice,
  moveCheck: replayingSession && movecheckPolicy !== 'force' ? 'skip' : movecheckPolicy,
  moveCheckSeen: moveCheck.seen,
});

// ---------------------------------------------------------------- view

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const TONES: ToneChoice[] = ['neutral', 'agx', 'aces'];
const toneParam = params.get('tone') as ToneChoice | null;
const world = new WorldView(canvas, {
  seed,
  tone: toneParam && TONES.includes(toneParam) ? toneParam : undefined,
  line: settings.line,
  // The sim has no train-pass event: only the view knows a moving local just drew level.
  onTrainPass: (closeness) => audio.trainPass(closeness),
});
const hud = new Hud(document.getElementById('hud')!, {
  onHome: () => {
    audio.ui('back');
    loop.dispatch({ type: 'home' });
  },
  onPlay: () => loop.dispatch({ type: 'startPressed' }),
  onSettings: () => setOverlay('settings'),
  onWorkout: () => setOverlay('workout'),
  onToggleSound: () => toggleSound(),
  onWander: () => void enterWander(),
});
const stepper = new FixedStepper();

// The pose UI stacks above the HUD, so it goes after #hud in the DOM.
const pipRoot = document.body.appendChild(document.createElement('div'));
const uiRoot = document.body.appendChild(document.createElement('div'));
const screens = new PoseScreens(uiRoot, {
  onInput: (i) => loop.dispatch(i),
  onSaveCamera: (id) => runtime.saveCameraId(id),
});
// The move check gets its own layer above the pose UI: it owns the whole screen while it is up.
const moveCheckRoot = document.body.appendChild(document.createElement('div'));
const moveCheckLayer = new MoveCheckScreen(moveCheckRoot, moveCheck.handlers, {
  onHome: () => loop.dispatch({ type: 'home' }),
});
// The lane setup likewise owns the whole screen while it is up.
const laneRoot = document.body.appendChild(document.createElement('div'));
const laneLayer = new LaneSetupScreen(laneRoot, lanes.handlers);
const pip = new PosePip(pipRoot, { visible: pipVisibleFromUrl(location.search) });
pip.attachToggleKey(window);
runtime.sampleLuma = (t) => pip.sampleLuma(t);
applySettings(settings);

// ---------------------------------------------------------------- progression, missions, the shop

// Autopilot and pose-replay runs are demos: not saved unless ?saveAutopilot is set. The same flag
// governs the profile, the wallet and the mission board — a bot must never bank a single coin.
const profile = new ProfileStore();
const progression = new ProgressionStore();
const saveRuns = !(autopilotOn || runtime.isReplay) || params.has('saveAutopilot');
const runs = new RunSession({ progression, profile, saveRuns });

const missionBoard = new MissionBoard(hud.menuPanel, {
  onPlayDaily: () => startDaily(),
  onShop: () => setOverlay('shop'),
});

// ---------------------------------------------------------------- full-screen overlays
//
// Settings, the workout screen and the shop each own the whole screen while they are up. They sit
// above every other layer, the keyboard is detached under them (so Enter cannot start a run behind
// one) and a live run is pinned down first, exactly as the flow does for its own screens.

type Overlay = 'none' | 'settings' | 'workout' | 'shop';
let overlay: Overlay = 'none';
/** "Redo the move check" was asked for before there was a camera to do it with. */
let wantsMoveCheck = false;

const settingsRoot = document.body.appendChild(document.createElement('div'));
const workoutRoot = document.body.appendChild(document.createElement('div'));
const shopRoot = document.body.appendChild(document.createElement('div'));

const settingsScreen = new SettingsScreen(settingsRoot, {
  change: (patch) => {
    audio.ui('click');
    // The mode is the one setting the flow owns: it re-calibrates and re-applies that mode's
    // tuning, so it goes through the flow rather than straight onto the controller.
    if (patch.mode !== undefined && patch.mode !== settings.mode) loop.dispatch({ type: 'chooseMode', mode: patch.mode });
    applySettings(settingsStore.set(patch));
    syncOverlays();
  },
  audioChange: (patch) => {
    audio.setVolumes(patch);
    syncOverlays();
  },
  chooseCamera: (id) => {
    runtime.saveCameraId(id);
    loop.dispatch({ type: 'chooseCamera', id });
    syncOverlays();
  },
  redoMoveCheck: () => {
    // The check needs a camera. The screen disables this button in keyboard mode, but the view it
    // was drawn from can be a moment stale — and a `startPressed` in keyboard mode means *play*.
    // This button asks to be measured; it must never be a way to start a run.
    if (flow.input !== 'webcam') return;
    setOverlay('none');
    // Three ways in, and Settings is reached from all of them. From the ready screen the check
    // runs on the spot. With a camera open — including on the menu — a recalibration runs it
    // behind the calibration. Without one, the camera has to be started first, so the player is
    // sent to the explainer and the request is held until the flow has something to measure.
    if (flow.screen === 'ready') loop.dispatch({ type: 'checkMoves' });
    else if (flow.cameraReady) loop.dispatch({ type: 'recalibrate' });
    else {
      wantsMoveCheck = true;
      loop.dispatch({ type: 'startPressed' });
    }
  },
  setLaneSpots: () => {
    // Like the move check, this asks to be measured and must never become a way to start a run.
    if (flow.input !== 'webcam') return;
    setOverlay('none');
    // The flow walks a player without a camera or a calibration there first, then opens it.
    loop.dispatch({ type: 'setLanes' });
  },
  resetTuning: () => {
    moveCheck.store.clear(currentMode() ?? undefined);
    moveCheck.lastSummary = null;
    moveCheck.applyFor(null);
    flow.setMoveCheckSeen(moveCheck.seen);
    controlsFrom = null;
    sendMeta();
    syncOverlays();
  },
  exportData: () => exportData(),
  clearHistory: () => {
    profile.reset();
    hud.setProfile(profile.profile, null);
    syncOverlays();
  },
  openWorkout: () => setOverlay('workout'),
  close: () => setOverlay('none'),
});

const workoutScreen = new WorkoutScreen(workoutRoot, {
  startRun: () => {
    setOverlay('none');
    loop.dispatch({ type: 'startPressed' });
  },
  openSettings: () => setOverlay('settings'),
  close: () => setOverlay('none'),
});

const shopScreen = new ShopScreen(shopRoot, {
  buy: (id) => {
    const bought = progression.buy(id);
    audio.ui(bought.ok ? 'confirm' : 'back');
    if (bought.ok && (bought.item.kind === 'character' || bought.item.kind === 'board')) progression.equip(id);
    applySkins();
    syncOverlays();
  },
  equip: (id) => {
    audio.ui('confirm');
    progression.equip(id);
    applySkins();
    syncOverlays();
  },
  close: () => setOverlay('none'),
});

/** What the settings screen renders: the three stores it shows, plus what the camera can do. */
function settingsView(): SettingsView {
  return {
    open: true,
    settings: settingsStore.get(),
    audio: audio.volumes,
    cameras: cameraOptions(runtime.cameras, runtime.activeCameraId ?? flow.model.cameraId),
    webcam: flow.input === 'webcam',
    hasTuning: !moveCheck.store.empty,
    laneSpots: lanes.store.get(),
    smallRoom: settings.mode === 'small' || currentMode() === 'small',
  };
}

function syncOverlays(): void {
  settingsScreen.update(overlay === 'settings' ? settingsView() : null);
  workoutScreen.update(overlay === 'workout' ? { open: true, profile: profile.profile, weightKg: settings.weightKg } : null);
  shopScreen.update(overlay === 'shop' ? shopModel(progression.state) : null);
  document.documentElement.dataset.overlay = overlay;
}

function setOverlay(next: Overlay): void {
  if (next === overlay) return;
  // Nothing covers a live run: pin it down first, the same ruling the flow's own screens follow.
  // A run paused by a lost pose counts — it resumes the moment tracking is back, which would
  // restart it behind the settings screen.
  const live = game.state === 'playing' || game.state === 'countdown' || (game.state === 'paused' && game.pausedByLoss);
  if (next !== 'none' && live) loop.pauseGame();
  audio.ui(next === 'none' ? 'back' : 'click');
  overlay = next;
  if (next === 'none') detachKeyboard ??= keyboard.attach(window);
  else {
    detachKeyboard?.();
    detachKeyboard = null;
  }
  syncOverlays();
}

/** "Export my data": the profile and the progression, as one JSON file. */
function exportData(): void {
  const body = JSON.stringify(
    { exportedAt: new Date().toISOString(), profile: JSON.parse(profile.exportJson()), progression: progression.state },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `subway-irl-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Puts a settings change in force, live. Called for the saved values at boot and on every change. */
function applySettings(next: GameSettings): void {
  settings = next;
  setOutlineStrength(next.outlines);
  applyLiveSettings(
    // A recorded session replays with the sensitivity, and the track, it was played with.
    {
      controller: runtime.ctrl,
      game,
      world,
      pip,
      laneSpots: lanes.store.get(),
      ownsSensitivity: sessionMeta?.sensitivity === undefined,
      ownsRun: !sessionMeta,
      // A replay decides lanes the way it was recorded (see `sessionSpots`).
      ownsLanes: !sessionMeta,
    },
    next,
  );
}

/** The equipped runner and hoverboard, from the shop. Cheap to call: the world ignores a repeat. */
function applySkins(): void {
  const { character, board } = progression.state.unlocks;
  world.setSkins({
    character: { id: character, palette: shopItem(character)?.palette },
    board: { id: board, palette: shopItem(board)?.palette },
  });
}

/**
 * The pause screen's "Controls" cheat sheet: the card this session's check ended on, or one built
 * from the saved tuning. Rebuilt only when the summary behind it changes.
 */
let controlsFrom: unknown = null;
let controlsEl: HTMLElement | null = null;
function controlsCard(): HTMLElement {
  const summary = moveCheck.controls(runtime.ctrl.baseline?.mode ?? runtime.ctrl.forcedMode ?? null);
  if (summary !== controlsFrom || !controlsEl) {
    controlsFrom = summary;
    controlsEl = renderSummaryCard(summary, { title: 'Controls' });
  }
  return controlsEl;
}

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
const currentMode = (): PlayMode | null => runtime.ctrl.baseline?.mode ?? runtime.ctrl.forcedMode ?? null;
let metaKey = '';
/** The lane spots the last meta reported; the controller hands out a new object whenever they change. */
let metaSpots: unknown = null;
function sendMeta(): void {
  const ctrl = runtime.ctrl;
  metaKey = `${inputLabel()}|${currentMode()}`;
  metaSpots = ctrl.laneSpots;
  telemetry.meta({
    seed,
    difficulty,
    obstacles: game.options.obstacles ?? { ...DEFAULT_OBSTACLES },
    input: inputLabel(),
    mode: currentMode(),
    sensitivity: ctrl.sensitivity,
    thresholds: { ...(ctrl.th as unknown as Record<string, number>) },
    moveTuning: moveCheck.tuningInForce(),
    laneSpots: ctrl.laneSpots ? { ...ctrl.laneSpots } : null,
  });
}
runtime.onFrame = (f, events) => {
  telemetry.frame(f);
  telemetry.poseEvents(events, f.t);
  // The spec counts the raised-hand start as a gesture. A browser may disagree and refuse to
  // resume; `unlock()` swallows that, and the next key or click gets there anyway.
  for (let i = 0; i < events.length; i++) if (events[i].type === 'start') gesture.fire();
  // The check measures the same signals the controller just computed, on the same frame.
  if (runtime.ctrl.baseline) moveCheck.frame(runtime.ctrl, events, f.t);
  lanes.frame(runtime.ctrl, f.t);
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
      // hasOwn, not `in`: `in` walks the prototype, so any same-origin tab could write toString.
      if (Object.hasOwn(ctrl.th, msg.key)) (ctrl.th as unknown as Record<string, number>)[msg.key] = msg.value;
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
window.addEventListener('pagehide', (event) => {
  telemetry.close();
  runtime.stop();
  // Going into the back/forward cache: this page may be shown again exactly as it is. Tearing the
  // audio graph down there leaves a restored page permanently silent, so it is only suspended.
  if (event.persisted) {
    audio.suspend();
    return;
  }
  gesture.detach();
  audio.dispose();
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
      // The error card tells the player to pick another camera, so it had better have the list.
      // `start()` enumerates before it can fail, and boot() enumerated before that.
      screens.setCameras(runtime.cameras, runtime.activeCameraId ?? cameraId);
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
    case 'startMoveCheck':
      moveCheck.begin(runtime.ctrl.baseline?.mode ?? runtime.ctrl.forcedMode ?? 'full');
      break;
    case 'endMoveCheck':
      moveCheck.end();
      break;
    case 'startLaneSetup':
      lanes.begin();
      break;
    case 'endLaneSetup':
      lanes.end();
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- the run ledger

hud.setProfile(profile.profile, null);
applySkins();

/**
 * The run left without reaching the summary. Whatever the daily borrowed goes back: the seed, so
 * the rest of the session is not still running today's challenge track, and the arming, so the
 * next ordinary run is not quietly scored as an attempt at it.
 */
function abandonRun(): void {
  runs.abandonRun();
  runs.disarmDaily();
  game.options.seed = baseSeed;
  if (!sessionMeta) game.options.obstacles = playerObstacles();
}

/**
 * The boosts the run that is counting down was bought. `startRun` has already reset the power-ups
 * and the countdown does not tick them, so a magnet set here is running the moment play begins —
 * which is exactly what the shop card promises.
 */
function startBoosts(boosts: RunBoosts): void {
  if (boosts.magnet) game.powerups.activate('magnet');
}

/** The mission list on the summary card, rebuilt only when a run actually ends. */
function showSummary(missions: ReturnType<typeof runs.endRun>['missions']): void {
  if (missions.length) hud.summaryPanel.replaceChildren(renderMissionList(missions, { title: 'Missions' }));
  else hud.summaryPanel.replaceChildren();
}

/**
 * The run that just ended, banked exactly once — profile, wallet, missions and the daily, all
 * through the one hook the game gives us for "this run is over". A run abandoned with Home goes
 * to `menu` instead and never arrives here; a demo run arrives and is deliberately worth nothing.
 */
function recordRun(): void {
  const result = runs.endRun(
    { difficulty: game.options.difficulty, seed: game.options.seed, input: autopilot ? 'autopilot' : flow.input },
    game.caughtReason,
  );
  hud.setProfile(profile.profile, result.record);
  showSummary(result.missions);
  // The daily borrowed the seed and the obstacle settings; hand them back so the next ordinary run
  // gets a fresh track at the player's own settings.
  game.options.seed = baseSeed;
  if (!sessionMeta) game.options.obstacles = playerObstacles();
}

// ---------------------------------------------------------------- the intro cinematic

const intro = new IntroRunner({
  stage: world,
  seed,
  onCue: (cue, gain) => audio.intro(cue, gain),
  onEnd: () => {
    hud.setIntro(false);
    // Released here, so the countdown's first frame is the one right after the handover: the
    // camera never passes through the menu shot and nothing pops.
    loop.queueStart();
  },
});
const introPolicy = introMode(location.search);

/** The spec's rule, asked once per `startGame`: first run of a session, never in front of a bot. */
function wantsIntro(): boolean {
  return shouldPlayIntro({
    mode: introPolicy,
    autopilot: autopilotOn,
    replay: runtime.isReplay,
    keyboardTest: params.get('input') === 'keyboard',
    played: intro.played,
  });
}

const loop: AppLoop = new AppLoop({
  game,
  flow,
  keyboard,
  autopilot,
  pose: runtime,
  telemetry,
  onEffect,
  // The audio frame is one per fixed step, with exactly the events that step emitted.
  onStep: (stepSec, activity, events) => audio.update(stepSec, game, activity, events),
  holdStart: () => {
    if (!wantsIntro()) return false;
    hud.setIntro(true);
    intro.begin();
    return true;
  },
  onSkip: () => intro.skip(),
  onGameEvent: (e) => {
    if (e.type !== 'state') return;
    if (e.state === 'countdown') startBoosts(runs.beginRun());
    else if (e.state === 'summary') recordRun();
    else if (e.state === 'menu') abandonRun();
    runs.event(e);
  },
  // The same threshold the pose source pauses on, so the "camera stalled" toast and the pause
  // agree with each other rather than the toast arriving half a second early.
  stallMs: STALL_MS,
});

/**
 * "Run it" on the daily card. The challenge's own seed becomes this run's track — the seed the
 * Game adds its run counter to, so every player gets the same Bandra-to-Andheri today — and the
 * run is marked so the summary knows to score it against the goal.
 */
function startDaily(): void {
  if (!saveRuns) return;
  game.options.seed = runs.daily.challenge.seed - game.runsStarted;
  // The same track for everyone today, whatever their own obstacle settings.
  game.options.obstacles = { ...DEFAULT_OBSTACLES };
  runs.armDaily();
  setOverlay('none');
  loop.dispatch({ type: 'startPressed' });
}

// ---------------------------------------------------------------- Wander (free roam)
//
// A separate mode with its own scene, keys and overlay (src/wander/), entered from the menu. While
// it is up, `frame()` hands the whole frame to it: the game loop does not step, so there is no run,
// no inspector, no idle clock, and nothing reaches the profile, the missions or the wallet. The
// game stays in `menu`, exactly as it was, and Esc puts the menu back.

let wander: Wander | null = null;
let wanderLoading = false;
/** A camera start asked for with C is in flight until this time (ms). */
let wanderCameraUntil = 0;
const wanderSample: PoseSample = { running: false, tracking: false, calibrated: false, jogActive: false, msSinceStep: Infinity, cadenceSpm: 0, lane: 0 };

/** The pose pipeline as Wander reads it, or null while no camera is running (keys only). */
function wanderPose(): PoseSample | null {
  if (flow.input !== 'webcam' || !runtime.running) return null;
  const now = performance.now();
  const st = runtime.status();
  const act = runtime.commands.activity(now);
  const s = wanderSample;
  s.running = true;
  // No body in view, or no frame for a while: nothing to walk with.
  s.tracking = st.tracking && !act.lost;
  s.calibrated = st.calibrated;
  s.jogActive = st.jog.active && !act.lost;
  s.msSinceStep = act.msSinceStep;
  s.cadenceSpm = act.cadenceSpm;
  s.lane = st.lane;
  return s;
}

function wanderSkin(): { id: string; palette?: RunnerPalette } {
  const id = progression.state.unlocks.character;
  return { id, palette: shopItem(id)?.palette };
}

async function enterWander(): Promise<void> {
  if (wander?.active || wanderLoading) return;
  const free = () => flow.screen === 'menu' && game.state === 'menu' && overlay === 'none' && !intro.playing;
  if (!free()) return;
  wanderLoading = true;
  try {
    // The module (three.js scenery, the city plan, its overlay) is only fetched when it is wanted.
    const { Wander: WanderMode } = await import('./wander');
    if (!free()) return;
    wander ??= new WanderMode({
      renderer: world.renderer,
      seed: baseSeed,
      line: settings.line,
      skin: wanderSkin(),
      pose: wanderPose,
      canStartCamera: () => flow.input === 'webcam' && !runtime.running && !runtime.isReplay && performance.now() > wanderCameraUntil,
      startCamera: () => {
        wanderCameraUntil = performance.now() + 8000;
        openCamera(null);
      },
      onTrainPass: (closeness) => audio.trainPass(closeness),
      onExit: leaveWander,
    });
    wander.resize(window.innerWidth, window.innerHeight);
    wander.refresh({ line: settings.line, skin: wanderSkin() });
    audio.ui('click');
    // Its keys are its own: the game's keyboard (Enter would start a run) stays detached meanwhile.
    detachKeyboard?.();
    detachKeyboard = null;
    keyboard.drain();
    runtime.commands.drain();
    wander.enter();
  } catch (err) {
    console.warn('Wander failed to start:', err);
    detachKeyboard ??= keyboard.attach(window);
  } finally {
    wanderLoading = false;
  }
}

/** Wander was left: the menu's keyboard and camera are the game's again. */
function leaveWander(): void {
  audio.ui('back');
  detachKeyboard ??= keyboard.attach(window);
  keyboard.drain();
  runtime.commands.drain();
}

/** One frame of Wander: the body's commands are drained unread (it reads the body itself), the PiP stays up. */
function wanderFrame(now: number, dt: number): void {
  keyboard.drain();
  runtime.commands.drain();
  const webcam = flow.input === 'webcam';
  const pipOn = webcam && flow.cameraReady;
  pip.setActive(pipOn);
  pip.setLayout('corner');
  syncPipVideo(pipOn);
  if (pipOn) {
    const st = runtime.status();
    st.dark = runtime.dark(now);
    pip.update(st, isStalled(st.lastFrameT, now, STALL_MS), now, runtime.aspect);
  }
  if (!contextLost) wander!.frame(dt);
  const stats = wander!.stats;
  if (perf && stats && dt > 0) {
    fps += (1 / dt - fps) * 0.05;
    perf.textContent = `${fps.toFixed(0)} fps  ${stats.calls} calls  ${(stats.triangles / 1000).toFixed(1)}k tris  dpr ${stats.pixelRatio}\nwander  ${stats.chunks} chunks`;
  }
}

// ---------------------------------------------------------------- sound
//
// Nothing may be heard before a real user gesture: the browser insists, and a game that blares on
// load is obnoxious. A demo path (autopilot, a pose replay) never unlocks at all, so an automated
// check runs silent; `?audio` forces it on for a demo someone is actually watching.

const gesture = new GestureUnlock({
  target: window,
  enabled: soundAllowed({ autopilot: autopilotOn, replay: runtime.isReplay, search: location.search }),
  onUnlock: () => audio.unlock(),
  // Not merely "the graph exists": the raised hand that starts a run arrives on a pose frame with no user
  // activation, which builds a context the browser will not resume. Only a context that is really
  // running counts as unlocked; anything else and the next key or click gets another go.
  audible: () => audio.audible,
});

function toggleSound(): void {
  // Pressing mute is itself a gesture: a player who reaches for the speaker before touching
  // anything else should end up with sound, not with a muted graph that was never built.
  gesture.fire();
  audio.toggleMute();
  hud.setSound({ muted: audio.muted, ready: audio.audible });
  // Mute is reachable from three places at once. If the settings screen is open behind the key,
  // it has to be told, or its toggle argues with the game about which way round it is.
  if (overlay !== 'none') syncOverlays();
}

// N, because M opens the live monitor.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyN' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
  toggleSound();
});

// Any key and any click skip the cinematic, from frame one. (A raised hand goes through the
// loop's own `onSkip`, because a pose start never reaches the DOM.)
const skipIntro = (): void => intro.skip();
window.addEventListener('keydown', skipIntro, true);
window.addEventListener('pointerdown', skipIntro, true);

// Esc closes an overlay. The keyboard is detached under one, so this is the only way out by key.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || overlay === 'none') return;
  e.preventDefault();
  setOverlay('none');
});

Object.assign(window as unknown as Record<string, unknown>, {
  __game: game,
  __world: world,
  __profile: profile,
  __progression: progression,
  __runs: runs,
  __settings: settingsStore,
  __audio: audio,
  __intro: intro,
  __gesture: gesture,
  __flow: flow,
  __runtime: runtime,
  __moveCheck: moveCheck,
  __lanes: lanes,
  __loop: loop,
  __telemetry: telemetry,
  __overlay: (name: Overlay) => setOverlay(name),
  __wander: () => wander,
  __daily: () => startDaily(),
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
  wander?.resize(window.innerWidth, window.innerHeight);
}
resize();
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) loop.pauseGame();
});

// The GPU can drop the context (driver reset, too many tabs). preventDefault lets the browser
// restore it; three.js re-uploads its resources then, and the player resumes with Enter.
// The pause card says so: a black screen under an ordinary "Press Enter to resume" would invite
// the player to resume a run they cannot see. While the graphics are gone the run is held paused
// every frame (see frame()), so Enter cannot start it blind.
let contextLost = false;
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  contextLost = true;
  loop.pauseGame();
  hud.setPauseNotice('The graphics are restarting — hang on a moment');
  console.warn('WebGL context lost; game paused until it is restored.');
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  resize();
  hud.setPauseNotice('Graphics are back — press Enter to carry on');
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
  // A camera needs a secure context. Opened over a LAN address — which is the natural thing to do
  // from Windows against a WSL dev server — `navigator.mediaDevices` is simply undefined, and
  // "this browser cannot use a camera" sends the player hunting entirely the wrong problem.
  if (typeof isSecureContext === 'boolean' && !isSecureContext) {
    return fallBackToKeyboard(`A camera needs https or localhost — open the game at http://localhost${location.port ? `:${location.port}` : ''}`);
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

// ---------------------------------------------------------------- missions, per frame

/** A mission toast is worth two and a half seconds of the corner of the screen, and no more. */
const TOAST_MS = 2600;
let toastUntil = 0;
let boardKey = '';

function updateProgressionUi(now: number, dt: number): void {
  // The run feeds the tracker every frame; the board and the wallet only move at the summary.
  runs.frame(game, dt);
  const toast = runs.takeToast();
  if (toast) {
    hud.setMissionToast(renderMissionToast(toast));
    toastUntil = now + TOAST_MS;
  } else if (toastUntil && now > toastUntil) {
    hud.setMissionToast(null);
    toastUntil = 0;
  }

  // A demo (autopilot, replay) banks nothing, so it has no board to show: an empty mission panel
  // over someone else's recorded session would only be confusing.
  if (game.state !== 'menu' || !saveRuns) return;
  // The menu board: what this player can actually be asked to do, then what they are being asked.
  runs.setCapabilities({
    mode: currentMode(),
    tracksJogging: flow.input === 'webcam' ? flow.cameraReady : keyboard.jogEnabled,
    skipped: skippedMoves(),
  });
  const lvl = levelProgress(progression.state.lifetimeScore);
  const daily = saveRuns ? runs.daily : null;
  const key = `${JSON.stringify(runs.liveMissions())}|${lvl.level}|${lvl.frac}|${progression.balance}|${daily?.view.progressText ?? ''}|${daily?.view.done ?? ''}`;
  if (key === boardKey) return;
  boardKey = key;
  missionBoard.update({
    missions: runs.liveMissions(),
    daily: daily ? daily.view : null,
    level: { text: `LEVEL ${lvl.level}`, sub: `${fmtCoins(lvl.into)} / ${fmtCoins(lvl.span)} to level ${lvl.level + 1}`, frac: lvl.frac },
    coins: fmtCoins(progression.balance),
  });
}

/**
 * Moves the player gave up on in the check and never managed once, so the board never asks for a
 * jump from someone whose ceiling will not allow one. A move they *accepted at their best attempt*
 * has a peak and still counts as something they can do.
 */
function skippedMoves(): string[] {
  const mode = currentMode();
  if (!mode) return [];
  return moveCheck
    .controls(mode)
    .steps.filter((step) => step.status === 'skipped' && step.peak === null)
    .map((step) => step.id);
}

// ---------------------------------------------------------------- frame loop

let last = performance.now();
// On a 120 Hz screen the world would be drawn twice as often as the game steps, at twice the GPU
// cost, on the same iGPU the pose model runs on. ?fps=0 draws every refresh; ?scale=off keeps the
// render resolution fixed.
const fpsParam = Number(params.get('fps'));
const limiter = new FrameLimiter(params.has('fps') && Number.isFinite(fpsParam) ? (fpsParam > 0 ? 1000 / fpsParam - 3 : 0) : 13);
const renderScale = flagOn('scale') || !params.has('scale') ? new RenderScale() : null;
function frame(now: number): void {
  if (!limiter.accept(now)) {
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.max(0, (now - last) / 1000);
  last = now;
  const scaled = renderScale?.update(dt * 1000);
  if (scaled !== null && scaled !== undefined) world.setRenderScale(scaled);
  if (wander?.active) {
    wanderFrame(now, dt);
    requestAnimationFrame(frame);
    return;
  }
  // The cinematic is advanced *before* the game steps, so the frame it hands over on is the same
  // frame the countdown starts in — the camera goes straight from the intro's last pose to the
  // running pose with no menu shot in between.
  //
  // "The same frame" has to be true, not merely intended. `onEnd` queues the run, and only a game
  // step consumes it; the fixed stepper returns 0 steps whenever the accumulator has not filled,
  // which on a 120 Hz panel is most frames. On such a frame the world would render with the game
  // still in `menu` and `camReady` just cleared — a hard cut to the menu camera, then a slide
  // back. So the one frame the cinematic hands over on is guaranteed its step.
  const wasPlaying = intro.playing;
  const stillPlaying = intro.advance(dt, game);
  const handedOver = wasPlaying && !stillPlaying;
  const steps = Math.max(stepper.advance(dt), handedOver ? 1 : 0);
  loop.beginFrame();
  for (let i = 0; i < steps; i++) loop.step(stepper.stepSec, now);
  loop.endFrame(now);

  const m = flow.model;
  screens.update(m);
  const webcam = m.input === 'webcam';
  const st = loop.status;
  screens.setWarnings(webcam && flow.cameraReady && !!st?.slowPose, loop.stalled);
  const checking = m.screen === 'moveCheck';
  // A move check asked for from Settings before the camera was open: run it the moment the flow
  // has a calibration to measure against, rather than dropping the request on the floor.
  if (wantsMoveCheck && m.screen === 'ready') {
    wantsMoveCheck = false;
    loop.dispatch({ type: 'checkMoves' });
  } else if (wantsMoveCheck && (m.screen === 'menu' || m.screen === 'playing')) {
    wantsMoveCheck = false; // they went somewhere else; the request is stale
  }
  moveCheckLayer.update(checking ? moveCheck.model : null);
  const settingLanes = m.screen === 'laneSetup';
  laneLayer.update(settingLanes ? lanes.model : null);
  hud.setControls(game.state === 'paused' ? controlsCard() : null);
  // The check's scrim owns the screen: the PiP drops to its corner form (the player is copying the
  // figure, not watching themselves) and goes back to the big stage view afterwards.
  const setup = m.screen === 'calibrating' || m.screen === 'ready';
  // The cinematic owns the screen — the HUD clears every card for it, and the camera card is no
  // more exempt than they are. The flow reads `playing` throughout the intro, hence the guard.
  // The lane setup keeps the corner preview: seeing yourself helps you find your spot.
  const pipOn = webcam && flow.cameraReady && !intro.playing && (setup || checking || settingLanes || m.screen === 'playing');
  pip.setActive(pipOn);
  pip.setLayout(setup ? 'stage' : 'corner');
  syncPipVideo(pipOn);
  if (pipOn && st) pip.update(st, loop.stalled, now, runtime.aspect);
  // Tuning is per play mode: re-apply whenever the detected (or forced) mode changes.
  if (!replayingSession) moveCheck.applyFor(runtime.ctrl.baseline?.mode ?? runtime.ctrl.forcedMode ?? null);

  if (game.state === 'menu') {
    hud.setInputNotice(
      menuNotice({ input: m.input, cameraReady: flow.cameraReady, replay: runtime.replayName, autopilot: autopilotOn, fallback }),
    );
  }
  if (`${inputLabel()}|${currentMode()}` !== metaKey || runtime.ctrl.laneSpots !== metaSpots) sendMeta();

  updateProgressionUi(now, dt);
  hud.setSound({ muted: audio.muted, ready: audio.audible });

  // No graphics, no run: hold a live run paused until the context comes back. Once the player
  // has resumed after a restore, the notice has done its job.
  if (contextLost && (game.state === 'playing' || game.state === 'countdown')) loop.pauseGame();
  else if (!contextLost && game.state !== 'paused') hud.setPauseNotice(null);

  if (!contextLost) {
    // Asked *after* the step, not before it: the step is where a held `startGame` begins the
    // cinematic, and drawing the world on that one frame would put the game's own runner back on
    // screen beside the cinematic's kid for the rest of it.
    if (intro.playing) intro.draw();
    else world.render(game, dt, loop.frameEvents);
  }
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
// Fetch the pose model while the player reads the menu, so starting the camera is quick.
if (initialInput === 'webcam' && !replay) setTimeout(warmPoseAssets, 2500);
if (flagOn('wander')) void enterWander();
