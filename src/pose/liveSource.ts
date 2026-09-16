import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, type ModelVariant } from './landmarker';
import { mirrorPoses } from './mirror';
import type { WorkerIn, WorkerOut } from './pose.worker';
import type { PoseSource } from './poseSource';
import type { PoseFrame } from './types';

const SLOW_FPS = 15;
const SLOW_FOR_MS = 5000;
/** Consecutive per-frame worker errors that count as a dead worker. */
const MAX_WORKER_ERRORS = 5;

/** Prefix of the error `start()` throws when no pose backend could load. */
export const MODEL_LOAD_FAILED = 'Pose model failed to load:';

/**
 * Runs pose detection on a playing <video>. Backend fallback chain:
 * worker + GPU → main thread + GPU → main thread + CPU (lite).
 * Switches to the lite model if detection stays below 15 fps for 5 s.
 *
 * An instance is single-use: after `stop()` (or a failed `start()`), create a new one to restart.
 */
export class LivePoseSource implements PoseSource {
  backend = 'none';
  private worker: Worker | null = null;
  private landmarker: PoseLandmarker | null = null;
  private onFrame: ((f: PoseFrame) => void) | null = null;
  private running = false;
  private busy = false;
  private lastSent = 0;
  private handle = 0;
  private results: number[] = [];
  private startedAt = 0;
  private slowSince: number | null = null;
  private fallingBack = false;
  private switching = false;
  private workerErrors = 0;
  /** Rejects the worker init that is currently pending, if any. */
  private cancelInit: ((message: string) => void) | null = null;

  constructor(
    private video: HTMLVideoElement,
    private maxFps = 30,
  ) {}

  get fps(): number {
    return this.results.length / 2;
  }

  /**
   * Loads a backend and starts detecting. Resolves without starting if `stop()` ran meanwhile.
   * Rejects with an Error whose message starts with MODEL_LOAD_FAILED when every backend fails.
   */
  async start(onFrame: (f: PoseFrame) => void): Promise<void> {
    this.onFrame = onFrame;
    this.running = true;
    try {
      await this.initBackend();
    } catch (err) {
      if (this.abortIfStopped()) return;
      this.running = false;
      this.backend = 'failed';
      throw new Error(`${MODEL_LOAD_FAILED} ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!this.running) return;
    this.startedAt = performance.now();
    const tick = () => {
      if (!this.running) return;
      // Schedule first so an exception in grab() can never end the loop.
      this.handle = this.video.requestVideoFrameCallback(tick);
      this.grab();
    };
    this.handle = this.video.requestVideoFrameCallback(tick);
  }

  stop(): void {
    this.running = false;
    this.video.cancelVideoFrameCallback(this.handle);
    this.cancelInit?.('Pose source stopped');
    this.worker?.terminate();
    this.worker = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.busy = false;
    this.results = [];
    this.slowSince = null;
    this.lastSent = 0;
  }

  private async initBackend(): Promise<void> {
    try {
      await this.initWorker('full');
      if (this.abortIfStopped()) return;
      this.backend = 'worker-gpu-full';
      return;
    } catch (err) {
      if (this.abortIfStopped()) return;
      console.warn('Pose worker unavailable, using the main thread:', err);
    }
    try {
      this.landmarker = await createLandmarker({ variant: 'full', delegate: 'GPU' });
      if (this.abortIfStopped()) return;
      this.backend = 'main-gpu-full';
      return;
    } catch (err) {
      if (this.abortIfStopped()) return;
      console.warn('GPU pose model unavailable, using CPU lite:', err);
    }
    // Last resort: let a failure propagate to start().
    this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'CPU' });
    if (this.abortIfStopped()) return;
    this.backend = 'main-cpu-lite';
  }

  private initWorker(variant: ModelVariant): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = this.worker ?? new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      const fail = (message: string) => {
        clearTimeout(timer);
        this.cancelInit = null;
        w.terminate();
        if (this.worker === w) this.worker = null;
        reject(new Error(message));
      };
      this.cancelInit = fail;
      const timer = setTimeout(() => fail('Pose worker init timed out'), 20000);
      w.onerror = (e) => fail(e.message || 'Pose worker crashed');
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
          this.cancelInit = null;
          this.workerErrors = 0;
          w.onmessage = (ev: MessageEvent<WorkerOut>) => this.onWorkerMessage(ev.data);
          // A crash *after* init must not silently vanish: fail() above only rejects
          // this init call's already-settled promise, so route later crashes through
          // the same recovery path used for a fatal worker message.
          w.onerror = (ev) => void this.fallBackToMainThread(ev.message || 'Pose worker crashed');
          resolve();
        } else if (e.data.type === 'error') {
          fail(e.data.message);
        }
      };
      w.postMessage({ type: 'init', variant } satisfies WorkerIn);
    });
  }

  private grab(): void {
    const now = performance.now();
    if (this.busy || now - this.lastSent < 1000 / this.maxFps - 2 || this.video.readyState < 2) return;
    this.lastSent = now;

    if (this.worker) {
      this.busy = true;
      const worker = this.worker;
      createImageBitmap(this.video).then(
        (bitmap) => {
          try {
            worker.postMessage({ type: 'frame', bitmap, t: now } satisfies WorkerIn, [bitmap]);
          } catch (err) {
            bitmap.close();
            this.busy = false;
            console.warn('Could not send a frame to the pose worker:', err);
          }
        },
        () => (this.busy = false),
      );
    } else if (this.landmarker) {
      let poses;
      try {
        poses = mirrorPoses(this.landmarker.detectForVideo(this.video, now).landmarks);
      } catch (err) {
        void this.dropToCpuLite(err);
        return;
      }
      this.emit({ t: now, aspect: this.video.videoWidth / this.video.videoHeight, poses });
    }
  }

  private onWorkerMessage(m: WorkerOut): void {
    if (m.type === 'result') {
      this.busy = false;
      this.workerErrors = 0;
      this.emit({ t: m.t, aspect: m.aspect, poses: m.poses });
    } else if (m.type === 'error') {
      this.busy = false;
      console.warn('Pose worker error:', m.message);
      if (++this.workerErrors >= MAX_WORKER_ERRORS) {
        this.workerErrors = 0;
        void this.fallBackToMainThread(`${MAX_WORKER_ERRORS} pose worker errors in a row: ${m.message}`);
      }
    }
  }

  private emit(frame: PoseFrame): void {
    const now = performance.now();
    this.results.push(now);
    while (now - this.results[0] > 2000) this.results.shift();
    this.checkSpeed(now);
    try {
      this.onFrame?.(frame);
    } catch (err) {
      // A consumer bug must not take pose detection down with it.
      console.error('Pose frame consumer threw:', err);
    }
  }

  private checkSpeed(now: number): void {
    const slow = this.backend.endsWith('-full') && now - this.startedAt > 3000 && this.fps < SLOW_FPS;
    if (!slow) {
      this.slowSince = null;
      return;
    }
    this.slowSince ??= now;
    if (now - this.slowSince > SLOW_FOR_MS) void this.switchToLite();
  }

  private async switchToLite(): Promise<void> {
    if (this.switching || this.fallingBack || this.abortIfStopped()) return;
    this.switching = true;
    console.warn(`Pose detection below ${SLOW_FPS} fps; switching to the lite model`);
    this.slowSince = null;
    this.busy = true;
    try {
      if (this.worker) {
        try {
          await this.initWorker('lite');
          if (this.abortIfStopped()) return;
          this.backend = 'worker-gpu-lite';
        } catch (err) {
          if (this.abortIfStopped()) return;
          // The worker is unusable; drop to the main thread (CPU lite is acceptable here).
          await this.fallBackToMainThread(err);
        }
      } else {
        try {
          this.closeLandmarker();
          this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'GPU' });
          if (this.abortIfStopped()) return;
          this.backend = 'main-gpu-lite';
        } catch (err) {
          if (this.abortIfStopped()) return;
          console.warn('GPU lite pose model unavailable, falling back to CPU lite:', err);
          await this.loadCpuLite();
        }
      }
    } finally {
      this.busy = false;
      this.switching = false;
    }
  }

  /**
   * Recovers from a fatal worker failure (a crash, repeated frame errors, or a failed re-init)
   * by dropping to the main thread: GPU full, then CPU lite. Guarded against re-entry; leaves
   * `backend` at 'failed' (and logs an error) if even CPU lite cannot start, so the failure is
   * visible instead of silently stalling.
   */
  private async fallBackToMainThread(reason: unknown): Promise<void> {
    if (this.fallingBack || this.abortIfStopped()) return;
    this.fallingBack = true;
    this.busy = true;
    console.warn('Pose worker failed, falling back to the main thread:', reason);
    this.worker?.terminate();
    this.worker = null;
    try {
      this.closeLandmarker();
      this.landmarker = await createLandmarker({ variant: 'full', delegate: 'GPU' });
      if (this.abortIfStopped()) return;
      this.backend = 'main-gpu-full';
    } catch (err) {
      if (this.abortIfStopped()) return;
      console.warn('GPU pose model unavailable, using CPU lite:', err);
      await this.loadCpuLite();
    } finally {
      this.busy = false;
      this.fallingBack = false;
    }
  }

  /**
   * Recovers from a main-thread detection error: any GPU model drops to CPU lite; if CPU lite
   * itself failed (or cannot load), the source is marked 'failed'. Shares the re-entry guards.
   */
  private async dropToCpuLite(reason: unknown): Promise<void> {
    if (this.switching || this.fallingBack || this.abortIfStopped()) return;
    this.fallingBack = true;
    this.busy = true;
    try {
      this.closeLandmarker();
      if (this.backend === 'main-cpu-lite') {
        this.markFailed(reason);
        return;
      }
      console.warn('Main-thread pose detection failed, using CPU lite:', reason);
      await this.loadCpuLite();
    } finally {
      this.busy = false;
      this.fallingBack = false;
    }
  }

  /** Loads CPU lite on the main thread; marks the source 'failed' if that fails too. Callers hold the busy guard. */
  private async loadCpuLite(): Promise<void> {
    try {
      this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'CPU' });
      if (this.abortIfStopped()) return;
      this.backend = 'main-cpu-lite';
    } catch (err) {
      if (this.abortIfStopped()) return;
      this.markFailed(err);
    }
  }

  /** No backend is left: surface the failure instead of relabelling a backend that no longer exists. */
  private markFailed(err: unknown): void {
    this.closeLandmarker();
    this.backend = 'failed';
    console.error('Pose detection failed on every backend:', err);
  }

  /** Closes the main-thread landmarker and clears the field, so nothing can call a closed instance. */
  private closeLandmarker(): void {
    const lm = this.landmarker;
    this.landmarker = null;
    try {
      lm?.close();
    } catch (err) {
      console.warn('Could not close the pose model:', err);
    }
  }

  /**
   * If stop() ran while a backend init was awaiting, undo whatever that await just produced
   * (a worker or landmarker nothing will otherwise close) instead of letting it overwrite the
   * null `stop()` left behind. Returns true when the caller should bail.
   */
  private abortIfStopped(): boolean {
    if (this.running) return false;
    this.worker?.terminate();
    this.worker = null;
    this.closeLandmarker();
    return true;
  }
}
