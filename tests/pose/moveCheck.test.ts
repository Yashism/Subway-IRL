import { describe, expect, it } from 'vitest';
import {
  ADVANCE_MS,
  JOG_STEPS_NEEDED,
  MoveCheck,
  NEAR_MISS_FRACTION,
  OFFER_SKIP_ATTEMPTS,
  OFFER_SKIP_MS,
  type MoveCheckSource,
} from '../../src/pose/moveCheck';
import type { MoveCheckModel, MoveId, MoveStepModel } from '../../src/pose/moveCheckTypes';
import { emptyMagnitudes } from '../../src/pose/moves';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../../src/pose/thresholds';
import { REARM_OF, TUNE_MIN_FACTOR, tunedValue } from '../../src/pose/tuning';
import type { MoveMagnitudes, PlayMode, PoseEvent } from '../../src/pose/types';

const FRAME_MS = 1000 / 30;

/** Drives a MoveCheck from hand-written magnitudes, standing in for the pose pipeline. */
class Rig implements MoveCheckSource {
  readonly th: Thresholds = { ...DEFAULT_THRESHOLDS };
  sensitivity = 1;
  readonly magnitudes: MoveMagnitudes = emptyMagnitudes();
  readonly check: MoveCheck;
  t = 0;

  constructor(mode: PlayMode) {
    this.check = new MoveCheck(mode);
    this.check.update(this, [], 0);
  }

  /** One frame: move the magnitudes, then deliver `events`. */
  frame(set: Partial<MoveMagnitudes> = {}, events: readonly PoseEvent[] = [], dtMs = FRAME_MS): MoveCheckModel {
    this.t += dtMs;
    Object.assign(this.magnitudes, set);
    return this.check.update(this, events, this.t);
  }

  /** Holds the magnitudes for `ms` with no events — how time passes with nothing happening. */
  wait(ms: number, set: Partial<MoveMagnitudes> = {}): MoveCheckModel {
    const end = this.t + ms;
    let model = this.check.model;
    while (this.t < end - 1e-9) model = this.frame(set, [], Math.min(FRAME_MS, end - this.t));
    return model;
  }

  get step(): MoveStepModel {
    return this.check.model.steps[this.check.model.index];
  }

  get id(): MoveId | null {
    return this.check.model.index < this.check.model.steps.length ? this.step.id : null;
  }

  stepFor(id: MoveId): MoveStepModel {
    return this.check.model.steps.find((s) => s.id === id)!;
  }

  /** Runs a magnitude up to `mag`, fires `events`, then lets the 600 ms hold elapse. */
  succeed(set: Partial<MoveMagnitudes>, events: readonly PoseEvent[]): void {
    this.frame(set, events);
    this.wait(ADVANCE_MS + FRAME_MS, set);
  }

  /** Waits until the step offers a way out, then takes it. Returns what the machine allowed. */
  skip(): boolean {
    this.wait(OFFER_SKIP_MS + 100);
    return this.check.skipStep();
  }

  accept(): boolean {
    this.wait(OFFER_SKIP_MS + 100);
    return this.check.acceptBest();
  }

  /** Four jog steps, with the knees or arms reaching `mag`. */
  passJog(mag: number): void {
    for (let i = 1; i <= JOG_STEPS_NEEDED; i++) {
      this.frame({ jogPrimary: mag, bobAmp: 0.06, jogSteps: i });
      this.frame({ jogPrimary: 0 });
    }
    this.wait(ADVANCE_MS + FRAME_MS);
  }
}

const LANE_L: PoseEvent = { type: 'lane', lane: -1 };
const LANE_R: PoseEvent = { type: 'lane', lane: 1 };
const SHIFT_L: PoseEvent = { type: 'laneShift', dir: -1 };
const SHIFT_R: PoseEvent = { type: 'laneShift', dir: 1 };
const JUMP: PoseEvent = { type: 'jump' };
const ROLL: PoseEvent = { type: 'roll' };
const HOVER: PoseEvent = { type: 'hoverboard' };

describe('MoveCheck — the step machine', () => {
  it('starts on the jog step with the instruction for the mode', () => {
    expect(new Rig('full').step).toMatchObject({ id: 'jog', status: 'active', how: expect.stringContaining('knees') });
    expect(new Rig('small').step.how).toContain('arms');
    expect(new Rig('full').check.model.steps.map((s) => s.id)).toEqual(['jog', 'left', 'right', 'jump', 'roll', 'hover']);
  });

  it('asks for four jog steps and counts them', () => {
    const r = new Rig('full');
    expect(r.step.steps).toEqual({ seen: 0, needed: JOG_STEPS_NEEDED });
    r.frame({ jogPrimary: 0.3, jogSteps: 1 });
    r.frame({ jogSteps: 2 });
    expect(r.step.steps).toEqual({ seen: 2, needed: JOG_STEPS_NEEDED });
    expect(r.step.status).toBe('active');
    r.frame({ jogSteps: 3 });
    r.frame({ jogSteps: 4 });
    expect(r.step.status).toBe('done');
    expect(r.step.steps).toEqual({ seen: 4, needed: JOG_STEPS_NEEDED });
  });

  it('holds the ✓ for ADVANCE_MS before moving on', () => {
    const r = new Rig('full');
    for (let i = 1; i <= JOG_STEPS_NEEDED; i++) r.frame({ jogPrimary: 0.3, jogSteps: i });
    expect(r.id).toBe('jog');
    r.wait(ADVANCE_MS - 100);
    expect(r.id).toBe('jog');
    r.wait(200);
    expect(r.id).toBe('left');
    expect(r.stepFor('jog').status).toBe('done');
    expect(r.stepFor('left').status).toBe('active');
  });

  it('walks the whole order and ends with a summary', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.succeed({ lane: -0.9 }, [LANE_L]);
    r.succeed({ lane: 0.9 }, [LANE_R]);
    r.succeed({ rise: 0.4 }, [JUMP]);
    r.succeed({ drop: 0.5 }, [ROLL]);
    expect(r.id).toBe('hover');
    r.succeed({}, [HOVER]);
    expect(r.check.finished).toBe(true);
    const summary = r.check.model.summary!;
    expect(summary.mode).toBe('full');
    expect(summary.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
  });

  it('ignores an event that belongs to another move', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.frame({ lane: 0.9 }, [LANE_R, JUMP, ROLL]);
    expect(r.step.status).toBe('active');
    expect(r.id).toBe('left');
  });

  it('records the peak in the detector’s own units, not the value at the moment it fired', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.frame({ lane: -0.55 }, [LANE_L]);
    r.frame({ lane: -0.82 });
    r.wait(ADVANCE_MS + FRAME_MS, { lane: -0.1 });
    expect(r.stepFor('left').peak).toBeCloseTo(0.82, 6);
  });
});

describe('MoveCheck — near misses and skipping', () => {
  it('says so when the peak reaches half of what is needed', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    const need = DEFAULT_THRESHOLDS.laneEnter;
    r.frame({ lane: -need * (NEAR_MISS_FRACTION - 0.1) });
    expect(r.step.hint).toBeNull();
    r.frame({ lane: -need * (NEAR_MISS_FRACTION + 0.1) });
    expect(r.step.hint).toBe('Almost — go a bit further');
    expect(r.step.progress).toBeCloseTo(NEAR_MISS_FRACTION + 0.1, 6);
  });

  it('counts one attempt per excursion and offers a skip after four', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    const need = DEFAULT_THRESHOLDS.laneEnter;
    for (let i = 0; i < OFFER_SKIP_ATTEMPTS; i++) {
      expect(r.step.canSkip).toBe(false);
      r.frame({ lane: -need * 0.8 });
      r.frame({ lane: 0 });
    }
    expect(r.step.canSkip).toBe(true);
    expect(r.step.canAccept).toBe(true);
  });

  it('offers a skip after ten seconds even with no attempt at all', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.wait(OFFER_SKIP_MS - 500);
    expect(r.step.canSkip).toBe(false);
    r.wait(1000);
    expect(r.step.canSkip).toBe(true);
  });

  it('never offers "use your best attempt" for jog or the hoverboard', () => {
    const r = new Rig('full');
    r.wait(OFFER_SKIP_MS + 100);
    expect(r.step).toMatchObject({ id: 'jog', canSkip: true, canAccept: false });
    expect(r.check.acceptBest(), 'the jog step has no easier setting to offer').toBe(false);
    r.check.skipStep();
    for (const id of ['left', 'right', 'jump', 'roll'] as const) {
      r.wait(OFFER_SKIP_MS + 100);
      expect(r.step, id).toMatchObject({ id, canSkip: true, canAccept: true });
      r.check.skipStep();
    }
    r.wait(OFFER_SKIP_MS + 100);
    expect(r.step).toMatchObject({ id: 'hover', canSkip: true, canAccept: false });
  });

  it('advances at once on skip, and tunes nothing for that move', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.frame({ lane: -0.9 });
    expect(r.check.skipStep(), 'a skip before it is offered is refused').toBe(false);
    expect(r.skip()).toBe(true);
    expect(r.id).toBe('right');
    expect(r.stepFor('left').status).toBe('skipped');
    r.check.skipAll();
    expect(r.check.finished).toBe(true);
    expect(r.check.model.summary!.tuned).not.toHaveProperty('laneEnter');
  });

  it('skipAll leaves the done steps tuned and the rest untouched', () => {
    const r = new Rig('full');
    r.passJog(0.5);
    r.check.skipAll();
    const summary = r.check.model.summary!;
    expect(summary.steps.map((s) => s.status)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(summary.tuned.kneeLift).toBeCloseTo(tunedValue('kneeLift', 0.5), 6);
    expect(summary.tuned).not.toHaveProperty('laneEnter');
  });

  it('acceptBest tunes from an attempt that never fired', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.frame({ lane: -0.4 });
    expect(r.check.acceptBest(), 'an easier setting before it is offered is refused').toBe(false);
    expect(r.accept()).toBe(true);
    r.frame({ lane: 0.4 });
    r.accept();
    r.check.skipAll();
    const tuned = r.check.model.summary!.tuned;
    expect(r.stepFor('left').status).toBe('skipped');
    // 0.55 * 0.4 is below the floor, so it lands on it: still easier than the 0.5 default.
    expect(tuned.laneEnter).toBeCloseTo(TUNE_MIN_FACTOR * DEFAULT_THRESHOLDS.laneEnter, 6);
    expect(tuned.laneExit! / tuned.laneEnter!).toBeCloseTo(
      DEFAULT_THRESHOLDS.laneExit / DEFAULT_THRESHOLDS.laneEnter,
      6,
    );
  });

  it('acceptBest with nothing measured lands on the easiest allowed setting', () => {
    const r = new Rig('full');
    r.skip();
    r.accept();
    r.check.skipAll();
    expect(r.check.model.summary!.tuned.laneEnter).toBeCloseTo(TUNE_MIN_FACTOR * DEFAULT_THRESHOLDS.laneEnter, 6);
  });

  it('redoing the check starts over', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.succeed({ lane: -0.9 }, [LANE_L]);
    r.check.reset();
    expect(r.check.finished).toBe(false);
    expect(r.check.model.index).toBe(0);
    expect(r.check.model.summary).toBeNull();
    expect(r.check.model.steps.every((s, i) => s.status === (i === 0 ? 'active' : 'todo'))).toBe(true);
    expect(r.stepFor('left').peak).toBeNull();
    r.wait(OFFER_SKIP_MS + 100);
    expect(r.step.canSkip).toBe(true);
  });
});

describe('MoveCheck — tuning', () => {
  it('tunes the full-body keys from the player’s own peaks', () => {
    const r = new Rig('full');
    r.passJog(0.4);
    r.succeed({ lane: -0.8 }, [LANE_L]);
    r.succeed({ lane: 0.8 }, [LANE_R]);
    r.succeed({ rise: 0.3 }, [JUMP]);
    r.succeed({ drop: 0.6 }, [ROLL]);
    r.succeed({}, [HOVER]);
    const tuned = r.check.model.summary!.tuned;
    expect(tuned.kneeLift).toBeCloseTo(tunedValue('kneeLift', 0.4), 6);
    expect(tuned.laneEnter).toBeCloseTo(tunedValue('laneEnter', 0.8), 6);
    expect(tuned.jumpRise).toBeCloseTo(tunedValue('jumpRise', 0.3), 6);
    expect(tuned.rollDrop).toBeCloseTo(tunedValue('rollDrop', 0.6), 6);
    expect(Object.keys(tuned).sort()).toEqual(
      ['jumpRearm', 'jumpRise', 'jumpVel', 'kneeLift', 'kneeRelease', 'laneEnter', 'laneExit', 'rollDrop'].sort(),
    );
  });

  it('averages the two sides into one symmetric lane threshold', () => {
    const r = new Rig('full');
    r.passJog(0.4);
    r.succeed({ lane: -0.6 }, [LANE_L]);
    r.succeed({ lane: 1.0 }, [LANE_R]);
    r.check.skipAll();
    const summary = r.check.model.summary!;
    expect(summary.tuned.laneEnter).toBeCloseTo(tunedValue('laneEnter', 0.8), 6);
    expect(summary.asymmetryNote).toBeNull();
  });

  it('flags a lopsided pair rather than favouring the stronger side', () => {
    const r = new Rig('full');
    r.passJog(0.4);
    r.succeed({ lane: -0.5 }, [LANE_L]);
    r.succeed({ lane: 1.0 }, [LANE_R]);
    r.check.skipAll();
    const summary = r.check.model.summary!;
    expect(summary.asymmetryNote).toMatch(/left/i);
    expect(summary.asymmetryNote).toMatch(/right/i);
    // Tuned to the weaker side, not the mean: the mean (0.75) would put the threshold at 0.41, above
    // the 0.5 step this player's left side actually managed — a left lane change they could never make.
    expect(summary.tuned.laneEnter).toBeCloseTo(tunedValue('laneEnter', 0.5), 6);
    expect(summary.tuned.laneEnter!).toBeLessThan(0.5);
    expect(summary.tuned.laneEnter!).toBeLessThan(DEFAULT_THRESHOLDS.laneEnter);
  });

  it('never leaves the weaker side a threshold it cannot reach', () => {
    for (const [l, r2] of [[0.5, 1.5], [1.5, 0.5], [0.6, 0.7], [0.55, 2.0]] as const) {
      const r = new Rig('full');
      r.passJog(0.4);
      r.succeed({ lane: -l }, [LANE_L]);
      r.succeed({ lane: r2 }, [LANE_R]);
      r.check.skipAll();
      const tuned = r.check.model.summary!.tuned.laneEnter!;
      expect(tuned, `left ${l} right ${r2}`).toBeLessThan(Math.min(l, r2));
    }
  });

  it('uses the one side it has when the other was skipped', () => {
    const r = new Rig('full');
    r.passJog(0.4);
    expect(r.skip()).toBe(true);
    r.succeed({ lane: 1.0 }, [LANE_R]);
    r.check.skipAll();
    expect(r.check.model.summary!.tuned.laneEnter).toBeCloseTo(tunedValue('laneEnter', 1.0), 6);
    expect(r.check.model.summary!.asymmetryNote).toBeNull();
  });

  it('tunes both small-room signals for the lanes and for the jog', () => {
    const r = new Rig('small');
    for (let i = 1; i <= JOG_STEPS_NEEDED; i++) {
      r.frame({ jogPrimary: 0.3, bobAmp: 0.05, jogSteps: i });
      r.frame({ jogPrimary: 0 });
    }
    r.wait(ADVANCE_MS + FRAME_MS);
    r.succeed({ tiltDeg: -24, noseShift: -0.5 }, [SHIFT_L]);
    r.succeed({ tiltDeg: 24, noseShift: 0.5 }, [SHIFT_R]);
    r.succeed({ rise: 0.2 }, [JUMP]);
    r.succeed({ headDrop: 0.5 }, [ROLL]);
    r.succeed({}, [HOVER]);
    const tuned = r.check.model.summary!.tuned;
    expect(tuned.wristPump).toBeCloseTo(tunedValue('wristPump', 0.3), 6);
    expect(tuned.bobMinAmp).toBeCloseTo(tunedValue('bobMinAmp', 0.05), 6);
    expect(tuned.leanDeg).toBeCloseTo(tunedValue('leanDeg', 24), 6);
    expect(tuned.noseShift).toBeCloseTo(tunedValue('noseShift', 0.5), 6);
    expect(tuned.smallJumpRise).toBeCloseTo(tunedValue('smallJumpRise', 0.2), 6);
    expect(tuned.duckDrop).toBeCloseTo(tunedValue('duckDrop', 0.5), 6);
    for (const [enter, rearm] of Object.entries(REARM_OF)) {
      const e = tuned[enter as keyof Thresholds];
      if (e === undefined) continue;
      expect(tuned[rearm as keyof Thresholds]! / e).toBeCloseTo(
        DEFAULT_THRESHOLDS[rearm as keyof Thresholds] / DEFAULT_THRESHOLDS[enter as keyof Thresholds],
        6,
      );
    }
  });

  it('the hoverboard tunes nothing', () => {
    const r = new Rig('full');
    for (let i = 0; i < 5; i++) expect(r.skip()).toBe(true);
    expect(r.id).toBe('hover');
    r.succeed({}, [HOVER]);
    expect(r.check.model.summary!.tuned).toEqual({});
    expect(r.stepFor('hover').status).toBe('done');
  });

  it('measures against the thresholds actually in force, sensitivity included', () => {
    const r = new Rig('full');
    r.sensitivity = 1.25;
    r.th.laneEnter = 0.4;
    r.passJog(0.4);
    // Needed is 0.4 / 1.25 = 0.32, so 0.17 is past the near-miss line a 0.5 default would miss.
    r.frame({ lane: -0.17 });
    expect(r.step.hint).toBe('Almost — go a bit further');
    expect(r.step.progress).toBeCloseTo(0.17 / 0.32, 6);
  });

  it('hands the flow a saveable record with the peaks behind every key', () => {
    const r = new Rig('small');
    expect(r.check.tuning(1234)).toBeNull();
    for (let i = 1; i <= JOG_STEPS_NEEDED; i++) r.frame({ jogPrimary: 0.3, bobAmp: 0.05, jogSteps: i });
    r.wait(ADVANCE_MS + FRAME_MS);
    r.succeed({ tiltDeg: -24, noseShift: -0.5 }, [SHIFT_L]);
    r.check.skipAll();
    const record = r.check.tuning(1234)!;
    expect(record.mode).toBe('small');
    expect(record.at).toBe(1234);
    expect(record.peaks.jog).toBeCloseTo(0.3, 6);
    expect(record.peaks.left).toBeCloseTo(24, 6);
    expect(record.keyPeaks?.bobMinAmp).toBeCloseTo(0.05, 6);
    expect(record.keyPeaks?.noseShift).toBeCloseTo(0.5, 6);
    // The record carries the measured keys only; the summary also shows the companions derived
    // from them, which a stored record must never be able to contradict.
    expect(Object.keys(record.thresholds).sort()).toEqual(['bobMinAmp', 'leanDeg', 'noseShift', 'wristPump']);
    for (const [key, value] of Object.entries(record.thresholds)) {
      expect(r.check.model.summary!.tuned[key as keyof Thresholds], key).toBeCloseTo(value, 10);
    }
  });
});

describe('MoveCheck — measuring only what the player did', () => {
  it('leaves the nose-shift threshold alone when the player leaned and their head stayed put', () => {
    const r = new Rig('small');
    for (let i = 1; i <= JOG_STEPS_NEEDED; i++) r.frame({ jogPrimary: 0.3, bobAmp: 0.05, jogSteps: i });
    r.wait(ADVANCE_MS + FRAME_MS);
    // The instruction says "lean your shoulders LEFT", so that is what they do. The detector fires
    // on the lean OR the nose, and the nose barely moved — there is no measurement of it to use.
    r.succeed({ tiltDeg: -24, noseShift: -0.02 }, [SHIFT_L]);
    r.succeed({ tiltDeg: 24, noseShift: 0.02 }, [SHIFT_R]);
    r.check.skipAll();
    const tuned = r.check.model.summary!.tuned;
    expect(tuned.leanDeg).toBeCloseTo(tunedValue('leanDeg', 24), 6);
    expect(tuned).not.toHaveProperty('noseShift');
    expect(tuned).not.toHaveProperty('noseRearm');
  });

  it('leaves bobMinAmp alone for a player who jogs with their arms and never bounces', () => {
    const r = new Rig('small');
    for (let i = 1; i <= JOG_STEPS_NEEDED; i++) r.frame({ jogPrimary: 0.3, bobAmp: 0, jogSteps: i });
    r.wait(ADVANCE_MS + FRAME_MS);
    r.check.skipAll();
    const tuned = r.check.model.summary!.tuned;
    expect(tuned.wristPump).toBeCloseTo(tunedValue('wristPump', 0.3), 6);
    expect(tuned).not.toHaveProperty('bobMinAmp');
  });

  it('leaves the hip drop alone when the roll was performed as a head duck', () => {
    const r = new Rig('full');
    r.passJog(0.4);
    r.skip();
    r.skip();
    r.skip();
    r.succeed({ drop: 0.04, headDrop: 0.6 }, [ROLL]);
    r.check.skipAll();
    expect(r.check.model.summary!.tuned).not.toHaveProperty('rollDrop');
  });

  it('still gives an easier setting when nothing at all cleared the line', () => {
    const r = new Rig('small');
    r.skip();
    r.frame({ tiltDeg: -2, noseShift: -0.01 });
    r.accept();
    r.check.skipAll();
    const tuned = r.check.model.summary!.tuned;
    // The primary signal — the one the instruction names — is tuned, and only that one.
    expect(tuned.leanDeg).toBeCloseTo(TUNE_MIN_FACTOR * DEFAULT_THRESHOLDS.leanDeg, 6);
    expect(tuned).not.toHaveProperty('noseShift');
  });
});

describe('MoveCheck — the jump\u2019s second gate', () => {
  it('counts the jogger\u2019s bounce into what the jump has to clear', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.skip();
    r.skip();
    expect(r.id).toBe('jump');
    // Jogging hard: moves.ts makes the jump clear bobJumpFactor x the bounce, or every step is a jump.
    const bob = 0.1;
    r.frame({ rise: DEFAULT_THRESHOLDS.jumpRise * 1.1, bobAmp: bob });
    expect(r.step.progress).toBeLessThan(1);
    expect(r.step.progress).toBeCloseTo((DEFAULT_THRESHOLDS.jumpRise * 1.1) / (DEFAULT_THRESHOLDS.bobJumpFactor * bob), 6);
  });

  it('tells a jumper who is high enough but too slow to hop quicker, not further', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.skip();
    r.skip();
    // Twice the height the threshold asks for, and the detector still has not fired: the only thing
    // left in the way is speed, and "go a bit further" is advice this player cannot act on.
    r.frame({ rise: DEFAULT_THRESHOLDS.jumpRise * 2 });
    expect(r.step.progress).toBe(1);
    expect(r.step.hint).toBe('Almost — try a quicker hop');
  });

  it('lowers the speed gate with the height, so an easier setting is actually easier', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.skip();
    r.skip();
    r.frame({ rise: 0.1 });
    r.accept();
    r.check.skipAll();
    const tuned = r.check.model.summary!.tuned;
    expect(tuned.jumpRise!).toBeLessThan(DEFAULT_THRESHOLDS.jumpRise);
    expect(tuned.jumpVel!).toBeLessThan(DEFAULT_THRESHOLDS.jumpVel);
  });
});

describe('MoveCheck — shape', () => {
  it('reuses the same model and step objects every frame', () => {
    const r = new Rig('full');
    const model = r.check.model;
    const steps = model.steps;
    const first = steps[0];
    const counter = first.steps;
    r.frame({ jogPrimary: 0.2, jogSteps: 1 });
    expect(r.check.model).toBe(model);
    expect(r.check.model.steps).toBe(steps);
    expect(r.check.model.steps[0]).toBe(first);
    expect(r.check.model.steps[0].steps).toBe(counter);
  });

  it('counts only the jog steps taken since the step began', () => {
    const r = new Rig('full');
    // A redo, or ?movecheck=force: the player has already been jogging, so the counter is well past 0.
    r.magnitudes.jogSteps = 37;
    r.check.reset();
    r.frame();
    expect(r.step.steps).toEqual({ seen: 0, needed: JOG_STEPS_NEEDED });
    for (let i = 1; i <= JOG_STEPS_NEEDED - 1; i++) {
      r.frame({ jogPrimary: 0.3, jogSteps: 37 + i });
      expect(r.step.steps, `after ${i}`).toEqual({ seen: i, needed: JOG_STEPS_NEEDED });
      expect(r.step.status).toBe('active');
    }
    r.frame({ jogSteps: 37 + JOG_STEPS_NEEDED });
    expect(r.step.status).toBe('done');
  });

  it('takes the event that lands on the very frame a step becomes active', () => {
    const r = new Rig('full');
    for (let i = 1; i <= JOG_STEPS_NEEDED; i++) r.frame({ jogPrimary: 0.3, jogSteps: i });
    r.wait(ADVANCE_MS - FRAME_MS);
    expect(r.id).toBe('jog');
    // The tick runs out on this frame and the left step takes over — with the event already in hand.
    // The hoverboard fires once per hold, so dropping it would cost a whole raise of both arms.
    r.frame({ lane: -0.9 }, [LANE_L], FRAME_MS * 2);
    expect(r.stepFor('left').status).toBe('done');
  });

  it('builds a hint string only when the hint actually changes', () => {
    const r = new Rig('full');
    r.passJog(0.3);
    r.frame({ lane: -0.4 });
    const hint = r.step.hint;
    expect(hint).toBe('Almost — go a bit further');
    for (let i = 0; i < 20; i++) r.frame({ lane: -0.4 });
    expect(r.step.hint).toBe(hint);
  });

  it('does not allocate its way through a long check', () => {
    const r = new Rig('full');
    const g = globalThis as { gc?: () => void };
    g.gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) r.frame({ lane: -0.2 + 0.4 * Math.sin(i / 7), rise: 0.05, jogPrimary: 0.1 });
    const grown = process.memoryUsage().heapUsed - before;
    // Generous bound: 4000 frames must not leave megabytes behind.
    expect(grown).toBeLessThan(4 * 1024 * 1024);
  });

  it('gives every step a label and an instruction, and a step counter only for the jog', () => {
    for (const mode of ['full', 'small'] as const) {
      for (const s of new Rig(mode).check.model.steps) {
        expect(s.label.length, `${mode} ${s.id}`).toBeGreaterThan(0);
        expect(s.how.length, `${mode} ${s.id}`).toBeGreaterThan(0);
        expect(s.steps === null, `${mode} ${s.id}`).toBe(s.id !== 'jog');
      }
    }
  });
});
