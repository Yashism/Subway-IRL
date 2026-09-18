/**
 * Every audio *decision*, and nothing that makes a sound.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md ("Architecture", "Behaviour").
 *
 * The director takes the same state the HUD draws — the run speed, the idle clock, the chaser's
 * gap, the Josh meter, the player's real jogging cadence — and turns it into cues and held mix
 * levels. There is no Web Audio here and there never will be: this file is the part that has
 * opinions, so it is the part that has to be testable against a fake sink.
 *
 * It allocates nothing per frame. Mix levels live in one record built at construction, and a cue
 * is three primitives.
 */
import { TUNING } from '../game/config';
import type { GameEvent, GameState } from '../game/game';
import type { IdleLevel } from '../game/rules';
import type { ActivityStatus } from '../input/commands';
import { MIX_CHANNELS, type AudioSink, type CueName, type MixChannel } from './types';

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
/** 0 below `a`, 1 above `b`, linear between. The shape every layer fades in on. */
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

/** What the director needs to know this frame. Everything is read-only game state. */
export interface DirectorFrame {
  dt: number;
  state: GameState;
  /** Seconds left on the countdown (only meaningful in the `countdown` state). */
  countdown: number;
  /** 0 at the start speed, 1 at this difficulty's top speed. */
  speedFraction: number;
  /** Milliseconds since the player last moved. */
  idleMs: number;
  idleLevel: IdleLevel;
  /** Metres the TT is behind the runner. */
  chaserGap: number;
  joshValue: number;
  joshActive: boolean;
  /** Off the ground (not counting rocket flight): the falling edge is the landing. */
  airborne: boolean;
  hoverboard: boolean;
  /** On a hoverboard *and* actually standing still: a rest, which the jog rule allows. */
  resting: boolean;
  /** The last seconds of a rest, still standing: time to lead the player back into their stride. */
  restEnding: boolean;
  rocket: boolean;
  magnet: boolean;
  activity: ActivityStatus;
}

// ------------------------------------------------------------------ the jog pulse

/**
 * The fitness feature, in numbers. A metronome that ignores the player is useless — they fall
 * behind it and stop trying — and one that follows them exactly is also useless, because it never
 * asks for anything. So: lock onto their real cadence, then sit a *little* above it when they are
 * under what the run is asking for, by an amount small enough that the next footfall still lands
 * on a tick.
 */
export const PULSE = {
  /** Footfalls per minute the tick will never go outside. */
  min: 120,
  max: 200,
  /** What the run asks for, at the start speed and at top speed. */
  demandSlow: 140,
  demandFast: 176,
  /** Seconds of smoothing onto the player's measured cadence (it is noisy, and a jittery tick is unfollowable). */
  follow: 1.6,
  /** The most the tick will ever sit above the player, in spm. Roughly 4%: one stride's worth over ten. */
  leadMax: 7,
  /** Seconds of being slow before the full lead is applied — no nagging for one short stride. */
  leadIn: 1.2,
  /** Within this many spm of the tick, the player counts as locked on and the tick gets quieter. */
  steadyBand: 8,
  /** No step this recently means they are not jogging: hold the tempo rather than chase it down. */
  staleMs: 900,
} as const;

/** Tracks the player's cadence and decides the tempo of the tick they should be jogging to. */
export class JogPulse {
  /** Footfalls per minute the tick is running at. */
  bpm: number = PULSE.demandSlow;
  /** The smoothed measurement of what the player is actually doing. */
  tracked: number = PULSE.demandSlow;
  /** How far above the player the tick is currently sitting. */
  lead = 0;
  /** The player is jogging within `steadyBand` of the tick. */
  locked = false;
  /** Seconds they have been under what the run is asking for. */
  private slowFor = 0;

  reset(speedFraction = 0): void {
    this.bpm = this.tracked = this.demand(speedFraction);
    this.lead = 0;
    this.slowFor = 0;
    this.locked = false;
  }

  demand(speedFraction: number): number {
    return lerp(PULSE.demandSlow, PULSE.demandFast, clamp01(speedFraction));
  }

  update(dt: number, speedFraction: number, a: ActivityStatus): number {
    const demand = this.demand(speedFraction);

    // No cadence source (keyboard play): a plain metronome at what the run asks for.
    if (!a.tracksJogging) {
      this.tracked += (demand - this.tracked) * (1 - Math.exp(-dt / PULSE.follow));
      this.lead = 0;
      this.slowFor = 0;
      this.locked = false;
      this.bpm = clamp(this.tracked, PULSE.min, PULSE.max);
      return this.bpm;
    }

    const live =
      Number.isFinite(a.cadenceSpm) && a.cadenceSpm > PULSE.min * 0.5 && a.msSinceStep < PULSE.staleMs
        ? clamp(a.cadenceSpm, PULSE.min, PULSE.max)
        : null;

    if (live === null) {
      // They have stopped, or are between strides. Hold the tempo: it is what they come back to.
      this.slowFor = 0;
      this.lead = Math.max(0, this.lead - dt * PULSE.leadMax);
      this.locked = false;
      this.bpm = clamp(this.tracked + this.lead, PULSE.min, PULSE.max);
      return this.bpm;
    }

    this.tracked += (live - this.tracked) * (1 - Math.exp(-dt / PULSE.follow));
    const deficit = demand - this.tracked;
    if (deficit > PULSE.steadyBand * 0.5) {
      this.slowFor += dt;
      // Half the gap, capped, faded in — so the lead always converges on `demand` rather than overshooting it.
      const want = Math.min(PULSE.leadMax, deficit * 0.5) * clamp01(this.slowFor / PULSE.leadIn);
      this.lead += (want - this.lead) * (1 - Math.exp(-dt / 0.6));
    } else {
      this.slowFor = 0;
      this.lead += (0 - this.lead) * (1 - Math.exp(-dt / 0.6));
    }
    this.bpm = clamp(this.tracked + this.lead, PULSE.min, PULSE.max);
    // Being led does not count as locked on. The tick goes quiet only once the player is holding
    // the pace on their own — while it is still pulling them up it has to stay the loud thing.
    this.locked = Math.abs(live - this.bpm) <= PULSE.steadyBand && this.lead < 2;
    return this.bpm;
  }
}

// ------------------------------------------------------------------ tuning for the mix

/** How hard each cue ducks the music bed, 0..1. Anything not listed does not duck. */
const DUCK: Partial<Record<CueName, number>> = {
  caught: 0.9,
  stumble: 0.35,
  pickupRocket: 0.4,
  rocketLanding: 0.3,
  hoverboard: 0.3,
  trainPass: 0.35,
  whistle: 0.18,
  joshStart: 0.3,
  go: 0.25,
  moveFanfare: 0.3,
  summary: 0.35,
};

/** Seconds for a full duck to release. */
const DUCK_RELEASE = 0.55;
/**
 * The "about to be caught" alarm: the whistle, then three barks a quick 0.3 s apart, the last
 * pitched a touch lower so the three do not sound like one sample looped. Times in seconds.
 */
export const ALARM: readonly { at: number; cue: CueName; gain: number; rate: number }[] = [
  { at: 0, cue: 'whistle', gain: 0.85, rate: 1 },
  { at: 0.45, cue: 'bark', gain: 0.9, rate: 1 },
  { at: 0.75, cue: 'bark', gain: 0.85, rate: 1.04 },
  { at: 1.05, cue: 'bark', gain: 0.9, rate: 0.96 },
];
const ALARM_LENGTH = ALARM[ALARM.length - 1].at;

/** The jog tick while the player rests on a hoverboard: there, but no longer asking anything. */
const RESTING_PULSE = 0.12;
/** …and in the last seconds of the rest: the strongest it gets, to pull them back to their feet. */
const REST_ENDING_PULSE = 0.9;

/**
 * The coin ladder, in semitones above the chime's root: a minor pentatonic climbing two octaves,
 * the same scale the riff is on, so a long coin line is *part of* the music instead of over it.
 */
const COIN_LADDER = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24] as const;
/** Longer than this between coins and the streak has ended. */
const COIN_STREAK_GAP = 0.85;

/** Mix values below this difference are not worth sending. */
const MIX_EPSILON = 0.004;

export interface DirectorOptions {
  /** Injected for tests; the ambience punctuation and whistle spacing are the only random things here. */
  random?: () => number;
}

export class Director {
  readonly pulse = new JogPulse();

  /** Indexed, not iterated: a for..of over the frozen channel tuple would allocate an iterator a frame. */
  private readonly channels = MIX_CHANNELS as readonly MixChannel[];
  private readonly mixOut = {} as Record<MixChannel, number>;
  private readonly mixSent = {} as Record<MixChannel, number>;
  private readonly random: () => number;

  private state: GameState = 'menu';
  private tempoSent = 0;
  private transportSent: boolean | null = null;
  private duck = 0;
  private coinStreak = 0;
  private sinceCoin = Infinity;
  private whistleIn = 0;
  private crowIn = 6;
  private tannoyIn = 12;
  private beepAt = 4;
  private wasAirborne = false;
  private wasJosh = false;
  private idleWas: IdleLevel = 'ok';
  /** Seconds into the alarm sequence, or -1 when it is not playing. */
  private alarmT = -1;
  /** Index of the next ALARM step to fire. */
  private alarmNext = 0;

  constructor(private readonly sink: AudioSink, options: DirectorOptions = {}) {
    this.random = options.random ?? Math.random;
    for (const c of MIX_CHANNELS) {
      this.mixOut[c] = 0;
      this.mixSent[c] = -1;
    }
  }

  /**
   * A sound the app asks for directly rather than one the run implies: UI clicks, the move check's
   * confirmations, the intro's brush strokes. It still ducks the bed like any other cue.
   */
  fire(cue: CueName, gain = 1, rate = 1): void {
    this.emit(cue, gain, rate);
  }

  /** A train sweeping past, from the world. 0..1 by how near it passes. */
  trainPass(closeness = 1): void {
    this.emit('trainPass', 0.35 + 0.55 * clamp01(closeness), lerp(1.08, 0.92, clamp01(closeness)));
  }

  update(frame: DirectorFrame, events: readonly GameEvent[]): void {
    const dt = frame.dt > 0 && frame.dt < 0.5 ? frame.dt : 1 / 60;
    this.duck = Math.max(0, this.duck - dt / DUCK_RELEASE);
    this.sinceCoin += dt;

    for (let i = 0; i < events.length; i++) this.onEvent(events[i], frame);
    if (this.state !== frame.state) this.onState(frame);
    this.edges(frame);
    this.advanceAlarm(dt);

    // The landing is the falling edge of being in the air — the game has no event for it.
    if (this.wasAirborne && !frame.airborne && frame.state === 'playing') {
      this.emit('land', 0.42 + 0.22 * frame.speedFraction, 0.94 + 0.12 * this.random());
    }
    this.wasAirborne = frame.airborne;

    switch (frame.state) {
      case 'playing':
        this.playing(dt, frame);
        break;
      case 'countdown':
        this.countdown(frame);
        break;
      case 'paused':
        this.paused(frame);
        break;
      case 'caught':
        this.caught();
        break;
      case 'summary':
        this.summary(dt, frame);
        break;
      default:
        this.menu(dt, frame);
        break;
    }
    this.flush();
  }

  // ---------------------------------------------------------------- states

  private menu(dt: number, frame: DirectorFrame): void {
    const m = this.mixOut;
    m.drone = 0.45;
    m.tabla = 0.3;
    m.bass = 0.16;
    m.riff = 0.24;
    m.pulse = 0;
    m.josh = 0;
    m.heartbeat = 0;
    m.wind = 0;
    m.hover = m.rocket = m.magnet = 0;
    m.chaserSteps = 0;
    m.ambience = 0.55;
    m.music = 1 - this.duck;
    this.pulse.reset(frame.speedFraction);
    this.setTempo(132);
    this.setTransport(true);
    this.punctuate(dt, 0.7);
  }

  private countdown(frame: DirectorFrame): void {
    const m = this.mixOut;
    m.drone = 0.55;
    m.tabla = 0;
    m.bass = 0;
    m.riff = 0;
    m.pulse = 0;
    m.josh = 0;
    m.heartbeat = 0;
    m.wind = 0.1;
    m.hover = m.rocket = m.magnet = 0;
    m.chaserSteps = 0;
    m.ambience = 0.5;
    m.music = 1 - this.duck;
    this.setTransport(false);
    // Three beeps as the whole seconds tick away; "GO" lands on the state change.
    const n = Math.ceil(frame.countdown - 1e-6);
    if (n < this.beepAt && n >= 1) {
      this.beepAt = n;
      this.emit('countdown', 0.7, n === 1 ? 1.12 : 1);
    }
  }

  private paused(frame: DirectorFrame): void {
    const m = this.mixOut;
    m.drone = 0.5;
    m.tabla = 0;
    m.bass = 0;
    m.riff = 0;
    m.pulse = 0;
    m.josh = 0;
    m.heartbeat = 0;
    m.wind = 0;
    m.hover = m.rocket = m.magnet = 0;
    m.chaserSteps = 0;
    m.ambience = 0.3;
    m.music = 0.28;
    this.setTransport(false);
    void frame;
  }

  private caught(): void {
    const m = this.mixOut;
    for (let i = 0; i < this.channels.length; i++) m[this.channels[i]] = 0;
    m.ambience = 0.12;
    this.setTransport(false);
  }

  private summary(dt: number, frame: DirectorFrame): void {
    const m = this.mixOut;
    m.drone = 0.42;
    m.tabla = 0.14;
    m.bass = 0.1;
    m.riff = 0.26;
    m.pulse = 0;
    m.josh = 0;
    m.heartbeat = 0;
    m.wind = 0;
    m.hover = m.rocket = m.magnet = 0;
    m.chaserSteps = 0;
    m.ambience = 0.45;
    m.music = 1 - this.duck;
    this.setTempo(120);
    this.setTransport(true);
    this.punctuate(dt, 0.6);
    void frame;
  }

  private playing(dt: number, frame: DirectorFrame): void {
    const m = this.mixOut;
    const t = clamp01(frame.speedFraction);

    // How far into the 2 s deadline we are, 0 at the warning, 1 at caught. This is the red vignette.
    const e = clamp01((frame.idleMs - TUNING.idleWarnMs) / (TUNING.idleCaughtMs - TUNING.idleWarnMs));
    const alive = 1 - e;

    m.drone = (0.5 + 0.12 * t) * (0.45 + 0.55 * alive);
    m.tabla = (0.55 + 0.35 * ramp(t, 0, 0.35)) * alive * alive;
    m.bass = 0.85 * ramp(t, 0.18, 0.42) * alive;
    m.riff = 0.75 * ramp(t, 0.45, 0.72) * clamp01(1 - 2 * e);
    m.josh = (frame.joshActive ? 1 : 0.3 * clamp01(frame.joshValue)) * alive;
    m.wind = (0.12 + 0.6 * t) * (1 - 0.5 * e);
    m.ambience = (0.5 - 0.2 * t) * (1 - 0.6 * e);
    m.heartbeat = e;

    m.hover = frame.hoverboard ? 0.55 : 0;
    m.rocket = frame.rocket ? 0.8 : 0;
    m.magnet = frame.magnet ? 0.35 : 0;

    // The jog pulse. It is the one layer the idle warning makes LOUDER: when everything else
    // drops away it is the beat they have to put a foot back onto, so it has to be the thing left.
    // A hoverboard rest is the exception: nagging someone who has been told they may stop would
    // undo the point of it, so the tick goes faint — not silent, so the tempo stays in their head —
    // and comes back strong in the last seconds to carry them back into their stride.
    this.pulse.update(dt, t, frame.activity);
    if (frame.restEnding) m.pulse = REST_ENDING_PULSE;
    else if (frame.resting) m.pulse = RESTING_PULSE;
    else m.pulse = (this.pulse.locked ? 0.42 : 0.8) * (1 + 0.35 * e);
    // The groove relaxes while they rest; the drone and the station carry on around them.
    if (frame.resting && !frame.restEnding) m.tabla *= 0.55;
    this.setTempo(this.pulse.bpm);

    this.chaser(dt, frame);
    m.music = 1 - this.duck;
    this.setTransport(true);
    this.punctuate(dt, 0.35 * (1 - t));
  }

  // ---------------------------------------------------------------- pieces

  /** The TT: footsteps rise with how close he is, and the whistle comes more often. */
  private chaser(dt: number, frame: DirectorFrame): void {
    const near = TUNING.chaserNearGap;
    const far = TUNING.chaserFarGap;
    const p = clamp01((far - frame.chaserGap) / (far - near));
    this.mixOut.chaserSteps = p * p * 0.9;

    if (p <= 0.12) {
      this.whistleIn = 1.2; // He is out of earshot; the next one comes shortly after he closes.
      return;
    }
    this.whistleIn -= dt;
    if (this.whistleIn > 0) return;
    this.emit('whistle', 0.28 + 0.6 * p, 0.94 + 0.2 * p);
    this.whistleIn = lerp(6, 1.9, p) * (0.85 + 0.3 * this.random());
  }

  /** Crows and a tannoy blip over the station bed. `density` scales how often they land. */
  private punctuate(dt: number, density: number): void {
    if (density <= 0.01) return;
    this.crowIn -= dt * density;
    if (this.crowIn <= 0) {
      this.emit('crow', 0.16 + 0.12 * this.random(), 0.9 + 0.25 * this.random());
      this.crowIn = 9 + 14 * this.random();
    }
    this.tannoyIn -= dt * density;
    if (this.tannoyIn <= 0) {
      this.emit('tannoy', 0.2, 0.96 + 0.08 * this.random());
      this.tannoyIn = 16 + 18 * this.random();
    }
  }

  private onState(frame: DirectorFrame): void {
    const from = this.state;
    this.state = frame.state;
    switch (frame.state) {
      case 'countdown':
        this.beepAt = 4;
        break;
      case 'playing':
        if (from === 'countdown') this.emit('go', 0.85, 1);
        this.pulse.reset(frame.speedFraction);
        this.idleWas = 'ok';
        this.coinStreak = 0;
        this.sinceCoin = Infinity;
        this.whistleIn = 3;
        break;
      case 'summary':
        this.emit('summary', 0.6, 1);
        break;
      default:
        break;
    }
  }

  private onEvent(e: GameEvent, frame: DirectorFrame): void {
    switch (e.type) {
      case 'coin': {
        this.coinStreak = this.sinceCoin <= COIN_STREAK_GAP ? this.coinStreak + 1 : 0;
        this.sinceCoin = 0;
        const semi = COIN_LADDER[Math.min(this.coinStreak, COIN_LADDER.length - 1)];
        const gain = 0.5 + 0.03 * Math.min(this.coinStreak, 8);
        this.emit(frame.joshActive ? 'coinJosh' : 'coin', gain, 2 ** (semi / 12));
        break;
      }
      case 'pickup':
        this.emit(
          e.kind === 'magnet' ? 'pickupMagnet' : e.kind === 'rocket' ? 'pickupRocket' : 'pickupChappal',
          0.8,
          1,
        );
        break;
      case 'jump':
        this.emit('jump', 0.5, 0.96 + 0.08 * this.random());
        break;
      case 'roll':
        this.emit('roll', 0.55, 1);
        break;
      case 'lane':
        this.emit('lane', 0.35, 0.95 + 0.12 * this.random());
        break;
      case 'hoverboard':
        this.emit('hoverboard', 0.8, 1);
        break;
      case 'hoverboardSaved':
        this.emit('hoverboardSave', 0.85, 1);
        break;
      case 'stumble':
        this.emit('stumble', 0.8, 1);
        // One more stumble soon and the TT has them: the chaser closes in, so sound the alarm.
        this.alarm();
        break;
      case 'rocketLanding':
        this.emit('rocketLanding', 0.7, 1);
        break;
      case 'caught':
        this.emit('caught', 1, e.reason === 'idle' ? 0.9 : 1);
        break;
      default:
        break;
    }
  }

  /** The idle warning and the Josh meter, both edge-triggered off the frame. */
  private edges(frame: DirectorFrame): void {
    if (frame.idleLevel === 'warn' && this.idleWas === 'ok') this.alarm();
    this.idleWas = frame.idleLevel;
    if (frame.joshActive !== this.wasJosh) {
      this.emit(frame.joshActive ? 'joshStart' : 'joshEnd', frame.joshActive ? 0.8 : 0.45, 1);
      this.wasJosh = frame.joshActive;
    }
  }

  /**
   * "About to be caught": the TT's whistle, then his dog barking three times (the user asked for
   * exactly this — "security whistle > 3 bark sounds", played once). Started by the idle warning
   * and by a stumble, the two moments the chaser closes in. Never restarted while it is playing,
   * so one danger is one alarm, and the TT's own periodic whistle is held off until it is done.
   */
  private alarm(): void {
    if (this.alarmT >= 0) return;
    this.alarmT = 0;
    this.alarmNext = 0;
    this.whistleIn = Math.max(this.whistleIn, ALARM_LENGTH + 1);
    this.advanceAlarm(0);
  }

  private advanceAlarm(dt: number): void {
    if (this.alarmT < 0) return;
    this.alarmT += dt;
    while (this.alarmNext < ALARM.length && ALARM[this.alarmNext].at <= this.alarmT + 1e-9) {
      const step = ALARM[this.alarmNext++];
      this.emit(step.cue, step.gain, step.rate);
    }
    if (this.alarmNext >= ALARM.length) this.alarmT = -1;
  }

  private emit(cue: CueName, gain: number, rate: number): void {
    this.duck = Math.max(this.duck, DUCK[cue] ?? 0);
    this.sink.cue(cue, gain, rate);
  }

  private setTempo(bpm: number): void {
    if (Math.abs(bpm - this.tempoSent) < 0.25) return;
    this.tempoSent = bpm;
    this.sink.tempo(bpm);
  }

  private setTransport(running: boolean): void {
    if (this.transportSent === running) return;
    this.transportSent = running;
    this.sink.transport(running);
  }

  /**
   * Forgets what the sink has been told, so the next frame states everything again. The facade
   * calls this when a real engine appears behind it (the first user gesture) — otherwise the
   * epsilon in `flush` would happily withhold every level it had already "sent" to nothing.
   */
  resync(): void {
    for (let i = 0; i < this.channels.length; i++) this.mixSent[this.channels[i]] = -1;
    this.tempoSent = 0;
    this.transportSent = null;
  }

  /** Sends only the mix values that actually moved. */
  private flush(): void {
    for (let i = 0; i < this.channels.length; i++) {
      const c = this.channels[i];
      const v = this.mixOut[c];
      if (Math.abs(v - this.mixSent[c]) < MIX_EPSILON) continue;
      this.mixSent[c] = v;
      this.sink.mix(c, v);
    }
  }
}
