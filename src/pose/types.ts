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
}
