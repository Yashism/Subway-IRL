/**
 * Fetching and decoding the sample files, with the synth as the safety net.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md ("Loading policy").
 *
 * The contract is the whole point: **nothing here ever rejects or throws**. A 404, a corrupt file,
 * a codec the browser will not touch, an offline player, a `decodeAudioData` that fails silently —
 * all of it ends the same way, with `get()` returning null and the engine playing the synth patch
 * instead. A missing file must cost quality, never a sound and never a frame.
 */
import { AUDIO_BASE, AUDIO_FORMATS } from './manifest';

export interface SampleBankOptions {
  /** Default: `/audio/`. */
  base?: string;
  /** Default: `globalThis.fetch`. Injected in tests. */
  fetch?: typeof fetch;
  /**
   * File extension to ask for. Default: whatever the browser admits to playing, ogg first.
   * Injected in tests so they never depend on a codec being present.
   */
  ext?: string;
  /** Default: `ctx.decodeAudioData`. Injected in tests, where no decoder exists. */
  decode?: (data: ArrayBuffer) => Promise<AudioBuffer>;
  /** Called after each name settles, loaded or not — the engine uses it to swap the bed in. */
  onLoaded?: (name: string, buffer: AudioBuffer | null) => void;
}

/** ogg where it is supported, m4a otherwise. Falls back to ogg when nothing can be asked. */
export function pickFormat(): string {
  try {
    const el = typeof document !== 'undefined' ? document.createElement('audio') : null;
    if (el && typeof el.canPlayType === 'function') {
      for (const f of AUDIO_FORMATS) {
        // '' means no, 'maybe'/'probably' mean yes. Chrome says 'probably' for both.
        if (el.canPlayType(f.mime) !== '') return f.ext;
      }
    }
  } catch {
    // No DOM, or a hostile one: ogg is the better guess for anything that is not Safari.
  }
  return AUDIO_FORMATS[0].ext;
}

export class SampleBank {
  /** Names that were asked for and could not be had. The lab shows them; the engine ignores them. */
  readonly failed = new Set<string>();

  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly base: string;
  private readonly ext: string;
  private readonly fetcher: typeof fetch | null;
  private readonly decoder: ((data: ArrayBuffer) => Promise<AudioBuffer>) | null;
  private readonly onLoaded: ((name: string, buffer: AudioBuffer | null) => void) | undefined;

  constructor(ctx: BaseAudioContext, options: SampleBankOptions = {}) {
    this.base = options.base ?? AUDIO_BASE;
    this.ext = options.ext ?? pickFormat();
    this.fetcher =
      options.fetch ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.decoder =
      options.decode ??
      (typeof ctx.decodeAudioData === 'function' ? (d) => ctx.decodeAudioData(d) : null);
    this.onLoaded = options.onLoaded;
  }

  /** The decoded buffer, or null if it has not arrived (or never will). */
  get(name: string): AudioBuffer | null {
    return this.buffers.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.buffers.has(name);
  }

  get size(): number {
    return this.buffers.size;
  }

  /** How far along a load is, for a progress line. */
  get counts(): { loaded: number; failed: number; pending: number } {
    return { loaded: this.buffers.size, failed: this.failed.size, pending: this.pending.size };
  }

  /**
   * Loads each name at most once, whatever happens to it. Resolves when every one has settled;
   * it never rejects, so a caller can `await` it without a catch and still be sure it returns.
   */
  async load(names: readonly string[]): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const name of names) {
      if (this.buffers.has(name) || this.failed.has(name)) continue;
      let job = this.pending.get(name);
      if (!job) {
        job = this.one(name);
        this.pending.set(name, job);
      }
      jobs.push(job);
    }
    await Promise.all(jobs);
  }

  private async one(name: string): Promise<void> {
    let buffer: AudioBuffer | null = null;
    try {
      if (!this.fetcher || !this.decoder) throw new Error('no fetch or no decoder');
      const res = await this.fetcher(`${this.base}${name}.${this.ext}`);
      // A dev server happily answers 404 with an HTML page; decoding that would be the confusing
      // failure, so the status is checked before anything touches the bytes.
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
      const data = await res.arrayBuffer();
      if (!data || data.byteLength < 64) throw new Error('empty body');
      const decoded = await this.decoder(data);
      if (!decoded || !decoded.length) throw new Error('decoded to nothing');
      buffer = decoded;
    } catch {
      buffer = null; // The synth patch covers it. Nothing to report and nothing to throw.
    }
    this.pending.delete(name);
    if (buffer) this.buffers.set(name, buffer);
    else this.failed.add(name);
    try {
      this.onLoaded?.(name, buffer);
    } catch {
      // A listener that throws is the listener's problem, not the loader's.
    }
  }
}
