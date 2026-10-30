/**
 * Wander's controls: the keyboard, and the body (jog in place to walk, lean or step to steer).
 * Both end up as one WalkInput per frame. The mapping is pure so it can be tested; only `WanderKeys`
 * touches the DOM.
 *
 * Keys: W / Up walk · S / Down back up · A D / Left Right turn · Q E sidestep · Shift run ·
 * P or Space pause · C turn the camera on · Esc back to the menu.
 */
import type { WalkInput } from './walker';

const FORWARD = ['KeyW', 'ArrowUp'];
const BACK = ['KeyS', 'ArrowDown'];
const LEFT = ['KeyA', 'ArrowLeft'];
const RIGHT = ['KeyD', 'ArrowRight'];
const STRAFE_LEFT = ['KeyQ'];
const STRAFE_RIGHT = ['KeyE'];
const RUN = ['ShiftLeft', 'ShiftRight'];

/** Every code Wander listens to as a movement key (so the page does not scroll on the arrows). */
export const MOVEMENT_KEYS: ReadonlySet<string> = new Set([...FORWARD, ...BACK, ...LEFT, ...RIGHT, ...STRAFE_LEFT, ...STRAFE_RIGHT, ...RUN]);

const anyDown = (down: ReadonlySet<string>, codes: readonly string[]): boolean => codes.some((c) => down.has(c));
const axis = (down: ReadonlySet<string>, plus: readonly string[], minus: readonly string[]): number =>
  (anyDown(down, plus) ? 1 : 0) - (anyDown(down, minus) ? 1 : 0);

/** The input the held keys ask for. */
export function keysToInput(down: ReadonlySet<string>, out: WalkInput): WalkInput {
  out.forward = axis(down, FORWARD, BACK);
  out.turn = axis(down, RIGHT, LEFT);
  out.strafe = axis(down, STRAFE_RIGHT, STRAFE_LEFT);
  out.run = anyDown(down, RUN);
  return out;
}

/** What the pose pipeline says about the player, as far as Wander cares. */
export interface PoseSample {
  /** The camera is open and feeding the pose model. */
  running: boolean;
  /** A body is in view right now. */
  tracking: boolean;
  /** The player has stood still long enough to be calibrated. */
  calibrated: boolean;
  jogActive: boolean;
  msSinceStep: number;
  cadenceSpm: number;
  /** -1 left, 0 centre, 1 right: where the player stands (or leans). */
  lane: number;
}

/** Walking carries on this long after the last step, so the gaps between steps do not stutter. */
export const POSE_WALK_HOLD_MS = 900;
/** A cadence at or above this is a run. */
export const POSE_RUN_SPM = 165;
/** Steering by the body turns slower than the keys: a lean is a nudge, not a spin. */
export const POSE_TURN = 0.7;

/** True when the pose can drive the walker: a calibrated body in view. */
export const poseUsable = (p: PoseSample | null): boolean => !!p && p.running && p.tracking && p.calibrated;

/** The input the body asks for: jog in place to walk (fast to run), lean or step to steer. */
export function poseToInput(p: PoseSample | null, out: WalkInput): WalkInput {
  out.forward = 0;
  out.turn = 0;
  out.strafe = 0;
  out.run = false;
  if (!p || !poseUsable(p)) return out;
  const jogging = p.jogActive || p.msSinceStep < POSE_WALK_HOLD_MS;
  out.forward = jogging ? 1 : 0;
  out.run = jogging && p.cadenceSpm >= POSE_RUN_SPM;
  out.turn = Math.sign(p.lane) * POSE_TURN;
  return out;
}

/** The keys win on any axis they are using; the body fills in the rest. */
export function mergeInput(keys: WalkInput, pose: WalkInput, out: WalkInput): WalkInput {
  out.forward = keys.forward !== 0 ? keys.forward : pose.forward;
  out.turn = keys.turn !== 0 ? keys.turn : pose.turn;
  out.strafe = keys.strafe !== 0 ? keys.strafe : pose.strafe;
  out.run = keys.run || pose.run;
  return out;
}

export interface KeyHandlers {
  /** Esc: leave Wander. */
  exit(): void;
  /** P or Space: pause / resume. */
  pause(): void;
  /** C: turn the camera on (for body control). */
  camera(): void;
}

/** The held movement keys, plus the few one-shot keys. Attach while Wander is up, detach on the way out. */
export class WanderKeys {
  private readonly down = new Set<string>();

  constructor(private readonly handlers: KeyHandlers) {}

  /** The input the held keys ask for, written into `out`. */
  read(out: WalkInput): WalkInput {
    return keysToInput(this.down, out);
  }

  /** Forgets every held key (the window lost focus, or Wander is pausing). */
  release(): void {
    this.down.clear();
  }

  keyDown(e: { code: string; repeat?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (MOVEMENT_KEYS.has(e.code)) {
      this.down.add(e.code);
      return true;
    }
    if (e.repeat) return e.code === 'Escape' || e.code === 'KeyP' || e.code === 'Space' || e.code === 'KeyC';
    switch (e.code) {
      case 'Escape':
        this.handlers.exit();
        return true;
      case 'KeyP':
      case 'Space':
        this.handlers.pause();
        return true;
      case 'KeyC':
        this.handlers.camera();
        return true;
      default:
        return false;
    }
  }

  keyUp(e: { code: string }): void {
    this.down.delete(e.code);
  }

  attach(target: EventTarget): () => void {
    const down = (e: Event) => {
      if (this.keyDown(e as KeyboardEvent)) e.preventDefault();
    };
    const up = (e: Event) => this.keyUp(e as KeyboardEvent);
    const blur = () => this.release();
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    target.addEventListener('blur', blur);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', blur);
      this.release();
    };
  }
}
