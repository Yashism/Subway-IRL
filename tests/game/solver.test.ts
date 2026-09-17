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

  it('never rolls under a banner while riding up a ramp', () => {
    for (const bannerS of [33, 35, 36.5]) {
      const specs = [
        spec('ramp', 0, 30),
        spec('trainParked', 0, 38, 10),
        spec('trainParked', -1, 10, 50),
        spec('trainParked', 1, 10, 50),
        spec('bannerHigh', 0, bannerS),
      ];
      const actions = plan(toBlocks(specs, 20), 0, 60, { speed: 20, minGap: 1, startLane: 0 });
      if (actions) expect(replayPlan(specs, actions, 0, 20, 60), `banner at ${bannerS}`).toBeNull();
    }
  });

  it('respects the minimum gap between actions', () => {
    // Two barriers too far apart for one jump; the side lanes are walled, so both must be jumped.
    // At 30 m/s a jump lasts 18 m, so the second barrier must be at least ~33 m in for the first jump to land in time.
    const specs = [spec('barrierLow', 0, 20), spec('barrierLow', 0, 36), spec('trainParked', -1, 10), spec('trainParked', 1, 10)];
    expect(plan(toBlocks(specs, 30), 0, 60, { speed: 30, minGap: 0.8, startLane: 0 })).toBeNull();
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

  it('leaves the roof at the end of the train, so a later ramp can be boarded', () => {
    const specs = [
      spec('ramp', 0, 15),
      spec('trainParked', 0, 23, 22),
      spec('ramp', 0, 75),
      spec('trainParked', 0, 83, 22),
      spec('trainParked', -1, 20, 90),
      spec('trainParked', 1, 20, 90),
    ];
    const actions = plan(toBlocks(specs, 20), 0, 120, { speed: 20, minGap: 1, startLane: 0 });
    expect(actions).toEqual([]);
    expect(replayPlan(specs, actions!, 0, 20, 120)).toBeNull();
  });

  it('cannot act while dropping off the end of a roof', () => {
    // The roof ends at 45.4 and the fall from 3.2 m lasts ~0.49 s (~10 m at 20 m/s); side lanes stay walled.
    const walled = (barrierS: number) => [
      spec('ramp', 0, 15),
      spec('trainParked', 0, 23, 22),
      spec('trainParked', -1, 20, 45),
      spec('trainParked', 1, 20, 45),
      spec('barrierLow', 0, barrierS),
    ];
    // A barrier at 58 needs a jump started before the runner has landed.
    expect(plan(toBlocks(walled(58), 20), 0, 80, { speed: 20, minGap: 0.8, startLane: 0 })).toBeNull();
    const specs = walled(64);
    const actions = plan(toBlocks(specs, 20), 0, 80, { speed: 20, minGap: 0.8, startLane: 0 });
    expect(actions!.map((a) => a.type)).toEqual(['jump']);
    expect(actions![0].s).toBeGreaterThan(55);
    expect(replayPlan(specs, actions!, 0, 20, 80)).toBeNull();
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
