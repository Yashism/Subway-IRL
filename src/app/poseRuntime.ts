import { emptyPoseStatus, PoseCommandSource } from '../input/poseSource';
import {
  describeCameraError,
  listCameras,
  openCamera,
  pickDefaultCamera,
  type CameraInfo,
} from '../pose/camera';
import { PoseController, type PoseControllerOptions } from '../pose/controller';
import { decodeFixture, type PoseFixture } from '../pose/fixtures';
import { LivePoseSource, MODEL_LOAD_FAILED } from '../pose/liveSource';
import type { PoseSource } from '../pose/poseSource';
import { ReplayPoseSource } from '../pose/replaySource';
import type { PoseEvent, PoseFrame, PoseStatus } from '../pose/types';
import { decodeSession, sessionToFixture, type SessionRecording } from '../telemetry/messages';
import { isDark } from '../ui/pip';
import type { PoseSnapshot } from './flow';

/** localStorage key for the chosen camera (shared with the debug page). */
export const CAMERA_KEY = 'subway-irl.cameraId';

export interface CameraApi {
  open(deviceId?: string): Promise<MediaStream>;
  list(): Promise<CameraInfo[]>;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** PoseStatus plus the frame-luma verdict the session flow reads. */
export type RuntimeStatus = PoseStatus & PoseSnapshot;

export interface PoseRuntimeOptions {
  controller?: PoseControllerOptions;
  /** When set, start() plays this source instead of opening a camera (`?posereplay`, `?session`). */
  replay?: (() => Promise<PoseSource>) | null;
  /** Name of the replayed fixture or session, for labels. */
  replayName?: string;
  camera?: CameraApi;
  storage?: KeyValueStore;
  /** Default: a LivePoseSource on the video. */
  createSource?: (video: HTMLVideoElement) => PoseSource;
  /** Default: a hidden, muted <video> parked in the document. */
  createVideo?: () => HTMLVideoElement;
}

const browserCamera: CameraApi = { open: (id) => openCamera(id), list: () => listCameras() };

const browserStorage: KeyValueStore = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
};

const stopStream = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

/** Off-screen spot where the camera video lives while the PiP is not showing it (it keeps decoding). */
let parking: HTMLElement | null = null;
function parkingSpot(): HTMLElement {
  if (!parking) {
    parking = document.createElement('div');
    parking.className = 'pose-video-parking';
    parking.setAttribute('aria-hidden', 'true');
    // Rendered (not display:none) so the browser keeps delivering video frames.
    parking.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
    document.body.append(parking);
  }
  return parking;
}

function hiddenVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.autoplay = false;
  parkingSpot().append(v);
  return v;
}

/**
 * Owns the webcam and the pose pipeline for the game page: camera choice (remembered), the
 * hidden <video>, a LivePoseSource (or a replay), the PoseController and the PoseCommandSource.
 * Every pose frame goes through `commands.push()`; `onFrame` sees it afterwards (telemetry).
 */
export class PoseRuntime {
  readonly ctrl: PoseController;
  readonly commands: PoseCommandSource;
  readonly isReplay: boolean;
  readonly replayName: string;
  /** The camera video; null for replays. */
  readonly video: HTMLVideoElement | null;
  /** Called after every frame has been processed, with the pose events it produced. */
  onFrame: ((f: PoseFrame, events: readonly PoseEvent[]) => void) | null = null;
  /** The open camera stopped on its own (unplugged, or taken by another app). */
  onCameraEnded: (() => void) | null = null;
  /** Mean frame luma 0..255 (PosePip.sampleLuma), or null when unknown. */
  sampleLuma: ((nowMs: number) => number | null) | null = null;
  activeCameraId: string | null = null;
  /** Camera image width / height of the latest frame. */
  aspect = 4 / 3;
  /** Cameras seen at the last start (labels are filled once permission is granted). */
  cameras: CameraInfo[] = [];

  private readonly camera: CameraApi;
  private readonly storage: KeyValueStore;
  private readonly replay: (() => Promise<PoseSource>) | null;
  private readonly createSource: (video: HTMLVideoElement) => PoseSource;
  private source: PoseSource | null = null;
  private stream: MediaStream | null = null;
  private gen = 0;
  private live = false;
  private readonly ownVideo: boolean;
  private readonly st: RuntimeStatus = { ...emptyPoseStatus(), dark: false };

  constructor(opts: PoseRuntimeOptions = {}) {
    this.ctrl = new PoseController(opts.controller);
    // Same threshold as the controller's own lost event (ruling): a stalled stream pauses after 1 s.
    this.commands = new PoseCommandSource(this.ctrl, { staleMs: this.ctrl.th.lostMs });
    this.replay = opts.replay ?? null;
    this.isReplay = this.replay !== null;
    this.replayName = opts.replayName ?? '';
    this.camera = opts.camera ?? browserCamera;
    this.storage = opts.storage ?? browserStorage;
    this.createSource = opts.createSource ?? ((v) => new LivePoseSource(v));
    this.ownVideo = !opts.createVideo;
    this.video = this.isReplay ? null : (opts.createVideo ?? hiddenVideo)();
  }

  /** A pose source is running. */
  get running(): boolean {
    return this.live;
  }

  /** Pose backend, e.g. "worker-gpu-full", "replay", or "none" when stopped. */
  get backend(): string {
    return this.live && this.source ? this.source.backend : 'none';
  }

  /** Pose frames per second (smoothed). */
  get fps(): number {
    return this.status().poseFps;
  }

  /** The current pose status. The same object every call: read it at once, never keep it. */
  status(): RuntimeStatus {
    return this.ctrl.statusInto(this.st) as RuntimeStatus;
  }

  /** The camera image is too dark to track well. Always false for replays. */
  dark(nowMs: number): boolean {
    if (this.isReplay || !this.sampleLuma) return false;
    return isDark(this.sampleLuma(nowMs));
  }

  savedCameraId(): string | null {
    try {
      return this.storage.get(CAMERA_KEY);
    } catch {
      return null;
    }
  }

  saveCameraId(id: string): void {
    try {
      this.storage.set(CAMERA_KEY, id);
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  }

  /**
   * Opens the camera (the given one, else the saved one, never an IR camera by default) and
   * starts pose detection; for a replay, starts the replay. Resolves true once frames can flow,
   * false if a newer start() or stop() superseded this call. Rejects on failure: show
   * `describeError(err)`.
   */
  async start(cameraId: string | null = null): Promise<boolean> {
    this.stop();
    const gen = this.gen;
    const superseded = () => gen !== this.gen;
    const onFrame = (f: PoseFrame) => {
      if (superseded()) return;
      this.aspect = f.aspect;
      const events = this.commands.push(f);
      this.onFrame?.(f, events);
    };

    if (this.replay) {
      const src = await this.replay();
      if (superseded()) return false;
      this.source = src;
      this.live = true;
      await src.start(onFrame);
      return !superseded();
    }

    const video = this.video!;
    let stream: MediaStream | null = null;
    let src: PoseSource | null = null;
    const release = () => {
      src?.stop();
      stopStream(stream);
      if (this.stream === stream) this.stream = null;
      if (this.source === src) this.source = null;
    };
    try {
      const wanted = cameraId ?? this.savedCameraId();
      stream = await this.camera.open(wanted ?? undefined).catch((err: unknown) => {
        if (!wanted) throw err;
        return this.camera.open();
      });
      if (superseded()) return (release(), false);
      const cams = await this.camera.list();
      if (superseded()) return (release(), false);
      this.cameras = cams;
      const pick = pickDefaultCamera(cams, wanted);
      if (pick && pick.deviceId !== deviceOf(stream)) {
        stopStream(stream);
        stream = null;
        stream = await this.camera.open(pick.deviceId);
        if (superseded()) return (release(), false);
      }
      this.activeCameraId = deviceOf(stream) ?? pick?.deviceId ?? null;
      if (this.activeCameraId) this.saveCameraId(this.activeCameraId);
      this.stream = stream;
      stream.getVideoTracks()[0]?.addEventListener?.('ended', () => {
        if (!superseded()) this.onCameraEnded?.();
      });
      video.srcObject = stream;
      await video.play();
      if (superseded()) return (release(), false);
      src = this.createSource(video);
      this.source = src;
      await src.start(onFrame);
      if (superseded()) return (release(), false);
      this.live = true;
      return true;
    } catch (err) {
      release();
      // A newer start() (or stop()) tore this one down — `video.play()` rejects with AbortError when
      // its srcObject is cleared. That is not a camera failure: report it like any other supersede,
      // or the newer, working camera ends up behind the "Camera trouble" screen.
      if (superseded()) return false;
      video.srcObject = null;
      throw err;
    }
  }

  /** Moves the video back to its off-screen spot (after the PiP let go of it), so it keeps playing. */
  parkVideo(): void {
    if (this.video && typeof document !== 'undefined' && this.ownVideo) parkingSpot().append(this.video);
  }

  /** Stops detection and the camera. Frames that arrive later are ignored. */
  stop(): void {
    this.gen++;
    this.live = false;
    this.source?.stop();
    this.source = null;
    stopStream(this.stream);
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  /** Switches to another camera (or restarts the replay). */
  restart(cameraId: string | null): Promise<boolean> {
    return this.start(cameraId);
  }

  /** Forgets the calibration; the command source keeps steps monotonic and re-centres the lane. */
  recalibrate(): void {
    this.commands.recalibrate();
  }

  /** Text for the camera error screen. */
  describeError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(MODEL_LOAD_FAILED) || this.isReplay) return message;
    return describeCameraError(err);
  }
}

function deviceOf(stream: MediaStream | null): string | null {
  return stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
}

/** `?posereplay=<fixture>`: frames from tests/fixtures/<fixture>.json, looped. */
export function fixtureReplay(name: string, base = '/tests/fixtures/'): () => Promise<PoseSource> {
  let frames: PoseFrame[] | null = null;
  return async () => {
    if (!frames) {
      const url = `${base}${encodeURIComponent(name.replace(/\.json$/i, ''))}.json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Replay fixture not found: ${url}`);
      frames = decodeFixture((await res.json()) as PoseFixture);
    }
    return new ReplayPoseSource(frames, true);
  };
}

/** `?session=<file>`: a recorded monitor session from tests/fixtures/sessions/, played once. */
export async function loadSession(file: string, base = '/tests/fixtures/sessions/'): Promise<SessionRecording> {
  const name = /\.json$/i.test(file) ? file : `${file}.json`;
  const url = `${base}${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Session recording not found: ${url}`);
  return decodeSession(await res.json());
}

export function sessionReplay(rec: SessionRecording): () => Promise<PoseSource> {
  const frames = decodeFixture(sessionToFixture(rec));
  return async () => new ReplayPoseSource(frames, false);
}
