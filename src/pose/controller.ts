import { Calibrator, driftBaseline, type Baseline } from './calibration';
import { GestureDetector } from './gestures';
import { JogDetector } from './jog';
import { dist, toBody, VISIBLE, type Body } from './landmarks';
import { FullBodyMoves, SmallRoomMoves } from './moves';
import { PoseSmoother } from './oneEuro';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import type { PlayMode, Pose, PoseEvent, PoseFrame, PoseStatus } from './types';

export interface PoseControllerOptions {
  thresholds?: Thresholds;
  sensitivity?: number;
  forcedMode?: PlayMode | null;
}

const SLOW_POSE_FPS = 15;
const SLOW_POSE_AFTER_MS = 2000;

/**
 * Turns a stream of pose frames into game-agnostic move events and a status snapshot.
 *
 * `status.jog.msSinceStep` keeps counting through a lost/found gap. Losing tracking must never
 * count as idle (spec §5.5), so the game should run its own idle clock that restarts on resume
 * rather than using msSinceStep directly across a pause.
 */
export class PoseController {
  readonly th: Thresholds;
  sensitivity: number;
  forcedMode: PlayMode | null;
  baseline: Baseline | null = null;
  body: Body | null = null;

  private calibrator: Calibrator;
  private jog: JogDetector;
  private gestures: GestureDetector;
  private full: FullBodyMoves;
  private small: SmallRoomMoves;
  private smoother = new PoseSmoother();
  private pose: Pose | null = null;
  private lastSeenT: number | null = null;
  private lost = false;
  private lastT: number | null = null;
  private firstT: number | null = null;
  private fps = 0;
  private now = 0;

  constructor(opts: PoseControllerOptions = {}) {
    this.th = opts.thresholds ?? { ...DEFAULT_THRESHOLDS };
    this.sensitivity = opts.sensitivity ?? 1;
    this.forcedMode = opts.forcedMode ?? null;
    this.calibrator = new Calibrator(this.th);
    this.jog = new JogDetector(this.th);
    this.gestures = new GestureDetector(this.th);
    this.full = new FullBodyMoves(this.th);
    this.small = new SmallRoomMoves(this.th);
  }

  /** Forgets the baseline and move state. Returns a `lane: 0` event if the player was in a side lane. */
  recalibrate(): PoseEvent[] {
    const events: PoseEvent[] = this.full.lane !== 0 ? [{ type: 'lane', lane: 0 }] : [];
    this.baseline = null;
    this.calibrator.reset();
    this.jog.reset();
    this.full.reset();
    this.small.reset();
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

  update(frame: PoseFrame): PoseEvent[] {
    const { t } = frame;
    const prevT = this.lastT;
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
      if (!this.baseline) this.calibrator.update(null, t, this.forcedMode);
      if (!this.lost && t - this.lastSeenT >= this.th.lostMs) {
        this.lost = true;
        return [{ type: 'lost' }];
      }
      return [];
    }

    const events: PoseEvent[] = [];
    if (this.lost) {
      this.lost = false;
      this.smoother.reset();
      events.push({ type: 'found' });
    }
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
    const sens = this.sensitivity;
    this.jog.update(body, base, t, sens);
    const jogging = this.jog.status(t).active;
    const moves = base.mode === 'full' ? this.full : this.small;
    events.push(...moves.update({ body, base, t, sens, bobAmp: this.jog.bob.amplitudeAt(t), jogging }));

    const settled =
      base.mode === 'full'
        ? Math.abs(body.hip.y - base.hip.y) < this.th.driftSettle * base.torso
        : Math.abs(body.shoulder.y - base.shoulder.y) < this.th.driftSettle * base.shoulderWidth;
    if (prevT !== null && !jogging && moves.idle && settled) driftBaseline(base, body, t - prevT, undefined, base.mode === 'small');
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
