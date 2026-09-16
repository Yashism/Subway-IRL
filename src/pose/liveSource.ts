import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, type ModelVariant } from './landmarker';
import { mirrorPoses } from './mirror';
import type { WorkerIn, WorkerOut } from './pose.worker';
import type { PoseSource } from './poseSource';
import type { PoseFrame } from './types';

const SLOW_FPS = 15;
const SLOW_FOR_MS = 5000;

/**
 * Runs pose detection on a playing <video>. Backend fallback chain:
 * worker + GPU → main thread + GPU → main thread + CPU (lite).
 * Switches to the lite model if detection stays below 15 fps for 5 s.
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

  constructor(
    private video: HTMLVideoElement,
    private maxFps = 30,
  ) {}

  get fps(): number {
    return this.results.length / 2;
  }

  async start(onFrame: (f: PoseFrame) => void): Promise<void> {
    this.onFrame = onFrame;
    this.running = true;
    await this.initBackend();
    this.startedAt = performance.now();
    const tick = () => {
      if (!this.running) return;
      this.grab();
      this.handle = this.video.requestVideoFrameCallback(tick);
    };
    this.handle = this.video.requestVideoFrameCallback(tick);
  }

  stop(): void {
    this.running = false;
    this.video.cancelVideoFrameCallback(this.handle);
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
      this.backend = 'worker-gpu-full';
      return;
    } catch (err) {
      console.warn('Pose worker unavailable, using the main thread:', err);
    }
    try {
      this.landmarker = await createLandmarker({ variant: 'full', delegate: 'GPU' });
      this.backend = 'main-gpu-full';
      return;
    } catch (err) {
      console.warn('GPU pose model unavailable, using CPU lite:', err);
    }
    this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'CPU' });
    this.backend = 'main-cpu-lite';
  }

  private initWorker(variant: ModelVariant): Promise<void> {
    return new Promise((resolve, reject) => {
      const w = this.worker ?? new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
      this.worker = w;
      const fail = (message: string) => {
        clearTimeout(timer);
        w.terminate();
        this.worker = null;
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail('Pose worker init timed out'), 20000);
      w.onerror = (e) => fail(e.message || 'Pose worker crashed');
      w.onmessage = (e: MessageEvent<WorkerOut>) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer);
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
      const r = this.landmarker.detectForVideo(this.video, now);
      this.emit({ t: now, aspect: this.video.videoWidth / this.video.videoHeight, poses: mirrorPoses(r.landmarks) });
    }
  }

  private onWorkerMessage(m: WorkerOut): void {
    if (m.type === 'result') {
      this.busy = false;
      this.emit({ t: m.t, aspect: m.aspect, poses: m.poses });
    } else if (m.type === 'error') {
      this.busy = false;
      console.warn('Pose worker error:', m.message);
    }
  }

  private emit(frame: PoseFrame): void {
    const now = performance.now();
    this.results.push(now);
    while (now - this.results[0] > 2000) this.results.shift();
    this.checkSpeed(now);
    this.onFrame?.(frame);
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
    if (this.fallingBack) return;
    console.warn(`Pose detection below ${SLOW_FPS} fps; switching to the lite model`);
    this.slowSince = null;
    this.busy = true;
    try {
      if (this.worker) {
        try {
          await this.initWorker('lite');
          this.backend = 'worker-gpu-lite';
        } catch (err) {
          // The worker is unusable; drop to the main thread (CPU lite is acceptable here).
          await this.fallBackToMainThread(err);
        }
      } else {
        try {
          this.landmarker?.close();
          this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'GPU' });
          this.backend = 'main-gpu-lite';
        } catch (err) {
          console.warn('GPU lite pose model unavailable, falling back to CPU lite:', err);
          try {
            this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'CPU' });
            this.backend = 'main-cpu-lite';
          } catch (err2) {
            // Both lite attempts failed: don't leave `landmarker` pointing at the closed
            // instance above (grab() would call detectForVideo on it and throw). Surface
            // the failure instead of relabelling a backend that no longer exists.
            this.landmarker = null;
            this.backend = 'failed';
            console.error('Pose detection failed on every backend:', err2);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Recovers from a fatal worker failure (a crash, or a failed re-init) by dropping to the
   * main thread: GPU full, then CPU lite. Guarded against re-entry; leaves `backend` at
   * 'failed' (and logs an error) if even CPU lite cannot start, so the failure is visible
   * instead of silently stalling.
   */
  private async fallBackToMainThread(reason: unknown): Promise<void> {
    if (this.fallingBack) return;
    this.fallingBack = true;
    this.busy = true;
    console.warn('Pose worker failed, falling back to the main thread:', reason);
    this.worker?.terminate();
    this.worker = null;
    try {
      this.landmarker?.close();
      this.landmarker = await createLandmarker({ variant: 'full', delegate: 'GPU' });
      this.backend = 'main-gpu-full';
    } catch (err) {
      console.warn('GPU pose model unavailable, using CPU lite:', err);
      try {
        this.landmarker = await createLandmarker({ variant: 'lite', delegate: 'CPU' });
        this.backend = 'main-cpu-lite';
      } catch (err2) {
        this.landmarker = null;
        this.backend = 'failed';
        console.error('Pose detection failed on every backend:', err2);
      }
    } finally {
      this.busy = false;
      this.fallingBack = false;
    }
  }
}
