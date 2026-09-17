/**
 * The Move Check step machine: it walks the player through every move once, confirms each one was
 * seen, and records how big that player's version of it is so the thresholds can be tuned to them.
 * Spec: docs/superpowers/specs/2026-09-17-move-check.md
 *
 * Framework-free and deterministic: no DOM, no timers (time arrives as `tMs`), no allocation in
 * `update`. The model and its step objects are the same references every frame — the UI renders
 * them, the flow calls the handlers, and neither owns any of this state.
 */
import {
  MOVE_ORDER,
  type MoveCheckModel,
  type MoveCheckSummary,
  type MoveId,
  type MoveStepModel,
  type MoveTuning,
} from './moveCheckTypes';
import type { Thresholds } from './thresholds';
import { tuneKey, type ThresholdKey } from './tuning';
import type { MoveMagnitudes, PlayMode, PoseEvent } from './types';

/** What the check needs from the pose pipeline each frame. `PoseController` satisfies it. */
export interface MoveCheckSource {
  /** The thresholds actually in force, which may already carry an earlier tuning. */
  readonly th: Thresholds;
  readonly sensitivity: number;
  readonly magnitudes: Readonly<MoveMagnitudes>;
}

/** A peak this far along to the threshold counts as a near miss worth telling the player about. */
export const NEAR_MISS_FRACTION = 0.5;
/** An attempt is over once the signal falls back this far; the next rise is a new one. */
export const ATTEMPT_RESET_FRACTION = 0.3;
/** How long the ✓ stays up before the next step. */
export const ADVANCE_MS = 600;
/** A step this old may be skipped... */
export const OFFER_SKIP_MS = 10_000;
/** ...as may one the player has nearly hit this many times. */
export const OFFER_SKIP_ATTEMPTS = 4;
export const JOG_STEPS_NEEDED = 4;
/** Left and right further apart than this are flagged rather than silently averaged. */
export const ASYMMETRY_FRACTION = 0.4;

/** One measurable signal of a move: the threshold key it tunes, and how to read its magnitude. */
interface Signal {
  key: ThresholdKey;
  read(m: Readonly<MoveMagnitudes>): number;
}

const sig = (key: ThresholdKey, read: (m: Readonly<MoveMagnitudes>) => number): Signal => ({ key, read });

// Read functions are module constants, so a frame allocates nothing.
const jogPrimary = (m: Readonly<MoveMagnitudes>) => m.jogPrimary;
const bobAmp = (m: Readonly<MoveMagnitudes>) => m.bobAmp;
const laneLeft = (m: Readonly<MoveMagnitudes>) => -m.lane;
const laneRight = (m: Readonly<MoveMagnitudes>) => m.lane;
const tiltLeft = (m: Readonly<MoveMagnitudes>) => -m.tiltDeg;
const tiltRight = (m: Readonly<MoveMagnitudes>) => m.tiltDeg;
const noseLeft = (m: Readonly<MoveMagnitudes>) => -m.noseShift;
const noseRight = (m: Readonly<MoveMagnitudes>) => m.noseShift;
const rise = (m: Readonly<MoveMagnitudes>) => m.rise;
const hipDrop = (m: Readonly<MoveMagnitudes>) => m.drop;
const headDrop = (m: Readonly<MoveMagnitudes>) => m.headDrop;

const LABELS: Record<MoveId, string> = {
  jog: 'Jog',
  left: 'Left',
  right: 'Right',
  jump: 'Jump',
  roll: 'Roll',
  hover: 'Hoverboard',
};

const HOW: Record<PlayMode, Record<MoveId, string>> = {
  full: {
    jog: 'Jog in place — lift your knees',
    left: 'Step to your LEFT',
    right: 'Step to your RIGHT',
    jump: 'Jump up!',
    roll: 'Squat down / duck',
    hover: 'Both hands up!',
  },
  small: {
    jog: 'Jog in place, or pump your arms',
    left: 'Lean your shoulders LEFT',
    right: 'Lean your shoulders RIGHT',
    jump: 'Jump, or hop on your toes',
    roll: 'Duck your head down',
    hover: 'Both hands up!',
  },
};

/** The signals each step measures and tunes, per the spec's tuning table. */
const SIGNALS: Record<PlayMode, Record<MoveId, readonly Signal[]>> = {
  full: {
    jog: [sig('kneeLift', jogPrimary)],
    left: [sig('laneEnter', laneLeft)],
    right: [sig('laneEnter', laneRight)],
    jump: [sig('jumpRise', rise)],
    roll: [sig('rollDrop', hipDrop)],
    hover: [],
  },
  small: {
    jog: [sig('wristPump', jogPrimary), sig('bobMinAmp', bobAmp)],
    left: [sig('leanDeg', tiltLeft), sig('noseShift', noseLeft)],
    right: [sig('leanDeg', tiltRight), sig('noseShift', noseRight)],
    jump: [sig('smallJumpRise', rise)],
    roll: [sig('duckDrop', headDrop)],
    hover: [],
  },
};

/** Steps whose difficulty is a threshold, so "use an easier setting" means something. */
const CAN_ACCEPT: ReadonlySet<MoveId> = new Set<MoveId>(['left', 'right', 'jump', 'roll']);

/** Does `event` mean this move was just seen? The jog is counted in steps instead. */
function fires(id: MoveId, mode: PlayMode, e: PoseEvent): boolean {
  switch (id) {
    case 'left':
      return mode === 'full' ? e.type === 'lane' && e.lane === -1 : e.type === 'laneShift' && e.dir === -1;
    case 'right':
      return mode === 'full' ? e.type === 'lane' && e.lane === 1 : e.type === 'laneShift' && e.dir === 1;
    case 'jump':
      return e.type === 'jump';
    case 'roll':
      return e.type === 'roll';
    case 'hover':
      return e.type === 'hoverboard';
    default:
      return false;
  }
}

class Step {
  readonly model: MoveStepModel;
  readonly peaks: number[];
  startT = Number.NaN;
  doneT = Number.NaN;
  attempts = 0;
  /** True while the signal is up in an attempt that has not fired yet. */
  attempting = false;
  /** Jog steps already counted when this step became active. */
  jogFrom = 0;
  /** The player took the "easier setting" option: tune from the best attempt anyway. */
  accepted = false;

  constructor(readonly id: MoveId, mode: PlayMode, readonly signals: readonly Signal[]) {
    this.peaks = signals.map(() => 0);
    this.model = {
      id,
      status: 'todo',
      label: LABELS[id],
      how: HOW[mode][id],
      hint: null,
      canSkip: false,
      canAccept: false,
      progress: 0,
      peak: null,
      steps: id === 'jog' ? { seen: 0, needed: JOG_STEPS_NEEDED } : null,
    };
  }

  reset(): void {
    this.peaks.fill(0);
    this.startT = Number.NaN;
    this.doneT = Number.NaN;
    this.attempts = 0;
    this.attempting = false;
    this.jogFrom = 0;
    this.accepted = false;
    const m = this.model;
    m.status = 'todo';
    m.hint = null;
    m.canSkip = false;
    m.canAccept = false;
    m.progress = 0;
    m.peak = null;
    if (m.steps) m.steps.seen = 0;
  }

  /** Whatever this step measured is worth tuning from: it was detected, or accepted as-is. */
  get tunable(): boolean {
    return this.model.status === 'done' || this.accepted;
  }
}

const snapshot = (m: MoveStepModel): MoveStepModel => ({ ...m, steps: m.steps ? { ...m.steps } : null });

export class MoveCheck {
  private readonly steps: Step[];
  private readonly view: MoveCheckModel;
  private lastT = 0;

  constructor(readonly mode: PlayMode) {
    this.steps = MOVE_ORDER.map((id) => new Step(id, mode, SIGNALS[mode][id]));
    this.view = { mode, index: 0, steps: this.steps.map((s) => s.model), summary: null };
    this.steps[0].model.status = 'active';
  }

  get model(): MoveCheckModel {
    return this.view;
  }

  get finished(): boolean {
    return this.view.summary !== null;
  }

  /** Back to the first step, forgetting every measurement. The "Redo the check" handler. */
  reset(): void {
    for (const s of this.steps) s.reset();
    this.view.index = 0;
    this.view.summary = null;
    this.steps[0].model.status = 'active';
  }

  /**
   * One frame of the pose pipeline. `events` are the events that frame produced, in order.
   * Returns the model, which is the same object every time.
   */
  update(src: MoveCheckSource, events: readonly PoseEvent[], tMs: number): MoveCheckModel {
    this.lastT = tMs;
    if (this.view.summary) return this.view;
    const step = this.steps[this.view.index];
    if (Number.isNaN(step.startT)) {
      step.startT = tMs;
      // The jog step counts steps taken from here on, not the ones already on the clock.
      step.jogFrom = src.magnitudes.jogSteps;
    }

    const active = step.model.status === 'active';
    // A ✓ holds for ADVANCE_MS, and the peak keeps rising through it: a jump's apex comes after the
    // detector has already fired, and that apex is the number worth tuning from.
    if (active || step.model.status === 'done') this.measure(step, src);

    if (active) {
      if (step.id === 'jog') {
        const seen = Math.max(0, src.magnitudes.jogSteps - step.jogFrom);
        step.model.steps!.seen = Math.min(seen, JOG_STEPS_NEEDED);
        if (seen >= JOG_STEPS_NEEDED) this.succeed(step, tMs);
      } else {
        for (const e of events) {
          if (fires(step.id, this.mode, e)) {
            this.succeed(step, tMs);
            break;
          }
        }
      }
      if (step.model.status === 'active') this.describe(step, tMs);
    } else if (tMs - step.doneT >= ADVANCE_MS) {
      this.advance();
    }
    return this.view;
  }

  /** Leaves this step untuned and moves on. */
  skipStep(): void {
    const step = this.steps[this.view.index];
    if (!this.view.summary && step.model.status === 'active') {
      step.model.status = 'skipped';
      this.advance();
    }
  }

  /** "Use an easier setting": takes the best attempt as the tuning input and moves on. */
  acceptBest(): void {
    const step = this.steps[this.view.index];
    if (!this.view.summary && step.model.status === 'active') {
      step.accepted = true;
      step.model.status = 'skipped';
      this.advance();
    }
  }

  /** Abandons the rest of the check. What was already measured still counts. */
  skipAll(): void {
    if (this.view.summary) return;
    for (let i = this.view.index; i < this.steps.length; i++) {
      const m = this.steps[i].model;
      if (m.status === 'active' || m.status === 'todo') m.status = 'skipped';
      this.clearHints(this.steps[i]);
    }
    this.view.index = this.steps.length;
    this.finish();
  }

  /**
   * The record to persist, once the check has finished; null before that. `at` is epoch ms,
   * supplied by the caller so this stays deterministic.
   */
  tuning(at: number): MoveTuning | null {
    const summary = this.view.summary;
    if (!summary) return null;
    const peaks: Partial<Record<MoveId, number>> = {};
    for (const s of this.steps) if (s.tunable && s.signals.length) peaks[s.id] = s.peaks[0];
    const record: MoveTuning = { mode: this.mode, at, thresholds: { ...summary.tuned }, peaks };
    const keyPeaks = this.keyPeaks();
    if (Object.keys(keyPeaks).length) record.keyPeaks = keyPeaks;
    return record;
  }

  private measure(step: Step, src: MoveCheckSource): void {
    const m = src.magnitudes;
    let best = 0;
    let now = 0;
    for (let i = 0; i < step.signals.length; i++) {
      const s = step.signals[i];
      const need = this.need(s.key, src);
      const value = s.read(m);
      if (value > step.peaks[i]) step.peaks[i] = value;
      if (need > 0) {
        best = Math.max(best, step.peaks[i] / need);
        now = Math.max(now, value / need);
      }
    }
    if (step.signals.length) {
      step.model.peak = step.peaks[0];
      step.model.progress = Math.min(1, best);
    }
    if (step.model.status !== 'active') return;
    // One attempt per excursion above the near-miss line that does not fire.
    if (!step.attempting && now >= NEAR_MISS_FRACTION) step.attempting = true;
    else if (step.attempting && now < ATTEMPT_RESET_FRACTION) {
      step.attempting = false;
      step.attempts++;
    }
  }

  /** What this signal has to reach right now: the live threshold, eased by the sensitivity setting. */
  private need(key: ThresholdKey, src: MoveCheckSource): number {
    const sens = Number.isFinite(src.sensitivity) && src.sensitivity > 0 ? src.sensitivity : 1;
    return src.th[key] / sens;
  }

  private describe(step: Step, tMs: number): void {
    const m = step.model;
    const near = m.progress >= NEAR_MISS_FRACTION;
    m.canSkip = tMs - step.startT >= OFFER_SKIP_MS || step.attempts >= OFFER_SKIP_ATTEMPTS;
    m.canAccept = m.canSkip && CAN_ACCEPT.has(step.id);
    const out = m.canAccept ? 'use your best attempt' : 'skip this move';
    if (near && m.canSkip) m.hint = `Almost — go a bit further, or ${out}`;
    else if (near) m.hint = 'Almost — go a bit further';
    else if (m.canSkip) m.hint = `No luck yet — ${m.canAccept ? 'skip it, or use your best attempt' : 'you can skip this move'}`;
    else if (step.attempts > 0) m.hint = `${step.attempts} near ${step.attempts === 1 ? 'miss' : 'misses'} so far`;
    else m.hint = null;
  }

  private clearHints(step: Step): void {
    step.model.hint = null;
    step.model.canSkip = false;
    step.model.canAccept = false;
  }

  private succeed(step: Step, tMs: number): void {
    step.model.status = 'done';
    step.doneT = tMs;
    step.attempting = false;
    this.clearHints(step);
  }

  private advance(): void {
    const step = this.steps[this.view.index];
    this.clearHints(step);
    this.view.index++;
    if (this.view.index >= this.steps.length) {
      this.finish();
      return;
    }
    const next = this.steps[this.view.index];
    next.model.status = 'active';
    // Left NaN on purpose: the next frame stamps the start and the jog-step mark together.
    next.startT = Number.NaN;
  }

  /** Peaks per threshold key, left and right averaged into one. */
  private keyPeaks(): Partial<Record<ThresholdKey, number>> {
    const sums = new Map<ThresholdKey, { total: number; n: number }>();
    for (const step of this.steps) {
      if (!step.tunable) continue;
      for (let i = 0; i < step.signals.length; i++) {
        const key = step.signals[i].key;
        const acc = sums.get(key) ?? { total: 0, n: 0 };
        acc.total += step.peaks[i];
        acc.n++;
        sums.set(key, acc);
      }
    }
    const out: Partial<Record<ThresholdKey, number>> = {};
    for (const [key, { total, n }] of sums) out[key] = total / n;
    return out;
  }

  private finish(): void {
    const tuned: Partial<Thresholds> = {};
    for (const [key, peak] of Object.entries(this.keyPeaks())) tuneKey(tuned, key as ThresholdKey, peak);
    this.view.summary = {
      mode: this.mode,
      steps: this.steps.map((s) => snapshot(s.model)),
      tuned,
      asymmetryNote: this.asymmetryNote(),
    };
  }

  /**
   * Left and right are averaged into one symmetric threshold, so a player whose two sides differ a
   * lot is told rather than quietly given a threshold their weaker side cannot reach.
   */
  private asymmetryNote(): string | null {
    const left = this.steps.find((s) => s.id === 'left')!;
    const right = this.steps.find((s) => s.id === 'right')!;
    if (!left.tunable || !right.tunable) return null;
    const l = left.peaks[0];
    const r = right.peaks[0];
    const bigger = Math.max(l, r);
    if (bigger <= 0 || Math.abs(l - r) / bigger <= ASYMMETRY_FRACTION) return null;
    const word = this.mode === 'full' ? 'step' : 'lean';
    const [small, large] = l < r ? ['left', 'right'] : ['right', 'left'];
    return `Your ${small} ${word} is much smaller than your ${large} — the game uses the average of the two.`;
  }
}
