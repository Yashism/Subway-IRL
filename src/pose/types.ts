/** One MediaPipe landmark. x/y are normalized to the image (0..1) and already mirrored so the player's left is screen-left. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

/** The 33 BlazePose landmarks of one person. */
export type Pose = Landmark[];

/** Output of one pose-model inference. `t` is in milliseconds; `aspect` is image width / height. */
export interface PoseFrame {
  t: number;
  aspect: number;
  poses: Pose[];
}

export type PlayMode = 'full' | 'small';
export type Lane = -1 | 0 | 1;

export type PoseEvent =
  | { type: 'lane'; lane: Lane }
  | { type: 'laneShift'; dir: -1 | 1 }
  | { type: 'jump' }
  | { type: 'roll' }
  | { type: 'hoverboard' }
  | { type: 'start' }
  | { type: 'lost' }
  | { type: 'found' };

export interface JogStatus {
  active: boolean;
  cadenceSpm: number;
  msSinceStep: number;
  steps: number;
}

/**
 * Read-only per-frame readout of the quantities the move detectors compare against their
 * thresholds, in those thresholds' own units (torso lengths in full-body mode, shoulder widths in
 * small-room mode, degrees for the lean). Only the active mode's fields move; the others stay 0.
 * The Move Check measures a player's peak here so a tuned number is comparable to the threshold it
 * replaces. Nothing in the game reads it: adding it changes no detection behaviour.
 */
export interface MoveMagnitudes {
  /** Sideways offset from the calibrated spot, signed like the lane (`laneEnter`). Full body. */
  lane: number;
  /** Shoulder-line angle; negative is the player's left (`leanDeg`). Small room. */
  tiltDeg: number;
  /** Nose sideways shift, signed like `tiltDeg` (`noseShift`). Small room. */
  noseShift: number;
  /** Height above the vertical reference (`jumpRise` / `smallJumpRise`). */
  rise: number;
  /** Hip drop below the vertical reference (`rollDrop`). Full body; 0 in small-room mode. */
  drop: number;
  /** Head drop below its reference (`rollHeadDrop` in full body, `duckDrop` in small room). */
  headDrop: number;
  /** The primary jog signal: knee lift (`kneeLift`) or |wrist offset| (`wristPump`). */
  jogPrimary: number;
  /**
   * Half the peak-to-trough bounce of the last second (`bobMinAmp`). Ungated, so a bounce too small
   * to count as a step still reads as a real number — that is the one the small-room jog is tuned
   * from, and a player bobbing just under the threshold has to be told "almost".
   */
  bobAmp: number;
  /**
   * The bounce the jump gate actually subtracts (`moves.ts`): the mean of *recorded* swings, and so
   * 0 for anyone who is not jogging. A separate field because one number cannot serve both — this
   * one must not count the jump's own rise as a bounce, and `bobAmp` must not be gated.
   */
  bobGated: number;
  /** Jog steps counted since calibration. Not a magnitude; the jog step of the check counts these. */
  jogSteps: number;
}

export type DistanceHint = 'ok' | 'closer' | 'back';

export interface CalibrationState {
  progress: number;
  bodyVisible: boolean;
  distance: DistanceHint;
}

export interface PoseStatus {
  tracking: boolean;
  calibrated: boolean;
  mode: PlayMode | null;
  lane: Lane;
  poseFps: number;
  confidence: number;
  jog: JogStatus;
  startProgress: number;
  calibration: CalibrationState;
  pose: Pose | null;
  /** Timestamp of the last frame given to update(), with or without a pose; null before the first. Lets the game detect a stalled stream. */
  lastFrameT: number | null;
  /** True while the player is down in a squat or duck (a roll in progress, or not yet stood back up). */
  squatting: boolean;
  /** Pose fps is below 15 after at least 2 s of frames. */
  slowPose: boolean;
}
