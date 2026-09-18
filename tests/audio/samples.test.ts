/**
 * The recordings: that the manifest points at files that exist, that the loader survives every way
 * a fetch can fail, and that a cue with no file still makes a sound.
 *
 * Nothing here touches the network. The manifest test reads `public/audio` off disk (that is the
 * point — it catches a typo'd filename before a player hears the fallback), and the loader tests
 * inject their own fetch and decoder.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { GameAudio } from '../../src/audio';
import { SampleBank } from '../../src/audio/loader';
import {
  allSampleNames,
  AUDIO_FORMATS,
  coreSampleNames,
  CUE_SAMPLES,
  LAYER_SAMPLES,
  restSampleNames,
} from '../../src/audio/manifest';
import { AudioSettingsStore } from '../../src/audio/settings';
import { CUES, DEFAULT_SETTINGS, type CueName } from '../../src/audio/types';
import { asContext, FakeAudioBuffer, FakeOfflineContext, measure } from '../helpers/fakeWebAudio';

const AUDIO_DIR = join(import.meta.dirname, '../../public/audio');
const SR = 22050;

// ------------------------------------------------------------------ the manifest

describe('the manifest', () => {
  it('names only files that are actually shipped, in every format', () => {
    for (const name of allSampleNames()) {
      for (const f of AUDIO_FORMATS) {
        const path = join(AUDIO_DIR, `${name}.${f.ext}`);
        expect(existsSync(path), `${name}.${f.ext} is referenced but missing`).toBe(true);
        expect(statSync(path).size, `${name}.${f.ext} is empty`).toBeGreaterThan(1024);
      }
    }
  });

  it('ships nothing it does not use', () => {
    const used = new Set(allSampleNames());
    const extras = readdirSync(AUDIO_DIR)
      .filter((f) => AUDIO_FORMATS.some((x) => f.endsWith(`.${x.ext}`)))
      .map((f) => f.replace(/\.[^.]+$/, ''))
      .filter((n) => !used.has(n));
    expect([...new Set(extras)]).toEqual([]);
  });

  it('is committed with its credits', () => {
    expect(existsSync(join(AUDIO_DIR, 'CREDITS.md'))).toBe(true);
  });

  it('splits into a core batch and the rest with nothing lost or duplicated', () => {
    const core = coreSampleNames();
    const rest = restSampleNames();
    expect(new Set([...core, ...rest])).toEqual(new Set(allSampleNames()));
    expect(core.filter((n) => rest.includes(n))).toEqual([]);
    // The bed and the footsteps are held layers: a run opens with them, so they cannot wait.
    for (const n of [...LAYER_SAMPLES.step, ...LAYER_SAMPLES.heartbeat]) expect(core).toContain(n);
  });

  it('keeps every cue playable, sampled or not', () => {
    for (const cue of CUES) {
      const spec = CUE_SAMPLES[cue];
      if (!spec) continue;
      expect(spec.layers.length, cue).toBeGreaterThan(0);
      expect(spec.gain, cue).toBeGreaterThan(0);
      expect(spec.gain, cue).toBeLessThanOrEqual(1.5);
    }
  });
});

// ------------------------------------------------------------------ the loader

const sine = (hz: number, seconds = 0.4, rate = 44100) => {
  const buf = new FakeAudioBuffer(1, Math.round(rate * seconds), rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * hz * i) / rate);
  return buf;
};

const okResponse = () =>
  ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4096) }) as unknown as Response;

function bankWith(
  ctx: FakeOfflineContext,
  over: Partial<Parameters<typeof SampleBank.prototype.load>[0]> = [],
  opts: Partial<ConstructorParameters<typeof SampleBank>[1]> = {},
): SampleBank {
  void over;
  return new SampleBank(asContext(ctx), {
    ext: 'ogg',
    fetch: (async () => okResponse()) as unknown as typeof fetch,
    decode: async () => sine(220) as unknown as AudioBuffer,
    ...opts,
  });
}

describe('the loader', () => {
  const ctx = () => new FakeOfflineContext(8, SR);

  it('loads and caches, and fetches each name once however often it is asked for', async () => {
    const fetcher = vi.fn(async () => okResponse());
    const bank = bankWith(ctx(), [], { fetch: fetcher as unknown as typeof fetch });
    await bank.load(['coin', 'coin', 'land']);
    await bank.load(['coin', 'land']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bank.get('coin')).toBeTruthy();
    expect(bank.size).toBe(2);
    expect(bank.failed.size).toBe(0);
  });

  it('asks for the right url', async () => {
    const fetcher = vi.fn(async () => okResponse());
    const bank = bankWith(ctx(), [], { base: '/audio/', ext: 'm4a', fetch: fetcher as unknown as typeof fetch });
    await bank.load(['whistle']);
    expect(fetcher).toHaveBeenCalledWith('/audio/whistle.m4a');
  });

  it.each([
    ['a 404', { ok: false, status: 404 } as unknown as Response, undefined],
    ['an empty body', { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) } as unknown as Response, undefined],
    ['a null response', null as unknown as Response, undefined],
  ])('survives %s', async (_label, res) => {
    const bank = bankWith(ctx(), [], { fetch: (async () => res) as unknown as typeof fetch });
    await expect(bank.load(['coin'])).resolves.toBeUndefined();
    expect(bank.get('coin')).toBeNull();
    expect(bank.failed.has('coin')).toBe(true);
  });

  it('survives a fetch that throws, a decoder that throws, and a decoder that returns nothing', async () => {
    const thrower = bankWith(ctx(), [], {
      fetch: (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch,
    });
    await expect(thrower.load(['coin'])).resolves.toBeUndefined();

    const badDecode = bankWith(ctx(), [], {
      decode: async () => {
        throw new DOMException('cannot decode');
      },
    });
    await expect(badDecode.load(['coin'])).resolves.toBeUndefined();

    const empty = bankWith(ctx(), [], { decode: async () => null as unknown as AudioBuffer });
    await expect(empty.load(['coin'])).resolves.toBeUndefined();

    for (const b of [thrower, badDecode, empty]) expect(b.get('coin')).toBeNull();
  });

  it('survives having no fetch at all', async () => {
    const bank = new SampleBank(asContext(ctx()), { ext: 'ogg', fetch: undefined, decode: async () => sine(220) as unknown as AudioBuffer });
    // globalThis.fetch exists in Node 22, so force the failure through the decoder-less path too.
    await expect(bank.load(['coin'])).resolves.toBeUndefined();
    expect(bank.get('coin')).toBeNull();
  });

  it('never retries a name that already failed', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response);
    const bank = bankWith(ctx(), [], { fetch: fetcher as unknown as typeof fetch });
    await bank.load(['coin']);
    await bank.load(['coin']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tells a listener about each name, and a listener that throws does not break the load', async () => {
    const seen: [string, boolean][] = [];
    const bank = bankWith(ctx(), [], {
      onLoaded: (n, b) => {
        seen.push([n, b !== null]);
        throw new Error('listener blew up');
      },
    });
    await expect(bank.load(['coin', 'land'])).resolves.toBeUndefined();
    expect(seen.map(([n]) => n).sort()).toEqual(['coin', 'land']);
    expect(seen.every(([, ok]) => ok)).toBe(true);
  });
});

// ------------------------------------------------------------------ sample vs synth in the engine

function renderEngine(seconds: number, setup: (e: AudioEngine) => void, bank?: SampleBank): Float32Array {
  const ctx = new FakeOfflineContext(Math.round(SR * seconds), SR);
  const engine = new AudioEngine(asContext(ctx), { settings: DEFAULT_SETTINGS, reverb: false, bank: bank ?? null });
  engine.start();
  setup(engine);
  return ctx.render(() => engine.update());
}

/** A bank pre-filled with a recognisable tone for the given names. */
async function loadedBank(names: string[], hz = 150, seconds = 0.5): Promise<SampleBank> {
  const bank = new SampleBank(asContext(new FakeOfflineContext(8, SR)), {
    ext: 'ogg',
    fetch: (async () => okResponse()) as unknown as typeof fetch,
    decode: async () => sine(hz, seconds, SR) as unknown as AudioBuffer,
  });
  await bank.load(names);
  return bank;
}

describe('sample or synth', () => {
  it('plays the recording when it is there and the patch when it is not', async () => {
    const bank = await loadedBank(['coin']);
    const sampled = renderEngine(0.8, (e) => e.cue('coin', 1, 1), bank);
    const synth = renderEngine(0.8, (e) => e.cue('coin', 1, 1));
    expect(measure(sampled, SR).peak, 'sampled coin was silent').toBeGreaterThan(0.01);
    expect(measure(synth, SR).peak, 'fallback coin was silent').toBeGreaterThan(0.01);
    // The stand-in is a 150 Hz sine; the synth coin is a chime up at 880. They are not the same sound.
    expect(measure(sampled, SR).crossingsPerSec).toBeLessThan(measure(synth, SR).crossingsPerSec / 2);
  });

  it('falls back for a cue whose file failed, without touching the ones that loaded', async () => {
    const bank = await loadedBank(['coin']);
    await bank.load(['stumble']).catch(() => {});
    const stumble = renderEngine(0.8, (e) => e.cue('stumble', 1, 1), bank);
    expect(measure(stumble, SR).peak).toBeGreaterThan(0.01);
  });

  it('rides the coin ladder on the recording, not just on the patch', async () => {
    const bank = await loadedBank(['coin']);
    // Counted over a window both renders are still sounding in: across the whole buffer the faster
    // one simply finishes sooner, so the crossings per second come out identical.
    const win = (b: Float32Array) => b.subarray(600, Math.round(SR * 0.2));
    const low = win(renderEngine(0.7, (e) => e.cue('coin', 1, 1), bank));
    const high = win(renderEngine(0.7, (e) => e.cue('coin', 1, 2), bank));
    expect(measure(high, SR).crossingsPerSec).toBeGreaterThan(measure(low, SR).crossingsPerSec * 1.6);
  });

  it('plays the body of a two-file cue even when the second file never arrives', async () => {
    const bank = await loadedBank(['caught-hit']);
    const caught = renderEngine(1.2, (e) => e.cue('caught', 1, 1), bank);
    expect(measure(caught, SR).peak).toBeGreaterThan(0.01);
  });

  it('cross-fades the synthetic station bed out once the recording lands', async () => {
    const bank = await loadedBank(['ambience-crowd']);
    const withSample = renderEngine(2.5, (e) => e.mix('ambience', 1), bank);
    const synthOnly = renderEngine(2.5, (e) => e.mix('ambience', 1));
    expect(measure(withSample, SR).peak).toBeGreaterThan(0.005);
    expect(measure(synthOnly, SR).peak).toBeGreaterThan(0.005);
    // The recorded bed is a tone here, the synthetic one is filtered noise.
    expect(measure(withSample, SR).tonality).toBeGreaterThan(measure(synthOnly, SR).tonality);
  });

  it('shapes the flat train recording into a pass-by, since it was recorded mid-pass', async () => {
    // The stand-in has to be as long as the real recording, or the envelope has nothing to shape.
    const bank = await loadedBank(['train-pass'], 200, 5.5);
    const buf = renderEngine(3.5, (e) => e.cue('trainPass', 1, 1), bank);
    const m = measure(buf, SR);
    expect(m.peak).toBeGreaterThan(0.01);
    // The manifest's attack/decay must put the loudest moment in the middle and make it grow,
    // exactly as the synth patch does — a flat texture played raw would fail both of these.
    expect(m.peakAt).toBeGreaterThan(0.15);
    expect(m.peakAt).toBeLessThan(0.85);
    expect(m.frontLoad).toBeLessThan(1);
  });

  it('puts a Doppler on the train that the recording does not have', async () => {
    const bank = await loadedBank(['train-pass'], 300, 5.5);
    const buf = renderEngine(3.5, (e) => e.cue('trainPass', 1, 1), bank);
    // Early in the pass it is pitched up, late in it pitched down.
    const early = measure(buf.subarray(Math.round(SR * 0.6), Math.round(SR * 1.4)), SR);
    const late = measure(buf.subarray(Math.round(SR * 3.0), Math.round(SR * 3.4)), SR);
    expect(early.crossingsPerSec).toBeGreaterThan(late.crossingsPerSec * 1.02);
  });

  it('walks round the footstep recordings instead of repeating one', async () => {
    const bank = await loadedBank([...LAYER_SAMPLES.step]);
    const buf = renderEngine(2, (e) => {
      e.tempo(160);
      e.mix('chaserSteps', 1);
      e.transport(true);
    }, bank);
    expect(measure(buf, SR).peak).toBeGreaterThan(0.005);
  });

  it('adds no graph nodes on an idle frame once samples are attached', async () => {
    const bank = await loadedBank(['ambience-crowd']);
    const ctx = new FakeOfflineContext(10, SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: false, bank });
    engine.start();
    engine.update(); // the bed swaps here
    const before = { ...ctx.created };
    for (let i = 0; i < 120; i++) engine.update();
    expect(ctx.created).toEqual(before);
  });
});

describe('the facade and the recordings', () => {
  const make = (over: Partial<ConstructorParameters<typeof GameAudio>[0]> = {}) =>
    new GameAudio({
      settings: new AudioSettingsStore(null),
      search: '',
      reverb: false,
      makeContext: () => asContext(new FakeOfflineContext(64, 8000)),
      samples: {
        ext: 'ogg',
        fetch: (async () => okResponse()) as unknown as typeof fetch,
        decode: async () => sine(220, 0.2, 8000) as unknown as AudioBuffer,
      },
      ...over,
    });

  it('starts loading on the first gesture and never lets that failure reach the caller', async () => {
    const audio = make({
      samples: { ext: 'ogg', fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch },
    });
    expect(() => audio.unlock()).not.toThrow();
    expect(audio.bank).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.ready).toBe(true);
  });

  it('honours ?nosamples by staying entirely synthetic', () => {
    const audio = make({ search: '?nosamples' });
    audio.unlock();
    expect(audio.bank).toBeNull();
    expect(audio.ready).toBe(true);
    expect(() => audio.play('coin', 1, 1)).not.toThrow();
  });

  it('is audible before a single file has arrived', () => {
    const audio = make();
    audio.unlock();
    expect(() => {
      for (const cue of CUES) audio.play(cue as CueName, 1, 1);
    }).not.toThrow();
  });
});
