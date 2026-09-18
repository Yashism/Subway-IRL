/**
 * The engine, rendered to samples. No audio device is touched: `tests/helpers/fakeWebAudio.ts`
 * renders the graph offline, the same way an `OfflineAudioContext` would in a browser.
 *
 * Since nobody can hear a test, the assertions are about the shape of the waveform: a whistle has
 * to be periodic, a whoosh has to be noisy, a drum has to be front-loaded, and nothing may render
 * silence or clip. `audio-lab.html` draws the same buffers, rendered through Chrome's real
 * OfflineAudioContext, so the two can be compared by eye.
 */
import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { CUES, DEFAULT_SETTINGS, type CueName } from '../../src/audio/types';
import { playCue, type VoiceCtx } from '../../src/audio/voices';
import { asContext, FakeOfflineContext, measure } from '../helpers/fakeWebAudio';

const SR = 22050;

/** Renders one patch on a bare graph, so a per-cue check costs only that cue's own nodes. */
function renderCue(cue: CueName, seconds = 1.2, gain = 1, rate = 1): Float32Array {
  const ctx = new FakeOfflineContext(Math.round(SR * seconds), SR);
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);
  const v: VoiceCtx = { ctx: asContext(ctx), out: out as unknown as AudioNode, sends: null };
  playCue(v, cue, 0.01, gain, rate);
  return ctx.render();
}

/** Builds an engine, drives it like a game loop and renders what comes out. */
function renderEngine(
  seconds: number,
  setup: (e: AudioEngine) => void,
  perFrame?: (e: AudioEngine, t: number) => void,
  settings = DEFAULT_SETTINGS,
): Float32Array {
  const ctx = new FakeOfflineContext(Math.round(SR * seconds), SR);
  const engine = new AudioEngine(asContext(ctx), { settings, reverb: false });
  engine.start();
  setup(engine);
  return ctx.render((t) => {
    perFrame?.(engine, t);
    engine.update();
  });
}

const finite = (buf: Float32Array) => buf.every((v) => Number.isFinite(v));

describe('the graph', () => {
  it('builds once, with every node type the patches need', () => {
    const ctx = new FakeOfflineContext(10, SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: true });
    expect(engine.ctx).toBeTruthy();
    expect(ctx.created.gain).toBeGreaterThan(10);
    expect(ctx.created.oscillator).toBeGreaterThan(5);
    expect(ctx.created.biquad).toBeGreaterThan(3);
    expect(ctx.created.compressor).toBe(1);
    expect(ctx.created.convolver).toBe(1);
  });

  it('adds no nodes at all on an idle frame', () => {
    const ctx = new FakeOfflineContext(10, SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: false });
    engine.start();
    engine.mix('drone', 0.5);
    const before = { ...ctx.created };
    for (let i = 0; i < 120; i++) engine.update();
    expect(ctx.created).toEqual(before);
  });

  it('starts nothing before start(), and start() is idempotent', () => {
    const ctx = new FakeOfflineContext(Math.round(SR * 0.3), SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: false });
    engine.cue('coin', 1, 1); // before start(): must be dropped, not thrown
    engine.mix('drone', 1);
    const silent = ctx.render(() => engine.update());
    expect(measure(silent, SR).peak).toBeLessThan(1e-4);
    expect(() => {
      engine.start();
      engine.start();
    }).not.toThrow();
  });
});

describe('a cue renders sound', () => {
  it.each(CUES.map((c) => [c]))('%s is audible, finite and does not clip', (cue) => {
    const seconds = cue === 'caught' || cue === 'trainPass' ? 2.4 : 1.4;
    const buf = renderCue(cue as CueName, seconds);
    const m = measure(buf, SR);
    expect(finite(buf), `${cue} rendered NaN`).toBe(true);
    expect(m.peak, `${cue} rendered silence`).toBeGreaterThan(0.01);
    expect(m.rms, `${cue} rendered next to nothing`).toBeGreaterThan(2e-4);
    // Headroom, not a limiter check: every cue has to leave room for the rest of the mix.
    expect(m.peak, `${cue} is too hot on its own bus`).toBeLessThan(0.9);
  });

  it('a mute renders silence where the same run was loud', () => {
    const play = (e: AudioEngine) => {
      e.mix('drone', 1);
      e.mix('tabla', 1);
      e.mix('pulse', 1);
      e.transport(true);
      e.tempo(160);
      e.cue('caught', 1, 1);
    };
    const loud = renderEngine(1.2, play);
    const muted = renderEngine(1.2, play, undefined, { ...DEFAULT_SETTINGS, muted: true });
    expect(measure(loud, SR).rms).toBeGreaterThan(0.002);
    // The mute glides over ~10 ms rather than stepping (a hard cut clicks), so it is not a pure zero.
    expect(measure(muted, SR).rms).toBeLessThan(measure(loud, SR).rms / 50);
  });

  it('the sfx volume scales what the player hears', () => {
    const play = (e: AudioEngine) => e.cue('coin', 1, 1);
    const full = measure(renderEngine(0.6, play), SR).peak;
    const quiet = measure(renderEngine(0.6, play, undefined, { ...DEFAULT_SETTINGS, sfx: 0.2 }), SR).peak;
    expect(quiet).toBeLessThan(full * 0.5);
    expect(quiet).toBeGreaterThan(0);
  });
});

describe('the cues sound like what they are called', () => {
  it('a whistle is a tone and a whoosh is noise', () => {
    const whistle = measure(renderCue('whistle', 1.0), SR);
    expect(whistle.tonality).toBeGreaterThan(0.7);
    for (const cue of ['roll', 'lane', 'brush'] as CueName[]) {
      const m = measure(renderCue(cue, 1.0), SR);
      expect(m.tonality, cue).toBeLessThan(0.45);
      expect(m.crossingsPerSec, cue).toBeGreaterThan(whistle.crossingsPerSec / 4);
    }
    // The hoverboard is a riser over a motor, so it is not pure noise — only clearly less pitched.
    expect(measure(renderCue('hoverboard', 1.0), SR).tonality).toBeLessThan(whistle.tonality - 0.2);
  });

  it('percussion is a transient: loud at the front, gone at the back', () => {
    for (const cue of ['land', 'stumble', 'countdown', 'uiClick'] as CueName[]) {
      const m = measure(renderCue(cue, 1.2), SR);
      expect(m.peakAt, cue).toBeLessThan(0.35);
      expect(m.frontLoad, cue).toBeGreaterThan(5);
    }
  });

  it('a chime rings on rather than snapping off', () => {
    const m = measure(renderCue('coin', 1.2), SR);
    expect(m.peakAt).toBeLessThan(0.2);
    expect(m.tonality).toBeGreaterThan(0.7);
  });

  it('the train sweeps past instead of starting loud', () => {
    const m = measure(renderCue('trainPass', 2.4), SR);
    // The swell peaks in the middle of the pass, not at its edges, and grows rather than decaying.
    expect(m.peakAt).toBeGreaterThan(0.15);
    expect(m.peakAt).toBeLessThan(0.85);
    expect(m.frontLoad).toBeLessThan(1);
  });

  it('the coin ladder really does raise the pitch', () => {
    const low = renderCue('coin', 0.5, 1, 1);
    const high = renderCue('coin', 0.5, 1, 2);
    expect(measure(high, SR).crossingsPerSec).toBeGreaterThan(measure(low, SR).crossingsPerSec * 1.6);
  });

  it('a gain of zero is not scheduled at all', () => {
    expect(measure(renderCue('coin', 0.4, 0, 1), SR).peak).toBe(0);
  });
});

describe('the sequencer', () => {
  it('plays the groove while the transport runs and stops when it does not', () => {
    const running = renderEngine(2, (e) => {
      e.tempo(160);
      e.mix('tabla', 1);
      e.mix('bass', 1);
      e.transport(true);
    });
    const stopped = renderEngine(2, (e) => {
      e.tempo(160);
      e.mix('tabla', 1);
      e.mix('bass', 1);
      e.transport(false);
    });
    expect(measure(running, SR).rms).toBeGreaterThan(0.002);
    expect(measure(stopped, SR).rms).toBeLessThan(measure(running, SR).rms / 10);
  });

  it('puts more ticks in a second at a faster jog', () => {
    const count = (bpm: number) => {
      const buf = renderEngine(2, (e) => {
        e.tempo(bpm);
        e.mix('pulse', 1);
        e.transport(true);
      });
      // Count envelopes: a tick is a short burst well above the floor.
      let hits = 0;
      let inside = false;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (!inside && a > 0.02) {
          hits++;
          inside = true;
        } else if (inside && a < 0.004) inside = false;
      }
      return hits;
    };
    const slow = count(130);
    const fast = count(190);
    expect(slow).toBeGreaterThan(2);
    expect(fast).toBeGreaterThan(slow);
  });

  it('holds the layers apart: the riff can be soloed away from the drum', () => {
    const drums = renderEngine(1.5, (e) => {
      e.tempo(160);
      e.mix('tabla', 1);
      e.transport(true);
    });
    const riff = renderEngine(1.5, (e) => {
      e.tempo(160);
      e.mix('riff', 1);
      e.transport(true);
    });
    expect(measure(drums, SR).rms).toBeGreaterThan(0.001);
    expect(measure(riff, SR).rms).toBeGreaterThan(0.001);
    // The riff rings; the drums do not.
    expect(measure(riff, SR).tonality).toBeGreaterThan(measure(drums, SR).tonality);
  });

  it('the heartbeat gets faster as the idle deadline closes', () => {
    const beats = (level: number) => {
      const buf = renderEngine(3, (e) => e.mix('heartbeat', level));
      let hits = 0;
      let inside = false;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (!inside && a > 0.03) {
          hits++;
          inside = true;
        } else if (inside && a < 0.005) inside = false;
      }
      return hits;
    };
    expect(beats(1)).toBeGreaterThan(beats(0.1));
    expect(beats(0)).toBe(0);
  });
});

describe('nothing throws', () => {
  it('on a context whose clock never advances (a suspended tab)', () => {
    const ctx = new FakeOfflineContext(1, SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: false });
    engine.start();
    expect(() => {
      for (let i = 0; i < 600; i++) {
        engine.update();
        engine.cue('coin', 1, 1);
        engine.mix('drone', 0.5);
      }
    }).not.toThrow();
  });

  it('when the clock jumps forward, as it does when a tab comes back', () => {
    const ctx = new FakeOfflineContext(1, SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: false });
    engine.start();
    engine.tempo(160);
    engine.mix('pulse', 1);
    engine.mix('heartbeat', 1);
    engine.transport(true);
    engine.update();
    ctx.advanceTo(3600); // an hour in the background
    expect(() => engine.update()).not.toThrow();
    const before = { ...ctx.created };
    engine.update();
    // It resyncs to now instead of scheduling an hour of notes.
    expect((ctx.created.oscillator ?? 0) - (before.oscillator ?? 0)).toBeLessThan(40);
  });

  it('on hostile numbers', () => {
    const ctx = new FakeOfflineContext(1, SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: false });
    engine.start();
    expect(() => {
      for (const n of [Number.NaN, Infinity, -Infinity, -5, 1e9]) {
        engine.tempo(n);
        engine.mix('music', n);
        engine.cue('coin', n, n);
      }
    }).not.toThrow();
  });

  it('drops cues past the voice budget rather than melting', () => {
    const ctx = new FakeOfflineContext(1, SR);
    const engine = new AudioEngine(asContext(ctx), { reverb: false });
    engine.start();
    const before = ctx.created.oscillator ?? 0;
    for (let i = 0; i < 500; i++) engine.cue('coin', 1, 1);
    expect((ctx.created.oscillator ?? 0) - before).toBeLessThan(120);
  });
});
