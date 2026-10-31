/**
 * Which cues are recordings and which are synthesised, and how loud each recording sits.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md ("Ground rules", "Loading policy").
 *
 * The rule the spec sets is samples first: a recorded whistle beats anything we can build out of
 * oscillators. What is listed here is played from `public/audio/`; everything not listed — and
 * anything listed whose file fails to arrive — falls through to the synth patch in `voices.ts`.
 * That fallback is not a nicety: a cue must never become silence because a fetch failed.
 *
 * What stayed synthesised, and why (all of it was looked for first):
 *   lane        no free whoosh worth having; the synth swish is a cleaner one anyway
 *   tannoy      the one CC0 "station arrival" recording turned out to be platform noise with no
 *               chime in it — the spectrogram is flat broadband hiss
 *   idleWarn    it is the heartbeat swell, which is assembled from the heartbeat sample plus a sub
 *   the bed     tabla, bayan, tanpura, riff and the jog tick: no CC0 Indian percussion or drone
 *               exists at a usable quality on any source open to us, and a half-right tabla would
 *               be worse than an honest synthetic one
 *
 * `crow` and `trainPass` were on that list until a second search pass found usable recordings for
 * both — a CC0 caw and a public-domain level crossing with its own Doppler — so they are now
 * played from file like everything else in `CUE_SAMPLES`, and credited in `CREDITS.md`.
 *
 * Every file's source, author and licence is in `public/audio/CREDITS.md`.
 */
import type { BufferShape } from './voices';
import type { CueName } from './types';

/** Where the files are served from: `audio/` under wherever the game is hosted (a sub-path on GitHub Pages). */
export const AUDIO_BASE = `${typeof import.meta.env === 'undefined' ? '/' : import.meta.env.BASE_URL}audio/`;

/** In preference order; the loader picks the first the browser admits to playing. */
export const AUDIO_FORMATS = [
  { ext: 'ogg', mime: 'audio/ogg; codecs="vorbis"' },
  { ext: 'm4a', mime: 'audio/mp4; codecs="mp4a.40.2"' },
] as const;

export interface SampleLayer {
  /** Basename in `public/audio`, without extension. */
  file: string;
  /** Shaping for a texture recording (the train): fade-in, fade-out, Doppler. */
  shape?: BufferShape;
  /** Level for this layer within the cue. */
  gain?: number;
  /** Seconds after the cue's start. */
  delay?: number;
  /** Ignore the cue's pitch ratio — a body hit should not change pitch with a coin streak. */
  fixedPitch?: boolean;
}

export interface CueSample {
  /** Played together. The first is the body of the cue: without it, the whole cue falls back. */
  layers: readonly SampleLayer[];
  /** Trim so the recording sits where the synth patch it replaces sat. Tuned in the lab. */
  gain: number;
  /** Reverb send, the same 0..1 the synth patches use. */
  send?: number;
  /**
   * `core` is fetched on the first gesture, before anything else — the cues a player meets in the
   * first five seconds. `rest` streams in behind it, playing synth until it lands.
   */
  tier?: 'core' | 'rest';
}

export const CUE_SAMPLES: Partial<Record<CueName, CueSample>> = {
  // --- the first five seconds -----------------------------------------------------
  countdown: { layers: [{ file: 'countdown' }], gain: 0.55, send: 0.2, tier: 'core' },
  go: { layers: [{ file: 'go' }], gain: 0.45, send: 0.25, tier: 'core' },
  coin: { layers: [{ file: 'coin' }], gain: 0.8, send: 0.3, tier: 'core' },
  jump: { layers: [{ file: 'jump' }], gain: 0.42, send: 0.15, tier: 'core' },
  land: { layers: [{ file: 'land' }], gain: 1.1, send: 0.15, tier: 'core' },
  roll: { layers: [{ file: 'roll' }], gain: 0.7, send: 0.2, tier: 'core' },
  uiClick: { layers: [{ file: 'ui-click' }], gain: 0.55, tier: 'core' },
  uiBack: { layers: [{ file: 'ui-back' }], gain: 0.55, tier: 'core' },
  uiConfirm: { layers: [{ file: 'ui-confirm' }], gain: 0.5, send: 0.2, tier: 'core' },
  // The TT's whistle is the cue the whole chase hangs on, so it is never left to the fallback.
  whistle: { layers: [{ file: 'whistle' }], gain: 0.5, send: 0.35, tier: 'core' },
  // The dog in the "about to be caught" alarm: loaded up front, since the moment it is for can
  // come in the first seconds of a run.
  bark: { layers: [{ file: 'bark' }], gain: 0.6, send: 0.3, tier: 'core' },

  // --- everything else ------------------------------------------------------------
  coinJosh: { layers: [{ file: 'coin', gain: 1 }, { file: 'coin', gain: 0.45, delay: 0.012 }], gain: 0.7, send: 0.4 },
  pickupMagnet: { layers: [{ file: 'pickup-magnet' }], gain: 0.5, send: 0.3 },
  pickupRocket: { layers: [{ file: 'pickup-rocket' }], gain: 0.5, send: 0.3 },
  pickupChappal: { layers: [{ file: 'pickup-chappal' }], gain: 0.8, send: 0.2 },
  rocketLanding: { layers: [{ file: 'rocket-landing' }], gain: 0.85, send: 0.35 },
  joshStart: { layers: [{ file: 'josh-start' }], gain: 0.6, send: 0.4 },
  joshEnd: { layers: [{ file: 'josh-end' }], gain: 0.45, send: 0.35 },
  stumble: { layers: [{ file: 'stumble' }], gain: 0.85, send: 0.25 },
  hoverboard: { layers: [{ file: 'hoverboard' }], gain: 0.45, send: 0.3 },
  hoverboardSave: { layers: [{ file: 'hoverboard-save' }], gain: 0.5, send: 0.4 },
  // The sting is two recordings: the hit lands on the frame, the fall runs on under it.
  caught: {
    layers: [{ file: 'caught-hit', gain: 1, fixedPitch: true }, { file: 'caught-sting', gain: 0.8, delay: 0.01 }],
    gain: 0.45,
    send: 0.55,
  },
  summary: { layers: [{ file: 'summary' }], gain: 0.55, send: 0.5 },
  moveOk: { layers: [{ file: 'move-ok' }], gain: 0.6, send: 0.3 },
  moveFanfare: { layers: [{ file: 'move-fanfare' }], gain: 0.45, send: 0.4 },
  brush: { layers: [{ file: 'brush' }], gain: 0.75, send: 0.3 },
  unfurl: { layers: [{ file: 'unfurl' }], gain: 0.5, send: 0.35 },
  introWhistle: { layers: [{ file: 'whistle' }], gain: 0.5, send: 0.8 },
  crow: { layers: [{ file: 'crow' }], gain: 0.45, send: 0.6 },
  // Seven seconds across a level crossing, with the approach, the pass and the recede all in the
  // recording — the Doppler is real, so nothing is added on top of it. The fades only stop the cue
  // switching on and off in the middle of the road traffic underneath it.
  trainPass: {
    layers: [{ file: 'train-pass', shape: { attack: 1.0, decay: 1.6 } }],
    gain: 0.5,
    send: 0.4,
  },
};

/**
 * Samples the sequenced layers use, in place of their synth voice. The footsteps are a set the
 * scheduler walks round, because four identical slaps in a row is the most obviously fake thing a
 * game can do.
 */
export const LAYER_SAMPLES = {
  /** The TT's footfalls. */
  step: ['step-0', 'step-1', 'step-2', 'step-3'],
  /** One lub-dub; the engine sets the rate. */
  heartbeat: ['heartbeat'],
  /** A loop, not a one-shot: it replaces the synth station bed once it lands. */
  ambience: ['ambience-crowd'],
} as const;

/** Every basename the game may ask for, deduplicated. */
export function allSampleNames(): string[] {
  const out = new Set<string>();
  for (const spec of Object.values(CUE_SAMPLES)) for (const l of spec.layers) out.add(l.file);
  for (const names of Object.values(LAYER_SAMPLES)) for (const n of names) out.add(n);
  return [...out];
}

/** The ones fetched first, before the rest stream in. */
export function coreSampleNames(): string[] {
  const out = new Set<string>();
  for (const spec of Object.values(CUE_SAMPLES)) {
    if (spec.tier === 'core') for (const l of spec.layers) out.add(l.file);
  }
  // The bed and the footsteps are core too: they are held layers, and a run starts with them.
  for (const n of [...LAYER_SAMPLES.step, ...LAYER_SAMPLES.heartbeat]) out.add(n);
  return [...out];
}

/** The rest, in the order they are wanted. */
export function restSampleNames(): string[] {
  const core = new Set(coreSampleNames());
  return allSampleNames().filter((n) => !core.has(n));
}
