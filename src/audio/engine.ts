/**
 * The Web Audio graph, and the only place a sound is actually made.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md ("Architecture").
 *
 * The engine has no opinions: it takes the director's cues and mix levels and renders them. It
 * builds its whole graph once in the constructor, and thereafter a frame only writes numbers to
 * AudioParams and, when a step falls due, schedules the next few notes. Nothing here allocates on
 * a frame that does not start a note.
 *
 * It works on any `BaseAudioContext`, which is what makes it testable: an `OfflineAudioContext`
 * renders the same graph to a buffer with no audio device in sight.
 */
import { CUE_SAMPLES, LAYER_SAMPLES, type CueSample } from './manifest';
import type { SampleBank } from './loader';
import {
  BAR,
  buildAmbience,
  buildDrone,
  buildHover,
  buildMagnet,
  buildRocket,
  buildWind,
  makeImpulse,
  PATTERNS,
  playBayan,
  playCue,
  playFootstep,
  playHeartbeat,
  playJoshNote,
  playPluck,
  playRiffNote,
  playTabla,
  playTick,
  playBuffer,
  loopBuffer,
  RIFF,
  SEND_LEVELS,
  type Layer,
  type VoiceCtx,
} from './voices';
import {
  DEFAULT_SETTINGS,
  HEARTBEAT_BPM,
  MIX_CHANNELS,
  type AudioSettings,
  type AudioSink,
  type CueName,
  type MixChannel,
} from './types';

/**
 * Which bus each one-shot goes to. The default is `sfx`; the exceptions are the ones that belong
 * to the bed (crows, the tannoy) or to the music itself (the Josh swell, the summary chord).
 */
const CUE_BUS: Partial<Record<CueName, 'sfx' | 'music' | 'ambience'>> = {
  crow: 'ambience',
  tannoy: 'ambience',
  joshStart: 'music',
  joshEnd: 'music',
  summary: 'music',
};

/**
 * How fast a mix channel follows the director. The music duck has to be quick or it ducks after the
 * sound it was ducking for; a layer fading in wants to be slow enough that nobody hears it arrive.
 */
const MIX_TC: Partial<Record<MixChannel, number>> = {
  music: 0.045,
  heartbeat: 0.25,
  ambience: 0.5,
};
const MIX_TC_DEFAULT = 0.13;

/**
 * Fixed trim on each bus, under the player's sliders. The patches are written at a level that
 * makes each one clear on its own; a dozen of them at once is a different sum, and a bus trim is
 * where you fix that rather than by de-tuning every patch against every other.
 */
const BUS_TRIM = { music: 0.5, sfx: 0.7, ambience: 0.45 } as const;

/** Seconds of notes scheduled ahead of the clock. Long enough to survive a dropped frame. */
const LOOKAHEAD = 0.22;
/** A cue is scheduled this far in the future, so its envelope starts on a sample boundary we own. */
const CUE_LATENCY = 0.015;
/** The sequencer resyncs rather than catching up if it falls this far behind (a throttled tab). */
const RESYNC = 0.5;
/** Cue starts allowed in one window, so a pathological pile-up cannot melt the graph. */
const VOICE_BUDGET = 14;
const VOICE_WINDOW = 0.08;

export interface EngineOptions {
  settings?: AudioSettings;
  /** Off for a cheap render (tests, or a machine that cannot afford convolution). */
  reverb?: boolean;
  /** The recordings. Anything it does not have is played from `voices.ts` instead. */
  bank?: SampleBank | null;
}

export class AudioEngine implements AudioSink {
  readonly ctx: BaseAudioContext;
  /**
   * The last node before the destination. The lab hangs an AnalyserNode off it to draw what the
   * player is actually hearing; the game never touches it.
   */
  readonly tap: AudioNode;

  private readonly master: GainNode;
  private readonly musicBus: GainNode;
  private readonly musicDuck: GainNode;
  private readonly sfxBus: GainNode;
  private readonly ambienceBus: GainNode;

  /** One VoiceCtx per bus, built once: a cue never allocates a routing object. */
  private readonly vMusic: VoiceCtx;
  private readonly vSfx: VoiceCtx;
  private readonly vAmbience: VoiceCtx;

  /** The scheduled layers' own routing, built once with the graph. */
  private readonly vTabla: VoiceCtx;
  private readonly vBass: VoiceCtx;
  private readonly vRiff: VoiceCtx;
  private readonly vJosh: VoiceCtx;
  private readonly vPulse: VoiceCtx;
  private readonly vHeart: VoiceCtx;
  private readonly vSteps: VoiceCtx;
  private readonly vDrone: VoiceCtx;
  private readonly heldLayers: Layer[];

  private readonly layers = {} as Record<MixChannel, GainNode | null>;
  private readonly level = {} as Record<MixChannel, number>;

  /** What the mixer is set to right now. The lab reads it; the game changes it through the facade. */
  settings: AudioSettings;
  private started = false;

  // sequencer
  /** The recordings, when there are any. Every read of it is guarded: a miss means synth. */
  private bank: SampleBank | null = null;
  /** The sampled station bed, once it has replaced the synthetic one. */
  private ambienceLoop: AudioBufferSourceNode | null = null;
  private ambienceSynth: GainNode | null = null;
  private ambienceSample: GainNode | null = null;
  private stepIndex = 0;

  private pulseBpm = 150;
  private running = false;
  private nextStep = 0;
  private step = 0;
  private heartbeatAt = 0;
  private voiceWindowEnds = 0;
  private voicesInWindow = 0;

  constructor(ctx: BaseAudioContext, options: EngineOptions = {}) {
    this.ctx = ctx;
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };

    // master → limiter → out. The limiter is a safety net, not a sound: with twenty voices and a
    // coin streak on top, peaks stack, and clipping on a laptop speaker is the ugliest thing there is.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);
    this.tap = limiter;

    this.master = ctx.createGain();
    this.master.connect(limiter);

    this.musicBus = ctx.createGain();
    this.musicDuck = ctx.createGain();
    this.musicDuck.connect(this.musicBus);
    this.musicBus.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.ambienceBus = ctx.createGain();
    this.ambienceBus.connect(this.master);

    // One reverb for the whole game, fed by four fixed taps per bus (see SEND_LEVELS).
    let sends: readonly AudioNode[] | null = null;
    if (options.reverb !== false) {
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx, 1.1, 3.2);
      const wet = ctx.createGain();
      wet.gain.value = 0.34;
      conv.connect(wet);
      wet.connect(this.master);
      sends = SEND_LEVELS.map((lv) => {
        const g = ctx.createGain();
        g.gain.value = lv;
        g.connect(conv);
        return g;
      });
    }

    this.vMusic = { ctx, out: this.musicDuck, sends };
    this.vSfx = { ctx, out: this.sfxBus, sends };
    this.vAmbience = { ctx, out: this.ambienceBus, sends };

    for (const c of MIX_CHANNELS) {
      this.layers[c] = null;
      this.level[c] = 0;
    }

    // The station bed is the one layer that exists twice: a synthetic one that is there from the
    // first frame, and a recording that replaces it the moment its file lands. They meet at
    // `ambienceLevel`, which is what the mix automates, so the swap is a cross-fade under a level
    // the director never has to know about.
    //
    //   synth sources → ambienceSynth ⟍
    //                                   ambienceLevel (the mix) → ambience bus
    //   sample loop   → ambienceSample ⟋
    const ambienceLevel = ctx.createGain();
    ambienceLevel.gain.value = 0;
    ambienceLevel.connect(this.ambienceBus);
    const ambienceSynth = ctx.createGain();
    ambienceSynth.gain.value = 1;
    ambienceSynth.connect(ambienceLevel);
    const ambienceSample = ctx.createGain();
    ambienceSample.gain.value = 0;
    ambienceSample.connect(ambienceLevel);
    this.ambienceSynth = ambienceSynth;
    this.ambienceSample = ambienceSample;

    // Held layers, built once and left running: their level is the only thing that ever changes.
    const bed = buildAmbience(ctx, ambienceSynth);
    bed.gain.gain.value = 1; // its own gain is not the mix any more; `ambienceLevel` is.
    const held: [MixChannel, Layer][] = [
      ['drone', buildDrone(ctx, this.musicDuck)],
      ['wind', buildWind(ctx, this.sfxBus)],
      ['hover', buildHover(ctx, this.sfxBus)],
      ['rocket', buildRocket(ctx, this.sfxBus)],
      ['magnet', buildMagnet(ctx, this.sfxBus)],
    ];
    this.heldLayers = [bed, ...held.map(([, l]) => l)];
    for (const [c, l] of held) this.layers[c] = l.gain;
    this.layers.ambience = ambienceLevel;

    // Scheduled layers: a gain node the notes land in, so a fade is one automation, not per-note maths.
    // The jog pulse and the heartbeat sit on the SFX bus on purpose — they are gameplay, not music,
    // and turning the music down must not take away the beat you are meant to be running on.
    for (const [c, bus] of [
      ['tabla', this.musicDuck],
      ['bass', this.musicDuck],
      ['riff', this.musicDuck],
      ['josh', this.musicDuck],
      ['pulse', this.sfxBus],
      ['heartbeat', this.sfxBus],
      ['chaserSteps', this.sfxBus],
    ] as [MixChannel, GainNode][]) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(bus);
      this.layers[c] = g;
    }

    this.vTabla = { ctx, out: this.layers.tabla!, sends };
    this.vBass = { ctx, out: this.layers.bass!, sends };
    this.vRiff = { ctx, out: this.layers.riff!, sends };
    this.vJosh = { ctx, out: this.layers.josh!, sends };
    this.vPulse = { ctx, out: this.layers.pulse!, sends: null };
    this.vHeart = { ctx, out: this.layers.heartbeat!, sends };
    this.vSteps = { ctx, out: this.layers.chaserSteps!, sends };
    this.vDrone = { ctx, out: this.layers.drone!, sends };

    this.bank = options.bank ?? null;
    this.level.music = 1;
    this.musicDuck.gain.value = 1;
    this.applySettings(this.settings, true);
  }

  /** Starts the continuous sources. Safe to call twice; safe while the context is suspended. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const t = this.ctx.currentTime;
    for (const l of this.heldLayers) l.start(t);
    this.nextStep = t + 0.05;
    this.heartbeatAt = t + 0.05;
  }

  /**
   * `immediate` puts the values in place with no glide. The constructor needs it: a GainNode starts
   * at 1, so gliding onto a quiet (or muted) setting would let the first 30 ms out at full volume.
   * Every later change glides, because a step in a gain is a click.
   */
  applySettings(s: AudioSettings, immediate = false): void {
    this.settings = { ...s };
    const t = this.ctx.currentTime;
    const put = (p: AudioParam, v: number, tc: number) => {
      if (immediate) p.value = v;
      else p.setTargetAtTime(v, t, tc);
    };
    put(this.master.gain, s.muted ? 0 : s.master, 0.01);
    put(this.musicBus.gain, s.music * BUS_TRIM.music, 0.03);
    put(this.sfxBus.gain, s.sfx * BUS_TRIM.sfx, 0.03);
    put(this.ambienceBus.gain, s.sfx * BUS_TRIM.ambience, 0.05);
  }

  // ---------------------------------------------------------------- AudioSink

  mix(channel: MixChannel, value: number): void {
    const v = Number.isFinite(value) ? (value < 0 ? 0 : value > 1 ? 1 : value) : 0;
    this.level[channel] = v;
    const t = this.ctx.currentTime;
    const tc = MIX_TC[channel] ?? MIX_TC_DEFAULT;
    if (channel === 'music') {
      this.musicDuck.gain.setTargetAtTime(v, t, tc);
      return;
    }
    if (channel === 'heartbeat') {
      // One number drives both: how loud the heart is and how fast it is going (see HEARTBEAT_BPM).
      this.layers.heartbeat!.gain.setTargetAtTime(v, t, tc);
      return;
    }
    const g = this.layers[channel];
    if (g) g.gain.setTargetAtTime(v, t, tc);
  }

  tempo(pulseBpm: number): void {
    if (!Number.isFinite(pulseBpm) || pulseBpm <= 0) return;
    this.pulseBpm = pulseBpm < 40 ? 40 : pulseBpm > 300 ? 300 : pulseBpm;
  }

  transport(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    if (running) {
      this.step = 0;
      this.nextStep = this.ctx.currentTime + 0.06;
    }
  }

  cue(name: CueName, gain = 1, rate = 1): void {
    if (!this.started) return;
    const t = this.ctx.currentTime + CUE_LATENCY;
    if (t >= this.voiceWindowEnds) {
      this.voiceWindowEnds = t + VOICE_WINDOW;
      this.voicesInWindow = 0;
    }
    if (++this.voicesInWindow > VOICE_BUDGET) return;
    const bus = CUE_BUS[name];
    const v = bus === 'music' ? this.vMusic : bus === 'ambience' ? this.vAmbience : this.vSfx;
    const spec = CUE_SAMPLES[name];
    // The recording if it has arrived, the synth patch if it has not. Every cue can do both, so a
    // file that is still in flight (or never coming) costs quality and nothing else.
    if (spec && this.playSample(v, spec, t, gain, rate)) return;
    playCue(v, name, t, gain, rate);
  }

  /** @returns false when the body of the cue is not loaded, so the caller falls back. */
  private playSample(v: VoiceCtx, spec: CueSample, t: number, gain: number, rate: number): boolean {
    const bank = this.bank;
    if (!bank) return false;
    const body = bank.get(spec.layers[0].file);
    if (!body) return false;
    const a = Math.max(0, Math.min(2, gain)) * spec.gain;
    for (let i = 0; i < spec.layers.length; i++) {
      const l = spec.layers[i];
      const buf = i === 0 ? body : bank.get(l.file);
      if (!buf) continue; // A missing extra layer just thins the cue; the body still plays.
      playBuffer(v, buf, t + (l.delay ?? 0), a * (l.gain ?? 1), l.fixedPitch ? 1 : rate, spec.send ?? 0, l.shape);
    }
    return true;
  }

  /**
   * Hands the engine the recordings. Safe to call before anything has loaded and safe to call
   * again as more arrives — the station bed swaps itself in the first time its file is there.
   */
  attachBank(bank: SampleBank | null): void {
    this.bank = bank;
  }

  // ---------------------------------------------------------------- the clock

  /**
   * Called once a frame. Schedules whatever falls due in the next `LOOKAHEAD` seconds — the notes
   * land on exact sample times, so the groove does not jitter with the frame rate.
   */
  update(): void {
    if (!this.started) return;
    const now = this.ctx.currentTime;
    if (this.running) {
      const dur = 60 / this.pulseBpm;
      if (this.nextStep < now - RESYNC) this.nextStep = now + 0.02;
      let guard = 0;
      while (this.nextStep < now + LOOKAHEAD && guard++ < 64) {
        this.scheduleStep(this.step, this.nextStep);
        this.nextStep += dur;
        this.step = (this.step + 1) % RIFF.length;
      }
    }
    this.scheduleHeartbeat(now);
    if (this.ambienceSample) this.swapAmbience(now);
  }

  /** The decoded buffer for a name, or null. One map read; safe before anything has loaded. */
  private sample(name: string): AudioBuffer | null {
    return this.bank ? this.bank.get(name) : null;
  }

  /**
   * Cross-fades the synthetic station bed out and the recorded one in, once. After it has run the
   * per-frame cost is one null check — `ambienceSample` is cleared, which is also the latch.
   */
  private swapAmbience(now: number): void {
    const buf = this.sample(LAYER_SAMPLES.ambience[0]);
    if (!buf) return;
    const wet = this.ambienceSample!;
    this.ambienceSample = null;
    const src = loopBuffer({ ctx: this.ctx, out: wet, sends: null }, buf, now);
    this.ambienceLoop = src;
    wet.gain.setTargetAtTime(1, now, 0.8);
    this.ambienceSynth?.gain.setTargetAtTime(0, now, 0.8);
  }

  private scheduleStep(i: number, t: number): void {
    const b = i % BAR;
    if (this.level.pulse > 0.01) playTick(this.vPulse, t, 1, PATTERNS.pulse[b]);
    if (this.level.tabla > 0.01) playTabla(this.vTabla, t, PATTERNS.tabla[b], 1);
    if (this.level.bass > 0.01 && PATTERNS.bass[b] > 0) playBayan(this.vBass, t, PATTERNS.bass[b]);
    if (this.level.riff > 0.01) playRiffNote(this.vRiff, t, RIFF[i], 1);
    if (this.level.josh > 0.01) playJoshNote(this.vJosh, t, RIFF[i], 1);
    if (this.level.chaserSteps > 0.01) {
      // Four recordings walked round: the same slap four times in a row is the most obviously
      // synthetic thing a footstep layer can do.
      const step = this.sample(LAYER_SAMPLES.step[this.stepIndex % LAYER_SAMPLES.step.length]);
      this.stepIndex++;
      if (step) playBuffer(this.vSteps, step, t, 0.45 * PATTERNS.steps[b], 0.94 + 0.12 * Math.random(), 0.25);
      else playFootstep(this.vSteps, t, 1, PATTERNS.steps[b]);
    }
    // The tanpura cycle rides the drone's own level, so a thinned bed thins its plucks too.
    if (this.level.drone > 0.05 && PATTERNS.tanpura[b] >= 0) {
      playPluck(this.vDrone, t, PATTERNS.tanpura[b], 0.9);
    }
  }

  private scheduleHeartbeat(now: number): void {
    const e = this.level.heartbeat;
    if (e <= 0.02) {
      this.heartbeatAt = now;
      return;
    }
    const bpm = HEARTBEAT_BPM[0] + (HEARTBEAT_BPM[1] - HEARTBEAT_BPM[0]) * e;
    const dur = 60 / bpm;
    if (this.heartbeatAt < now - RESYNC) this.heartbeatAt = now + 0.02;
    let guard = 0;
    const beat = this.sample(LAYER_SAMPLES.heartbeat[0]);
    while (this.heartbeatAt < now + LOOKAHEAD && guard++ < 8) {
      if (beat) playBuffer(this.vHeart, beat, this.heartbeatAt, 0.45, 1, 0.2);
      else playHeartbeat(this.vHeart, this.heartbeatAt, 1);
      this.heartbeatAt += dur;
    }
  }
}
