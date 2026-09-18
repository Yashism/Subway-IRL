/**
 * Putting a settings change in force *now*, on the things that are already running.
 * Spec: docs/superpowers/specs/2026-09-18-settings-workout.md ("Everything applies live").
 *
 * This is the other half of `settings.ts`: that file decides what a setting is and remembers it,
 * this one carries it to the pose controller, the game options, the world and the preview. It is
 * separate so the rule "a change reaches the live game" can be tested without a camera, a WebGL
 * context or a page — every target here is the smallest structural slice of the real thing.
 *
 * Two settings are deliberately *not* applied here, because neither is a value anything holds:
 * the play mode goes through the session flow (it recalibrates and re-applies that mode's tuning),
 * and the camera goes through the flow's camera picker.
 */
import type { Difficulty, ObstacleSettings } from '../game/config';
import type { LaneSpots } from '../pose/laneSpots';
import type { LineId } from '../world/stations';
import type { GameSettings } from './settings';

/** Everything a live settings change writes to. Structural on purpose: the tests pass plain objects. */
export interface LiveTargets {
  /**
   * The pose controller. Sensitivity is the same value the debug monitor sends; `laneSpots` is the
   * full-body lane spots in force, null for the automatic lanes.
   */
  controller: { sensitivity: number; laneSpots: Readonly<LaneSpots> | null };
  /** The player's recorded lane spots (their own store), or null when none are recorded. */
  laneSpots?: Readonly<LaneSpots> | null;
  /** The Game's options object, read at the start of every run and every frame. */
  game: { options: { difficulty: Difficulty; obstacles?: ObstacleSettings } };
  world: {
    setLine(line: LineId): void;
    setReduced(o: { motion?: boolean; effects?: boolean }): void;
  };
  /** The camera preview. Display only. */
  pip: { setMirror(on: boolean): void };
  /**
   * False while a recorded session is replaying: it plays back at the sensitivity it was recorded
   * with, so the live slider must not reach into it. Defaults to true.
   */
  ownsSensitivity?: boolean;
  /**
   * False while a recorded session is replaying: the track is rebuilt from the seed, difficulty and
   * obstacle settings it was recorded with, so the live settings must not change any of them — a
   * replay on another difficulty would be a different track. Defaults to true.
   */
  ownsRun?: boolean;
  /**
   * False while a recorded session is replaying: it decides lanes with the spots it was recorded
   * with (or without any), so neither the Lanes setting nor this machine's spots may reach it.
   * Defaults to true.
   */
  ownsLanes?: boolean;
}

/** Applies every live-applicable setting. Safe to call repeatedly with the same values. */
export function applyLiveSettings(t: LiveTargets, s: GameSettings): void {
  if (t.ownsSensitivity !== false) t.controller.sensitivity = s.sensitivity;
  // "My spots" with none recorded is the automatic lanes, never a broken zone.
  if (t.ownsLanes !== false) t.controller.laneSpots = s.lanes === 'spots' ? (t.laneSpots ?? null) : null;
  if (t.ownsRun !== false) {
    t.game.options.difficulty = s.difficulty;
    t.game.options.obstacles = { level: s.obstacleLevel, amount: s.obstacleAmount };
  }
  t.world.setLine(s.line);
  t.world.setReduced({ motion: s.reducedMotion, effects: s.reducedEffects });
  t.pip.setMirror(s.mirror);
}
