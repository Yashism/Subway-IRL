import type { Baseline } from './calibration';
import type { Body } from './landmarks';
import { DropDetector, JumpDetector, VerticalRef } from './signals';
import type { Thresholds } from './thresholds';
import type { Lane, PoseEvent } from './types';

export interface MoveContext {
  body: Body;
  base: Baseline;
  t: number;
  sens: number;
  /** Current jog bob amplitude, in the same units as the mode's height signal. */
  bobAmp: number;
  jogging: boolean;
}

/** Lane zones with hysteresis: enter a side lane at |offset| >= enter, leave it below exit. */
export function nextLane(lane: Lane, offset: number, enter: number, exit: number): Lane {
  if (lane === 0) return offset <= -enter ? -1 : offset >= enter ? 1 : 0;
  if (lane === -1) return offset > -exit ? (offset >= enter ? 1 : 0) : -1;
  return offset < exit ? (offset <= -enter ? -1 : 0) : 1;
}

/** Full-body mode: standing position sets the lane; hips drive jump and roll. Units: torso lengths. */
export class FullBodyMoves {
  lane: Lane = 0;
  private jump = new JumpDetector();
  private roll = new DropDetector();
  private vref = new VerticalRef();

  constructor(private th: Thresholds) {}

  get idle(): boolean {
    return this.jump.isArmed && this.roll.isArmed && !this.roll.isDropping;
  }

  reset(): void {
    this.lane = 0;
    this.jump.reset();
    this.roll.reset();
    this.vref.reset();
  }

  update({ body, base, t, sens, bobAmp, jogging }: MoveContext): PoseEvent[] {
    const th = this.th;
    const T = base.torso;
    const events: PoseEvent[] = [];

    const lane = nextLane(this.lane, (body.hip.x - base.hip.x) / T, th.laneEnter / sens, th.laneExit / sens);
    if (lane !== this.lane) {
      this.lane = lane;
      events.push({ type: 'lane', lane });
    }

    const h = -body.hip.y / T;
    const ref = this.vref.value(h, t, -base.hip.y / T, jogging, !this.idle);
    const minRise = Math.max(th.jumpRise / sens, th.bobJumpFactor * bobAmp);
    if (this.jump.update(h, ref, t, th.jumpVel / sens, minRise, th.jumpRearm / sens)) events.push({ type: 'jump' });

    const refHipY = -ref * T;
    const noseRef = base.nose.y + (refHipY - base.hip.y);
    const drop = ref - h;
    const headDrop = (body.nose.y - noseRef) / T;
    const rolled = this.roll.update(drop, headDrop, t, {
      drop: th.rollDrop / sens,
      holdMs: th.rollHoldMs,
      headDrop: th.rollHeadDrop / sens,
      rearmDrop: th.rollDrop / 2 / sens,
      rearmHead: th.rollHeadDrop / 2 / sens,
    });
    if (rolled) events.push({ type: 'roll' });
    return events;
  }
}

/** Small-room mode: leaning works like a swipe; shoulders drive jump, the head drives roll. Units: shoulder widths. */
export class SmallRoomMoves {
  private leanArmed = true;
  private jump = new JumpDetector();
  private roll = new DropDetector();
  private vref = new VerticalRef();

  constructor(private th: Thresholds) {}

  /** Also requires the lean to be re-armed, so a held lean is never absorbed by baseline drift. */
  get idle(): boolean {
    return this.leanArmed && this.jump.isArmed && this.roll.isArmed;
  }

  reset(): void {
    this.leanArmed = true;
    this.jump.reset();
    this.roll.reset();
    this.vref.reset();
  }

  update({ body, base, t, sens, bobAmp, jogging }: MoveContext): PoseEvent[] {
    const th = this.th;
    const S = base.shoulderWidth;
    const events: PoseEvent[] = [];

    const noseShift = (body.nose.x - base.nose.x) / S;
    if (this.leanArmed) {
      const left = body.tiltDeg <= -th.leanDeg / sens || noseShift <= -th.noseShift / sens;
      const right = body.tiltDeg >= th.leanDeg / sens || noseShift >= th.noseShift / sens;
      if (left !== right) {
        this.leanArmed = false;
        events.push({ type: 'laneShift', dir: left ? -1 : 1 });
      }
    } else if (Math.abs(body.tiltDeg) < th.leanRearmDeg / sens && Math.abs(noseShift) < th.noseRearm / sens) {
      this.leanArmed = true;
    }

    const h = -body.shoulder.y / S;
    const ref = this.vref.value(h, t, -base.shoulder.y / S, jogging, !this.idle);
    const minRise = Math.max(th.smallJumpRise / sens, th.bobJumpFactor * bobAmp);
    if (this.jump.update(h, ref, t, th.smallJumpVel / sens, minRise, th.smallJumpRearm / sens)) events.push({ type: 'jump' });

    const noseRef = base.nose.y + (-ref * S - base.shoulder.y);
    const duck = (body.nose.y - noseRef) / S;
    const ducked = this.roll.update(0, duck, t, {
      drop: Infinity,
      holdMs: 0,
      headDrop: th.duckDrop / sens,
      rearmDrop: 1,
      rearmHead: th.duckDrop / 2 / sens,
    });
    if (ducked) events.push({ type: 'roll' });
    return events;
  }
}
