/**
 * The facade the app holds: one object, one call a frame.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md
 *
 *     const audio = new GameAudio();
 *     window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
 *     // …and once a frame, after game.step():
 *     audio.update(dt, game, activity, events);
 *
 * Nothing is heard until `unlock()` runs inside a real user gesture, because that is what browsers
 * require and because a game that blares on load is obnoxious. Before then the director still runs
 * — the jog pulse is already tracking the player's cadence — it just has nowhere to send it.
 */
import type { Game, GameEvent } from '../game/game';
import { speedFraction } from '../game/speed';
import type { ActivityStatus } from '../input/commands';
import { Director, type DirectorFrame } from './director';
import { AudioEngine } from './engine';
import { SampleBank, type SampleBankOptions } from './loader';
import { coreSampleNames, restSampleNames } from './manifest';
import { applyUrlFlags, AudioSettingsStore } from './settings';
import type { AudioSettings, AudioSink, CueName, MixChannel } from './types';

export * from './types';
export { Director, JogPulse, PULSE, type DirectorFrame } from './director';
export { AudioEngine } from './engine';
export { SampleBank, pickFormat, type SampleBankOptions } from './loader';
export { CUE_SAMPLES, LAYER_SAMPLES, allSampleNames, coreSampleNames, restSampleNames } from './manifest';
export { applyUrlFlags, AudioSettingsStore, cleanSettings } from './settings';

const NO_ACTIVITY: ActivityStatus = {
  tracksJogging: false,
  msSinceStep: Infinity,
  cadenceSpm: 0,
  steps: 0,
  squatting: false,
  lost: false,
};

export interface GameAudioOptions {
  settings?: AudioSettingsStore;
  /** Default: `location.search`, for `?mute` and `?vol=`. Pass '' to ignore the URL. */
  search?: string;
  /** Off for a cheap graph on a weak machine. */
  reverb?: boolean;
  /** Injected for tests. */
  makeContext?: () => BaseAudioContext;
  random?: () => number;
  /** Passed to the SampleBank (base path, fetch, decoder). Injected in tests. */
  samples?: SampleBankOptions;
  /** True skips the recordings entirely and plays the synth patches. `?nosamples` sets it. */
  synthOnly?: boolean;
}

export class GameAudio implements AudioSink {
  readonly store: AudioSettingsStore;
  readonly director: Director;
  engine: AudioEngine | null = null;
  bank: SampleBank | null = null;

  private settings: AudioSettings;
  private readonly synthOnly: boolean;
  /** This browser gave us no AudioContext; asking again would only build nothing, slower. */
  private noContext = false;
  private readonly options: GameAudioOptions;
  private readonly onVisibility: () => void;
  /** Reused every frame: building a frame object 60 times a second is exactly what we promised not to do. */
  private readonly frame: DirectorFrame = {
    dt: 1 / 60,
    state: 'menu',
    countdown: 0,
    speedFraction: 0,
    idleMs: 0,
    idleLevel: 'ok',
    chaserGap: 12,
    joshValue: 0,
    joshActive: false,
    airborne: false,
    hoverboard: false,
    resting: false,
    restEnding: false,
    rocket: false,
    magnet: false,
    activity: NO_ACTIVITY,
  };

  constructor(options: GameAudioOptions = {}) {
    this.options = options;
    this.store = options.settings ?? new AudioSettingsStore();
    const search = options.search ?? (typeof location !== 'undefined' ? location.search : '');
    this.settings = this.store.override(applyUrlFlags(this.store.get(), search));
    this.synthOnly = options.synthOnly ?? search.includes('nosamples');
    this.director = new Director(this, options.random ? { random: options.random } : {});

    this.onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) this.suspend();
      else this.resume();
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  }

  /**
   * The graph has been built — `unlock()` got as far as making a context. Deliberately **not**
   * called `ready`: a facade with a getter called `ready` that can be true over silence is what
   * let the HUD show a speaker while nothing was coming out. Ask `audible` for that.
   */
  get built(): boolean {
    return this.engine !== null;
  }

  /**
   * True when sound is really coming out: the graph exists *and* its context is running.
   *
   * This and `built` come apart, and the difference is the whole autoplay story. A context built
   * outside a user gesture — from a pose frame, say — is created `suspended` and refuses to
   * resume, so it is built and the player hears nothing. The HUD's speaker reads this one, because
   * a 🔊 over silence is worse than no icon at all. A context with no `state` (an offline renderer
   * in a test) is taken at its word.
   */
  get audible(): boolean {
    const ctx = this.engine?.ctx;
    if (!ctx) return false;
    return ctx.state === undefined || ctx.state === 'running';
  }

  get muted(): boolean {
    return this.settings.muted;
  }

  get volumes(): AudioSettings {
    return { ...this.settings };
  }

  /**
   * Call from inside any real user gesture (a click, a key, the start gesture). Builds the graph
   * the first time and resumes it every time — Chrome will re-suspend a context that was created
   * too early, so this stays safe to call again.
   */
  unlock(): void {
    if (!this.engine) {
      // Asked again and again until it takes, so a browser with no output device must not be made
      // to build a context per keystroke — one refusal is enough to stop trying.
      if (this.noContext) return;
      const ctx = this.makeContext();
      if (!ctx) {
        this.noContext = true;
        return;
      }
      this.engine = new AudioEngine(ctx, { settings: this.settings, reverb: this.options.reverb !== false });
      this.engine.start();
      this.director.resync();
      this.loadSamples(ctx);
    }
    this.resume();
  }

  /**
   * Fetches the recordings: the cues a player meets in the first five seconds first, the rest
   * behind them. Nothing is awaited by anything that matters — every cue already has a synth
   * patch, so the game is fully audible from the first frame and simply gets better as files land.
   */
  private loadSamples(ctx: BaseAudioContext): void {
    if (this.synthOnly || !this.engine) return;
    const bank = new SampleBank(ctx, this.options.samples);
    this.bank = bank;
    this.engine.attachBank(bank);
    void bank.load(coreSampleNames()).then(() => bank.load(restSampleNames()));
  }

  /** Once a frame, after `game.step()`. `events` is exactly what that call returned. */
  update(dt: number, game: Game, activity: ActivityStatus, events: readonly GameEvent[]): void {
    const f = this.frame;
    f.dt = dt;
    f.state = game.state;
    f.countdown = game.countdown;
    f.speedFraction = speedFraction(game.speed, game.options.difficulty);
    f.idleMs = game.idleMs;
    f.idleLevel = game.idleLevel;
    f.chaserGap = game.chaser.gap;
    f.joshValue = game.josh.value;
    f.joshActive = game.josh.active;
    f.airborne = game.runner.y > 0.02 && !game.runner.flying;
    f.hoverboard = game.powerups.hoverboard > 0;
    // A rest is the board plus actually stopping: a player jogging through a board is not resting.
    f.resting = game.resting && game.movingLevel !== 'ok';
    f.restEnding = game.restEnding;
    f.rocket = game.powerups.rocket > 0;
    f.magnet = game.powerups.magnet > 0;
    f.activity = activity;
    this.director.update(f, events);
    this.engine?.update();
  }

  /** The same thing for a screen with no Game behind it (the lab, the intro, a menu). */
  updateFrame(frame: DirectorFrame, events: readonly GameEvent[] = []): void {
    this.director.update(frame, events);
    this.engine?.update();
  }

  // ---------------------------------------------------------------- hooks for the rest of the app

  ui(kind: 'click' | 'back' | 'confirm'): void {
    this.director.fire(kind === 'click' ? 'uiClick' : kind === 'back' ? 'uiBack' : 'uiConfirm', 0.7, 1);
  }

  /** The move check: a confirmation per finished move, a small fanfare on the summary. */
  moveCheck(kind: 'ok' | 'fanfare'): void {
    this.director.fire(kind === 'ok' ? 'moveOk' : 'moveFanfare', kind === 'ok' ? 0.7 : 0.85, 1);
  }

  /** The intro poster sequence. */
  intro(kind: 'brush' | 'unfurl' | 'whistle', gain = 0.8): void {
    this.director.fire(kind === 'brush' ? 'brush' : kind === 'unfurl' ? 'unfurl' : 'introWhistle', gain, 1);
  }

  /** A train sweeping past the runner, 0..1 by how near it passes. The world calls this. */
  trainPass(closeness = 1): void {
    this.director.trainPass(closeness);
  }

  /** Anything else, by name. */
  play(cue: CueName, gain = 1, rate = 1): void {
    this.director.fire(cue, gain, rate);
  }

  // ---------------------------------------------------------------- settings

  setVolumes(patch: Partial<AudioSettings>): AudioSettings {
    this.settings = this.store.set(patch);
    this.engine?.applySettings(this.settings);
    return this.volumes;
  }

  setMuted(muted: boolean): void {
    this.setVolumes({ muted });
  }

  toggleMute(): boolean {
    this.setMuted(!this.settings.muted);
    return this.settings.muted;
  }

  // ---------------------------------------------------------------- lifecycle

  suspend(): void {
    const ctx = this.engine?.ctx as AudioContext | undefined;
    if (ctx && typeof ctx.suspend === 'function' && ctx.state === 'running') void ctx.suspend().catch(() => {});
  }

  resume(): void {
    const ctx = this.engine?.ctx as AudioContext | undefined;
    if (ctx && typeof ctx.resume === 'function' && ctx.state !== 'running') void ctx.resume().catch(() => {});
  }

  dispose(): void {
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibility);
    }
    const ctx = this.engine?.ctx as AudioContext | undefined;
    this.engine = null;
    if (ctx && typeof ctx.close === 'function') void ctx.close().catch(() => {});
  }

  // ---------------------------------------------------------------- AudioSink (to the engine, or nowhere)

  cue(cue: CueName, gain: number, rate: number): void {
    this.engine?.cue(cue, gain, rate);
  }

  mix(channel: MixChannel, value: number): void {
    this.engine?.mix(channel, value);
  }

  tempo(pulseBpm: number): void {
    this.engine?.tempo(pulseBpm);
  }

  transport(running: boolean): void {
    this.engine?.transport(running);
  }

  private makeContext(): BaseAudioContext | null {
    if (this.options.makeContext) return this.options.makeContext();
    const Ctor =
      typeof globalThis !== 'undefined'
        ? ((globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
            .AudioContext ??
          (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;
    if (!Ctor) return null;
    try {
      // `interactive` is the right trade here: a game cue that arrives late is worse than one that jitters.
      return new Ctor({ latencyHint: 'interactive' });
    } catch {
      return null; // No output device, or the context limit was hit: the game stays silent, not broken.
    }
  }
}
