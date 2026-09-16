import { decodeFixture, type PoseFixture } from './fixtures';
import type { PoseSource } from './poseSource';
import type { PoseFrame } from './types';

/** Plays recorded frames in real time, looping by default. Timestamps keep increasing across loops. */
export class ReplayPoseSource implements PoseSource {
  readonly backend = 'replay';
  private raf = 0;
  private running = false;

  constructor(
    private frames: PoseFrame[],
    private loop = true,
  ) {}

  static async load(url: string, loop = true): Promise<ReplayPoseSource> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Replay fixture not found: ${url}`);
    return new ReplayPoseSource(decodeFixture((await res.json()) as PoseFixture), loop);
  }

  async start(onFrame: (f: PoseFrame) => void): Promise<void> {
    const frames = this.frames;
    if (!frames.length) return;
    this.running = true;
    const t0 = performance.now();
    const duration = frames[frames.length - 1].t + 1000 / 30;
    let i = 0;
    let offset = 0;
    const tick = () => {
      if (!this.running) return;
      const elapsed = performance.now() - t0;
      while (i < frames.length && frames[i].t + offset <= elapsed) {
        onFrame({ ...frames[i], t: t0 + frames[i].t + offset });
        i++;
      }
      if (i >= frames.length) {
        if (!this.loop) return;
        i = 0;
        offset += duration;
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
