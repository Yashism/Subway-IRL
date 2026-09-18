/**
 * The patches: every sound in the game, built out of oscillators, noise and filters.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md ("Ground rules").
 *
 * This is the audio twin of `world/render/canvasTexture.ts` — procedural assets, drawn in code, so
 * there is nothing to download and nothing to licence. Each patch schedules its own nodes at an
 * absolute time and stops them; the graph they hang off is built once by `engine.ts`.
 *
 * The Indian flavour is in the material, not in an impression of it: a tanpura's four strings
 * plucked in their cycle under a drone, a keherwa-shaped tabla pattern with a real bayan glide,
 * and a minor-pentatonic riff. Everything is synthetic and original.
 */
import type { CueName } from './types';

// ------------------------------------------------------------------ scale and patterns

/** Sa. D3 — low enough to sit under the game, high enough that a laptop speaker finds it. */
export const ROOT = 146.83;

/** Minor pentatonic above Sa, in semitones. Everything melodic in the game is on this. */
export const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19] as const;

/** Footfalls in one cycle of the groove. Eight ticks = one avartan of keherwa = four musical beats. */
export const BAR = 8;

export const PATTERNS = {
  /** Bayan (the low drum): the weight of the cycle, on 1 and on the 4th beat. */
  bass: [1, 0, 0, 0.4, 0, 0, 0.85, 0],
  /** Dayan strokes: 2 = na (open rim), 1 = tin, 0.5 = ke (closed slap). */
  tabla: [2, 0.5, 1, 0.5, 2, 0.5, 1, 1],
  /** The jog tick. One per footfall, accented on the stride so a gait has something to sit in. */
  pulse: [1, 0.5, 0.78, 0.5, 0.9, 0.5, 0.78, 0.5],
  /** The TT running: a hurried, uneven gait, slightly ahead of the player's. */
  steps: [1, 0.6, 0.85, 0.6, 1, 0.6, 0.85, 0.55],
  /** Which tanpura string is plucked, by half-beat; -1 is no pluck. Pa–Sa–Sa–Sa', the classic cycle. */
  tanpura: [0, -1, 1, -1, 2, -1, 3, -1],
} as const;

/** Scale degrees for the riff over two cycles; -1 is a rest. */
export const RIFF = [0, -1, 1, -1, 2, -1, 1, 2, 3, -1, 2, -1, 1, 0, -1, -1] as const;

/** The tanpura's four strings, in semitones from Sa: Pa below, Sa, Sa, Sa above. */
const TANPURA = [-5, 0, 0, 12] as const;

const semi = (n: number) => 2 ** (n / 12);

// ------------------------------------------------------------------ small helpers

/** One shared noise buffer per context — regenerating it per shot would be the only real allocation here. */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const hit = noiseCache.get(ctx);
  if (hit) return hit;
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // Slightly brown-tinted white: a pure white buffer is thin, and everything here gets filtered anyway.
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.035 * w) / 1.035;
    d[i] = w * 0.72 + last * 3.2;
  }
  noiseCache.set(ctx, buf);
  return buf;
}

/**
 * A reverb impulse: exponentially decaying noise. Generated, like everything else — a station hall
 * with no recording in it.
 */
export function makeImpulse(ctx: BaseAudioContext, seconds = 1.1, decay = 3.2): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const u = i / len;
      // A short gap before the tail keeps the early reflections from smearing the transients.
      const pre = u < 0.006 ? u / 0.006 : 1;
      d[i] = (Math.random() * 2 - 1) * (1 - u) ** decay * pre;
    }
  }
  return buf;
}

/**
 * Reverb send amounts a voice may pick from. Fixed taps, not a per-note gain node: a send gain per
 * voice would be an allocation on every coin, and four buckets is all the difference anyone hears.
 */
export const SEND_LEVELS = [0.12, 0.3, 0.55, 0.85] as const;

/** Where a voice goes: its bus, and the pre-built reverb taps (null on a dry bus). */
export interface VoiceCtx {
  ctx: BaseAudioContext;
  out: AudioNode;
  sends: readonly AudioNode[] | null;
}

const MIN = 1e-4;

function gain(ctx: BaseAudioContext, v = 0): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

/**
 * Attack–hold–decay on a gain. Exponential on the way down because that is what a struck thing
 * does, and a linear decay reads as synthetic immediately.
 */
function env(p: AudioParam, t: number, peak: number, attack: number, hold: number, decay: number): number {
  const top = Math.max(MIN * 2, peak);
  p.setValueAtTime(MIN, t);
  p.exponentialRampToValueAtTime(top, t + Math.max(0.0005, attack));
  const end = t + attack + hold + decay;
  if (hold > 0) p.setValueAtTime(top, t + attack + hold);
  p.exponentialRampToValueAtTime(MIN, end);
  p.setValueAtTime(0, end + 0.002);
  return end + 0.002;
}

function osc(ctx: BaseAudioContext, type: OscillatorType, f: number): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = Math.max(MIN, f);
  return o;
}

function noise(v: VoiceCtx, t: number, dur: number): AudioBufferSourceNode {
  const s = v.ctx.createBufferSource();
  s.buffer = noiseBuffer(v.ctx);
  s.loop = true;
  // A random offset so repeated hits are not the same click twice.
  const off = Math.random() * 1.5;
  s.start(t, off);
  s.stop(t + dur + 0.02);
  return s;
}

function filter(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = 1): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = Math.max(MIN, f);
  b.Q.value = q;
  return b;
}

/** Connects a voice's output to its bus and, at the nearest send bucket, to the reverb. */
function route(v: VoiceCtx, node: AudioNode, send = 0): void {
  node.connect(v.out);
  if (!v.sends || send <= 0.03) return;
  let best = 0;
  for (let i = 1; i < SEND_LEVELS.length; i++) {
    if (Math.abs(SEND_LEVELS[i] - send) < Math.abs(SEND_LEVELS[best] - send)) best = i;
  }
  node.connect(v.sends[best]);
}

/**
 * Shaping for a recording that is a texture rather than an event — the train, which was recorded
 * mid-pass and has no approach of its own.
 */
export interface BufferShape {
  /** Seconds of fade-in. Turns a flat stretch of rail noise into something arriving. */
  attack?: number;
  /** Seconds of fade-out at the end. */
  decay?: number;
  /** Playback-rate spread across the sound, rate·(1+d) falling to rate·(1−d): a real Doppler. */
  doppler?: number;
}

/**
 * A recorded sample, through the same bus and the same reverb taps as a synth voice.
 * `rate` is the playback ratio, so the coin ladder and the chaser's whistle ride a recording
 * exactly as they ride an oscillator.
 */
export function playBuffer(
  v: VoiceCtx,
  buffer: AudioBuffer,
  t: number,
  peak: number,
  rate = 1,
  send = 0,
  shape?: BufferShape,
): void {
  if (peak <= 0.0005) return;
  const r = rate > 0 && Number.isFinite(rate) ? Math.min(4, Math.max(0.25, rate)) : 1;
  const s = v.ctx.createBufferSource();
  s.buffer = buffer;
  s.playbackRate.value = r;
  const dur = buffer.duration / r;
  const d = shape?.doppler ?? 0;
  if (d > 0) {
    // Falling pitch across the pass. This is the Doppler the recording does not have: it was made
    // standing beside a train that was already going past, so the shift has to be put back.
    s.playbackRate.setValueAtTime(r * (1 + d), t);
    s.playbackRate.linearRampToValueAtTime(Math.max(0.25, r * (1 - d)), t + dur);
  }
  const g = gain(v.ctx, shape?.attack || shape?.decay ? 0 : peak);
  s.connect(g);
  route(v, g, send);
  if (shape?.attack || shape?.decay) {
    // Linear, not exponential: this is something approaching, not something struck.
    const a = Math.min(shape.attack ?? 0, dur * 0.8);
    const dec = Math.min(shape.decay ?? 0, dur - a);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.max(0.001, a));
    g.gain.setValueAtTime(peak, t + Math.max(0.001, dur - dec));
    g.gain.linearRampToValueAtTime(0, t + dur);
  }
  s.start(t);
  // A hard stop at the end so a long tail cannot outlive the node; slack for a Doppler'd rate.
  s.stop(t + dur * (1 + d) + 0.05);
}

/** A looping bed from a sample — the station ambience, once its file has landed. */
export function loopBuffer(v: VoiceCtx, buffer: AudioBuffer, t: number): AudioBufferSourceNode {
  const s = v.ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.connect(v.out);
  s.start(t);
  return s;
}

// ------------------------------------------------------------------ building blocks

/** A struck tone with a pitch fall — the shape behind drums, thumps and blips. */
function hit(
  v: VoiceCtx,
  t: number,
  type: OscillatorType,
  f0: number,
  f1: number,
  peak: number,
  attack: number,
  decay: number,
  send = 0,
): void {
  const o = osc(v.ctx, type, f0);
  o.frequency.setValueAtTime(Math.max(MIN, f0), t);
  o.frequency.exponentialRampToValueAtTime(Math.max(MIN, f1), t + decay * 0.9);
  const g = gain(v.ctx);
  o.connect(g);
  route(v, g, send);
  const end = env(g.gain, t, peak, attack, 0, decay);
  o.start(t);
  o.stop(end);
}

/** A band of noise with a sweeping centre — every whoosh, scrape and breath in the game. */
function swish(
  v: VoiceCtx,
  t: number,
  f0: number,
  f1: number,
  q: number,
  peak: number,
  attack: number,
  decay: number,
  send = 0,
  type: BiquadFilterType = 'bandpass',
): void {
  const n = noise(v, t, attack + decay);
  const b = filter(v.ctx, type, f0, q);
  b.frequency.setValueAtTime(Math.max(MIN, f0), t);
  b.frequency.exponentialRampToValueAtTime(Math.max(MIN, f1), t + attack + decay);
  const g = gain(v.ctx);
  n.connect(b);
  b.connect(g);
  route(v, g, send);
  env(g.gain, t, peak, attack, 0, decay);
}

/** A struck-metal chime: a fundamental with a slightly stretched partial above it. */
function chime(v: VoiceCtx, t: number, f: number, peak: number, decay: number, send = 0.25): void {
  hit(v, t, 'sine', f, f * 0.995, peak, 0.004, decay, send);
  hit(v, t, 'sine', f * 2.76, f * 2.74, peak * 0.3, 0.003, decay * 0.45, send);
  hit(v, t, 'triangle', f * 5.4, f * 5.3, peak * 0.09, 0.002, decay * 0.2, send);
}

// ------------------------------------------------------------------ the groove

/**
 * Dayan strokes. `na` is the ringing open rim, `tin` a shorter one a fourth up, `ke` the dead slap:
 * the three that carry keherwa. The ring is a pair of inharmonic partials over a noise click —
 * a tabla is a drum whose overtones are tuned, which is exactly why it sounds like a pitch.
 */
export function playTabla(v: VoiceCtx, t: number, stroke: number, g: number, root = ROOT): void {
  if (g <= 0.001) return;
  if (stroke >= 1.5) {
    const f = root * 4;
    hit(v, t, 'sine', f, f * 0.97, 0.55 * g, 0.002, 0.34, 0.3);
    hit(v, t, 'sine', f * 1.5, f * 1.48, 0.2 * g, 0.002, 0.2, 0.25);
    hit(v, t, 'sine', f * 2.35, f * 2.3, 0.09 * g, 0.002, 0.12, 0.2);
    swish(v, t, 2600, 1500, 1.1, 0.13 * g, 0.001, 0.035);
  } else if (stroke >= 0.9) {
    const f = root * 5.33;
    hit(v, t, 'sine', f, f * 0.96, 0.4 * g, 0.002, 0.16, 0.25);
    hit(v, t, 'sine', f * 1.52, f * 1.5, 0.13 * g, 0.002, 0.1, 0.2);
    swish(v, t, 3200, 1900, 1.2, 0.1 * g, 0.001, 0.03);
  } else {
    swish(v, t, 1500, 700, 1.6, 0.22 * g, 0.0015, 0.05);
    hit(v, t, 'sine', root * 3.4, root * 2.6, 0.12 * g, 0.002, 0.045);
  }
}

/**
 * The bayan. Its whole character is the heel pressing the head while it rings, so the pitch bends
 * *down* over the note — that glide is the sound, and a flat low sine is a kick drum instead.
 */
export function playBayan(v: VoiceCtx, t: number, g: number, root = ROOT): void {
  if (g <= 0.001) return;
  const f = root * 0.62;
  const o = osc(v.ctx, 'sine', f * 1.35);
  o.frequency.setValueAtTime(f * 1.35, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.78, t + 0.28);
  const sh = v.ctx.createWaveShaper();
  sh.curve = softCurve(v.ctx);
  const gn = gain(v.ctx);
  o.connect(sh);
  sh.connect(gn);
  route(v, gn, 0.18);
  const end = env(gn.gain, t, 0.5 * g, 0.004, 0.02, 0.42);
  o.start(t);
  o.stop(end);
  swish(v, t, 900, 320, 1.0, 0.06 * g, 0.001, 0.05);
}

/** A gentle saturation, so the bayan has body on a laptop speaker instead of just a thud. */
const curveCache = new WeakMap<BaseAudioContext, Float32Array<ArrayBuffer>>();
function softCurve(ctx: BaseAudioContext): Float32Array<ArrayBuffer> {
  const hitc = curveCache.get(ctx);
  if (hitc) return hitc;
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
  }
  curveCache.set(ctx, c);
  return c;
}

/**
 * The jog tick. Deliberately not a drum: a short, dry, high woodblock that cuts through the groove
 * and the game, because the player has to be able to find it while their own feet are landing.
 */
export function playTick(v: VoiceCtx, t: number, g: number, accent: number): void {
  if (g <= 0.001) return;
  const f = 1180 * (0.94 + 0.12 * accent);
  hit(v, t, 'triangle', f, f * 0.62, 0.7 * g * accent, 0.0008, 0.035);
  hit(v, t, 'sine', f * 0.5, f * 0.35, 0.27 * g * accent, 0.0008, 0.05);
  if (accent > 0.85) hit(v, t, 'sine', 320, 210, 0.3 * g, 0.001, 0.07);
}

/** A tanpura string. Plucked, long, and left to hang — the jvari buzz is the bright partial on top. */
export function playPluck(v: VoiceCtx, t: number, string: number, g: number, root = ROOT): void {
  if (g <= 0.001) return;
  const f = root * semi(TANPURA[string % TANPURA.length]);
  const o = osc(v.ctx, 'sawtooth', f);
  const b = filter(v.ctx, 'lowpass', f * 9, 1.4);
  b.frequency.setValueAtTime(f * 12, t);
  b.frequency.exponentialRampToValueAtTime(f * 3, t + 1.1);
  const gn = gain(v.ctx);
  o.connect(b);
  b.connect(gn);
  route(v, gn, 0.4);
  const end = env(gn.gain, t, 0.26 * g, 0.008, 0.05, 1.5);
  o.start(t);
  o.stop(end);
}

/** The riff: a short plucked string, a little bend into the note so a phrase has a voice. */
export function playRiffNote(v: VoiceCtx, t: number, degree: number, g: number, octave = 0, root = ROOT): void {
  if (g <= 0.001 || degree < 0) return;
  const f = root * 2 * semi(SCALE[degree % SCALE.length] + 12 * octave);
  const o = osc(v.ctx, 'triangle', f);
  o.frequency.setValueAtTime(f * 0.94, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
  const o2 = osc(v.ctx, 'sawtooth', f * 2.003);
  const b = filter(v.ctx, 'lowpass', f * 6, 2.2);
  b.frequency.setValueAtTime(f * 9, t);
  b.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.5);
  const gn = gain(v.ctx);
  const g2 = gain(v.ctx, 0.22);
  o.connect(b);
  o2.connect(g2);
  g2.connect(b);
  b.connect(gn);
  route(v, gn, 0.35);
  const end = env(gn.gain, t, 0.3 * g, 0.006, 0.03, 0.55);
  o.start(t);
  o.stop(end);
  o2.start(t);
  o2.stop(end);
}

/** The Josh shimmer: the riff doubled two octaves up on a bell, plus a shaker on the offbeats. */
export function playJoshNote(v: VoiceCtx, t: number, degree: number, g: number, root = ROOT): void {
  if (g <= 0.001) return;
  if (degree >= 0) chime(v, t, root * 4 * semi(SCALE[degree % SCALE.length]), 0.13 * g, 0.5, 0.45);
  swish(v, t + 0.0, 5200, 3400, 0.9, 0.05 * g, 0.002, 0.06, 0.2, 'highpass');
}

/** The TT's footfalls: a flat slap on a platform, no pitch to speak of. */
export function playFootstep(v: VoiceCtx, t: number, g: number, accent: number): void {
  if (g <= 0.001) return;
  swish(v, t, 900, 220, 0.9, 0.35 * g * accent, 0.002, 0.075, 0.25);
  hit(v, t, 'sine', 120, 70, 0.2 * g * accent, 0.002, 0.09);
}

/** Lub-dub. The idle warning's clock. */
export function playHeartbeat(v: VoiceCtx, t: number, g: number): void {
  if (g <= 0.001) return;
  hit(v, t, 'sine', 78, 42, 0.45 * g, 0.006, 0.19);
  hit(v, t + 0.19, 'sine', 66, 38, 0.3 * g, 0.006, 0.22);
}

// ------------------------------------------------------------------ the held layers

export interface Layer {
  /** What the engine automates to set this layer's level. */
  gain: GainNode;
  /** Sources to start once the context is running. */
  start(t: number): void;
}

/** A slow LFO on a parameter — the life in anything that would otherwise be a held tone. */
function lfo(ctx: BaseAudioContext, target: AudioParam, hz: number, depth: number, sources: OscillatorNode[]): void {
  const o = osc(ctx, 'sine', hz);
  const g = gain(ctx, depth);
  o.connect(g);
  g.connect(target);
  sources.push(o);
}

/** The tanpura's sustained body under the plucks: the sruti box, essentially. */
export function buildDrone(ctx: BaseAudioContext, dest: AudioNode, root = ROOT): Layer {
  const out = gain(ctx, 0);
  const lp = filter(ctx, 'lowpass', 900, 0.8);
  lp.connect(out);
  out.connect(dest);
  const sources: OscillatorNode[] = [];
  // Sa two octaves down, Sa, and Pa: the drone's whole harmonic claim.
  // Levels are low on purpose: a drone is continuous, so at the level of a drum hit it would be
  // the only thing anyone hears. It has to sit under the groove, not beside it.
  for (const [mult, type, level, detune] of [
    [0.5, 'sine', 0.16, 0],
    [1, 'sawtooth', 0.05, -4],
    [1, 'sawtooth', 0.05, 5],
    [semi(7), 'sine', 0.065, 0],
    [2, 'sine', 0.026, 3],
  ] as const) {
    const o = osc(ctx, type, root * mult);
    o.detune.value = detune;
    const g = gain(ctx, level);
    o.connect(g);
    g.connect(lp);
    sources.push(o);
    lfo(ctx, g.gain, 0.07 + sources.length * 0.013, level * 0.25, sources);
  }
  lfo(ctx, lp.frequency, 0.05, 260, sources);
  return { gain: out, start: (t) => sources.forEach((s) => s.start(t)) };
}

/** Station bed: traffic hum low down, a crowd murmuring in a band above it. */
export function buildAmbience(ctx: BaseAudioContext, dest: AudioNode): Layer {
  const out = gain(ctx, 0);
  out.connect(dest);
  const sources: (AudioBufferSourceNode | OscillatorNode)[] = [];
  const oscs: OscillatorNode[] = [];

  const hum = ctx.createBufferSource();
  hum.buffer = noiseBuffer(ctx);
  hum.loop = true;
  const humLp = filter(ctx, 'lowpass', 220, 0.7);
  const humG = gain(ctx, 0.5);
  hum.connect(humLp);
  humLp.connect(humG);
  humG.connect(out);
  sources.push(hum);

  const crowd = ctx.createBufferSource();
  crowd.buffer = noiseBuffer(ctx);
  crowd.loop = true;
  const bp = filter(ctx, 'bandpass', 950, 1.1);
  const crowdG = gain(ctx, 0.3);
  crowd.connect(bp);
  bp.connect(crowdG);
  crowdG.connect(out);
  sources.push(crowd);
  // Two LFOs at unrelated rates: the swell never repeats on a hearable period.
  lfo(ctx, crowdG.gain, 0.11, 0.16, oscs);
  lfo(ctx, crowdG.gain, 0.037, 0.1, oscs);
  lfo(ctx, bp.frequency, 0.06, 240, oscs);

  return {
    gain: out,
    start: (t) => {
      for (const s of sources) (s as AudioBufferSourceNode).start(t);
      for (const o of oscs) o.start(t);
    },
  };
}

/** Rail rumble and the wind of running: how fast the run feels, without a number. */
export function buildWind(ctx: BaseAudioContext, dest: AudioNode): Layer {
  const out = gain(ctx, 0);
  out.connect(dest);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const hp = filter(ctx, 'highpass', 520, 0.6);
  const hpG = gain(ctx, 0.09);
  src.connect(hp);
  hp.connect(hpG);
  hpG.connect(out);
  const lp = filter(ctx, 'lowpass', 110, 1.1);
  const lpG = gain(ctx, 0.22);
  src.connect(lp);
  lp.connect(lpG);
  lpG.connect(out);
  const oscs: OscillatorNode[] = [];
  lfo(ctx, hpG.gain, 0.23, 0.03, oscs);
  return {
    gain: out,
    start: (t) => {
      src.start(t);
      for (const o of oscs) o.start(t);
    },
  };
}

/** The hoverboard: a detuned hum with a wobble, the way a cheap motor sounds. */
export function buildHover(ctx: BaseAudioContext, dest: AudioNode): Layer {
  const out = gain(ctx, 0);
  const lp = filter(ctx, 'lowpass', 850, 3);
  lp.connect(out);
  out.connect(dest);
  const oscs: OscillatorNode[] = [];
  for (const [f, level] of [[104, 0.3], [107.5, 0.26], [211, 0.12]] as const) {
    const o = osc(ctx, 'sawtooth', f);
    const g = gain(ctx, level);
    o.connect(g);
    g.connect(lp);
    oscs.push(o);
  }
  lfo(ctx, lp.frequency, 5.5, 220, oscs);
  return { gain: out, start: (t) => oscs.forEach((o) => o.start(t)) };
}

/** Rocket thrust: resonant noise over a sub. */
export function buildRocket(ctx: BaseAudioContext, dest: AudioNode): Layer {
  const out = gain(ctx, 0);
  out.connect(dest);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  const lp = filter(ctx, 'lowpass', 620, 4.5);
  const g = gain(ctx, 0.5);
  src.connect(lp);
  lp.connect(g);
  g.connect(out);
  const sub = osc(ctx, 'sine', 58);
  const subG = gain(ctx, 0.3);
  sub.connect(subG);
  subG.connect(out);
  const oscs: OscillatorNode[] = [sub];
  lfo(ctx, lp.frequency, 7.5, 140, oscs);
  return {
    gain: out,
    start: (t) => {
      src.start(t);
      for (const o of oscs) o.start(t);
    },
  };
}

/** The magnet: a high shimmer that pulses, so the pull is audible. */
export function buildMagnet(ctx: BaseAudioContext, dest: AudioNode): Layer {
  const out = gain(ctx, 0);
  out.connect(dest);
  const oscs: OscillatorNode[] = [];
  for (const [f, level] of [[1760, 0.09], [2640, 0.05]] as const) {
    const o = osc(ctx, 'sine', f);
    const g = gain(ctx, level);
    o.connect(g);
    g.connect(out);
    oscs.push(o);
    lfo(ctx, g.gain, 6.5, level * 0.9, oscs);
  }
  return { gain: out, start: (t) => oscs.forEach((o) => o.start(t)) };
}

// ------------------------------------------------------------------ one-shot cues

/**
 * Every one-shot, by name. `rate` is a pitch ratio: the coin ladder rides it up a streak, and the
 * chaser's whistle rides it up as he closes.
 */
export function playCue(v: VoiceCtx, cue: CueName, t: number, g: number, rate: number): void {
  const r = rate > 0 && Number.isFinite(rate) ? rate : 1;
  const a = Math.max(0, Math.min(2, g));
  if (a <= 0.0005) return;
  switch (cue) {
    case 'coin':
      chime(v, t, 880 * r, 0.48 * a, 0.28, 0.3);
      hit(v, t, 'triangle', 2400 * r, 1800 * r, 0.075 * a, 0.001, 0.02);
      break;
    case 'coinJosh':
      chime(v, t, 880 * r, 0.42 * a, 0.34, 0.4);
      chime(v, t + 0.012, 1760 * r, 0.2 * a, 0.42, 0.5);
      break;
    case 'pickupMagnet':
      hit(v, t, 'triangle', 300 * r, 1300 * r, 0.3 * a, 0.01, 0.3, 0.35);
      chime(v, t + 0.14, 1318 * r, 0.2 * a, 0.5, 0.4);
      break;
    case 'pickupRocket':
      swish(v, t, 200, 4200, 1.3, 0.4 * a, 0.16, 0.3, 0.3);
      hit(v, t, 'sine', 70, 180, 0.55 * a, 0.02, 0.45);
      chime(v, t + 0.26, 1760 * r, 0.24 * a, 0.5, 0.5);
      break;
    case 'pickupChappal':
      // A slipper landing: wood, then leather.
      hit(v, t, 'triangle', 430 * r, 190 * r, 0.62 * a, 0.001, 0.1, 0.2);
      swish(v, t, 2200, 600, 1.4, 0.4 * a, 0.001, 0.08, 0.2);
      chime(v, t + 0.1, 1046 * r, 0.2 * a, 0.35, 0.3);
      break;
    case 'rocketLanding':
      hit(v, t, 'sine', 150, 42, 0.58 * a, 0.004, 0.5, 0.3);
      swish(v, t, 1400, 260, 0.8, 0.26 * a, 0.004, 0.45, 0.4);
      break;
    case 'joshStart':
      for (let i = 0; i < 3; i++) {
        const f = ROOT * 2 * semi(SCALE[i * 2]);
        const o = osc(v.ctx, 'sawtooth', f * 0.5);
        o.frequency.setValueAtTime(f * 0.5, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.42);
        const b = filter(v.ctx, 'lowpass', 900, 3);
        b.frequency.setValueAtTime(400, t);
        b.frequency.exponentialRampToValueAtTime(3600, t + 0.45);
        const gn = gain(v.ctx);
        o.connect(b);
        b.connect(gn);
        route(v, gn, 0.4);
        const end = env(gn.gain, t, 0.15 * a, 0.12, 0.1, 0.4);
        o.start(t);
        o.stop(end);
      }
      break;
    case 'joshEnd':
      hit(v, t, 'triangle', ROOT * 4, ROOT * 2, 0.5 * a, 0.01, 0.4, 0.35);
      break;
    case 'jump':
      hit(v, t, 'triangle', 280 * r, 620 * r, 0.55 * a, 0.004, 0.12);
      swish(v, t, 700, 2600, 0.8, 0.38 * a, 0.01, 0.13);
      break;
    case 'land':
      hit(v, t, 'sine', 190 * r, 78, 0.7 * a, 0.002, 0.14, 0.15);
      swish(v, t, 1100, 300, 0.9, 0.34 * a, 0.001, 0.07);
      break;
    case 'roll':
      // A wide band, not a narrow one: at any Q above about 1 a falling sweep stops being a scrape
      // on gravel and starts being a slide whistle.
      swish(v, t, 2600, 380, 0.7, 0.55 * a, 0.01, 0.34, 0.2);
      hit(v, t + 0.26, 'sine', 150, 80, 0.3 * a, 0.004, 0.1);
      break;
    case 'lane':
      swish(v, t, 700 * r, 3600 * r, 0.8, 1.5 * a, 0.012, 0.11, 0.15);
      break;
    case 'stumble':
      // A clatter, not a tone: three knocks falling over each other.
      hit(v, t, 'triangle', 320, 120, 0.4 * a, 0.001, 0.1);
      swish(v, t, 1800, 400, 1.0, 0.35 * a, 0.001, 0.13, 0.25);
      hit(v, t + 0.07, 'triangle', 240, 95, 0.3 * a, 0.001, 0.09);
      hit(v, t + 0.13, 'sine', 150, 62, 0.35 * a, 0.002, 0.24, 0.2);
      break;
    case 'hoverboard':
      // Air first, motor second: the riser has to be the thing you hear, or it reads as a bass note.
      swish(v, t, 300, 3800, 1.1, 0.66 * a, 0.14, 0.34, 0.3);
      swish(v, t, 1800, 5200, 0.8, 0.24 * a, 0.2, 0.3, 0.35, 'highpass');
      hit(v, t + 0.1, 'sawtooth', 90, 150, 0.15 * a, 0.05, 0.4);
      break;
    case 'hoverboardSave':
      chime(v, t, 1318 * r, 0.3 * a, 0.5, 0.5);
      chime(v, t + 0.07, 1760 * r, 0.24 * a, 0.55, 0.5);
      swish(v, t, 4000, 900, 1.2, 0.2 * a, 0.002, 0.3, 0.4);
      break;
    case 'whistle':
    case 'introWhistle': {
      // A pea whistle: two close tones, both warbling fast. The beat between them is the shrill.
      const dur = cue === 'introWhistle' ? 0.85 : 0.42;
      const send = cue === 'introWhistle' ? 0.75 : 0.35;
      for (const [mult, level] of [[1, 0.2], [1.26, 0.13], [2.01, 0.05]] as const) {
        const f = 2100 * r * mult;
        const o = osc(v.ctx, 'sine', f);
        const gn = gain(v.ctx);
        const wob = osc(v.ctx, 'sine', 27);
        const wobG = gain(v.ctx, f * 0.035);
        wob.connect(wobG);
        wobG.connect(o.frequency);
        o.connect(gn);
        route(v, gn, send);
        const end = env(gn.gain, t, level * a, 0.02, dur * 0.55, dur * 0.4);
        o.start(t);
        o.stop(end);
        wob.start(t);
        wob.stop(end);
      }
      swish(v, t, 2600, 3400, 2.5, 0.05 * a, 0.02, dur, send);
      break;
    }
    case 'idleWarn':
      hit(v, t, 'sine', 62, 44, 0.5 * a, 0.08, 0.6, 0.3);
      playHeartbeat(v, t + 0.1, 0.6 * a);
      break;
    case 'caught': {
      // The sting: a cluster sliding down a tritone, over a hit and a long reversed-sounding tail.
      for (const [mult, level] of [[1, 0.095], [semi(3), 0.075], [semi(6), 0.06], [0.5, 0.11]] as const) {
        const f = ROOT * 2 * mult;
        const o = osc(v.ctx, 'sawtooth', f);
        o.frequency.setValueAtTime(f, t);
        o.frequency.exponentialRampToValueAtTime(f * semi(-6), t + 1.1);
        const b = filter(v.ctx, 'lowpass', 2600, 1.4);
        b.frequency.setValueAtTime(3200, t);
        b.frequency.exponentialRampToValueAtTime(420, t + 1.2);
        const gn = gain(v.ctx);
        o.connect(b);
        b.connect(gn);
        route(v, gn, 0.6);
        const end = env(gn.gain, t, level * a, 0.012, 0.3, 0.95);
        o.start(t);
        o.stop(end);
      }
      hit(v, t, 'sine', 120, 38, 0.45 * a, 0.003, 0.7, 0.4);
      swish(v, t, 5200, 700, 0.7, 0.2 * a, 0.006, 1.2, 0.7);
      break;
    }
    case 'trainPass': {
      // Doppler: the band falls through the pass, the level swells and goes, and the bogies clack.
      const dur = 1.7;
      const n = noise(v, t, dur);
      const b = filter(v.ctx, 'bandpass', 520 * r, 0.7);
      b.frequency.setValueAtTime(760 * r, t);
      b.frequency.exponentialRampToValueAtTime(300 * r, t + dur);
      const gn = gain(v.ctx);
      n.connect(b);
      b.connect(gn);
      route(v, gn, 0.4);
      env(gn.gain, t, 0.5 * a, dur * 0.42, 0.04, dur * 0.52);
      const rum = noise(v, t, dur);
      const lp = filter(v.ctx, 'lowpass', 130, 1.2);
      const rg = gain(v.ctx);
      rum.connect(lp);
      lp.connect(rg);
      route(v, rg, 0.2);
      env(rg.gain, t, 0.55 * a, dur * 0.4, 0.05, dur * 0.5);
      for (let i = 0; i < 12; i++) {
        const u = i / 12;
        const at = t + 0.1 + u * (dur - 0.25);
        const near = 1 - Math.abs(u - 0.45) * 1.7;
        if (near <= 0.05) continue;
        swish(v, at, 1900 * (1.1 - 0.35 * u), 700, 1.4, 0.12 * a * near, 0.001, 0.05, 0.25);
      }
      break;
    }
    case 'crow': {
      // Two harsh caws. Vibrato plus a formant band is the whole trick.
      for (const off of [0, 0.17]) {
        const f = 700 * r * (off ? 0.92 : 1);
        const o = osc(v.ctx, 'sawtooth', f);
        o.frequency.setValueAtTime(f * 1.15, t + off);
        o.frequency.exponentialRampToValueAtTime(f * 0.8, t + off + 0.16);
        const vib = osc(v.ctx, 'sine', 42);
        const vibG = gain(v.ctx, f * 0.09);
        vib.connect(vibG);
        vibG.connect(o.frequency);
        const b = filter(v.ctx, 'bandpass', 1700, 2.2);
        const gn = gain(v.ctx);
        o.connect(b);
        b.connect(gn);
        route(v, gn, 0.6);
        const end = env(gn.gain, t + off, 0.48 * a, 0.012, 0.03, 0.14);
        o.start(t + off);
        o.stop(end);
        vib.start(t + off);
        vib.stop(end);
      }
      break;
    }
    case 'tannoy': {
      // A station PA: a two-tone chime squeezed into a telephone band and pushed into a big room.
      const band = filter(v.ctx, 'bandpass', 1500, 0.9);
      const gn = gain(v.ctx, 1);
      band.connect(gn);
      route(v, gn, 0.85);
      const sub: VoiceCtx = { ctx: v.ctx, out: band, sends: null };
      chime(sub, t, 880 * r, 0.5 * a, 0.7, 0);
      chime(sub, t + 0.34, 660 * r, 0.5 * a, 0.9, 0);
      break;
    }
    case 'countdown':
      hit(v, t, 'sine', 760 * r, 760 * r, 0.72 * a, 0.004, 0.14, 0.2);
      break;
    case 'go':
      hit(v, t, 'sine', 1140 * r, 1140 * r, 0.55 * a, 0.004, 0.16, 0.25);
      hit(v, t + 0.02, 'sine', 1710 * r, 1710 * r, 0.3 * a, 0.004, 0.22, 0.3);
      swish(v, t, 900, 5000, 0.9, 0.3 * a, 0.03, 0.2, 0.3);
      break;
    case 'summary':
      for (let i = 0; i < 3; i++) chime(v, t + i * 0.13, ROOT * 2 * semi(SCALE[i * 2]), 0.2 * a, 1.1, 0.6);
      break;
    case 'uiClick':
      hit(v, t, 'triangle', 1500 * r, 900 * r, 0.45 * a, 0.0008, 0.035);
      break;
    case 'uiBack':
      hit(v, t, 'triangle', 740 * r, 440 * r, 0.45 * a, 0.0008, 0.05);
      break;
    case 'uiConfirm':
      chime(v, t, 880 * r, 0.26 * a, 0.16, 0.2);
      chime(v, t + 0.07, 1318 * r, 0.26 * a, 0.24, 0.25);
      break;
    case 'moveOk':
      chime(v, t, ROOT * 4 * semi(0), 0.3 * a, 0.3, 0.3);
      chime(v, t + 0.08, ROOT * 4 * semi(5), 0.27 * a, 0.42, 0.35);
      break;
    case 'moveFanfare':
      for (let i = 0; i < 5; i++) chime(v, t + i * 0.09, ROOT * 4 * semi(SCALE[i]), 0.2 * a, 0.5, 0.4);
      break;
    case 'brush':
      // A loaded brush dragged across paper: a band of noise that opens and closes fast.
      swish(v, t, 600, 3200, 0.7, 0.8 * a, 0.03, 0.16, 0.3);
      swish(v, t + 0.02, 4000, 1200, 1.2, 0.35 * a, 0.01, 0.12, 0.2);
      break;
    case 'unfurl':
      swish(v, t, 300, 2600, 0.6, 0.38 * a, 0.22, 0.5, 0.35, 'lowpass');
      for (let i = 0; i < 9; i++) {
        swish(v, t + 0.04 + i * 0.055 * (1 + i * 0.1), 3000, 1800, 3, 0.12 * a, 0.001, 0.02, 0.2);
      }
      break;
  }
}
