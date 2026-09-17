/**
 * Shared contract for the Move Check (the guided move rehearsal that also tunes the
 * detection thresholds to the player). The logic lives in `moveCheck.ts` / `tuning.ts`;
 * the UI in `src/ui/moveCheckScreen.ts` renders `MoveCheckModel` and nothing else.
 * Spec: docs/superpowers/specs/2026-09-17-move-check.md
 */
import type { PlayMode } from './types';
import type { Thresholds } from './thresholds';

export type MoveId = 'jog' | 'left' | 'right' | 'jump' | 'roll' | 'hover';

export const MOVE_ORDER: readonly MoveId[] = ['jog', 'left', 'right', 'jump', 'roll', 'hover'];

export type MoveStepStatus =
  /** Not reached yet. */
  | 'todo'
  /** The player is being asked for this move now. */
  | 'active'
  /** Detected. */
  | 'done'
  /** Skipped, or accepted at the player's best attempt. */
  | 'skipped';

export interface MoveStepModel {
  id: MoveId;
  status: MoveStepStatus;
  /** Short move name for the step dots, e.g. "Jump". */
  label: string;
  /** How to do it, in the current play mode, e.g. "Step to your LEFT". */
  how: string;
  /** Extra nudge shown under the instruction: a near miss, an attempt count, nothing. */
  hint: string | null;
  /** True once the player may skip this step (offered after ~10 s or 4 near misses). */
  canSkip: boolean;
  /** True when an "accept my best attempt" option should be offered (lanes / jump / roll only). */
  canAccept: boolean;
  /** How far the best attempt got, 0..1 of what is needed. Drives the strength bar. */
  progress: number;
  /** The measured peak in the detector's own units, once there is one. */
  peak: number | null;
  /** For the jog step: steps seen out of the 4 needed. Null for the others. */
  steps: { seen: number; needed: number } | null;
}

export interface MoveCheckSummary {
  mode: PlayMode;
  steps: readonly MoveStepModel[];
  /** Threshold keys this check changed, with their new values, including derived companions. */
  tuned: Partial<Thresholds>;
  /** Set when the left and right attempts differed by more than 40 %. */
  asymmetryNote: string | null;
}

export interface MoveCheckModel {
  mode: PlayMode;
  /** 0-based index into `steps` of the active step; equals steps.length when finished. */
  index: number;
  steps: readonly MoveStepModel[];
  /** Null until every step is done or skipped. */
  summary: MoveCheckSummary | null;
}

/** What the UI can ask of the check. The flow supplies these. */
export interface MoveCheckHandlers {
  skipStep(): void;
  acceptBest(): void;
  skipAll(): void;
  redo(): void;
  resetTuning(): void;
  start(): void;
}

/** One stored tuning record, per play mode. */
export interface MoveTuning {
  mode: PlayMode;
  /** Epoch ms. */
  at: number;
  thresholds: Partial<Thresholds>;
  /**
   * The headline peak of each move, for display — "your jump: 0.31". Only the move's first signal,
   * and in that mode's units (a lane is degrees in small-room mode, torso lengths in full-body), so
   * it is not safe to feed back into the tuning maths. Use `keyPeaks` for that.
   */
  peaks: Partial<Record<MoveId, number>>;
  /**
   * The peak behind each tuned key, after left/right averaging. `peaks` holds one number per move,
   * which cannot describe a step that tunes two signals (small-room jog tunes `wristPump` and
   * `bobMinAmp`, a small-room lane tunes `leanDeg` and `noseShift`); this makes the re-derivation
   * exact. Absent in records written before it existed.
   */
  keyPeaks?: Partial<Record<keyof Thresholds, number>>;
}

export const MOVE_TUNING_KEY = 'subway-irl.moveTuning.v1';
