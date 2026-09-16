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
