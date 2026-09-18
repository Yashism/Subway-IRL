import { describe, expect, it } from 'vitest';
import { SessionFlow, type FlowInput, type FlowOptions } from '../../src/app/flow';
import { MoveCheckSession } from '../../src/app/moveCheckSession';
import { TUNING } from '../../src/game/config';
import { PoseController } from '../../src/pose/controller';
import { MoveCheck } from '../../src/pose/moveCheck';
import { MOVE_TUNING_KEY, type MoveTuning } from '../../src/pose/moveCheckTypes';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../../src/pose/thresholds';
import { applyTuning, MoveTuningStore, type TuningStorage } from '../../src/pose/tuning';
import type { PlayMode } from '../../src/pose/types';
import { PoseDrive } from '../helpers/poseDrive';
import { jumpArc, ramp, Scenario, STAND, type SynthParams } from '../helpers/synth';

const T = STAND.torso;
const SMALL: Partial<SynthParams> = { lowerVisible: false };
const COUNTDOWN_MS = TUNING.countdownSeconds * 1000;
const STEP_MS = 60000 / 150;

/** A cautious full-body player: a modest knee lift, a half-torso step, a real jump and squat. */
function fullBodyTimeline(): Scenario {
  const sc = new Scenario(30).hold(2500);
  sc.add(3500, (t) => {
    const s = Math.sin((2 * Math.PI * t) / (2 * STEP_MS));
    return {
      hipY: STAND.hipY + 0.05 * T * Math.cos((2 * Math.PI * t) / STEP_MS),
      kneeLiftL: Math.max(0, s) * 0.22,
      kneeLiftR: Math.max(0, -s) * 0.22,
    };
  }).hold(900);
  for (const dir of [-1, 1] as const) {
    const at = (k: number) => ({ hipX: STAND.hipX + dir * 0.55 * T * k });
    sc.add(200, (t) => at(ramp(t, 200)))
      .hold(500, at(1))
      .add(200, (t) => at(1 - ramp(t, 200)))
      .hold(900);
  }
  sc.add(500, (t) => ({ hipY: STAND.hipY - jumpArc(t, 500, 0.4) * T })).hold(1000);
  const low = (k: number) => ({ hipY: STAND.hipY + 0.45 * T * k });
  sc.add(200, (t) => low(ramp(t, 200)))
    .hold(600, low(1))
    .add(200, (t) => low(1 - ramp(t, 200)))
    .hold(1000);
  return sc.hold(800, { arms: 'both-up' }).hold(800);
}

/** The same player in a small room: arms pumping, shoulders leaning, a hop and a head duck. */
function smallRoomTimeline(): Scenario {
  const sc = new Scenario(30).hold(2500, SMALL);
  sc.add(3500, (t) => ({
    ...SMALL,
    hipY: STAND.hipY + 0.045 * T * Math.cos((2 * Math.PI * t) / STEP_MS),
    arms: 'pump' as const,
    pump: 0.28 * Math.sin((2 * Math.PI * t) / (2 * STEP_MS)),
  })).hold(900, SMALL);
  for (const dir of [-1, 1] as const) {
    const at = (k: number) => ({ ...SMALL, tiltDeg: dir * 20 * k });
    sc.add(200, (t) => at(ramp(t, 200)))
      .hold(500, at(1))
      .add(200, (t) => at(1 - ramp(t, 200)))
      .hold(900, SMALL);
  }
  sc.add(400, (t) => ({ ...SMALL, hipY: STAND.hipY - jumpArc(t, 400, 0.25) * T })).hold(1000, SMALL);
  const down = (k: number) => ({ ...SMALL, noseDrop: 0.5 * k });
  sc.add(200, (t) => down(ramp(t, 200)))
    .hold(500, down(1))
    .add(200, (t) => down(1 - ramp(t, 200)))
    .hold(1000, SMALL);
  return sc.hold(800, { ...SMALL, arms: 'both-up' }).hold(800, SMALL);
}

/**
 * Runs a whole check the way the flow will: real pose frames through a real PoseController, whose
 * events and magnitude readout drive the MoveCheck. The check only starts once there is a baseline,
 * exactly as it does after calibration.
 */
function runCheck(mode: PlayMode): { check: MoveCheck; tuning: MoveTuning } {
  const ctrl = new PoseController({ forcedMode: mode });
  const check = new MoveCheck(mode);
  const frames = (mode === 'full' ? fullBodyTimeline() : smallRoomTimeline()).frames;
  for (const f of frames) {
    const events = ctrl.update(f);
    if (ctrl.baseline) check.update(ctrl, events, f.t);
  }
  const tuning = check.tuning(1_700_000_000_000);
  expect(tuning, `${mode} check did not finish`).not.toBeNull();
  return { check, tuning: tuning! };
}

function memStore(): TuningStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/**
 * A run of the real game: calibrate, start, jog, then one deliberately small sideways move —
 * under the shipped threshold, over a threshold tuned to a cautious player.
 */
function shallowLaneRun(thresholds: Partial<Thresholds> | undefined, small: boolean): string[] {
  const d = new PoseDrive({ small, pose: { thresholds } });
  d.calibrateAndStart().jog(COUNTDOWN_MS + 800);
  const at = small ? (k: number) => ({ tiltDeg: -12 * k }) : (k: number) => ({ hipX: STAND.hipX - 0.4 * T * k });
  d.posture(200, (t) => at(ramp(t, 200)))
    .posture(600, () => at(1))
    .jog(800);
  d.run();
  expect(d.state, 'the run should still be going').toBe('playing');
  return d.commandNames;
}

describe('move check → tuning → play', () => {
  it('walks a full-body player through every move and tunes to what they did', () => {
    const { check, tuning } = runCheck('full');
    const summary = check.model.summary!;
    expect(summary.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      'jog:done',
      'left:done',
      'right:done',
      'jump:done',
      'roll:done',
      'hover:done',
    ]);
    expect(summary.asymmetryNote).toBeNull();
    expect(Object.keys(summary.tuned).sort()).toEqual([
      'jumpRearm',
      'jumpRise',
      'jumpVel',
      'kneeLift',
      'kneeRelease',
      'laneEnter',
      'laneExit',
      'rollDrop',
    ]);
    // A half-torso step is what this player does, so a half-torso step is no longer what it takes.
    expect(summary.tuned.laneEnter!).toBeLessThan(DEFAULT_THRESHOLDS.laneEnter);
    expect(summary.tuned.rollDrop!).toBeLessThan(DEFAULT_THRESHOLDS.rollDrop);
    expect(tuning.peaks.left).toBeGreaterThan(DEFAULT_THRESHOLDS.laneEnter);
    expect(tuning.peaks.right).toBeGreaterThan(DEFAULT_THRESHOLDS.laneEnter);
    expect(tuning.keyPeaks?.laneEnter).toBeCloseTo(((tuning.peaks.left ?? 0) + (tuning.peaks.right ?? 0)) / 2, 6);
  });

  it('walks a small-room player through every move and tunes the lean it saw', () => {
    const { check, tuning } = runCheck('small');
    const summary = check.model.summary!;
    expect(summary.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      'jog:done',
      'left:done',
      'right:done',
      'jump:done',
      'roll:done',
      'hover:done',
    ]);
    expect(Object.keys(summary.tuned).sort()).toEqual([
      'bobMinAmp',
      'duckDrop',
      'leanDeg',
      'leanRearmDeg',
      'noseRearm',
      'noseShift',
      'smallJumpRearm',
      'smallJumpRise',
      'smallJumpVel',
      'wristPump',
    ]);
    expect(summary.tuned.leanDeg!).toBeLessThan(DEFAULT_THRESHOLDS.leanDeg);
    expect(tuning.peaks.left).toBeCloseTo(20, 0);
    expect(tuning.keyPeaks?.noseShift).toBeGreaterThan(0);
  });

  it('keeps each mode’s tuning apart in storage and hands back what was measured', () => {
    const storage = memStore();
    const store = new MoveTuningStore(storage);
    expect(store.empty).toBe(true);
    store.save(runCheck('full').tuning);
    store.save(runCheck('small').tuning);

    const reopened = new MoveTuningStore(storage);
    expect(reopened.empty).toBe(false);
    expect(reopened.get('full')!.thresholds.laneEnter).toBeCloseTo(
      new MoveTuningStore(storage).get('full')!.thresholds.laneEnter!,
      10,
    );
    expect(reopened.get('full')!.thresholds).not.toHaveProperty('leanDeg');
    expect(reopened.get('small')!.thresholds).not.toHaveProperty('laneEnter');
    expect(storage.data[MOVE_TUNING_KEY]).toContain('"full"');

    reopened.clear('full');
    expect(new MoveTuningStore(storage).get('full')).toBeNull();
    expect(new MoveTuningStore(storage).get('small')).not.toBeNull();
  });

  it.each([
    ['full', false, 'setLane:-1'],
    ['small', true, 'shiftLane:-1'],
  ] as const)('%s: the tuned thresholds are the ones in force on the next run', (mode, small, command) => {
    const stored = new MoveTuningStore(memStore());
    stored.save(runCheck(mode).tuning);
    const tuned = stored.get(mode)!.thresholds;

    // The same shallow move, played twice: it is only a lane change for the player who was measured.
    expect(shallowLaneRun(undefined, small)).not.toContain(command);
    expect(shallowLaneRun(tuned, small)).toContain(command);
  });

  it('a live thresholds object carries the tuning, and a reset puts the defaults back', () => {
    const { tuning } = runCheck('small');
    const th = { ...DEFAULT_THRESHOLDS };
    applyTuning(th, tuning);
    expect(th.leanDeg).toBe(tuning.thresholds.leanDeg);
    expect(th.leanRearmDeg! / th.leanDeg).toBeCloseTo(
      DEFAULT_THRESHOLDS.leanRearmDeg / DEFAULT_THRESHOLDS.leanDeg,
      10,
    );
    expect(th.laneEnter).toBe(DEFAULT_THRESHOLDS.laneEnter);
    applyTuning(th, null);
    expect(th).toEqual(DEFAULT_THRESHOLDS);
  });

  it('a re-run that skips a step keeps what that step was tuned to last time', () => {
    const storage = memStore();
    const store = new MoveTuningStore(storage);
    store.save(runCheck('full').tuning);
    const first = store.get('full')!.thresholds;
    expect(first.jumpRise).toBeDefined();

    // The player recalibrates because their lanes drifted, and skips the jump — a step they
    // deliberately did not touch must not quietly lose last time's tuning.
    const redo = new MoveCheck('full');
    redo.skipAll();
    new MoveTuningStore(storage).save(redo.tuning(2_000_000_000_000)!);

    const th = { ...DEFAULT_THRESHOLDS };
    applyTuning(th, new MoveTuningStore(storage).get('full'));
    expect(th.jumpRise).toBeCloseTo(first.jumpRise!, 10);
    expect(th.laneEnter).toBeCloseTo(first.laneEnter!, 10);
  });

  it('a skipped check leaves every threshold alone', () => {
    const check = new MoveCheck('full');
    check.skipAll();
    expect(check.model.summary!.tuned).toEqual({});
    const th = { ...DEFAULT_THRESHOLDS };
    applyTuning(th, check.tuning(1));
    expect(th).toEqual(DEFAULT_THRESHOLDS);
  });
});


/**
 * The wiring: real pose frames through a real PoseController, the flow deciding when the check
 * runs, the session saving what it measured onto the live thresholds, and a reload finding it.
 */
describe('move check: wired into the session flow', () => {
  const CALIBRATED: FlowInput = {
    type: 'pose',
    status: {
      tracking: true,
      calibrated: true,
      mode: 'full',
      startProgress: 0,
      calibration: { progress: 0, bodyVisible: true, distance: 'ok' },
      dark: false,
    },
  };

  /** A webcam flow on the calibration screen, plus the session its effects drive. */
  function wired(storage: TuningStorage, opts: Partial<FlowOptions> = {}) {
    const ctrl = new PoseController({ forcedMode: 'full' });
    const store = new MoveTuningStore(storage);
    const session = new MoveCheckSession({ thresholds: ctrl.th, store, now: () => 1_700_000_000_000 });
    const flow = new SessionFlow({ input: 'webcam', moveCheckSeen: session.seen, ...opts });
    const run = (i: FlowInput) => {
      for (const fx of flow.dispatch(i)) {
        if (fx.type === 'startMoveCheck') session.begin(ctrl.baseline?.mode ?? 'full');
        if (fx.type === 'endMoveCheck') session.end();
      }
    };
    flow.dispatch({ type: 'startPressed' });
    flow.dispatch({ type: 'startPressed' });
    flow.dispatch({ type: 'cameraOk' });
    return { ctrl, store, session, flow, run };
  }

  /** Plays the whole full-body timeline into the controller, feeding the check while it is up. */
  function play(w: ReturnType<typeof wired>): void {
    for (const f of fullBodyTimeline().frames) {
      const events = w.ctrl.update(f);
      if (w.ctrl.baseline) w.run(CALIBRATED);
      if (w.session.running) w.session.frame(w.ctrl, events, f.t);
    }
  }

  it('a first-ever calibration runs the check, and the very next run plays with what it measured', () => {
    const storage = memStore();
    const w = wired(storage);
    expect(w.flow.screen).toBe('calibrating');
    play(w);
    expect(w.flow.screen).toBe('moveCheck');
    expect(w.session.model!.summary, 'the check should have finished').not.toBeNull();

    const tuned = w.store.get('full')!.thresholds;
    expect(tuned.laneEnter).toBeLessThan(DEFAULT_THRESHOLDS.laneEnter);
    // Already in force on the live controller, before anyone presses start.
    expect(w.ctrl.th.laneEnter).toBeCloseTo(tuned.laneEnter!, 10);
    expect(shallowLaneRun(undefined, false)).not.toContain('setLane:-1');
    expect(shallowLaneRun({ ...w.ctrl.th }, false)).toContain('setLane:-1');

    w.run({ type: 'startPressed' });
    expect(w.flow.screen).toBe('playing');
    expect(w.session.running).toBe(false);
  });

  it('a returning player goes straight to ready, with the saved tuning already applied', () => {
    const storage = memStore();
    play(wired(storage));

    const back = wired(storage);
    back.session.applyFor('full');
    expect(back.flow.screen).toBe('calibrating');
    back.run(CALIBRATED);
    expect(back.flow.screen).toBe('ready');
    expect(back.session.running).toBe(false);
    expect(back.ctrl.th.laneEnter).toBeCloseTo(back.store.get('full')!.thresholds.laneEnter!, 10);

    // ...and the check is still one click away.
    expect(back.flow.model.showMoveCheck).toBe(true);
    back.run({ type: 'checkMoves' });
    expect(back.flow.screen).toBe('moveCheck');
    expect(back.session.running).toBe(true);
  });

  it('?movecheck=skip goes straight to ready even on a first run', () => {
    const w = wired(memStore(), { moveCheck: 'skip' });
    play(w);
    expect(w.flow.screen).toBe('ready');
    expect(w.session.running).toBe(false);
    expect(w.store.empty).toBe(true);
    expect(w.ctrl.th.laneEnter).toBe(DEFAULT_THRESHOLDS.laneEnter);
  });

  it('?movecheck=force runs it for a returning player too', () => {
    const storage = memStore();
    play(wired(storage));
    const forced = wired(storage, { moveCheck: 'force' });
    forced.run(CALIBRATED);
    expect(forced.flow.screen).toBe('moveCheck');
  });
});
