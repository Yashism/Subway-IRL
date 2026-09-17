import { describe, expect, it } from 'vitest';
import type { ChunkDef } from '../../src/game/chunks';
import { TUNING } from '../../src/game/config';
import { Game } from '../../src/game/game';
import type { ActivityStatus } from '../../src/input/commands';
import { emptyProfile, type Profile } from '../../src/app/profile';
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
    for (let i = 0; i < 60 && g.state === 'playing'; i++) g.step(1 / 60, [], STILL);
    expect(hudModel(g).center).toBe('Pakda gaya!');
    expect(hudModel(g).sub).toBe('You stopped jogging');
    // The caught screen holds for the whole catch duration, then the summary follows.
    const catchFrames = Math.round(TUNING.catchSeconds * TUNING.stepHz);
    for (let i = 0; i < catchFrames - 2; i++) g.step(1 / 60, [], STILL);
    expect(hudModel(g).center).toBe('Pakda gaya!');
    for (let i = 0; i < 3; i++) g.step(1 / 60, [], STILL);
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

  it('leaves the profile bits blank without a profile', () => {
    const m = hudModel(new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY }));
    expect(m.profile).toEqual({
      best: '',
      beatBest: false,
      menuBest: '',
      menuCoins: '',
      newBest: false,
      summaryBest: '',
      lifetime: { runs: '', coins: '', distance: '' },
    });
  });
});

describe('hudModel with a profile', () => {
  const profile = (over: Partial<Profile> = {}): Profile => ({
    ...emptyProfile(),
    bestScore: 1500,
    totalCoins: 12345,
    totalRuns: 12,
    totalDistance: 4321.9,
    ...over,
  });

  it('shows best score and lifetime coins on the menu', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    const m = hudModel(g, { profile: profile(), last: null });
    expect(m.profile.menuBest).toBe('Best score 1,500');
    expect(m.profile.menuCoins).toBe('12,345');
  });

  it('hides the menu pills before the first recorded run', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    const m = hudModel(g, { profile: emptyProfile(), last: null });
    expect(m.profile.menuBest).toBe('');
    expect(m.profile.menuCoins).toBe('');
    expect(m.profile.best).toBe('');
  });

  it('shows BEST under the score and flags it once the run beats it', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.state = 'playing';
    g.stats.score = 1500;
    const view = { profile: profile(), last: null };
    expect(hudModel(g, view).profile.best).toBe('BEST 1,500');
    expect(hudModel(g, view).profile.beatBest).toBe(false);
    g.stats.score = 1501;
    expect(hudModel(g, view).profile.beatBest).toBe(true);
  });

  it('celebrates a new best on the summary card', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.state = 'summary';
    g.stats.score = 2000;
    const m = hudModel(g, { profile: profile({ bestScore: 2000, totalRuns: 13 }), last: { newBest: true, previousBest: 1500 } });
    expect(m.profile.newBest).toBe(true);
    expect(m.profile.summaryBest).toBe('Previous best 1,500');
    expect(m.profile.lifetime).toEqual({ runs: '13', coins: '12,345', distance: '4.3 km' });
  });

  it('shows the standing best when the run fell short', () => {
    const g = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY });
    g.state = 'summary';
    g.stats.score = 20;
    const m = hudModel(g, { profile: profile(), last: { newBest: false, previousBest: 1500 } });
    expect(m.profile.newBest).toBe(false);
    expect(m.profile.summaryBest).toBe('Best: 1,500');
  });
});
