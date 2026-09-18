/**
 * The lane-spots setup: the player stands on their centre, left and right spots in turn, and each
 * is taken once they hold still there for a second — the same interaction as calibration.
 * Spec: docs/superpowers/specs/2026-09-18-lane-spots.md ("The setup").
 *
 * Framework-free and deterministic: no DOM, no timers (time arrives as `tMs`), no allocation in
 * `update`. The model is the same object every frame — the UI renders it, the app calls `redo`,
 * and neither owns any of this state. Nothing here saves anything: the result is only a proposal
 * until the player presses Save, so every other way out leaves the saved spots as they were.
 */
import { MAX_SPOT, MIN_SPOT_GAP, type LaneSpots } from './laneSpots';

export type SpotId = 'centre' | 'left' | 'right';

/** Centre first: the side spots are judged against it. */
export const SPOT_ORDER: readonly SpotId[] = ['centre', 'left', 'right'];

/** How long the player holds still on a spot before it is taken. */
export const SPOT_HOLD_MS = 1000;
/** "Still" means the hips stay within this band of where the hold began, in torso lengths. */
export const SPOT_STEADY = 0.1;
/** A player standing still somewhere that cannot be taken is told why after this long. */
export const SPOT_HINT_MS = 400;
/** How long the ✓ stays up before the next spot is asked for. */
export const SPOT_ADVANCE_MS = 600;

/** Why the current position cannot be taken. */
export type SpotBlock =
  /** A side spot on the centre spot's other side. */
  | 'wrongSide'
  /** A side spot nearer the centre spot than `MIN_SPOT_GAP`. */
  | 'tooClose'
  /** Further from the calibrated centre than any real room allows (`MAX_SPOT`). */
  | 'tooFar';

export interface LaneSetupModel {
  /** The spot being asked for; null once all three are taken. */
  step: SpotId | null;
  /** 0-based position in `SPOT_ORDER`; 3 when finished. */
  index: number;
  /** Short name for the step dots, e.g. "Left". */
  label: string;
  /** The instruction, e.g. "Step to where you want the left lane". */
  how: string;
  /** Spots taken so far, in torso lengths from the calibrated centre. */
  spots: { centre: number | null; left: number | null; right: number | null };
  /** Where the player's hips are now, same units; null when nobody is in view. */
  live: number | null;
  /** Progress of the hold on the current spot, 0..1. */
  hold: number;
  /** Why the current position cannot be taken, once the player has stood there a moment. */
  blocked: SpotBlock | null;
  /** The nudge under the instruction, or null. */
  hint: string | null;
  /** The current step's spot was just taken; its ✓ is showing. */
  taken: boolean;
  /** All three spots, once taken; the summary's Save offers exactly this. */
  result: LaneSpots | null;
}

const LABELS: Record<SpotId, string> = { centre: 'Centre', left: 'Left', right: 'Right' };
const HOW: Record<SpotId, string> = {
  centre: 'Stand where you want the centre lane',
  left: 'Step to where you want the left lane',
  right: 'Step to where you want the right lane',
};
const FURTHER: Record<SpotId, string> = {
  centre: 'Come back towards the middle',
  left: 'Step further left',
  right: 'Step further right',
};
export const HINT_LOST = 'Step back into view — the camera cannot see you';
export const HINT_TOO_FAR = 'Come back towards the middle';

export class LaneSetup {
  private readonly view: LaneSetupModel;
  /** Where the current steady stretch began, and when. NaN when there is none. */
  private anchor = Number.NaN;
  private steadyT = Number.NaN;
  /** The hold on a position that can be taken: when it began, and the running mean. */
  private holdT = Number.NaN;
  private sum = 0;
  private n = 0;
  private takenT = Number.NaN;

  constructor() {
    this.view = {
      step: 'centre',
      index: 0,
      label: LABELS.centre,
      how: HOW.centre,
      spots: { centre: null, left: null, right: null },
      live: null,
      hold: 0,
      blocked: null,
      hint: null,
      taken: false,
      result: null,
    };
  }

  get model(): LaneSetupModel {
    return this.view;
  }

  get finished(): boolean {
    return this.view.result !== null;
  }

  /** Back to the centre spot, forgetting all three. The "Redo" handler. */
  redo(): void {
    const v = this.view;
    v.spots.centre = v.spots.left = v.spots.right = null;
    v.result = null;
    v.live = null;
    this.show(0);
  }

  /**
   * One pose frame. `offset` is the hips' sideways offset from the calibrated centre in torso
   * lengths (`MoveMagnitudes.lane`), or null when nobody is in view. Returns the model.
   */
  update(offset: number | null, tMs: number): LaneSetupModel {
    const v = this.view;
    v.live = offset !== null && Number.isFinite(offset) ? offset : null;
    if (v.result) return v;
    if (v.taken) {
      if (tMs - this.takenT < SPOT_ADVANCE_MS) return v;
      this.advance();
      if (v.result) return v;
    }
    const step = v.step!;
    const x = v.live;
    if (x === null) {
      this.restart();
      v.hold = 0;
      v.blocked = null;
      v.hint = HINT_LOST;
      return v;
    }

    // Any move out of the band starts a new steady stretch — and a new hold.
    if (Number.isNaN(this.anchor) || Math.abs(x - this.anchor) > SPOT_STEADY) {
      this.restart();
      this.anchor = x;
      this.steadyT = tMs;
    }

    const blocked = this.check(step, x);
    v.blocked = blocked;
    if (blocked) {
      this.holdT = Number.NaN;
      v.hold = 0;
      // Only once they have actually stopped there: mid-step, the instruction says enough.
      v.hint = tMs - this.steadyT >= SPOT_HINT_MS ? (blocked === 'tooFar' ? HINT_TOO_FAR : FURTHER[step]) : null;
      return v;
    }

    v.hint = null;
    if (Number.isNaN(this.holdT)) {
      this.holdT = tMs;
      this.sum = 0;
      this.n = 0;
    }
    this.sum += x;
    this.n++;
    const held = tMs - this.holdT;
    v.hold = Math.min(1, held / SPOT_HOLD_MS);
    if (held >= SPOT_HOLD_MS) this.take(step, this.sum / this.n, tMs);
    return v;
  }

  /** Can `x` be taken as this spot? Every sample of a hold passes, so their mean does too. */
  private check(step: SpotId, x: number): SpotBlock | null {
    if (Math.abs(x) > MAX_SPOT - (step === 'centre' ? MIN_SPOT_GAP : 0)) return 'tooFar';
    const c = this.view.spots.centre;
    if (step === 'centre' || c === null) return null;
    const out = step === 'left' ? c - x : x - c;
    if (out >= MIN_SPOT_GAP) return null;
    return out < 0 ? 'wrongSide' : 'tooClose';
  }

  private take(step: SpotId, spot: number, tMs: number): void {
    const v = this.view;
    v.spots[step] = spot;
    v.hold = 1;
    v.taken = true;
    v.hint = null;
    v.blocked = null;
    this.takenT = tMs;
    this.restart();
  }

  private advance(): void {
    const v = this.view;
    if (v.index + 1 < SPOT_ORDER.length) {
      this.show(v.index + 1);
      return;
    }
    const { centre, left, right } = v.spots;
    v.result = { left: left!, centre: centre!, right: right! };
    v.step = null;
    v.index = SPOT_ORDER.length;
    v.taken = false;
    v.hold = 0;
  }

  private show(index: number): void {
    const v = this.view;
    const step = SPOT_ORDER[index];
    v.index = index;
    v.step = step;
    v.label = LABELS[step];
    v.how = HOW[step];
    v.hold = 0;
    v.hint = null;
    v.blocked = null;
    v.taken = false;
    this.takenT = Number.NaN;
    this.restart();
  }

  private restart(): void {
    this.anchor = Number.NaN;
    this.steadyT = Number.NaN;
    this.holdT = Number.NaN;
    this.sum = 0;
    this.n = 0;
  }
}
