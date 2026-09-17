import { describe, expect, it } from 'vitest';
import { CHUNKS } from '../../src/game/chunks';
import { LANE_WIDTH } from '../../src/game/config';
import {
  airborneProgress,
  damp,
  laneLean,
  obstacleKey,
  obstacleVariant,
  OBSTACLE_VARIANTS,
  runnerAction,
  trainLengths,
  trainLook,
  type RunnerLook,
} from '../../src/world/viewState';

const base: RunnerLook = { state: 'playing', flying: false, airborne: false, rolling: false, hoverboard: false, stumbling: false };
const look = (o: Partial<RunnerLook>): RunnerLook => ({ ...base, ...o });

describe('runnerAction', () => {
  it('maps game states', () => {
    expect(runnerAction(look({ state: 'menu' }))).toBe('idle');
    expect(runnerAction(look({ state: 'countdown' }))).toBe('idle');
    expect(runnerAction(look({ state: 'caught' }))).toBe('caught');
    expect(runnerAction(look({ state: 'summary', flying: true }))).toBe('caught');
    expect(runnerAction(look({}))).toBe('run');
    expect(runnerAction(look({ state: 'paused' }))).toBe('run');
  });

  it('maps runner states with the right priority', () => {
    expect(runnerAction(look({ flying: true, airborne: true }))).toBe('fly');
    expect(runnerAction(look({ airborne: true, hoverboard: true }))).toBe('jump');
    expect(runnerAction(look({ rolling: true, hoverboard: true }))).toBe('roll');
    expect(runnerAction(look({ stumbling: true, hoverboard: true }))).toBe('stumble');
    expect(runnerAction(look({ hoverboard: true }))).toBe('hover');
  });
});

describe('airborneProgress', () => {
  it('runs 0 -> 0.5 -> 1 over a ballistic arc and clamps', () => {
    expect(airborneProgress(8, 8)).toBe(0);
    expect(airborneProgress(0, 8)).toBe(0.5);
    expect(airborneProgress(-8, 8)).toBe(1);
    expect(airborneProgress(-25, 8)).toBe(1);
    expect(airborneProgress(20, 8)).toBe(0);
    expect(airborneProgress(1, 0)).toBe(0.5);
  });
});

describe('laneLean', () => {
  it('points toward the target lane and settles to 0', () => {
    expect(laneLean(0, 1)).toBe(1);
    expect(laneLean(0, -1)).toBe(-1);
    expect(laneLean(LANE_WIDTH, 1)).toBe(0);
    expect(laneLean(LANE_WIDTH * 0.75, 1)).toBeCloseTo(0.5);
  });
});

describe('obstacle variants', () => {
  it('are stable, in range and keyed by length for trains only', () => {
    for (const id of [0, 1, 7, 8, 123, -3]) {
      const v = obstacleVariant('trainParked', id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(OBSTACLE_VARIANTS.trainParked);
      expect(obstacleVariant('trainParked', id)).toBe(v);
    }
    expect(obstacleKey('trainParked', 3, 22)).not.toBe(obstacleKey('trainParked', 3, 30));
    expect(obstacleKey('cow', 1, 2.5)).toBe('cow|1');
  });

  it('covers both liveries and every graffiti set', () => {
    const looks = Array.from({ length: OBSTACLE_VARIANTS.trainParked }, (_, v) => trainLook(v));
    expect(new Set(looks.map((l) => `${l.livery}|${l.seed % 4}`)).size).toBe(8);
  });

  it('finds every train length the chunks use', () => {
    const lengths = trainLengths(CHUNKS);
    expect(lengths.trainParked).toEqual(expect.arrayContaining([10, 22, 30]));
    expect(lengths.trainMoving).toContain(30);
  });
});

describe('damp', () => {
  it('is 0 for no time and approaches 1', () => {
    expect(damp(8, 0)).toBe(0);
    expect(damp(8, 1 / 60)).toBeCloseTo(1 - Math.exp(-8 / 60));
    expect(damp(8, 10)).toBeCloseTo(1);
  });
});
