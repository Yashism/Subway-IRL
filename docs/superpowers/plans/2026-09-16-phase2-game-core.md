# Subway IRL — Phase 2: Game Core (simulation, keyboard, placeholder 3D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable 3-lane endless runner in the browser. It is driven by the keyboard (pose wiring is Phase 3) and rendered with placeholder 3D shapes. It includes the full Subway Surfers-style rules from spec §5.

**Architecture:**
- **`src/game/`** is a deterministic simulation: fixed 60 Hz steps and a seeded RNG, with no DOM and no three.js. It consumes `GameCommand`s plus an `ActivityStatus` (jogging info) through `src/input/`.
- **Track generation** uses hand-authored 60 m chunks. A frame-accurate solver proves every chunk and every chunk join is passable within the spec's minimum-gap rule. The same solver drives an autopilot, which serves as the integration test and the visual demo.
- **`src/world/`** renders the game state with three.js placeholders, using a floating origin (the runner is always at z = 0).
- **`src/ui/hud.ts`** is a minimal DOM HUD. `src/main.ts` runs the loop.

**Tech Stack:** TypeScript (strict), three.js, Vite 8, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-16-subway-irl-design.md` (§3 module boundaries, §5 gameplay, §6.4 rendering targets, §7 HUD basics, §9 testing)

## Global Constraints

- `game/` must not import from `world/`, `ui/` or `three`. `pose/` must not import from `game/`. `input/` may import types from `pose/`.
- The simulation is deterministic: a fixed step of `1/60` s, all randomness via `Rng(seed)`, no `Math.random()` and no wall-clock reads inside `game/`.
- Lanes are `-1 | 0 | 1` (the `Lane` type from `src/pose/types.ts`) and sit 2.5 m apart. Distance along the track is `s`, in metres.
- Rendering uses a floating origin: world `z = -(itemS - game.s)`, so the runner is at z = 0 and the camera looks toward −z.
- Render pixel ratio ≤ 1.25. AgX tone mapping. One shadow-casting directional light that follows the runner. Target 60 fps.
- Keyboard: ←/A and →/D change lane, ↑/W jump, ↓/S roll, Space hoverboard, Enter start, Esc/P pause, **J held = jogging** (only counts when J-jog is enabled with `?jog`).
- Every game constant lives in `src/game/config.ts` (`TUNING`).
- Never use Playwright. For visual checks, run `shoot <url> <out.png> [readyExpr] [settleMs]` and open every PNG with the Read tool.
- Every commit message ends with a blank line followed by exactly: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

## File Map

| File | Responsibility |
|---|---|
| `src/input/commands.ts` | `GameCommand`, `ActivityStatus`, `CommandSource` |
| `src/input/keyboard.ts` | Keyboard → commands; J-jog activity |
| `src/input/hub.ts` | Merges several command sources |
| `src/game/config.ts` | `TUNING`, `LANE_WIDTH`, `laneX`, `Difficulty` |
| `src/game/rng.ts` | Seeded RNG (mulberry32) |
| `src/game/speed.ts` | Speed curve, minimum action gap, tiers |
| `src/game/runner.ts` | Runner physics: lanes, jump, roll, slam, surfaces, rocket flight |
| `src/game/obstacles.ts` | Obstacle kinds and geometry, moving-train maths |
| `src/game/collision.ts` | Overlap, walkable surfaces, front/side hit classification |
| `src/game/chunks.ts` | The 30 hand-authored track chunks |
| `src/game/solver.ts` | Frame-accurate passability solver and action planner |
| `src/game/track.ts` | Chunk placement, coins, pickups, pruning, moving trains |
| `src/game/powerups.ts` | Magnet / rocket / chappal / hoverboard timers, Josh meter |
| `src/game/rules.ts` | Chaser, stumble tracker, idle clock |
| `src/game/game.ts` | `Game` state machine and per-step integration |
| `src/game/autopilot.ts` | Bot `CommandSource` that uses the solver |
| `src/game/loop.ts` | `FixedStepper` |
| `src/world/worldMath.ts` | Pure placement helpers (sleepers, buildings) |
| `src/world/worldView.ts` | three.js placeholder renderer |
| `src/ui/hud.ts`, `src/ui/hud.css` | Minimal HUD |
| `src/main.ts`, `index.html` | Boot and main loop |
| `tests/input/*.test.ts`, `tests/game/*.test.ts`, `tests/world/*.test.ts` | Tests |

---

### Task 1: Input layer

**Files:**
- Create: `src/input/commands.ts`, `src/input/keyboard.ts`, `src/input/hub.ts`
- Test: `tests/input/keyboard.test.ts`, `tests/input/hub.test.ts`

**Interfaces:**
- Consumes: `Lane` from `src/pose/types.ts` (existing)
- Produces:
  - `GameCommand` (`setLane`, `shiftLane`, `jump`, `roll`, `hoverboard`, `start`, `pause`)
  - `ActivityStatus { tracksJogging; msSinceStep; cadenceSpm; steps; squatting; lost }`
  - `CommandSource { drain(): GameCommand[]; activity(tMs): ActivityStatus }`
  - `KeyboardInput` with `jogEnabled`, `keyDown(e, tMs): boolean`, `keyUp(e, tMs)`, `drain()`, `activity(tMs)` and `attach(target, now?) => detach`
  - `InputHub(sources)`, which is itself a `CommandSource`

- [ ] **Step 1: Write the failing tests**

`tests/input/keyboard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { KeyboardInput } from '../../src/input/keyboard';

describe('KeyboardInput', () => {
  it('maps keys to commands and ignores auto-repeat', () => {
    const k = new KeyboardInput();
    for (const code of ['ArrowLeft', 'KeyD', 'ArrowUp', 'KeyS', 'Space', 'Enter', 'Escape']) k.keyDown({ code }, 0);
    k.keyDown({ code: 'ArrowUp', repeat: true }, 0);
    expect(k.keyDown({ code: 'KeyZ' }, 0)).toBe(false);
    expect(k.drain()).toEqual([
      { type: 'shiftLane', dir: -1 },
      { type: 'shiftLane', dir: 1 },
      { type: 'jump' },
      { type: 'roll' },
      { type: 'hoverboard' },
      { type: 'start' },
      { type: 'pause' },
    ]);
    expect(k.drain()).toEqual([]);
  });

  it('does not track jogging unless enabled', () => {
    expect(new KeyboardInput().activity(0).tracksJogging).toBe(false);
  });

  it('treats holding J as jogging at 160 spm', () => {
    const k = new KeyboardInput();
    k.jogEnabled = true;
    expect(k.activity(0).msSinceStep).toBe(Infinity);
    k.keyDown({ code: 'KeyJ' }, 1000);
    k.keyDown({ code: 'KeyJ', repeat: true }, 1500);
    const on = k.activity(2000);
    expect(on).toMatchObject({ tracksJogging: true, msSinceStep: 0, cadenceSpm: 160, steps: 3 });
    k.keyUp({ code: 'KeyJ' }, 2000);
    const off = k.activity(3500);
    expect(off).toMatchObject({ msSinceStep: 1500, cadenceSpm: 0, steps: 3 });
    expect(k.drain()).toEqual([]);
  });
});
```

`tests/input/hub.test.ts`:
```ts
import { expect, it } from 'vitest';
import type { ActivityStatus, CommandSource, GameCommand } from '../../src/input/commands';
import { InputHub } from '../../src/input/hub';

const source = (cmds: GameCommand[], a: Partial<ActivityStatus>): CommandSource => ({
  drain: () => cmds.splice(0),
  activity: () => ({ tracksJogging: false, msSinceStep: Infinity, cadenceSpm: 0, steps: 0, squatting: false, lost: false, ...a }),
});

it('merges commands and activity', () => {
  const hub = new InputHub([
    source([{ type: 'jump' }], { steps: 2 }),
    source([{ type: 'roll' }], { tracksJogging: true, msSinceStep: 300, cadenceSpm: 150, steps: 5, squatting: true }),
    source([], { tracksJogging: true, msSinceStep: 900, cadenceSpm: 170, lost: true }),
  ]);
  expect(hub.drain()).toEqual([{ type: 'jump' }, { type: 'roll' }]);
  expect(hub.drain()).toEqual([]);
  expect(hub.activity(0)).toEqual({ tracksJogging: true, msSinceStep: 300, cadenceSpm: 170, steps: 7, squatting: true, lost: true });
});

it('reports no jogging when no source tracks it', () => {
  const hub = new InputHub([source([], { cadenceSpm: 200 })]);
  expect(hub.activity(0)).toMatchObject({ tracksJogging: false, msSinceStep: Infinity, cadenceSpm: 0 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/input`
Expected: FAIL because the modules are not found.

- [ ] **Step 3: Write `src/input/commands.ts`**

```ts
import type { Lane } from '../pose/types';

export type GameCommand =
  | { type: 'setLane'; lane: Lane }
  | { type: 'shiftLane'; dir: -1 | 1 }
  | { type: 'jump' }
  | { type: 'roll' }
  | { type: 'hoverboard' }
  | { type: 'start' }
  | { type: 'pause' };

/** Body activity the game reads every step, whatever the input source. */
export interface ActivityStatus {
  /** False when no source measures jogging (plain keyboard): the jog rule is then off. */
  tracksJogging: boolean;
  msSinceStep: number;
  cadenceSpm: number;
  steps: number;
  /** A squat is being held (counts as movement for up to 1 s). */
  squatting: boolean;
  /** The player is out of view: the game pauses. */
  lost: boolean;
}

export interface CommandSource {
  /** Commands since the last call, oldest first. */
  drain(): GameCommand[];
  activity(tMs: number): ActivityStatus;
}
```

- [ ] **Step 4: Write `src/input/keyboard.ts`**

```ts
import type { ActivityStatus, CommandSource, GameCommand } from './commands';

export interface KeyLike {
  code: string;
  repeat?: boolean;
}

/** Holding J jogs at 160 steps per minute. */
const JOG_STEP_MS = 375;

const KEYMAP: Record<string, GameCommand> = {
  ArrowLeft: { type: 'shiftLane', dir: -1 },
  KeyA: { type: 'shiftLane', dir: -1 },
  ArrowRight: { type: 'shiftLane', dir: 1 },
  KeyD: { type: 'shiftLane', dir: 1 },
  ArrowUp: { type: 'jump' },
  KeyW: { type: 'jump' },
  ArrowDown: { type: 'roll' },
  KeyS: { type: 'roll' },
  Space: { type: 'hoverboard' },
  Enter: { type: 'start' },
  Escape: { type: 'pause' },
  KeyP: { type: 'pause' },
};

/** Keyboard controls. With jogEnabled, holding J stands in for jogging in place. */
export class KeyboardInput implements CommandSource {
  jogEnabled = false;
  private queue: GameCommand[] = [];
  private jogStart: number | null = null;
  private jogStoppedAt = -Infinity;
  private stepsBefore = 0;

  /** Returns true when the key is one the game uses (so the caller can preventDefault). */
  keyDown(e: KeyLike, tMs: number): boolean {
    if (e.code === 'KeyJ') {
      this.jogStart ??= tMs;
      return true;
    }
    const cmd = KEYMAP[e.code];
    if (!cmd) return false;
    if (!e.repeat) this.queue.push({ ...cmd });
    return true;
  }

  keyUp(e: KeyLike, tMs: number): void {
    if (e.code !== 'KeyJ' || this.jogStart === null) return;
    this.stepsBefore += this.jogSteps(tMs);
    this.jogStart = null;
    this.jogStoppedAt = tMs;
  }

  drain(): GameCommand[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  activity(tMs: number): ActivityStatus {
    const jogging = this.jogStart !== null;
    return {
      tracksJogging: this.jogEnabled,
      msSinceStep: jogging ? 0 : tMs - this.jogStoppedAt,
      cadenceSpm: jogging ? 160 : 0,
      steps: this.stepsBefore + this.jogSteps(tMs),
      squatting: false,
      lost: false,
    };
  }

  attach(target: EventTarget, now: () => number = () => performance.now()): () => void {
    const down = (e: Event) => {
      if (this.keyDown(e as KeyboardEvent, now())) e.preventDefault();
    };
    const up = (e: Event) => this.keyUp(e as KeyboardEvent, now());
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
    };
  }

  private jogSteps(tMs: number): number {
    return this.jogStart === null ? 0 : Math.floor((tMs - this.jogStart) / JOG_STEP_MS) + 1;
  }
}
```

- [ ] **Step 5: Write `src/input/hub.ts`**

```ts
import type { ActivityStatus, CommandSource, GameCommand } from './commands';

/** Combines keyboard, pose and bot sources into one. */
export class InputHub implements CommandSource {
  constructor(readonly sources: CommandSource[]) {}

  drain(): GameCommand[] {
    return this.sources.flatMap((s) => s.drain());
  }

  activity(tMs: number): ActivityStatus {
    const all = this.sources.map((s) => s.activity(tMs));
    const jog = all.filter((a) => a.tracksJogging);
    return {
      tracksJogging: jog.length > 0,
      msSinceStep: jog.length ? Math.min(...jog.map((a) => a.msSinceStep)) : Infinity,
      cadenceSpm: Math.max(0, ...jog.map((a) => a.cadenceSpm)),
      steps: all.reduce((n, a) => n + a.steps, 0),
      squatting: all.some((a) => a.squatting),
      lost: all.some((a) => a.lost),
    };
  }
}
```

- [ ] **Step 6: Run the tests and type check**

Run: `npx vitest run tests/input && npx tsc --noEmit`
Expected: all pass and the type check is clean.

- [ ] **Step 7: Commit**

```bash
git add src/input tests/input
git commit -m "feat(input): add keyboard commands and input hub"
```

---

### Task 2: Config, RNG, speed curve and tiers

**Files:**
- Create: `src/game/config.ts`, `src/game/rng.ts`, `src/game/speed.ts`
- Test: `tests/game/speed.test.ts`, `tests/game/rng.test.ts`

**Interfaces:**
- Produces:
  - Config: `LANE_WIDTH`, `laneX(lane)`, `Difficulty` (`'chill' | 'cardio' | 'beast'`), `DIFFICULTY`, `TUNING`
  - RNG: `Rng(seed)` with `next()`, `int(n)`, `pick(items)`, `chance(p)`
  - Speed: `topSpeed(d)`, `speedAt(tSec, d)`, `speedFraction(speed, d)`, `minGapAt(speed, d)`
  - Tiers: `Tier` (`0 | 1 | 2 | 3 | 4`, where 0 = warm-up), `tierFor(tSec, d)`, `TIER_FRACTIONS`

- [ ] **Step 1: Write the failing tests**

`tests/game/rng.test.ts`:
```ts
import { expect, it } from 'vitest';
import { Rng } from '../../src/game/rng';

it('is deterministic per seed and stays in range', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const xs = Array.from({ length: 1000 }, () => a.next());
  expect(Array.from({ length: 1000 }, () => b.next())).toEqual(xs);
  expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  expect(new Rng(43).next()).not.toBe(xs[0]);
});

it('picks, draws integers and flips coins', () => {
  const r = new Rng(7);
  const seen = new Set(Array.from({ length: 200 }, () => r.int(3)));
  expect([...seen].sort()).toEqual([0, 1, 2]);
  expect(['a', 'b']).toContain(r.pick(['a', 'b']));
  expect(new Rng(1).chance(0)).toBe(false);
  expect(new Rng(1).chance(1)).toBe(true);
});
```

`tests/game/speed.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { laneX, TUNING } from '../../src/game/config';
import { minGapAt, speedAt, speedFraction, tierFor, topSpeed } from '../../src/game/speed';

describe('speed curve', () => {
  it('starts at 12 m/s and reaches top speed after the ramp', () => {
    expect(speedAt(0, 'cardio')).toBe(12);
    expect(speedAt(240, 'cardio')).toBeCloseTo(30, 6);
    expect(speedAt(400, 'cardio')).toBeCloseTo(30, 6);
    expect(topSpeed('chill')).toBeCloseTo(24, 6);
    expect(topSpeed('beast')).toBeCloseTo(36, 6);
    expect(speedAt(200, 'beast')).toBeCloseTo(36, 6);
  });

  it('never slows down', () => {
    let prev = 0;
    for (let t = 0; t <= 300; t += 5) {
      const v = speedAt(t, 'cardio');
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('tightens the minimum action gap from 1.2 s to 0.8 s', () => {
    expect(minGapAt(12, 'cardio')).toBeCloseTo(1.2, 6);
    expect(minGapAt(30, 'cardio')).toBeCloseTo(0.8, 6);
    expect(minGapAt(21, 'cardio')).toBeCloseTo(1.0, 6);
    expect(speedFraction(50, 'cardio')).toBe(1);
  });

  it('uses warm-up for the first 20 s, then tiers by speed', () => {
    expect(tierFor(0, 'cardio')).toBe(0);
    expect(tierFor(19.9, 'cardio')).toBe(0);
    expect(tierFor(20, 'cardio')).toBe(1);
    expect(tierFor(240, 'cardio')).toBe(4);
    const tiers = Array.from({ length: 241 }, (_, t) => tierFor(t, 'cardio'));
    expect(tiers.every((x, i) => i === 0 || x >= tiers[i - 1])).toBe(true);
  });

  it('places lanes 2.5 m apart', () => {
    expect(laneX(-1)).toBe(-2.5);
    expect(laneX(1)).toBe(2.5);
    expect(TUNING.stepHz).toBe(60);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/game`
Expected: FAIL because the modules are not found.

- [ ] **Step 3: Write `src/game/config.ts`**

```ts
export const LANE_WIDTH = 2.5;
export const laneX = (lane: number): number => lane * LANE_WIDTH;

export type Difficulty = 'chill' | 'cardio' | 'beast';

/** Multipliers on top speed and on how fast the speed ramps up. */
export const DIFFICULTY: Record<Difficulty, { speed: number; ramp: number }> = {
  chill: { speed: 0.8, ramp: 0.8 },
  cardio: { speed: 1, ramp: 1 },
  beast: { speed: 1.2, ramp: 1.2 },
};

/** Every gameplay constant. Distances in metres, times in seconds unless named *Ms. */
export const TUNING = {
  stepHz: 60,
  // speed
  startSpeed: 12,
  topSpeed: 30,
  rampSeconds: 240,
  warmupSeconds: 20,
  minGapStart: 1.2,
  minGapFloor: 0.8,
  // runner
  laneChangeSeconds: 0.15,
  jumpSeconds: 0.6,
  jumpHeight: 1.2,
  chappalJumpSeconds: 0.9,
  chappalJumpHeight: 3.8,
  rollSeconds: 0.6,
  slamSpeed: 25,
  runnerHeight: 1.8,
  rollHeight: 0.8,
  runnerHalfWidth: 0.4,
  runnerHalfDepth: 0.4,
  rocketHeight: 6,
  rocketClimbSpeed: 8,
  // world
  trainHeight: 3.2,
  oncomingTrainSpeed: 10,
  coinSpacing: 3,
  coinHeight: 0.8,
  pickupChance: 0.35,
  // rules
  stumbleWindowSeconds: 8,
  idleWarnMs: 1000,
  idleCaughtMs: 2000,
  squatIdleCreditMs: 1000,
  catchSeconds: 1.5,
  countdownSeconds: 3,
  // power-ups
  hoverboardsPerRun: 3,
  hoverboardSeconds: 30,
  crashGraceSeconds: 1,
  magnetSeconds: 10,
  magnetRange: 30,
  rocketSeconds: 8,
  rocketLandingClearSeconds: 1,
  chappalSeconds: 10,
  joshCadence: 160,
  joshFillSeconds: 5,
  joshDrainSeconds: 3,
  // chaser
  chaserStartGap: 1.5,
  chaserNearGap: 3,
  chaserFarGap: 12,
};
```

- [ ] **Step 4: Write `src/game/rng.ts`**

```ts
/** Small seeded PRNG (mulberry32). The only source of randomness in game/. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
```

- [ ] **Step 5: Write `src/game/speed.ts`**

```ts
import { DIFFICULTY, TUNING, type Difficulty } from './config';

export type Tier = 0 | 1 | 2 | 3 | 4;

/** Speed-fraction ranges for tiers 1–4 (tier 0 is the warm-up). */
export const TIER_FRACTIONS: Record<1 | 2 | 3 | 4, [number, number]> = {
  1: [0, 0.25],
  2: [0.25, 0.5],
  3: [0.5, 0.75],
  4: [0.75, 1],
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const topSpeed = (d: Difficulty): number => TUNING.topSpeed * DIFFICULTY[d].speed;

/** Eases from the start speed up to the difficulty's top speed over the ramp. */
export function speedAt(tSec: number, d: Difficulty): number {
  const u = clamp01((tSec * DIFFICULTY[d].ramp) / TUNING.rampSeconds);
  const eased = 1 - (1 - u) ** 2;
  return TUNING.startSpeed + (topSpeed(d) - TUNING.startSpeed) * eased;
}

export const speedFraction = (speed: number, d: Difficulty): number =>
  clamp01((speed - TUNING.startSpeed) / (topSpeed(d) - TUNING.startSpeed));

/** Minimum time between moves the track may demand at this speed. */
export const minGapAt = (speed: number, d: Difficulty): number =>
  TUNING.minGapStart + (TUNING.minGapFloor - TUNING.minGapStart) * speedFraction(speed, d);

export function tierFor(tSec: number, d: Difficulty): Tier {
  if (tSec < TUNING.warmupSeconds) return 0;
  const f = speedFraction(speedAt(tSec, d), d);
  return f < 0.25 ? 1 : f < 0.5 ? 2 : f < 0.75 ? 3 : 4;
}
```

- [ ] **Step 6: Run the tests and type check**

Run: `npx vitest run tests/game && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/game tests/game
git commit -m "feat(game): add tuning, seeded rng and speed curve"
```

---
### Task 3: Runner physics

**Files:**
- Create: `src/game/runner.ts`
- Test: `tests/game/runner.test.ts`

**Interfaces:**
- Consumes: `TUNING`, `LANE_WIDTH`, `laneX` (Task 2); `Lane` (pose types)
- Produces:
  - Jumps: `JumpProfile`, `NORMAL_JUMP`, `CHAPPAL_JUMP`, `jumpHeightAt(tSec, profile)`
  - `class Runner`
    - fields: `lane`, `prevLane`, `x`, `y`, `vy`, `airborne`, `flying`, `rollLeft`
    - getters: `rolling`, `height`, `changingLane`
    - methods: `setLane(l)`, `shiftLane(dir)`, `bounceBack()`, `jump(profile?)`, `roll()`, `update(dt, surface)`
  - Vertical motion uses the exact constant-acceleration update (`y += vy*dt - g*dt²/2`), so jump heights at frame times match `jumpHeightAt` exactly. The solver relies on this.

- [ ] **Step 1: Write the failing test `tests/game/runner.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { CHAPPAL_JUMP, jumpHeightAt, NORMAL_JUMP, Runner } from '../../src/game/runner';

const DT = 1 / 60;
function run(r: Runner, frames: number, surface = 0) {
  for (let i = 0; i < frames; i++) r.update(DT, surface);
}

describe('Runner lanes', () => {
  it('slides to the new lane in 0.15 s', () => {
    const r = new Runner();
    expect(r.setLane(1)).toBe(true);
    run(r, 7);
    expect(r.changingLane).toBe(true);
    run(r, 2);
    expect(r.x).toBeCloseTo(2.5, 9);
    expect(r.changingLane).toBe(false);
  });

  it('clamps at the edges and bounces back to the previous lane', () => {
    const r = new Runner();
    expect(r.shiftLane(1)).toBe(true);
    expect(r.shiftLane(1)).toBe(false);
    expect(r.setLane(1)).toBe(false);
    r.bounceBack();
    expect(r.lane).toBe(0);
    expect(r.prevLane).toBe(1);
  });
});

describe('Runner jump and roll', () => {
  it('follows the analytic jump arc at frame times', () => {
    const r = new Runner();
    expect(r.jump()).toBe(true);
    expect(r.jump()).toBe(false);
    for (let f = 1; f < 36; f++) {
      r.update(DT, 0);
      expect(r.y).toBeCloseTo(jumpHeightAt(f * DT, NORMAL_JUMP), 9);
    }
    r.update(DT, 0);
    expect(r.y).toBe(0);
    expect(r.airborne).toBe(false);
    expect(jumpHeightAt(0.3, NORMAL_JUMP)).toBeCloseTo(TUNING.jumpHeight, 9);
  });

  it('rolls for 0.6 s at reduced height', () => {
    const r = new Runner();
    r.roll();
    expect(r.height).toBe(TUNING.rollHeight);
    run(r, 35);
    expect(r.rolling).toBe(true);
    run(r, 2);
    expect(r.rolling).toBe(false);
    expect(r.height).toBe(TUNING.runnerHeight);
  });

  it('slams down when rolling in the air and rolls on landing', () => {
    const r = new Runner();
    r.jump();
    run(r, 6);
    r.roll();
    let frames = 0;
    while (r.airborne && frames < 60) {
      r.update(DT, 0);
      frames++;
    }
    expect(frames).toBeLessThan(6);
    expect(r.rolling).toBe(true);
  });

  it('cancels a roll with a jump', () => {
    const r = new Runner();
    r.roll();
    run(r, 5);
    expect(r.jump()).toBe(true);
    expect(r.rolling).toBe(false);
  });

  it('jumps much higher with chappals', () => {
    const r = new Runner();
    r.jump(CHAPPAL_JUMP);
    run(r, 27);
    expect(r.y).toBeCloseTo(TUNING.chappalJumpHeight, 6);
  });
});

describe('Runner surfaces and flight', () => {
  it('walks up to a surface and falls when it ends', () => {
    const r = new Runner();
    r.update(DT, 0.2);
    expect(r.y).toBeCloseTo(0.2, 9);
    r.y = TUNING.trainHeight;
    r.update(DT, TUNING.trainHeight);
    expect(r.airborne).toBe(false);
    r.update(DT, 0);
    expect(r.airborne).toBe(true);
    run(r, 40);
    expect(r.y).toBe(0);
    expect(r.airborne).toBe(false);
  });

  it('lands on a higher surface when falling onto it', () => {
    const r = new Runner();
    r.jump(CHAPPAL_JUMP);
    run(r, 30, 0); // past the 3.8 m peak, still above the roof
    run(r, 30, TUNING.trainHeight);
    expect(r.y).toBe(TUNING.trainHeight);
    expect(r.airborne).toBe(false);
  });

  it('climbs to rocket height while flying and falls afterwards', () => {
    const r = new Runner();
    r.flying = true;
    expect(r.jump()).toBe(false);
    run(r, 60);
    expect(r.y).toBe(TUNING.rocketHeight);
    r.flying = false;
    run(r, 60);
    expect(r.y).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/game/runner.test.ts`
Expected: FAIL because the module is not found.

- [ ] **Step 3: Write `src/game/runner.ts`**

```ts
import type { Lane } from '../pose/types';
import { LANE_WIDTH, laneX, TUNING } from './config';

export interface JumpProfile {
  seconds: number;
  height: number;
}

export const NORMAL_JUMP: JumpProfile = { seconds: TUNING.jumpSeconds, height: TUNING.jumpHeight };
export const CHAPPAL_JUMP: JumpProfile = { seconds: TUNING.chappalJumpSeconds, height: TUNING.chappalJumpHeight };

/** Height above take-off t seconds into a jump (0 outside the jump). */
export function jumpHeightAt(t: number, p: JumpProfile): number {
  if (t <= 0 || t >= p.seconds) return 0;
  const u = t / p.seconds;
  return 4 * p.height * u * (1 - u);
}

const gravityOf = (p: JumpProfile) => (8 * p.height) / p.seconds ** 2;
const launchSpeedOf = (p: JumpProfile) => (4 * p.height) / p.seconds;
const clampLane = (n: number): Lane => (n < -1 ? -1 : n > 1 ? 1 : n) as Lane;
/** A runner this far from its lane centre is visibly changing lanes. */
const SETTLED_X = 0.3;

export class Runner {
  lane: Lane = 0;
  prevLane: Lane = 0;
  x = 0;
  /** Height of the feet above the ground. */
  y = 0;
  vy = 0;
  airborne = false;
  /** Rocket power-up: hovering at rocket height. */
  flying = false;
  rollLeft = 0;
  private gravity = gravityOf(NORMAL_JUMP);
  private rollOnLanding = false;

  get rolling(): boolean {
    return this.rollLeft > 0;
  }

  get height(): number {
    return this.rolling ? TUNING.rollHeight : TUNING.runnerHeight;
  }

  get changingLane(): boolean {
    return Math.abs(this.x - laneX(this.lane)) > SETTLED_X;
  }

  setLane(lane: Lane): boolean {
    if (lane === this.lane) return false;
    this.prevLane = this.lane;
    this.lane = lane;
    return true;
  }

  shiftLane(dir: -1 | 1): boolean {
    return this.setLane(clampLane(this.lane + dir));
  }

  /** Stumble: head back to the lane we came from. */
  bounceBack(): void {
    const back = this.prevLane;
    this.prevLane = this.lane;
    this.lane = back;
  }

  jump(profile: JumpProfile = NORMAL_JUMP): boolean {
    if (this.airborne || this.flying) return false;
    this.rollLeft = 0;
    this.rollOnLanding = false;
    this.airborne = true;
    this.vy = launchSpeedOf(profile);
    this.gravity = gravityOf(profile);
    return true;
  }

  roll(): boolean {
    if (this.flying) return false;
    if (this.airborne) {
      this.vy = Math.min(this.vy, -TUNING.slamSpeed);
      this.rollOnLanding = true;
      return true;
    }
    this.rollLeft = TUNING.rollSeconds;
    return true;
  }

  /** `surface` is the height of whatever is under the runner (0 = ground). */
  update(dt: number, surface: number): void {
    const target = laneX(this.lane);
    const step = (LANE_WIDTH / TUNING.laneChangeSeconds) * dt;
    this.x = Math.abs(target - this.x) <= step + 1e-9 ? target : this.x + Math.sign(target - this.x) * step;

    if (this.rollLeft > 0) this.rollLeft = Math.max(0, this.rollLeft - dt);

    if (this.flying) {
      const climb = TUNING.rocketClimbSpeed * dt;
      const gap = TUNING.rocketHeight - this.y;
      this.y = Math.abs(gap) <= climb ? TUNING.rocketHeight : this.y + Math.sign(gap) * climb;
      this.vy = 0;
      this.airborne = true;
      this.gravity = gravityOf(NORMAL_JUMP);
      return;
    }

    if (!this.airborne) {
      if (surface >= this.y - 0.05) {
        this.y = surface;
        return;
      }
      this.airborne = true;
      this.vy = 0;
      this.gravity = gravityOf(NORMAL_JUMP);
    }

    const next = this.y + this.vy * dt - 0.5 * this.gravity * dt * dt;
    this.vy -= this.gravity * dt;
    if (this.vy <= 0 && next <= surface + 1e-9) {
      this.y = surface;
      this.vy = 0;
      this.airborne = false;
      if (this.rollOnLanding) {
        this.rollOnLanding = false;
        this.rollLeft = TUNING.rollSeconds;
      }
    } else {
      this.y = next;
    }
  }
}
```

Notes for the implementer:
- In the "follows the analytic jump arc" test, frame 36 lands exactly at t = 0.6 s. There, `next` is 0 up to float error and `vy` < 0, so the runner lands.
- In the rocket test, the fall from 6 m takes about 0.67 s (40 frames), so 60 frames is enough.
- If float error makes a boundary assertion flaky, fix the physics tolerance (the `1e-9` terms), not the assertion.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/game/runner.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/game/runner.ts tests/game/runner.test.ts
git commit -m "feat(game): add runner physics"
```

---

### Task 4: Obstacles and collision

**Files:**
- Create: `src/game/obstacles.ts`, `src/game/collision.ts`
- Test: `tests/game/collision.test.ts`

**Interfaces:**
- Consumes: `TUNING`, `laneX` (Task 2); `Lane`
- Produces:
  - `ObstacleKind`, `ObstacleAction`, `ObstacleInfo`, `OBSTACLES`
  - `ObstacleSpec { kind; lane; s; length? }`: for `trainMoving`, `s` is the meeting point (where the train's front will be when the runner gets there)
  - `Obstacle { id; kind; lane; length; front }`: `front` is the current near end
  - `lengthOf(spec)`, `movingFrontAt(meetS, runnerS, runnerSpeed)`, `meetPointOf(front, runnerS, runnerSpeed)`
  - `RunnerBox { s; x; y; height }`, `overlaps(box, o)`, `surfaceAt(box, obstacles)`
  - `Hit { kind: 'front' | 'side'; obstacle }`, `findHit(box, lane, changingLane, obstacles)`

  Rules:
  - A ramp rises to train height over its first `length − 1` m.
  - A train roof supports the runner while any part of the runner is over it. This stops a crash on the lip when running off the end.
  - A surface only counts if it's at most 0.5 m above the runner's feet.
  - Obstacles in any lane other than the runner's target lane are ignored.
  - A target-lane overlap while changing lanes is a `side` hit; otherwise it is a `front` hit.

- [ ] **Step 1: Write the failing test `tests/game/collision.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { findHit, overlaps, surfaceAt } from '../../src/game/collision';
import { meetPointOf, movingFrontAt, type Obstacle, type ObstacleKind } from '../../src/game/obstacles';
import type { Lane } from '../../src/pose/types';

let nextId = 1;
const ob = (kind: ObstacleKind, lane: Lane, front: number, length: number): Obstacle => ({ id: nextId++, kind, lane, front, length });
const box = (s: number, x = 0, y = 0, height = TUNING.runnerHeight) => ({ s, x, y, height });

describe('overlaps', () => {
  const barrier = ob('barrierLow', 0, 10, 0.5);
  const banner = ob('bannerHigh', 0, 10, 0.5);

  it('hits a low barrier on the ground but not above it', () => {
    expect(overlaps(box(10.2), barrier)).toBe(true);
    expect(overlaps(box(10.2, 0, 1.05), barrier)).toBe(false);
    expect(overlaps(box(9.5), barrier)).toBe(false);
    expect(overlaps(box(10.2, 2.5), barrier)).toBe(false);
    expect(overlaps(box(10.2, 1.1), barrier)).toBe(true);
  });

  it('lets a rolling runner under a banner but not a jumping one', () => {
    expect(overlaps(box(10.2, 0, 0, TUNING.rollHeight), banner)).toBe(false);
    expect(overlaps(box(10.2), banner)).toBe(true);
    expect(overlaps(box(10.2, 0, 1.2), banner)).toBe(true);
  });

  it('never collides with ramps, nor with a train from its roof', () => {
    expect(overlaps(box(12), ob('ramp', 0, 10, 8))).toBe(false);
    const train = ob('trainParked', 0, 20, 30);
    expect(overlaps(box(25), train)).toBe(true);
    expect(overlaps(box(25, 0, TUNING.trainHeight), train)).toBe(false);
  });
});

describe('surfaceAt', () => {
  const ramp = ob('ramp', 0, 10, 8);
  const train = ob('trainParked', 0, 18, 30);
  const all = [ramp, train];

  it('rises along a ramp and reaches train height before the train starts', () => {
    expect(surfaceAt(box(10), all)).toBe(0);
    expect(surfaceAt(box(13.5, 0, 1.2), all)).toBeCloseTo(TUNING.trainHeight / 2, 6);
    expect(surfaceAt(box(17, 0, 3.0), all)).toBeCloseTo(TUNING.trainHeight, 6);
  });

  it('holds the runner on the roof until its back edge leaves the train', () => {
    expect(surfaceAt(box(30, 0, 3.2), all)).toBe(TUNING.trainHeight);
    expect(surfaceAt(box(48.3, 0, 3.2), all)).toBe(TUNING.trainHeight);
    expect(surfaceAt(box(48.5, 0, 3.2), all)).toBe(0);
  });

  it('ignores surfaces that are too high or in another lane', () => {
    expect(surfaceAt(box(30, 0, 0), all)).toBe(0);
    expect(surfaceAt(box(30, 2.5, 3.2), all)).toBe(0);
  });
});

describe('findHit', () => {
  it('classifies head-on and lane-change hits', () => {
    const auto = ob('auto', 1, 10, 3);
    expect(findHit(box(10.5, 2.5), 1, false, [auto])).toMatchObject({ kind: 'front' });
    expect(findHit(box(10.5, 1.5), 1, true, [auto])).toMatchObject({ kind: 'side' });
    expect(findHit(box(10.5, 1.5), 0, true, [auto])).toBeNull();
    expect(findHit(box(5, 2.5), 1, false, [auto])).toBeNull();
  });
});

describe('moving trains', () => {
  it('converts between meeting point and current front', () => {
    const front = movingFrontAt(100, 40, 20);
    expect(front).toBeCloseTo(100 + 60 * 0.5, 9);
    expect(meetPointOf(front, 40, 20)).toBeCloseTo(100, 9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/game/collision.test.ts`
Expected: FAIL because the modules are not found.

- [ ] **Step 3: Write `src/game/obstacles.ts`**

```ts
import type { Lane } from '../pose/types';
import { TUNING } from './config';

export type ObstacleKind =
  | 'trainParked'
  | 'trainMoving'
  | 'barrierLow'
  | 'handcart'
  | 'bannerHigh'
  | 'auto'
  | 'cow'
  | 'ramp';

/** What the player must do: leave the lane, jump, roll, or nothing (ramps). */
export type ObstacleAction = 'lane' | 'jump' | 'roll' | 'none';

export interface ObstacleInfo {
  length: number;
  yMin: number;
  yMax: number;
  /** Height you can stand on (train roof / top of a ramp), or null. */
  walkTop: number | null;
  action: ObstacleAction;
  moving: boolean;
}

const H = TUNING.trainHeight;

export const OBSTACLES: Record<ObstacleKind, ObstacleInfo> = {
  trainParked: { length: 30, yMin: 0, yMax: H, walkTop: H, action: 'lane', moving: false },
  trainMoving: { length: 30, yMin: 0, yMax: H, walkTop: null, action: 'lane', moving: true },
  barrierLow: { length: 0.5, yMin: 0, yMax: 1.0, walkTop: null, action: 'jump', moving: false },
  handcart: { length: 1.5, yMin: 0, yMax: 1.1, walkTop: null, action: 'jump', moving: false },
  bannerHigh: { length: 0.5, yMin: 1.0, yMax: 3.0, walkTop: null, action: 'roll', moving: false },
  auto: { length: 3, yMin: 0, yMax: 2.0, walkTop: null, action: 'lane', moving: false },
  cow: { length: 2.5, yMin: 0, yMax: 1.6, walkTop: null, action: 'lane', moving: false },
  ramp: { length: 8, yMin: 0, yMax: 0, walkTop: H, action: 'none', moving: false },
};

export interface ObstacleSpec {
  kind: ObstacleKind;
  lane: Lane;
  /** Near end along the track. For trainMoving: where its front meets the runner. */
  s: number;
  length?: number;
}

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  lane: Lane;
  length: number;
  /** Current near end along the track. */
  front: number;
}

export const lengthOf = (spec: ObstacleSpec): number => spec.length ?? OBSTACLES[spec.kind].length;

/** Front of an oncoming train, with the runner at runnerS, that will meet the runner at meetS. */
export function movingFrontAt(meetS: number, runnerS: number, runnerSpeed: number): number {
  const k = TUNING.oncomingTrainSpeed / runnerSpeed;
  return meetS + (meetS - runnerS) * k;
}

/** Inverse of movingFrontAt. */
export function meetPointOf(front: number, runnerS: number, runnerSpeed: number): number {
  const k = TUNING.oncomingTrainSpeed / runnerSpeed;
  return (front + k * runnerS) / (1 + k);
}
```

- [ ] **Step 4: Write `src/game/collision.ts`**

```ts
import type { Lane } from '../pose/types';
import { laneX, TUNING } from './config';
import { OBSTACLES, type Obstacle } from './obstacles';

/** Half-width of every obstacle across the track. */
const OBSTACLE_HALF_WIDTH = 0.8;
/** How far above the feet a surface may be and still be stepped onto. */
const STEP_UP = 0.5;
/** Ramps reach full height this far before their end, so the runner is level when the train begins. */
const RAMP_LEVEL_EARLY = 1;

export interface RunnerBox {
  s: number;
  x: number;
  y: number;
  height: number;
}

const nearLane = (x: number, lane: Lane, halfWidth: number) => Math.abs(x - laneX(lane)) < halfWidth;

export function overlaps(r: RunnerBox, o: Obstacle): boolean {
  const info = OBSTACLES[o.kind];
  if (info.yMax <= info.yMin) return false;
  const hd = TUNING.runnerHalfDepth;
  if (r.s + hd <= o.front || r.s - hd >= o.front + o.length) return false;
  if (!nearLane(r.x, o.lane, OBSTACLE_HALF_WIDTH + TUNING.runnerHalfWidth)) return false;
  return r.y < info.yMax && r.y + r.height > info.yMin;
}

/** Height of the highest walkable surface under the runner that it can reach. */
export function surfaceAt(r: RunnerBox, obstacles: readonly Obstacle[]): number {
  const hd = TUNING.runnerHalfDepth;
  let top = 0;
  for (const o of obstacles) {
    const info = OBSTACLES[o.kind];
    if (info.walkTop === null || !nearLane(r.x, o.lane, OBSTACLE_HALF_WIDTH)) continue;
    let h: number;
    if (o.kind === 'ramp') {
      if (r.s < o.front || r.s > o.front + o.length) continue;
      h = info.walkTop * Math.min(1, (r.s - o.front) / (o.length - RAMP_LEVEL_EARLY));
    } else {
      if (r.s + hd <= o.front || r.s - hd >= o.front + o.length) continue;
      h = info.walkTop;
    }
    if (h <= r.y + STEP_UP && h > top) top = h;
  }
  return top;
}

export type HitKind = 'front' | 'side';

export interface Hit {
  kind: HitKind;
  obstacle: Obstacle;
}

/**
 * Only obstacles in the lane the runner is heading for count. Hitting one while
 * still sliding across is a side clip (stumble); otherwise it is head-on.
 */
export function findHit(r: RunnerBox, lane: Lane, changingLane: boolean, obstacles: readonly Obstacle[]): Hit | null {
  for (const o of obstacles) {
    if (o.lane !== lane || !overlaps(r, o)) continue;
    return { kind: changingLane ? 'side' : 'front', obstacle: o };
  }
  return null;
}
```

Check against the test: at s = 17 the ramp height is `3.2 × min(1, 7/7) = 3.2`. At s = 48.3 the back edge (47.9) is still over a train that ends at 48, so the surface is 3.2. At s = 48.5 the back edge (48.1) has left it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/game/collision.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/game/obstacles.ts src/game/collision.ts tests/game/collision.test.ts
git commit -m "feat(game): add obstacle geometry and collision rules"
```

---
### Task 5: Track chunks and the passability solver

**Files:**
- Create: `src/game/chunks.ts`, `src/game/solver.ts`
- Test: `tests/game/solver.test.ts`, `tests/game/chunks.test.ts`, `tests/game/helpers/replay.ts`

**Interfaces:**
- Consumes: `TUNING` (Task 2); `Tier`, `TIER_FRACTIONS`, `speedAt`, `topSpeed`, `minGapAt` (Task 2); `ObstacleSpec`, `OBSTACLES`, `lengthOf`, `movingFrontAt`, `Obstacle` (Task 4); `surfaceAt`, `findHit` (Task 4); `Runner`, `jumpHeightAt`, `NORMAL_JUMP` (Task 3)
- Produces:
  - `CHUNK_LENGTH` (60)
  - `CoinRun { lane; s0; s1; shape: 'line' | 'arc' | 'roof' }`
  - `ChunkDef { id; tier; obstacles; coins; pickup? }` and `CHUNKS`
  - `Block`, `PlanAction`, `toBlocks(specs, speed)`
  - `plan(blocks, fromS, toS, { speed, minGap, startLane, onRoof? }): PlanAction[] | null`
  - `unpassableFrom(specs, fromS, toS, speed, minGap): Lane | null`
  - Test helper `replayPlan(specs, actions, startLane, speed, length)`, which returns the first collision or null

**How the solver works.** It steps one simulation frame at a time (`ds = speed / 60`). At each step every state is a lane plus a mode:
- `run`
- `air` (a jump started at frame k)
- `roll`
- `change` (a lane change that occupies both lanes for 9 frames)

A new action may start only when the previous one was at least `minGap` seconds earlier. Lane blocks are forbidden in the lanes the runner occupies. A jump block needs `jumpHeightAt(age) ≥ top + 0.02`, and a roll block needs roll mode. A runner that is in a ramp's lane, not changing lanes, within 1 m after the ramp starts, boards the roof: the train that ramp leads to no longer blocks it until the runner changes lanes. Oncoming trains block `[meet − 0.4 − 2, meet + len/(1+k) + 0.4 + 2]`, where `k = trainSpeed / speed`. States that differ only in when their next action is allowed are merged, keeping the earliest.

**Chunk authoring rules** (the tests enforce them):
- Obstacles start at s ∈ [15, 45]. Parked trains end by s = 50. Oncoming-train meeting points are ≤ 40.
- A ramp is always followed directly by a parked train in the same lane (train.s = ramp.s + 8).
- Every chunk must be passable from every entry lane at its tier's lowest and highest speed, for cardio and beast.
- Every join from a chunk to a chunk of the same tier or the next tier must also be passable.
- The run passes when the real runner physics, following the solver's plan, never collides.
- If a chunk fails, change the chunk data (spacing, lanes, kinds). Never loosen the solver or the physics to make a chunk pass.

- [ ] **Step 1: Write the replay helper `tests/game/helpers/replay.ts`**

```ts
import { findHit, surfaceAt, type Hit } from '../../../src/game/collision';
import { TUNING } from '../../../src/game/config';
import { lengthOf, movingFrontAt, OBSTACLES, type Obstacle, type ObstacleSpec } from '../../../src/game/obstacles';
import { Runner } from '../../../src/game/runner';
import type { PlanAction } from '../../../src/game/solver';
import type { Lane } from '../../../src/pose/types';

/** Runs the real runner physics along a plan at constant speed; returns the first collision or null. */
export function replayPlan(specs: readonly ObstacleSpec[], actions: readonly PlanAction[], startLane: Lane, speed: number, length: number): Hit | null {
  const dt = 1 / TUNING.stepHz;
  const obstacles: Obstacle[] = specs.map((o, id) => ({
    id,
    kind: o.kind,
    lane: o.lane,
    length: lengthOf(o),
    front: OBSTACLES[o.kind].moving ? movingFrontAt(o.s, 0, speed) : o.s,
  }));
  const r = new Runner();
  r.lane = startLane;
  r.prevLane = startLane;
  r.x = startLane * 2.5;
  const queue = [...actions];
  const steps = Math.ceil(length / (speed * dt));
  for (let i = 0; i <= steps; i++) {
    const s = i * speed * dt;
    while (queue.length && queue[0].s <= s + 1e-6) {
      const a = queue.shift()!;
      if (a.type === 'jump') r.jump();
      else if (a.type === 'roll') r.roll();
      else r.setLane(a.lane);
    }
    const next = s + speed * dt;
    for (const o of obstacles) if (OBSTACLES[o.kind].moving) o.front -= TUNING.oncomingTrainSpeed * dt;
    const box = { s: next, x: r.x, y: r.y, height: r.height };
    r.update(dt, surfaceAt(box, obstacles));
    const hit = findHit({ s: next, x: r.x, y: r.y, height: r.height }, r.lane, r.changingLane, obstacles);
    if (hit) return hit;
  }
  return null;
}
```

This mirrors the per-step order the Game uses:
1. apply commands
2. advance `s`
3. move trains
4. update the runner using the surface at the new `s`
5. check hits

- [ ] **Step 2: Write the failing solver test `tests/game/solver.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { ObstacleSpec } from '../../src/game/obstacles';
import { plan, toBlocks, unpassableFrom } from '../../src/game/solver';
import { replayPlan } from './helpers/replay';

const spec = (kind: ObstacleSpec['kind'], lane: -1 | 0 | 1, s: number, length?: number): ObstacleSpec => ({ kind, lane, s, length });

describe('plan', () => {
  it('needs no actions on an empty track', () => {
    expect(plan([], 0, 60, { speed: 20, minGap: 1, startLane: 0 })).toEqual([]);
  });

  it('jumps a full row of barriers, and the real runner clears it', () => {
    const specs = [spec('barrierLow', -1, 30), spec('barrierLow', 0, 30), spec('barrierLow', 1, 30)];
    const actions = plan(toBlocks(specs, 20), 0, 60, { speed: 20, minGap: 1, startLane: 0 });
    expect(actions).not.toBeNull();
    expect(actions!.map((a) => a.type)).toEqual(['jump']);
    expect(replayPlan(specs, actions!, 0, 20, 60)).toBeNull();
  });

  it('rolls under a full row of banners', () => {
    const specs = [spec('bannerHigh', -1, 30), spec('bannerHigh', 0, 30), spec('bannerHigh', 1, 30)];
    const actions = plan(toBlocks(specs, 25), 0, 60, { speed: 25, minGap: 1, startLane: 1 });
    expect(actions!.map((a) => a.type)).toEqual(['roll']);
    expect(replayPlan(specs, actions!, 1, 25, 60)).toBeNull();
  });

  it('fails when every lane is walled off', () => {
    const specs = [spec('trainParked', -1, 20), spec('trainParked', 0, 20), spec('trainParked', 1, 20)];
    expect(unpassableFrom(specs, 0, 60, 20, 1)).toBe(-1);
  });

  it('respects the minimum gap between actions', () => {
    // Two barriers too far apart for one jump; the side lanes are walled, so both must be jumped.
    const specs = [spec('barrierLow', 0, 20), spec('barrierLow', 0, 32), spec('trainParked', -1, 10), spec('trainParked', 1, 10)];
    expect(unpassableFrom(specs, 0, 60, 30, 0.8)).toBe(-1);
    expect(unpassableFrom(specs, 0, 60, 30, 0.1)).toBeNull();
  });

  it('runs over a train by taking its ramp', () => {
    const specs = [spec('ramp', 0, 15), spec('trainParked', 0, 23, 22), spec('auto', -1, 30), spec('auto', 1, 30)];
    const blocks = toBlocks(specs, 20);
    expect(blocks.find((b) => b.lane === 0)!.rampS).toBe(15);
    const actions = plan(blocks, 0, 60, { speed: 20, minGap: 1, startLane: 0 });
    expect(actions).toEqual([]);
    expect(replayPlan(specs, actions!, 0, 20, 60)).toBeNull();
    expect(unpassableFrom(specs, 0, 60, 20, 1)).toBeNull();
  });

  it('plans from the roof when already on it', () => {
    const specs = [spec('ramp', 0, -10), spec('trainParked', 0, -2, 30), spec('auto', -1, 10), spec('auto', 1, 10)];
    const blocks = toBlocks(specs, 20);
    expect(plan(blocks, 0, 40, { speed: 20, minGap: 1, startLane: 0 })).toBeNull();
    expect(plan(blocks, 0, 40, { speed: 20, minGap: 1, startLane: 0, onRoof: true })).toEqual([]);
  });

  it('blocks an oncoming train only around the meeting point', () => {
    const [b] = toBlocks([spec('trainMoving', 1, 30)], 30);
    expect(b.s0).toBeCloseTo(30 - 0.4 - 2, 6);
    expect(b.s1).toBeCloseTo(30 + 30 / (1 + 10 / 30) + 0.4 + 2, 6);
    const specs = [spec('trainMoving', 0, 30)];
    const actions = plan(toBlocks(specs, 30), 0, 90, { speed: 30, minGap: 0.8, startLane: 0 });
    expect(actions!.map((a) => a.type)).toEqual(['lane']);
    expect(replayPlan(specs, actions!, 0, 30, 90)).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/game/solver.test.ts`
Expected: FAIL because the module is not found.

- [ ] **Step 4: Write `src/game/solver.ts`**

```ts
import type { Lane } from '../pose/types';
import { TUNING } from './config';
import { lengthOf, OBSTACLES, type ObstacleSpec } from './obstacles';
import { jumpHeightAt, NORMAL_JUMP } from './runner';

export interface Block {
  lane: Lane;
  s0: number;
  s1: number;
  need: 'lane' | 'jump' | 'roll';
  /** Height a jump has to clear. */
  top: number;
  /** Start of the ramp that leads onto this train's roof, if any. */
  rampS: number | null;
}

export type PlanAction =
  | { s: number; type: 'jump' }
  | { s: number; type: 'roll' }
  | { s: number; type: 'lane'; lane: Lane };

export interface PlanOptions {
  speed: number;
  /** Seconds that must pass between actions. */
  minGap: number;
  startLane: Lane;
  /** The runner starts on the roof of a ramp-served train in its lane. */
  onRoof?: boolean;
}

/** Extra room around an oncoming train's danger zone (runner speed drifts while it approaches). */
const MOVING_MARGIN = 2;
const JUMP_CLEARANCE = 0.02;
/** A runner in the ramp's lane within this distance after the ramp starts goes up onto the roof. */
const ROOF_BOARDING = 1;

const RUN = 0;
const AIR = 1;
const ROLL = 2;
const CHANGE = 3;
type Mode = typeof RUN | typeof AIR | typeof ROLL | typeof CHANGE;

interface Node {
  lane: Lane;
  /** Lane being left while changing (equals lane otherwise). */
  from: Lane;
  mode: Mode;
  /** Frame the current mode began. */
  start: number;
  /** First frame a new action may start. */
  free: number;
  /** Index of the roof block the runner is on, or -1. */
  roof: number;
  parent: Node | null;
  action: PlanAction | null;
}

export function toBlocks(specs: readonly ObstacleSpec[], speed: number): Block[] {
  const pad = TUNING.runnerHalfDepth;
  const ramps = specs.filter((o) => o.kind === 'ramp');
  const out: Block[] = [];
  for (const o of specs) {
    const info = OBSTACLES[o.kind];
    const need = info.action;
    if (need === 'none') continue;
    let s0 = o.s - pad;
    let s1 = o.s + lengthOf(o) + pad;
    if (info.moving) {
      s0 -= MOVING_MARGIN;
      s1 = o.s + lengthOf(o) / (1 + TUNING.oncomingTrainSpeed / speed) + pad + MOVING_MARGIN;
    }
    const ramp =
      info.walkTop === null ? undefined : ramps.find((r) => r.lane === o.lane && Math.abs(r.s + lengthOf(r) - o.s) < 0.5);
    out.push({ lane: o.lane, s0, s1, need, top: info.yMax, rampS: ramp ? ramp.s : null });
  }
  return out;
}

/** Finds a sequence of actions that gets from fromS to toS without touching any block, or null. */
export function plan(blocks: readonly Block[], fromS: number, toS: number, o: PlanOptions): PlanAction[] | null {
  const hz = TUNING.stepHz;
  const ds = o.speed / hz;
  const steps = Math.ceil((toS - fromS) / ds);
  const gap = Math.ceil(o.minGap * hz);
  const airFrames = Math.round(NORMAL_JUMP.seconds * hz);
  const rollFrames = Math.round(TUNING.rollSeconds * hz);
  const changeFrames = Math.ceil(TUNING.laneChangeSeconds * hz);
  const relevant = blocks.filter((b) => b.s1 >= fromS && b.s0 <= toS);

  const startRoof = o.onRoof
    ? relevant.findIndex((b) => b.lane === o.startLane && b.rampS !== null && fromS >= b.s0 && fromS <= b.s1)
    : -1;

  const put = (map: Map<string, Node>, n: Node, at: number) => {
    const age = n.mode === RUN ? 0 : at - n.start;
    const key = `${n.lane}|${n.from}|${n.mode}|${age}|${n.roof}`;
    const old = map.get(key);
    if (!old || n.free < old.free) map.set(key, n);
  };

  const settle = (n: Node, i: number, s: number): Node => {
    let m = n;
    const age = i - n.start;
    if (
      (n.mode === AIR && age >= airFrames) ||
      (n.mode === ROLL && age >= rollFrames) ||
      (n.mode === CHANGE && age >= changeFrames)
    ) {
      m = { ...m, mode: RUN, from: m.lane };
    }
    if (m.roof < 0 && m.mode !== CHANGE) {
      const idx = relevant.findIndex(
        (b) => b.rampS !== null && b.lane === m.lane && s >= b.rampS && s <= b.rampS + ROOF_BOARDING,
      );
      if (idx >= 0) m = { ...m, roof: idx };
    }
    return m;
  };

  const valid = (n: Node, i: number, s: number): boolean => {
    for (let bi = 0; bi < relevant.length; bi++) {
      const b = relevant[bi];
      if (s < b.s0 || s > b.s1) continue;
      const inside = n.mode === CHANGE ? b.lane === n.lane || b.lane === n.from : b.lane === n.lane;
      if (!inside) continue;
      if (b.need === 'lane') {
        if (n.roof === bi && n.mode !== CHANGE) continue;
        return false;
      }
      if (b.need === 'jump') {
        if (n.mode !== AIR) return false;
        if (jumpHeightAt((i - n.start) / hz, NORMAL_JUMP) < b.top + JUMP_CLEARANCE) return false;
        continue;
      }
      if (n.mode !== ROLL) return false;
    }
    return true;
  };

  let frontier = new Map<string, Node>();
  put(frontier, { lane: o.startLane, from: o.startLane, mode: RUN, start: 0, free: 0, roof: startRoof, parent: null, action: null }, 0);

  for (let i = 0; i <= steps; i++) {
    const s = fromS + i * ds;
    const next = new Map<string, Node>();
    for (const raw of frontier.values()) {
      const n = settle(raw, i, s);
      if (!valid(n, i, s)) continue;
      if (i === steps) return actionsOf(n);
      put(next, n, i + 1);
      if (n.mode !== RUN || i < n.free) continue;
      put(next, { ...n, mode: AIR, start: i, free: i + gap, parent: n, action: { s, type: 'jump' } }, i + 1);
      put(next, { ...n, mode: ROLL, start: i, free: i + gap, parent: n, action: { s, type: 'roll' } }, i + 1);
      for (const d of [-1, 1] as const) {
        const lane = n.lane + d;
        if (lane < -1 || lane > 1) continue;
        const to = lane as Lane;
        put(
          next,
          { ...n, lane: to, from: n.lane, mode: CHANGE, start: i, free: i + gap, roof: -1, parent: n, action: { s, type: 'lane', lane: to } },
          i + 1,
        );
      }
    }
    if (next.size === 0) return null;
    frontier = next;
  }
  return null;
}

function actionsOf(n: Node): PlanAction[] {
  const out: PlanAction[] = [];
  for (let c: Node | null = n; c; c = c.parent) if (c.action) out.push(c.action);
  return out.reverse();
}

/** The first entry lane from which the stretch cannot be passed, or null if every lane works. */
export function unpassableFrom(specs: readonly ObstacleSpec[], fromS: number, toS: number, speed: number, minGap: number): Lane | null {
  const blocks = toBlocks(specs, speed);
  for (const lane of [-1, 0, 1] as const) {
    if (!plan(blocks, fromS, toS, { speed, minGap, startLane: lane })) return lane;
  }
  return null;
}
```

A note on `actionsOf`: a node that continues unchanged into the next frame is a copy that keeps the same `action` and `parent`. Walking the parents therefore visits each action exactly once.

- [ ] **Step 5: Run the solver tests**

Run: `npx vitest run tests/game/solver.test.ts`
Expected: all pass.

If `replayPlan` reports a hit, the solver and the physics disagree. Find which one is wrong by printing per-frame `s`, `y`, the lane and the block, and fix that one. Never loosen an assertion.

- [ ] **Step 6: Write `src/game/chunks.ts`**

```ts
import type { Lane } from '../pose/types';
import type { ObstacleKind, ObstacleSpec } from './obstacles';
import type { Tier } from './speed';

export const CHUNK_LENGTH = 60;

export interface CoinRun {
  lane: Lane;
  s0: number;
  s1: number;
  /** line: at running height; arc: follows a jump over the middle; roof: on top of a train. */
  shape: 'line' | 'arc' | 'roof';
}

export interface ChunkDef {
  id: string;
  tier: Tier;
  obstacles: ObstacleSpec[];
  coins: CoinRun[];
  /** Where a power-up may appear (spawned with TUNING.pickupChance). */
  pickup?: { lane: Lane; s: number };
}

const L: Lane = -1;
const C: Lane = 0;
const R: Lane = 1;

const o = (kind: ObstacleKind, lane: Lane, s: number, length?: number): ObstacleSpec =>
  length === undefined ? { kind, lane, s } : { kind, lane, s, length };
const line = (lane: Lane, s0: number, s1: number): CoinRun => ({ lane, s0, s1, shape: 'line' });
const roof = (lane: Lane, s0: number, s1: number): CoinRun => ({ lane, s0, s1, shape: 'roof' });
/** Coins arcing over an obstacle whose middle is at s. */
const arc = (lane: Lane, s: number): CoinRun => ({ lane, s0: s - 6, s1: s + 6, shape: 'arc' });

export const CHUNKS: readonly ChunkDef[] = [
  // tier 0: warm-up
  { id: 'w-coins', tier: 0, obstacles: [], coins: [line(C, 15, 45)] },
  { id: 'w-barrier', tier: 0, obstacles: [o('barrierLow', C, 30)], coins: [arc(C, 30.25), line(L, 15, 45)] },
  { id: 'w-blockers', tier: 0, obstacles: [o('auto', L, 25), o('cow', R, 25)], coins: [line(C, 15, 45)] },
  { id: 'w-banner', tier: 0, obstacles: [o('bannerHigh', C, 30)], coins: [line(L, 15, 45)] },

  // tier 1
  { id: 't1-train-center', tier: 1, obstacles: [o('trainParked', C, 15)], coins: [line(L, 15, 45), line(R, 15, 45)], pickup: { lane: R, s: 52 } },
  {
    id: 't1-ramp-left',
    tier: 1,
    obstacles: [o('ramp', L, 15), o('trainParked', L, 23, 22), o('barrierLow', C, 40)],
    coins: [roof(L, 25, 43), arc(C, 40.25)],
    pickup: { lane: R, s: 30 },
  },
  { id: 't1-auto-barrier', tier: 1, obstacles: [o('auto', C, 20), o('barrierLow', L, 45)], coins: [line(R, 15, 45)], pickup: { lane: C, s: 50 } },
  { id: 't1-banner-cow', tier: 1, obstacles: [o('bannerHigh', C, 25), o('cow', L, 25)], coins: [line(R, 20, 45)] },
  { id: 't1-handcarts', tier: 1, obstacles: [o('handcart', L, 25), o('handcart', R, 25)], coins: [line(C, 15, 45)], pickup: { lane: L, s: 50 } },
  { id: 't1-oncoming', tier: 1, obstacles: [o('trainMoving', R, 25)], coins: [line(C, 15, 45)] },
  {
    id: 't1-barrier-row',
    tier: 1,
    obstacles: [o('barrierLow', L, 30), o('barrierLow', C, 30), o('barrierLow', R, 30)],
    coins: [arc(C, 30.25)],
  },

  // tier 2
  {
    id: 't2-trains-sides',
    tier: 2,
    obstacles: [o('trainParked', L, 15), o('trainParked', R, 15), o('barrierLow', C, 45)],
    coins: [line(C, 15, 36), arc(C, 45.25)],
  },
  {
    id: 't2-zigzag',
    tier: 2,
    obstacles: [o('auto', L, 15), o('auto', R, 15), o('cow', C, 45), o('auto', R, 45)],
    coins: [line(C, 15, 30), line(L, 33, 45)],
    pickup: { lane: L, s: 30 },
  },
  {
    id: 't2-banner-train',
    tier: 2,
    obstacles: [o('trainParked', C, 15), o('bannerHigh', L, 45), o('bannerHigh', R, 45)],
    coins: [line(L, 15, 40), line(R, 15, 40)],
  },
  { id: 't2-oncoming-barrier', tier: 2, obstacles: [o('trainMoving', C, 20), o('barrierLow', L, 45)], coins: [line(R, 15, 45)] },
  {
    id: 't2-roof-run',
    tier: 2,
    obstacles: [o('ramp', C, 15), o('trainParked', C, 23, 22), o('auto', L, 30), o('auto', R, 30)],
    coins: [roof(C, 25, 43)],
  },
  {
    id: 't2-double-barrier',
    tier: 2,
    obstacles: [o('barrierLow', C, 20), o('barrierLow', C, 45)],
    coins: [arc(C, 20.25), arc(C, 45.25)],
    pickup: { lane: L, s: 35 },
  },
  {
    id: 't2-handcart-banner',
    tier: 2,
    obstacles: [o('handcart', L, 20), o('bannerHigh', C, 20), o('handcart', R, 45)],
    coins: [line(R, 15, 40)],
  },

  // tier 3
  {
    id: 't3-corridor',
    tier: 3,
    obstacles: [o('trainParked', L, 15), o('trainParked', R, 15), o('bannerHigh', C, 45)],
    coins: [line(C, 15, 40)],
  },
  {
    id: 't3-oncoming-pair',
    tier: 3,
    obstacles: [o('trainMoving', L, 20), o('trainMoving', R, 20), o('bannerHigh', C, 45)],
    coins: [line(C, 15, 40)],
  },
  {
    id: 't3-roof-and-row',
    tier: 3,
    obstacles: [o('ramp', R, 15), o('trainParked', R, 23, 22), o('barrierLow', L, 30), o('barrierLow', C, 30)],
    coins: [roof(R, 25, 43), arc(C, 30.25)],
  },
  { id: 't3-weave', tier: 3, obstacles: [o('auto', C, 15), o('cow', L, 45), o('auto', C, 45)], coins: [line(R, 15, 45)], pickup: { lane: R, s: 30 } },
  {
    id: 't3-banner-train',
    tier: 3,
    obstacles: [o('bannerHigh', L, 15), o('bannerHigh', C, 15), o('bannerHigh', R, 15), o('trainParked', C, 40, 10)],
    coins: [line(L, 25, 45)],
  },
  { id: 't3-oncoming-center', tier: 3, obstacles: [o('trainMoving', C, 25), o('handcart', L, 45)], coins: [line(R, 15, 45)] },

  // tier 4
  {
    id: 't4-sides-banner',
    tier: 4,
    obstacles: [o('trainParked', L, 15), o('trainParked', R, 15), o('bannerHigh', C, 40)],
    coins: [line(C, 15, 35)],
  },
  { id: 't4-single-train', tier: 4, obstacles: [o('trainParked', C, 15)], coins: [line(L, 15, 45), line(R, 15, 45)], pickup: { lane: L, s: 52 } },
  {
    id: 't4-row-jump',
    tier: 4,
    obstacles: [o('barrierLow', L, 30), o('barrierLow', C, 30), o('barrierLow', R, 30)],
    coins: [arc(C, 30.25)],
  },
  { id: 't4-oncoming-side', tier: 4, obstacles: [o('trainMoving', L, 20)], coins: [line(C, 15, 45)], pickup: { lane: R, s: 35 } },
  {
    id: 't4-roof',
    tier: 4,
    obstacles: [o('ramp', C, 15), o('trainParked', C, 23, 22), o('cow', L, 35), o('auto', R, 35)],
    coins: [roof(C, 25, 43)],
  },
  {
    id: 't4-banner-row',
    tier: 4,
    obstacles: [o('bannerHigh', L, 30), o('bannerHigh', C, 30), o('bannerHigh', R, 30)],
    coins: [line(C, 20, 28)],
  },
];
```

- [ ] **Step 7: Write the chunk test `tests/game/chunks.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { CHUNK_LENGTH, CHUNKS, type ChunkDef } from '../../src/game/chunks';
import { TUNING, type Difficulty } from '../../src/game/config';
import { lengthOf, OBSTACLES, type ObstacleSpec } from '../../src/game/obstacles';
import { plan, toBlocks, unpassableFrom } from '../../src/game/solver';
import { minGapAt, speedAt, TIER_FRACTIONS, topSpeed, type Tier } from '../../src/game/speed';
import { replayPlan } from './helpers/replay';

const DIFFICULTIES: Difficulty[] = ['cardio', 'beast'];

function tierSpeeds(tier: Tier, d: Difficulty): [number, number] {
  if (tier === 0) return [TUNING.startSpeed, speedAt(TUNING.warmupSeconds, d)];
  const [lo, hi] = TIER_FRACTIONS[tier];
  const span = topSpeed(d) - TUNING.startSpeed;
  return [TUNING.startSpeed + span * lo, TUNING.startSpeed + span * hi];
}

const shifted = (c: ChunkDef, by: number): ObstacleSpec[] => c.obstacles.map((o) => ({ ...o, s: o.s + by }));

describe('chunk data', () => {
  it('has the planned number of chunks per tier and unique ids', () => {
    const count = (t: Tier) => CHUNKS.filter((c) => c.tier === t).length;
    expect([0, 1, 2, 3, 4].map((t) => count(t as Tier))).toEqual([4, 7, 7, 6, 6]);
    expect(new Set(CHUNKS.map((c) => c.id)).size).toBe(CHUNKS.length);
  });

  it.each(CHUNKS)('$id follows the authoring rules', (c) => {
    for (const o of c.obstacles) {
      expect(o.s).toBeGreaterThanOrEqual(15);
      expect(o.s).toBeLessThanOrEqual(45);
      if (o.kind === 'trainParked') expect(o.s + lengthOf(o)).toBeLessThanOrEqual(50);
      if (OBSTACLES[o.kind].moving) expect(o.s).toBeLessThanOrEqual(40);
      if (o.kind === 'ramp') {
        const train = c.obstacles.find((t) => t.kind === 'trainParked' && t.lane === o.lane && t.s === o.s + lengthOf(o));
        expect(train, `${c.id}: ramp at ${o.s} needs a train right after it`).toBeDefined();
      }
    }
    for (const run of c.coins) {
      expect(run.s0).toBeGreaterThanOrEqual(0);
      expect(run.s1).toBeLessThanOrEqual(CHUNK_LENGTH);
    }
    if (c.pickup) expect(c.pickup.s).toBeLessThanOrEqual(CHUNK_LENGTH);
  });
});

describe('chunk passability', () => {
  it.each(CHUNKS)('$id is passable from every lane at its tier speeds', (c) => {
    for (const d of DIFFICULTIES) {
      for (const v of tierSpeeds(c.tier, d)) {
        expect(unpassableFrom(c.obstacles, 0, CHUNK_LENGTH, v, minGapAt(v, d)), `${d} @ ${v.toFixed(1)} m/s`).toBeNull();
      }
    }
  });

  it.each(CHUNKS)('$id plans survive the real runner physics', (c) => {
    for (const d of DIFFICULTIES) {
      const v = tierSpeeds(c.tier, d)[1];
      const blocks = toBlocks(c.obstacles, v);
      for (const lane of [-1, 0, 1] as const) {
        const actions = plan(blocks, 0, CHUNK_LENGTH, { speed: v, minGap: minGapAt(v, d), startLane: lane })!;
        const hit = replayPlan(c.obstacles, actions, lane, v, CHUNK_LENGTH);
        expect(hit, `${d} lane ${lane}: hit ${hit?.obstacle.kind} (${hit?.kind})`).toBeNull();
      }
    }
  });

  it('every join into the same or next tier is passable', () => {
    const failures: string[] = [];
    for (const a of CHUNKS) {
      for (const b of CHUNKS) {
        if (b.tier !== a.tier && b.tier !== a.tier + 1) continue;
        const specs = [...a.obstacles, ...shifted(b, CHUNK_LENGTH)];
        for (const d of DIFFICULTIES) {
          const v = tierSpeeds(b.tier, d)[1];
          const lane = unpassableFrom(specs, 0, 2 * CHUNK_LENGTH, v, minGapAt(v, d));
          if (lane !== null) failures.push(`${a.id} -> ${b.id} (${d}, from lane ${lane})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the chunk tests and fix the chunk data until they pass**

Run: `npx vitest run tests/game/chunks.test.ts`

Some chunks may fail. The listed chunks were designed with at least 25–30 m between forced actions, but the solver is the judge. For each failure:
1. Print the failing chunk, lane and speed.
2. Move obstacles further apart, open a lane, or swap a kind (for example banner ↔ barrier, since rolls have a wider window than jumps).

Keep each chunk's character, and keep the tier counts at 4/7/7/6/6. Record every data change in the report.

The join test runs a few hundred plans. If it takes longer than about 20 s, report the timing; do not skip it.

Expected in the end: all pass.

- [ ] **Step 9: Full suite, type check, commit**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/game/chunks.ts src/game/solver.ts tests/game
git commit -m "feat(game): add track chunks and passability solver"
```

---
### Task 6: Track generator

**Files:**
- Create: `src/game/track.ts`
- Test: `tests/game/track.test.ts`

**Interfaces:**
- Consumes:
  - `CHUNKS`, `CHUNK_LENGTH`, `ChunkDef`, `CoinRun` (Task 5)
  - `Rng`, `tierFor`, `TUNING`, `Difficulty` (Task 2)
  - `OBSTACLES`, `lengthOf`, `movingFrontAt`, `Obstacle` (Task 4)
  - `NORMAL_JUMP` (Task 3)
- Produces:
  - Power-ups: `PowerupKind` (`'magnet' | 'rocket' | 'chappal'`), `POWERUP_KINDS`
  - Items: `Coin { id; lane; s; y; taken }`, `Pickup { id; kind; lane; s; taken }`
  - `TRACK_AHEAD` (200)
  - `class Track(rng, difficulty, chunks = CHUNKS)`
    - public arrays: `obstacles`, `coins`, `pickups`, `placed`
    - methods: `update(runnerS, speed, tSec, dt)`, `clearObstacles(fromS, toS)`, `addCoinTrail(fromS, toS, lane, y)`

  Behaviour:
  - The first chunk starts at s = 30. Chunks are placed back to back until they reach `runnerS + 200`.
  - Each chunk's tier comes from the estimated time the runner will reach it.
  - The same chunk never appears twice in a row, unless it's the only one in its tier.
  - Items more than 30 m behind are dropped, and taken coins and pickups are dropped too.
  - Oncoming trains move toward the runner at `TUNING.oncomingTrainSpeed`.

- [ ] **Step 1: Write the failing test `tests/game/track.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { TUNING } from '../../src/game/config';
import { Rng } from '../../src/game/rng';
import { POWERUP_KINDS, Track, TRACK_AHEAD } from '../../src/game/track';

const DT = 1 / 60;

describe('Track', () => {
  it('is deterministic for a seed', () => {
    const ids = (seed: number) => {
      const t = new Track(new Rng(seed), 'cardio');
      for (let i = 0; i < 20; i++) t.update(i * 100, 20, i * 5, DT);
      return t.placed.map((p) => p.id);
    };
    expect(ids(5)).toEqual(ids(5));
    expect(ids(5)).not.toEqual(ids(6));
  });

  it('lays out warm-up chunks ahead of the runner from s = 30', () => {
    const t = new Track(new Rng(1), 'cardio');
    t.update(0, 12, 0, DT);
    expect(t.placed[0].s).toBe(30);
    const last = t.placed[t.placed.length - 1];
    expect(last.s + 60).toBeGreaterThanOrEqual(TRACK_AHEAD);
    expect(t.placed.every((p) => p.id.startsWith('w-'))).toBe(true);
    expect(t.placed.every((p, i) => i === 0 || p.id !== t.placed[i - 1].id)).toBe(true);
  });

  it('moves to harder tiers later and drops what is far behind', () => {
    const t = new Track(new Rng(2), 'cardio');
    t.update(0, 12, 0, DT);
    t.update(5000, 30, 300, DT);
    expect(t.placed[t.placed.length - 1].id.startsWith('t4-')).toBe(true);
    expect(t.obstacles.every((o) => o.front + o.length >= 5000 - 30)).toBe(true);
    expect(t.coins.every((c) => c.s >= 5000 - 30)).toBe(true);
  });

  it('moves oncoming trains toward the runner', () => {
    const chunks: ChunkDef[] = [{ id: 'm', tier: 0, obstacles: [{ kind: 'trainMoving', lane: 0, s: 30 }], coins: [] }];
    const t = new Track(new Rng(1), 'cardio', chunks);
    t.update(0, 12, 0, DT);
    const train = t.obstacles[0];
    expect(train.front).toBeCloseTo(60 + 60 * (TUNING.oncomingTrainSpeed / 12), 6);
    t.update(0, 12, 0, 0.5);
    expect(train.front).toBeCloseTo(60 + 50 - 5, 6);
  });

  it('shapes coin arcs and roof runs', () => {
    const chunks: ChunkDef[] = [
      { id: 'c', tier: 0, obstacles: [], coins: [{ lane: 0, s0: 24, s1: 36, shape: 'arc' }, { lane: 1, s0: 10, s1: 13, shape: 'roof' }] },
    ];
    const t = new Track(new Rng(1), 'cardio', chunks);
    t.update(0, 12, 0, DT);
    const arc = t.coins.filter((c) => c.lane === 0 && c.s < 90).map((c) => [c.s, c.y]);
    expect(arc.map(([s]) => s)).toEqual([54, 57, 60, 63, 66]);
    expect(arc[0][1]).toBeCloseTo(TUNING.coinHeight, 6);
    expect(arc[2][1]).toBeCloseTo(TUNING.coinHeight + 1.2, 6);
    const roofCoins = t.coins.filter((c) => c.lane === 1 && c.s < 90);
    expect(roofCoins.map((c) => c.y)).toEqual([TUNING.coinHeight + TUNING.trainHeight, TUNING.coinHeight + TUNING.trainHeight]);
  });

  it('sometimes offers power-ups at chunk pickup slots', () => {
    const chunks: ChunkDef[] = [{ id: 'p', tier: 0, obstacles: [], coins: [], pickup: { lane: -1, s: 20 } }];
    const t = new Track(new Rng(3), 'cardio', chunks);
    const seen = new Map<number, string>();
    for (let s = 0; s <= 12_000; s += 150) {
      t.update(s, 12, 0, DT);
      for (const p of t.pickups) {
        expect(p.lane).toBe(-1);
        seen.set(p.id, p.kind);
      }
    }
    // ~200 slots at a 35% chance: a few dozen pickups, never all of them.
    expect(seen.size).toBeGreaterThan(20);
    expect(seen.size).toBeLessThan(150);
    expect([...seen.values()].every((k) => POWERUP_KINDS.includes(k as never))).toBe(true);
  });

  it('clears obstacles from a stretch and lays coin trails', () => {
    const chunks: ChunkDef[] = [
      { id: 'x', tier: 0, obstacles: [{ kind: 'barrierLow', lane: 0, s: 20 }, { kind: 'auto', lane: 1, s: 40 }], coins: [] },
    ];
    const t = new Track(new Rng(1), 'cardio', chunks);
    t.update(0, 12, 0, DT);
    const before = t.obstacles.length;
    t.clearObstacles(45, 65);
    expect(t.obstacles.length).toBe(before - 1);
    expect(t.obstacles.some((o) => o.front === 70)).toBe(true);
    t.addCoinTrail(100, 109, 0, TUNING.rocketHeight);
    expect(t.coins.filter((c) => c.y === TUNING.rocketHeight).map((c) => c.s)).toEqual([100, 103, 106, 109]);
  });
});
```

In the clear test, the barrier is at 50–50.5 and the auto at 70–73. `clearObstacles(45, 65)` removes only the barrier.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/game/track.test.ts`
Expected: FAIL because the module is not found.

- [ ] **Step 3: Write `src/game/track.ts`**

```ts
import type { Lane } from '../pose/types';
import { CHUNK_LENGTH, CHUNKS, type ChunkDef, type CoinRun } from './chunks';
import { TUNING, type Difficulty } from './config';
import { lengthOf, movingFrontAt, OBSTACLES, type Obstacle } from './obstacles';
import type { Rng } from './rng';
import { NORMAL_JUMP } from './runner';
import { tierFor } from './speed';

export type PowerupKind = 'magnet' | 'rocket' | 'chappal';
export const POWERUP_KINDS: readonly PowerupKind[] = ['magnet', 'rocket', 'chappal'];

export interface Coin {
  id: number;
  lane: Lane;
  s: number;
  y: number;
  taken: boolean;
}

export interface Pickup {
  id: number;
  kind: PowerupKind;
  lane: Lane;
  s: number;
  taken: boolean;
}

/** Track is laid out at least this far ahead of the runner. */
export const TRACK_AHEAD = 200;
const TRACK_BEHIND = 30;
const FIRST_CHUNK_S = 30;
const PLACED_HISTORY = 20;

function removeWhere<T>(items: T[], drop: (item: T) => boolean): void {
  let w = 0;
  for (const item of items) if (!drop(item)) items[w++] = item;
  items.length = w;
}

export class Track {
  readonly obstacles: Obstacle[] = [];
  readonly coins: Coin[] = [];
  readonly pickups: Pickup[] = [];
  /** Recently placed chunks, oldest first. */
  readonly placed: { id: string; s: number }[] = [];
  private nextS = FIRST_CHUNK_S;
  private nextId = 1;
  private lastChunk = '';

  constructor(
    private readonly rng: Rng,
    private readonly difficulty: Difficulty,
    private readonly chunks: readonly ChunkDef[] = CHUNKS,
  ) {}

  update(runnerS: number, speed: number, tSec: number, dt: number): void {
    for (const o of this.obstacles) if (OBSTACLES[o.kind].moving) o.front -= TUNING.oncomingTrainSpeed * dt;
    while (this.nextS < runnerS + TRACK_AHEAD) this.placeChunk(runnerS, speed, tSec);
    const cutoff = runnerS - TRACK_BEHIND;
    removeWhere(this.obstacles, (o) => o.front + o.length < cutoff);
    removeWhere(this.coins, (c) => c.taken || c.s < cutoff);
    removeWhere(this.pickups, (p) => p.taken || p.s < cutoff);
  }

  /** Removes every obstacle that overlaps [fromS, toS] (used for a safe rocket landing). */
  clearObstacles(fromS: number, toS: number): void {
    removeWhere(this.obstacles, (o) => o.front < toS && o.front + o.length > fromS);
  }

  addCoinTrail(fromS: number, toS: number, lane: Lane, y: number): void {
    for (let s = fromS; s <= toS + 1e-9; s += TUNING.coinSpacing) this.coins.push({ id: this.nextId++, lane, s, y, taken: false });
  }

  private placeChunk(runnerS: number, speed: number, tSec: number): void {
    const base = this.nextS;
    this.nextS += CHUNK_LENGTH;
    const eta = tSec + Math.max(0, base - runnerS) / speed;
    const tier = tierFor(eta, this.difficulty);
    let pool = this.chunks.filter((c) => c.tier === tier);
    if (pool.length > 1) pool = pool.filter((c) => c.id !== this.lastChunk);
    if (pool.length === 0) return;
    const chunk = this.rng.pick(pool);
    this.lastChunk = chunk.id;
    this.placed.push({ id: chunk.id, s: base });
    if (this.placed.length > PLACED_HISTORY) this.placed.shift();

    for (const spec of chunk.obstacles) {
      const s = base + spec.s;
      this.obstacles.push({
        id: this.nextId++,
        kind: spec.kind,
        lane: spec.lane,
        length: lengthOf(spec),
        front: OBSTACLES[spec.kind].moving ? movingFrontAt(s, runnerS, speed) : s,
      });
    }
    for (const run of chunk.coins) this.addCoinRun(run, base);
    if (chunk.pickup && this.rng.chance(TUNING.pickupChance)) {
      this.pickups.push({
        id: this.nextId++,
        kind: this.rng.pick(POWERUP_KINDS),
        lane: chunk.pickup.lane,
        s: base + chunk.pickup.s,
        taken: false,
      });
    }
  }

  private addCoinRun(run: CoinRun, base: number): void {
    const mid = (run.s0 + run.s1) / 2;
    const half = (run.s1 - run.s0) / 2;
    for (let cs = run.s0; cs <= run.s1 + 1e-9; cs += TUNING.coinSpacing) {
      let y = TUNING.coinHeight;
      if (run.shape === 'roof') y += TUNING.trainHeight;
      if (run.shape === 'arc') y += NORMAL_JUMP.height * (1 - ((cs - mid) / half) ** 2);
      this.coins.push({ id: this.nextId++, lane: run.lane, s: base + cs, y, taken: false });
    }
  }
}
```

In the "moves to harder tiers" test, `placed` keeps only the last 20 entries. Those come from the second update, where every eta is past 300 s, so they are tier 4.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/game/track.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/game/track.ts tests/game/track.test.ts
git commit -m "feat(game): add track generator"
```

---

### Task 7: Power-ups, Josh meter, chaser, stumbles and the idle clock

**Files:**
- Create: `src/game/powerups.ts`, `src/game/rules.ts`
- Test: `tests/game/powerups.test.ts`, `tests/game/rules.test.ts`

**Interfaces:**
- Consumes: `TUNING` (Task 2); `PowerupKind` (Task 6); `ActivityStatus` (Task 1)
- Produces:
  - `class Powerups`
    - timers: `magnet`, `rocket`, `chappal`, `hoverboard`, `grace`
    - `hoverboardsLeft`
    - methods: `activate(kind)`, `activateHoverboard(): boolean`, `absorbCrash(): boolean`, `update(dt): { rocketEnded }`, `reset()`
    - getter: `invulnerable`
  - `class JoshMeter`: `value`, `active`, `multiplier`, `update(dt, cadenceSpm)`, `reset()`
  - `class Chaser`: `gap`, `visible`, `update(dt, close)`, `catchUp()`, `reset()`
  - `class StumbleTracker`: `hit(tSec): 'stumble' | 'caught'`, `recent(tSec)`, `reset()`
  - `IdleLevel` (`'ok' | 'warn' | 'caught'`)
  - `class IdleClock`: `resume(tMs)`, `action(tMs)`, `update(tMs, activity): IdleLevel`, `idleMs(tMs)`

- [ ] **Step 1: Write the failing tests**

`tests/game/powerups.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { JoshMeter, Powerups } from '../../src/game/powerups';

describe('Powerups', () => {
  it('runs each power-up for its duration and reports the rocket ending once', () => {
    const p = new Powerups();
    p.activate('magnet');
    p.activate('rocket');
    p.activate('chappal');
    expect([p.magnet, p.rocket, p.chappal]).toEqual([TUNING.magnetSeconds, TUNING.rocketSeconds, TUNING.chappalSeconds]);
    expect(p.invulnerable).toBe(true);
    expect(p.update(TUNING.rocketSeconds - 0.01).rocketEnded).toBe(false);
    expect(p.update(0.02).rocketEnded).toBe(true);
    expect(p.update(0.02).rocketEnded).toBe(false);
    expect(p.rocket).toBe(0);
    expect(p.magnet).toBeGreaterThan(0);
  });

  it('allows three hoverboards, one at a time, each absorbing one crash', () => {
    const p = new Powerups();
    expect(p.absorbCrash()).toBe(false);
    expect(p.activateHoverboard()).toBe(true);
    expect(p.activateHoverboard()).toBe(false);
    expect(p.absorbCrash()).toBe(true);
    expect(p.hoverboard).toBe(0);
    expect(p.invulnerable).toBe(true);
    p.update(TUNING.crashGraceSeconds + 0.01);
    expect(p.invulnerable).toBe(false);
    expect(p.activateHoverboard()).toBe(true);
    p.update(TUNING.hoverboardSeconds + 0.01);
    expect(p.hoverboard).toBe(0);
    expect(p.activateHoverboard()).toBe(true);
    p.update(TUNING.hoverboardSeconds + 0.01);
    expect(p.activateHoverboard()).toBe(false);
    expect(p.hoverboardsLeft).toBe(0);
    p.reset();
    expect(p.hoverboardsLeft).toBe(TUNING.hoverboardsPerRun);
  });
});

describe('JoshMeter', () => {
  it('fills with a fast cadence, doubles coins while full and drains otherwise', () => {
    const j = new JoshMeter();
    for (let i = 0; i < 290; i++) j.update(1 / 60, 170);
    expect(j.active).toBe(false);
    for (let i = 0; i < 20; i++) j.update(1 / 60, 170);
    expect(j.active).toBe(true);
    expect(j.multiplier).toBe(2);
    for (let i = 0; i < 120; i++) j.update(1 / 60, 150);
    expect(j.active).toBe(true);
    for (let i = 0; i < 70; i++) j.update(1 / 60, 150);
    expect(j.active).toBe(false);
    expect(j.multiplier).toBe(1);
  });
});
```

`tests/game/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { Chaser, IdleClock, StumbleTracker } from '../../src/game/rules';
import type { ActivityStatus } from '../../src/input/commands';

const act = (a: Partial<ActivityStatus>): ActivityStatus => ({
  tracksJogging: true,
  msSinceStep: Infinity,
  cadenceSpm: 0,
  steps: 0,
  squatting: false,
  lost: false,
  ...a,
});

describe('Chaser', () => {
  it('falls back, then closes in when alerted', () => {
    const c = new Chaser();
    expect(c.gap).toBe(TUNING.chaserStartGap);
    expect(c.visible).toBe(true);
    for (let i = 0; i < 240; i++) c.update(1 / 60, false);
    expect(c.gap).toBeGreaterThan(10);
    expect(c.visible).toBe(false);
    for (let i = 0; i < 60; i++) c.update(1 / 60, true);
    expect(c.gap).toBeLessThan(4);
    c.catchUp();
    expect(c.gap).toBeLessThan(1);
  });
});

describe('StumbleTracker', () => {
  it('catches on a second stumble within the window', () => {
    const s = new StumbleTracker();
    expect(s.recent(0)).toBe(false);
    expect(s.hit(10)).toBe('stumble');
    expect(s.recent(15)).toBe(true);
    expect(s.hit(18.5)).toBe('stumble');
    expect(s.hit(20)).toBe('caught');
  });
});

describe('IdleClock', () => {
  it('never catches when jogging is not tracked', () => {
    const c = new IdleClock();
    c.resume(0);
    expect(c.update(10_000, act({ tracksJogging: false }))).toBe('ok');
  });

  it('warns after 1 s and catches after 2 s without steps', () => {
    const c = new IdleClock();
    c.resume(0);
    expect(c.update(999, act({}))).toBe('ok');
    expect(c.update(1000, act({}))).toBe('warn');
    expect(c.update(2000, act({}))).toBe('caught');
  });

  it('counts steps, actions and resumes as activity', () => {
    const c = new IdleClock();
    c.resume(0);
    expect(c.update(1800, act({ msSinceStep: 100 }))).toBe('ok');
    expect(c.update(3000, act({ msSinceStep: 1300 }))).toBe('warn');
    c.action(3000);
    expect(c.update(3500, act({ msSinceStep: 1800 }))).toBe('ok');
    c.resume(10_000);
    expect(c.update(10_500, act({ msSinceStep: 7000 }))).toBe('ok');
    expect(c.idleMs(10_500)).toBe(500);
  });

  it('credits a held squat for at most 1 s', () => {
    const c = new IdleClock();
    c.resume(0);
    c.update(500, act({ squatting: true }));
    expect(c.update(2400, act({ squatting: true }))).toBe('ok');
    expect(c.update(2500, act({ squatting: true }))).toBe('warn');
    expect(c.update(3500, act({ squatting: true }))).toBe('caught');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/game/powerups.test.ts tests/game/rules.test.ts`
Expected: FAIL because the modules are not found.

- [ ] **Step 3: Write `src/game/powerups.ts`**

```ts
import { TUNING } from './config';
import type { PowerupKind } from './track';

/** Remaining seconds for each timed power-up. */
export class Powerups {
  magnet = 0;
  rocket = 0;
  chappal = 0;
  hoverboard = 0;
  /** Invulnerability after a hoverboard crash or a rocket landing. */
  grace = 0;
  hoverboardsLeft = TUNING.hoverboardsPerRun;

  get invulnerable(): boolean {
    return this.rocket > 0 || this.grace > 0;
  }

  activate(kind: PowerupKind): void {
    if (kind === 'magnet') this.magnet = TUNING.magnetSeconds;
    else if (kind === 'rocket') this.rocket = TUNING.rocketSeconds;
    else this.chappal = TUNING.chappalSeconds;
  }

  activateHoverboard(): boolean {
    if (this.hoverboard > 0 || this.hoverboardsLeft <= 0) return false;
    this.hoverboardsLeft--;
    this.hoverboard = TUNING.hoverboardSeconds;
    return true;
  }

  /** Uses up an active hoverboard to survive a head-on crash. */
  absorbCrash(): boolean {
    if (this.hoverboard <= 0) return false;
    this.hoverboard = 0;
    this.grace = TUNING.crashGraceSeconds;
    return true;
  }

  update(dt: number): { rocketEnded: boolean } {
    const hadRocket = this.rocket > 0;
    this.magnet = Math.max(0, this.magnet - dt);
    this.rocket = Math.max(0, this.rocket - dt);
    this.chappal = Math.max(0, this.chappal - dt);
    this.hoverboard = Math.max(0, this.hoverboard - dt);
    this.grace = Math.max(0, this.grace - dt);
    return { rocketEnded: hadRocket && this.rocket === 0 };
  }

  reset(): void {
    this.magnet = this.rocket = this.chappal = this.hoverboard = this.grace = 0;
    this.hoverboardsLeft = TUNING.hoverboardsPerRun;
  }
}

/** Fills while the player jogs fast; while full, coins count double until it drains empty. */
export class JoshMeter {
  value = 0;
  active = false;

  get multiplier(): number {
    return this.active ? 2 : 1;
  }

  update(dt: number, cadenceSpm: number): void {
    const rate = cadenceSpm >= TUNING.joshCadence ? 1 / TUNING.joshFillSeconds : -1 / TUNING.joshDrainSeconds;
    this.value = Math.min(1, Math.max(0, this.value + rate * dt));
    if (this.value >= 1) this.active = true;
    if (this.value <= 0) this.active = false;
  }

  reset(): void {
    this.value = 0;
    this.active = false;
  }
}
```

- [ ] **Step 4: Write `src/game/rules.ts`**

```ts
import type { ActivityStatus } from '../input/commands';
import { TUNING } from './config';

const RECEDE_RATE = 0.6;
const APPROACH_RATE = 3;
const CAUGHT_GAP = 0.5;

/** The TT and dog: how far behind the runner they are. */
export class Chaser {
  gap = TUNING.chaserStartGap;

  get visible(): boolean {
    return this.gap < TUNING.chaserFarGap - 1;
  }

  update(dt: number, close: boolean): void {
    const target = close ? TUNING.chaserNearGap : TUNING.chaserFarGap;
    const rate = target < this.gap ? APPROACH_RATE : RECEDE_RATE;
    this.gap += (target - this.gap) * (1 - Math.exp(-rate * dt));
  }

  catchUp(): void {
    this.gap = CAUGHT_GAP;
  }

  reset(): void {
    this.gap = TUNING.chaserStartGap;
  }
}

/** A second side-clip within the window means caught. */
export class StumbleTracker {
  private last = -Infinity;

  hit(tSec: number): 'stumble' | 'caught' {
    const caught = this.recent(tSec);
    this.last = tSec;
    return caught ? 'caught' : 'stumble';
  }

  recent(tSec: number): boolean {
    return tSec - this.last <= TUNING.stumbleWindowSeconds;
  }

  reset(): void {
    this.last = -Infinity;
  }
}

export type IdleLevel = 'ok' | 'warn' | 'caught';

/**
 * The game's own "stopped jogging" clock (spec §5.5). Steps, jumps, rolls,
 * lane changes and resuming all count as activity; a held squat counts for at most 1 s.
 */
export class IdleClock {
  private lastActive = 0;
  private squatSince: number | null = null;

  resume(tMs: number): void {
    this.lastActive = tMs;
    this.squatSince = null;
  }

  action(tMs: number): void {
    this.lastActive = Math.max(this.lastActive, tMs);
  }

  idleMs(tMs: number): number {
    return tMs - this.lastActive;
  }

  update(tMs: number, a: ActivityStatus): IdleLevel {
    if (!a.tracksJogging) {
      this.lastActive = tMs;
      return 'ok';
    }
    if (Number.isFinite(a.msSinceStep)) this.lastActive = Math.max(this.lastActive, tMs - a.msSinceStep);
    if (a.squatting) {
      this.squatSince ??= tMs;
      this.lastActive = Math.max(this.lastActive, Math.min(tMs, this.squatSince + TUNING.squatIdleCreditMs));
    } else {
      this.squatSince = null;
    }
    const idle = this.idleMs(tMs);
    return idle >= TUNING.idleCaughtMs ? 'caught' : idle >= TUNING.idleWarnMs ? 'warn' : 'ok';
  }
}
```

Checking the tests against this code:
- **Squat test:** the squat starts at 500, so the credit caps `lastActive` at 1500. Idle is 900 ms at 2400 (ok), 1000 ms at 2500 (warn) and 2000 ms at 3500 (caught).
- **Josh test:** the meter fills in 5 s (300 frames), so 290 frames is not full and 310 is. It then drains over 3 s (180 frames): after 120 frames it is still active, after 190 it is inactive.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/game && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/game/powerups.ts src/game/rules.ts tests/game/powerups.test.ts tests/game/rules.test.ts
git commit -m "feat(game): add power-ups, josh meter, chaser and idle rules"
```

---
### Task 8: Game state machine, autopilot and fixed stepper

**Files:**
- Create: `src/game/game.ts`, `src/game/autopilot.ts`, `src/game/loop.ts`
- Modify: `src/game/config.ts` (add pickup/coin reach constants), `src/game/track.ts` (add `removeObstacle`)
- Test: `tests/game/game.test.ts`, `tests/game/autopilot.test.ts`, `tests/game/loop.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7
- Produces:
  - Types: `GameState` (`'menu' | 'countdown' | 'playing' | 'paused' | 'caught' | 'summary'`), `CaughtReason`, `GameEvent`, `GameOptions { seed; difficulty; god?; chunks? }`, `RunStats`
  - `class Game`
    - public fields: `state`, `countdown`, `time`, `s`, `speed`, `idleLevel`, `caughtReason`, `pausedByLoss`, `runner`, `track`, `powerups`, `josh`, `chaser`, `stats`, `options`
    - methods: `step(dt, commands, activity): GameEvent[]`, `pause()`
  - `liveSpecs(obstacles, runnerS, speed)`
  - `class Autopilot(game)`, a `CommandSource` with `tick()`
  - `class FixedStepper(stepSec = 1/60, maxFrameSec = 0.25)` with `advance(frameSec): number`

  Per-step order in `playing`:
  1. lost → pause
  2. pause command → pause
  3. apply commands
  4. time, speed and `s`
  5. track update
  6. power-up timers (rocket landing clears the way ahead)
  7. runner update with the surface at the new `s`
  8. collect coins and pickups
  9. collisions
  10. idle clock
  11. Josh meter
  12. chaser
  13. stats

  This order must match `tests/game/helpers/replay.ts`.

- [ ] **Step 1: Add constants and `removeObstacle`**

In `src/game/config.ts`, add to `TUNING` under `// world`:
```ts
  coinReach: 1,
  coinReachHeight: 0.5,
  magnetCollect: 1.5,
  pickupReach: 1,
  pickupMaxHeight: 1.5,
```

In `src/game/track.ts`, add this method to `Track`:
```ts
  removeObstacle(id: number): void {
    removeWhere(this.obstacles, (o) => o.id === id);
  }
```

- [ ] **Step 2: Write the failing tests**

`tests/game/loop.test.ts`:
```ts
import { expect, it } from 'vitest';
import { FixedStepper } from '../../src/game/loop';

it('turns variable frames into fixed steps and caps long frames', () => {
  const f = new FixedStepper();
  expect(f.advance(1 / 60)).toBe(1);
  expect(f.advance(1 / 120)).toBe(0);
  expect(f.advance(1 / 120)).toBe(1);
  expect(f.advance(0.1)).toBe(6);
  expect(f.advance(5)).toBe(15);
  expect(f.advance(-1)).toBe(0);
});
```

`tests/game/game.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { TUNING } from '../../src/game/config';
import { Game, type GameEvent, type GameOptions } from '../../src/game/game';
import { lengthOf, type ObstacleSpec } from '../../src/game/obstacles';
import type { ActivityStatus, GameCommand } from '../../src/input/commands';

const EMPTY: ChunkDef[] = [{ id: 'empty', tier: 0, obstacles: [], coins: [] }];
const KEYBOARD: ActivityStatus = { tracksJogging: false, msSinceStep: Infinity, cadenceSpm: 0, steps: 0, squatting: false, lost: false };
const STILL: ActivityStatus = { ...KEYBOARD, tracksJogging: true };
const JOGGING: ActivityStatus = { ...STILL, msSinceStep: 0, cadenceSpm: 150 };

function steps(g: Game, n: number, cmds: GameCommand[] = [], a: ActivityStatus = KEYBOARD): GameEvent[] {
  const events: GameEvent[] = [];
  for (let i = 0; i < n; i++) events.push(...g.step(1 / 60, i === 0 ? cmds : [], a));
  return events;
}

function playing(opts: Partial<GameOptions> = {}, a: ActivityStatus = KEYBOARD): Game {
  const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY, ...opts });
  steps(g, 1, [{ type: 'start' }], a);
  steps(g, 180, [], a);
  expect(g.state).toBe('playing');
  return g;
}

let nextId = 10_000;
function place(g: Game, spec: ObstacleSpec): number {
  const id = nextId++;
  g.track.obstacles.push({ id, kind: spec.kind, lane: spec.lane, length: lengthOf(spec), front: spec.s });
  return id;
}

/** Steps until the runner reaches s (or n frames pass). */
function stepTo(g: Game, s: number, a: ActivityStatus = KEYBOARD) {
  for (let i = 0; i < 600 && g.s < s && g.state === 'playing'; i++) g.step(1 / 60, [], a);
}

describe('Game states', () => {
  it('goes from menu through a 3 s countdown into play', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    expect(g.state).toBe('menu');
    steps(g, 10);
    expect(g.state).toBe('menu');
    const ev = steps(g, 1, [{ type: 'start' }]);
    expect(ev).toContainEqual({ type: 'state', state: 'countdown' });
    steps(g, 179);
    expect(g.state).toBe('countdown');
    steps(g, 1);
    expect(g.state).toBe('playing');
    steps(g, 60);
    expect(g.s).toBeCloseTo(12, 0);
  });

  it('pauses when the player is lost and counts down again when found', () => {
    const g = playing();
    steps(g, 1, [], { ...KEYBOARD, lost: true });
    expect(g.state).toBe('paused');
    expect(g.pausedByLoss).toBe(true);
    steps(g, 30, [], { ...KEYBOARD, lost: true });
    expect(g.state).toBe('paused');
    steps(g, 1);
    expect(g.state).toBe('countdown');
    steps(g, 180);
    expect(g.state).toBe('playing');
  });

  it('pauses on command and resumes on Enter', () => {
    const g = playing();
    steps(g, 1, [{ type: 'pause' }]);
    expect(g.state).toBe('paused');
    steps(g, 60);
    expect(g.state).toBe('paused');
    steps(g, 1, [{ type: 'start' }]);
    expect(g.state).toBe('countdown');
    g.pause();
    expect(g.state).toBe('paused');
  });

  it('is deterministic for a seed', () => {
    const run = () => {
      const g = new Game({ seed: 9, difficulty: 'cardio' });
      steps(g, 1, [{ type: 'start' }]);
      steps(g, 900, [], { ...KEYBOARD });
      return [g.s, g.state, g.track.obstacles.map((o) => `${o.kind}@${o.front.toFixed(3)}`).join()];
    };
    expect(run()).toEqual(run());
  });
});

describe('Jog rule', () => {
  it('never applies to keyboard-only play', () => {
    const g = playing();
    steps(g, 600);
    expect(g.state).toBe('playing');
  });

  it('warns after 1 s and catches after 2 s without jogging', () => {
    const g = playing({}, STILL);
    steps(g, 61, [], STILL);
    expect(g.idleLevel).toBe('warn');
    expect(g.chaser.gap).toBeLessThan(TUNING.chaserFarGap);
    steps(g, 60, [], STILL);
    expect(g.state).toBe('caught');
    expect(g.caughtReason).toBe('idle');
  });

  it('keeps going while jogging, and a jump counts as movement', () => {
    const g = playing({}, JOGGING);
    steps(g, 300, [], JOGGING);
    expect(g.state).toBe('playing');
    steps(g, 50, [], STILL);
    steps(g, 50, [{ type: 'jump' }], STILL);
    expect(g.state).toBe('playing');
    expect(g.idleLevel).toBe('ok');
  });

  it('does not catch while cheating is on (god mode)', () => {
    const g = playing({ god: true }, STILL);
    steps(g, 300, [], STILL);
    expect(g.state).toBe('playing');
  });
});

describe('Collisions', () => {
  it('ends the run on a head-on crash and starts a fresh run afterwards', () => {
    const g = playing();
    place(g, { kind: 'auto', lane: 0, s: g.s + 10 });
    const ev = steps(g, 90);
    expect(g.state).toBe('caught');
    expect(g.caughtReason).toBe('crash');
    expect(ev).toContainEqual({ type: 'caught', reason: 'crash' });
    steps(g, 90);
    expect(g.state).toBe('summary');
    const distance = g.stats.distance;
    expect(distance).toBeGreaterThan(9);
    steps(g, 1, [{ type: 'start' }]);
    expect(g.state).toBe('countdown');
    expect(g.s).toBe(0);
    expect(g.stats.distance).toBe(0);
  });

  it('survives one crash on a hoverboard', () => {
    const g = playing();
    const id = place(g, { kind: 'auto', lane: 0, s: g.s + 10 });
    const ev = steps(g, 90, [{ type: 'hoverboard' }]);
    expect(g.state).toBe('playing');
    expect(ev).toContainEqual({ type: 'hoverboardSaved' });
    expect(g.track.obstacles.some((o) => o.id === id)).toBe(false);
    expect(g.powerups.hoverboardsLeft).toBe(TUNING.hoverboardsPerRun - 1);
    expect(g.stats.hoverboardsUsed).toBe(1);
  });

  it('clears a barrier with a well-timed jump', () => {
    const g = playing();
    const front = g.s + 12;
    place(g, { kind: 'barrierLow', lane: 0, s: front });
    stepTo(g, front - 0.3 * g.speed);
    steps(g, 1, [{ type: 'jump' }]);
    steps(g, 60);
    expect(g.state).toBe('playing');
    expect(g.stats.jumps).toBe(1);
  });

  it('rolls under a banner', () => {
    const g = playing();
    const front = g.s + 12;
    place(g, { kind: 'bannerHigh', lane: 0, s: front });
    stepTo(g, front - 3);
    steps(g, 1, [{ type: 'roll' }]);
    steps(g, 60);
    expect(g.state).toBe('playing');
    expect(g.stats.rolls).toBe(1);
  });

  it('stumbles on a side clip and is caught by a second one within 8 s', () => {
    const g = playing();
    for (const round of [1, 2]) {
      const front = g.s + 8;
      place(g, { kind: 'auto', lane: 1, s: front });
      stepTo(g, front - 0.9);
      const ev = steps(g, 20, [{ type: 'shiftLane', dir: 1 }]);
      if (round === 1) {
        expect(ev).toContainEqual({ type: 'stumble' });
        expect(g.state).toBe('playing');
        expect(g.runner.lane).toBe(0);
      } else {
        expect(g.state).toBe('caught');
        expect(g.caughtReason).toBe('stumble');
      }
    }
  });

  it('ignores obstacles in god mode', () => {
    const g = playing({ god: true });
    place(g, { kind: 'auto', lane: 0, s: g.s + 5 });
    steps(g, 60);
    expect(g.state).toBe('playing');
  });
});

describe('Coins and power-ups', () => {
  it('collects coins in the runner lane only, unless magnetised', () => {
    const g = playing();
    g.track.coins.push({ id: 1, lane: 0, s: g.s + 5, y: TUNING.coinHeight, taken: false });
    g.track.coins.push({ id: 2, lane: 1, s: g.s + 5, y: TUNING.coinHeight, taken: false });
    const ev = steps(g, 40);
    expect(g.stats.coins).toBe(1);
    expect(ev.filter((e) => e.type === 'coin')).toHaveLength(1);
    g.powerups.activate('magnet');
    g.track.coins.push({ id: 3, lane: 1, s: g.s + 5, y: TUNING.coinHeight, taken: false });
    g.track.coins.push({ id: 4, lane: -1, s: g.s + 6, y: TUNING.coinHeight + TUNING.trainHeight, taken: false });
    steps(g, 40);
    expect(g.stats.coins).toBe(3);
  });

  it('doubles coins while the Josh meter is full', () => {
    const g = playing({}, { ...JOGGING, cadenceSpm: 170 });
    steps(g, 320, [], { ...JOGGING, cadenceSpm: 170 });
    expect(g.josh.active).toBe(true);
    g.track.coins.push({ id: 5, lane: 0, s: g.s + 3, y: TUNING.coinHeight, taken: false });
    steps(g, 20, [], { ...JOGGING, cadenceSpm: 170 });
    expect(g.stats.coins).toBe(2);
  });

  it('flies over everything on a rocket and lands safely', () => {
    const g = playing();
    g.track.pickups.push({ id: 7, kind: 'rocket', lane: 0, s: g.s + 5, taken: false });
    const ev = steps(g, 40);
    expect(ev).toContainEqual({ type: 'pickup', kind: 'rocket' });
    expect(g.powerups.rocket).toBeGreaterThan(0);
    expect(g.track.coins.some((c) => c.y === TUNING.rocketHeight)).toBe(true);
    place(g, { kind: 'auto', lane: 0, s: g.s + 20 });
    steps(g, 60);
    expect(g.runner.y).toBeCloseTo(TUNING.rocketHeight, 6);
    place(g, { kind: 'auto', lane: 0, s: g.s + (TUNING.rocketSeconds - 1.5) * g.speed + 10 });
    const landing = steps(g, 60 * TUNING.rocketSeconds);
    expect(landing).toContainEqual({ type: 'rocketLanding' });
    steps(g, 180);
    expect(g.state).toBe('playing');
    expect(g.runner.y).toBe(0);
  });

  it('jumps higher with chappals', () => {
    const g = playing();
    g.powerups.activate('chappal');
    steps(g, 1, [{ type: 'jump' }]);
    let top = 0;
    for (let i = 0; i < 60; i++) {
      steps(g, 1);
      top = Math.max(top, g.runner.y);
    }
    expect(top).toBeGreaterThan(3.5);
  });
});
```

`tests/game/autopilot.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TUNING, type Difficulty } from '../../src/game/config';
import { Autopilot, liveSpecs } from '../../src/game/autopilot';
import { Game } from '../../src/game/game';
import { movingFrontAt } from '../../src/game/obstacles';

function drive(seed: number, difficulty: Difficulty, seconds: number): Game {
  const g = new Game({ seed, difficulty });
  const bot = new Autopilot(g);
  let tMs = 0;
  for (let i = 0; i < seconds * TUNING.stepHz; i++) {
    bot.tick();
    g.step(1 / TUNING.stepHz, bot.drain(), bot.activity(tMs));
    tMs += 1000 / TUNING.stepHz;
    if (g.state === 'caught') break;
  }
  return g;
}

function context(g: Game): string {
  const near = g.track.obstacles
    .filter((o) => o.front + o.length > g.s - 5 && o.front < g.s + 30)
    .map((o) => `${o.kind}/L${o.lane}@${o.front.toFixed(1)}`)
    .join(' ');
  return `caught (${g.caughtReason}) at s=${g.s.toFixed(1)} v=${g.speed.toFixed(1)} lane=${g.runner.lane} y=${g.runner.y.toFixed(2)}; chunks ${g.track.placed
    .slice(-5)
    .map((p) => `${p.id}@${p.s}`)
    .join(', ')}; near: ${near}`;
}

describe('Autopilot', () => {
  it('converts oncoming trains back to meeting points', () => {
    const front = movingFrontAt(120, 20, 25);
    const [spec] = liveSpecs([{ id: 1, kind: 'trainMoving', lane: 0, length: 30, front }], 20, 25);
    expect(spec.s).toBeCloseTo(120, 9);
    expect(spec.length).toBe(30);
  });

  it.each([1, 2, 3])('survives five minutes on cardio (seed %i)', (seed) => {
    const g = drive(seed, 'cardio', 305);
    expect(g.caughtReason, context(g)).toBeNull();
    expect(g.state).toBe('playing');
    expect(g.s).toBeGreaterThan(5000);
    expect(g.stats.coins).toBeGreaterThan(0);
    expect(g.stats.steps).toBeGreaterThan(0);
  }, 180_000);

  it('survives three minutes on beast', () => {
    const g = drive(4, 'beast', 185);
    expect(g.caughtReason, context(g)).toBeNull();
    expect(g.state).toBe('playing');
  }, 180_000);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/game/loop.test.ts tests/game/game.test.ts tests/game/autopilot.test.ts`
Expected: FAIL because the modules are not found.

- [ ] **Step 4: Write `src/game/loop.ts`**

```ts
import { TUNING } from './config';

/** Converts variable frame times into a whole number of fixed simulation steps. */
export class FixedStepper {
  private acc = 0;

  constructor(
    readonly stepSec = 1 / TUNING.stepHz,
    readonly maxFrameSec = 0.25,
  ) {}

  advance(frameSec: number): number {
    this.acc += Math.min(Math.max(frameSec, 0), this.maxFrameSec);
    const n = Math.floor(this.acc / this.stepSec + 1e-9);
    this.acc = Math.max(0, this.acc - n * this.stepSec);
    return n;
  }
}
```

- [ ] **Step 5: Write `src/game/game.ts`**

```ts
import type { ActivityStatus, GameCommand } from '../input/commands';
import type { ChunkDef } from './chunks';
import { findHit, surfaceAt, type RunnerBox } from './collision';
import { laneX, TUNING, type Difficulty } from './config';
import { JoshMeter, Powerups } from './powerups';
import { Rng } from './rng';
import { Chaser, IdleClock, StumbleTracker, type IdleLevel } from './rules';
import { CHAPPAL_JUMP, NORMAL_JUMP, Runner } from './runner';
import { speedAt } from './speed';
import { Track, type PowerupKind } from './track';

export type GameState = 'menu' | 'countdown' | 'playing' | 'paused' | 'caught' | 'summary';
export type CaughtReason = 'crash' | 'stumble' | 'idle';

export type GameEvent =
  | { type: 'state'; state: GameState }
  | { type: 'jump' }
  | { type: 'roll' }
  | { type: 'lane' }
  | { type: 'coin' }
  | { type: 'pickup'; kind: PowerupKind }
  | { type: 'hoverboard' }
  | { type: 'hoverboardSaved' }
  | { type: 'stumble' }
  | { type: 'caught'; reason: CaughtReason }
  | { type: 'rocketLanding' };

export interface GameOptions {
  seed: number;
  difficulty: Difficulty;
  /** Debug: no crashes, no idle catch. */
  god?: boolean;
  /** Override the chunk set (tests). */
  chunks?: readonly ChunkDef[];
}

export interface RunStats {
  distance: number;
  coins: number;
  score: number;
  timeSec: number;
  jumps: number;
  rolls: number;
  laneChanges: number;
  steps: number;
  hoverboardsUsed: number;
}

const emptyStats = (): RunStats => ({
  distance: 0,
  coins: 0,
  score: 0,
  timeSec: 0,
  jumps: 0,
  rolls: 0,
  laneChanges: 0,
  steps: 0,
  hoverboardsUsed: 0,
});

/** Extra time the path ahead is cleared for after a rocket, covering the fall back down. */
const ROCKET_FALL_SECONDS = 1.5;

export class Game {
  state: GameState = 'menu';
  countdown = 0;
  /** Seconds of play in the current run. */
  time = 0;
  s = 0;
  speed = TUNING.startSpeed;
  idleLevel: IdleLevel = 'ok';
  caughtReason: CaughtReason | null = null;
  pausedByLoss = false;
  runner = new Runner();
  track: Track;
  readonly powerups = new Powerups();
  readonly josh = new JoshMeter();
  readonly chaser = new Chaser();
  stats: RunStats = emptyStats();

  private readonly idle = new IdleClock();
  private readonly stumbles = new StumbleTracker();
  /** Milliseconds since the game was created (drives the idle clock). */
  private clockMs = 0;
  private catchTimer = 0;
  private runs = 0;
  private stepsAtStart = 0;

  constructor(readonly options: GameOptions) {
    this.track = this.newTrack();
  }

  pause(): void {
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    this.pausedByLoss = false;
    this.state = 'paused';
  }

  step(dt: number, commands: readonly GameCommand[], activity: ActivityStatus): GameEvent[] {
    const events: GameEvent[] = [];
    this.clockMs += dt * 1000;
    const wants = (type: GameCommand['type']) => commands.some((c) => c.type === type);

    switch (this.state) {
      case 'menu':
      case 'summary':
        if (wants('start')) this.startRun(activity, events);
        break;
      case 'countdown':
        if (activity.lost) {
          this.pausedByLoss = true;
          this.setState('paused', events);
          break;
        }
        this.countdown -= dt;
        if (this.countdown <= 1e-9) {
          this.idle.resume(this.clockMs);
          this.setState('playing', events);
        }
        break;
      case 'paused': {
        const resume = this.pausedByLoss ? !activity.lost : wants('start') || wants('pause');
        if (resume) {
          this.countdown = TUNING.countdownSeconds;
          this.setState('countdown', events);
        }
        break;
      }
      case 'playing':
        this.play(dt, commands, activity, events);
        break;
      case 'caught':
        this.catchTimer -= dt;
        if (this.catchTimer <= 1e-9) this.setState('summary', events);
        break;
    }
    return events;
  }

  private startRun(activity: ActivityStatus, events: GameEvent[]): void {
    this.track = this.newTrack();
    this.runs++;
    this.runner = new Runner();
    this.powerups.reset();
    this.josh.reset();
    this.chaser.reset();
    this.stumbles.reset();
    this.time = 0;
    this.s = 0;
    this.speed = TUNING.startSpeed;
    this.idleLevel = 'ok';
    this.caughtReason = null;
    this.stats = emptyStats();
    this.stepsAtStart = activity.steps;
    this.countdown = TUNING.countdownSeconds;
    this.setState('countdown', events);
  }

  private newTrack(): Track {
    return new Track(new Rng(this.options.seed + this.runs), this.options.difficulty, this.options.chunks);
  }

  private play(dt: number, commands: readonly GameCommand[], activity: ActivityStatus, events: GameEvent[]): void {
    if (activity.lost) {
      this.pausedByLoss = true;
      this.setState('paused', events);
      return;
    }
    if (commands.some((c) => c.type === 'pause')) {
      this.pausedByLoss = false;
      this.setState('paused', events);
      return;
    }
    for (const c of commands) this.apply(c, events);

    this.time += dt;
    this.speed = speedAt(this.time, this.options.difficulty);
    this.s += this.speed * dt;
    this.track.update(this.s, this.speed, this.time, dt);

    const p = this.powerups;
    if (p.update(dt).rocketEnded) {
      this.track.clearObstacles(this.s, this.s + this.speed * (TUNING.rocketLandingClearSeconds + ROCKET_FALL_SECONDS));
      p.grace = Math.max(p.grace, TUNING.rocketLandingClearSeconds + ROCKET_FALL_SECONDS);
      events.push({ type: 'rocketLanding' });
    }
    const r = this.runner;
    r.flying = p.rocket > 0;
    r.update(dt, surfaceAt(this.box(), this.track.obstacles));

    this.collect(events);
    this.collide(events);
    if (this.state !== 'playing') return;

    this.idleLevel = this.idle.update(this.clockMs, activity);
    if (this.idleLevel === 'caught' && !this.options.god) {
      this.catchPlayer('idle', events);
      return;
    }
    this.josh.update(dt, activity.tracksJogging ? activity.cadenceSpm : 0);
    this.chaser.update(dt, this.idleLevel !== 'ok' || this.stumbles.recent(this.time));

    this.stats.distance = this.s;
    this.stats.timeSec = this.time;
    this.stats.steps = Math.max(0, activity.steps - this.stepsAtStart);
    this.stats.score = Math.floor(this.s) + this.stats.coins;
  }

  private apply(c: GameCommand, events: GameEvent[]): void {
    const r = this.runner;
    switch (c.type) {
      case 'setLane':
      case 'shiftLane': {
        const moved = c.type === 'setLane' ? r.setLane(c.lane) : r.shiftLane(c.dir);
        if (moved) {
          this.stats.laneChanges++;
          this.idle.action(this.clockMs);
          events.push({ type: 'lane' });
        }
        break;
      }
      case 'jump':
        if (r.jump(this.powerups.chappal > 0 ? CHAPPAL_JUMP : NORMAL_JUMP)) {
          this.stats.jumps++;
          this.idle.action(this.clockMs);
          events.push({ type: 'jump' });
        }
        break;
      case 'roll':
        if (r.roll()) {
          this.stats.rolls++;
          this.idle.action(this.clockMs);
          events.push({ type: 'roll' });
        }
        break;
      case 'hoverboard':
        if (this.powerups.activateHoverboard()) {
          this.stats.hoverboardsUsed++;
          events.push({ type: 'hoverboard' });
        }
        break;
      default:
        break;
    }
  }

  private box(): RunnerBox {
    const r = this.runner;
    return { s: this.s, x: r.x, y: r.y, height: r.height };
  }

  private collect(events: GameEvent[]): void {
    const r = this.runner;
    const magnet = this.powerups.magnet > 0;
    for (const c of this.track.coins) {
      if (c.taken) continue;
      const ds = c.s - this.s;
      if (ds < -TUNING.coinReach) continue;
      const got = magnet
        ? ds <= TUNING.magnetCollect
        : ds <= TUNING.coinReach &&
          Math.abs(laneX(c.lane) - r.x) < TUNING.coinReach &&
          c.y >= r.y - TUNING.coinReachHeight &&
          c.y <= r.y + r.height + TUNING.coinReachHeight;
      if (!got) continue;
      c.taken = true;
      this.stats.coins += this.josh.multiplier;
      events.push({ type: 'coin' });
    }
    for (const pk of this.track.pickups) {
      if (pk.taken || r.flying || r.y > TUNING.pickupMaxHeight) continue;
      if (Math.abs(pk.s - this.s) > TUNING.pickupReach || Math.abs(laneX(pk.lane) - r.x) >= TUNING.pickupReach) continue;
      pk.taken = true;
      this.powerups.activate(pk.kind);
      events.push({ type: 'pickup', kind: pk.kind });
      if (pk.kind === 'rocket') {
        this.track.addCoinTrail(this.s + 15, this.s + this.speed * TUNING.rocketSeconds - 10, r.lane, TUNING.rocketHeight);
      }
    }
  }

  private collide(events: GameEvent[]): void {
    if (this.options.god || this.powerups.invulnerable) return;
    const r = this.runner;
    const hit = findHit(this.box(), r.lane, r.changingLane, this.track.obstacles);
    if (!hit) return;
    if (hit.kind === 'side') {
      r.bounceBack();
      events.push({ type: 'stumble' });
      if (this.stumbles.hit(this.time) === 'caught') this.catchPlayer('stumble', events);
      return;
    }
    if (this.powerups.absorbCrash()) {
      this.track.removeObstacle(hit.obstacle.id);
      events.push({ type: 'hoverboardSaved' });
      return;
    }
    this.catchPlayer('crash', events);
  }

  private catchPlayer(reason: CaughtReason, events: GameEvent[]): void {
    this.caughtReason = reason;
    this.catchTimer = TUNING.catchSeconds;
    this.chaser.catchUp();
    this.setState('caught', events);
    events.push({ type: 'caught', reason });
  }

  private setState(state: GameState, events: GameEvent[]): void {
    this.state = state;
    events.push({ type: 'state', state });
  }
}
```

- [ ] **Step 6: Write `src/game/autopilot.ts`**

```ts
import type { ActivityStatus, CommandSource, GameCommand } from '../input/commands';
import { TUNING } from './config';
import type { Game } from './game';
import { meetPointOf, OBSTACLES, type Obstacle, type ObstacleSpec } from './obstacles';
import { plan, toBlocks, type PlanAction } from './solver';

/** Metres between replans while the runner is settled. */
const REPLAN_EVERY = 4;
/** The bot reacts faster than a person. */
const BOT_MIN_GAP = 0.3;
const HORIZON_SECONDS = 3;
const MIN_HORIZON = 60;
const BOT_CADENCE = 165;
const ROOF_TOLERANCE = 0.1;

/** Current obstacles as specs the solver understands (oncoming trains back to meeting points). */
export function liveSpecs(obstacles: readonly Obstacle[], runnerS: number, speed: number): ObstacleSpec[] {
  return obstacles.map((o) => ({
    kind: o.kind,
    lane: o.lane,
    length: o.length,
    s: OBSTACLES[o.kind].moving ? meetPointOf(o.front, runnerS, speed) : o.front,
  }));
}

/** A bot player for demos and integration tests: plans with the solver and always "jogs". */
export class Autopilot implements CommandSource {
  private queue: GameCommand[] = [];
  private actions: PlanAction[] = [];
  private plannedAt = -Infinity;

  constructor(private readonly game: Game) {}

  drain(): GameCommand[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  activity(tMs: number): ActivityStatus {
    return {
      tracksJogging: true,
      msSinceStep: 0,
      cadenceSpm: BOT_CADENCE,
      steps: Math.floor(tMs / (60_000 / BOT_CADENCE)),
      squatting: false,
      lost: false,
    };
  }

  /** Call once before every game step. */
  tick(): void {
    const g = this.game;
    if (g.state === 'menu' || g.state === 'summary') {
      this.queue.push({ type: 'start' });
      this.actions = [];
      this.plannedAt = -Infinity;
      return;
    }
    if (g.state !== 'playing') return;
    const r = g.runner;
    const settled = !r.airborne && !r.rolling && !r.changingLane && !r.flying;
    if (settled && g.s - this.plannedAt >= REPLAN_EVERY) this.replan();
    while (this.actions.length && this.actions[0].s <= g.s + 1e-6) {
      const a = this.actions.shift()!;
      this.queue.push(a.type === 'lane' ? { type: 'setLane', lane: a.lane } : { type: a.type });
    }
  }

  private replan(): void {
    const g = this.game;
    const specs = liveSpecs(g.track.obstacles, g.s, g.speed);
    const horizon = Math.max(MIN_HORIZON, g.speed * HORIZON_SECONDS);
    const onRoof = g.runner.y >= TUNING.trainHeight - ROOF_TOLERANCE;
    this.actions =
      plan(toBlocks(specs, g.speed), g.s, g.s + horizon, {
        speed: g.speed,
        minGap: BOT_MIN_GAP,
        startLane: g.runner.lane,
        onRoof,
      }) ?? [];
    this.plannedAt = g.s;
  }
}
```

- [ ] **Step 7: Run the tests and make them pass**

Run: `npx vitest run tests/game`

The unit tests in `game.test.ts` should pass as written. If a timing-sensitive collision test is off by a frame, check the per-step order above before changing numbers.

The autopilot tests are the integration check: the solver, physics, track and rules must all agree. If the bot gets caught:
1. Read the `context(...)` message to find the chunk and obstacle.
2. Reproduce it in a focused test.
3. Fix the real cause. For example: an action emitted a frame late, a moving-train margin, or a roof edge.

Do not add special cases to the bot to dodge a real game bug. If the cause is a chunk that cannot be passed at the real speed, fix the chunk data and add the case to `chunks.test.ts`. Report every root cause.

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/game tests/game
git commit -m "feat(game): add game state machine, autopilot and fixed stepper"
```

---
### Task 9: Placeholder 3D world

**Files:**
- Create: `src/world/worldMath.ts`, `src/world/worldView.ts`
- Modify: `package.json` (add `three`, `@types/three`)
- Test: `tests/world/worldMath.test.ts`

**Interfaces:**
- Consumes: `Game` (Task 8); `OBSTACLES`, `ObstacleKind` (Task 4); `PowerupKind` (Task 6); `TUNING`, `LANE_WIDTH`, `laneX` (Task 2)
- Produces:
  - `repeatingOffsets(s, spacing, behind, ahead): number[]`, which gives the distances ahead of the runner of items placed every `spacing` metres
  - `BUILDING_SLOT`, `BUILDING_PALETTE`, `buildingAt(k, side)`
  - `class WorldView(canvas)`
    - methods: `resize(w, h, dpr)`, `render(game, dtSec)`, `dispose()`
    - getter: `stats` (`{ calls, triangles, pixelRatio }`)

  Scene contents:
  - **Look:** a warm dusk sky colour with fog.
  - **Ground and track:** a dusty ground plane, three ballast strips with rails, and instanced sleepers.
  - **Buildings:** instanced, colourful blocks on both sides.
  - **Obstacles:** coloured boxes, pooled by kind. Ramps are wedges.
  - **Coins:** instanced gold discs that spin and are pulled toward the runner while the magnet is on.
  - **Pickups:** bobbing coloured gems.
  - **Runner:** an orange capsule with a head. It squashes while rolling, rides a board while the hoverboard is on, shows a flame while flying, and blinks during grace.
  - **Chaser:** a TT block and a dog block behind the runner.
  - **Camera and light:** the camera eases behind and above the runner. The sun and its shadow follow the runner.

- [ ] **Step 1: Install three.js**

```bash
npm install three
npm install -D @types/three
```

- [ ] **Step 2: Write the failing test `tests/world/worldMath.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { BUILDING_PALETTE, buildingAt, repeatingOffsets } from '../../src/world/worldMath';

describe('repeatingOffsets', () => {
  it('lists items on a fixed grid around the runner', () => {
    expect(repeatingOffsets(10, 4, 3, 10)).toEqual([-2, 2, 6, 10]);
    const offs = repeatingOffsets(123.4, 1.5, 12, 220);
    expect(offs[0]).toBeGreaterThanOrEqual(-12);
    expect(offs[offs.length - 1]).toBeLessThanOrEqual(220);
    for (let i = 1; i < offs.length; i++) expect(offs[i] - offs[i - 1]).toBeCloseTo(1.5, 9);
  });
});

describe('buildingAt', () => {
  it('is deterministic, varied and uses the palette', () => {
    expect(buildingAt(7, 1)).toEqual(buildingAt(7, 1));
    expect(buildingAt(7, 1)).not.toEqual(buildingAt(7, -1));
    const heights = new Set<number>();
    for (let k = 0; k < 50; k++) {
      const b = buildingAt(k, -1);
      heights.add(Math.round(b.height));
      expect(b.height).toBeGreaterThanOrEqual(6);
      expect(b.height).toBeLessThanOrEqual(22);
      expect(b.width).toBeGreaterThanOrEqual(7);
      expect(b.width).toBeLessThanOrEqual(11);
      expect(BUILDING_PALETTE).toContain(b.color);
    }
    expect(heights.size).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/world`
Expected: FAIL because the module is not found.

- [ ] **Step 4: Write `src/world/worldMath.ts`**

```ts
/** Metres of track per roadside building. */
export const BUILDING_SLOT = 12;

/** Chawl-and-shopfront colours. */
export const BUILDING_PALETTE = [0xf2c14e, 0xf78154, 0x5fad56, 0x4d9de0, 0xe15554, 0xc9ada7, 0xf4d6cc, 0x9c89b8] as const;

/**
 * Items repeat every `spacing` metres along the track. Returns how far ahead of the
 * runner (at s) each one is, for those between `behind` metres back and `ahead` metres forward.
 */
export function repeatingOffsets(s: number, spacing: number, behind: number, ahead: number): number[] {
  const first = Math.ceil((s - behind) / spacing);
  const last = Math.floor((s + ahead) / spacing);
  const out: number[] = [];
  for (let k = first; k <= last; k++) out.push(k * spacing - s);
  return out;
}

function hash01(n: number, salt: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
  x ^= x >>> 13;
  x = Math.imul(x, 0x27d4eb2f);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export interface BuildingLook {
  height: number;
  width: number;
  depth: number;
  color: number;
}

/** The building in slot k on one side of the track; always the same for the same slot. */
export function buildingAt(k: number, side: -1 | 1): BuildingLook {
  const n = k * 2 + (side > 0 ? 1 : 0);
  return {
    height: 6 + hash01(n, 0) * 16,
    width: 7 + hash01(n, 1) * 4,
    depth: 6 + hash01(n, 2) * 6,
    color: BUILDING_PALETTE[Math.floor(hash01(n, 3) * BUILDING_PALETTE.length)],
  };
}
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/world`
Expected: all pass.

- [ ] **Step 6: Write `src/world/worldView.ts`**

```ts
import * as THREE from 'three';
import { LANE_WIDTH, laneX, TUNING } from '../game/config';
import type { Game } from '../game/game';
import { OBSTACLES, type ObstacleKind } from '../game/obstacles';
import type { PowerupKind } from '../game/track';
import { BUILDING_SLOT, buildingAt, repeatingOffsets } from './worldMath';

const VIEW_AHEAD = 220;
const VIEW_BEHIND = 12;
const MAX_PIXEL_RATIO = 1.25;
const SLEEPER_SPACING = 1.5;
const MAX_COINS = 400;
const MAX_SLEEPERS = 3 * (Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / SLEEPER_SPACING) + 2);
const MAX_BUILDINGS = 2 * (Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / BUILDING_SLOT) + 2);
const OBSTACLE_WIDTH = 2;
const SKY = 0xf7c59f;
const TRACK_LENGTH = VIEW_AHEAD + VIEW_BEHIND + 40;

const OBSTACLE_COLORS: Record<ObstacleKind, number> = {
  trainParked: 0x9b2d30,
  trainMoving: 0x1f5aa6,
  barrierLow: 0xc8a165,
  handcart: 0x8b5a2b,
  bannerHigh: 0xff6f3c,
  auto: 0xf4c430,
  cow: 0xf1ede4,
  ramp: 0x8a8f96,
};

const PICKUP_COLORS: Record<PowerupKind, number> = {
  magnet: 0xe53935,
  rocket: 0xff9800,
  chappal: 0x8d6e63,
};

/** Floating origin: the runner is always at z = 0 and the track runs toward -z. */
const toZ = (itemS: number, runnerS: number) => -(itemS - runnerS);

function obstacleGeometry(kind: ObstacleKind): THREE.BufferGeometry {
  const info = OBSTACLES[kind];
  if (kind === 'ramp') {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(info.length, 0);
    shape.lineTo(info.length, TUNING.trainHeight);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: OBSTACLE_WIDTH, bevelEnabled: false });
    g.rotateY(Math.PI / 2); // profile x (along the track) -> -z, extrusion -> +x
    g.translate(-OBSTACLE_WIDTH / 2, 0, 0);
    return g;
  }
  const g = new THREE.BoxGeometry(OBSTACLE_WIDTH, info.yMax - info.yMin, 1);
  // Origin at the near end; scaling z by the length stretches it away from the runner.
  g.translate(0, (info.yMax + info.yMin) / 2, -0.5);
  return g;
}

const standard = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });

export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 400);
  private readonly lookAt = new THREE.Vector3(0, 1.2, -14);
  private readonly sun: THREE.DirectionalLight;
  private readonly tmp = new THREE.Object3D();
  private readonly color = new THREE.Color();

  private readonly obstacleGeo = {} as Record<ObstacleKind, THREE.BufferGeometry>;
  private readonly obstacleMat = {} as Record<ObstacleKind, THREE.Material>;
  private readonly obstacleMeshes = new Map<number, THREE.Mesh>();
  private readonly obstaclePool = new Map<ObstacleKind, THREE.Mesh[]>();

  private readonly pickupGeo = new THREE.IcosahedronGeometry(0.45, 1);
  private readonly pickupMeshes = new Map<number, THREE.Mesh>();

  private readonly sleepers: THREE.InstancedMesh;
  private readonly buildings: THREE.InstancedMesh;
  private readonly coins: THREE.InstancedMesh;

  private readonly runner = new THREE.Group();
  private readonly board: THREE.Mesh;
  private readonly flame: THREE.Mesh;
  private readonly chaser = new THREE.Group();
  private clock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = this.scene;
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 70, VIEW_AHEAD);

    scene.add(new THREE.HemisphereLight(0xfff3e0, 0x7a5c3e, 1.1));
    this.sun = new THREE.DirectionalLight(0xffd7a8, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -14, right: 14, top: 20, bottom: -20, near: 1, far: 70 });
    this.sun.shadow.bias = -0.0005;
    scene.add(this.sun, this.sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, TRACK_LENGTH), standard(0xb08a63));
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -(TRACK_LENGTH / 2 - VIEW_BEHIND - 20);
    ground.receiveShadow = true;
    scene.add(ground);

    const ballastGeo = new THREE.BoxGeometry(LANE_WIDTH * 0.85, 0.12, TRACK_LENGTH);
    const railGeo = new THREE.BoxGeometry(0.08, 0.1, TRACK_LENGTH);
    const ballastMat = standard(0x7a6f66);
    const railMat = standard(0xaab0b6, { metalness: 0.6, roughness: 0.4 });
    for (const lane of [-1, 0, 1]) {
      const ballast = new THREE.Mesh(ballastGeo, ballastMat);
      ballast.position.set(laneX(lane), 0, ground.position.z);
      ballast.receiveShadow = true;
      scene.add(ballast);
      for (const side of [-0.7, 0.7]) {
        const rail = new THREE.Mesh(railGeo, railMat);
        rail.position.set(laneX(lane) + side, 0.16, ground.position.z);
        scene.add(rail);
      }
    }

    this.sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.08, 0.25), standard(0x5a4632), MAX_SLEEPERS);
    this.sleepers.frustumCulled = false;
    this.sleepers.receiveShadow = true;
    scene.add(this.sleepers);

    this.buildings = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), standard(0xffffff, { roughness: 0.9 }), MAX_BUILDINGS);
    this.buildings.frustumCulled = false;
    this.buildings.castShadow = true;
    this.buildings.receiveShadow = true;
    scene.add(this.buildings);

    const coinGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.08, 20);
    coinGeo.rotateX(Math.PI / 2);
    this.coins = new THREE.InstancedMesh(
      coinGeo,
      standard(0xffc83d, { metalness: 0.7, roughness: 0.3, emissive: 0x6b4a00 }),
      MAX_COINS,
    );
    this.coins.frustumCulled = false;
    scene.add(this.coins);

    for (const kind of Object.keys(OBSTACLES) as ObstacleKind[]) {
      this.obstacleGeo[kind] = obstacleGeometry(kind);
      this.obstacleMat[kind] = standard(OBSTACLE_COLORS[kind], { roughness: 0.6 });
    }

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.8, 4, 12), standard(0xff7a1a, { roughness: 0.5 }));
    body.position.y = 0.78;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), standard(0xc68642));
    head.position.y = 1.62;
    this.board = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 1.8), standard(0x00c2d1, { emissive: 0x004a52 }));
    this.board.position.y = 0.04;
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.9, 12), standard(0xff9800, { emissive: 0xff5a00 }));
    this.flame.rotation.x = Math.PI;
    this.flame.position.set(0, -0.2, 0.3);
    for (const m of [body, head, this.board]) m.castShadow = true;
    this.runner.add(body, head, this.board, this.flame);
    scene.add(this.runner);

    const coat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.1, 0.5), standard(0x2b2b2b));
    coat.position.y = 0.55;
    const shirt = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.5), standard(0xf5f5f5));
    shirt.position.y = 1.4;
    const ttHead = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), standard(0x8d5524));
    ttHead.position.y = 1.9;
    const dog = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 0.9), standard(0xc49a6c));
    dog.position.set(0.9, 0.35, 0.4);
    for (const m of [coat, shirt, ttHead, dog]) m.castShadow = true;
    this.chaser.add(coat, shirt, ttHead, dog);
    scene.add(this.chaser);

    this.camera.position.set(0, 4.2, 7.5);
  }

  get stats(): { calls: number; triangles: number; pixelRatio: number } {
    const r = this.renderer.info.render;
    return { calls: r.calls, triangles: r.triangles, pixelRatio: this.renderer.getPixelRatio() };
  }

  resize(width: number, height: number, dpr: number): void {
    this.renderer.setPixelRatio(Math.min(dpr, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(g: Game, dtSec: number): void {
    this.clock += dtSec;
    this.updateRunner(g);
    this.updateCamera(g, dtSec);
    this.updateTrack(g.s);
    this.updateObstacles(g);
    this.updateCoins(g);
    this.updatePickups(g);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }

  private updateRunner(g: Game): void {
    const r = g.runner;
    this.runner.position.set(r.x, r.y, 0);
    this.runner.scale.y = r.rolling ? TUNING.rollHeight / TUNING.runnerHeight : 1;
    this.board.visible = g.powerups.hoverboard > 0;
    this.flame.visible = r.flying;
    this.runner.visible = g.powerups.grace <= 0 || Math.floor(this.clock * 12) % 2 === 0;

    const showChaser = g.chaser.visible || g.state === 'caught' || g.state === 'summary';
    this.chaser.visible = showChaser;
    this.chaser.position.set(r.x * 0.8, 0, g.chaser.gap + 0.8);

    this.sun.position.set(r.x - 12, 25, 10);
    this.sun.target.position.set(r.x, 0, -8);
  }

  private updateCamera(g: Game, dtSec: number): void {
    const r = g.runner;
    const k = dtSec > 0 ? 1 - Math.exp(-8 * dtSec) : 1;
    this.camera.position.lerp(new THREE.Vector3(r.x * 0.55, 4.2 + r.y * 0.7, 7.5), k);
    this.lookAt.lerp(new THREE.Vector3(r.x * 0.55, 1.2 + r.y * 0.7, -14), k);
    this.camera.lookAt(this.lookAt);
  }

  private updateTrack(s: number): void {
    const t = this.tmp;
    t.rotation.set(0, 0, 0);
    t.scale.set(1, 1, 1);
    let n = 0;
    for (const ahead of repeatingOffsets(s, SLEEPER_SPACING, VIEW_BEHIND, VIEW_AHEAD)) {
      for (const lane of [-1, 0, 1]) {
        if (n >= MAX_SLEEPERS) break;
        t.position.set(laneX(lane), 0.06, -ahead);
        t.updateMatrix();
        this.sleepers.setMatrixAt(n++, t.matrix);
      }
    }
    this.sleepers.count = n;
    this.sleepers.instanceMatrix.needsUpdate = true;

    n = 0;
    const first = Math.floor((s - VIEW_BEHIND) / BUILDING_SLOT);
    const last = Math.ceil((s + VIEW_AHEAD) / BUILDING_SLOT);
    for (const side of [-1, 1] as const) {
      for (let k = first; k <= last && n < MAX_BUILDINGS; k++) {
        const b = buildingAt(k, side);
        t.position.set(side * (1.5 * LANE_WIDTH + 3 + b.width / 2), b.height / 2, toZ(k * BUILDING_SLOT + BUILDING_SLOT / 2, s));
        t.scale.set(b.width, b.height, b.depth);
        t.updateMatrix();
        this.buildings.setMatrixAt(n, t.matrix);
        this.buildings.setColorAt(n, this.color.setHex(b.color));
        n++;
      }
    }
    this.buildings.count = n;
    this.buildings.instanceMatrix.needsUpdate = true;
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;
  }

  private updateObstacles(g: Game): void {
    const seen = new Set<number>();
    for (const o of g.track.obstacles) {
      const z = toZ(o.front, g.s);
      if (z < -VIEW_AHEAD || z - o.length > VIEW_BEHIND) continue;
      seen.add(o.id);
      let mesh = this.obstacleMeshes.get(o.id);
      if (!mesh) {
        mesh = this.takeObstacleMesh(o.kind);
        this.obstacleMeshes.set(o.id, mesh);
      }
      mesh.position.set(laneX(o.lane), 0, z);
      mesh.scale.z = o.kind === 'ramp' ? o.length / OBSTACLES.ramp.length : o.length;
    }
    for (const [id, mesh] of this.obstacleMeshes) {
      if (seen.has(id)) continue;
      this.obstacleMeshes.delete(id);
      mesh.visible = false;
      this.obstaclePool.get(mesh.userData.kind as ObstacleKind)!.push(mesh);
    }
  }

  private takeObstacleMesh(kind: ObstacleKind): THREE.Mesh {
    let pool = this.obstaclePool.get(kind);
    if (!pool) {
      pool = [];
      this.obstaclePool.set(kind, pool);
    }
    let mesh = pool.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.obstacleGeo[kind], this.obstacleMat[kind]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.kind = kind;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  private updateCoins(g: Game): void {
    const t = this.tmp;
    const r = g.runner;
    const magnet = g.powerups.magnet > 0;
    t.scale.set(1, 1, 1);
    let n = 0;
    for (const c of g.track.coins) {
      if (c.taken || n >= MAX_COINS) continue;
      const ahead = c.s - g.s;
      if (ahead > VIEW_AHEAD || ahead < -VIEW_BEHIND) continue;
      let x = laneX(c.lane);
      let y = c.y;
      if (magnet && ahead > 0 && ahead < TUNING.magnetRange) {
        const pull = 1 - ahead / TUNING.magnetRange;
        x += (r.x - x) * pull;
        y += (r.y + 1 - y) * pull;
      }
      t.position.set(x, y, -ahead);
      t.rotation.set(0, this.clock * 4 + c.id, 0);
      t.updateMatrix();
      this.coins.setMatrixAt(n++, t.matrix);
    }
    this.coins.count = n;
    this.coins.instanceMatrix.needsUpdate = true;
  }

  private updatePickups(g: Game): void {
    const seen = new Set<number>();
    for (const p of g.track.pickups) {
      if (p.taken) continue;
      const ahead = p.s - g.s;
      if (ahead > VIEW_AHEAD || ahead < -VIEW_BEHIND) continue;
      seen.add(p.id);
      let mesh = this.pickupMeshes.get(p.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.pickupGeo, standard(PICKUP_COLORS[p.kind], { emissive: PICKUP_COLORS[p.kind], emissiveIntensity: 0.4 }));
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.pickupMeshes.set(p.id, mesh);
      }
      mesh.position.set(laneX(p.lane), 1 + Math.sin(this.clock * 3 + p.id) * 0.2, -ahead);
      mesh.rotation.y = this.clock * 2;
    }
    for (const [id, mesh] of this.pickupMeshes) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      this.pickupMeshes.delete(id);
    }
  }
}
```

Pickups are rare (under 1 per chunk), so creating and disposing their meshes is acceptable. Obstacles, coins, sleepers and buildings are pooled or instanced.

- [ ] **Step 7: Type check and test**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean and all passing. If a three.js type differs in the installed version (for example `setColorAt` or shadow camera fields), adapt to the installed API and note it in the report. Visual verification happens in Task 10.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/world tests/world
git commit -m "feat(world): add placeholder three.js world"
```

---

### Task 10: HUD, main loop and visual check

**Files:**
- Create: `src/ui/hud.ts`, `src/ui/hud.css`, `src/main.ts`
- Modify: `index.html`
- Test: `tests/ui/hud.test.ts`

**Interfaces:**
- Consumes: `Game`, `Autopilot`, `FixedStepper` (Task 8); `WorldView` (Task 9); `KeyboardInput`, `InputHub` (Task 1)
- Produces:
  - `HudModel`, `hudModel(game)`, `class Hud(root)` with `update(game)`
  - The playable page `/`, which accepts these URL parameters:
    - `?seed=<n>`
    - `?difficulty=chill|cardio|beast`
    - `?autopilot` (a bot plays)
    - `?god` (no crashes)
    - `?jog` (holding J counts as jogging, which turns the jog rule on)
    - `?perf` (fps, draw-call and triangle overlay)
  - `window.__game`, for debugging and screenshots

- [ ] **Step 1: Write the failing test `tests/ui/hud.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { Game } from '../../src/game/game';
import type { ActivityStatus } from '../../src/input/commands';
import { hudModel } from '../../src/ui/hud';

const EMPTY: ChunkDef[] = [{ id: 'empty', tier: 0, obstacles: [], coins: [] }];
const KB: ActivityStatus = { tracksJogging: false, msSinceStep: Infinity, cadenceSpm: 0, steps: 0, squatting: false, lost: false };
const STILL: ActivityStatus = { ...KB, tracksJogging: true };

describe('hudModel', () => {
  it('shows the title and controls in the menu', () => {
    const m = hudModel(new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY }));
    expect(m.center).toBe('Subway IRL');
    expect(m.sub).toMatch(/Enter/);
    expect(m.hoverboards).toBe(3);
  });

  it('counts down, then shows score, coins and power-ups', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.step(1 / 60, [{ type: 'start' }], KB);
    expect(hudModel(g).center).toBe('3');
    for (let i = 0; i < 240; i++) g.step(1 / 60, [], KB);
    g.powerups.activate('magnet');
    g.stats.coins = 4;
    const m = hudModel(g);
    expect(m.center).toBe('');
    expect(m.coins).toBe('₹4');
    expect(m.powerups).toEqual(['🧲 Magnet 10s']);
    expect(m.danger).toBe(false);
  });

  it('warns when the player stops jogging and summarises a caught run', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.step(1 / 60, [{ type: 'start' }], STILL);
    for (let i = 0; i < 180 + 70; i++) g.step(1 / 60, [], STILL);
    expect(hudModel(g).center).toBe('Bhaago!');
    expect(hudModel(g).danger).toBe(true);
    for (let i = 0; i < 60; i++) g.step(1 / 60, [], STILL);
    expect(hudModel(g).center).toBe('Pakda gaya!');
    expect(hudModel(g).sub).toBe('You stopped jogging');
    for (let i = 0; i < 90; i++) g.step(1 / 60, [], STILL);
    const m = hudModel(g);
    expect(m.center).toMatch(/^Score \d+$/);
    expect(m.sub).toMatch(/Enter to play again/);
  });

  it('tells a lost player to step back into frame', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.step(1 / 60, [{ type: 'start' }], KB);
    g.step(1 / 60, [], { ...KB, lost: true });
    expect(hudModel(g).center).toBe('Step back into frame');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ui`
Expected: FAIL because the module is not found.

- [ ] **Step 3: Write `src/ui/hud.ts`**

```ts
import type { CaughtReason, Game } from '../game/game';

export interface HudModel {
  score: string;
  coins: string;
  speed: string;
  center: string;
  sub: string;
  powerups: string[];
  hoverboards: number;
  /** Josh meter fill, 0..1. */
  josh: number;
  joshActive: boolean;
  /** Stopped jogging: flash the screen edges. */
  danger: boolean;
}

const CAUGHT_TEXT: Record<CaughtReason, string> = {
  crash: 'You crashed',
  stumble: 'Two stumbles in a row',
  idle: 'You stopped jogging',
};

function centerText(g: Game): string {
  switch (g.state) {
    case 'menu':
      return 'Subway IRL';
    case 'countdown':
      return String(Math.max(1, Math.ceil(g.countdown - 1e-9)));
    case 'paused':
      return g.pausedByLoss ? 'Step back into frame' : 'Paused';
    case 'caught':
      return 'Pakda gaya!';
    case 'summary':
      return `Score ${g.stats.score}`;
    default:
      return g.idleLevel === 'warn' ? 'Bhaago!' : '';
  }
}

function subText(g: Game): string {
  switch (g.state) {
    case 'menu':
      return 'Press Enter to start · ←/→ lanes · ↑ jump · ↓ roll · Space hoverboard';
    case 'paused':
      return g.pausedByLoss ? '' : 'Press Enter to resume';
    case 'caught':
      return g.caughtReason ? CAUGHT_TEXT[g.caughtReason] : '';
    case 'summary': {
      const s = g.stats;
      return `₹${s.coins} · ${Math.floor(s.distance)} m · ${s.jumps} jumps · ${s.rolls} rolls · Enter to play again`;
    }
    default:
      return '';
  }
}

export function hudModel(g: Game): HudModel {
  const p = g.powerups;
  const timers: [string, number][] = [
    ['🧲 Magnet', p.magnet],
    ['🚀 Rocket', p.rocket],
    ['🩴 Chappals', p.chappal],
    ['🛹 Hoverboard', p.hoverboard],
  ];
  return {
    score: String(g.stats.score),
    coins: `₹${g.stats.coins}`,
    speed: `${g.speed.toFixed(0)} m/s`,
    center: centerText(g),
    sub: subText(g),
    powerups: timers.filter(([, t]) => t > 0).map(([name, t]) => `${name} ${Math.ceil(t)}s`),
    hoverboards: p.hoverboardsLeft,
    josh: g.josh.value,
    joshActive: g.josh.active,
    danger: g.state === 'playing' && g.idleLevel === 'warn',
  };
}

const el = (tag: string, cls: string, parent: HTMLElement): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  parent.append(e);
  return e;
};

/** Minimal DOM HUD. Writes to the DOM only when a value changes. */
export class Hud {
  private readonly vignette: HTMLElement;
  private readonly score: HTMLElement;
  private readonly coins: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly center: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly powerups: HTMLElement;
  private readonly boards: HTMLElement;
  private readonly josh: HTMLElement;
  private readonly joshFill: HTMLElement;
  private last = new Map<HTMLElement, string>();

  constructor(root: HTMLElement) {
    this.vignette = el('div', 'hud-vignette', root);
    const top = el('div', 'hud-top', root);
    this.powerups = el('div', 'hud-powerups', top);
    const right = el('div', 'hud-right', top);
    this.score = el('div', 'hud-score', right);
    this.coins = el('div', 'hud-coins', right);
    this.speed = el('div', 'hud-speed', right);
    this.boards = el('div', 'hud-boards', right);
    this.center = el('div', 'hud-center', root);
    this.sub = el('div', 'hud-sub', root);
    this.josh = el('div', 'hud-josh', root);
    this.joshFill = el('div', 'hud-josh-fill', this.josh);
    el('span', 'hud-josh-label', this.josh).textContent = 'JOSH';
  }

  update(g: Game): void {
    const m = hudModel(g);
    this.text(this.score, m.score);
    this.text(this.coins, m.coins);
    this.text(this.speed, m.speed);
    this.text(this.center, m.center);
    this.text(this.sub, m.sub);
    this.text(this.powerups, m.powerups.join('\n'));
    this.text(this.boards, `🛹 × ${m.hoverboards}`);
    this.joshFill.style.transform = `scaleX(${m.josh.toFixed(3)})`;
    this.josh.classList.toggle('active', m.joshActive);
    this.vignette.classList.toggle('danger', m.danger);
    this.center.classList.toggle('big', g.state === 'countdown' || g.state === 'menu');
  }

  private text(e: HTMLElement, value: string): void {
    if (this.last.get(e) === value) return;
    this.last.set(e, value);
    e.textContent = value;
  }
}
```

Check the "warns" test against this code:
- The countdown takes 180 frames. After 70 more still frames the idle time is 1167 ms, so the warning shows.
- 60 frames later the idle time is 2167 ms, which is past 2000, so the player is caught.
- The catch screen then lasts 90 frames before the summary.

- [ ] **Step 4: Write `src/ui/hud.css`**

```css
:root {
  color-scheme: dark;
  font-family: 'Trebuchet MS', system-ui, sans-serif;
}
html,
body {
  margin: 0;
  height: 100%;
  overflow: hidden;
  background: #f7c59f;
}
#scene {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  display: block;
}
#hud {
  position: fixed;
  inset: 0;
  pointer-events: none;
  color: #fff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.55);
}
.hud-vignette {
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 0 0 rgba(229, 57, 53, 0);
  transition: box-shadow 0.2s;
}
.hud-vignette.danger {
  animation: danger 0.5s ease-in-out infinite alternate;
}
@keyframes danger {
  from { box-shadow: inset 0 0 60px 10px rgba(229, 57, 53, 0.35); }
  to { box-shadow: inset 0 0 140px 40px rgba(229, 57, 53, 0.75); }
}
@media (prefers-reduced-motion: reduce) {
  .hud-vignette.danger { animation: none; box-shadow: inset 0 0 120px 30px rgba(229, 57, 53, 0.6); }
}
.hud-top {
  position: absolute;
  top: 16px;
  left: 20px;
  right: 20px;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.hud-powerups {
  white-space: pre-line;
  font-size: 18px;
  line-height: 1.5;
}
.hud-right {
  text-align: right;
}
.hud-score {
  font-size: 40px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.hud-coins {
  font-size: 26px;
  color: #ffd54a;
  font-weight: 700;
}
.hud-speed,
.hud-boards {
  font-size: 15px;
  opacity: 0.9;
}
.hud-center {
  position: absolute;
  top: 34%;
  width: 100%;
  text-align: center;
  font-size: 44px;
  font-weight: 800;
}
.hud-center.big {
  font-size: 88px;
  letter-spacing: 0.02em;
}
.hud-sub {
  position: absolute;
  top: calc(34% + 110px);
  width: 100%;
  text-align: center;
  font-size: 20px;
  padding: 0 16px;
  box-sizing: border-box;
}
.hud-josh {
  position: absolute;
  bottom: 22px;
  left: 50%;
  width: min(360px, 70vw);
  height: 14px;
  transform: translateX(-50%);
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.hud-josh-fill {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  transform: scaleX(0);
  background: linear-gradient(90deg, #ff9933, #ffd54a);
}
.hud-josh.active .hud-josh-fill {
  background: linear-gradient(90deg, #ff5722, #ffeb3b);
}
.hud-josh-label {
  position: absolute;
  inset: 0;
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  letter-spacing: 0.2em;
}
.hud-perf {
  position: fixed;
  left: 8px;
  bottom: 8px;
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.55);
  color: #9f9;
  font: 12px/1.4 ui-monospace, monospace;
  white-space: pre;
  pointer-events: none;
}
```

- [ ] **Step 5: Write `src/main.ts` and replace `index.html`**

`src/main.ts`:
```ts
import './ui/hud.css';
import { Autopilot } from './game/autopilot';
import type { Difficulty } from './game/config';
import { Game } from './game/game';
import { FixedStepper } from './game/loop';
import { InputHub } from './input/hub';
import { KeyboardInput } from './input/keyboard';
import { Hud } from './ui/hud';
import { WorldView } from './world/worldView';

const params = new URLSearchParams(location.search);
const DIFFICULTIES: Difficulty[] = ['chill', 'cardio', 'beast'];
const requested = params.get('difficulty') as Difficulty | null;
const difficulty: Difficulty = requested && DIFFICULTIES.includes(requested) ? requested : 'cardio';
const seedParam = Number(params.get('seed'));
const seed = Number.isFinite(seedParam) && params.has('seed') ? seedParam : Math.floor(Math.random() * 1e6);

const game = new Game({ seed, difficulty, god: params.has('god') });
const keyboard = new KeyboardInput();
keyboard.jogEnabled = params.has('jog');
keyboard.attach(window);
const autopilot = params.has('autopilot') ? new Autopilot(game) : null;
const input = new InputHub(autopilot ? [keyboard, autopilot] : [keyboard]);

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const world = new WorldView(canvas);
const hud = new Hud(document.getElementById('hud')!);
const stepper = new FixedStepper();
(window as unknown as { __game: Game }).__game = game;

const perf = params.has('perf') ? document.body.appendChild(document.createElement('div')) : null;
if (perf) perf.className = 'hud-perf';
let fps = 60;

function resize(): void {
  world.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}
resize();
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause();
});

let last = performance.now();
function frame(now: number): void {
  const dt = Math.max(0, (now - last) / 1000);
  last = now;
  const steps = stepper.advance(dt);
  for (let i = 0; i < steps; i++) {
    autopilot?.tick();
    game.step(stepper.stepSec, input.drain(), input.activity(now));
  }
  world.render(game, dt);
  hud.update(game);
  if (perf && dt > 0) {
    fps += (1 / dt - fps) * 0.05;
    const s = world.stats;
    perf.textContent = `${fps.toFixed(0)} fps  ${s.calls} calls  ${(s.triangles / 1000).toFixed(1)}k tris  dpr ${s.pixelRatio}\nseed ${seed}  ${difficulty}  s=${game.s.toFixed(0)}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
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
    <canvas id="scene"></canvas>
    <div id="hud"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`Math.random()` here is allowed: it is outside `game/` and only picks the seed.

- [ ] **Step 6: Run the tests, type check and build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: everything passes, and `dist/index.html` plus `dist/debug.html` are produced.

- [ ] **Step 7: Visual check**

Start the dev server in the background, if one isn't already serving the project on 5173:
```bash
cd /home/yash/Projects/SSRealLife && (npx vite --port 5173 --strictPort > "$SCRATCH/vite.log" 2>&1 &)
```
`$SCRATCH` is the session scratchpad directory, which the dispatch names.

Capture three states and open each PNG with the Read tool:
```bash
shoot "http://localhost:5173/?seed=3" "$SCRATCH/p2-menu.png" "document.querySelector('.hud-center')?.textContent === 'Subway IRL'" 500
shoot "http://localhost:5173/?seed=3&autopilot&perf" "$SCRATCH/p2-play.png" "window.__game?.state === 'playing' && window.__game.time > 6" 300
shoot "http://localhost:5173/?seed=5&autopilot&perf&difficulty=beast" "$SCRATCH/p2-play-later.png" "window.__game?.state === 'playing' && window.__game.time > 25" 300
```

Check each screenshot for:
- the dusk sky and fog
- three tracks with sleepers and rails
- coloured buildings on both sides
- the orange runner in the lower middle of the frame
- coloured obstacles and gold coins ahead
- the HUD score, coins and Josh bar
- the perf overlay (bottom left)
- the menu title, on the menu shot

Fix anything that renders wrong, re-shoot and read again.

If headless Chrome can't create a WebGL context (a blank canvas, or a page error that mentions WebGL), copy `~/.claude/tools/shoot.mjs` into the scratchpad. Replace `'--disable-gpu'` in its Chrome args with `'--enable-unsafe-swiftshader', '--use-angle=swiftshader'` and run the copy with `node`. Never edit the original tool.

Record the fps, calls and triangles from the perf overlay in the report. Headless numbers are not representative of the real laptop.

Stop any server you started: `kill $(pgrep -f "vite[.]js")`. If that pattern misses it (the server runs as `node .../node_modules/.bin/vite`), use `kill $(pgrep -f "bin/vit[e] --port 5173")`.

- [ ] **Step 8: Commit**

```bash
git add index.html src/main.ts src/ui tests/ui
git commit -m "feat: playable keyboard runner with placeholder world and HUD"
```

- [ ] **Step 9: Hand-off note for the user (manual)**

Ask the user to:
1. Open `http://localhost:5173/` in Windows Chrome and play with the keyboard.
2. Try `?jog` and hold J to jog.
3. Try `?autopilot&perf` and report the fps and calls shown.

Pose control arrives in Phase 3.

---

## Deferred from spec §5.9

Saving the best score, coins and history in `localStorage` belongs with the Phase 4 screens.

## Later phases (separate plans)

3. **Pose → input:** a `PoseCommandSource` (PoseEvent → GameCommand, PoseStatus → ActivityStatus), calibration and camera screens in the game page, a camera preview with the skeleton, a "too dark" hint, and a stall and slow-pose warning.
4. **UI:** screens, settings, the fitness summary and history.
5. **Assets:** the asset pipeline and brief, the Mumbai Local environment, lighting and quality tiers.
6. **Content:** characters, animations and audio.
7. **Polish:** power-ups, performance and a playtest pass.
