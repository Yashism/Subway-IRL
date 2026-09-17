import type { Lane } from '../pose/types';

export type GameCommand =
  | { type: 'setLane'; lane: Lane }
  | { type: 'shiftLane'; dir: -1 | 1 }
  | { type: 'jump' }
  | { type: 'roll' }
  | { type: 'hoverboard' }
  | { type: 'start' }
  | { type: 'pause' };

/** Body activity the game reads every step, whatever the input source. */
export interface ActivityStatus {
  /** False when no source measures jogging (plain keyboard): the jog rule is then off. */
  tracksJogging: boolean;
  msSinceStep: number;
  cadenceSpm: number;
  steps: number;
  /** A squat is being held (counts as movement for up to 1 s). */
  squatting: boolean;
  /** The player is out of view: the game pauses. */
  lost: boolean;
}

export interface CommandSource {
  /** Commands since the last call, oldest first. */
  drain(): GameCommand[];
  activity(tMs: number): ActivityStatus;
}
