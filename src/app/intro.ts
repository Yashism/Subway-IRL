/**
 * When the intro cinematic plays, and the thing that plays it.
 * Spec: docs/superpowers/specs/2026-09-18-intro-sequence.md ("How it is driven").
 *
 * The rule the spec cares about is small but easy to get wrong, so it lives here on its own, away
 * from the world and the DOM: the cinematic is shown once per session, on the first run, and never
 * in front of an automated check. `?intro=always` / `?intro=off` override that in both directions.
 *
 * `IntroRunner` owns the lifecycle rather than main.ts, because the ordering is the whole trick:
 * the run is held back while it plays, the last frame of the cinematic and the first frame of the
 * countdown are the same camera pose, and the teardown happens *after* the real runner is in place.
 */

export type IntroMode = 'auto' | 'always' | 'off';

/** `?intro=always` / `?intro=off` (`?intro` alone means always); anything else is `auto`. */
export function introMode(search: string): IntroMode {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return 'auto';
  }
  if (!params.has('intro')) return 'auto';
  const v = (params.get('intro') ?? '').toLowerCase();
  if (v === '0' || v === 'off' || v === 'no' || v === 'false' || v === 'never') return 'off';
  if (v === '' || v === '1' || v === 'on' || v === 'yes' || v === 'true' || v === 'always') return 'always';
  return 'auto';
}

export interface IntroContext {
  mode: IntroMode;
  /** The bot is driving: a demo must not sit through four seconds of cinema. */
  autopilot: boolean;
  /** `?posereplay=` or `?session=`: a replay plays back what was recorded, nothing else. */
  replay: boolean;
  /** `?input=keyboard` was asked for by name — the keyboard *test* path, not a camera-less player. */
  keyboardTest: boolean;
  /** The cinematic has already played in this browser session. */
  played: boolean;
}

/**
 * Spec: "Shown on the first run of a session"; never in autopilot, replay or keyboard-test paths
 * "unless explicitly forced". `always` forces it every run, which is what the screenshots use.
 */
export function shouldPlayIntro(c: IntroContext): boolean {
  if (c.mode === 'off') return false;
  if (c.mode === 'always') return true;
  if (c.autopilot || c.replay || c.keyboardTest) return false;
  return !c.played;
}

/** The part of WorldView the runner drives. Structural, so the tests need no WebGL at all. */
export interface IntroStage<G> {
  startIntro(o?: { seed?: number; variant?: number }): void;
  advanceIntro(dt: number): boolean;
  renderIntro(): void;
  skipIntro(): void;
  endIntro(game: G): void;
  readonly introBeat: number;
}

export interface IntroRunnerOptions<G> {
  stage: IntroStage<G>;
  /** Seeds the poster variant and the scatter of the paste. */
  seed?: number;
  /** Runs when the cinematic has handed over, after the world has been put back to the game. */
  onEnd?: () => void;
}

/**
 * Plays the cinematic across frames. `begin()` when a run is held back, `advance(dt, game)` at the
 * top of every frame (before the game steps, so the countdown's first frame is the one that
 * follows the handover), `draw()` in place of the world's normal render.
 */
export class IntroRunner<G> {
  private readonly o: IntroRunnerOptions<G>;
  private active = false;
  /** The cinematic has played once in this session (the spec's "first run of a session"). */
  played = false;

  constructor(o: IntroRunnerOptions<G>) {
    this.o = o;
  }

  get playing(): boolean {
    return this.active;
  }

  /** The beat on screen, 1..4, or 0 when nothing is playing. */
  get beat(): number {
    return this.active ? this.o.stage.introBeat : 0;
  }

  begin(): void {
    if (this.active) return;
    this.active = true;
    this.played = true;
    this.o.stage.startIntro({ seed: this.o.seed });
  }

  /** Any key, any click, a raised hand. Safe at any beat, and safe when nothing is playing. */
  skip(): void {
    if (this.active) this.o.stage.skipIntro();
  }

  /**
   * One frame. Returns true while the cinematic still owns the screen. On the frame it ends, the
   * world is handed back to `game` *before* this returns false, so the caller can release the run
   * into the very next game step and the player never sees a frame of the menu camera.
   */
  advance(dt: number, game: G): boolean {
    if (!this.active) return false;
    if (this.o.stage.advanceIntro(dt)) return true;
    this.active = false;
    this.o.stage.endIntro(game);
    this.o.onEnd?.();
    return false;
  }

  draw(): void {
    if (this.active) this.o.stage.renderIntro();
  }
}
