/**
 * The move check as the game page runs it: it owns the MoveCheck the flow asks for, feeds it the
 * pose frames, saves what it measured and puts the tuning in force on the live thresholds.
 * Spec: docs/superpowers/specs/2026-09-17-move-check.md
 *
 * DOM-free, so the whole routing can be tested headless: `main.ts` renders `model` with
 * MoveCheckScreen and hands `handlers` to it.
 */
import { MoveCheck, type MoveCheckSource } from '../pose/moveCheck';
import {
  type MoveCheckHandlers,
  type MoveCheckModel,
  type MoveCheckSummary,
  type MoveId,
  type MoveStepModel,
  type MoveTuning,
} from '../pose/moveCheckTypes';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../pose/thresholds';
import { applyTuning, MoveTuningStore, TUNABLE_KEYS } from '../pose/tuning';
import type { PlayMode, PoseEvent } from '../pose/types';
import type { MoveCheckEvent } from '../telemetry/messages';

export interface MoveCheckSessionOptions {
  /** The live thresholds object of the PoseController: a tuning is applied into it, in place. */
  thresholds: Thresholds;
  /**
   * The PoseController, so its baseline can be pinned while a step is being measured. Drift
   * chases a player who holds a slow, sub-threshold lean or knee lift — exactly what a cautious
   * first-timer does when told "lean your shoulders LEFT" — which would eat the very excursion
   * the check is trying to measure.
   */
  controller?: { freezeBaseline: boolean } | null;
  /** Default: the browser's localStorage-backed store. */
  store?: MoveTuningStore;
  /** Epoch ms for a saved record. Default: Date.now. */
  now?: () => number;
  /** "Start playing" on the summary card. */
  onStart?: () => void;
  /** The live thresholds just changed (a check was saved, or reset to defaults). */
  onTuningChanged?: (tuning: MoveTuning | null, mode: PlayMode) => void;
  /** Move-check telemetry, for the monitor. `t` is the pose clock. */
  onTelemetry?: (mode: PlayMode, event: MoveCheckEvent, t: number) => void;
}

/**
 * The threshold keys a stored record actually puts in force. A record holds only the keys that
 * were measured; `applyTuning` derives each one's companions (the re-arm keys, and the jump
 * velocities), so a rebuilt cheat sheet has to ask it rather than count the stored keys — or it
 * would claim fewer tuned settings than the card the check itself ended on.
 */
export function tunedInForce(tuning: MoveTuning | null): Partial<Thresholds> {
  if (!tuning) return {};
  const th = { ...DEFAULT_THRESHOLDS };
  applyTuning(th, tuning);
  const out: Partial<Thresholds> = {};
  for (const key of TUNABLE_KEYS) if (th[key] !== DEFAULT_THRESHOLDS[key]) out[key] = th[key];
  return out;
}

/**
 * A cheat sheet for a player who has not run a check this session: the moves of `mode` with
 * whatever the saved record measured. The hoverboard tunes nothing, so it has no peak to show and
 * counts as done whenever there is a record at all.
 */
export function summaryFromTuning(mode: PlayMode, tuning: MoveTuning | null): MoveCheckSummary {
  const steps: MoveStepModel[] = new MoveCheck(mode).model.steps.map((s) => {
    const peak = tuning?.peaks[s.id] ?? null;
    const done = peak !== null || (s.id === 'hover' && tuning !== null);
    return { ...s, status: done ? 'done' : 'skipped', hint: null, canSkip: false, canAccept: false, progress: 0, peak, steps: null };
  });
  return { mode, steps, tuned: tunedInForce(tuning), asymmetryNote: null };
}

export class MoveCheckSession {
  readonly store: MoveTuningStore;
  readonly handlers: MoveCheckHandlers;
  /** The summary of the last check finished this session, for the pause screen's Controls card. */
  lastSummary: MoveCheckSummary | null = null;

  private readonly th: Thresholds;
  private readonly opts: MoveCheckSessionOptions;
  private check: MoveCheck | null = null;
  private mode: PlayMode = 'full';
  /** Pose clock of the last frame, so a handler's telemetry lands on the same timeline. */
  private lastT = 0;
  /** Step index whose "go" has been reported, and the statuses already reported. */
  private toldIndex = -1;
  private readonly toldResult = new Set<MoveId>();
  private saved = false;
  /** The mode whose saved tuning is in force on `th` right now. */
  private appliedMode: PlayMode | null = null;
  /** Bumped whenever a tuning is saved or cleared, so `controls` can memoize on it. */
  private rev = 0;
  private controlsCache: { mode: PlayMode; rev: number; summary: MoveCheckSummary } | null = null;

  constructor(opts: MoveCheckSessionOptions) {
    this.opts = opts;
    this.th = opts.thresholds;
    this.store = opts.store ?? new MoveTuningStore();
    this.handlers = {
      skipStep: () => this.act((c) => c.skipStep()),
      acceptBest: () => this.act((c) => c.acceptBest()),
      skipAll: () => this.act((c) => c.skipAll()),
      redo: () => this.act((c) => this.restart(c)),
      resetTuning: () => this.resetTuning(),
      start: () => this.opts.onStart?.(),
    };
  }

  /** The model to render, or null when no check is running (the screen hides itself on null). */
  get model(): MoveCheckModel | null {
    return this.check?.model ?? null;
  }

  get running(): boolean {
    return this.check !== null;
  }

  /** True when this machine has a saved tuning — the flow's cue to offer the check rather than run it. */
  get seen(): boolean {
    return !this.store.empty;
  }

  /** The flow's `startMoveCheck` effect. `mode` is the detected or forced play mode. */
  begin(mode: PlayMode): void {
    this.mode = mode;
    this.check = new MoveCheck(mode);
    this.toldIndex = -1;
    this.toldResult.clear();
    this.saved = false;
    this.freeze(true);
  }

  /** The flow's `endMoveCheck` effect. Whatever was measured has already been saved. */
  end(): void {
    this.check = null;
    this.freeze(false);
  }

  /** One pose frame, from the same callback that feeds the controller's events to telemetry. */
  frame(src: MoveCheckSource, events: readonly PoseEvent[], tMs: number): void {
    const check = this.check;
    if (!check) return;
    this.lastT = tMs;
    check.update(src, events, tMs);
    this.sync();
  }

  /**
   * Puts the saved tuning for `mode` on the live thresholds, replacing any earlier one. Called
   * before the first run and whenever the play mode changes, because tuning is per mode.
   * A null mode (nothing detected or forced yet) restores the defaults.
   */
  applyFor(mode: PlayMode | null): void {
    if (mode === this.appliedMode) return;
    this.appliedMode = mode;
    applyTuning(this.th, mode ? this.store.get(mode) : null);
  }

  /** The tuning currently in force, for the recorded session's meta. */
  tuningInForce(): MoveTuning | null {
    return this.appliedMode ? this.store.get(this.appliedMode) : null;
  }

  /**
   * The card the pause screen shows as "Controls": this session's check, else the saved tuning.
   * The same object comes back until something changes it, so a caller can cache the rendered card.
   */
  controls(mode: PlayMode | null): MoveCheckSummary {
    const m = mode ?? this.lastSummary?.mode ?? this.mode;
    if (this.lastSummary && this.lastSummary.mode === m) return this.lastSummary;
    const cache = this.controlsCache;
    if (cache && cache.mode === m && cache.rev === this.rev) return cache.summary;
    const summary = summaryFromTuning(m, this.store.get(m));
    this.controlsCache = { mode: m, rev: this.rev, summary };
    return summary;
  }

  // ---------------------------------------------------------------- internals

  private act(fn: (c: MoveCheck) => void): void {
    const check = this.check;
    if (!check) return;
    fn(check);
    this.sync();
  }

  private restart(check: MoveCheck): void {
    check.reset();
    this.toldIndex = -1;
    this.toldResult.clear();
    this.saved = false;
    this.freeze(true);
  }

  /** Pinned exactly while a step is being measured, so the baseline can follow the player again
   *  the moment the summary is up and they stop posing. */
  private freeze(on: boolean): void {
    const c = this.opts.controller;
    if (c) c.freezeBaseline = on;
  }

  /** Reports what changed since the last call, and saves the tuning the moment the check finishes. */
  private sync(): void {
    const check = this.check;
    if (!check) return;
    const m = check.model;
    for (const step of m.steps) {
      // 'active' is not a result: only a step that has landed one way or the other is reported.
      if (step.status === 'todo' || step.status === 'active' || this.toldResult.has(step.id)) continue;
      this.toldResult.add(step.id);
      this.tell({ phase: 'result', move: step.id, result: step.status === 'done' ? 'done' : 'skipped', peak: step.peak, progress: step.progress });
    }
    const step = m.summary ? undefined : m.steps[m.index];
    if (step && m.index !== this.toldIndex) {
      this.toldIndex = m.index;
      this.tell({ phase: 'start', move: step.id });
    }
    if (m.summary && !this.saved) this.finish(check, m.summary);
  }

  private finish(check: MoveCheck, summary: MoveCheckSummary): void {
    this.saved = true;
    this.rev++;
    this.freeze(false);
    this.lastSummary = summary;
    const record = check.tuning(this.opts.now?.() ?? Date.now());
    if (!record) return;
    // The store merges this over the mode's earlier record, so a step the player skipped this time
    // keeps what it was tuned to before rather than falling back to the shipped default.
    this.store.save(record);
    const saved = this.store.get(this.mode);
    // In force for the very next run.
    this.appliedMode = this.mode;
    applyTuning(this.th, saved);
    this.tell({ phase: 'done', tuned: { ...(saved?.thresholds as Record<string, number> | undefined) }, note: summary.asymmetryNote });
    this.opts.onTuningChanged?.(saved, this.mode);
  }

  /** "Reset to defaults": forget this mode's record, restore the shipped thresholds, measure again. */
  private resetTuning(): void {
    this.rev++;
    this.store.clear(this.mode);
    this.appliedMode = this.mode;
    applyTuning(this.th, null);
    this.lastSummary = null;
    this.tell({ phase: 'done', tuned: {}, note: 'reset to defaults' });
    this.opts.onTuningChanged?.(null, this.mode);
    if (this.check) this.restart(this.check);
  }

  private tell(e: MoveCheckEvent): void {
    this.opts.onTelemetry?.(this.mode, e, this.lastT);
  }
}
