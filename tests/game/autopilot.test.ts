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
