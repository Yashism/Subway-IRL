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

  it('exposes depleting power-up timers, the josh multiplier and a GO flash', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.step(1 / 60, [{ type: 'start' }], KB);
    for (let i = 0; i < 181; i++) g.step(1 / 60, [], KB);
    expect(hudModel(g).go).toBe(true);
    for (let i = 0; i < 60; i++) g.step(1 / 60, [], KB);
    expect(hudModel(g).go).toBe(false);

    g.powerups.activate('magnet');
    g.powerups.activate('rocket');
    g.powerups.activateHoverboard();
    g.powerups.magnet = 2.5;
    const m = hudModel(g);
    expect(m.timers.map((t) => t.kind)).toEqual(['magnet', 'rocket', 'hoverboard']);
    expect(m.timers[0].frac).toBeCloseTo(0.25);
    expect(m.timers[0].seconds).toBe(3);
    expect(m.timers[1].frac).toBe(1);
    expect(m.hoverboards).toBe(2);
    expect(m.multiplier).toBe('');

    g.josh.value = 1;
    g.josh.active = true;
    expect(hudModel(g).multiplier).toBe('×2');
    expect(hudModel(g).joshActive).toBe(true);
  });

  it('fills the summary card', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.state = 'summary';
    Object.assign(g.stats, { score: 1234, coins: 56, distance: 789.6, jumps: 7, rolls: 3, timeSec: 75.4 });
    const m = hudModel(g);
    expect(m.center).toBe('Score 1234');
    expect(m.summary).toEqual({ score: '1234', coins: '56', distance: '789 m', jumps: '7', rolls: '3', time: '1:15' });
  });
});
