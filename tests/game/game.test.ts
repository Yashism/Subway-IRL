import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { TUNING } from '../../src/game/config';
import { Game, type GameEvent, type GameOptions } from '../../src/game/game';
import { lengthOf, movingFrontAt, type ObstacleSpec } from '../../src/game/obstacles';
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

  it('pauses on command during the countdown', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    steps(g, 1, [{ type: 'start' }]);
    steps(g, 30);
    steps(g, 1, [{ type: 'pause' }]);
    expect(g.state).toBe('paused');
    expect(g.pausedByLoss).toBe(false);
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

  it('clears the lane behind a crash the hoverboard absorbed', () => {
    const g = playing();
    const front = g.s + 10;
    place(g, { kind: 'auto', lane: 0, s: front });
    place(g, { kind: 'trainParked', lane: 0, s: front + lengthOf({ kind: 'auto', lane: 0, s: 0 }) + 4 });
    const ev = steps(g, 60, [{ type: 'hoverboard' }]);
    expect(ev).toContainEqual({ type: 'hoverboardSaved' });
    steps(g, 180);
    expect(g.state).toBe('playing');
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

  it('stumbles exactly once on one physical side clip', () => {
    const g = playing();
    const front = g.s + 8;
    place(g, { kind: 'auto', lane: 1, s: front });
    stepTo(g, front - 0.9);
    const ev = steps(g, 60, [{ type: 'shiftLane', dir: 1 }]);
    expect(ev.filter((e) => e.type === 'stumble')).toHaveLength(1);
    expect(g.state).toBe('playing');
    expect(g.runner.lane).toBe(0);
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

  it('clears oncoming trains that would meet the runner just after a rocket landing', () => {
    for (const after of [1.8, 2.1, 2.4]) {
      const g = playing();
      g.powerups.activate('rocket');
      steps(g, 60 * (TUNING.rocketSeconds - 1));
      expect(g.runner.flying).toBe(true);
      const left = g.powerups.rocket;
      const meet = g.s + g.speed * (left + after);
      place(g, { kind: 'trainMoving', lane: g.runner.lane, s: movingFrontAt(meet, g.s, g.speed) });
      const ev = steps(g, Math.round(60 * (left + 4)));
      expect(ev).toContainEqual({ type: 'rocketLanding' });
      expect(g.state, `meeting ${after} s after landing`).toBe('playing');
    }
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

describe('Lane changes on train roofs', () => {
  /** A runner standing on a parked-train roof in `from`, with `next` in the neighbouring lane. */
  function onRoof(from: -1 | 0 | 1, next: 'trainParked' | 'trainMoving', to: -1 | 0 | 1, meetAhead = 0): Game {
    const g = playing();
    g.runner.lane = from;
    g.runner.prevLane = from;
    g.runner.x = from * 2.5;
    place(g, { kind: 'trainParked', lane: from, s: g.s - 5 });
    if (next === 'trainParked') place(g, { kind: 'trainParked', lane: to, s: g.s - 5 });
    else place(g, { kind: 'trainMoving', lane: to, s: movingFrontAt(g.s + meetAhead, g.s, g.speed) });
    g.runner.y = TUNING.trainHeight;
    steps(g, 5);
    expect(g.runner.y).toBe(TUNING.trainHeight);
    return g;
  }

  for (const [from, to] of [[0, 1], [1, 0], [0, -1], [-1, 0]] as const) {
    it(`walks from one roof to the next (lane ${from} -> ${to})`, () => {
      const g = onRoof(from, 'trainParked', to);
      const ev = steps(g, 30, [{ type: 'setLane', lane: to }]);
      expect(ev.filter((e) => e.type === 'stumble')).toHaveLength(0);
      expect(g.state).toBe('playing');
      expect(g.runner.lane).toBe(to);
      expect(g.runner.x).toBe(to * 2.5);
      expect(g.runner.y).toBe(TUNING.trainHeight);
      expect(g.runner.airborne).toBe(false);
    });
  }

  // meetAhead 0: the oncoming train is already alongside (side clip); 4: it arrives head-on.
  for (const [from, to, meetAhead] of [[0, 1, 0], [1, 0, 0], [0, 1, 4], [1, 0, 4]] as const) {
    it(`stumbles or crashes only once stepping off a roof into an oncoming train (lane ${from} -> ${to}, meets ${meetAhead} m ahead)`, () => {
      const g = onRoof(from, 'trainMoving', to, meetAhead);
      const ev = steps(g, 60, [{ type: 'setLane', lane: to }]);
      expect(ev.filter((e) => e.type === 'stumble').length).toBeLessThanOrEqual(1);
      if (g.state !== 'playing') expect(g.caughtReason).toBe('crash');
      expect(ev.filter((e) => e.type === 'stumble' || e.type === 'caught').length).toBe(1);
    });
  }
});
