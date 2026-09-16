import type { Lane } from '../pose/types';
import { LANE_WIDTH, laneX, TUNING } from './config';

export interface JumpProfile {
  seconds: number;
  height: number;
}

export const NORMAL_JUMP: JumpProfile = { seconds: TUNING.jumpSeconds, height: TUNING.jumpHeight };
export const CHAPPAL_JUMP: JumpProfile = { seconds: TUNING.chappalJumpSeconds, height: TUNING.chappalJumpHeight };

/** Height above take-off t seconds into a jump (0 outside the jump). */
export function jumpHeightAt(t: number, p: JumpProfile): number {
  if (t <= 0 || t >= p.seconds) return 0;
  const u = t / p.seconds;
  return 4 * p.height * u * (1 - u);
}

const gravityOf = (p: JumpProfile) => (8 * p.height) / p.seconds ** 2;
const launchSpeedOf = (p: JumpProfile) => (4 * p.height) / p.seconds;
const clampLane = (n: number): Lane => (n < -1 ? -1 : n > 1 ? 1 : n) as Lane;
/** A runner this far from its lane centre is visibly changing lanes. */
const SETTLED_X = 0.3;

export class Runner {
  lane: Lane = 0;
  prevLane: Lane = 0;
  x = 0;
  /** Height of the feet above the ground. */
  y = 0;
  vy = 0;
  airborne = false;
  /** Rocket power-up: hovering at rocket height. */
  flying = false;
  rollLeft = 0;
  private gravity = gravityOf(NORMAL_JUMP);
  private rollOnLanding = false;

  get rolling(): boolean {
    return this.rollLeft > 0;
  }

  get height(): number {
    return this.rolling ? TUNING.rollHeight : TUNING.runnerHeight;
  }

  get changingLane(): boolean {
    return Math.abs(this.x - laneX(this.lane)) > SETTLED_X;
  }

  setLane(lane: Lane): boolean {
    if (lane === this.lane) return false;
    this.prevLane = this.lane;
    this.lane = lane;
    return true;
  }

  shiftLane(dir: -1 | 1): boolean {
    return this.setLane(clampLane(this.lane + dir));
  }

  /** Stumble: head back to the lane we came from. */
  bounceBack(): void {
    const back = this.prevLane;
    this.prevLane = this.lane;
    this.lane = back;
  }

  jump(profile: JumpProfile = NORMAL_JUMP): boolean {
    if (this.airborne || this.flying) return false;
    this.rollLeft = 0;
    this.rollOnLanding = false;
    this.airborne = true;
    this.vy = launchSpeedOf(profile);
    this.gravity = gravityOf(profile);
    return true;
  }

  roll(): boolean {
    if (this.flying) return false;
    if (this.airborne) {
      this.vy = Math.min(this.vy, -TUNING.slamSpeed);
      this.rollOnLanding = true;
      return true;
    }
    this.rollLeft = TUNING.rollSeconds;
    return true;
  }

  /** `surface` is the height of whatever is under the runner (0 = ground). */
  update(dt: number, surface: number): void {
    const target = laneX(this.lane);
    const step = (LANE_WIDTH / TUNING.laneChangeSeconds) * dt;
    this.x = Math.abs(target - this.x) <= step + 1e-9 ? target : this.x + Math.sign(target - this.x) * step;

    if (this.rollLeft > 0) this.rollLeft = Math.max(0, this.rollLeft - dt);

    if (this.flying) {
      const climb = TUNING.rocketClimbSpeed * dt;
      const gap = TUNING.rocketHeight - this.y;
      this.y = Math.abs(gap) <= climb ? TUNING.rocketHeight : this.y + Math.sign(gap) * climb;
      this.vy = 0;
      this.airborne = true;
      this.gravity = gravityOf(NORMAL_JUMP);
      return;
    }

    if (!this.airborne) {
      if (surface >= this.y - 0.05) {
        this.y = surface;
        return;
      }
      this.airborne = true;
      this.vy = 0;
      this.gravity = gravityOf(NORMAL_JUMP);
    }

    const next = this.y + this.vy * dt - 0.5 * this.gravity * dt * dt;
    this.vy -= this.gravity * dt;
    if (this.vy <= 0 && next <= surface + 1e-9) {
      this.y = surface;
      this.vy = 0;
      this.airborne = false;
      if (this.rollOnLanding) {
        this.rollOnLanding = false;
        this.rollLeft = TUNING.rollSeconds;
      }
    } else {
      this.y = next;
    }
  }
}
