import { Calibrator, driftBaseline, driftBaselineX, rebaseBaselineX, type Baseline } from './calibration';
import { GestureDetector } from './gestures';
import { JogDetector } from './jog';
import { dist, toBody, VISIBLE, type Body } from './landmarks';
import { clearMagnitudes, emptyMagnitudes, FullBodyMoves, SmallRoomMoves } from './moves';
import { PoseSmoother } from './oneEuro';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import type { MoveMagnitudes, PlayMode, Pose, PoseEvent, PoseFrame, PoseStatus } from './types';

export interface PoseControllerOptions {
  /** Overrides merged over DEFAULT_THRESHOLDS. Tune live through `ctrl.th`, not this object. */
  thresholds?: Partial<Thresholds>;
  sensitivity?: number;
  forcedMode?: PlayMode | null;
}

const SLOW_POSE_FPS = 15;
const MIN_SENSITIVITY = 0.75;
const MAX_SENSITIVITY = 1.25;
/** Calibration survives pose gaps up to this long. */
const CALIB_GAP_MS = 300;
const SLOW_POSE_AFTER_MS = 2000;

/**
 * Turns a stream of pose frames into game-agnostic move events and a status snapshot.
 *
 * `status.jog.msSinceStep` keeps counting through a lost/found gap. Losing tracking must never
 * count as idle (spec §5.5), so the game should run its own idle clock that restarts on resume
 * rather than using msSinceStep directly across a pause.
 */
export class PoseController {
  /** Live thresholds: every detector reads this object, so edit it in place to tune. */
  readonly th: Thresholds;
  forcedMode: PlayMode | null;
  baseline: Baseline | null = null;
  body: Body | null = null;

  private calibrator: Calibrator;
  private jog: JogDetector;
  private gestures: GestureDetector;
  private full: FullBodyMoves;
  private small: SmallRoomMoves;
  private smoother = new PoseSmoother();
  private readonly mag = emptyMagnitudes();
  private pose: Pose | null = null;
  private lastSeenT: number | null = null;
  private lost = false;
  private lastT: number | null = null;
  private firstT: number | null = null;
  private fps = 0;
  private sens = 1;
  private now = 0;

  constructor(opts: PoseControllerOptions = {}) {
    this.th = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.sensitivity = opts.sensitivity ?? 1;
    this.forcedMode = opts.forcedMode ?? null;
    this.calibrator = new Calibrator(this.th);
    this.jog = new JogDetector(this.th, this.mag);
    this.gestures = new GestureDetector(this.th);
    // Both modes write into the same readout; only the calibrated one ever runs.
    this.full = new FullBodyMoves(this.th, this.mag);
    this.small = new SmallRoomMoves(this.th, this.mag);
  }

  /**
   * Live readout of what the move detectors measured on the last frame, in their thresholds' own
   * units (see `MoveMagnitudes`). The same object every time: read it, never keep it as a snapshot.
   */
  get magnitudes(): Readonly<MoveMagnitudes> {
    return this.mag;
  }

  /** Move sensitivity, clamped to [0.75, 1.25]; higher makes moves easier to trigger. */
  get sensitivity(): number {
    return this.sens;
  }

  set sensitivity(v: number) {
    this.sens = Number.isFinite(v) ? Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, v)) : 1;
  }

  /** Forgets the baseline and move state. Returns a `lane: 0` event if the player was in a side lane. */
  recalibrate(): PoseEvent[] {
    const events: PoseEvent[] = this.full.lane !== 0 ? [{ type: 'lane', lane: 0 }] : [];
    this.baseline = null;
    this.calibrator.reset();
    this.jog.reset();
    this.full.reset();
    this.small.reset();
    clearMagnitudes(this.mag);
    return events;
  }

  get status(): PoseStatus {
    const poseFps = Math.round(this.fps);
    const base = this.baseline;
    return {
      tracking: this.body !== null,
      calibrated: this.baseline !== null,
      mode: this.baseline?.mode ?? null,
      lane: this.full.lane,
      poseFps,
      confidence: this.body?.confidence ?? 0,
      jog: this.jog.status(this.now),
      startProgress: this.gestures.startProgress,
      calibration: { ...this.calibrator.state },
      pose: this.pose,
      lastFrameT: this.lastT,
      squatting: base ? (base.mode === 'full' ? this.full : this.small).isDown : false,
      slowPose:
        this.firstT !== null &&
        this.lastT !== null &&
        this.lastT - this.firstT >= SLOW_POSE_AFTER_MS &&
        poseFps > 0 &&
        poseFps < SLOW_POSE_FPS,
    };
  }

  /**
   * Non-allocating `status`: fills `out` (and its nested `jog`/`calibration` objects) in place and
   * returns the same reference. For a 60 Hz poller (`PoseCommandSource.activity()`); read or copy
   * the result at once, never hold onto `out.jog`/`out.calibration` across calls expecting them to
   * be snapshots.
   */
  statusInto(out: PoseStatus): PoseStatus {
    const poseFps = Math.round(this.fps);
    const base = this.baseline;
    out.tracking = this.body !== null;
    out.calibrated = this.baseline !== null;
    out.mode = this.baseline?.mode ?? null;
    out.lane = this.full.lane;
    out.poseFps = poseFps;
    out.confidence = this.body?.confidence ?? 0;
    const jog = this.jog.status(this.now);
    out.jog.active = jog.active;
    out.jog.cadenceSpm = jog.cadenceSpm;
    out.jog.msSinceStep = jog.msSinceStep;
    out.jog.steps = jog.steps;
    out.startProgress = this.gestures.startProgress;
    const cal = this.calibrator.state;
    out.calibration.progress = cal.progress;
    out.calibration.bodyVisible = cal.bodyVisible;
    out.calibration.distance = cal.distance;
    out.pose = this.pose;
    out.lastFrameT = this.lastT;
    out.squatting = base ? (base.mode === 'full' ? this.full : this.small).isDown : false;
    out.slowPose =
      this.firstT !== null &&
      this.lastT !== null &&
      this.lastT - this.firstT >= SLOW_POSE_AFTER_MS &&
      poseFps > 0 &&
      poseFps < SLOW_POSE_FPS;
    return out;
  }

  update(frame: PoseFrame): PoseEvent[] {
    const { t } = frame;
    const prevT = this.lastT;
    const events: PoseEvent[] = [];
    // A gap since the previous update() call — of any kind, not just empty frames — longer than
    // lostMs: treat it like lost-then-found even though no empty frames arrived to flag it. Without
    // this, a pose that resumes directly (no empty frames in between) skips the found-reset below.
    if (prevT !== null && !this.lost && t - prevT >= this.th.lostMs) {
      this.lost = true;
      events.push({ type: 'lost' });
    }
    if (prevT !== null && t > prevT) {
      const inst = 1000 / (t - prevT);
      this.fps = this.fps ? this.fps * 0.9 + inst * 0.1 : inst;
    }
    this.lastT = t;
    this.firstT ??= t;
    this.now = t;
    this.lastSeenT ??= t;

    let raw = this.pickPose(frame);
    // A pose the model barely believes in is treated as no pose: it must not drive moves.
    if (raw && toBody(raw, frame.aspect).confidence < VISIBLE) raw = null;
    if (!raw) {
      this.pose = null;
      this.body = null;
      clearMagnitudes(this.mag);
      // A brief dropout (a blink of the model) should not throw away calibration progress.
      if (!this.baseline && t - this.lastSeenT > CALIB_GAP_MS) this.calibrator.update(null, t, this.forcedMode);
      if (!this.lost && t - this.lastSeenT >= this.th.lostMs) {
        this.lost = true;
        events.push({ type: 'lost' });
      }
      return events;
    }

    const found = this.lost;
    if (found) {
      this.lost = false;
      this.smoother.reset();
      // Keep the baseline, lane and step history; drop state that went stale during the gap.
      this.jog.bob.reset();
      this.full.resetTransient();
      this.small.resetTransient();
      events.push({ type: 'found' });
    }
    // Same rule when the stream stalled without sending empty frames.
    if (!this.baseline && t - this.lastSeenT > CALIB_GAP_MS) this.calibrator.reset();
    this.lastSeenT = t;

    const pose = this.smoother.smooth(raw, t);
    const body = toBody(pose, frame.aspect);
    this.pose = pose;
    this.body = body;
    events.push(...this.gestures.update(body, t));

    if (!this.baseline) {
      this.baseline = this.calibrator.update(body, t, this.forcedMode);
      return events;
    }

    const base = this.baseline;
    // Small-room lanes are relative, so a player who comes back somewhere else keeps playing from
    // there. Full-body mode keeps x: standing position is the lane.
    if (found && base.mode === 'small') rebaseBaselineX(base, body);
    const sens = this.sensitivity;
    this.jog.update(body, base, t, sens);
    const jogging = this.jog.status(t).active;
    const moves = base.mode === 'full' ? this.full : this.small;
    events.push(...moves.update({ body, base, t, sens, bobAmp: this.jog.bob.amplitudeAt(t), jogging }));

    const settled =
      base.mode === 'full'
        ? Math.abs(body.hip.y - base.hip.y) < this.th.driftSettle * base.torso
        : Math.abs(body.shoulder.y - base.shoulder.y) < this.th.driftSettle * base.shoulderWidth;
    if (prevT === null) return events;
    const dt = t - prevT;
    // Small-room x follows the player even while jogging, but never during a held lean.
    if (base.mode === 'small' && this.small.leanReady) driftBaselineX(base, body, dt);
    if (!jogging && moves.idle && settled) driftBaseline(base, body, dt);
    return events;
  }

  /** With several people in view, follow the one nearest the calibrated spot (or the largest before calibration). */
  private pickPose(frame: PoseFrame): Pose | null {
    if (frame.poses.length <= 1) return frame.poses[0] ?? null;
    const base = this.baseline;
    const score = (p: Pose) => {
      const b = toBody(p, frame.aspect);
      return base ? -dist(b.hip, base.hip) : b.torso;
    };
    return frame.poses.reduce((best, p) => (score(p) > score(best) ? p : best));
  }
}
