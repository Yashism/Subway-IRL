import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import type { ObstacleKind } from '../../src/game/obstacles';
import { decodeFixture, type PoseFixture } from '../../src/pose/fixtures';
import { PoseDrive, type PoseDriveOptions } from '../helpers/poseDrive';
import { jogParams, jumpArc, ramp, STAND } from '../helpers/synth';

const T = STAND.torso;
const COUNTDOWN_MS = TUNING.countdownSeconds * 1000;

/**
 * Calibrate, raise the right hand to Start, jog through the countdown and 1 s of play.
 * Returns the rig mid-run, in state playing, with the clock at the end of the timeline.
 */
function playing(opts: PoseDriveOptions = {}): PoseDrive {
  const d = new PoseDrive(opts);
  d.calibrateAndStart().jog(COUNTDOWN_MS + 1000);
  d.run();
  expect(d.state).toBe('playing');
  return d;
}

/**
 * Puts `kind` in `lane` (default: the runner's), `leadMs` of running ahead of the moment the move
 * starts (the start of the next pose segment), then plays the move plus 1.5 s of jogging.
 */
function obstacleThenMove(d: PoseDrive, kind: ObstacleKind, leadMs: number, move: (d: PoseDrive) => void, lane = d.game.runner.lane) {
  d.place({ kind, lane, s: d.game.s + (d.game.speed * leadMs) / 1000 });
  move(d);
  d.jog(1500);
  d.run();
}

/** 500 ms of jogging with a real hip arc on top (a jump in the middle of jogging). */
function hipJump(d: PoseDrive) {
  const t0 = d.sc.t;
  d.posture(500, (t) => {
    const j = jogParams(t0 + t, { small: d.small });
    return { ...j, hipY: j.hipY - jumpArc(t, 500, 0.4) * T };
  });
}

/** Hip drop held (a squat) while the jog stops: 200 ms down, `holdMs` held, 200 ms up. */
function squat(d: PoseDrive, holdMs = 600) {
  const low = STAND.hipY + 0.45 * T;
  d.posture(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * ramp(t, 200) }))
    .stand(holdMs, { hipY: low })
    .posture(200, (t) => ({ hipY: low - 0.45 * T * ramp(t, 200) }));
}

describe('pose → game: start', () => {
  it('calibrates by standing, then a raised right hand starts the countdown and play', () => {
    const d = new PoseDrive();
    d.stand(2500).run();
    expect(d.ctrl.status.calibrated).toBe(true);
    expect(d.state).toBe('menu');
    expect(d.pose.activity(d.now).tracksJogging).toBe(true);

    d.stand(1600, { arms: 'right-up' }).run();
    expect(d.commandNames).toEqual(['start']);
    const counting = d.enteredAt('countdown');
    expect(counting).not.toBeNull();
    expect(counting!).toBeGreaterThanOrEqual(2500 + 1500);

    d.jog(COUNTDOWN_MS + 500).run();
    expect(d.states).toEqual(['countdown', 'playing']);
    const began = d.enteredAt('playing')!;
    expect(began - counting!).toBeCloseTo(COUNTDOWN_MS, -2);
    expect(d.game.s).toBeGreaterThan(0);
  });
});

describe('pose → game: moves', () => {
  it('a real jump in the middle of jogging clears a barrier', () => {
    // The jump command lands ~100 ms into the hip arc; a 350 ms lead puts the barrier ~0.25 s into
    // the 0.6 s game jump, at its highest. Control: without the jump the same barrier ends the run.
    const miss = playing();
    obstacleThenMove(miss, 'barrierLow', 350, (d) => d.jog(500));
    expect(miss.states).toContain('caught');
    expect(miss.game.caughtReason).toBe('crash');

    const d = playing();
    obstacleThenMove(d, 'barrierLow', 350, hipJump);
    expect(d.commandNames.filter((n) => n === 'jump')).toEqual(['jump']);
    expect(d.state).toBe('playing');
    expect(d.game.stats.jumps).toBe(1);
  });

  it('a held squat rolls under a banner', () => {
    const miss = playing();
    obstacleThenMove(miss, 'bannerHigh', 450, (d) => d.jog(1000));
    expect(miss.states).toContain('caught');

    const d = playing();
    obstacleThenMove(d, 'bannerHigh', 450, (x) => squat(x));
    expect(d.commandNames.filter((n) => n === 'roll')).toEqual(['roll']);
    expect(d.state).toBe('playing');
    expect(d.game.stats.rolls).toBe(1);
  });

  it('full body: stepping 0.8 T to the right sets lane 1 and dodges a parked train', () => {
    const step = (d: PoseDrive) =>
      d.jog(300, (t) => ({ hipX: STAND.hipX + 0.8 * T * ramp(t, 300) })).jog(1200, () => ({ hipX: STAND.hipX + 0.8 * T }));

    const miss = playing();
    obstacleThenMove(miss, 'trainParked', 900, (d) => d.jog(1500), 0);
    expect(miss.states).toContain('caught');

    const d = playing();
    expect(d.ctrl.status.mode).toBe('full');
    d.place({ kind: 'trainParked', lane: 0, s: d.game.s + d.game.speed * 0.9 });
    step(d);
    // Keep jogging in the new lane, past the whole 30 m train.
    d.jog(2500, () => ({ hipX: STAND.hipX + 0.8 * T })).run();
    expect(d.commandNames).toContain('setLane:1');
    expect(d.commandNames.filter((n) => n.startsWith('shiftLane'))).toEqual([]);
    expect(d.game.runner.lane).toBe(1);
    expect(d.state).toBe('playing');
    expect(d.game.stats.laneChanges).toBe(1);
  });

  it('small room: a lean shifts the lane', () => {
    const d = playing({ small: true });
    expect(d.ctrl.status.mode).toBe('small');
    const lean = (deg: number) => ({ tiltDeg: deg });
    d.jog(200, (t) => lean(-20 * ramp(t, 200)))
      .jog(400, () => lean(-20))
      .jog(200, (t) => lean(-20 * (1 - ramp(t, 200))))
      .jog(800)
      .run();
    expect(d.commandNames.filter((n) => n !== 'start')).toEqual(['shiftLane:-1']);
    expect(d.game.runner.lane).toBe(-1);
    expect(d.state).toBe('playing');
  });

  it('both hands up activates the hoverboard', () => {
    const d = playing();
    d.jog(600, () => ({}), { arms: 'both-up' }).jog(500).run();
    expect(d.commandNames.filter((n) => n !== 'start')).toEqual(['hoverboard']);
    expect(d.gameEvents.map(({ e }) => e.type)).toContain('hoverboard');
    expect(d.game.stats.hoverboardsUsed).toBe(1);
    expect(d.game.powerups.hoverboard).toBeGreaterThan(0);
  });
});

describe('pose → game: activity and tracking', () => {
  it('stopping jogging gets the runner caught (idle) after about 2 s', () => {
    const d = playing();
    const stopped = d.sc.t;
    d.stand(4000);
    expect(d.runUntil((x) => x.state === 'caught')).toBe(true);
    expect(d.game.caughtReason).toBe('idle');
    const caught = d.enteredAt('caught', stopped)!;
    // The last step lands a little before the jog stops, so the catch comes a little before 2 s.
    expect(caught - stopped).toBeGreaterThan(1500);
    expect(caught - stopped).toBeLessThanOrEqual(2100);
  });

  it('keeps playing while jogging', () => {
    const d = playing();
    d.jog(6000).run();
    expect(d.state).toBe('playing');
    expect(d.game.idleLevel).toBe('ok');
    expect(d.game.stats.steps).toBeGreaterThan(12);
  });

  it('leaving the frame pauses (never caught); coming back counts down and plays on', () => {
    const d = playing();
    const left = d.sc.t;
    d.posture(2000, () => null).run();
    expect(d.state).toBe('paused');
    expect(d.game.pausedByLoss).toBe(true);
    expect(d.states).not.toContain('caught');
    const paused = d.enteredAt('paused', left)!;
    expect(paused - left).toBeGreaterThanOrEqual(900);
    expect(paused - left).toBeLessThan(1500);

    const back = d.sc.t;
    d.jog(COUNTDOWN_MS + 2500).run();
    const counting = d.enteredAt('countdown', back)!;
    expect(counting - back).toBeLessThan(100);
    expect(d.enteredAt('playing', counting)! - counting).toBeCloseTo(COUNTDOWN_MS, -2);
    expect(d.state).toBe('playing');
    expect(d.states).not.toContain('caught');
  });

  it('a stalled stream (no frames for 2 s) pauses, and resumes when frames return', () => {
    const d = playing();
    const stalled = d.sc.frames.at(-1)!.t;
    d.gap(2000).run();
    expect(d.state).toBe('paused');
    expect(d.game.pausedByLoss).toBe(true);
    expect(d.states).not.toContain('caught');
    const paused = d.enteredAt('paused', stalled)!;
    expect(paused - stalled).toBeGreaterThan(1500);
    expect(paused - stalled).toBeLessThan(1600);

    const back = d.sc.t;
    d.jog(COUNTDOWN_MS + 1500).run();
    expect(d.enteredAt('countdown', back)).not.toBeNull();
    expect(d.state).toBe('playing');
    // The controller sends no found after a stall: resuming must not fake a move either.
    expect(d.commandNames).toEqual(['start']);
  });

  it('keeps counting steps across a recalibration', () => {
    const d = playing();
    d.jog(2000).run();
    const before = d.game.stats.steps;
    d.pose.recalibrate();
    d.run(d.now + 100);
    expect(d.game.stats.steps).toBeGreaterThanOrEqual(before);
  });
});

const load = (name: string) =>
  decodeFixture(JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as PoseFixture);

describe('pose → game: recorded fixtures', () => {
  /**
   * Enter on the keyboard at t = 0, then play the fixture once the countdown is over, so every
   * move lands in a live run. The fixtures stop jogging between moves, so god mode keeps the idle
   * rule out of the way.
   */
  function replay(name: string): PoseDrive {
    const d = new PoseDrive({ game: { god: true } });
    const offset = COUNTDOWN_MS + 200;
    d.sc.frames.push(...load(name).map((f) => ({ ...f, t: f.t + offset })));
    d.sc.t = d.sc.frames.at(-1)!.t + 1000 / 30;
    d.keyboard.keyDown({ code: 'Enter' }, 0);
    d.run(offset);
    expect(d.state).toBe('playing');
    d.run();
    return d;
  }

  it('synth-full gives lane, jump, roll and hoverboard commands', () => {
    const d = replay('synth-full');
    expect(d.commandNames).toEqual(['start', 'setLane:1', 'setLane:0', 'jump', 'roll', 'hoverboard']);
    expect(d.state).toBe('playing');
    expect(d.game.stats).toMatchObject({ laneChanges: 2, jumps: 1, rolls: 1, hoverboardsUsed: 1 });
  });

  it('synth-small gives a lane shift and a jump, and counts steps', () => {
    const d = replay('synth-small');
    expect(d.commandNames).toEqual(['start', 'shiftLane:-1', 'jump']);
    expect(d.state).toBe('playing');
    expect(d.game.stats).toMatchObject({ laneChanges: 1, jumps: 1 });
    expect(d.game.stats.steps).toBeGreaterThanOrEqual(9);
  });
});
