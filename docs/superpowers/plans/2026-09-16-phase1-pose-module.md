# Subway IRL — Phase 1: Scaffold + Pose Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the project and build the complete, tested `pose/` module (calibration, jog, lane/jump/roll detection in both modes, gestures), plus a pose debug page with live camera, replay and fixture recording.

**Architecture:** Pure-TypeScript detectors consume `PoseFrame`s (mirrored, normalized MediaPipe landmarks) and emit `PoseEvent`s plus a `PoseStatus`. They know nothing about the camera. `LivePoseSource` runs MediaPipe (in a Web Worker if possible, with a fallback chain). `ReplayPoseSource` plays recorded JSON fixtures. All detection logic is unit-tested with synthetic pose sequences.

**Tech Stack:** Vite 8, TypeScript (strict), `@mediapipe/tasks-vision` 1.0.1, Vitest, tsx (scripts only).

**Spec:** `docs/superpowers/specs/2026-09-16-subway-irl-design.md` (sections 3, 4, 8, 9)

## Global Constraints

- Coordinates: landmark `x` is mirrored (`x = 1 - raw.x`) so the player's left is screen-left. `Body` measurements are in "height units": `x * aspect`, `y` unchanged, where image y points down.
- Thresholds live only in `src/pose/thresholds.ts`. Magnitude thresholds are divided by `sensitivity` (0.75–1.25). Time thresholds are not.
- `pose/` must not import anything from `game/`, `world/` or `ui/`.
- Camera request: 640×480 at 30 fps. Pose model: Full, `numPoses: 2`, `runningMode: 'VIDEO'`. Cameras whose label matches `/\bIR\b|infrared/i` are skipped by default.
- MediaPipe wasm and models are served from `public/mediapipe/` (gitignored, created by `scripts/fetch-mediapipe.mjs`).
- Never use Playwright. Visual checks use `shoot <url> <out.png> [readyExpr] [settleMs]`, and each PNG must be opened with the Read tool.
- Commit after every task. Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Map

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `index.html` | Scaffold |
| `scripts/fetch-mediapipe.mjs` | Copy wasm and download models into `public/mediapipe/` |
| `src/pose/types.ts` | Shared pose types and events |
| `src/pose/thresholds.ts` | All tunable detection constants |
| `src/pose/landmarks.ts` | Landmark indices, `toBody()` measurements |
| `src/pose/oneEuro.ts` | One Euro filter and `PoseSmoother` |
| `src/pose/signals.ts` | `TimeWindow`, `BobTracker`, `JumpDetector`, `DropDetector`, `VerticalRef` |
| `src/pose/calibration.ts` | `Calibrator`, `Baseline`, `driftBaseline` |
| `src/pose/jog.ts` | `JogDetector` (steps, cadence, time since last step) |
| `src/pose/moves.ts` | `nextLane`, `FullBodyMoves`, `SmallRoomMoves` |
| `src/pose/gestures.ts` | `GestureDetector` (hoverboard, start hold) |
| `src/pose/controller.ts` | `PoseController`: glues everything together, handles player lock and lost/found |
| `src/pose/fixtures.ts` | Fixture encode/decode, `FixtureRecorder` |
| `src/pose/camera.ts` | Camera listing, picking, opening, error text |
| `src/pose/mirror.ts` | MediaPipe result → mirrored `Pose[]` |
| `src/pose/landmarker.ts` | `createLandmarker()` |
| `src/pose/pose.worker.ts` | Worker that runs the landmarker |
| `src/pose/poseSource.ts` | `PoseSource` interface |
| `src/pose/liveSource.ts` | Camera → landmarker, with fallback chain and slow-speed downgrade |
| `src/pose/replaySource.ts` | Fixture playback |
| `debug.html`, `src/debug/main.ts`, `src/debug/overlay.ts`, `src/debug/debug.css` | Pose debug page |
| `tests/helpers/synth.ts` | Synthetic pose generator and scenario runner |
| `tests/helpers/baseline.ts` | `baselineFor()` helper |
| `scripts/make-synth-fixtures.ts` | Writes demo fixtures for replay |
| `tests/pose/*.test.ts` | Unit and scenario tests |

---

### Task 1: Scaffold, types, thresholds, body measurements

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `index.html`, `scripts/fetch-mediapipe.mjs`
- Create: `src/pose/types.ts`, `src/pose/thresholds.ts`, `src/pose/landmarks.ts`
- Create: `tests/helpers/synth.ts`
- Test: `tests/pose/landmarks.test.ts`

**Interfaces:**
- Produces:
  - Types: `Landmark`, `Pose`, `PoseFrame`, `PlayMode`, `Lane`, `PoseEvent`, `JogStatus`, `DistanceHint`, `CalibrationState`, `PoseStatus`
  - Thresholds: `DEFAULT_THRESHOLDS`, `Thresholds`
  - Landmarks: `LM`, `TRACKED_INDICES`, `VISIBLE`, `Vec2`, `Body`, `toBody(pose, aspect)`, `dist(a,b)`
  - Test helpers: `ASPECT`, `STAND`, `SynthParams`, `synthPose()`, `Scenario`, `ramp()`, `jumpArc()`, `jogParams()`

- [ ] **Step 1: Initialise the package and install dependencies**

```bash
cd /home/yash/Projects/SSRealLife
npm init -y
npm install @mediapipe/tasks-vision@1.0.1
npm install -D vite typescript vitest tsx @types/node
```

Then replace the generated `package.json` fields `name`, `type`, `scripts` so the file reads (keep the dependency versions npm wrote):

```json
{
  "name": "subway-irl",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "predev": "node scripts/fetch-mediapipe.mjs",
    "dev": "vite",
    "prebuild": "node scripts/fetch-mediapipe.mjs",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "fixtures:synth": "tsx scripts/make-synth-fixtures.ts"
  }
}
```

If `npx tsc --version` fails, or TypeScript 7 rejects the config below, install `typescript@5` instead.

- [ ] **Step 2: Write the config files**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src", "tests", "scripts/**/*.ts", "vite.config.ts", "vitest.config.ts"]
}
```

`vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        debug: resolve(import.meta.dirname, 'debug.html'),
      },
    },
  },
  worker: { format: 'es' },
});
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
```

`.gitignore`:
```
node_modules/
dist/
public/mediapipe/
*.log
```

`index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subway IRL</title>
  </head>
  <body>
    <p>Subway IRL — the game arrives in Phase 2. Open <a href="/debug.html">the pose debug page</a>.</p>
  </body>
</html>
```

The build input also lists `debug.html`, which Task 11 creates. Until then, only run `npm test` and `npm run typecheck`.

- [ ] **Step 3: Write `scripts/fetch-mediapipe.mjs`**

```js
import { access, cp, mkdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const outDir = new URL('public/mediapipe/', root);
const MODELS = {
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
};

const exists = (u) => access(u).then(() => true, () => false);

await mkdir(new URL('models/', outDir), { recursive: true });
await cp(new URL('node_modules/@mediapipe/tasks-vision/wasm/', root), new URL('wasm/', outDir), { recursive: true });

for (const [name, url] of Object.entries(MODELS)) {
  const dest = new URL(`models/${name}`, outDir);
  if (await exists(dest)) continue;
  console.log(`Downloading ${name}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${name}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
console.log('MediaPipe assets ready in public/mediapipe/');
```

Run: `node scripts/fetch-mediapipe.mjs && ls public/mediapipe/models public/mediapipe/wasm`
Expected: both `.task` files and the 6 wasm files are listed.

- [ ] **Step 4: Write `src/pose/types.ts`**

```ts
/** One MediaPipe landmark. x/y are normalized to the image (0..1) and already mirrored so the player's left is screen-left. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/** The 33 BlazePose landmarks of one person. */
export type Pose = Landmark[];

/** Output of one pose-model inference. `t` is in milliseconds; `aspect` is image width / height. */
export interface PoseFrame {
  t: number;
  aspect: number;
  poses: Pose[];
}

export type PlayMode = 'full' | 'small';
export type Lane = -1 | 0 | 1;

export type PoseEvent =
  | { type: 'lane'; lane: Lane }
  | { type: 'laneShift'; dir: -1 | 1 }
  | { type: 'jump' }
  | { type: 'roll' }
  | { type: 'hoverboard' }
  | { type: 'start' }
  | { type: 'lost' }
  | { type: 'found' };

export interface JogStatus {
  active: boolean;
  cadenceSpm: number;
  msSinceStep: number;
  steps: number;
}

export type DistanceHint = 'ok' | 'closer' | 'back';

export interface CalibrationState {
  progress: number;
  bodyVisible: boolean;
  distance: DistanceHint;
}

export interface PoseStatus {
  tracking: boolean;
  calibrated: boolean;
  mode: PlayMode | null;
  lane: Lane;
  poseFps: number;
  confidence: number;
  jog: JogStatus;
  startProgress: number;
  calibration: CalibrationState;
  pose: Pose | null;
}
```

- [ ] **Step 5: Write `src/pose/thresholds.ts`**

```ts
/**
 * Detection thresholds. Distances are in torso lengths (full-body mode) or shoulder widths
 * (small-room mode), angles in degrees, times in milliseconds. Magnitudes are divided by the
 * sensitivity setting, so sensitivity > 1 makes moves easier to trigger.
 */
export const DEFAULT_THRESHOLDS = {
  // full-body
  laneEnter: 0.5,
  laneExit: 0.35,
  jumpVel: 1.5,
  jumpRise: 0.15,
  jumpRearm: 0.08,
  rollDrop: 0.3,
  rollHoldMs: 100,
  rollHeadDrop: 0.4,
  kneeLift: 0.12,
  kneeRelease: 0.06,
  // small-room
  leanDeg: 15,
  leanRearmDeg: 7,
  noseShift: 0.35,
  noseRearm: 0.2,
  smallJumpVel: 1.2,
  smallJumpRise: 0.12,
  smallJumpRearm: 0.06,
  duckDrop: 0.3,
  wristPump: 0.15,
  // jogging (both modes)
  bobMinAmp: 0.03,
  bobJumpFactor: 2.5,
  bobMaxStepGapMs: 700,
  bobMaxSwing: 0.25,
  // gestures, tracking, calibration
  hoverHoldMs: 300,
  startHoldMs: 1500,
  lostMs: 1000,
  calibHoldMs: 2000,
  calibStill: 0.15,
  calibMinTorso: 0.1,
  driftSettle: 0.1,
};

export type Thresholds = typeof DEFAULT_THRESHOLDS;
```

- [ ] **Step 6: Write the synthetic pose helper `tests/helpers/synth.ts`**

```ts
import type { Landmark, Pose, PoseFrame } from '../../src/pose/types';
import { LM } from '../../src/pose/landmarks';

export const ASPECT = 4 / 3;

/** Body posture in "height units" (x already multiplied by aspect). */
export interface SynthParams {
  hipX: number;
  hipY: number;
  torso: number;
  tiltDeg: number;
  /** Knee lift in torso lengths. */
  kneeLiftL: number;
  kneeLiftR: number;
  arms: 'down' | 'both-up' | 'right-up' | 'pump';
  /** wristL.y - wristR.y in shoulder widths (arms: 'pump'). */
  pump: number;
  /** Extra head drop in torso lengths. */
  noseDrop: number;
  lowerVisible: boolean;
}

export const STAND: SynthParams = {
  hipX: 0.5 * ASPECT,
  hipY: 0.6,
  torso: 0.25,
  tiltDeg: 0,
  kneeLiftL: 0,
  kneeLiftR: 0,
  arms: 'down',
  pump: 0,
  noseDrop: 0,
  lowerVisible: true,
};

export function synthPose(params: Partial<SynthParams> = {}): Pose {
  const q = { ...STAND, ...params };
  const T = q.torso;
  const S = 0.8 * T;
  const a = (q.tiltDeg * Math.PI) / 180;
  const C = { x: q.hipX, y: q.hipY - T };
  const shL = { x: C.x - (Math.cos(a) * S) / 2, y: C.y - (Math.sin(a) * S) / 2 };
  const shR = { x: C.x + (Math.cos(a) * S) / 2, y: C.y + (Math.sin(a) * S) / 2 };
  const nose = { x: C.x + 0.45 * T * Math.sin(a), y: C.y - 0.45 * T * Math.cos(a) + q.noseDrop * T };
  const hipL = { x: q.hipX - 0.2 * T, y: q.hipY };
  const hipR = { x: q.hipX + 0.2 * T, y: q.hipY };
  const kneeL = { x: hipL.x, y: q.hipY + 0.9 * T - q.kneeLiftL * T };
  const kneeR = { x: hipR.x, y: q.hipY + 0.9 * T - q.kneeLiftR * T };
  const down = q.hipY + 0.05 * T;
  const up = C.y - 0.7 * T;
  let wLy = down;
  let wRy = down;
  if (q.arms === 'both-up') wLy = wRy = up;
  if (q.arms === 'right-up') wRy = up;
  if (q.arms === 'pump') {
    const mid = q.hipY - 0.3 * T;
    wLy = mid + (q.pump * S) / 2;
    wRy = mid - (q.pump * S) / 2;
  }
  const wL = { x: shL.x - 0.05 * T, y: wLy };
  const wR = { x: shR.x + 0.05 * T, y: wRy };

  const lm = (p: { x: number; y: number }, visibility = 0.95): Landmark => ({ x: p.x / ASPECT, y: p.y, z: 0, visibility });
  const pose: Pose = Array.from({ length: 33 }, () => lm(C, 0.9));
  pose[LM.NOSE] = lm(nose);
  pose[LM.L_SHOULDER] = lm(shL);
  pose[LM.R_SHOULDER] = lm(shR);
  pose[LM.L_WRIST] = lm(wL);
  pose[LM.R_WRIST] = lm(wR);
  pose[LM.L_HIP] = lm(hipL);
  pose[LM.R_HIP] = lm(hipR);
  pose[LM.L_KNEE] = lm(kneeL, q.lowerVisible ? 0.95 : 0.1);
  pose[LM.R_KNEE] = lm(kneeR, q.lowerVisible ? 0.95 : 0.1);
  return pose;
}

export const ramp = (t: number, dur: number) => Math.min(1, Math.max(0, t / dur));

/** Parabolic jump height (torso lengths) at time t of a jump lasting dur ms. */
export const jumpArc = (t: number, dur: number, height: number) =>
  t >= 0 && t < dur ? 4 * height * (t / dur) * (1 - t / dur) : 0;

export interface JogOptions {
  spm?: number;
  /** Hip bob amplitude in torso lengths. */
  bob?: number;
  small?: boolean;
  arms?: SynthParams['arms'];
  base?: Partial<SynthParams>;
}

/** Jogging in place: alternating knee lifts (full) or arm pumping (small) plus a vertical bob once per step. */
export function jogParams(t: number, o: JogOptions = {}): SynthParams {
  const spm = o.spm ?? 160;
  const bob = o.bob ?? 0.05;
  const base = { ...STAND, ...o.base };
  const stepMs = 60000 / spm;
  const s = Math.sin((2 * Math.PI * t) / (2 * stepMs));
  const hipY = base.hipY + bob * base.torso * Math.cos((2 * Math.PI * t) / stepMs);
  if (o.small) {
    return { ...base, lowerVisible: false, hipY, arms: o.arms ?? 'pump', pump: 0.5 * s };
  }
  return { ...base, hipY, kneeLiftL: Math.max(0, s) * 0.35, kneeLiftR: Math.max(0, -s) * 0.35, arms: o.arms ?? 'down' };
}

type Step = Partial<SynthParams> | Partial<SynthParams>[] | null;

/** Builds a continuous timeline of synthetic frames. */
export class Scenario {
  t = 0;
  readonly frames: PoseFrame[] = [];
  constructor(readonly fps = 30) {}

  add(durationMs: number, fn: (t: number) => Step): this {
    const dt = 1000 / this.fps;
    for (let local = 0; local < durationMs - 1e-6; local += dt) {
      const p = fn(local);
      const list = p === null ? [] : Array.isArray(p) ? p : [p];
      this.frames.push({ t: this.t + local, aspect: ASPECT, poses: list.map((x) => synthPose(x)) });
    }
    this.t += durationMs;
    return this;
  }

  hold(durationMs: number, p: Step = {}): this {
    return this.add(durationMs, () => p);
  }
}
```

- [ ] **Step 7: Write the failing test `tests/pose/landmarks.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { toBody } from '../../src/pose/landmarks';
import { ASPECT, STAND, synthPose } from '../helpers/synth';

describe('toBody', () => {
  it('measures a standing body in height units', () => {
    const b = toBody(synthPose(), ASPECT);
    expect(b.torso).toBeCloseTo(0.25, 3);
    expect(b.shoulderWidth).toBeCloseTo(0.2, 3);
    expect(b.hip.x).toBeCloseTo(STAND.hipX, 3);
    expect(b.hip.y).toBeCloseTo(0.6, 3);
    expect(b.tiltDeg).toBeCloseTo(0, 3);
    expect(b.lowerBodyVisible).toBe(true);
    expect(b.kneeL).not.toBeNull();
    expect(b.confidence).toBeGreaterThan(0.9);
  });

  it('reports a negative tilt when leaning to the player’s left', () => {
    expect(toBody(synthPose({ tiltDeg: -20 }), ASPECT).tiltDeg).toBeCloseTo(-20, 3);
  });

  it('drops knees when the lower body is hidden', () => {
    const b = toBody(synthPose({ lowerVisible: false }), ASPECT);
    expect(b.kneeL).toBeNull();
    expect(b.kneeR).toBeNull();
    expect(b.lowerBodyVisible).toBe(false);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npx vitest run tests/pose/landmarks.test.ts`
Expected: FAIL, because `src/pose/landmarks` cannot be resolved.

- [ ] **Step 9: Write `src/pose/landmarks.ts`**

```ts
import type { Landmark, Pose } from './types';

export const LM = {
  NOSE: 0,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
} as const;

export const TRACKED_INDICES: readonly number[] = Object.values(LM);
export const VISIBLE = 0.6;

export interface Vec2 {
  x: number;
  y: number;
}

/** Body measurements in height units: y is normalized image height, x is scaled by aspect so both axes match. */
export interface Body {
  nose: Vec2;
  shoulder: Vec2;
  hip: Vec2;
  shoulderL: Vec2;
  shoulderR: Vec2;
  wristL: Vec2;
  wristR: Vec2;
  kneeL: Vec2 | null;
  kneeR: Vec2 | null;
  torso: number;
  shoulderWidth: number;
  /** Shoulder-line angle in degrees; negative means leaning to the player's left. */
  tiltDeg: number;
  lowerBodyVisible: boolean;
  confidence: number;
}

export const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function toBody(pose: Pose, aspect: number): Body {
  const pt = (l: Landmark): Vec2 => ({ x: l.x * aspect, y: l.y });
  const vis = (i: number) => pose[i].visibility;
  const shoulderL = pt(pose[LM.L_SHOULDER]);
  const shoulderR = pt(pose[LM.R_SHOULDER]);
  const shoulder = mid(shoulderL, shoulderR);
  const hip = mid(pt(pose[LM.L_HIP]), pt(pose[LM.R_HIP]));
  const kneesVisible = vis(LM.L_KNEE) >= VISIBLE && vis(LM.R_KNEE) >= VISIBLE;
  const hipsVisible = vis(LM.L_HIP) >= VISIBLE && vis(LM.R_HIP) >= VISIBLE;
  const core = [LM.NOSE, LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP];
  return {
    nose: pt(pose[LM.NOSE]),
    shoulder,
    hip,
    shoulderL,
    shoulderR,
    wristL: pt(pose[LM.L_WRIST]),
    wristR: pt(pose[LM.R_WRIST]),
    kneeL: kneesVisible ? pt(pose[LM.L_KNEE]) : null,
    kneeR: kneesVisible ? pt(pose[LM.R_KNEE]) : null,
    torso: dist(shoulder, hip),
    shoulderWidth: dist(shoulderL, shoulderR),
    tiltDeg: (Math.atan2(shoulderR.y - shoulderL.y, shoulderR.x - shoulderL.x) * 180) / Math.PI,
    lowerBodyVisible: kneesVisible && hipsVisible,
    confidence: core.reduce((s, i) => s + vis(i), 0) / core.length,
  };
}
```

- [ ] **Step 10: Run the tests and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 3 tests pass. The type check reports no errors, apart from a missing `debug.html` path, which `tsc` does not check.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: scaffold project and pose body measurements"
```

---
### Task 2: One Euro filter and pose smoother

**Files:**
- Create: `src/pose/oneEuro.ts`
- Test: `tests/pose/oneEuro.test.ts`

**Interfaces:**
- Consumes: `Pose` (Task 1), `TRACKED_INDICES` (Task 1)
- Produces: `class OneEuroFilter(minCutoff = 1, beta = 0, dCutoff = 1)` with `filter(x, tMs): number` and `reset()`; `class PoseSmoother(minCutoff = 3, beta = 10)` with `smooth(pose, tMs): Pose` and `reset()`

- [ ] **Step 1: Write the failing test `tests/pose/oneEuro.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { OneEuroFilter, PoseSmoother } from '../../src/pose/oneEuro';
import { synthPose } from '../helpers/synth';

const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('OneEuroFilter', () => {
  it('passes the first value through and holds a constant signal', () => {
    const f = new OneEuroFilter();
    expect(f.filter(0.5, 0)).toBe(0.5);
    for (let i = 1; i < 30; i++) expect(f.filter(0.5, i * 33)).toBeCloseTo(0.5, 9);
  });

  it('reduces jitter', () => {
    const f = new OneEuroFilter(1, 0);
    const input: number[] = [];
    const output: number[] = [];
    for (let i = 0; i < 60; i++) {
      const x = 0.5 + (i % 2 ? 0.01 : -0.01);
      input.push(x);
      output.push(f.filter(x, i * 33.3));
    }
    expect(std(output.slice(10))).toBeLessThan(std(input) * 0.5);
  });

  it('follows a fast step change when beta is high', () => {
    const f = new OneEuroFilter(3, 10);
    f.filter(0, 0);
    let y = 0;
    for (let t = 33; t <= 500; t += 33) y = f.filter(1, t);
    expect(y).toBeGreaterThan(0.9);
  });
});

describe('PoseSmoother', () => {
  it('smooths tracked landmarks and leaves the input untouched', () => {
    const s = new PoseSmoother();
    const a = synthPose();
    const b = synthPose({ hipY: 0.7 });
    s.smooth(a, 0);
    const out = s.smooth(b, 33);
    expect(out[24].y).toBeGreaterThan(0.6);
    expect(out[24].y).toBeLessThan(0.7);
    expect(b[24].y).toBeCloseTo(0.7, 9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pose/oneEuro.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Write `src/pose/oneEuro.ts`**

```ts
import { TRACKED_INDICES } from './landmarks';
import type { Pose } from './types';

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);

/** One Euro filter (Casiez et al.): low lag on fast motion, strong smoothing when still. */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff = 1,
    private beta = 0,
    private dCutoff = 1,
  ) {}

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tMs: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.tPrev) / 1000, 1e-3);
    this.tPrev = tMs;
    const dx = (x - this.xPrev) / dt;
    const dxHat = alpha(this.dCutoff, dt) * dx + (1 - alpha(this.dCutoff, dt)) * this.dxPrev;
    const a = alpha(this.minCutoff + this.beta * Math.abs(dxHat), dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

/** Applies a One Euro filter to x and y of every landmark the detectors use. */
export class PoseSmoother {
  private filters = new Map<number, [OneEuroFilter, OneEuroFilter]>();

  constructor(
    private minCutoff = 3,
    private beta = 10,
  ) {}

  reset(): void {
    this.filters.clear();
  }

  smooth(pose: Pose, tMs: number): Pose {
    const out = pose.map((l) => ({ ...l }));
    for (const i of TRACKED_INDICES) {
      let f = this.filters.get(i);
      if (!f) {
        f = [new OneEuroFilter(this.minCutoff, this.beta), new OneEuroFilter(this.minCutoff, this.beta)];
        this.filters.set(i, f);
      }
      out[i].x = f[0].filter(pose[i].x, tMs);
      out[i].y = f[1].filter(pose[i].y, tMs);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pose/oneEuro.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pose/oneEuro.ts tests/pose/oneEuro.test.ts
git commit -m "feat(pose): add One Euro landmark smoothing"
```

---

### Task 3: Signal helpers

**Files:**
- Create: `src/pose/signals.ts`
- Test: `tests/pose/signals.test.ts`

**Interfaces:**
- Produces:
  - `class TimeWindow(spanMs)`: `push(t, v)`, `clear()`, `size`, `mean()` (NaN when empty), `max()` (-Infinity when empty), `min()` (Infinity when empty)
  - `class BobTracker`: `update(v, t, minAmp, maxGapMs, maxSwing): boolean` (true when a trough completes a step cycle), `amplitudeAt(t): number`, `reset()`. `v` is a height where bigger means higher. Hysteresis = `minAmp`; a counted swing must be ≥ `2*minAmp` and ≤ `maxSwing` (callers pass `th.bobMaxSwing`, unscaled by sensitivity — it is a sanity cap, not a trigger).
  - `class JumpDetector`: `update(v, ref, t, minVel, minRise, rearm): boolean`, `isArmed`, `reset()`
  - `interface DropThresholds { drop; holdMs; headDrop; rearmDrop; rearmHead }`
  - `class DropDetector`: `update(drop, headDrop, t, th: DropThresholds): boolean`, `isArmed`, `isDropping`, `reset()`
  - `class VerticalRef`: `value(v, t, staticRef, jogging, frozen): number`, `reset()`

- [ ] **Step 1: Write the failing test `tests/pose/signals.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { BobTracker, DropDetector, JumpDetector, TimeWindow, VerticalRef } from '../../src/pose/signals';

const DROP = { drop: 0.3, holdMs: 100, headDrop: 0.4, rearmDrop: 0.15, rearmHead: 0.2 };

describe('TimeWindow', () => {
  it('keeps only samples inside the span', () => {
    const w = new TimeWindow(100);
    w.push(0, 1);
    w.push(50, 3);
    w.push(120, 5);
    expect(w.size).toBe(2);
    expect(w.mean()).toBe(4);
    expect(w.max()).toBe(5);
    expect(w.min()).toBe(3);
  });

  it('reports sentinel values when empty', () => {
    const w = new TimeWindow(100);
    expect(w.mean()).toBeNaN();
    expect(w.max()).toBe(-Infinity);
  });
});

describe('BobTracker', () => {
  const run = (amp: number, ms: number) => {
    const b = new BobTracker();
    let steps = 0;
    for (let t = 0; t < ms; t += 1000 / 30) {
      if (b.update(-amp * Math.cos((2 * Math.PI * t) / 375), t, 0.03, 700, 0.25)) steps++;
    }
    return { b, steps };
  };

  it('counts one step per bob cycle and measures amplitude', () => {
    const { b, steps } = run(0.05, 3000);
    expect(steps).toBeGreaterThanOrEqual(5);
    expect(steps).toBeLessThanOrEqual(7);
    expect(b.amplitudeAt(3000)).toBeCloseTo(0.05, 2);
    expect(b.amplitudeAt(5000)).toBe(0);
  });

  it('ignores bobs that are too small or too large', () => {
    expect(run(0.02, 3000).steps).toBe(0);
    const big = run(0.3, 3000);
    expect(big.steps).toBe(0);
    expect(big.b.amplitudeAt(3000)).toBe(0);
  });
});

describe('JumpDetector', () => {
  it('fires once on a fast rise and re-arms after landing', () => {
    const j = new JumpDetector();
    const fire: number[] = [];
    const heights = [0, 0, 0.1, 0.25, 0.3, 0.25, 0.1, 0, 0, 0.1, 0.25, 0.3];
    heights.forEach((v, i) => {
      if (j.update(v, 0, i * 33, 1.5, 0.15, 0.08)) fire.push(i);
    });
    expect(fire).toEqual([3, 10]);
  });

  it('ignores slow rises', () => {
    const j = new JumpDetector();
    let fired = false;
    for (let i = 0; i < 60; i++) fired ||= j.update(i * 0.005, 0, i * 33, 1.5, 0.15, 0.08);
    expect(fired).toBe(false);
  });
});

describe('DropDetector', () => {
  it('needs the drop held for holdMs and fires once', () => {
    const d = new DropDetector();
    expect(d.update(0.4, 0, 0, DROP)).toBe(false);
    expect(d.isDropping).toBe(true);
    expect(d.update(0.4, 0, 60, DROP)).toBe(false);
    expect(d.update(0.4, 0, 110, DROP)).toBe(true);
    expect(d.update(0.4, 0, 200, DROP)).toBe(false);
    expect(d.update(0, 0, 300, DROP)).toBe(false);
    expect(d.isArmed).toBe(true);
  });

  it('cancels a short dip', () => {
    const d = new DropDetector();
    d.update(0.4, 0, 0, DROP);
    d.update(0.1, 0, 50, DROP);
    expect(d.update(0.4, 0, 120, DROP)).toBe(false);
  });

  it('fires immediately on a head drop', () => {
    expect(new DropDetector().update(0, 0.5, 0, DROP)).toBe(true);
  });
});

describe('VerticalRef', () => {
  it('uses the static reference unless jogging', () => {
    const r = new VerticalRef();
    expect(r.value(1, 0, 5, false, false)).toBe(5);
    r.value(3, 10, 5, false, false);
    expect(r.value(2, 20, 5, true, false)).toBe(2);
    expect(r.value(100, 30, 5, true, true)).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pose/signals.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Write `src/pose/signals.ts`**

```ts
/** Keeps (t, v) samples that fall inside a trailing time window. */
export class TimeWindow {
  private s: { t: number; v: number }[] = [];

  constructor(private spanMs: number) {}

  push(t: number, v: number): void {
    this.s.push({ t, v });
    while (this.s.length && t - this.s[0].t > this.spanMs) this.s.shift();
  }

  clear(): void {
    this.s = [];
  }

  get size(): number {
    return this.s.length;
  }

  mean(): number {
    return this.s.length ? this.s.reduce((a, x) => a + x.v, 0) / this.s.length : Number.NaN;
  }

  max(): number {
    let m = -Infinity;
    for (const x of this.s) if (x.v > m) m = x.v;
    return m;
  }

  min(): number {
    let m = Infinity;
    for (const x of this.s) if (x.v < m) m = x.v;
    return m;
  }
}

/** Follows the up/down bounce of a height signal and reports one step per bounce cycle. */
export class BobTracker {
  private dir: 'up' | 'down' = 'up';
  private ext = Number.NaN;
  private extT = 0;
  private lastPeak = Number.NaN;
  private lastTroughT = -Infinity;
  private swings: number[] = [];

  reset(): void {
    this.dir = 'up';
    this.ext = Number.NaN;
    this.lastPeak = Number.NaN;
    this.lastTroughT = -Infinity;
    this.swings = [];
  }

  /** Typical bounce amplitude (half the peak-to-trough swing); 0 once bouncing has stopped. */
  amplitudeAt(t: number): number {
    if (!this.swings.length || t - this.lastTroughT > 1000) return 0;
    return this.swings.reduce((a, b) => a + b, 0) / this.swings.length / 2;
  }

  update(v: number, t: number, minAmp: number, maxGapMs: number, maxSwing: number): boolean {
    if (Number.isNaN(this.ext)) {
      this.ext = v;
      this.extT = t;
      return false;
    }
    if (this.dir === 'up') {
      if (v > this.ext) {
        this.ext = v;
        this.extT = t;
      } else if (v < this.ext - minAmp) {
        this.lastPeak = this.ext;
        this.dir = 'down';
        this.ext = v;
        this.extT = t;
      }
      return false;
    }
    if (v < this.ext) {
      this.ext = v;
      this.extT = t;
      return false;
    }
    if (v <= this.ext + minAmp) return false;

    const troughT = this.extT;
    const swing = this.lastPeak - this.ext;
    this.dir = 'up';
    this.ext = v;
    this.extT = t;
    if (swing < 2 * minAmp || swing > maxSwing) return false;
    const gap = troughT - this.lastTroughT;
    this.lastTroughT = troughT;
    if (gap > maxGapMs) return false;
    this.swings.push(swing);
    if (this.swings.length > 4) this.swings.shift();
    return true;
  }
}

/** Fires when a height rises fast and far enough above its reference; re-arms after coming back down. */
export class JumpDetector {
  private armed = true;
  private prev: { t: number; v: number } | null = null;
  private vel = new TimeWindow(200);

  get isArmed(): boolean {
    return this.armed;
  }

  reset(): void {
    this.armed = true;
    this.prev = null;
    this.vel.clear();
  }

  update(v: number, ref: number, t: number, minVel: number, minRise: number, rearm: number): boolean {
    if (this.prev && t > this.prev.t) this.vel.push(t, (v - this.prev.v) / ((t - this.prev.t) / 1000));
    this.prev = { t, v };
    const rise = v - ref;
    if (!this.armed) {
      if (rise < rearm) this.armed = true;
      return false;
    }
    if (rise > minRise && this.vel.max() > minVel) {
      this.armed = false;
      return true;
    }
    return false;
  }
}

export interface DropThresholds {
  drop: number;
  holdMs: number;
  headDrop: number;
  rearmDrop: number;
  rearmHead: number;
}

/** Fires on a body drop held for holdMs, or immediately on a large head drop. */
export class DropDetector {
  private armed = true;
  private since: number | null = null;

  get isArmed(): boolean {
    return this.armed;
  }

  get isDropping(): boolean {
    return this.since !== null;
  }

  reset(): void {
    this.armed = true;
    this.since = null;
  }

  update(drop: number, headDrop: number, t: number, th: DropThresholds): boolean {
    if (!this.armed) {
      if (drop < th.rearmDrop && headDrop < th.rearmHead) this.armed = true;
      return false;
    }
    if (headDrop > th.headDrop) return this.fire();
    if (drop > th.drop) {
      this.since ??= t;
      if (t - this.since >= th.holdMs) return this.fire();
    } else {
      this.since = null;
    }
    return false;
  }

  private fire(): true {
    this.armed = false;
    this.since = null;
    return true;
  }
}

/** Resting height: the calibrated value when still, the 1 s average while jogging. */
export class VerticalRef {
  private win = new TimeWindow(1000);

  reset(): void {
    this.win.clear();
  }

  value(v: number, t: number, staticRef: number, jogging: boolean, frozen: boolean): number {
    if (!frozen) this.win.push(t, v);
    return jogging && this.win.size > 0 ? this.win.mean() : staticRef;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pose/signals.test.ts`
Expected: all tests pass. If the JumpDetector index expectation is off by one frame, check the velocity window maths before touching the expectation: sample 3 has rise 0.25 > 0.15 and velocity (0.15/0.033 s) ≈ 4.5 > 1.5.

- [ ] **Step 5: Commit**

```bash
git add src/pose/signals.ts tests/pose/signals.test.ts
git commit -m "feat(pose): add signal helpers for bob, jump and drop detection"
```

---
### Task 4: Calibration

**Files:**
- Create: `src/pose/calibration.ts`, `tests/helpers/baseline.ts`
- Test: `tests/pose/calibration.test.ts`

**Interfaces:**
- Consumes: `Body`, `toBody`, `dist`, `VISIBLE` (Task 1); `Thresholds` (Task 1); `PlayMode`, `CalibrationState`, `DistanceHint` (Task 1)
- Produces:
  - `interface Baseline { hip: Vec2; shoulder: Vec2; nose: Vec2; kneeRelL: number | null; kneeRelR: number | null; torso: number; shoulderWidth: number; mode: PlayMode }`. `kneeRel` is `knee.y - hip.y` while standing.
  - `class Calibrator(th)`: `state: CalibrationState`, `update(body | null, t, forcedMode | null): Baseline | null`, `reset()`
  - `driftBaseline(base, body, dtMs, tauMs = 3000): void`, which mutates only the vertical values and the scale (never x)
  - Test helper `baselineFor(params?, mode?): Baseline`

- [ ] **Step 1: Write the helper `tests/helpers/baseline.ts`**

```ts
import { Calibrator, type Baseline } from '../../src/pose/calibration';
import { toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { PlayMode } from '../../src/pose/types';
import { ASPECT, synthPose, type SynthParams } from './synth';

export function baselineFor(params: Partial<SynthParams> = {}, mode: PlayMode | null = null): Baseline {
  const cal = new Calibrator(DEFAULT_THRESHOLDS);
  for (let t = 0; t < 2500; t += 1000 / 30) {
    const b = cal.update(toBody(synthPose(params), ASPECT), t, mode);
    if (b) return b;
  }
  throw new Error('synthetic body did not calibrate');
}
```

- [ ] **Step 2: Write the failing test `tests/pose/calibration.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { Calibrator, driftBaseline, type Baseline } from '../../src/pose/calibration';
import { toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { PlayMode } from '../../src/pose/types';
import { baselineFor } from '../helpers/baseline';
import { ASPECT, STAND, synthPose, type SynthParams } from '../helpers/synth';

function feed(cal: Calibrator, fromMs: number, toMs: number, p: Partial<SynthParams>, mode: PlayMode | null = null) {
  let out: Baseline | null = null;
  for (let t = fromMs; t < toMs; t += 1000 / 30) out = cal.update(toBody(synthPose(p), ASPECT), t, mode) ?? out;
  return out;
}

describe('Calibrator', () => {
  it('needs 2 s of standing still', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    expect(feed(cal, 0, 1900, {})).toBeNull();
    expect(cal.state.progress).toBeGreaterThan(0.9);
    const base = feed(cal, 1900, 2100, {});
    expect(base).not.toBeNull();
    expect(base!.mode).toBe('full');
    expect(base!.torso).toBeCloseTo(0.25, 3);
    expect(base!.hip.y).toBeCloseTo(0.6, 3);
    expect(base!.kneeRelL).toBeCloseTo(0.225, 3);
  });

  it('restarts the timer when the player moves', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    feed(cal, 0, 1000, {});
    expect(feed(cal, 1000, 2500, { hipX: STAND.hipX + 0.1 })).toBeNull();
  });

  it('picks small-room mode when the lower body is hidden', () => {
    const base = baselineFor({ lowerVisible: false });
    expect(base.mode).toBe('small');
    expect(base.kneeRelL).toBeNull();
  });

  it('respects a forced mode', () => {
    expect(baselineFor({}, 'small').mode).toBe('small');
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    expect(feed(cal, 0, 2500, { lowerVisible: false }, 'full')).toBeNull();
    expect(cal.state.distance).toBe('back');
  });

  it('asks a far-away player to come closer', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    expect(feed(cal, 0, 2500, { torso: 0.08 })).toBeNull();
    expect(cal.state.distance).toBe('closer');
  });

  it('resets progress when the body disappears', () => {
    const cal = new Calibrator(DEFAULT_THRESHOLDS);
    feed(cal, 0, 1000, {});
    cal.update(null, 1033, null);
    expect(cal.state).toEqual({ progress: 0, bodyVisible: false, distance: 'ok' });
  });
});

describe('driftBaseline', () => {
  it('eases vertical values toward the current body but never x', () => {
    const base = baselineFor();
    const body = toBody(synthPose({ hipY: 0.62, hipX: STAND.hipX + 0.05 }), ASPECT);
    for (let i = 0; i < 90; i++) driftBaseline(base, body, 1000 / 30);
    expect(base.hip.y).toBeGreaterThan(0.61);
    expect(base.hip.y).toBeLessThan(0.62);
    expect(base.hip.x).toBeCloseTo(STAND.hipX, 6);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/pose/calibration.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 4: Write `src/pose/calibration.ts`**

```ts
import { dist, VISIBLE, type Body, type Vec2 } from './landmarks';
import type { Thresholds } from './thresholds';
import type { CalibrationState, DistanceHint, PlayMode } from './types';

export interface Baseline {
  hip: Vec2;
  shoulder: Vec2;
  nose: Vec2;
  /** knee.y - hip.y while standing; null when knees were not visible. */
  kneeRelL: number | null;
  kneeRelR: number | null;
  torso: number;
  shoulderWidth: number;
  mode: PlayMode;
}

const IDLE: CalibrationState = { progress: 0, bodyVisible: false, distance: 'ok' };

function average(bodies: Body[], f: (b: Body) => number | null): number | null {
  const xs = bodies.map(f).filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Records the player's resting posture after they hold still for calibHoldMs. */
export class Calibrator {
  state: CalibrationState = { ...IDLE };
  private samples: { t: number; body: Body }[] = [];

  constructor(private th: Thresholds) {}

  reset(): void {
    this.samples = [];
    this.state = { ...IDLE };
  }

  update(body: Body | null, t: number, forcedMode: PlayMode | null): Baseline | null {
    if (!body || body.confidence < VISIBLE) {
      this.reset();
      return null;
    }
    const distance: DistanceHint =
      body.torso < this.th.calibMinTorso ? 'closer' : forcedMode === 'full' && !body.lowerBodyVisible ? 'back' : 'ok';
    if (distance !== 'ok') {
      this.samples = [];
      this.state = { progress: 0, bodyVisible: true, distance };
      return null;
    }

    const first = this.samples[0];
    if (first && dist(first.body.hip, body.hip) > this.th.calibStill * body.torso) this.samples = [];
    this.samples.push({ t, body });
    const span = t - this.samples[0].t;
    this.state = { progress: Math.min(1, span / this.th.calibHoldMs), bodyVisible: true, distance };
    if (span < this.th.calibHoldMs) return null;

    const bodies = this.samples.map((s) => s.body);
    const avg = (f: (b: Body) => number) => average(bodies, f)!;
    const lower = bodies.filter((b) => b.lowerBodyVisible).length > bodies.length / 2;
    const mode: PlayMode = forcedMode ?? (lower ? 'full' : 'small');
    const baseline: Baseline = {
      hip: { x: avg((b) => b.hip.x), y: avg((b) => b.hip.y) },
      shoulder: { x: avg((b) => b.shoulder.x), y: avg((b) => b.shoulder.y) },
      nose: { x: avg((b) => b.nose.x), y: avg((b) => b.nose.y) },
      kneeRelL: lower ? average(bodies, (b) => (b.kneeL ? b.kneeL.y - b.hip.y : null)) : null,
      kneeRelR: lower ? average(bodies, (b) => (b.kneeR ? b.kneeR.y - b.hip.y : null)) : null,
      torso: avg((b) => b.torso),
      shoulderWidth: avg((b) => b.shoulderWidth),
      mode,
    };
    this.reset();
    return baseline;
  }
}

/** Slowly follows posture changes (standing taller, stepping nearer) while the player is still. Never moves x. */
export function driftBaseline(base: Baseline, body: Body, dtMs: number, tauMs = 3000): void {
  const a = 1 - Math.exp(-dtMs / tauMs);
  const lerp = (p: number, q: number) => p + (q - p) * a;
  base.hip.y = lerp(base.hip.y, body.hip.y);
  base.shoulder.y = lerp(base.shoulder.y, body.shoulder.y);
  base.nose.y = lerp(base.nose.y, body.nose.y);
  base.torso = lerp(base.torso, body.torso);
  base.shoulderWidth = lerp(base.shoulderWidth, body.shoulderWidth);
  if (body.kneeL && base.kneeRelL !== null) base.kneeRelL = lerp(base.kneeRelL, body.kneeL.y - body.hip.y);
  if (body.kneeR && base.kneeRelR !== null) base.kneeRelR = lerp(base.kneeRelR, body.kneeR.y - body.hip.y);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/pose/calibration.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/pose/calibration.ts tests/helpers/baseline.ts tests/pose/calibration.test.ts
git commit -m "feat(pose): add calibration and baseline drift"
```

---

### Task 5: Jog detection

**Files:**
- Create: `src/pose/jog.ts`
- Test: `tests/pose/jog.test.ts`

**Interfaces:**
- Consumes: `Body` (Task 1), `Baseline` (Task 4), `BobTracker` (Task 3), `Thresholds`, `JogStatus` (Task 1)
- Produces: `class JogDetector(th)` with:
  - `readonly bob: BobTracker`
  - `update(body, base, t, sens): boolean` (true when a step was counted)
  - `status(t): JogStatus`
  - `reset()`

  Step sources:
  - **Full-body mode:** alternating knee lifts are the primary source; the hip bob is the fallback.
  - **Small-room mode:** alternating wrist pumps are the primary source; the shoulder bob is the fallback.
  - The fallback only counts when the primary source has been silent for more than 1000 ms.
  - Steps closer than 180 ms apart are merged.

- [ ] **Step 1: Write the failing test `tests/pose/jog.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { JogDetector } from '../../src/pose/jog';
import { toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import { baselineFor } from '../helpers/baseline';
import { ASPECT, jogParams, synthPose, type JogOptions, type SynthParams } from '../helpers/synth';

function jog(opts: JogOptions, ms: number, calib: Partial<SynthParams> = {}) {
  const base = baselineFor(calib);
  const d = new JogDetector(DEFAULT_THRESHOLDS);
  for (let t = 0; t < ms; t += 1000 / 30) d.update(toBody(synthPose(jogParams(t, opts)), ASPECT), base, t, 1);
  return d;
}

describe('JogDetector', () => {
  it('counts alternating knee lifts at the right cadence', () => {
    const s = jog({}, 5000).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(12);
    expect(s.steps).toBeLessThanOrEqual(15);
    expect(s.cadenceSpm).toBeGreaterThan(145);
    expect(s.cadenceSpm).toBeLessThan(175);
    expect(s.active).toBe(true);
  });

  it('goes inactive a second after the last step', () => {
    const s = jog({}, 5000).status(6200);
    expect(s.active).toBe(false);
    expect(s.msSinceStep).toBeGreaterThan(1000);
    expect(s.cadenceSpm).toBe(0);
  });

  it('counts only one step when the same knee lifts repeatedly', () => {
    const base = baselineFor();
    const d = new JogDetector(DEFAULT_THRESHOLDS);
    for (let t = 0; t < 3000; t += 1000 / 30) {
      const lift = Math.max(0, Math.sin((2 * Math.PI * t) / 375)) * 0.35;
      d.update(toBody(synthPose({ kneeLiftL: lift }), ASPECT), base, t, 1);
    }
    expect(d.status(3000).steps).toBe(1);
  });

  it('falls back to the hip bob when knees are hidden', () => {
    const s = jog({ bob: 0.06, base: { lowerVisible: false } }, 5000).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(10);
  });

  it('counts arm pumping in small-room mode', () => {
    const s = jog({ small: true, bob: 0 }, 5000, { lowerVisible: false }).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(12);
    expect(s.steps).toBeLessThanOrEqual(15);
  });

  it('counts the shoulder bob in small-room mode with arms down', () => {
    const s = jog({ small: true, arms: 'down', bob: 0.08 }, 5000, { lowerVisible: false }).status(5000);
    expect(s.steps).toBeGreaterThanOrEqual(10);
  });

  it('reports nothing before the first step', () => {
    const s = new JogDetector(DEFAULT_THRESHOLDS).status(1000);
    expect(s).toEqual({ active: false, cadenceSpm: 0, msSinceStep: Infinity, steps: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pose/jog.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Write `src/pose/jog.ts`**

```ts
import type { Baseline } from './calibration';
import type { Body } from './landmarks';
import { BobTracker } from './signals';
import type { Thresholds } from './thresholds';
import type { JogStatus } from './types';

const MIN_STEP_GAP_MS = 180;
const FALLBACK_AFTER_MS = 1000;
const ACTIVE_MS = 1000;

/** Detects jogging in place and reports steps, cadence and time since the last step. */
export class JogDetector {
  readonly bob = new BobTracker();
  private total = 0;
  private stepTimes: number[] = [];
  private lastStepT = -Infinity;
  private lastPrimaryT = -Infinity;
  private kneeUp = { L: false, R: false };
  private lastKnee: 'L' | 'R' | null = null;
  private wristSide: -1 | 0 | 1 = 0;
  private wristSideT = -Infinity;

  constructor(private th: Thresholds) {}

  reset(): void {
    this.bob.reset();
    this.total = 0;
    this.stepTimes = [];
    this.lastStepT = -Infinity;
    this.lastPrimaryT = -Infinity;
    this.kneeUp = { L: false, R: false };
    this.lastKnee = null;
    this.wristSide = 0;
    this.wristSideT = -Infinity;
  }

  update(body: Body, base: Baseline, t: number, sens: number): boolean {
    const full = base.mode === 'full';
    const unit = full ? base.torso : base.shoulderWidth;
    const height = -(full ? body.hip.y : body.shoulder.y) / unit;
    const bobStep = this.bob.update(height, t, this.th.bobMinAmp / sens, this.th.bobMaxStepGapMs, this.th.bobMaxSwing);
    const primary = full ? this.kneeStep(body, base, sens) : this.wristStep(body, base, t, sens);
    if (primary) {
      this.lastPrimaryT = t;
      return this.addStep(t);
    }
    if (bobStep && t - this.lastPrimaryT > FALLBACK_AFTER_MS) return this.addStep(t);
    return false;
  }

  status(t: number): JogStatus {
    const ms = t - this.lastStepT;
    const n = this.stepTimes.length;
    const cadence = n >= 2 ? ((n - 1) / (this.stepTimes[n - 1] - this.stepTimes[0])) * 60000 : 0;
    return {
      active: ms < ACTIVE_MS,
      cadenceSpm: ms < ACTIVE_MS ? Math.round(cadence) : 0,
      msSinceStep: ms,
      steps: this.total,
    };
  }

  private addStep(t: number): boolean {
    if (t - this.lastStepT < MIN_STEP_GAP_MS) return false;
    this.lastStepT = t;
    this.total++;
    this.stepTimes.push(t);
    while (this.stepTimes.length && t - this.stepTimes[0] > 3000) this.stepTimes.shift();
    return true;
  }

  private kneeStep(body: Body, base: Baseline, sens: number): boolean {
    let stepped = false;
    for (const side of ['L', 'R'] as const) {
      const knee = side === 'L' ? body.kneeL : body.kneeR;
      const rest = side === 'L' ? base.kneeRelL : base.kneeRelR;
      if (!knee || rest === null) {
        this.kneeUp[side] = false;
        continue;
      }
      const lift = (rest - (knee.y - body.hip.y)) / base.torso;
      if (!this.kneeUp[side] && lift > this.th.kneeLift / sens) {
        this.kneeUp[side] = true;
        if (this.lastKnee !== side) {
          this.lastKnee = side;
          stepped = true;
        }
      } else if (this.kneeUp[side] && lift < this.th.kneeRelease / sens) {
        this.kneeUp[side] = false;
      }
    }
    return stepped;
  }

  private wristStep(body: Body, base: Baseline, t: number, sens: number): boolean {
    const d = (body.wristL.y - body.wristR.y) / base.shoulderWidth;
    const a = this.th.wristPump / sens;
    const side = d > a ? 1 : d < -a ? -1 : 0;
    if (side === 0 || side === this.wristSide) return false;
    const counted = this.wristSide !== 0 && t - this.wristSideT <= 1000;
    this.wristSide = side;
    this.wristSideT = t;
    return counted;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pose/jog.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pose/jog.ts tests/pose/jog.test.ts
git commit -m "feat(pose): detect jogging in place"
```

---
### Task 6: Lane, jump and roll detection (both modes)

**Files:**
- Create: `src/pose/moves.ts`
- Test: `tests/pose/moves.test.ts`

**Interfaces:**
- Consumes: `Body` (Task 1), `Baseline` (Task 4), `JumpDetector`, `DropDetector`, `VerticalRef` (Task 3), `Thresholds`, `Lane`, `PoseEvent` (Task 1)
- Produces:
  - `nextLane(lane, offset, enter, exit): Lane`
  - `interface MoveContext { body; base; t; sens; bobAmp; jogging }`
  - `class FullBodyMoves(th)`: `lane: Lane`, `idle: boolean`, `update(ctx): PoseEvent[]` (emits `lane`, `jump`, `roll`), `reset()`
  - `class SmallRoomMoves(th)`: `idle: boolean`, `update(ctx): PoseEvent[]` (emits `laneShift`, `jump`, `roll`), `reset()`

- [ ] **Step 1: Write the failing test `tests/pose/moves.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { toBody } from '../../src/pose/landmarks';
import { FullBodyMoves, nextLane, SmallRoomMoves, type MoveContext } from '../../src/pose/moves';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { Baseline } from '../../src/pose/calibration';
import type { PoseEvent } from '../../src/pose/types';
import { baselineFor } from '../helpers/baseline';
import { ASPECT, jumpArc, STAND, synthPose, type SynthParams } from '../helpers/synth';

const T = STAND.torso;

function drive(
  m: { update(c: MoveContext): PoseEvent[] },
  base: Baseline,
  ms: number,
  fn: (t: number) => Partial<SynthParams>,
  sens = 1,
) {
  const out: PoseEvent[] = [];
  for (let t = 0; t < ms; t += 1000 / 30) {
    out.push(...m.update({ body: toBody(synthPose(fn(t)), ASPECT), base, t, sens, bobAmp: 0, jogging: false }));
  }
  return out;
}

describe('nextLane', () => {
  it.each([
    [0, 0.6, 1],
    [0, -0.6, -1],
    [0, 0.4, 0],
    [1, 0.4, 1],
    [1, 0.3, 0],
    [1, -0.6, -1],
    [-1, -0.4, -1],
    [-1, 0.1, 0],
    [-1, 0.7, 1],
  ] as const)('lane %i at offset %f → %i', (lane, offset, expected) => {
    expect(nextLane(lane, offset, 0.5, 0.35)).toBe(expected);
  });
});

describe('FullBodyMoves', () => {
  it('changes lane when the player steps sideways', () => {
    const m = new FullBodyMoves(DEFAULT_THRESHOLDS);
    const ev = drive(m, baselineFor(), 600, (t) => ({ hipX: STAND.hipX + (t < 300 ? 0 : 0.8 * T) }));
    expect(ev).toEqual([{ type: 'lane', lane: 1 }]);
    expect(m.lane).toBe(1);
  });

  it('uses sensitivity to scale the step size', () => {
    const step = (t: number) => ({ hipX: STAND.hipX + (t < 300 ? 0 : 0.45 * T) });
    expect(drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 600, step, 1)).toEqual([]);
    expect(drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 600, step, 1.25)).toEqual([{ type: 'lane', lane: 1 }]);
  });

  it('detects a jump once', () => {
    const ev = drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 1500, (t) => ({
      hipY: STAND.hipY - jumpArc(t - 300, 500, 0.35) * T,
    }));
    expect(ev).toEqual([{ type: 'jump' }]);
  });

  it('detects a held squat once', () => {
    const ev = drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 1500, (t) => ({
      hipY: STAND.hipY + (t > 300 ? 0.45 * T : 0),
    }));
    expect(ev).toEqual([{ type: 'roll' }]);
  });
});

describe('SmallRoomMoves', () => {
  it('shifts lane once per lean and re-arms when upright', () => {
    const base = baselineFor({ lowerVisible: false });
    const ev = drive(new SmallRoomMoves(DEFAULT_THRESHOLDS), base, 3000, (t) => ({
      lowerVisible: false,
      tiltDeg: t < 300 ? 0 : t < 1200 ? -20 : t < 2000 ? 0 : 20,
    }));
    expect(ev).toEqual([
      { type: 'laneShift', dir: -1 },
      { type: 'laneShift', dir: 1 },
    ]);
  });

  it('detects a shoulder hop and a duck', () => {
    const base = baselineFor({ lowerVisible: false });
    const ev = drive(new SmallRoomMoves(DEFAULT_THRESHOLDS), base, 3000, (t) => ({
      lowerVisible: false,
      hipY: STAND.hipY - jumpArc(t - 300, 400, 0.25) * T,
      noseDrop: t > 2000 ? 0.5 : 0,
    }));
    expect(ev).toEqual([{ type: 'jump' }, { type: 'roll' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pose/moves.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Write `src/pose/moves.ts`**

```ts
import type { Baseline } from './calibration';
import type { Body } from './landmarks';
import { DropDetector, JumpDetector, VerticalRef } from './signals';
import type { Thresholds } from './thresholds';
import type { Lane, PoseEvent } from './types';

export interface MoveContext {
  body: Body;
  base: Baseline;
  t: number;
  sens: number;
  /** Current jog bob amplitude, in the same units as the mode's height signal. */
  bobAmp: number;
  jogging: boolean;
}

/** Lane zones with hysteresis: enter a side lane at |offset| >= enter, leave it below exit. */
export function nextLane(lane: Lane, offset: number, enter: number, exit: number): Lane {
  if (lane === 0) return offset <= -enter ? -1 : offset >= enter ? 1 : 0;
  if (lane === -1) return offset > -exit ? (offset >= enter ? 1 : 0) : -1;
  return offset < exit ? (offset <= -enter ? -1 : 0) : 1;
}

/** Full-body mode: standing position sets the lane; hips drive jump and roll. Units: torso lengths. */
export class FullBodyMoves {
  lane: Lane = 0;
  private jump = new JumpDetector();
  private roll = new DropDetector();
  private vref = new VerticalRef();

  constructor(private th: Thresholds) {}

  get idle(): boolean {
    return this.jump.isArmed && this.roll.isArmed && !this.roll.isDropping;
  }

  reset(): void {
    this.lane = 0;
    this.jump.reset();
    this.roll.reset();
    this.vref.reset();
  }

  update({ body, base, t, sens, bobAmp, jogging }: MoveContext): PoseEvent[] {
    const th = this.th;
    const T = base.torso;
    const events: PoseEvent[] = [];

    const lane = nextLane(this.lane, (body.hip.x - base.hip.x) / T, th.laneEnter / sens, th.laneExit / sens);
    if (lane !== this.lane) {
      this.lane = lane;
      events.push({ type: 'lane', lane });
    }

    const h = -body.hip.y / T;
    const ref = this.vref.value(h, t, -base.hip.y / T, jogging, !this.idle);
    const minRise = Math.max(th.jumpRise / sens, th.bobJumpFactor * bobAmp);
    if (this.jump.update(h, ref, t, th.jumpVel / sens, minRise, th.jumpRearm / sens)) events.push({ type: 'jump' });

    const refHipY = -ref * T;
    const noseRef = base.nose.y + (refHipY - base.hip.y);
    const drop = ref - h;
    const headDrop = (body.nose.y - noseRef) / T;
    const rolled = this.roll.update(drop, headDrop, t, {
      drop: th.rollDrop / sens,
      holdMs: th.rollHoldMs,
      headDrop: th.rollHeadDrop / sens,
      rearmDrop: th.rollDrop / 2 / sens,
      rearmHead: th.rollHeadDrop / 2 / sens,
    });
    if (rolled) events.push({ type: 'roll' });
    return events;
  }
}

/** Small-room mode: leaning works like a swipe; shoulders drive jump, the head drives roll. Units: shoulder widths. */
export class SmallRoomMoves {
  private leanArmed = true;
  private jump = new JumpDetector();
  private roll = new DropDetector();
  private vref = new VerticalRef();

  constructor(private th: Thresholds) {}

  get idle(): boolean {
    return this.jump.isArmed && this.roll.isArmed;
  }

  reset(): void {
    this.leanArmed = true;
    this.jump.reset();
    this.roll.reset();
    this.vref.reset();
  }

  update({ body, base, t, sens, bobAmp, jogging }: MoveContext): PoseEvent[] {
    const th = this.th;
    const S = base.shoulderWidth;
    const events: PoseEvent[] = [];

    const noseShift = (body.nose.x - base.nose.x) / S;
    if (this.leanArmed) {
      const left = body.tiltDeg <= -th.leanDeg / sens || noseShift <= -th.noseShift / sens;
      const right = body.tiltDeg >= th.leanDeg / sens || noseShift >= th.noseShift / sens;
      if (left !== right) {
        this.leanArmed = false;
        events.push({ type: 'laneShift', dir: left ? -1 : 1 });
      }
    } else if (Math.abs(body.tiltDeg) < th.leanRearmDeg / sens && Math.abs(noseShift) < th.noseRearm / sens) {
      this.leanArmed = true;
    }

    const h = -body.shoulder.y / S;
    const ref = this.vref.value(h, t, -base.shoulder.y / S, jogging, !this.idle);
    const minRise = Math.max(th.smallJumpRise / sens, th.bobJumpFactor * bobAmp);
    if (this.jump.update(h, ref, t, th.smallJumpVel / sens, minRise, th.smallJumpRearm / sens)) events.push({ type: 'jump' });

    const noseRef = base.nose.y + (-ref * S - base.shoulder.y);
    const duck = (body.nose.y - noseRef) / S;
    const ducked = this.roll.update(0, duck, t, {
      drop: Infinity,
      holdMs: 0,
      headDrop: th.duckDrop / sens,
      rearmDrop: 1,
      rearmHead: th.duckDrop / 2 / sens,
    });
    if (ducked) events.push({ type: 'roll' });
    return events;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pose/moves.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pose/moves.ts tests/pose/moves.test.ts
git commit -m "feat(pose): detect lanes, jumps and rolls in both play modes"
```

---

### Task 7: Gestures

**Files:**
- Create: `src/pose/gestures.ts`
- Test: `tests/pose/gestures.test.ts`

**Interfaces:**
- Consumes: `Body` (Task 1), `Thresholds`, `PoseEvent` (Task 1)
- Produces: `class GestureDetector(th)` with:
  - `startProgress: number` (0..1)
  - `update(body, t): PoseEvent[]`, which emits `hoverboard` and `start`
  - `reset()`

  Gesture rules:
  - **Hoverboard:** both wrists above the nose for `hoverHoldMs`. Re-arms once a wrist drops below its shoulder.
  - **Start:** the right wrist above the right shoulder while the left wrist stays below the left shoulder, held for `startHoldMs`. Re-arms once the right wrist drops below the right shoulder.

- [ ] **Step 1: Write the failing test `tests/pose/gestures.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { GestureDetector } from '../../src/pose/gestures';
import { toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { PoseEvent } from '../../src/pose/types';
import { ASPECT, synthPose, type SynthParams } from '../helpers/synth';

function run(g: GestureDetector, from: number, to: number, arms: SynthParams['arms']) {
  const out: PoseEvent[] = [];
  for (let t = from; t < to; t += 1000 / 30) out.push(...g.update(toBody(synthPose({ arms }), ASPECT), t));
  return out.map((e) => e.type);
}

describe('GestureDetector', () => {
  it('fires hoverboard once per raise of both hands', () => {
    const g = new GestureDetector(DEFAULT_THRESHOLDS);
    expect(run(g, 0, 1000, 'both-up')).toEqual(['hoverboard']);
    expect(run(g, 1000, 1300, 'down')).toEqual([]);
    expect(run(g, 1300, 1800, 'both-up')).toEqual(['hoverboard']);
  });

  it('ignores a quick raise of both hands', () => {
    expect(run(new GestureDetector(DEFAULT_THRESHOLDS), 0, 200, 'both-up')).toEqual([]);
  });

  it('fires start after holding the right hand up, with progress', () => {
    const g = new GestureDetector(DEFAULT_THRESHOLDS);
    run(g, 0, 750, 'right-up');
    expect(g.startProgress).toBeGreaterThan(0.4);
    expect(g.startProgress).toBeLessThan(0.6);
    expect(run(g, 750, 1700, 'right-up')).toEqual(['start']);
    expect(run(g, 1700, 3500, 'right-up')).toEqual([]);
  });

  it('resets start progress when the hand drops early', () => {
    const g = new GestureDetector(DEFAULT_THRESHOLDS);
    run(g, 0, 500, 'right-up');
    run(g, 500, 550, 'down');
    expect(g.startProgress).toBe(0);
  });

  it('does not start while both hands are up', () => {
    expect(run(new GestureDetector(DEFAULT_THRESHOLDS), 0, 2000, 'both-up')).toEqual(['hoverboard']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pose/gestures.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Write `src/pose/gestures.ts`**

```ts
import type { Body } from './landmarks';
import type { Thresholds } from './thresholds';
import type { PoseEvent } from './types';

/** Hand gestures: both hands up activates the hoverboard; holding the right hand up means start. */
export class GestureDetector {
  startProgress = 0;
  private hoverSince: number | null = null;
  private hoverArmed = true;
  private startSince: number | null = null;
  private startArmed = true;

  constructor(private th: Thresholds) {}

  reset(): void {
    this.startProgress = 0;
    this.hoverSince = null;
    this.hoverArmed = true;
    this.startSince = null;
    this.startArmed = true;
  }

  update(b: Body, t: number): PoseEvent[] {
    const events: PoseEvent[] = [];
    const leftDown = b.wristL.y > b.shoulderL.y;
    const rightDown = b.wristR.y > b.shoulderR.y;

    const bothUp = b.wristL.y < b.nose.y && b.wristR.y < b.nose.y;
    if (!bothUp) {
      this.hoverSince = null;
      if (leftDown || rightDown) this.hoverArmed = true;
    } else if (this.hoverArmed) {
      this.hoverSince ??= t;
      if (t - this.hoverSince >= this.th.hoverHoldMs) {
        this.hoverArmed = false;
        this.hoverSince = null;
        events.push({ type: 'hoverboard' });
      }
    }

    const rightOnly = !rightDown && leftDown;
    if (!rightOnly) {
      this.startSince = null;
      this.startProgress = 0;
      if (rightDown) this.startArmed = true;
    } else if (this.startArmed) {
      this.startSince ??= t;
      this.startProgress = Math.min(1, (t - this.startSince) / this.th.startHoldMs);
      if (this.startProgress >= 1) {
        this.startArmed = false;
        this.startSince = null;
        this.startProgress = 0;
        events.push({ type: 'start' });
      }
    }
    return events;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pose/gestures.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pose/gestures.ts tests/pose/gestures.test.ts
git commit -m "feat(pose): detect hoverboard and start gestures"
```

---
### Task 8: PoseController (integration)

**Files:**
- Create: `src/pose/controller.ts`, `tests/helpers/play.ts`
- Test: `tests/pose/controller.full.test.ts`, `tests/pose/controller.small.test.ts`, `tests/pose/controller.tracking.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces:
  - `interface PoseControllerOptions { thresholds?: Thresholds; sensitivity?: number; forcedMode?: PlayMode | null }`
  - `class PoseController`:
    - properties `th`, `sensitivity`, `forcedMode`, `baseline: Baseline | null`, `body: Body | null`, `status: PoseStatus`
    - `update(frame: PoseFrame): PoseEvent[]`
    - `recalibrate(): void`
  - Test helpers: `play(ctrl, frames)`, which returns the events, and `names(events)`, which returns strings such as `'lane:1'`, `'shift:-1'` and `'jump'`

- [ ] **Step 1: Write `tests/helpers/play.ts`**

```ts
import type { PoseController } from '../../src/pose/controller';
import type { PoseEvent, PoseFrame } from '../../src/pose/types';

export function play(ctrl: PoseController, frames: PoseFrame[]): PoseEvent[] {
  return frames.flatMap((f) => ctrl.update(f));
}

export const names = (events: PoseEvent[]) =>
  events.map((e) => (e.type === 'lane' ? `lane:${e.lane}` : e.type === 'laneShift' ? `shift:${e.dir}` : e.type));
```

- [ ] **Step 2: Write the failing test `tests/pose/controller.full.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { jogParams, jumpArc, ramp, Scenario, STAND } from '../helpers/synth';

const T = STAND.torso;
const calibrated = () => new Scenario().hold(2500);
const at = (dx: number) => ({ hipX: STAND.hipX + dx * T });
const events = (sc: Scenario) => names(play(new PoseController(), sc.frames));

describe('PoseController — full-body mode', () => {
  it('calibrates after 2 s of standing', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(1800).frames);
    expect(ctrl.status.calibrated).toBe(false);
    const done = new PoseController();
    play(done, calibrated().frames);
    expect(done.status.calibrated).toBe(true);
    expect(done.status.mode).toBe('full');
  });

  it('maps standing position to lanes', () => {
    const sc = calibrated()
      .add(300, (t) => at(0.8 * ramp(t, 300)))
      .hold(700, at(0.8))
      .add(300, (t) => at(0.8 * (1 - ramp(t, 300))))
      .hold(700)
      .add(300, (t) => at(-0.8 * ramp(t, 300)))
      .hold(700, at(-0.8));
    expect(events(sc)).toEqual(['lane:1', 'lane:0', 'lane:-1']);
  });

  it('does not flicker near a lane boundary', () => {
    const sc = calibrated()
      .add(300, (t) => at(0.8 * ramp(t, 300)))
      .add(2000, (t) => at(0.5 + 0.1 * Math.sin(t / 100)));
    expect(events(sc)).toEqual(['lane:1']);
  });

  it('detects a jump', () => {
    const sc = calibrated()
      .add(500, (t) => ({ hipY: STAND.hipY - jumpArc(t, 500, 0.35) * T }))
      .hold(1000);
    expect(events(sc)).toEqual(['jump']);
  });

  it('detects two separate squats', () => {
    const down = (t: number) => ({ hipY: STAND.hipY + 0.45 * T * ramp(t, 200) });
    const up = (t: number) => ({ hipY: STAND.hipY + 0.45 * T * (1 - ramp(t, 200)) });
    const sc = calibrated()
      .add(200, down).hold(600, down(200)).add(200, up).hold(800)
      .add(200, down).hold(600, down(200));
    expect(events(sc)).toEqual(['roll', 'roll']);
  });

  it('treats a pre-jump dip as part of the jump', () => {
    const sc = calibrated()
      .add(150, (t) => ({ hipY: STAND.hipY + 0.2 * T * Math.sin((Math.PI * t) / 150) }))
      .add(500, (t) => ({ hipY: STAND.hipY - jumpArc(t, 500, 0.35) * T }))
      .hold(800);
    expect(events(sc)).toEqual(['jump']);
  });

  it('detects a head duck as a roll', () => {
    const sc = calibrated()
      .add(200, (t) => ({ noseDrop: 0.5 * ramp(t, 200) }))
      .hold(400, { noseDrop: 0.5 });
    expect(events(sc)).toEqual(['roll']);
  });

  it('tracks jogging without triggering moves, then notices stopping', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(5000, (t) => jogParams(t));
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    const jog = ctrl.status.jog;
    expect(jog.active).toBe(true);
    expect(jog.steps).toBeGreaterThanOrEqual(12);
    expect(jog.steps).toBeLessThanOrEqual(15);
    expect(jog.cadenceSpm).toBeGreaterThan(145);
    expect(jog.cadenceSpm).toBeLessThan(175);

    const from = sc.frames.length;
    sc.hold(1500);
    play(ctrl, sc.frames.slice(from));
    expect(ctrl.status.jog.active).toBe(false);
    expect(ctrl.status.jog.msSinceStep).toBeGreaterThan(1000);
  });

  it('detects a jump in the middle of jogging', () => {
    const sc = calibrated()
      .add(3000, (t) => jogParams(t))
      .add(500, (t) => {
        const j = jogParams(3000 + t);
        return { ...j, hipY: j.hipY - jumpArc(t, 500, 0.4) * T };
      })
      .add(2000, (t) => jogParams(3500 + t));
    expect(events(sc)).toEqual(['jump']);
  });

  it('keeps following the calibrated player when someone else walks in', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(1500, () => [{}, { hipX: STAND.hipX + 0.5, torso: 0.3 }]);
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    expect(ctrl.status.lane).toBe(0);
  });
});
```

- [ ] **Step 3: Write the failing test `tests/pose/controller.small.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { jogParams, jumpArc, ramp, Scenario, STAND } from '../helpers/synth';

const T = STAND.torso;
const SMALL = { lowerVisible: false };
const calibrated = () => new Scenario().hold(2500, SMALL);

describe('PoseController — small-room mode', () => {
  it('calibrates in small-room mode when knees are hidden', () => {
    const ctrl = new PoseController();
    play(ctrl, calibrated().frames);
    expect(ctrl.status.mode).toBe('small');
  });

  it('turns leans into lane shifts', () => {
    const sc = calibrated()
      .add(200, (t) => ({ ...SMALL, tiltDeg: -20 * ramp(t, 200) }))
      .hold(600, { ...SMALL, tiltDeg: -20 })
      .add(200, (t) => ({ ...SMALL, tiltDeg: -20 * (1 - ramp(t, 200)) }))
      .hold(400, SMALL)
      .add(200, (t) => ({ ...SMALL, tiltDeg: 20 * ramp(t, 200) }))
      .hold(400, { ...SMALL, tiltDeg: 20 });
    expect(names(play(new PoseController(), sc.frames))).toEqual(['shift:-1', 'shift:1']);
  });

  it('detects a shoulder hop and a duck', () => {
    const sc = calibrated()
      .add(400, (t) => ({ ...SMALL, hipY: STAND.hipY - jumpArc(t, 400, 0.25) * T }))
      .hold(800, SMALL)
      .add(200, (t) => ({ ...SMALL, noseDrop: 0.5 * ramp(t, 200) }))
      .hold(400, { ...SMALL, noseDrop: 0.5 });
    expect(names(play(new PoseController(), sc.frames))).toEqual(['jump', 'roll']);
  });

  it('counts arm pumping as jogging without other moves', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(5000, (t) => jogParams(t, { small: true, bob: 0 }));
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    expect(ctrl.status.jog.steps).toBeGreaterThanOrEqual(12);
    expect(ctrl.status.jog.steps).toBeLessThanOrEqual(15);
  });

  it('counts a shoulder bob as jogging without jumping', () => {
    const ctrl = new PoseController();
    const sc = calibrated().add(5000, (t) => jogParams(t, { small: true, arms: 'down', bob: 0.08 }));
    expect(names(play(ctrl, sc.frames))).toEqual([]);
    expect(ctrl.status.jog.steps).toBeGreaterThanOrEqual(10);
  });
});
```

- [ ] **Step 4: Write the failing test `tests/pose/controller.tracking.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';
import { Scenario } from '../helpers/synth';

describe('PoseController — tracking and gestures', () => {
  it('emits lost after 1 s without a pose and found when the player returns', () => {
    const sc = new Scenario().hold(500).add(1500, () => null).hold(500);
    expect(names(play(new PoseController(), sc.frames))).toEqual(['lost', 'found']);
  });

  it('runs gestures before calibration', () => {
    const ctrl = new PoseController();
    const sc = new Scenario().hold(300).hold(1600, { arms: 'right-up' }).hold(300).hold(500, { arms: 'both-up' });
    expect(names(play(ctrl, sc.frames))).toEqual(['start', 'hoverboard']);
  });

  it('exposes start progress and the tracked pose in status', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(300).hold(800, { arms: 'right-up' }).frames);
    expect(ctrl.status.startProgress).toBeGreaterThan(0.4);
    expect(ctrl.status.tracking).toBe(true);
    expect(ctrl.status.pose).toHaveLength(33);
    expect(ctrl.status.poseFps).toBe(30);
  });

  it('recalibrate forgets the baseline', () => {
    const ctrl = new PoseController();
    play(ctrl, new Scenario().hold(2500).frames);
    ctrl.recalibrate();
    expect(ctrl.status.calibrated).toBe(false);
    expect(ctrl.status.calibration.progress).toBe(0);
  });

  it('honours a forced mode', () => {
    const ctrl = new PoseController({ forcedMode: 'small' });
    play(ctrl, new Scenario().hold(2500).frames);
    expect(ctrl.status.mode).toBe('small');
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run tests/pose/controller`
Expected: FAIL, because `src/pose/controller` is not found.

- [ ] **Step 6: Write `src/pose/controller.ts`**

```ts
import { Calibrator, driftBaseline, type Baseline } from './calibration';
import { GestureDetector } from './gestures';
import { JogDetector } from './jog';
import { dist, toBody, type Body } from './landmarks';
import { FullBodyMoves, SmallRoomMoves } from './moves';
import { PoseSmoother } from './oneEuro';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import type { PlayMode, Pose, PoseEvent, PoseFrame, PoseStatus } from './types';

export interface PoseControllerOptions {
  thresholds?: Thresholds;
  sensitivity?: number;
  forcedMode?: PlayMode | null;
}

/** Turns a stream of pose frames into game-agnostic move events and a status snapshot. */
export class PoseController {
  readonly th: Thresholds;
  sensitivity: number;
  forcedMode: PlayMode | null;
  baseline: Baseline | null = null;
  body: Body | null = null;

  private calibrator: Calibrator;
  private jog: JogDetector;
  private gestures: GestureDetector;
  private full: FullBodyMoves;
  private small: SmallRoomMoves;
  private smoother = new PoseSmoother();
  private pose: Pose | null = null;
  private lastSeenT: number | null = null;
  private lost = false;
  private lastT: number | null = null;
  private fps = 0;
  private now = 0;

  constructor(opts: PoseControllerOptions = {}) {
    this.th = opts.thresholds ?? { ...DEFAULT_THRESHOLDS };
    this.sensitivity = opts.sensitivity ?? 1;
    this.forcedMode = opts.forcedMode ?? null;
    this.calibrator = new Calibrator(this.th);
    this.jog = new JogDetector(this.th);
    this.gestures = new GestureDetector(this.th);
    this.full = new FullBodyMoves(this.th);
    this.small = new SmallRoomMoves(this.th);
  }

  recalibrate(): void {
    this.baseline = null;
    this.calibrator.reset();
    this.jog.reset();
    this.full.reset();
    this.small.reset();
  }

  get status(): PoseStatus {
    return {
      tracking: this.body !== null,
      calibrated: this.baseline !== null,
      mode: this.baseline?.mode ?? null,
      lane: this.full.lane,
      poseFps: Math.round(this.fps),
      confidence: this.body?.confidence ?? 0,
      jog: this.jog.status(this.now),
      startProgress: this.gestures.startProgress,
      calibration: { ...this.calibrator.state },
      pose: this.pose,
    };
  }

  update(frame: PoseFrame): PoseEvent[] {
    const { t } = frame;
    const prevT = this.lastT;
    if (prevT !== null && t > prevT) {
      const inst = 1000 / (t - prevT);
      this.fps = this.fps ? this.fps * 0.9 + inst * 0.1 : inst;
    }
    this.lastT = t;
    this.now = t;
    this.lastSeenT ??= t;

    const raw = this.pickPose(frame);
    if (!raw) {
      this.pose = null;
      this.body = null;
      if (!this.baseline) this.calibrator.update(null, t, this.forcedMode);
      if (!this.lost && t - this.lastSeenT >= this.th.lostMs) {
        this.lost = true;
        return [{ type: 'lost' }];
      }
      return [];
    }

    const events: PoseEvent[] = [];
    if (this.lost) {
      this.lost = false;
      this.smoother.reset();
      events.push({ type: 'found' });
    }
    this.lastSeenT = t;

    const pose = this.smoother.smooth(raw, t);
    const body = toBody(pose, frame.aspect);
    this.pose = pose;
    this.body = body;
    events.push(...this.gestures.update(body, t));

    if (!this.baseline) {
      this.baseline = this.calibrator.update(body, t, this.forcedMode);
      return events;
    }

    const base = this.baseline;
    const sens = this.sensitivity;
    this.jog.update(body, base, t, sens);
    const jogging = this.jog.status(t).active;
    const moves = base.mode === 'full' ? this.full : this.small;
    events.push(...moves.update({ body, base, t, sens, bobAmp: this.jog.bob.amplitudeAt(t), jogging }));

    const settled =
      base.mode === 'full'
        ? Math.abs(body.hip.y - base.hip.y) < this.th.driftSettle * base.torso
        : Math.abs(body.shoulder.y - base.shoulder.y) < this.th.driftSettle * base.shoulderWidth;
    if (prevT !== null && !jogging && moves.idle && settled) driftBaseline(base, body, t - prevT);
    return events;
  }

  /** With several people in view, follow the one nearest the calibrated spot (or the largest before calibration). */
  private pickPose(frame: PoseFrame): Pose | null {
    if (frame.poses.length <= 1) return frame.poses[0] ?? null;
    const base = this.baseline;
    const score = (p: Pose) => {
      const b = toBody(p, frame.aspect);
      return base ? -dist(b.hip, base.hip) : b.torso;
    };
    return frame.poses.reduce((best, p) => (score(p) > score(best) ? p : best));
  }
}
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass and there are no type errors.

If a scenario test fails, debug in this order before changing any expectation:
1. Log the offending signal per frame (for example `ctrl.body.hip.y`, `ctrl.status.jog`).
2. Check the synthetic scenario matches the test's intent.
3. Only then adjust a threshold in `thresholds.ts`, and only if the spec value is clearly unworkable. Record any such change in the commit message.

- [ ] **Step 8: Commit**

```bash
git add src/pose/controller.ts tests/helpers/play.ts tests/pose/controller.*.test.ts
git commit -m "feat(pose): add PoseController tying detection together"
```

---
### Task 9: Fixtures (record, encode, replay data)

**Files:**
- Create: `src/pose/fixtures.ts`, `scripts/make-synth-fixtures.ts`
- Create (generated): `tests/fixtures/synth-full.json`, `tests/fixtures/synth-small.json`
- Test: `tests/pose/fixtures.test.ts`

**Interfaces:**
- Consumes: `PoseFrame` (Task 1); `Scenario`, `jogParams`, `jumpArc`, `ramp`, `STAND` (Task 1 helpers)
- Produces:
  - `interface PoseFixture { version: 1; name: string; note?: string; aspect: number; frames: { t: number; poses: number[][][] }[] }`. Each landmark is stored as `[x, y, z, visibility]`, rounded to 4 decimal places, and `t` is relative to the first frame.
  - `encodeFrames(name, frames, note?): PoseFixture`
  - `decodeFixture(fx): PoseFrame[]`, which throws on an unknown version
  - `class FixtureRecorder`: `recording`, `count`, `start()`, `push(frame)`, `stop(name, note?): PoseFixture`

- [ ] **Step 1: Write the failing test `tests/pose/fixtures.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { decodeFixture, encodeFrames, FixtureRecorder, type PoseFixture } from '../../src/pose/fixtures';
import { Scenario } from '../helpers/synth';

describe('fixtures', () => {
  it('round-trips frames with relative timestamps', () => {
    const sc = new Scenario().hold(100).add(100, () => null);
    const shifted = sc.frames.map((f) => ({ ...f, t: f.t + 5000 }));
    const fx = encodeFrames('demo', shifted, 'note');
    expect(fx.version).toBe(1);
    expect(fx.frames[0].t).toBe(0);
    const back = decodeFixture(JSON.parse(JSON.stringify(fx)) as PoseFixture);
    expect(back).toHaveLength(shifted.length);
    expect(back[0].poses[0][24].y).toBeCloseTo(shifted[0].poses[0][24].y, 4);
    expect(back.at(-1)!.poses).toEqual([]);
  });

  it('rejects unknown versions', () => {
    expect(() => decodeFixture({ version: 2 } as unknown as PoseFixture)).toThrow(/version/);
  });

  it('records only while recording', () => {
    const r = new FixtureRecorder();
    const [a, b] = new Scenario().hold(67).frames;
    r.push(a);
    r.start();
    r.push(b);
    expect(r.count).toBe(1);
    const fx = r.stop('x');
    expect(r.recording).toBe(false);
    expect(fx.frames).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/pose/fixtures.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Write `src/pose/fixtures.ts`**

```ts
import type { PoseFrame } from './types';

/** Recorded landmark stream, used for replay and detector regression tests. */
export interface PoseFixture {
  version: 1;
  name: string;
  note?: string;
  aspect: number;
  /** Each pose is a list of [x, y, z, visibility]; t is ms since the first frame. */
  frames: { t: number; poses: number[][][] }[];
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function encodeFrames(name: string, frames: PoseFrame[], note?: string): PoseFixture {
  const t0 = frames[0]?.t ?? 0;
  return {
    version: 1,
    name,
    note,
    aspect: frames[0]?.aspect ?? 4 / 3,
    frames: frames.map((f) => ({
      t: Math.round(f.t - t0),
      poses: f.poses.map((p) => p.map((l) => [r4(l.x), r4(l.y), r4(l.z), r4(l.visibility)])),
    })),
  };
}

export function decodeFixture(fx: PoseFixture): PoseFrame[] {
  if (fx.version !== 1) throw new Error(`Unsupported fixture version ${String(fx.version)}`);
  return fx.frames.map((f) => ({
    t: f.t,
    aspect: fx.aspect,
    poses: f.poses.map((p) => p.map(([x, y, z, visibility]) => ({ x, y, z, visibility }))),
  }));
}

export class FixtureRecorder {
  recording = false;
  private frames: PoseFrame[] = [];

  get count(): number {
    return this.frames.length;
  }

  start(): void {
    this.frames = [];
    this.recording = true;
  }

  push(frame: PoseFrame): void {
    if (this.recording) this.frames.push(frame);
  }

  stop(name: string, note?: string): PoseFixture {
    this.recording = false;
    return encodeFrames(name, this.frames, note);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/pose/fixtures.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Write `scripts/make-synth-fixtures.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { encodeFrames } from '../src/pose/fixtures';
import { jogParams, jumpArc, ramp, Scenario, STAND } from '../tests/helpers/synth';

const T = STAND.torso;
const out = new URL('../tests/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });

const full = new Scenario()
  .hold(2500)
  .add(300, (t) => ({ hipX: STAND.hipX + 0.8 * T * ramp(t, 300) }))
  .hold(700, { hipX: STAND.hipX + 0.8 * T })
  .add(300, (t) => ({ hipX: STAND.hipX + 0.8 * T * (1 - ramp(t, 300)) }))
  .hold(500)
  .add(500, (t) => ({ hipY: STAND.hipY - jumpArc(t, 500, 0.35) * T }))
  .hold(500)
  .add(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * ramp(t, 200) }))
  .hold(500, { hipY: STAND.hipY + 0.45 * T })
  .add(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * (1 - ramp(t, 200)) }))
  .add(4000, (t) => jogParams(t))
  .hold(600, { arms: 'both-up' })
  .hold(1500);

const small = new Scenario()
  .hold(2500, { lowerVisible: false })
  .add(200, (t) => ({ lowerVisible: false, tiltDeg: -20 * ramp(t, 200) }))
  .hold(500, { lowerVisible: false, tiltDeg: -20 })
  .hold(500, { lowerVisible: false })
  .add(400, (t) => ({ lowerVisible: false, hipY: STAND.hipY - jumpArc(t, 400, 0.25) * T }))
  .hold(500, { lowerVisible: false })
  .add(4000, (t) => jogParams(t, { small: true, bob: 0 }))
  .hold(1500, { lowerVisible: false });

for (const [name, sc, note] of [
  ['synth-full', full, 'Synthetic: calibrate, lane right and back, jump, squat, jog, hoverboard'],
  ['synth-small', small, 'Synthetic small-room: calibrate, lean left, hop, arm-pump jog'],
] as const) {
  await writeFile(new URL(`${name}.json`, out), JSON.stringify(encodeFrames(name, sc.frames, note)));
  console.log(`wrote tests/fixtures/${name}.json (${sc.frames.length} frames)`);
}
```

Run: `npm run fixtures:synth`
Expected: two files are written, with roughly 400 and 300 frames.

- [ ] **Step 6: Add a regression test that replays the fixture files**

Append to `tests/pose/fixtures.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';

const load = (name: string) =>
  decodeFixture(JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as PoseFixture);

describe('recorded fixtures', () => {
  it('synth-full produces the expected moves', () => {
    expect(names(play(new PoseController(), load('synth-full')))).toEqual(['lane:1', 'lane:0', 'jump', 'roll', 'hoverboard']);
  });

  it('synth-small produces the expected moves', () => {
    const ctrl = new PoseController();
    expect(names(play(ctrl, load('synth-small')))).toEqual(['shift:-1', 'jump']);
    expect(ctrl.status.jog.steps).toBeGreaterThanOrEqual(9);
  });
});
```

Move the new `import` lines to the top of the file with the other imports.

Run: `npx vitest run tests/pose/fixtures.test.ts`
Expected: 5 tests pass.

Real recordings made later with the debug page go in `tests/fixtures/` and get the same kind of test.

- [ ] **Step 7: Commit**

```bash
git add src/pose/fixtures.ts scripts/make-synth-fixtures.ts tests/fixtures tests/pose/fixtures.test.ts
git commit -m "feat(pose): add pose fixtures and synthetic replay data"
```

---

### Task 10: Camera and MediaPipe runtime

**Files:**
- Create: `src/pose/camera.ts`, `src/pose/mirror.ts`, `src/pose/landmarker.ts`, `src/pose/pose.worker.ts`, `src/pose/poseSource.ts`, `src/pose/liveSource.ts`, `src/pose/replaySource.ts`
- Test: `tests/pose/camera.test.ts`, `tests/pose/mirror.test.ts`

**Interfaces:**
- Consumes: `Pose`, `PoseFrame` (Task 1); `decodeFixture` (Task 9)
- Produces:
  - `interface CameraInfo { deviceId; label }`
  - `isIrCamera(label)`, `pickDefaultCamera(cams, savedId?)`, `listCameras()`, `openCamera(deviceId?)`, `describeCameraError(err)`
  - `mirrorPoses(landmarks: {x,y,z,visibility?}[][]): Pose[]`
  - `createLandmarker({ variant: 'full'|'lite', delegate: 'GPU'|'CPU', canvas?, useModule? })`
  - `interface PoseSource { readonly backend: string; start(onFrame): Promise<void>; stop(): void }`
  - `class LivePoseSource(video, maxFps = 30)`, which adds `fps`
  - `class ReplayPoseSource(frames, loop = true)`, with `static load(url, loop?)`

- [ ] **Step 1: Write the failing tests**

`tests/pose/camera.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { describeCameraError, isIrCamera, pickDefaultCamera } from '../../src/pose/camera';

const FHD = { deviceId: 'a', label: 'USB2.0 FHD UVC WebCam' };
const IR = { deviceId: 'b', label: 'USB2.0 IR UVC WebCam' };

describe('camera helpers', () => {
  it('recognises IR cameras', () => {
    expect(isIrCamera(IR.label)).toBe(true);
    expect(isIrCamera('Infrared Camera')).toBe(true);
    expect(isIrCamera(FHD.label)).toBe(false);
    expect(isIrCamera('Mirror Cam')).toBe(false);
  });

  it('prefers the saved camera, then the first non-IR camera', () => {
    expect(pickDefaultCamera([IR, FHD])).toEqual(FHD);
    expect(pickDefaultCamera([IR, FHD], 'b')).toEqual(IR);
    expect(pickDefaultCamera([IR, FHD], 'gone')).toEqual(FHD);
    expect(pickDefaultCamera([IR])).toEqual(IR);
    expect(pickDefaultCamera([])).toBeNull();
  });

  it('explains camera errors', () => {
    expect(describeCameraError({ name: 'NotAllowedError' })).toMatch(/permission/i);
    expect(describeCameraError({ name: 'NotReadableError' })).toMatch(/busy/i);
    expect(describeCameraError({ name: 'NotFoundError' })).toMatch(/no camera/i);
    expect(describeCameraError(new Error('boom'))).toMatch(/boom/);
  });
});
```

`tests/pose/mirror.test.ts`:
```ts
import { expect, it } from 'vitest';
import { mirrorPoses } from '../../src/pose/mirror';

it('mirrors x and defaults missing visibility to 0', () => {
  expect(mirrorPoses([[{ x: 0.2, y: 0.3, z: 0.1, visibility: 0.9 }, { x: 1, y: 0, z: 0 }]])).toEqual([
    [
      { x: 0.8, y: 0.3, z: 0.1, visibility: 0.9 },
      { x: 0, y: 0, z: 0, visibility: 0 },
    ],
  ]);
});
```

Run: `npx vitest run tests/pose/camera.test.ts tests/pose/mirror.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 2: Write `src/pose/camera.ts` and `src/pose/mirror.ts`**

`src/pose/camera.ts`:
```ts
export interface CameraInfo {
  deviceId: string;
  label: string;
}

/** Windows Hello IR cameras show up as video inputs but are useless for pose tracking. */
export const isIrCamera = (label: string) => /\bIR\b|infrared/i.test(label);

export function pickDefaultCamera(cams: CameraInfo[], savedId?: string | null): CameraInfo | null {
  const saved = savedId ? cams.find((c) => c.deviceId === savedId) : undefined;
  return saved ?? cams.find((c) => !isIrCamera(c.label)) ?? cams[0] ?? null;
}

/** Labels are only filled in after camera permission has been granted. */
export async function listCameras(): Promise<CameraInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

export function openCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
  });
}

export function describeCameraError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access in the browser address bar, then retry.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy. Close other apps using it (Teams, Zoom, Camera) and retry.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Plug one in or pick another camera, then retry.';
    default:
      return `Could not start the camera: ${err instanceof Error ? err.message : String(err)}`;
  }
}
```

`src/pose/mirror.ts`:
```ts
import type { Pose } from './types';

interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** Mirror MediaPipe landmarks horizontally so the player's left is screen-left. */
export function mirrorPoses(landmarks: RawLandmark[][]): Pose[] {
  return landmarks.map((p) => p.map((l) => ({ x: 1 - l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })));
}
```

Run: `npx vitest run tests/pose/camera.test.ts tests/pose/mirror.test.ts`
Expected: all tests pass.

- [ ] **Step 3: Write `src/pose/landmarker.ts` and `src/pose/poseSource.ts`**

`src/pose/landmarker.ts`:
```ts
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export type ModelVariant = 'full' | 'lite';

export interface LandmarkerConfig {
  variant: ModelVariant;
  delegate: 'GPU' | 'CPU';
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /** Load the ES-module wasm loader (needed inside module workers). */
  useModule?: boolean;
}

const base = () => `${self.location.origin}${import.meta.env.BASE_URL}mediapipe`;

export async function createLandmarker(cfg: LandmarkerConfig): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(`${base()}/wasm`, cfg.useModule);
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${base()}/models/pose_landmarker_${cfg.variant}.task`,
      delegate: cfg.delegate,
    },
    canvas: cfg.canvas,
    runningMode: 'VIDEO',
    numPoses: 2,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}
```

`src/pose/poseSource.ts`:
```ts
import type { PoseFrame } from './types';

export interface PoseSource {
  /** Which backend is running, e.g. "worker-gpu-full" or "replay". */
  readonly backend: string;
  start(onFrame: (frame: PoseFrame) => void): Promise<void>;
  stop(): void;
}
```

- [ ] **Step 4: Write the worker `src/pose/pose.worker.ts`**

```ts
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, type ModelVariant } from './landmarker';
import { mirrorPoses } from './mirror';
import type { Pose } from './types';

export type WorkerIn = { type: 'init'; variant: ModelVariant } | { type: 'frame'; bitmap: ImageBitmap; t: number };
export type WorkerOut =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'result'; t: number; aspect: number; poses: Pose[] };

const ctx = self as unknown as {
  postMessage(msg: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let landmarker: PoseLandmarker | null = null;

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      landmarker?.close();
      landmarker = null;
      landmarker = await createLandmarker({
        variant: msg.variant,
        delegate: 'GPU',
        canvas: new OffscreenCanvas(1, 1),
        useModule: true,
      });
      ctx.postMessage({ type: 'ready' });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }

  const { bitmap, t } = msg;
  try {
    if (!landmarker) return;
    const result = landmarker.detectForVideo(bitmap, t);
    ctx.postMessage({ type: 'result', t, aspect: bitmap.width / bitmap.height, poses: mirrorPoses(result.landmarks) });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: String(err) });
  } finally {
    bitmap.close();
  }
};
```

A frame that arrives before init finishes still returns nothing. `LivePoseSource` only sends frames after `ready`.

- [ ] **Step 5: Write `src/pose/liveSource.ts`**

```ts
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, type ModelVariant } from './landmarker';
import { mirrorPoses } from './mirror';
import type { WorkerIn, WorkerOut } from './pose.worker';
import type { PoseSource } from './poseSource';
import type { PoseFrame } from './types';

const SLOW_FPS = 15;
const SLOW_FOR_MS = 5000;

/**
 * Runs pose detection on a playing <video>. Backend fallback chain:
 * worker + GPU → main thread + GPU → main thread + CPU (lite).
 * Switches to the lite model if detection stays below 15 fps for 5 s.
 */
export class LivePoseSource implements PoseSource {
  backend = 'none';
  private worker: Worker | null = null;
  private landmarker: PoseLandmarker | null = null;
  private onFrame: ((f: PoseFrame) => void) | null = null;
  private running = false;
  private busy = false;
  private lastSent = 0;
  private handle = 0;
  private results: number[] = [];
  private startedAt = 0;
  private slowSince: number | null = null;

  constructor(
    private video: HTMLVideoElement,
    private maxFps = 30,
  ) {}

  get fps(): number {
    return this.results.length / 2;
  }

  async start(onFrame: (f: PoseFrame) => void): Promise<void> {
    this.onFrame = onFrame;
    this.running = true;
    await this.initBackend();
    this.startedAt = performance.now();
    const tick = () => {
      if (!this.running) return;
      this.grab();
      this.handle = this.video.requestVideoFrameCallback(tick);
    };
    this.handle = this.video.requestVideoFrameCallback(tick);
  }

  stop(): void {
    this.running = false;
    this.video.cancelVideoFrameCallback(this.handle);
    this.worker?.terminate();
    this.worker = null;
    this.landmarker?.close();
    this.landmarker = null;
  }

  private async initBackend(): Promise<void> {
    try {
      await this.initWorker('full');
      this.backend = 'worker-gpu-full';
      return;
    } catch (err) {
      console.warn('Pose worker unavailable, using the main thread:', err);
    }
    try {
      this.landmarker = await createLandmarker({ variant: 'full', delegate: 'GPU' });
      this.backend = 'main-gpu-full';
      return;
    } catch (err) {
      console.warn('GPU pose model unavailable, using CPU lite:', err);
    }
    this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'CPU' });
    this.backend = 'main-cpu-lite';
  }

  private initWorker(variant: ModelVariant): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = this.worker ?? new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      const fail = (message: string) => {
        clearTimeout(timer);
        w.terminate();
        this.worker = null;
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('Pose worker init timed out'), 20000);
      w.onerror = (e) => fail(e.message || 'Pose worker crashed');
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          w.onmessage = (ev: MessageEvent<WorkerOut>) => this.onWorkerMessage(ev.data);
          resolve();
        } else if (e.data.type === 'error') {
          fail(e.data.message);
        }
      };
      w.postMessage({ type: 'init', variant } satisfies WorkerIn);
    });
  }

  private grab(): void {
    const now = performance.now();
    if (this.busy || now - this.lastSent < 1000 / this.maxFps - 2 || this.video.readyState < 2) return;
    this.lastSent = now;

    if (this.worker) {
      this.busy = true;
      const worker = this.worker;
      createImageBitmap(this.video).then(
        (bitmap) => worker.postMessage({ type: 'frame', bitmap, t: now } satisfies WorkerIn, [bitmap]),
        () => (this.busy = false),
      );
    } else if (this.landmarker) {
      const r = this.landmarker.detectForVideo(this.video, now);
      this.emit({ t: now, aspect: this.video.videoWidth / this.video.videoHeight, poses: mirrorPoses(r.landmarks) });
    }
  }

  private onWorkerMessage(m: WorkerOut): void {
    if (m.type === 'result') {
      this.busy = false;
      this.emit({ t: m.t, aspect: m.aspect, poses: m.poses });
    } else if (m.type === 'error') {
      this.busy = false;
      console.warn('Pose worker error:', m.message);
    }
  }

  private emit(frame: PoseFrame): void {
    const now = performance.now();
    this.results.push(now);
    while (now - this.results[0] > 2000) this.results.shift();
    this.checkSpeed(now);
    this.onFrame?.(frame);
  }

  private checkSpeed(now: number): void {
    const slow = this.backend.endsWith('-full') && now - this.startedAt > 3000 && this.fps < SLOW_FPS;
    if (!slow) {
      this.slowSince = null;
      return;
    }
    this.slowSince ??= now;
    if (now - this.slowSince > SLOW_FOR_MS) void this.switchToLite();
  }

  private async switchToLite(): Promise<void> {
    console.warn(`Pose detection below ${SLOW_FPS} fps; switching to the lite model`);
    this.slowSince = null;
    this.busy = true;
    try {
      if (this.worker) {
        await this.initWorker('lite');
        this.backend = 'worker-gpu-lite';
      } else {
        this.landmarker?.close();
        this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'GPU' });
        this.backend = 'main-gpu-lite';
      }
    } catch (err) {
      console.warn('Could not switch to the lite model:', err);
      this.backend = this.backend.replace('-full', '-full-slow');
    } finally {
      this.busy = false;
    }
  }
}
```

- [ ] **Step 6: Write `src/pose/replaySource.ts`**

```ts
import { decodeFixture, type PoseFixture } from './fixtures';
import type { PoseSource } from './poseSource';
import type { PoseFrame } from './types';

/** Plays recorded frames in real time, looping by default. Timestamps keep increasing across loops. */
export class ReplayPoseSource implements PoseSource {
  readonly backend = 'replay';
  private raf = 0;
  private running = false;

  constructor(
    private frames: PoseFrame[],
    private loop = true,
  ) {}

  static async load(url: string, loop = true): Promise<ReplayPoseSource> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Replay fixture not found: ${url}`);
    return new ReplayPoseSource(decodeFixture((await res.json()) as PoseFixture), loop);
  }

  async start(onFrame: (f: PoseFrame) => void): Promise<void> {
    const frames = this.frames;
    if (!frames.length) return;
    this.running = true;
    const t0 = performance.now();
    const duration = frames[frames.length - 1].t + 1000 / 30;
    let i = 0;
    let offset = 0;
    const tick = () => {
      if (!this.running) return;
      const elapsed = performance.now() - t0;
      while (i < frames.length && frames[i].t + offset <= elapsed) {
        onFrame({ ...frames[i], t: t0 + frames[i].t + offset });
        i++;
      }
      if (i >= frames.length) {
        if (!this.loop) return;
        i = 0;
        offset += duration;
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
```

- [ ] **Step 7: Type-check and run the tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass and there are no type errors.

If `requestVideoFrameCallback` is missing from the DOM lib typings, add `src/pose/dom-extras.d.ts` declaring it on `HTMLVideoElement`:

```ts
interface HTMLVideoElement {
  requestVideoFrameCallback(cb: (now: number, meta: unknown) => void): number;
  cancelVideoFrameCallback(handle: number): void;
}
```

- [ ] **Step 8: Commit**

```bash
git add src/pose tests/pose
git commit -m "feat(pose): add camera, MediaPipe worker and pose sources"
```

---
### Task 11: Pose debug page

**Files:**
- Create: `debug.html`, `src/debug/main.ts`, `src/debug/overlay.ts`, `src/debug/debug.css`

**Interfaces:**
- Consumes:
  - `PoseController` (Task 8), `DEFAULT_THRESHOLDS` (Task 1), `FixtureRecorder` (Task 9)
  - Camera helpers, `LivePoseSource`, `ReplayPoseSource`, `PoseSource` (Task 10)
  - `TRACKED_INDICES` (Task 1), `Baseline` (Task 4)
- Produces:
  - `/debug.html`, and `/debug.html?replay=<fixture-name>`, which loads `/tests/fixtures/<name>.json`
  - `drawOverlay(ctx, view, status, baseline, th)`

- [ ] **Step 1: Write `debug.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Subway IRL — Pose Debug</title>
    <link rel="stylesheet" href="/src/debug/debug.css" />
  </head>
  <body>
    <main class="debug">
      <section class="stage" id="stage">
        <video id="video" playsinline muted></video>
        <canvas id="overlay"></canvas>
        <div id="banner" class="banner" hidden></div>
      </section>
      <aside class="panel">
        <h1>Pose Debug</h1>
        <label class="field">Camera <select id="camera"></select></label>
        <div class="field-row">
          <label class="field">Mode
            <select id="mode">
              <option value="">Auto</option>
              <option value="full">Full body</option>
              <option value="small">Small room</option>
            </select>
          </label>
          <label class="field">Sensitivity <output id="sensOut">1.00</output>
            <input id="sens" type="range" min="0.75" max="1.25" step="0.05" value="1" />
          </label>
        </div>
        <div class="buttons">
          <button id="recalibrate" type="button">Recalibrate</button>
          <button id="record" type="button">● Record</button>
        </div>
        <dl id="status" class="status"></dl>
        <details>
          <summary>Thresholds</summary>
          <div id="thresholds" class="thresholds"></div>
        </details>
        <h2>Events</h2>
        <ol id="log" class="log"></ol>
      </aside>
    </main>
    <script type="module" src="/src/debug/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `src/debug/debug.css`**

```css
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: #171a21;
  --line: #2a2f3a;
  --text: #e7e9ee;
  --muted: #8b93a4;
  --accent: #ffb020;
  --ok: #3ecf8e;
  --bad: #ff5d5d;
  font: 14px/1.4 system-ui, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.debug { display: grid; grid-template-columns: 1fr 360px; height: 100vh; }
.stage { position: relative; background: #000; overflow: hidden; }
.stage video, .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.stage video { object-fit: contain; transform: scaleX(-1); }
.banner {
  position: absolute; left: 50%; top: 24px; transform: translateX(-50%);
  background: rgba(20, 20, 20, 0.85); border: 1px solid var(--accent);
  padding: 10px 16px; border-radius: 8px; max-width: 80%;
}
.panel { background: var(--panel); border-left: 1px solid var(--line); padding: 16px; overflow-y: auto; }
h1 { font-size: 18px; margin: 0 0 12px; }
h2 { font-size: 14px; margin: 16px 0 6px; color: var(--muted); }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; color: var(--muted); flex: 1; }
.field-row { display: flex; gap: 12px; }
select, input, button { font: inherit; color: var(--text); background: #0f1115; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
button { cursor: pointer; }
button:hover { border-color: var(--accent); }
button.recording { background: var(--bad); border-color: var(--bad); }
.buttons { display: flex; gap: 8px; margin-bottom: 12px; }
.status { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
.status dt { color: var(--muted); }
.status dd { margin: 0; font-variant-numeric: tabular-nums; }
.thresholds { display: grid; grid-template-columns: 1fr 90px; gap: 4px 8px; margin-top: 8px; }
.thresholds label { color: var(--muted); align-self: center; }
.log { margin: 0; padding-left: 0; list-style: none; font-family: ui-monospace, monospace; font-size: 12px; }
.log li { padding: 2px 0; border-bottom: 1px solid var(--line); }
.log li:first-child { color: var(--accent); }
@media (max-width: 800px) {
  .debug { grid-template-columns: 1fr; grid-template-rows: 60vh auto; height: auto; }
}
```

- [ ] **Step 3: Write `src/debug/overlay.ts`**

```ts
import type { Baseline } from '../pose/calibration';
import { TRACKED_INDICES } from '../pose/landmarks';
import type { Thresholds } from '../pose/thresholds';
import type { PoseStatus } from '../pose/types';

const CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12],
];

export interface View {
  width: number;
  height: number;
  /** Image aspect ratio (width / height). */
  aspect: number;
}

/** Draws the skeleton and detection guides, letterboxed like `object-fit: contain`. */
export function drawOverlay(ctx: CanvasRenderingContext2D, view: View, st: PoseStatus, base: Baseline | null, th: Thresholds): void {
  const { width, height, aspect } = view;
  ctx.clearRect(0, 0, width, height);
  const imgW = Math.min(width, height * aspect);
  const imgH = imgW / aspect;
  const ox = (width - imgW) / 2;
  const oy = (height - imgH) / 2;
  // Height units → pixels: x is stored as x * aspect.
  const px = (xh: number) => ox + (xh / aspect) * imgW;
  const py = (y: number) => oy + y * imgH;

  if (base) {
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    if (base.mode === 'full') {
      const T = base.torso;
      ctx.strokeStyle = 'rgba(255,176,32,0.8)';
      for (const dx of [-th.laneEnter, th.laneEnter]) line(ctx, px(base.hip.x + dx * T), oy, px(base.hip.x + dx * T), oy + imgH);
      ctx.strokeStyle = 'rgba(62,207,142,0.8)';
      line(ctx, ox, py(base.hip.y - th.jumpRise * T), ox + imgW, py(base.hip.y - th.jumpRise * T));
      ctx.strokeStyle = 'rgba(255,93,93,0.8)';
      line(ctx, ox, py(base.hip.y + th.rollDrop * T), ox + imgW, py(base.hip.y + th.rollDrop * T));
    } else {
      const S = base.shoulderWidth;
      ctx.strokeStyle = 'rgba(255,176,32,0.8)';
      for (const dx of [-th.noseShift, th.noseShift]) line(ctx, px(base.nose.x + dx * S), oy, px(base.nose.x + dx * S), oy + imgH);
      ctx.strokeStyle = 'rgba(255,93,93,0.8)';
      line(ctx, ox, py(base.nose.y + th.duckDrop * S), ox + imgW, py(base.nose.y + th.duckDrop * S));
    }
    ctx.setLineDash([]);
  }

  const pose = st.pose;
  if (pose) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    for (const [a, b] of CONNECTIONS) {
      if (pose[a].visibility < 0.5 || pose[b].visibility < 0.5) continue;
      line(ctx, ox + pose[a].x * imgW, py(pose[a].y), ox + pose[b].x * imgW, py(pose[b].y));
    }
    ctx.fillStyle = '#ffb020';
    for (const i of TRACKED_INDICES) {
      if (pose[i].visibility < 0.5) continue;
      ctx.beginPath();
      ctx.arc(ox + pose[i].x * imgW, py(pose[i].y), 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  if (!st.calibrated) {
    const hint =
      !st.calibration.bodyVisible ? 'Step into view' :
      st.calibration.distance === 'closer' ? 'Come closer' :
      st.calibration.distance === 'back' ? 'Step back — show your knees' :
      `Hold still… ${Math.round(st.calibration.progress * 100)}%`;
    ctx.fillText(hint, ox + 20, oy + 44);
  } else if (st.mode === 'full') {
    ctx.fillText(`Lane ${['LEFT', 'CENTRE', 'RIGHT'][st.lane + 1]}`, ox + 20, oy + 44);
  }
  if (st.jog.active) {
    ctx.fillStyle = '#3ecf8e';
    ctx.fillText(`🏃 ${st.jog.cadenceSpm} spm`, ox + 20, oy + imgH - 24);
  }
  if (st.startProgress > 0) {
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(ox + imgW - 60, oy + 60, 30, -Math.PI / 2, -Math.PI / 2 + st.startProgress * Math.PI * 2);
    ctx.stroke();
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
```

- [ ] **Step 4: Write `src/debug/main.ts`**

```ts
import { describeCameraError, isIrCamera, listCameras, openCamera, pickDefaultCamera } from '../pose/camera';
import { PoseController } from '../pose/controller';
import { FixtureRecorder } from '../pose/fixtures';
import { LivePoseSource } from '../pose/liveSource';
import type { PoseSource } from '../pose/poseSource';
import { ReplayPoseSource } from '../pose/replaySource';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../pose/thresholds';
import type { PlayMode, PoseEvent, PoseFrame } from '../pose/types';
import { drawOverlay } from './overlay';

const CAMERA_KEY = 'subway-irl.cameraId';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('overlay');
const stage = $<HTMLElement>('stage');
const banner = $<HTMLDivElement>('banner');
const cameraSel = $<HTMLSelectElement>('camera');
const modeSel = $<HTMLSelectElement>('mode');
const sens = $<HTMLInputElement>('sens');
const sensOut = $<HTMLOutputElement>('sensOut');
const recordBtn = $<HTMLButtonElement>('record');
const statusEl = $<HTMLDListElement>('status');
const logEl = $<HTMLOListElement>('log');
const ctx = canvas.getContext('2d')!;

const ctrl = new PoseController({ thresholds: { ...DEFAULT_THRESHOLDS } });
const recorder = new FixtureRecorder();
let source: PoseSource | null = null;
let aspect = 4 / 3;
let sourceFps = 0;
const frameTimes: number[] = [];

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function showBanner(text: string | null): void {
  banner.hidden = !text;
  banner.textContent = text ?? '';
}

function describe(e: PoseEvent): string {
  if (e.type === 'lane') return `lane → ${['left', 'centre', 'right'][e.lane + 1]}`;
  if (e.type === 'laneShift') return `lane shift ${e.dir < 0 ? '←' : '→'}`;
  return e.type;
}

function log(e: PoseEvent): void {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${describe(e)}`;
  logEl.prepend(li);
  while (logEl.children.length > 50) logEl.lastElementChild!.remove();
}

function onFrame(f: PoseFrame): void {
  aspect = f.aspect;
  const now = performance.now();
  frameTimes.push(now);
  while (now - frameTimes[0] > 2000) frameTimes.shift();
  sourceFps = frameTimes.length / 2;
  recorder.push(f);
  for (const e of ctrl.update(f)) log(e);
}

function renderStatus(): void {
  const s = ctrl.status;
  const rows: [string, string][] = [
    ['Backend', source?.backend ?? '—'],
    ['Pose fps', `${sourceFps.toFixed(0)}`],
    ['Tracking', s.tracking ? `yes (${(s.confidence * 100).toFixed(0)}%)` : 'no'],
    ['Calibrated', s.calibrated ? `yes — ${s.mode === 'full' ? 'full body' : 'small room'}` : `${Math.round(s.calibration.progress * 100)}% (${s.calibration.distance})`],
    ['Lane', ['left', 'centre', 'right'][s.lane + 1]],
    ['Jogging', s.jog.active ? `yes — ${s.jog.cadenceSpm} spm` : 'no'],
    ['Since step', Number.isFinite(s.jog.msSinceStep) ? `${(s.jog.msSinceStep / 1000).toFixed(1)} s` : '—'],
    ['Steps', `${s.jog.steps}`],
    ['Start hold', `${Math.round(s.startProgress * 100)}%`],
    ['Recording', recorder.recording ? `${recorder.count} frames` : 'off'],
  ];
  statusEl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function render(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay(ctx, { width: w, height: h, aspect }, ctrl.status, ctrl.baseline, ctrl.th);
  renderStatus();
  requestAnimationFrame(render);
}

function buildThresholdInputs(): void {
  const box = $<HTMLDivElement>('thresholds');
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    const label = document.createElement('label');
    label.textContent = key;
    label.htmlFor = `th-${key}`;
    const input = document.createElement('input');
    input.id = `th-${key}`;
    input.type = 'number';
    input.step = key.endsWith('Ms') ? '10' : key.endsWith('Deg') ? '1' : '0.01';
    input.value = String(ctrl.th[key]);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) ctrl.th[key] = v;
    });
    box.append(label, input);
  }
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fillCameras(activeId: string | undefined): Promise<void> {
  const cams = await listCameras();
  cameraSel.replaceChildren(
    ...cams.map((c) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = isIrCamera(c.label) ? `${c.label} (IR — not recommended)` : c.label;
      o.selected = c.deviceId === activeId;
      return o;
    }),
  );
}

async function startCamera(deviceId?: string): Promise<void> {
  source?.stop();
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  try {
    showBanner('Starting camera…');
    let stream = await openCamera(deviceId).catch(() => openCamera());
    const cams = await listCameras();
    const pick = pickDefaultCamera(cams, deviceId ?? store.get(CAMERA_KEY));
    const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (pick && pick.deviceId !== activeId) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await openCamera(pick.deviceId);
    }
    const finalId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (finalId) store.set(CAMERA_KEY, finalId);
    video.srcObject = stream;
    await video.play();
    await fillCameras(finalId);
    showBanner('Loading pose model…');
    const live = new LivePoseSource(video);
    source = live;
    await live.start(onFrame);
    showBanner(null);
  } catch (err) {
    showBanner(describeCameraError(err));
  }
}

async function startReplay(name: string): Promise<void> {
  video.hidden = true;
  cameraSel.disabled = true;
  try {
    const replay = await ReplayPoseSource.load(`/tests/fixtures/${encodeURIComponent(name)}.json`);
    source = replay;
    await replay.start(onFrame);
  } catch (err) {
    showBanner(err instanceof Error ? err.message : String(err));
  }
}

$<HTMLButtonElement>('recalibrate').addEventListener('click', () => ctrl.recalibrate());
modeSel.addEventListener('change', () => {
  ctrl.forcedMode = (modeSel.value || null) as PlayMode | null;
  ctrl.recalibrate();
});
sens.addEventListener('input', () => {
  ctrl.sensitivity = Number(sens.value);
  sensOut.textContent = Number(sens.value).toFixed(2);
});
cameraSel.addEventListener('change', () => void startCamera(cameraSel.value));
recordBtn.addEventListener('click', () => {
  if (!recorder.recording) {
    recorder.start();
    recordBtn.textContent = '■ Stop';
    recordBtn.classList.add('recording');
    return;
  }
  recordBtn.textContent = '● Record';
  recordBtn.classList.remove('recording');
  const name = window.prompt('Fixture name (e.g. full-jog-jump)', 'recording') ?? 'recording';
  const note = window.prompt('What did you do in this recording?', '') ?? '';
  download(name, recorder.stop(name, note));
});

buildThresholdInputs();
requestAnimationFrame(render);
const replay = new URLSearchParams(location.search).get('replay');
void (replay ? startReplay(replay) : startCamera());
```

- [ ] **Step 5: Type-check, build, and run the tests**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: no type errors, all tests pass, and the build writes `dist/index.html` and `dist/debug.html`. If Vite 8 warns that `build.rollupOptions` is deprecated, rename it to `build.rolldownOptions`.

- [ ] **Step 6: Check the page visually with replay**

```bash
cd /home/yash/Projects/SSRealLife
npx vite --port 5173 --strictPort > /tmp/claude-vite.log 2>&1 &   # or run via run_in_background
SHOT=$SCRATCH/debug-full.png
shoot "http://localhost:5173/debug.html?replay=synth-full" "$SHOT" \
  "document.querySelector('#log')?.textContent.includes('lane')" 500
shoot "http://localhost:5173/debug.html?replay=synth-small" "$SCRATCH/debug-small.png" \
  "document.querySelector('#status')?.textContent.includes('small room')" 300
```

Open both PNGs with the Read tool. Check for:
- the skeleton
- dashed guide lines (lane lines in full mode, nose/duck lines in small mode)
- the status panel showing `Backend replay` and a calibrated mode
- event log entries

Fix any issue found, re-shoot, and read the PNGs again. Stop the server afterwards with `kill $(pgrep -f "vite[.]js")` or by stopping the background task.

- [ ] **Step 7: Check that MediaPipe loads (headless, no camera)**

Headless Chrome has no real webcam, so this step only checks that the model loads. Shoot with Chrome's fake camera:

```bash
CHROME_FLAGS="--use-fake-device-for-media-stream --use-fake-ui-for-media-stream" \
shoot "http://localhost:5173/debug.html" "$SCRATCH/debug-live.png" \
  "/worker|main/.test(document.querySelector('#status')?.textContent ?? '')" 1000
```

If `shoot` does not pass extra Chrome flags, use the `chrome-devtools` MCP instead: open the page and read the Backend row and the console messages. Expected: the Backend shows `worker-gpu-full`, `main-gpu-full` or `main-cpu-lite`, and the console has no uncaught errors. If the worker fails, record the reason from the console warning. The fallback is acceptable for Phase 1, but mention it in the report.

- [ ] **Step 8: Commit**

```bash
git add debug.html src/debug
git commit -m "feat(debug): add pose debug page with replay and recording"
```

- [ ] **Step 9: Hand-off to the user for a real-camera check (manual)**

Ask the user to:
1. Run `npm run dev` in WSL and open `http://localhost:5173/debug.html` in **Windows Chrome**.
2. Allow the camera and confirm the FHD webcam is selected.
3. Check the full-body moves: stand still to calibrate, step left and right, jump, squat, jog in place, raise both hands, raise the right hand.
4. Check small-room mode: switch to Small room, then lean, hop, duck and pump arms.
5. Record fixtures with ● Record, one per move set:
   - `full-lanes`, `full-jump`, `full-squat`, `full-jog`, `full-jog-jump`, `full-prejump-dip`
   - `small-lean`, `small-hop`, `small-duck`, `small-pump`
6. Save the files into `tests/fixtures/`.
7. Report the Backend and Pose fps values shown.

Real fixtures then get regression tests like the synthetic ones in Task 9, Step 6, and thresholds get tuned against them.

---

## Later phases (separate plans, written when Phase 1 is done)

2. `game/` simulation with keyboard input and placeholder rendering in `world/`
3. Pose → input wiring, calibration flow, jog rule, full play loop
4. UI screens, HUD, summary, history, settings
5. Asset pipeline, asset brief, Mumbai Local environment, lighting, quality tiers
6. Characters, animations and audio
7. Power-up polish, performance tuning, playtest pass
