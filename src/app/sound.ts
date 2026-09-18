/**
 * The two rules the page has to get right about sound, kept out of `main.ts` so they can be tested.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md ("Autoplay").
 *
 * 1. Nothing is heard before a real user gesture. Browsers require it, and a game that blares on
 *    load is obnoxious. So the graph is built inside the first key, click or start gesture, once.
 * 2. An automated path — the bot demo, a pose replay — never unlocks at all, so a screenshot run
 *    or a recorded session plays back in silence unless someone asks for sound with `?audio`.
 *
 * The audio module itself is not imported here: this decides *whether* and *when*, not *what*.
 */

export interface SoundContext {
  /** The bot is driving. */
  autopilot: boolean;
  /** `?posereplay=` or `?session=`. */
  replay: boolean;
  /** `location.search`. */
  search: string;
}

/** `?audio` (or `?audio=1`) forces sound on a demo path; `?audio=0` silences any path. */
export function soundAllowed(c: SoundContext): boolean {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(c.search);
  } catch {
    return !(c.autopilot || c.replay);
  }
  if (params.has('audio')) {
    const v = (params.get('audio') ?? '').toLowerCase();
    return !['0', 'off', 'no', 'false'].includes(v);
  }
  return !(c.autopilot || c.replay);
}

export interface GestureUnlockOptions {
  /** Usually `window`. */
  target: EventTarget;
  /** Run inside the gesture. Called on every gesture until `audible()` says it took. */
  onUnlock(): void;
  /**
   * True once sound is really coming out. This is the whole point of the class: a browser builds
   * an AudioContext **suspended** when the call did not come from a real user gesture, and then
   * refuses to resume it. "We called unlock" and "it worked" are different facts, and only the
   * second one is allowed to stop us trying.
   */
  audible(): boolean;
  /** False means this page never makes a sound: no listeners, and `fire()` does nothing. */
  enabled?: boolean;
}

/**
 * Unlocks on a key, a pointer or a raised hand, and keeps offering every later gesture until the
 * sound is actually running. The listeners are capture-phase so a focused button cannot swallow
 * the gesture, and they come off as soon as they are not needed.
 *
 * The retry is not belt-and-braces: the raised hand that starts a run arrives on a pose frame,
 * which carries no user activation, so that attempt is expected to fail. Latching on it would
 * leave the player silent for the whole session with no way back — which is exactly what it did.
 */
export class GestureUnlock {
  private readonly o: GestureUnlockOptions;
  private readonly handler: () => void;
  private attached = false;
  /** Gestures offered to `onUnlock`, for the tests and for anyone debugging a silent page. */
  attempts = 0;

  constructor(o: GestureUnlockOptions) {
    this.o = o;
    this.handler = () => this.fire();
    if (o.enabled === false) return;
    o.target.addEventListener('keydown', this.handler, true);
    o.target.addEventListener('pointerdown', this.handler, true);
    this.attached = true;
  }

  /** Sound is running. Asked of the owner, never remembered here. */
  get unlocked(): boolean {
    return this.o.enabled !== false && this.o.audible();
  }

  /**
   * A gesture. Tries again if the last attempt did not take, and stands down once it has —
   * including for a gesture that never reaches the DOM, like the raised hand that starts a run.
   */
  fire(): void {
    if (this.o.enabled === false) return;
    if (this.o.audible()) {
      this.detach();
      return;
    }
    this.attempts++;
    this.o.onUnlock();
    // A resume granted inside this gesture is immediate; one that needs a round trip is picked up
    // by the next gesture, which finds it audible and stands the listeners down then.
    if (this.o.audible()) this.detach();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.o.target.removeEventListener('keydown', this.handler, true);
    this.o.target.removeEventListener('pointerdown', this.handler, true);
  }
}
