import { Calibrator, driftBaseline, type Baseline } from './calibration';
import { GestureDetector } from './gestures';
import { JogDetector } from './jog';
import { dist, toBody, type Body } from './landmarks';
import { FullBodyMoves, SmallRoomMoves } from './moves';
import { PoseSmoother } from './oneEuro';
import { DEFAULT_THRESHOLDS, type Thresholds } from './thresholds';
import type { PlayMode, Pose, PoseEvent, PoseFrame, PoseStatus } from './types';

export interface PoseControllerOptions {
  thresholds?: Thresholds;
  sensitivity?: number;
  forcedMode?: PlayMode | null;
}

/** Turns a stream of pose frames into game-agnostic move events and a status snapshot. */
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

  recalibrate(): void {
    this.baseline = null;
    this.calibrator.reset();
    this.jog.reset();
    this.full.reset();
    this.small.reset();
  }

  get status(): PoseStatus {
    return {
      tracking: this.body !== null,
      calibrated: this.baseline !== null,
      mode: this.baseline?.mode ?? null,
      lane: this.full.lane,
      poseFps: Math.round(this.fps),
      confidence: this.body?.confidence ?? 0,
      jog: this.jog.status(this.now),
      startProgress: this.gestures.startProgress,
      calibration: { ...this.calibrator.state },
      pose: this.pose,
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
    this.now = t;
    this.lastSeenT ??= t;

    const raw = this.pickPose(frame);
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
    if (prevT !== null && !jogging && moves.idle && settled) driftBaseline(base, body, t - prevT);
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
