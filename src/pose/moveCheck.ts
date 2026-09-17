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
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import { tuneKey, tunedValue, type ThresholdKey } from './tuning';
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
  /**
   * A second floor the detector imposes on top of the threshold, in the same units. Without it the
   * check would promise a move that the detector still refuses, and the progress bar would lie.
   */
  floor?(m: Readonly<MoveMagnitudes>, th: Thresholds): number;
}

const sig = (key: ThresholdKey, read: (m: Readonly<MoveMagnitudes>) => number, floor?: Signal['floor']): Signal => ({
  key,
  read,
  floor,
});

/** The jump also has to clear the jogger's own bounce (`moves.ts`), or every step would be a jump. */
const bobFloor = (m: Readonly<MoveMagnitudes>, th: Thresholds): number => th.bobJumpFactor * m.bobAmp;

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
    jump: [sig('jumpRise', rise, bobFloor)],
    roll: [sig('rollDrop', hipDrop)],
    hover: [],
  },
  small: {
    jog: [sig('wristPump', jogPrimary), sig('bobMinAmp', bobAmp)],
    left: [sig('leanDeg', tiltLeft), sig('noseShift', noseLeft)],
    right: [sig('leanDeg', tiltRight), sig('noseShift', noseRight)],
    jump: [sig('smallJumpRise', rise, bobFloor)],
    roll: [sig('duckDrop', headDrop)],
    hover: [],
  },
};

/** Two measurements of the same move far enough apart to be treated as different moves. */
const lopsided = (a: number, b: number): boolean => {
  const bigger = Math.max(a, b);
  return bigger > 0 && Math.abs(a - b) / bigger > ASYMMETRY_FRACTION;
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
  /** What each signal had to reach, as of the last frame — the line "was this measured at all?" uses. */
  readonly needs: number[];
  /** Packed inputs of the current hint, so an unchanged hint is not rebuilt 30 times a second. */
  hintSig = -1;
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
    this.needs = signals.map(() => 0);
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
    this.needs.fill(0);
    this.hintSig = -1;
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
    if (this.view.summary) return this.view;
    // Two passes at most: the step whose tick has just run out, and the one that becomes active on
    // the same frame — whose event may already be sitting in this frame's list. The hoverboard fires
    // once per hold, so dropping that one event would cost the player a whole raise of both arms.
    for (let pass = 0; pass < 2 && this.view.index < this.steps.length; pass++) {
      const step = this.steps[this.view.index];
      if (Number.isNaN(step.startT)) {
        step.startT = tMs;
        // The jog step counts steps taken from here on, not the ones already on the clock.
        step.jogFrom = src.magnitudes.jogSteps;
      }

      const active = step.model.status === 'active';
      // A tick holds for ADVANCE_MS, and the peak keeps rising through it: a jump's apex comes after
      // the detector has already fired, and that apex is the number worth tuning from.
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
        break;
      }
      if (tMs - step.doneT < ADVANCE_MS) break;
      this.advance();
    }
    return this.view;
  }

  /**
   * Leaves this step untuned and moves on. Refused, and returns false, until the step actually
   * offers it (`canSkip`): the rule belongs to the machine, not to whichever button calls it.
   * `skipAll` is the way out that is always available.
   */
  skipStep(): boolean {
    const step = this.current;
    if (!step?.model.canSkip) return false;
    step.model.status = 'skipped';
    this.advance();
    return true;
  }

  /**
   * "Use an easier setting": takes the best attempt as the tuning input and moves on. Only the
   * steps whose difficulty is a threshold offer it, so this is refused elsewhere.
   */
  acceptBest(): boolean {
    const step = this.current;
    if (!step?.model.canAccept) return false;
    step.accepted = true;
    step.model.status = 'skipped';
    this.advance();
    return true;
  }

  /** The step awaiting the player, or null when none is (finished, or mid-tick). */
  private get current(): Step | null {
    if (this.view.summary || this.view.index >= this.steps.length) return null;
    const step = this.steps[this.view.index];
    return step.model.status === 'active' ? step : null;
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
   * supplied by the caller so this stays deterministic. It describes *this* run only: a step the
   * player skipped is absent rather than reset, which is what lets `MoveTuningStore.save` keep the
   * threshold they tuned for it last time.
   */
  tuning(at: number): MoveTuning | null {
    if (!this.view.summary) return null;
    const peaks: Partial<Record<MoveId, number>> = {};
    for (const s of this.steps) if (s.tunable && s.signals.length) peaks[s.id] = s.peaks[0];
    const keyPeaks = this.keyPeaks();
    const thresholds: Partial<Thresholds> = {};
    // Measured keys only. Re-arm and velocity companions are derived from these on apply, so a
    // record can never carry a companion that disagrees with the key it belongs to.
    for (const [key, peak] of Object.entries(keyPeaks)) thresholds[key as ThresholdKey] = tunedValue(key as ThresholdKey, peak);
    const record: MoveTuning = { mode: this.mode, at, thresholds, peaks };
    if (Object.keys(keyPeaks).length) record.keyPeaks = keyPeaks;
    return record;
  }

  private measure(step: Step, src: MoveCheckSource): void {
    const m = src.magnitudes;
    let best = 0;
    let now = 0;
    for (let i = 0; i < step.signals.length; i++) {
      const s = step.signals[i];
      const need = this.need(s, src);
      const value = s.read(m);
      step.needs[i] = need;
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

  /**
   * What this signal has to reach right now: the live threshold eased by the sensitivity setting,
   * and never less than any extra floor the detector imposes. A threshold that is somehow not a
   * finite number falls back to the shipped default rather than silently killing all feedback.
   */
  private need(s: Signal, src: MoveCheckSource): number {
    const sens = Number.isFinite(src.sensitivity) && src.sensitivity > 0 ? src.sensitivity : 1;
    const live = src.th[s.key];
    const base = (Number.isFinite(live) ? live : DEFAULT_THRESHOLDS[s.key]) / sens;
    if (!s.floor) return base;
    const floor = s.floor(src.magnitudes, src.th);
    return Number.isFinite(floor) && floor > base ? floor : base;
  }

  private describe(step: Step, tMs: number): void {
    const m = step.model;
    const near = m.progress >= NEAR_MISS_FRACTION;
    // A full bar on a move that still has not fired means the other gate is the one in the way: for
    // the jump that is speed, and telling this player to go further is advice they cannot act on.
    const tooSlow = step.id === 'jump' && m.progress >= 1;
    m.canSkip = tMs - step.startT >= OFFER_SKIP_MS || step.attempts >= OFFER_SKIP_ATTEMPTS;
    m.canAccept = m.canSkip && CAN_ACCEPT.has(step.id);
    const sig =
      (near ? 1 : 0) | (tooSlow ? 2 : 0) | (m.canSkip ? 4 : 0) | (m.canAccept ? 8 : 0) | (step.attempts << 4);
    if (sig === step.hintSig) return;
    step.hintSig = sig;
    const out = m.canAccept ? 'use your best attempt' : 'skip this move';
    const almost = tooSlow ? 'Almost — try a quicker hop' : 'Almost — go a bit further';
    if ((near || tooSlow) && m.canSkip) m.hint = `${almost}, or ${out}`;
    else if (near || tooSlow) m.hint = almost;
    else if (m.canSkip) m.hint = `No luck yet — ${m.canAccept ? 'skip it, or use your best attempt' : 'you can skip this move'}`;
    else if (step.attempts > 0) m.hint = `${step.attempts} near ${step.attempts === 1 ? 'miss' : 'misses'} so far`;
    else m.hint = null;
  }

  private clearHints(step: Step): void {
    step.hintSig = -1;
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

  /**
   * What each tuned key was measured at, per side.
   *
   * A signal the player never used contributes nothing. Several detectors fire on *either* of two
   * signals — a small-room lane change on a shoulder lean or a nose shift, the jog on an arm pump or
   * a vertical bob — so a player who follows the instruction exercises one of them and leaves the
   * other at nearly zero. Tuning that one anyway would read "they can barely manage it" from a
   * measurement that was never taken, drop it to the bottom of the band, and hand the player a game
   * where glancing sideways changes lane. Anything below the near-miss line is left alone.
   */
  private contributions(): Map<ThresholdKey, { left: number | null; right: number | null; rest: number[] }> {
    const out = new Map<ThresholdKey, { left: number | null; right: number | null; rest: number[] }>();
    for (const step of this.steps) {
      if (!step.tunable) continue;
      const used = step.signals.map((_, i) => step.needs[i] > 0 && step.peaks[i] >= NEAR_MISS_FRACTION * step.needs[i]);
      // "Use an easier setting" has to mean something even when nothing cleared that line, so it
      // falls back to the primary signal — the one the on-screen instruction actually names.
      if (step.accepted && step.signals.length && !used.some(Boolean)) used[0] = true;
      for (let i = 0; i < step.signals.length; i++) {
        if (!used[i]) continue;
        const key = step.signals[i].key;
        const c = out.get(key) ?? { left: null, right: null, rest: [] };
        if (step.id === 'left') c.left = step.peaks[i];
        else if (step.id === 'right') c.right = step.peaks[i];
        else c.rest.push(step.peaks[i]);
        out.set(key, c);
      }
    }
    return out;
  }

  /** Peaks per threshold key, the two sides resolved into one number. */
  private keyPeaks(): Partial<Record<ThresholdKey, number>> {
    const out: Partial<Record<ThresholdKey, number>> = {};
    for (const [key, c] of this.contributions()) {
      const sides = [c.left, c.right].filter((v): v is number => v !== null);
      // Lopsided sides must not average: the mean always sits above the weaker side's own peak, so
      // the threshold would be one the player has just shown they cannot reach on that side — and
      // for a bad enough asymmetry it lands above the shipped default, leaving them worse off than
      // if they had never run the check. Tune to the side that needs the help.
      if (sides.length === 2 && lopsided(sides[0], sides[1])) {
        out[key] = Math.min(sides[0], sides[1]);
        continue;
      }
      const all = [...sides, ...c.rest];
      if (all.length) out[key] = all.reduce((a, b) => a + b, 0) / all.length;
    }
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
   * A player whose two sides differ a lot is told, rather than quietly given a threshold tuned to
   * the side they happen to be better on. Every key the lanes tune is checked, not just the first:
   * a player can lean on one side and shift their head on the other.
   */
  private asymmetryNote(): string | null {
    const contributions = this.contributions();
    const left = this.steps.find((s) => s.id === 'left')!;
    for (const signal of left.signals) {
      const c = contributions.get(signal.key);
      if (!c || c.left === null || c.right === null || !lopsided(c.left, c.right)) continue;
      const word = this.mode === 'full' ? 'step' : 'lean';
      const [small, large] = c.left < c.right ? ['left', 'right'] : ['right', 'left'];
      return `Your ${small} ${word} is much smaller than your ${large} — the game is tuned to the smaller one, so both work.`;
    }
    return null;
  }
}
