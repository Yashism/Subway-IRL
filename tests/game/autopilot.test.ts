import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { TUNING, type Difficulty, type ObstacleSettings } from '../../src/game/config';
import { Autopilot, liveSpecs } from '../../src/game/autopilot';
import { Game } from '../../src/game/game';
import { closingRate, lengthOf, movingFrontAt, type ObstacleSpec } from '../../src/game/obstacles';

function drive(seed: number, difficulty: Difficulty, seconds: number, obstacles?: ObstacleSettings): Game {
  const g = new Game({ seed, difficulty, obstacles });
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

const EMPTY: ChunkDef[] = [{ id: 'empty', tier: 0, obstacles: [], coins: [] }];

/**
 * Both side lanes walled by parked trains and two barriers `gap` seconds apart in the centre lane.
 * Chappals are either already on (with `chappalLeft` seconds left) or picked up `pickupAhead` m ahead.
 */
function chappalProbe(chappal: { left: number } | { pickupAhead: number }, barrierAt = 30, gap = 0.8): Game {
  const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
  const bot = new Autopilot(g);
  let tMs = 0;
  const run = (frames: number) => {
    for (let i = 0; i < frames && g.state !== 'caught'; i++) {
      bot.tick();
      g.step(1 / TUNING.stepHz, bot.drain(), bot.activity(tMs));
      tMs += 1000 / TUNING.stepHz;
    }
  };
  run(1 + TUNING.countdownSeconds * TUNING.stepHz);
  expect(g.state).toBe('playing');
  const { s, speed } = g;
  if ('left' in chappal) g.powerups.chappal = chappal.left;
  else g.track.pickups.push({ id: 1, kind: 'chappal', lane: 0, s: s + chappal.pickupAhead, taken: false });
  const specs: ObstacleSpec[] = [
    { kind: 'trainParked', lane: -1, s: s + 5, length: 60 },
    { kind: 'trainParked', lane: 1, s: s + 5, length: 60 },
    { kind: 'barrierLow', lane: 0, s: s + barrierAt },
    { kind: 'barrierLow', lane: 0, s: s + barrierAt + gap * speed },
  ];
  specs.forEach((o, i) => g.track.obstacles.push({ id: 100 + i, kind: o.kind, lane: o.lane, length: lengthOf(o), front: o.s }));
  run(5 * TUNING.stepHz);
  return g;
}

describe('Autopilot', () => {
  it('converts oncoming trains back to meeting points', () => {
    const front = movingFrontAt(120, 20, 25);
    const [spec] = liveSpecs([{ id: 1, kind: 'trainMoving', lane: 0, length: 30, front, closing: closingRate(25) }], 20, 25);
    expect(spec.s).toBeCloseTo(120, 9);
    expect(spec.length).toBe(30);
  });

  it('jumps twice in a row with chappals on', () => {
    for (let at = 25; at < 32; at += 0.35) {
      const g = chappalProbe({ left: TUNING.chappalSeconds }, at);
      expect(g.caughtReason, `barriers at +${at.toFixed(2)} m: ${context(g)}`).toBeNull();
      expect(g.stats.jumps).toBe(2);
    }
  }, 30_000);

  it('plans across chappals running out', () => {
    for (let left = 0.2; left < 3.2; left += 0.1) {
      const g = chappalProbe({ left }, 25 + 10 * (left % 0.3));
      expect(g.caughtReason, `${left.toFixed(1)} s of chappals left: ${context(g)}`).toBeNull();
    }
  }, 30_000);

  it('replans after picking up chappals mid-plan', () => {
    // Barriers 0.5 s apart: a jump the old plan timed for normal shoes lands too late with chappals.
    for (const at of [27.5, 28]) {
      for (let ahead = 21; ahead <= 23; ahead += 0.25) {
        const g = chappalProbe({ pickupAhead: ahead }, at, 0.5);
        expect(g.caughtReason, `pickup ${ahead} m ahead: ${context(g)}`).toBeNull();
        expect(g.powerups.chappal).toBeGreaterThan(0);
      }
    }
  }, 30_000);

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

  // Obstacle settings only choose among patterns the solver has checked, so every combination must
  // still be clearable: the bot plays the hardest and the busiest, and the gentlest and the sparsest.
  it.each([
    [5, 'lots'],
    [5, 'few'],
    [1, 'lots'],
    [1, 'few'],
  ] as const)('survives two minutes at obstacle level %i, amount %s', (level, amount) => {
    const g = drive(7, 'beast', 125, { level, amount });
    expect(g.caughtReason, context(g)).toBeNull();
    expect(g.state).toBe('playing');
  }, 180_000);
});

describe('Autopilot.enabled', () => {
  it('stops steering and stops pressing start when switched off', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio' });
    const bot = new Autopilot(g);
    bot.tick();
    expect(bot.drain()).toEqual([{ type: 'start' }]); // in the menu the bot presses start
    bot.enabled = false;
    bot.tick();
    expect(bot.drain()).toEqual([]);
  });
});
