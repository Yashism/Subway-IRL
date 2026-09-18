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
import { INTRO_BEATS, INTRO_BRUSH_STROKES } from '../world/intro';


export type IntroMode = 'auto' | 'always' | 'off';

/** The three sounds the cinematic makes (`GameAudio.intro`). */
export type IntroCue = 'brush' | 'unfurl' | 'whistle';

/**
 * When each one lands, in seconds of the sequence's own clock. The brush strokes are
 * `INTRO_BRUSH_STROKES` — the same instants the paste is thrown off the brush in `world/intro.ts`,
 * so the sound and the flecks can never drift apart. The other two are read off the same file:
 * the poster starts dropping at the beat-2 boundary, and the TT's torch finds the wall at 2.42.
 */
export const INTRO_CUES: readonly { t: number; cue: IntroCue; gain: number }[] = Object.freeze([
  ...INTRO_BRUSH_STROKES.map((t, i) => ({ t, cue: 'brush' as const, gain: i === 0 ? 0.9 : 0.72 })),
  { t: INTRO_BEATS[1], cue: 'unfurl', gain: 0.85 },
  { t: 2.44, cue: 'whistle', gain: 0.9 },
]);

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
  /** Seconds into the sequence, so the cues can be placed against its own clock. */
  readonly introTime: number;
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
  /**
   * A sound the cinematic makes. Fired once each, in order, as its clock passes them — including
   * on a skip, where every cue still pending is dropped rather than played in a burst.
   */
  onCue?: (cue: IntroCue, gain: number) => void;
}

/**
 * Plays the cinematic across frames. `begin()` when a run is held back, `advance(dt, game)` at the
 * top of every frame (before the game steps, so the countdown's first frame is the one that
 * follows the handover), `draw()` in place of the world's normal render.
 */
export class IntroRunner<G> {
  private readonly o: IntroRunnerOptions<G>;
  private active = false;
  /** Index of the next cue in INTRO_CUES; everything before it has already been fired or dropped. */
  private nextCue = 0;
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
    this.nextCue = 0;
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
    const playing = this.o.stage.advanceIntro(dt);
    this.fireCues(playing);
    if (playing) return true;
    this.active = false;
    this.o.stage.endIntro(game);
    this.o.onEnd?.();
    return false;
  }

  draw(): void {
    if (this.active) this.o.stage.renderIntro();
  }

  /**
   * Every cue the clock has passed, once each. A skip jumps the clock to the end, which would
   * otherwise fire the whole sequence at once — so once the cinematic is over the pending cues are
   * dropped rather than played. The one exception is the whistle, which is the sound the player is
   * being handed to the run by; a skipped intro still gets it.
   */
  private fireCues(stillPlaying: boolean): void {
    const at = this.o.stage.introTime;
    while (this.nextCue < INTRO_CUES.length && INTRO_CUES[this.nextCue].t <= at) {
      const c = INTRO_CUES[this.nextCue++];
      if (stillPlaying || c.cue === 'whistle') this.o.onCue?.(c.cue, c.gain);
    }
  }
}
