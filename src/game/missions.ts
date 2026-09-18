/**
 * Missions (spec: docs/superpowers/specs/2026-09-18-missions.md).
 *
 * PURE. Nothing here touches the simulation: the tracker only *reads* what `Game` already
 * computes every frame (stats, the idle verdict, the Josh meter, the power-up timers, the
 * chaser gap) and derives the few counters the mission rules need — a jog streak, a Josh
 * streak, hoverboard seconds, coins inside one magnet, near misses. `RunStats` is unchanged,
 * so the sim stays authoritative and deterministic whether or not missions are running.
 */

import type { Game, GameEvent } from './game';
import type { RunStats } from './game';
import type { IdleLevel } from './rules';
import type { PlayMode } from '../pose/types';
import { Rng } from './rng';

// ---------------------------------------------------------------- live counters

/** How close the TT has to get to count as a near miss, and how far he must fall back after. */
export const NEAR_MISS_GAP = 5;
export const NEAR_MISS_CLEAR = 8;

/** Everything a mission rule may read about one run. Derived, never authoritative. */
export interface RunCounters {
  distance: number;
  coins: number;
  score: number;
  timeSec: number;
  steps: number;
  jumps: number;
  rolls: number;
  laneChanges: number;
  hoverboardsUsed: number;
  /**
   * Longest unbroken stretch, in seconds, of the player actually moving (`Game.movingLevel` at
   * 'ok'). Resting on a hoverboard is not moving, so a rest breaks it even though it cannot catch.
   */
  bestJogStreakSec: number;
  /** The streak running right now (0 the moment the player stops). */
  jogStreakSec: number;
  /** Longest unbroken stretch with the Josh meter full. */
  bestJoshStreakSec: number;
  joshStreakSec: number;
  /** Seconds spent actually riding a hoverboard. */
  hoverboardSec: number;
  /**
   * Seconds spent resting on a hoverboard — riding it without moving. Not exercise, so the
   * workout's active minutes leave it out.
   */
  restSec: number;
  /** Most coins pulled in during a single magnet. */
  magnetCoinsBest: number;
  /** Times the TT closed in and was shaken off again. */
  nearMisses: number;
  stumbles: number;
  /** Times the "Bhaago!" warning came up. */
  idleWarnings: number;
  /** Metres since the last stumble or idle warning, and the best such stretch. */
  cleanMeters: number;
  bestCleanMeters: number;
  /** The run ended in a catch (set by the tracker from the `caught` event). */
  caught: boolean;
}

export const emptyCounters = (): RunCounters => ({
  distance: 0,
  coins: 0,
  score: 0,
  timeSec: 0,
  steps: 0,
  jumps: 0,
  rolls: 0,
  laneChanges: 0,
  hoverboardsUsed: 0,
  bestJogStreakSec: 0,
  jogStreakSec: 0,
  bestJoshStreakSec: 0,
  joshStreakSec: 0,
  hoverboardSec: 0,
  restSec: 0,
  magnetCoinsBest: 0,
  nearMisses: 0,
  stumbles: 0,
  idleWarnings: 0,
  cleanMeters: 0,
  bestCleanMeters: 0,
  caught: false,
});

/** One frame of the run, as the mission tracker sees it. All read from the Game. */
export interface RunSample {
  dt: number;
  /** False outside `playing`: a paused or counting-down frame breaks no streak and adds no time. */
  playing: boolean;
  stats: Readonly<RunStats>;
  /** The level the catch rule acts on: 'ok' throughout a hoverboard rest. Drives the warnings. */
  idleLevel: IdleLevel;
  /** Whether the player is actually moving, never excused by a rest. Drives the jog streak. */
  movingLevel: IdleLevel;
  /** On a hoverboard, where stopping is allowed. */
  resting: boolean;
  joshActive: boolean;
  /** Seconds left on the magnet (0 = off). */
  magnetSec: number;
  /** Seconds left on the hoverboard (0 = not riding). */
  hoverboardSec: number;
  /** How far behind the runner the TT is. */
  chaserGap: number;
}

/** Reads a frame off the game. Read-only: it mutates nothing and decides nothing. */
export function runSample(g: Game, dt: number): RunSample {
  return {
    dt,
    playing: g.state === 'playing',
    stats: g.stats,
    idleLevel: g.idleLevel,
    movingLevel: g.movingLevel,
    resting: g.resting,
    joshActive: g.josh.active,
    magnetSec: g.powerups.magnet,
    hoverboardSec: g.powerups.hoverboard,
    chaserGap: g.chaser.gap,
  };
}

/**
 * Turns a stream of frames and events into `RunCounters`.
 * One tracker per player; `reset()` at the start of every run.
 */
export class MissionTracker {
  counters: RunCounters = emptyCounters();

  private lastIdle: IdleLevel = 'ok';
  private lastDistance = 0;
  private magnetBase: number | null = null;
  /** The TT has been shaken off at least once, so the start gap is not a free near miss. */
  private chaserArmed = false;
  private chaserPending = false;

  reset(): void {
    this.counters = emptyCounters();
    this.lastIdle = 'ok';
    this.lastDistance = 0;
    this.magnetBase = null;
    this.chaserArmed = false;
    this.chaserPending = false;
  }

  event(e: GameEvent): void {
    const c = this.counters;
    if (e.type === 'stumble') {
      c.stumbles++;
      c.cleanMeters = 0;
    } else if (e.type === 'caught') {
      c.caught = true;
    }
  }

  sample(s: RunSample): void {
    const c = this.counters;
    const st = s.stats;
    c.distance = st.distance;
    c.coins = st.coins;
    c.score = st.score;
    c.timeSec = st.timeSec;
    c.steps = st.steps;
    c.jumps = st.jumps;
    c.rolls = st.rolls;
    c.laneChanges = st.laneChanges;
    c.hoverboardsUsed = st.hoverboardsUsed;

    if (!s.playing) {
      // A pause is not a stumble: the streaks hold, they just stop growing.
      this.lastDistance = st.distance;
      return;
    }
    const dt = Number.isFinite(s.dt) && s.dt > 0 ? s.dt : 0;

    // --- jog streak: unbroken seconds of actually moving. Read `movingLevel`, not `idleLevel`: a
    // hoverboard rest keeps the catch rule happy, and must not let a player stand still into a
    // "keep jogging" mission.
    if (s.movingLevel === 'ok') {
      c.jogStreakSec += dt;
      c.bestJogStreakSec = Math.max(c.bestJogStreakSec, c.jogStreakSec);
    } else {
      c.jogStreakSec = 0;
    }
    if (s.resting && s.movingLevel !== 'ok') c.restSec += dt;
    if (this.lastIdle === 'ok' && s.idleLevel !== 'ok') {
      c.idleWarnings++;
      c.cleanMeters = 0;
    }
    this.lastIdle = s.idleLevel;

    // --- Josh (fast jog) streak
    if (s.joshActive) {
      c.joshStreakSec += dt;
      c.bestJoshStreakSec = Math.max(c.bestJoshStreakSec, c.joshStreakSec);
    } else {
      c.joshStreakSec = 0;
    }

    if (s.hoverboardSec > 0) c.hoverboardSec += dt;

    // --- coins inside one magnet
    if (s.magnetSec > 0) {
      this.magnetBase ??= st.coins;
      c.magnetCoinsBest = Math.max(c.magnetCoinsBest, st.coins - this.magnetBase);
    } else {
      this.magnetBase = null;
    }

    // --- near miss: the TT closes in and is shaken off again
    if (s.chaserGap >= NEAR_MISS_CLEAR) {
      if (this.chaserPending) {
        c.nearMisses++;
        this.chaserPending = false;
      }
      this.chaserArmed = true;
    } else if (this.chaserArmed && s.chaserGap <= NEAR_MISS_GAP) {
      this.chaserPending = true;
    }

    // --- metres since the last mishap
    c.cleanMeters += Math.max(0, st.distance - this.lastDistance);
    c.bestCleanMeters = Math.max(c.bestCleanMeters, c.cleanMeters);
    this.lastDistance = st.distance;
  }
}

// ---------------------------------------------------------------- the pool

export type MissionGroup = 'movement' | 'run' | 'habit';

/**
 * What a mission needs the player to be able to do. Derived from the move check (a skipped
 * move is a missing capability) and from the input (a keyboard reports no jog at all), so the
 * pool can never offer a goal this player's setup makes impossible.
 */
export type MissionCapability = 'jog' | 'steps' | 'josh' | 'jump' | 'roll' | 'lane' | 'hoverboard';

export const ALL_CAPABILITIES: readonly MissionCapability[] = ['jog', 'steps', 'josh', 'jump', 'roll', 'lane', 'hoverboard'];

/** run: the mission takes the best single run. total: runs add up. */
export type MissionAccrual = 'run' | 'total';

export interface MissionRunContext {
  /** Local date key of the run, "YYYY-MM-DD". */
  day: string;
  /** 1-based index of this run within this browser session. */
  sessionRun: number;
  /** Distance of the run before this one, or null for a first-ever run. */
  previousDistance: number | null;
}

export interface MissionDef {
  id: string;
  group: MissionGroup;
  icon: string;
  needs: readonly MissionCapability[];
  /** Modes this mission may be offered in; omitted means both. */
  modes?: readonly PlayMode[];
  /**
   * Two active missions may never share a tag, so the set can never contain a pair the player
   * cannot progress in one run (e.g. "shake off the TT" beside "run clean"). The id is a tag
   * too, so one mission can never appear twice.
   */
  tags: readonly string[];
  accrual: MissionAccrual;
  /** Target per tier; the last entry repeats once the player runs off the end. */
  targets: readonly number[];
  /** Target multiplier per mode — a small-room jog step is a smaller movement. */
  scale?: Partial<Record<PlayMode, number>>;
  label(target: number): string;
  unit: string;
  /** 'run' accrual: the value this run reached. 'total': how much to add. */
  measure(c: RunCounters, ctx: MissionRunContext): number;
  /** Counted at most once per distinct mark — how "play on two different days" stays honest. */
  mark?(ctx: MissionRunContext): string;
}

const def = (d: MissionDef): MissionDef => Object.freeze({ ...d, tags: Object.freeze([d.id, ...d.tags]) });

/**
 * The pool. Movement missions come first and outnumber the rest: this is exercise, and the
 * missions are what turn "one more run" into a workout. Distance/score/coins are the supporting
 * cast, habits are the thin top layer.
 */
export const MISSION_POOL: readonly MissionDef[] = Object.freeze([
  // ---------------------------------------------------------- movement
  def({
    id: 'jog-steps',
    group: 'movement',
    icon: '👟',
    needs: ['steps'],
    tags: ['jog'],
    accrual: 'run',
    targets: [120, 250, 400, 600, 900],
    scale: { small: 0.7 },
    unit: 'steps',
    label: (n) => `Jog ${n} steps in one run`,
    measure: (c) => c.steps,
  }),
  def({
    id: 'jog-streak',
    group: 'movement',
    icon: '🔥',
    needs: ['jog'],
    tags: ['jog'],
    accrual: 'run',
    targets: [30, 60, 90, 120, 180],
    unit: 's',
    label: (n) => `Keep jogging ${n}s without stopping`,
    measure: (c) => Math.floor(c.bestJogStreakSec),
  }),
  def({
    id: 'josh-streak',
    group: 'movement',
    icon: '⚡',
    needs: ['josh'],
    tags: ['jog'],
    accrual: 'run',
    targets: [10, 20, 30, 45, 60],
    scale: { small: 0.7 },
    unit: 's',
    label: (n) => `Hold a full Josh meter for ${n}s`,
    measure: (c) => Math.floor(c.bestJoshStreakSec),
  }),
  def({
    id: 'jumps',
    group: 'movement',
    icon: '🦘',
    needs: ['jump'],
    tags: [],
    accrual: 'total',
    targets: [10, 25, 50, 90, 150],
    unit: 'jumps',
    label: (n) => `Jump ${n} times`,
    measure: (c) => c.jumps,
  }),
  def({
    id: 'rolls',
    group: 'movement',
    icon: '🛝',
    needs: ['roll'],
    tags: [],
    accrual: 'total',
    targets: [8, 20, 40, 70, 120],
    unit: 'rolls',
    label: (n) => `Roll under ${n} barriers`,
    measure: (c) => c.rolls,
  }),
  def({
    id: 'lanes',
    group: 'movement',
    icon: '↔️',
    needs: ['lane'],
    tags: [],
    accrual: 'total',
    targets: [20, 50, 100, 175, 280],
    unit: 'changes',
    label: (n) => `Change lane ${n} times`,
    measure: (c) => c.laneChanges,
  }),
  def({
    // A small-room lane change is a shoulder lean that has to re-arm before the next one, so
    // chaining this many inside one run is a full-body goal.
    id: 'lane-sprint',
    group: 'movement',
    icon: '🚦',
    needs: ['lane'],
    modes: ['full'],
    tags: [],
    accrual: 'run',
    targets: [12, 20, 30, 42, 60],
    unit: 'changes',
    label: (n) => `Change lane ${n} times in one run`,
    measure: (c) => c.laneChanges,
  }),
  def({
    id: 'clean-run',
    group: 'movement',
    icon: '🧘',
    needs: [],
    tags: ['clean'],
    accrual: 'total',
    targets: [1, 2, 3, 4, 6],
    unit: 'runs',
    label: (n) => (n === 1 ? 'Finish a run without stumbling' : `Finish ${n} runs without stumbling`),
    measure: (c) => (c.stumbles === 0 && c.timeSec > 0 ? 1 : 0),
  }),
  def({
    id: 'no-warning',
    group: 'movement',
    icon: '🏃',
    needs: ['jog'],
    tags: ['clean', 'jog'],
    accrual: 'run',
    targets: [200, 400, 700, 1000, 1500],
    unit: 'm',
    label: (n) => `Run ${n} m without one "Bhaago!"`,
    measure: (c) => Math.floor(c.bestCleanMeters),
  }),

  // ---------------------------------------------------------- run
  def({
    id: 'distance',
    group: 'run',
    icon: '📏',
    needs: [],
    tags: ['far'],
    accrual: 'run',
    targets: [400, 800, 1200, 1800, 2600],
    unit: 'm',
    label: (n) => `Reach ${n} m in one run`,
    measure: (c) => Math.floor(c.distance),
  }),
  def({
    id: 'score',
    group: 'run',
    icon: '⭐',
    needs: [],
    tags: ['far'],
    accrual: 'run',
    targets: [500, 1200, 2200, 3500, 5000],
    unit: 'pts',
    label: (n) => `Score ${n} in one run`,
    measure: (c) => Math.floor(c.score),
  }),
  def({
    id: 'coins-run',
    group: 'run',
    icon: '🪙',
    needs: [],
    tags: ['coins'],
    accrual: 'run',
    targets: [30, 60, 100, 160, 240],
    unit: 'coins',
    label: (n) => `Collect ${n} coins in one run`,
    measure: (c) => c.coins,
  }),
  def({
    id: 'magnet-coins',
    group: 'run',
    icon: '🧲',
    needs: [],
    tags: ['coins'],
    accrual: 'run',
    targets: [10, 18, 28, 40, 55],
    unit: 'coins',
    label: (n) => `Pull ${n} coins in with one magnet`,
    measure: (c) => c.magnetCoinsBest,
  }),
  def({
    id: 'hoverboard-time',
    group: 'run',
    icon: '🛹',
    needs: ['hoverboard'],
    tags: [],
    accrual: 'total',
    targets: [20, 45, 75, 110, 160],
    unit: 's',
    label: (n) => `Ride the hoverboard for ${n}s`,
    measure: (c) => Math.floor(c.hoverboardSec),
  }),
  def({
    // Shaking the TT off means letting him close in first: it cannot sit beside a "clean" goal.
    id: 'near-miss',
    group: 'run',
    icon: '🚋',
    needs: [],
    tags: ['clean'],
    accrual: 'total',
    targets: [3, 6, 10, 15, 22],
    unit: 'escapes',
    label: (n) => `Shake off the TT ${n} times`,
    measure: (c) => c.nearMisses,
  }),

  // ---------------------------------------------------------- habit
  def({
    id: 'two-days',
    group: 'habit',
    icon: '📅',
    needs: [],
    tags: [],
    accrual: 'total',
    targets: [2, 3, 4, 5, 6],
    unit: 'days',
    label: (n) => `Play on ${n} different days`,
    measure: () => 1,
    mark: (ctx) => ctx.day,
  }),
  def({
    id: 'session-runs',
    group: 'habit',
    icon: '🔁',
    needs: [],
    tags: ['session'],
    accrual: 'run',
    targets: [3, 4, 5, 6, 8],
    unit: 'runs',
    label: (n) => `Do ${n} runs in one session`,
    measure: (_c, ctx) => ctx.sessionRun,
  }),
  def({
    id: 'beat-last',
    group: 'habit',
    icon: '📈',
    needs: [],
    tags: ['session'],
    accrual: 'total',
    targets: [1, 2, 3, 5],
    unit: 'runs',
    label: (n) => (n === 1 ? 'Beat your last run’s distance' : `Beat your last run’s distance ${n} times`),
    measure: (c, ctx) => (ctx.previousDistance !== null && c.distance > ctx.previousDistance ? 1 : 0),
  }),
]);

const BY_ID = new Map(MISSION_POOL.map((d) => [d.id, d]));

export const missionDef = (id: string): MissionDef | undefined => BY_ID.get(id);

// ---------------------------------------------------------------- selection

export interface MissionContext {
  mode: PlayMode;
  capabilities: readonly MissionCapability[];
  /** How many missions to keep active. */
  slots?: number;
}

/**
 * The capabilities a player actually has.
 * `skipped` are move-check steps they gave up on; `tracksJogging` is false for a keyboard,
 * which measures no steps and no cadence at all.
 */
export function capabilitiesFor(opts: { tracksJogging: boolean; skipped?: readonly string[] }): MissionCapability[] {
  const skipped = new Set(opts.skipped ?? []);
  const out: MissionCapability[] = [];
  if (opts.tracksJogging && !skipped.has('jog')) out.push('jog', 'steps', 'josh');
  if (!skipped.has('jump')) out.push('jump');
  if (!skipped.has('roll')) out.push('roll');
  if (!skipped.has('left') || !skipped.has('right')) out.push('lane');
  if (!skipped.has('hover')) out.push('hoverboard');
  return out;
}

export const MISSION_SLOTS = 3;

/** Every mission this player's mode and capabilities allow. */
export function eligibleMissions(ctx: MissionContext): MissionDef[] {
  const have = new Set(ctx.capabilities);
  return MISSION_POOL.filter(
    (d) => (!d.modes || d.modes.includes(ctx.mode)) && d.needs.every((n) => have.has(n)),
  );
}

/** The target for a tier, scaled for the mode. The last tier repeats for a player past the end. */
export function targetFor(d: MissionDef, tier: number, mode: PlayMode): number {
  const t = d.targets[Math.min(Math.max(0, Math.floor(tier)), d.targets.length - 1)];
  const scale = d.scale?.[mode] ?? 1;
  return Math.max(1, Math.round(t * scale));
}

/** Coins for finishing a mission, by tier. */
export const MISSION_COINS: readonly number[] = [50, 75, 110, 150, 200];

export const missionReward = (tier: number): number =>
  MISSION_COINS[Math.min(Math.max(0, Math.floor(tier)), MISSION_COINS.length - 1)];

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Picks up to `count` missions that can all progress in the same run: no shared tag with each
 * other or with `taken` (the tags of the missions already on the board — an id is a tag too, so
 * passing ids works). Movement missions are offered first, so the set leans on moving.
 */
export function pickMissions(ctx: MissionContext, seed: number, count: number, taken: readonly string[] = []): MissionDef[] {
  const rng = new Rng(seed);
  const pool = eligibleMissions(ctx);
  const movement = shuffled(pool.filter((d) => d.group === 'movement'), rng);
  const rest = shuffled(pool.filter((d) => d.group !== 'movement'), rng);
  const chosen: MissionDef[] = [];

  /** `spread` also keeps the missions chosen here from sharing a tag with each other. */
  const fill = (used: Set<string>, spread: boolean): void => {
    for (const d of [...movement, ...rest]) {
      if (chosen.length >= count) return;
      if (chosen.includes(d)) continue;
      if (d.tags.some((t) => used.has(t))) continue;
      chosen.push(d);
      if (spread) for (const t of d.tags) used.add(t);
    }
  };

  fill(new Set(taken), true);
  // A player with almost nothing eligible gets two missions that share a tag rather than an empty
  // board. What the relaxed pass must not do is undo the rules that are not about spread: it still
  // starts from `taken`, so nothing it picks can clash with a mission the board is already keeping,
  // and it still skips anything already chosen, so the same mission cannot appear twice.
  if (chosen.length < count) fill(new Set(taken), false);
  return chosen;
}

// ---------------------------------------------------------------- state

export interface ActiveMission {
  id: string;
  tier: number;
  target: number;
  progress: number;
  done: boolean;
  /** The last mark counted, for missions that may only count once per day. */
  mark: string | null;
}

export interface MissionsState {
  version: 1;
  active: ActiveMission[];
  /** Lifetime completions; drives how fast the tiers climb. */
  completed: number;
  /** Rolls forward every time a slot is refilled, so the pool keeps moving. */
  seed: number;
}

/** Completions per tier step: the missions get harder, but gently. */
export const TIER_EVERY = 3;

export const tierFor = (completed: number): number => Math.max(0, Math.floor(completed / TIER_EVERY));

export const emptyMissions = (seed = 1): MissionsState => ({
  version: 1,
  active: [],
  completed: 0,
  seed: seed >>> 0 || 1,
});

const newMission = (d: MissionDef, tier: number, mode: PlayMode): ActiveMission => ({
  id: d.id,
  tier,
  target: targetFor(d, tier, mode),
  progress: 0,
  done: false,
  mark: null,
});

/**
 * Fills empty slots and swaps out anything finished or no longer possible (the player switched
 * mode, or redid the move check and skipped a move). Pure: returns a new state.
 */
export function refreshMissions(state: MissionsState, ctx: MissionContext): MissionsState {
  const slots = ctx.slots ?? MISSION_SLOTS;
  const eligible = new Set(eligibleMissions(ctx).map((d) => d.id));
  const keep = state.active.filter((m) => !m.done && eligible.has(m.id) && BY_ID.has(m.id)).slice(0, slots);

  // Dropping a finished mission must not let a conflicting one slide in beside the survivors.
  const used = new Set<string>();
  const kept: ActiveMission[] = [];
  for (const m of keep) {
    const d = BY_ID.get(m.id)!;
    if (d.tags.some((t) => used.has(t))) continue;
    for (const t of d.tags) used.add(t);
    kept.push(m);
  }
  if (kept.length >= slots) return { ...state, active: kept };

  const tier = tierFor(state.completed);
  const added = pickMissions(ctx, state.seed, slots - kept.length, [...used]).map((d) => newMission(d, tier, ctx.mode));
  return { ...state, active: [...kept, ...added], seed: (state.seed * 1664525 + 1013904223) >>> 0 || 1 };
}

export interface MissionCompletion {
  id: string;
  label: string;
  icon: string;
  tier: number;
  coins: number;
}

export interface MissionRunResult {
  state: MissionsState;
  completed: MissionCompletion[];
  /** Coins the completions are worth. */
  coins: number;
  /** Missions whose progress moved this run (for the HUD toast), completed or not. */
  advanced: string[];
}

/**
 * Folds one finished run into the mission set. Called exactly once per run, at the summary —
 * a run abandoned with Home never reaches it, just like the profile.
 */
export function applyRun(
  state: MissionsState,
  ctx: MissionContext,
  counters: RunCounters,
  run: MissionRunContext,
): MissionRunResult {
  const completed: MissionCompletion[] = [];
  const advanced: string[] = [];
  let coins = 0;
  let done = state.completed;

  const active = state.active.map((m): ActiveMission => {
    const d = BY_ID.get(m.id);
    if (!d || m.done) return m;
    const mark = d.mark ? d.mark(run) : null;
    if (mark !== null && mark === m.mark) return m;
    const raw = d.measure(counters, run);
    const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const next = d.accrual === 'run' ? Math.max(m.progress, value) : m.progress + value;
    const progress = Math.min(m.target, Math.floor(next));
    if (progress === m.progress && mark === m.mark) return m;
    if (progress > m.progress) advanced.push(m.id);
    const finished = progress >= m.target;
    if (finished) {
      const reward = missionReward(m.tier);
      coins += reward;
      done++;
      completed.push({ id: d.id, label: d.label(m.target), icon: d.icon, tier: m.tier, coins: reward });
    }
    return { ...m, progress, done: finished, mark: mark ?? m.mark };
  });

  return { state: { ...state, active, completed: done }, completed, coins, advanced };
}

// ---------------------------------------------------------------- view model

export interface MissionView {
  id: string;
  group: MissionGroup;
  icon: string;
  label: string;
  progress: number;
  target: number;
  /** 0..1, clamped and never NaN. */
  frac: number;
  done: boolean;
  /** "180 / 250 steps", or "Done!" */
  text: string;
  reward: number;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function missionView(m: ActiveMission): MissionView {
  const d = BY_ID.get(m.id);
  const target = Math.max(1, m.target);
  const progress = Math.max(0, Math.min(target, m.progress));
  return {
    id: m.id,
    group: d?.group ?? 'run',
    icon: d?.icon ?? '🎯',
    label: d ? d.label(target) : m.id,
    progress,
    target,
    frac: clamp01(progress / target),
    done: m.done || progress >= target,
    text: m.done || progress >= target ? 'Done!' : `${progress} / ${target} ${d?.unit ?? ''}`.trim(),
    reward: missionReward(m.tier),
  };
}

export const missionViews = (state: MissionsState): MissionView[] => state.active.map(missionView);
