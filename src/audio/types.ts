/**
 * The audio contract: what can be heard, and the only two shapes a decision can take.
 * Spec: docs/superpowers/specs/2026-09-18-audio.md
 *
 * Everything the game can hear is either a **cue** (a one-shot: a coin, a whistle, a beep) or a
 * **mix channel** (a continuously held level: the drone, the tabla, the chaser's footsteps). The
 * director speaks only this vocabulary, in primitives, so it can be tested against a fake sink and
 * so a frame costs no allocation at all.
 */

/** One-shot sounds. */
export const CUES = [
  // pickups and score
  'coin',
  'coinJosh',
  'pickupMagnet',
  'pickupRocket',
  'pickupChappal',
  'rocketLanding',
  'joshStart',
  'joshEnd',
  // the body
  'jump',
  'land',
  'roll',
  'lane',
  'stumble',
  'hoverboard',
  'hoverboardSave',
  // pressure
  'whistle',
  /** The street dog at the TT's heels: one bark; the alarm sequence fires it three times. */
  'bark',
  'caught',
  'trainPass',
  // ambience punctuation
  'crow',
  'tannoy',
  // flow
  'countdown',
  'go',
  'summary',
  // ui and the move check
  'uiClick',
  'uiBack',
  'uiConfirm',
  'moveOk',
  'moveFanfare',
  // intro sequence (hooks: the poster scene fires these when it lands)
  'brush',
  'unfurl',
  'introWhistle',
] as const;

export type CueName = (typeof CUES)[number];

/**
 * Continuously held levels, all 0..1. Each is a decision the director re-makes every frame and
 * only sends when it has actually moved.
 */
export const MIX_CHANNELS = [
  /** The whole music bus: ducking, the pause thin-out, the cut on `caught`. */
  'music',
  /** Tanpura-ish drone. The floor of the bed — never fully absent while anything plays. */
  'drone',
  /** Tabla tones (na / tin / ke): the groove proper. */
  'tabla',
  /** Bayan, the low drum. The first layer the run speed adds. */
  'bass',
  /** The pentatonic riff. The last layer the run speed adds. */
  'riff',
  /** The Josh swell: an octave shimmer over the groove while coins are doubled. */
  'josh',
  /** The jog pulse: the tick the player puts their feet on. */
  'pulse',
  /** Idle escalation, 0..1. Drives both the heartbeat's level AND its rate. */
  'heartbeat',
  /** Station bed: crowd murmur, traffic hum. */
  'ambience',
  /** The hoverboard's hum, while a board is under the player. */
  'hover',
  /** Rocket thrust, while flying. */
  'rocket',
  /** The magnet's shimmer, while it is pulling coins. */
  'magnet',
  /** The TT's footsteps, by how close he is. */
  'chaserSteps',
  /** Rail rumble and wind, by run speed. */
  'wind',
] as const;

export type MixChannel = (typeof MIX_CHANNELS)[number];

/** Heartbeat rate at escalation 0 and 1 (beats per minute). Shared so the mapping is stated once. */
export const HEARTBEAT_BPM = [58, 132] as const;

/**
 * Everything the director can ask for. Primitives only: a cue carries its own gain and a pitch
 * ratio rather than an options object, so firing one allocates nothing.
 */
export interface AudioSink {
  /** @param rate pitch/playback ratio, 1 = the patch's written pitch. */
  cue(cue: CueName, gain: number, rate: number): void;
  mix(channel: MixChannel, value: number): void;
  /** Footfalls per minute — one pulse tick per step. The groove runs at half this. */
  tempo(pulseBpm: number): void;
  /** Whether the step sequencer advances (groove, riff, jog pulse). */
  transport(running: boolean): void;
}

/** Mixer settings, persisted. */
export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}

export const AUDIO_SETTINGS_KEY = 'subway-irl.audio.v1';

export const DEFAULT_SETTINGS: AudioSettings = { master: 0.8, music: 0.7, sfx: 0.9, muted: false };

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
