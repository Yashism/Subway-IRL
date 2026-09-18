import { describe, expect, it } from 'vitest';
import { toBody } from '../../src/pose/landmarks';
import { symmetricZones } from '../../src/pose/laneSpots';
import { FullBodyMoves, nextLane, SmallRoomMoves, type MoveContext } from '../../src/pose/moves';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { Baseline } from '../../src/pose/calibration';
import type { PoseEvent } from '../../src/pose/types';
import { baselineFor } from '../helpers/baseline';
import { ASPECT, jumpArc, STAND, synthPose, type SynthParams } from '../helpers/synth';

const T = STAND.torso;

function drive(
  m: { update(c: MoveContext): PoseEvent[] },
  base: Baseline,
  ms: number,
  fn: (t: number) => Partial<SynthParams>,
  sens = 1,
) {
  const out: PoseEvent[] = [];
  for (let t = 0; t < ms; t += 1000 / 30) {
    out.push(...m.update({ body: toBody(synthPose(fn(t)), ASPECT), base, t, sens, bobAmp: 0, jogging: false }));
  }
  return out;
}

describe('nextLane', () => {
  it.each([
    [0, 0.6, 1],
    [0, -0.6, -1],
    [0, 0.4, 0],
    [1, 0.4, 1],
    [1, 0.3, 0],
    [1, -0.6, -1],
    [-1, -0.4, -1],
    [-1, 0.1, 0],
    [-1, 0.7, 1],
  ] as const)('lane %i at offset %f → %i', (lane, offset, expected) => {
    expect(nextLane(lane, offset, symmetricZones(0.5, 0.35))).toBe(expected);
  });
});

describe('FullBodyMoves', () => {
  it('changes lane when the player steps sideways', () => {
    const m = new FullBodyMoves(DEFAULT_THRESHOLDS);
    const ev = drive(m, baselineFor(), 600, (t) => ({ hipX: STAND.hipX + (t < 300 ? 0 : 0.8 * T) }));
    expect(ev).toEqual([{ type: 'lane', lane: 1 }]);
    expect(m.lane).toBe(1);
  });

  it('uses sensitivity to scale the step size', () => {
    const step = (t: number) => ({ hipX: STAND.hipX + (t < 300 ? 0 : 0.45 * T) });
    expect(drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 600, step, 1)).toEqual([]);
    expect(drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 600, step, 1.25)).toEqual([{ type: 'lane', lane: 1 }]);
  });

  it('detects a jump once', () => {
    const ev = drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 1500, (t) => ({
      hipY: STAND.hipY - jumpArc(t - 300, 500, 0.35) * T,
    }));
    expect(ev).toEqual([{ type: 'jump' }]);
  });

  it('detects a held squat once', () => {
    const ev = drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 1500, (t) => ({
      hipY: STAND.hipY + (t > 300 ? 0.45 * T : 0),
    }));
    expect(ev).toEqual([{ type: 'roll' }]);
  });

  it('scales the jump re-arm height with sensitivity', () => {
    // After the first jump peaks, the body settles at 0.07 T above rest: that re-arms at sens 1 (0.07 < 0.08)
    // but not at sens 1.25 (0.07 >= 0.064), so only sens 1 fires the second jump.
    const height = (t: number) => {
      if (t < 300) return 0;
      if (t < 550) return jumpArc(t - 300, 500, 0.35);
      if (t < 1500) return Math.max(jumpArc(t - 300, 500, 0.35), 0.07);
      return 0.07 + jumpArc(t - 1500, 500, 0.35);
    };
    const scene = (t: number) => ({ hipY: STAND.hipY - height(t) * T });
    expect(drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 2500, scene, 1)).toEqual([{ type: 'jump' }, { type: 'jump' }]);
    expect(drive(new FullBodyMoves(DEFAULT_THRESHOLDS), baselineFor(), 2500, scene, 1.25)).toEqual([{ type: 'jump' }]);
  });
});

describe('SmallRoomMoves', () => {
  it('shifts lane once per lean and re-arms when upright', () => {
    const base = baselineFor({ lowerVisible: false });
    const ev = drive(new SmallRoomMoves(DEFAULT_THRESHOLDS), base, 3000, (t) => ({
      lowerVisible: false,
      tiltDeg: t < 300 ? 0 : t < 1200 ? -20 : t < 2000 ? 0 : 20,
    }));
    expect(ev).toEqual([
      { type: 'laneShift', dir: -1 },
      { type: 'laneShift', dir: 1 },
    ]);
  });

  it('detects a shoulder hop and a duck', () => {
    const base = baselineFor({ lowerVisible: false });
    const ev = drive(new SmallRoomMoves(DEFAULT_THRESHOLDS), base, 3000, (t) => ({
      lowerVisible: false,
      hipY: STAND.hipY - jumpArc(t - 300, 400, 0.25) * T,
      noseDrop: t > 2000 ? 0.5 : 0,
    }));
    expect(ev).toEqual([{ type: 'jump' }, { type: 'roll' }]);
  });
});
