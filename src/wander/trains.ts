/**
 * The timetable for the local that passes the walker now and then: when it leaves, which track it
 * takes, where its front is. Pure — the scene only draws what this says.
 *
 * Trains only run while the walker is near the railway, so a long walk away from it costs nothing,
 * and a train always starts (and ends) out in the fog so it never pops into view.
 */
import { chunkRandom, TRACK_LANES, TRACK_X, type Box } from './city';

/** Seconds from entering the neighbourhood of the railway to the first train. */
export const FIRST_TRAIN_S = 7;
/** Seconds between trains, uniformly in [min, max]. */
export const GAP_S = [20, 38] as const;
/** The railway is "near" within this many metres east-west. */
export const NEAR_RANGE = 170;
/** A train starts and ends this far (along the track) from the walker. */
export const SPAWN_DISTANCE = 165;
export const END_DISTANCE = 175;
export const TRAIN_HALF_WIDTH = 1.3;

export interface TrainState {
  active: boolean;
  /** +1 runs towards +z (south), -1 towards -z. */
  dir: 1 | -1;
  /** World x of the track it is on. */
  x: number;
  /** World z of its front (the cab end). The body trails behind, away from `dir`. */
  frontZ: number;
  speed: number;
}

/** The front of a train has just drawn level with the walker. `dx` is how far to the side the track is. */
export interface TrainPass {
  dx: number;
}

export class TrainTimetable {
  readonly state: TrainState = { active: false, dir: 1, x: TRACK_LANES[2], frontZ: 0, speed: 0 };
  private readonly rand: () => number;
  private wait = FIRST_TRAIN_S;
  private departures = 0;

  constructor(
    seed: number,
    /** How long the train is, metres. */
    readonly length: number,
  ) {
    this.rand = chunkRandom(seed, 0x7a11);
  }

  /** The solid a train is while it runs: nothing else stands on its track. Null while there is no train. */
  solid(out: Box): Box | null {
    const s = this.state;
    if (!s.active) return null;
    out.x0 = s.x - TRAIN_HALF_WIDTH;
    out.x1 = s.x + TRAIN_HALF_WIDTH;
    out.z0 = s.dir > 0 ? s.frontZ - this.length : s.frontZ;
    out.z1 = s.dir > 0 ? s.frontZ : s.frontZ + this.length;
    return out;
  }

  /** Advances by `dt` with the walker at (px, pz). Returns a pass event the frame the front goes by. */
  update(dt: number, px: number, pz: number): TrainPass | null {
    const s = this.state;
    const near = Math.abs(px - TRACK_X) < NEAR_RANGE;
    if (!s.active) {
      // The clock only runs near the line; walking away resets it to a fresh wait.
      if (!near) {
        this.wait = Math.max(this.wait, FIRST_TRAIN_S * 0.5);
        return null;
      }
      this.wait -= dt;
      if (this.wait > 0) return null;
      this.depart(pz);
      return null;
    }
    const before = (s.frontZ - pz) * s.dir;
    s.frontZ += s.dir * s.speed * dt;
    const after = (s.frontZ - pz) * s.dir;
    // The rear is past the walker and out of sight: the run is over.
    const rear = s.dir > 0 ? s.frontZ - this.length : s.frontZ + this.length;
    if ((rear - pz) * s.dir > END_DISTANCE) {
      s.active = false;
      this.wait = GAP_S[0] + this.rand() * (GAP_S[1] - GAP_S[0]);
    }
    return before < 0 && after >= 0 ? { dx: s.x - px } : null;
  }

  private depart(pz: number): void {
    const s = this.state;
    // Alternate directions; the northbound uses the track beside the platform.
    s.dir = this.departures++ % 2 === 0 ? 1 : -1;
    s.x = s.dir > 0 ? TRACK_LANES[2] : TRACK_LANES[0];
    s.speed = 19 + this.rand() * 5;
    s.frontZ = pz - s.dir * SPAWN_DISTANCE;
    s.active = true;
  }
}

/** How loud a pass should sound, 0.15..1, by how far to the side the track is (for the audio cue). */
export function passCloseness(dx: number): number {
  return Math.max(0.15, 1 - Math.min(1, Math.abs(dx) / 40));
}
