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
  /** Run inside the gesture. Called at most once. */
  onUnlock(): void;
  /** False means this page never makes a sound: no listeners, and `fire()` does nothing. */
  enabled?: boolean;
}

/**
 * Unlocks on the first key, pointer or hand-raise, once, and then gets out of the way — the
 * listeners are capture-phase so a focused button cannot swallow the gesture, and they are removed
 * the moment they have done their job rather than running for the rest of the session.
 */
export class GestureUnlock {
  private readonly o: GestureUnlockOptions;
  private readonly handler: () => void;
  private done = false;
  private attached = false;

  constructor(o: GestureUnlockOptions) {
    this.o = o;
    this.handler = () => this.fire();
    if (o.enabled === false) return;
    o.target.addEventListener('keydown', this.handler, true);
    o.target.addEventListener('pointerdown', this.handler, true);
    this.attached = true;
  }

  get unlocked(): boolean {
    return this.done;
  }

  /** A gesture that never reaches the DOM: the raised hand that starts a run. */
  fire(): void {
    if (this.done || this.o.enabled === false) return;
    this.done = true;
    this.detach();
    this.o.onUnlock();
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.o.target.removeEventListener('keydown', this.handler, true);
    this.o.target.removeEventListener('pointerdown', this.handler, true);
  }
}
