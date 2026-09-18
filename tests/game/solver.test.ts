import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { clearTop, OBSTACLES, type ObstacleSpec } from '../../src/game/obstacles';
import { NORMAL_JUMP } from '../../src/game/runner';
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

  it('jumps a row of resting cows, and the real runner clears it — even at the starting speed', () => {
    const speed = TUNING.startSpeed;
    const specs = [spec('cowSitting', -1, 30), spec('cowSitting', 0, 30), spec('cowSitting', 1, 30)];
    const actions = plan(toBlocks(specs, speed), 0, 60, { speed, minGap: 1, startLane: 0 });
    expect(actions!.map((a) => a.type)).toEqual(['jump']);
    expect(replayPlan(specs, actions!, 0, speed, 60)).toBeNull();
  });

  it('still cannot jump a row of standing cows: those you go round', () => {
    const specs = [spec('cow', -1, 30), spec('cow', 0, 30), spec('cow', 1, 30)];
    expect(plan(toBlocks(specs, 20), 0, 60, { speed: 20, minGap: 1, startLane: 0 })).toBeNull();
  });

  it('clears a handcart at the starting speed (the old jump could not, at any timing)', () => {
    const speed = TUNING.startSpeed;
    const specs = [spec('handcart', -1, 30), spec('handcart', 0, 30), spec('handcart', 1, 30)];
    const actions = plan(toBlocks(specs, speed), 0, 60, { speed, minGap: 1, startLane: 0 });
    expect(actions).not.toBeNull();
    expect(replayPlan(specs, actions!, 0, speed, 60)).toBeNull();
  });

  it('respects the minimum gap between actions', () => {
    // Two barriers in one lane, the side lanes walled, so both must be jumped. Space them too far
    // apart for one jump to clear both, yet too close for two jumps a legal `minGap` apart. The
    // spacing is derived from the jump itself, so a change to the jump tuning cannot quietly turn
    // this into a passable track (it did once: a longer jump made a hand-picked 16 m passable).
    const speed = 30;
    const minGap = 0.8;
    const pad = TUNING.runnerHalfDepth;
    const L = OBSTACLES.barrierLow.length;
    const b1 = 20;
    // Where, after take-off, the feet are above the barrier's clear-top: [enter, leave] metres.
    const span = speed * NORMAL_JUMP.seconds;
    const above = Math.sqrt(1 - clearTop(OBSTACLES.barrierLow) / NORMAL_JUMP.height);
    const enter = (span * (1 - above)) / 2;
    const leave = (span * (1 + above)) / 2;
    // Take-offs that clear a barrier at x: [x + L + pad - leave, x - pad - enter].
    const earliest = (x: number) => x + L + pad - leave;
    const latest = (x: number) => x - pad - enter;
    // One jump clears both while b2's earliest take-off is no later than b1's latest. Two jumps need
    // b2's latest take-off to follow b1's earliest by the gap between them — and a second jump cannot
    // start before the first has landed, so that gap is never less than one jump's length.
    const oneJumpUpTo = latest(b1) + leave - L - pad;
    const twoJumpsFrom = (gap: number) => earliest(b1) + Math.max(span, gap * speed) + pad + enter;
    // Too far for one jump, and far enough that landing is no obstacle, but inside the gap rule:
    const lo = Math.max(oneJumpUpTo, twoJumpsFrom(0));
    const hi = twoJumpsFrom(minGap);
    expect(hi - lo).toBeGreaterThan(1); // such a spacing exists, with room either side
    const b2 = (lo + hi) / 2;

    const specs = [spec('barrierLow', 0, b1), spec('barrierLow', 0, b2), spec('trainParked', -1, 10), spec('trainParked', 1, 10)];
    expect(plan(toBlocks(specs, speed), 0, 60, { speed, minGap, startLane: 0 })).toBeNull();
    // Only the gap rule stands in the way: allow closer actions and it is passable.
    expect(unpassableFrom(specs, 0, 60, speed, 0.1)).toBeNull();
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
