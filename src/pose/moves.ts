import type { Baseline } from './calibration';
import { spotZones, symmetricZones, type LaneSpots, type LaneZones } from './laneSpots';
import type { Body } from './landmarks';
import { DropDetector, JumpDetector, VerticalRef } from './signals';
import type { Thresholds } from './thresholds';
import type { Lane, MoveMagnitudes, PoseEvent } from './types';

export const emptyMagnitudes = (): MoveMagnitudes => ({
  lane: 0,
  tiltDeg: 0,
  noseShift: 0,
  rise: 0,
  drop: 0,
  headDrop: 0,
  jogPrimary: 0,
  bobAmp: 0,
  bobGated: 0,
  jogSteps: 0,
});

/** Clears the live readouts (nobody in view). `jogSteps` is a running count, so it is left alone. */
export function clearMagnitudes(m: MoveMagnitudes): void {
  m.lane = 0;
  m.tiltDeg = 0;
  m.noseShift = 0;
  m.rise = 0;
  m.drop = 0;
  m.headDrop = 0;
  m.jogPrimary = 0;
  m.bobAmp = 0;
  m.bobGated = 0;
}

export interface MoveContext {
  body: Body;
  base: Baseline;
  t: number;
  sens: number;
  /** Current jog bob amplitude, in the same units as the mode's height signal. */
  bobAmp: number;
  jogging: boolean;
}

/**
 * Lane zones with hysteresis: a side lane is entered at or beyond its enter point and left once the
 * hips come back past its exit point. A move straight across (left to right) goes directly. The
 * automatic lanes are the symmetric case (`symmetricZones(enter, exit)`); lane spots are not.
 */
export function nextLane(lane: Lane, offset: number, z: Readonly<LaneZones>): Lane {
  if (lane === 0) return offset <= z.enterL ? -1 : offset >= z.enterR ? 1 : 0;
  if (lane === -1) return offset > z.exitL ? (offset >= z.enterR ? 1 : 0) : -1;
  return offset < z.exitR ? (offset <= z.enterL ? -1 : 0) : 1;
}

/** Full-body mode: standing position sets the lane; hips drive jump and roll. Units: torso lengths. */
export class FullBodyMoves {
  lane: Lane = 0;
  /**
   * The player's own lane spots, or null for the automatic lanes. While set, they — not
   * `laneEnter`/`laneExit` — decide the lane. Validated by the controller before it lands here.
   */
  spots: LaneSpots | null = null;
  /** Reused every frame, so deciding the lane allocates nothing. */
  private readonly zones: LaneZones = symmetricZones(0, 0);
  private jump = new JumpDetector();
  private roll = new DropDetector();
  private vref = new VerticalRef();

  /** Live magnitude readout; shared with the controller when one is passed in. */
  constructor(private th: Thresholds, readonly mag: MoveMagnitudes = emptyMagnitudes()) {}

  get idle(): boolean {
    return this.jump.isArmed && this.roll.isArmed && !this.roll.isDropping;
  }

  /** Hips are dropped: a squat is building, or the player has not stood back up since a roll. */
  get isDown(): boolean {
    return !this.roll.isArmed || this.roll.isDropping;
  }

  reset(): void {
    this.lane = 0;
    this.jump.reset();
    this.roll.reset();
    this.vref.reset();
  }

  /**
   * After a tracking gap: drop stale in-flight state but keep the lane. Jump and roll start
   * disarmed, so a player who comes back already crouched must stand up before they can roll.
   */
  resetTransient(): void {
    this.jump.reset(false);
    this.roll.reset(false);
    this.vref.reset();
  }

  update({ body, base, t, sens, bobAmp, jogging }: MoveContext): PoseEvent[] {
    const th = this.th;
    const T = base.torso;
    const events: PoseEvent[] = [];

    const offset = (body.hip.x - base.hip.x) / T;
    this.mag.lane = offset;
    const zones = this.spots ? spotZones(this.spots, sens, this.zones) : symmetricZones(th.laneEnter / sens, th.laneExit / sens, this.zones);
    const lane = nextLane(this.lane, offset, zones);
    if (lane !== this.lane) {
      this.lane = lane;
      events.push({ type: 'lane', lane });
    }

    const h = -body.hip.y / T;
    const ref = this.vref.value(h, t, -base.hip.y / T, jogging, !this.idle);
    const minRise = Math.max(th.jumpRise / sens, th.bobJumpFactor * bobAmp);
    this.mag.rise = h - ref;
    if (this.jump.update(h, ref, t, th.jumpVel / sens, minRise, th.jumpRearm / sens)) events.push({ type: 'jump' });

    const refHipY = -ref * T;
    const noseRef = base.nose.y + (refHipY - base.hip.y);
    const drop = ref - h;
    const headDrop = (body.nose.y - noseRef) / T;
    this.mag.drop = drop;
    this.mag.headDrop = headDrop;
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

  /** Live magnitude readout; shared with the controller when one is passed in. */
  constructor(private th: Thresholds, readonly mag: MoveMagnitudes = emptyMagnitudes()) {}

  /** Also requires the lean to be re-armed, so a held lean is never absorbed by baseline drift. */
  get idle(): boolean {
    return this.leanArmed && this.jump.isArmed && this.roll.isArmed;
  }

  /** The player is back upright after the last lean; until then the x reference must hold still. */
  get leanReady(): boolean {
    return this.leanArmed;
  }

  /** The head is still down after a duck. */
  get isDown(): boolean {
    return !this.roll.isArmed;
  }

  reset(): void {
    this.leanArmed = true;
    this.jump.reset();
    this.roll.reset();
    this.vref.reset();
  }

  /**
   * After a tracking gap: every move must return to rest before it can fire again. The controller
   * re-bases x to where the player came back, so the lean re-arms once they are upright.
   */
  resetTransient(): void {
    this.leanArmed = false;
    this.jump.reset(false);
    this.roll.reset(false);
    this.vref.reset();
  }

  update({ body, base, t, sens, bobAmp, jogging }: MoveContext): PoseEvent[] {
    const th = this.th;
    const S = base.shoulderWidth;
    const events: PoseEvent[] = [];

    const noseShift = (body.nose.x - base.nose.x) / S;
    this.mag.tiltDeg = body.tiltDeg;
    this.mag.noseShift = noseShift;
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
    this.mag.rise = h - ref;
    if (this.jump.update(h, ref, t, th.smallJumpVel / sens, minRise, th.smallJumpRearm / sens)) events.push({ type: 'jump' });

    const noseRef = base.nose.y + (-ref * S - base.shoulder.y);
    const duck = (body.nose.y - noseRef) / S;
    this.mag.headDrop = duck;
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
