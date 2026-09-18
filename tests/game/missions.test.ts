import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { Game, type GameEvent } from '../../src/game/game';
import {
  ALL_CAPABILITIES,
  MISSION_POOL,
  MISSION_SLOTS,
  MissionTracker,
  applyRun,
  capabilitiesFor,
  eligibleMissions,
  emptyCounters,
  emptyMissions,
  missionDef,
  missionReward,
  missionView,
  missionViews,
  pickMissions,
  refreshMissions,
  runSample,
  targetFor,
  tierFor,
  type ActiveMission,
  type MissionContext,
  type MissionRunContext,
  type RunCounters,
  type RunSample,
} from '../../src/game/missions';
import type { ActivityStatus } from '../../src/input/commands';

const FULL: MissionContext = { mode: 'full', capabilities: ALL_CAPABILITIES };
const SMALL: MissionContext = { mode: 'small', capabilities: ALL_CAPABILITIES };
const RUN: MissionRunContext = { day: '2026-09-18', sessionRun: 1, previousDistance: null };

const counters = (over: Partial<RunCounters> = {}): RunCounters => ({ ...emptyCounters(), ...over });

const sample = (over: Partial<RunSample> = {}): RunSample => ({
  dt: 1 / 60,
  playing: true,
  stats: {
    distance: 0, coins: 0, score: 0, timeSec: 0,
    jumps: 0, rolls: 0, laneChanges: 0, steps: 0, hoverboardsUsed: 0,
  },
  idleLevel: 'ok',
  joshActive: false,
  magnetSec: 0,
  hoverboardSec: 0,
  chaserGap: 12,
  ...over,
});

/** Feeds n one-second frames with the same shape. */
function feed(t: MissionTracker, n: number, over: Partial<RunSample> | ((i: number) => Partial<RunSample>)): void {
  for (let i = 0; i < n; i++) t.sample(sample({ dt: 1, ...(typeof over === 'function' ? over(i) : over) }));
}

// ---------------------------------------------------------------- the tracker

describe('MissionTracker', () => {
  it('copies the stats the sim already keeps', () => {
    const t = new MissionTracker();
    t.sample(sample({ stats: { distance: 120.5, coins: 9, score: 129, timeSec: 11, jumps: 3, rolls: 1, laneChanges: 4, steps: 40, hoverboardsUsed: 1 } }));
    expect(t.counters).toMatchObject({ distance: 120.5, coins: 9, score: 129, jumps: 3, rolls: 1, laneChanges: 4, steps: 40, hoverboardsUsed: 1 });
  });

  it('measures the longest unbroken jog streak, not the total', () => {
    const t = new MissionTracker();
    feed(t, 10, { idleLevel: 'ok' });
    feed(t, 1, { idleLevel: 'warn' });
    feed(t, 4, { idleLevel: 'ok' });
    expect(t.counters.bestJogStreakSec).toBe(10);
    expect(t.counters.jogStreakSec).toBe(4);
    expect(t.counters.idleWarnings).toBe(1);
  });

  it('holds the streak across a pause instead of breaking it', () => {
    const t = new MissionTracker();
    feed(t, 6, { idleLevel: 'ok' });
    feed(t, 5, { playing: false });
    feed(t, 6, { idleLevel: 'ok' });
    expect(t.counters.jogStreakSec).toBe(12);
    expect(t.counters.bestJogStreakSec).toBe(12);
  });

  it('times the Josh streak and the hoverboard separately', () => {
    const t = new MissionTracker();
    feed(t, 8, { joshActive: true, hoverboardSec: 5 });
    feed(t, 3, { joshActive: false, hoverboardSec: 2 });
    feed(t, 4, { joshActive: true });
    expect(t.counters.bestJoshStreakSec).toBe(8);
    expect(t.counters.hoverboardSec).toBe(11);
  });

  it('counts coins inside one magnet, and starts over on the next one', () => {
    const t = new MissionTracker();
    const at = (coins: number, magnet: number) => sample({ dt: 1, magnetSec: magnet, stats: { ...sample().stats, coins } });
    t.sample(at(5, 0));
    t.sample(at(5, 10));
    t.sample(at(17, 4));   // 12 in this magnet
    t.sample(at(20, 0));
    t.sample(at(20, 10));
    t.sample(at(24, 3));   // only 4 in the next one
    expect(t.counters.magnetCoinsBest).toBe(12);
  });

  it('counts a near miss only when the TT closes in and is shaken off again', () => {
    const t = new MissionTracker();
    // The run starts with the TT right behind: that opening gap is not a free escape.
    feed(t, 2, { chaserGap: 1.5 });
    expect(t.counters.nearMisses).toBe(0);
    feed(t, 2, { chaserGap: 12 });
    feed(t, 2, { chaserGap: 3 });
    expect(t.counters.nearMisses).toBe(0); // still close: not survived yet
    feed(t, 2, { chaserGap: 11 });
    expect(t.counters.nearMisses).toBe(1);
  });

  it('resets the clean stretch on a stumble and on a warning', () => {
    const t = new MissionTracker();
    let d = 0;
    const run = (n: number, idle: 'ok' | 'warn' = 'ok') => {
      for (let i = 0; i < n; i++) t.sample(sample({ dt: 1, idleLevel: idle, stats: { ...sample().stats, distance: (d += 10) } }));
    };
    run(30);
    t.event({ type: 'stumble' });
    run(12);
    expect(t.counters.stumbles).toBe(1);
    expect(t.counters.bestCleanMeters).toBe(300);
    expect(t.counters.cleanMeters).toBe(120);
  });

  it('ignores a bad dt rather than poisoning every streak', () => {
    const t = new MissionTracker();
    t.sample(sample({ dt: Number.NaN }));
    t.sample(sample({ dt: -5 }));
    expect(Number.isFinite(t.counters.bestJogStreakSec)).toBe(true);
    expect(t.counters.bestJogStreakSec).toBe(0);
  });

  it('reset() clears everything, including the near-miss arming', () => {
    const t = new MissionTracker();
    feed(t, 4, { chaserGap: 12 });
    feed(t, 2, { chaserGap: 2 });
    t.event({ type: 'stumble' });
    t.reset();
    expect(t.counters).toEqual(emptyCounters());
    // The TT is far away again, but nothing was escaped since the reset.
    feed(t, 2, { chaserGap: 11 });
    expect(t.counters.nearMisses).toBe(0);
    expect(t.counters.stumbles).toBe(0);
  });
});

// ---------------------------------------------------------------- the pool

describe('the mission pool', () => {
  it('leans on movement', () => {
    const movement = MISSION_POOL.filter((d) => d.group === 'movement').length;
    expect(movement).toBeGreaterThan(MISSION_POOL.length / 2 - 1);
    expect(movement).toBeGreaterThanOrEqual(MISSION_POOL.filter((d) => d.group === 'run').length);
  });

  it('gives every mission a unique id and its own id as a tag', () => {
    const ids = MISSION_POOL.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of MISSION_POOL) expect(d.tags).toContain(d.id);
  });

  it('never offers a mission the player cannot attempt', () => {
    // Keyboard: no jog is measured at all, so no step, streak or Josh mission may appear.
    const kb = capabilitiesFor({ tracksJogging: false });
    expect(kb).not.toContain('steps');
    const ids = eligibleMissions({ mode: 'full', capabilities: kb }).map((d) => d.id);
    expect(ids).not.toContain('jog-steps');
    expect(ids).not.toContain('jog-streak');
    expect(ids).not.toContain('josh-streak');
    expect(ids).toContain('distance');
  });

  it('drops a mission whose move was skipped in the move check', () => {
    const caps = capabilitiesFor({ tracksJogging: true, skipped: ['jump', 'hover'] });
    const ids = eligibleMissions({ mode: 'full', capabilities: caps }).map((d) => d.id);
    expect(ids).not.toContain('jumps');
    expect(ids).not.toContain('hoverboard-time');
    expect(ids).toContain('rolls');
  });

  it('is mode-aware', () => {
    const full = eligibleMissions(FULL).map((d) => d.id);
    const small = eligibleMissions(SMALL).map((d) => d.id);
    expect(full).toContain('lane-sprint');
    expect(small).not.toContain('lane-sprint');
  });

  it('scales a small-room target down', () => {
    const d = missionDef('jog-steps')!;
    expect(targetFor(d, 0, 'small')).toBeLessThan(targetFor(d, 0, 'full'));
    expect(targetFor(d, 0, 'small')).toBeGreaterThan(0);
  });

  it('climbs with the tier and stops at the last one', () => {
    const d = missionDef('jog-steps')!;
    expect(targetFor(d, 1, 'full')).toBeGreaterThan(targetFor(d, 0, 'full'));
    expect(targetFor(d, 99, 'full')).toBe(targetFor(d, d.targets.length - 1, 'full'));
    expect(targetFor(d, -3, 'full')).toBe(targetFor(d, 0, 'full'));
  });
});

describe('pickMissions', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = pickMissions(FULL, 7, 3).map((d) => d.id);
    const b = pickMissions(FULL, 7, 3).map((d) => d.id);
    expect(a).toEqual(b);
    const seen = new Set<string>();
    for (let s = 1; s < 40; s++) seen.add(pickMissions(FULL, s, 3).map((d) => d.id).join(','));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('never picks two missions that cannot both progress in one run', () => {
    for (let s = 1; s < 300; s++) {
      const picked = pickMissions(FULL, s, 3);
      const tags = picked.flatMap((d) => d.tags);
      expect(new Set(tags).size, `seed ${s}: ${picked.map((d) => d.id)}`).toBe(tags.length);
    }
  });

  it('respects the tags already on the board', () => {
    const clean = missionDef('clean-run')!;
    for (let s = 1; s < 120; s++) {
      const picked = pickMissions(FULL, s, 2, clean.tags);
      for (const d of picked) expect(d.tags.some((t) => clean.tags.includes(t))).toBe(false);
    }
  });

  it('leads with movement', () => {
    for (let s = 1; s < 60; s++) {
      const picked = pickMissions(FULL, s, 3);
      expect(picked.filter((d) => d.group === 'movement').length).toBeGreaterThanOrEqual(2);
    }
  });

  it('fills the board even for a player with almost nothing eligible', () => {
    const bare: MissionContext = { mode: 'small', capabilities: [] };
    expect(pickMissions(bare, 5, 3).length).toBe(3);
  });
});

// ---------------------------------------------------------------- state

describe('refreshMissions', () => {
  it('fills three slots and keeps them stable across calls', () => {
    const a = refreshMissions(emptyMissions(3), FULL);
    expect(a.active).toHaveLength(MISSION_SLOTS);
    const b = refreshMissions(a, FULL);
    expect(b.active.map((m) => m.id)).toEqual(a.active.map((m) => m.id));
  });

  it('replaces a finished mission with a fresh one that still fits beside the others', () => {
    const a = refreshMissions(emptyMissions(11), FULL);
    const doneId = a.active[0].id;
    const withDone = { ...a, active: [{ ...a.active[0], done: true, progress: a.active[0].target }, ...a.active.slice(1)], completed: 1 };
    const b = refreshMissions(withDone, FULL);
    expect(b.active).toHaveLength(MISSION_SLOTS);
    expect(b.active.map((m) => m.id)).not.toContain(doneId);
    const tags = b.active.flatMap((m) => missionDef(m.id)!.tags);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('gives the replacement a harder target once enough missions are done', () => {
    const base = refreshMissions(emptyMissions(4), FULL);
    const completed = 3;
    expect(tierFor(completed)).toBe(1);
    const next = refreshMissions({ ...base, active: base.active.map((m) => ({ ...m, done: true })), completed }, FULL);
    for (const m of next.active) expect(m.tier).toBe(1);
  });

  it('swaps out a mission the player can no longer attempt', () => {
    const full = refreshMissions({ ...emptyMissions(9), active: [{ id: 'lane-sprint', tier: 0, target: 12, progress: 3, done: false, mark: null }] }, FULL);
    expect(full.active.map((m) => m.id)).toContain('lane-sprint');
    const small = refreshMissions(full, SMALL);
    expect(small.active.map((m) => m.id)).not.toContain('lane-sprint');
    expect(small.active).toHaveLength(MISSION_SLOTS);
  });

  it('drops a mission id it does not recognise', () => {
    const s = refreshMissions({ ...emptyMissions(2), active: [{ id: 'nope', tier: 0, target: 5, progress: 1, done: false, mark: null }] }, FULL);
    expect(s.active.map((m) => m.id)).not.toContain('nope');
  });
});

describe('applyRun', () => {
  const board = (ids: string[], over: Partial<ActiveMission> = {}) =>
    ({ ...emptyMissions(1), active: ids.map((id) => ({ id, tier: 0, target: targetFor(missionDef(id)!, 0, 'full'), progress: 0, done: false, mark: null, ...over })) });

  it('takes the best single run for a "run" mission and never goes backwards', () => {
    let s = board(['jog-steps']);
    s = applyRun(s, FULL, counters({ steps: 100 }), RUN).state;
    expect(s.active[0].progress).toBe(100);
    s = applyRun(s, FULL, counters({ steps: 40 }), RUN).state;
    expect(s.active[0].progress).toBe(100);
  });

  it('adds up a "total" mission across runs', () => {
    let s = board(['jumps']);
    s = applyRun(s, FULL, counters({ jumps: 4 }), RUN).state;
    s = applyRun(s, FULL, counters({ jumps: 3 }), RUN).state;
    expect(s.active[0].progress).toBe(7);
  });

  it('completes, pays out and clamps to the target', () => {
    const s = board(['jumps']);
    const r = applyRun(s, FULL, counters({ jumps: 999 }), RUN);
    expect(r.state.active[0].done).toBe(true);
    expect(r.state.active[0].progress).toBe(r.state.active[0].target);
    expect(r.completed.map((c) => c.id)).toEqual(['jumps']);
    expect(r.coins).toBe(missionReward(0));
    expect(r.state.completed).toBe(1);
  });

  it('pays a finished mission exactly once', () => {
    let s = board(['jumps']);
    const first = applyRun(s, FULL, counters({ jumps: 999 }), RUN);
    s = first.state;
    const second = applyRun(s, FULL, counters({ jumps: 999 }), RUN);
    expect(second.coins).toBe(0);
    expect(second.completed).toHaveLength(0);
    expect(second.state.completed).toBe(1);
  });

  it('only counts a clean run when nothing was clipped', () => {
    const dirty = applyRun(board(['clean-run']), FULL, counters({ stumbles: 1, timeSec: 40 }), RUN);
    expect(dirty.state.active[0].progress).toBe(0);
    const clean = applyRun(board(['clean-run']), FULL, counters({ stumbles: 0, timeSec: 40 }), RUN);
    expect(clean.state.active[0].progress).toBe(1);
  });

  it('counts a new day once, however many runs it takes', () => {
    let s = board(['two-days']);
    s = applyRun(s, FULL, counters({ timeSec: 20 }), { ...RUN, day: '2026-09-18' }).state;
    s = applyRun(s, FULL, counters({ timeSec: 20 }), { ...RUN, day: '2026-09-18', sessionRun: 2 }).state;
    expect(s.active[0].progress).toBe(1);
    s = applyRun(s, FULL, counters({ timeSec: 20 }), { ...RUN, day: '2026-09-19' }).state;
    expect(s.active[0].progress).toBe(2);
  });

  it('reads the session and the previous run for the habit missions', () => {
    const runs = applyRun(board(['session-runs']), FULL, counters(), { ...RUN, sessionRun: 3 });
    expect(runs.state.active[0].progress).toBe(3);
    const worse = applyRun(board(['beat-last']), FULL, counters({ distance: 400 }), { ...RUN, previousDistance: 500 });
    expect(worse.state.active[0].progress).toBe(0);
    const better = applyRun(board(['beat-last']), FULL, counters({ distance: 600 }), { ...RUN, previousDistance: 500 });
    expect(better.state.active[0].progress).toBe(1);
  });

  it('reports what moved, for the live toast', () => {
    const r = applyRun(board(['jumps', 'rolls']), FULL, counters({ jumps: 2 }), RUN);
    expect(r.advanced).toEqual(['jumps']);
  });

  it('never lets a hostile counter run progress backwards or explode', () => {
    const r = applyRun(board(['jumps']), FULL, counters({ jumps: -50 }), RUN);
    expect(r.state.active[0].progress).toBe(0);
    const nan = applyRun(board(['distance']), FULL, counters({ distance: Number.NaN }), RUN);
    expect(Number.isFinite(nan.state.active[0].progress)).toBe(true);
  });
});

describe('missionView', () => {
  it('formats progress and clamps the bar', () => {
    const v = missionView({ id: 'jog-steps', tier: 0, target: 120, progress: 30, done: false, mark: null });
    expect(v.text).toBe('30 / 120 steps');
    expect(v.frac).toBeCloseTo(0.25);
    expect(v.group).toBe('movement');
  });

  it('reads done as done however it got there', () => {
    expect(missionView({ id: 'jumps', tier: 1, target: 25, progress: 25, done: false, mark: null }).done).toBe(true);
    expect(missionView({ id: 'jumps', tier: 1, target: 25, progress: 99, done: false, mark: null }).frac).toBe(1);
    expect(missionView({ id: 'jumps', tier: 0, target: 25, progress: -9, done: false, mark: null }).frac).toBe(0);
  });

  it('survives an unknown id rather than throwing at the player', () => {
    const v = missionView({ id: 'gone', tier: 0, target: 3, progress: 1, done: false, mark: null });
    expect(v.label).toBe('gone');
    expect(v.icon).toBeTruthy();
  });

  it('views the whole board', () => {
    expect(missionViews(refreshMissions(emptyMissions(5), FULL))).toHaveLength(MISSION_SLOTS);
  });
});

// ---------------------------------------------------------------- against a real run

const EMPTY: ChunkDef[] = [{ id: 'empty', tier: 0, obstacles: [], coins: [] }];
const JOGGING: ActivityStatus = { tracksJogging: true, msSinceStep: 0, cadenceSpm: 170, steps: 0, squatting: false, lost: false };

describe('a real simulated run', () => {
  it('tracks a run without changing what the game does', () => {
    const opts = { seed: 42, difficulty: 'cardio' as const, chunks: EMPTY };
    const plain = new Game(opts);
    const watched = new Game(opts);
    const t = new MissionTracker();
    const dt = 1 / 60;

    const drive = (g: Game, track: boolean): void => {
      let events: GameEvent[] = g.step(dt, [{ type: 'start' }], { ...JOGGING, steps: 0 });
      for (let i = 1; i < 900; i++) {
        const activity = { ...JOGGING, steps: Math.floor(i / 20) };
        const cmds = i % 120 === 0 ? [{ type: 'jump' } as const] : [];
        events = g.step(dt, cmds, activity);
        if (!track) continue;
        for (const e of events) t.event(e);
        t.sample(runSample(g, dt));
      }
    };
    drive(plain, false);
    drive(watched, true);

    // Same sim, watched or not.
    expect(watched.stats).toEqual(plain.stats);
    expect(watched.s).toBeCloseTo(plain.s, 6);

    expect(t.counters.distance).toBeCloseTo(watched.stats.distance, 6);
    expect(t.counters.jumps).toBe(watched.stats.jumps);
    expect(t.counters.steps).toBe(watched.stats.steps);
    // Jogging the whole way: the streak is the time played, and nothing was clipped.
    expect(t.counters.bestJogStreakSec).toBeGreaterThan(10);
    expect(t.counters.stumbles).toBe(0);
    expect(t.counters.idleWarnings).toBe(0);
  });

  it('turns one simulated run into mission progress exactly once', () => {
    const g = new Game({ seed: 7, difficulty: 'cardio', chunks: EMPTY });
    const t = new MissionTracker();
    const dt = 1 / 60;
    g.step(dt, [{ type: 'start' }], { ...JOGGING, steps: 0 });
    for (let i = 1; i < 600; i++) {
      const events = g.step(dt, i % 90 === 0 ? [{ type: 'jump' }] : [], { ...JOGGING, steps: Math.floor(i / 15) });
      for (const e of events) t.event(e);
      t.sample(runSample(g, dt));
    }

    let s = refreshMissions(emptyMissions(3), FULL);
    const before = s.active.map((m) => m.progress);
    const r = applyRun(s, FULL, t.counters, RUN);
    expect(r.state.active.some((m, i) => m.progress > before[i])).toBe(true);
    // Folding the same run in again is what a double-call would do; it must not double-count.
    const again = applyRun(r.state, FULL, counters(), RUN);
    expect(again.state.active.map((m) => m.progress)).toEqual(r.state.active.map((m) => m.progress));
  });
});
