/**
 * Visual harness for the settings and workout screens (not part of the build).
 * settings-harness.html?screen=settings|settings-keyboard|confirm|lanes|lanes-offer|lanes-small|workout|workout-empty|workout-oneday
 *
 * Everything is fixture data held in memory: no camera, no audio device, no game, no localStorage.
 * The stores are real, pointed at a fake storage, so a control that does not actually persist shows
 * up here as a control that does not move.
 */
import './hud.css';
import { ProfileStore, type Profile, type RunInput } from '../app/profile';
import { SettingsStore } from '../app/settings';
import { DEFAULT_SETTINGS as DEFAULT_AUDIO, type AudioSettings } from '../audio/types';
import { cameraOptions } from './poseScreens';
import { SettingsScreen, type SettingsView } from './settings';
import { WorkoutScreen, type WorkoutView } from './workout';

const SCREENS = [
  'settings',
  'settings-keyboard',
  'confirm',
  'lanes',
  'lanes-offer',
  'lanes-small',
  'workout',
  'workout-empty',
  'workout-oneday',
] as const;
type Screen = (typeof SCREENS)[number];

const params = new URLSearchParams(location.search);
const screen = (SCREENS as readonly string[]).includes(params.get('screen') ?? '') ? (params.get('screen') as Screen) : 'settings';
if (params.has('shot')) document.body.classList.add('shot');

const nav = document.getElementById('nav')!;
for (const s of SCREENS) {
  const a = document.createElement('a');
  a.href = `?screen=${s}`;
  a.textContent = s;
  nav.append(a);
}

// ---------------------------------------------------------------- fixtures

/** A storage that works but forgets: the harness must never touch the real profile. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const CAMS = [
  { deviceId: 'rgb', label: 'Integrated Camera' },
  { deviceId: 'usb', label: 'Logitech C920 HD Pro' },
];

/** `n` days ago, at the given local hour — the shape the day rollups actually key on. */
const daysAgo = (n: number, hour = 19): number => {
  const d = new Date();
  d.setHours(hour, 24, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
};

const run = (over: Partial<RunInput>): RunInput => ({
  at: daysAgo(0),
  score: 1200,
  coins: 40,
  distance: 480,
  timeSec: 150,
  jumps: 9,
  rolls: 5,
  laneChanges: 22,
  steps: 260,
  hoverboardsUsed: 1,
  caughtReason: 'chaser',
  difficulty: 'cardio',
  seed: 7,
  input: 'webcam',
  activeSeconds: 138,
  mode: 'full',
  ...over,
});

/** A player a fortnight in: a live streak, a missed day behind it, and a personal best. */
function populatedProfile(): Profile {
  const store = new ProfileStore(memoryStorage());
  // Oldest first, so "new best" lands on the runs that really were one.
  const days: [number, number][] = [
    [13, 1],
    [12, 2],
    // day 11 missed — the streak behind this one is broken on purpose
    [9, 1],
    [6, 2],
    [5, 1],
    [4, 1],
    [3, 2],
    [2, 1],
    [1, 2],
    [0, 1],
  ];
  let i = 0;
  for (const [ago, count] of days) {
    for (let k = 0; k < count; k++) {
      i++;
      // Scores wobble rather than climb: a "NEW BEST" badge on every row would mean nothing.
      const wobble = [0.62, 1.04, 0.71, 0.93, 1.18, 0.58, 0.88, 1.31, 0.75, 0.99, 0.67, 1.12, 0.84, 1.02][i % 14];
      store.recordRun(
        run({
          at: daysAgo(ago, 18 + k),
          score: Math.round((900 + i * 120) * wobble),
          coins: Math.round((18 + i * 4) * wobble),
          distance: Math.round((260 + i * 46) * wobble),
          timeSec: Math.round((150 + i * 14) * wobble),
          activeSeconds: Math.round((138 + i * 12) * wobble),
          steps: Math.round((240 + i * 22) * wobble),
          // A keyboard run has no play mode: nothing measured one, and `RunSession` records ''
          // rather than claiming otherwise. The harness is the oracle for this screen, so it must
          // not show a row the game cannot produce.
          ...(i % 7 === 0 ? { mode: '', input: 'keyboard' } : { mode: i % 4 === 0 ? 'small' : 'full', input: 'webcam' }),
        }),
      );
    }
  }
  return store.profile;
}

/** One run, today. The case where every "all time" number is also today's number. */
function oneDayProfile(): Profile {
  const store = new ProfileStore(memoryStorage());
  store.recordRun(run({ at: daysAgo(0, 8), score: 940, timeSec: 122, activeSeconds: 111, steps: 214, distance: 372, coins: 26 }));
  return store.profile;
}

// ---------------------------------------------------------------- main

const settingsStore = new SettingsStore(memoryStorage());
// `lanes`: spots recorded and in use. `lanes-offer`: none recorded, and My spots just picked.
if (screen === 'lanes') settingsStore.set({ lanes: 'spots' });
if (screen === 'lanes-small') settingsStore.set({ mode: 'small' });
const laneSpots = screen === 'lanes' || screen === 'lanes-small' ? { left: -0.62, centre: 0.04, right: 0.58 } : null;
let audio: AudioSettings = { ...DEFAULT_AUDIO };
let cameraId = 'usb';
const profile = screen === 'workout-empty' ? new ProfileStore(memoryStorage()).profile : screen === 'workout-oneday' ? oneDayProfile() : populatedProfile();

const log = (what: string, ...rest: unknown[]) => console.info(`[settings harness] ${what}`, ...rest);

const settings = new SettingsScreen(document.getElementById('settings')!, {
  change: (patch) => {
    settingsStore.set(patch);
    log('change', patch);
    render();
  },
  audioChange: (patch) => {
    audio = { ...audio, ...patch };
    log('audio', patch);
    render();
  },
  chooseCamera: (id) => {
    cameraId = id;
    log('camera', id);
    render();
  },
  redoMoveCheck: () => log('redo move check'),
  resetTuning: () => log('reset tuning'),
  setLaneSpots: () => log('set lane spots'),
  exportData: () => log('export data'),
  clearHistory: () => log('clear history'),
  openWorkout: () => log('open workout'),
  close: () => log('close'),
});

const workout = new WorkoutScreen(document.getElementById('workout')!, {
  startRun: () => log('start run'),
  openSettings: () => log('open settings'),
  close: () => log('close'),
});

function render(): void {
  const showSettings = !screen.startsWith('workout');
  const view: SettingsView = {
    open: showSettings,
    settings: settingsStore.get(),
    audio,
    cameras: cameraOptions(CAMS, cameraId),
    webcam: screen !== 'settings-keyboard',
    hasTuning: screen !== 'settings-keyboard',
    laneSpots,
    smallRoom: settingsStore.get().mode === 'small',
  };
  settings.update(view);
  const wView: WorkoutView = { open: !showSettings, profile, weightKg: settingsStore.get().weightKg };
  workout.update(wView);
}

render();

// The confirm dialog is a state of the screen, not a separate screen: drive it the way a player would.
if (screen === 'confirm') {
  const clear = Array.from(document.querySelectorAll<HTMLButtonElement>('.sw-btn')).find((b) => b.textContent === 'Clear my history');
  clear?.click();
}
if (screen === 'lanes-offer') {
  const chip = Array.from(document.querySelectorAll<HTMLButtonElement>('.sw-chip')).find((b) => b.textContent?.startsWith('My spots'));
  chip?.click();
}
// The Lanes controls sit low in the Movement card: bring them into the shot.
if (screen.startsWith('lanes')) document.querySelector('.sw-lanes-note')?.scrollIntoView({ block: 'center' });

void document.fonts.ready.then(() => {
  (window as unknown as { __ready: boolean }).__ready = true;
});
