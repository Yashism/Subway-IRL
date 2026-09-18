/**
 * A tiny offline Web Audio implementation, so the audio engine can be rendered to samples in Node.
 *
 * Node has no `OfflineAudioContext` and jsdom does not implement Web Audio, so the alternative was
 * a native dependency the whole team would have to install. This renders the exact graph
 * `engine.ts` builds — the same node types, the same AudioParam automation, the same scheduling —
 * one sample at a time, and hands back a Float32Array.
 *
 * What it is NOT: a conformant implementation. It covers the nodes this game uses and nothing else.
 * `ConvolverNode` and `DynamicsCompressorNode` are pass-throughs (a real FIR over a 1.1 s impulse
 * would make the tests minutes long), so tests that care about the limiter or the reverb tail
 * belong in the browser — `audio-lab.html` renders through Chrome's real OfflineAudioContext and
 * draws what comes back.
 */

type Time = number;

// ------------------------------------------------------------------ automation

type Ev =
  | { k: 'set'; t: Time; v: number }
  | { k: 'lin'; t: Time; v: number }
  | { k: 'exp'; t: Time; v: number }
  | { k: 'target'; t: Time; v: number; tc: number };

export class FakeParam {
  private events: Ev[] = [];
  private base: number;
  readonly mods: FakeNode[] = [];

  constructor(public defaultValue: number) {
    this.base = defaultValue;
  }

  get value(): number {
    return this.base;
  }

  set value(v: number) {
    this.base = v;
  }

  private add(e: Ev): FakeParam {
    this.events.push(e);
    this.events.sort((a, b) => a.t - b.t);
    return this;
  }

  setValueAtTime(v: number, t: Time): FakeParam {
    return this.add({ k: 'set', t, v });
  }

  linearRampToValueAtTime(v: number, t: Time): FakeParam {
    return this.add({ k: 'lin', t, v });
  }

  exponentialRampToValueAtTime(v: number, t: Time): FakeParam {
    if (v === 0) throw new RangeError('exponentialRampToValueAtTime: target must be non-zero');
    return this.add({ k: 'exp', t, v });
  }

  setTargetAtTime(v: number, t: Time, tc: number): FakeParam {
    return this.add({ k: 'target', t, v, tc });
  }

  cancelScheduledValues(t: Time): FakeParam {
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }

  /** The scheduled curve at `t`, before modulation. */
  scheduled(t: Time): number {
    const evs = this.events;
    if (evs.length === 0 || t < evs[0].t) return this.base;
    let i = 0;
    while (i + 1 < evs.length && evs[i + 1].t <= t) i++;
    const cur = evs[i];
    const prevValue = i === 0 ? this.base : valueOf(evs[i - 1], this.base);
    const next = evs[i + 1];

    if (cur.k === 'target') {
      const start = prevValue;
      return cur.v + (start - cur.v) * Math.exp(-(t - cur.t) / Math.max(1e-6, cur.tc));
    }
    // A ramp ahead of us interpolates from where the last event left the value.
    if (next && (next.k === 'lin' || next.k === 'exp') && t >= cur.t) {
      const from = valueOf(cur, this.base);
      const u = (t - cur.t) / Math.max(1e-9, next.t - cur.t);
      if (next.k === 'lin') return from + (next.v - from) * u;
      const a = Math.max(1e-9, Math.abs(from)) * Math.sign(from || 1);
      return a * (next.v / a) ** u;
    }
    return valueOf(cur, this.base);
  }

  sample(i: number, t: Time): number {
    let v = this.scheduled(t);
    for (const m of this.mods) v += m.sample(i, t);
    return v;
  }
}

function valueOf(e: Ev, base: number): number {
  return e.k === 'target' ? e.v : (e.v ?? base);
}

// ------------------------------------------------------------------ nodes

export abstract class FakeNode {
  readonly inputs: FakeNode[] = [];
  protected memoIndex = -1;
  protected memoValue = 0;

  constructor(readonly context: FakeOfflineContext) {}

  connect<T extends FakeNode | FakeParam>(target: T): T {
    if (target instanceof FakeParam) target.mods.push(this);
    else (target as FakeNode).inputs.push(this);
    return target;
  }

  disconnect(): void {
    // Nothing in the engine disconnects; kept so the shape matches.
  }

  sample(i: number, t: Time): number {
    if (this.memoIndex === i) return this.memoValue;
    this.memoIndex = i;
    this.memoValue = this.compute(i, t);
    return this.memoValue;
  }

  protected sumInputs(i: number, t: Time): number {
    let s = 0;
    for (const n of this.inputs) s += n.sample(i, t);
    return s;
  }

  protected abstract compute(i: number, t: Time): number;
}

class Destination extends FakeNode {
  protected compute(i: number, t: Time): number {
    return this.sumInputs(i, t);
  }
}

class Gain extends FakeNode {
  readonly gain = new FakeParam(1);
  protected compute(i: number, t: Time): number {
    return this.sumInputs(i, t) * this.gain.sample(i, t);
  }
}

class Pass extends FakeNode {
  protected compute(i: number, t: Time): number {
    return this.sumInputs(i, t);
  }
}

/** Stands in for the limiter. Pass-through: see the file header. */
class Compressor extends Pass {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
  readonly reduction = 0;
}

/** Stands in for the reverb. Pass-through at a low level: see the file header. */
class Convolver extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
  protected compute(i: number, t: Time): number {
    return this.sumInputs(i, t) * 0.2;
  }
}

class WaveShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: 'none' | '2x' | '4x' = 'none';
  protected compute(i: number, t: Time): number {
    const x = this.sumInputs(i, t);
    const c = this.curve;
    if (!c || c.length === 0) return x;
    const u = (Math.max(-1, Math.min(1, x)) + 1) * 0.5 * (c.length - 1);
    const lo = Math.floor(u);
    const hi = Math.min(c.length - 1, lo + 1);
    return c[lo] + (c[hi] - c[lo]) * (u - lo);
  }
}

class Oscillator extends FakeNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  private phase = 0;
  private startAt = Infinity;
  private stopAt = Infinity;

  start(when = 0): void {
    this.startAt = when;
  }

  stop(when = 0): void {
    this.stopAt = when;
  }

  protected compute(i: number, t: Time): number {
    if (t < this.startAt || t >= this.stopAt) return 0;
    const f = Math.max(0, this.frequency.sample(i, t) * 2 ** (this.detune.sample(i, t) / 1200));
    const p = this.phase;
    this.phase = (this.phase + f / this.context.sampleRate) % 1;
    switch (this.type) {
      case 'sawtooth':
        return 2 * p - 1;
      case 'square':
        return p < 0.5 ? 1 : -1;
      case 'triangle':
        return 4 * Math.abs(p - 0.5) - 1;
      default:
        return Math.sin(2 * Math.PI * p);
    }
  }
}

class BufferSource extends FakeNode {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeParam(1);
  readonly detune = new FakeParam(0);
  private startAt = Infinity;
  private stopAt = Infinity;
  private offset = 0;
  private pos = 0;

  start(when = 0, offset = 0): void {
    this.startAt = when;
    this.offset = offset;
  }

  stop(when = 0): void {
    this.stopAt = when;
  }

  protected compute(i: number, t: Time): number {
    if (t < this.startAt || t >= this.stopAt || !this.buffer) return 0;
    const data = this.buffer.getChannelData(0);
    if (this.pos === 0) this.pos = this.offset * this.buffer.sampleRate;
    const idx = Math.floor(this.pos);
    this.pos += this.playbackRate.sample(i, t);
    if (idx >= data.length) {
      if (!this.loop) return 0;
      this.pos = this.pos % data.length;
      return data[Math.floor(this.pos)] ?? 0;
    }
    return data[idx] ?? 0;
  }
}

/** RBJ cookbook biquad, coefficients recomputed each sample so a swept filter really sweeps. */
class Biquad extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  readonly gain = new FakeParam(0);
  readonly detune = new FakeParam(0);
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  protected compute(i: number, t: Time): number {
    const x = this.sumInputs(i, t);
    const sr = this.context.sampleRate;
    const f = Math.min(sr * 0.49, Math.max(10, this.frequency.sample(i, t)));
    const q = Math.max(0.0001, this.Q.sample(i, t));
    const w = (2 * Math.PI * f) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * q);
    let b0: number, b1: number, b2: number;
    const a0 = 1 + alpha;
    const a1 = -2 * cw;
    const a2 = 1 - alpha;
    if (this.type === 'highpass') {
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
    } else if (this.type === 'bandpass') {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else {
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
    }
    const y = (b0 / a0) * x + (b1 / a0) * this.x1 + (b2 / a0) * this.x2 - (a1 / a0) * this.y1 - (a2 / a0) * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return Number.isFinite(y) ? y : 0;
  }
}

export class FakeAudioBuffer {
  private readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(ch: number): Float32Array {
    return this.data[ch];
  }
}

// ------------------------------------------------------------------ the context

export class FakeOfflineContext {
  readonly destination: FakeNode;
  currentTime = 0;
  /** Set once `startRendering` has run, so a test can see the context was used. */
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly created: Record<string, number> = {};

  constructor(readonly length: number, readonly sampleRate = 22050) {
    this.destination = new Destination(this);
  }

  private tally(kind: string): void {
    this.created[kind] = (this.created[kind] ?? 0) + 1;
  }

  createGain(): Gain {
    this.tally('gain');
    return new Gain(this);
  }
  createOscillator(): Oscillator {
    this.tally('oscillator');
    return new Oscillator(this);
  }
  createBiquadFilter(): Biquad {
    this.tally('biquad');
    return new Biquad(this);
  }
  createBufferSource(): BufferSource {
    this.tally('bufferSource');
    return new BufferSource(this);
  }
  createConvolver(): Convolver {
    this.tally('convolver');
    return new Convolver(this);
  }
  createDynamicsCompressor(): Compressor {
    this.tally('compressor');
    return new Compressor(this);
  }
  createWaveShaper(): WaveShaper {
    this.tally('waveShaper');
    return new WaveShaper(this);
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    this.tally('buffer');
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  /** Advances `currentTime` without rendering, for scheduling a sequence before a render. */
  advanceTo(t: number): void {
    this.currentTime = t;
  }

  /**
   * Renders from 0 to `length` samples. `onSample` is where a test drives the engine's own clock:
   * it is called at each frame boundary with the context time, exactly as a game loop would.
   */
  render(onFrame?: (t: number) => void, frameHz = 60): Float32Array {
    const out = new Float32Array(this.length);
    const framePeriod = this.sampleRate / frameHz;
    let nextFrame = 0;
    for (let i = 0; i < this.length; i++) {
      const t = i / this.sampleRate;
      this.currentTime = t;
      if (onFrame && i >= nextFrame) {
        onFrame(t);
        nextFrame += framePeriod;
      }
      out[i] = this.destination.sample(i, t);
    }
    this.state = 'running';
    return out;
  }
}

/** The engine only ever sees a `BaseAudioContext`; this is the cast that says so. */
export const asContext = (c: FakeOfflineContext): BaseAudioContext => c as unknown as BaseAudioContext;

// ------------------------------------------------------------------ measuring what came out

export interface Measurement {
  peak: number;
  /** Root-mean-square over the whole buffer. */
  rms: number;
  /** Zero crossings per second — high for noise, low and steady for a tone. */
  crossingsPerSec: number;
  /** Sample index of the peak, as a fraction of the buffer. */
  peakAt: number;
  /** True if any sample is outside ±1. */
  clipped: boolean;
  /**
   * Normalised autocorrelation peak: how periodic the loudest part is. A whistle or a chime sits
   * near 1, a whoosh or a slap well below it. This is how a test can tell a tone from noise.
   */
  tonality: number;
  /** RMS of the first quarter over the second: well above 1 is percussive, below 1 is a swell. */
  frontLoad: number;
}

function rmsOf(buf: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/**
 * Normalised autocorrelation peak over a window around the loudest moment. Normalising by BOTH
 * windows' energy is what stops a decaying envelope reading as a pitch — the naive version calls
 * every drum hit tonal. Lags cover 120 Hz to 4 kHz, which is where a pitch anyone hears lives.
 */
function tonalityOf(buf: Float32Array, peakIdx: number, sampleRate: number): number {
  const win = Math.min(2048, buf.length);
  const start = Math.max(0, Math.min(buf.length - win, peakIdx - Math.floor(win * 0.05)));
  const maxLag = Math.min(Math.floor(win / 2), Math.floor(sampleRate / 120));
  const minLag = Math.max(2, Math.floor(sampleRate / 4000));
  let best = 0;
  for (let lag = minLag; lag < maxLag; lag++) {
    let r = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i + lag < win; i++) {
      const a = buf[start + i];
      const b = buf[start + i + lag];
      r += a * b;
      ea += a * a;
      eb += b * b;
    }
    const denom = Math.sqrt(ea * eb);
    if (denom < 1e-12) continue;
    const norm = r / denom;
    if (norm > best) best = norm;
  }
  return best;
}

export function measure(buf: Float32Array, sampleRate: number): Measurement {
  let peak = 0;
  let peakIdx = 0;
  let sum = 0;
  let crossings = 0;
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    const a = Math.abs(v);
    if (a > peak) {
      peak = a;
      peakIdx = i;
    }
    sum += v * v;
    if ((prev <= 0 && v > 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  const q = Math.max(1, Math.floor(buf.length / 4));
  return {
    peak,
    rms: Math.sqrt(sum / Math.max(1, buf.length)),
    crossingsPerSec: (crossings * sampleRate) / Math.max(1, buf.length),
    peakAt: buf.length ? peakIdx / buf.length : 0,
    clipped: peak > 1,
    tonality: tonalityOf(buf, peakIdx, sampleRate),
    frontLoad: rmsOf(buf, 0, q) / Math.max(1e-9, rmsOf(buf, q, 2 * q)),
  };
}
