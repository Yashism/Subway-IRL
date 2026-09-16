import type { PoseFrame } from './types';

/** Recorded landmark stream, used for replay and detector regression tests. */
export interface PoseFixture {
  version: 1;
  name: string;
  note?: string;
  aspect: number;
  /** Each pose is a list of [x, y, z, visibility]; t is ms since the first frame. */
  frames: { t: number; poses: number[][][] }[];
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function encodeFrames(name: string, frames: PoseFrame[], note?: string): PoseFixture {
  const t0 = frames[0]?.t ?? 0;
  return {
    version: 1,
    name,
    note,
    aspect: frames[0]?.aspect ?? 4 / 3,
    frames: frames.map((f) => ({
      t: Math.round(f.t - t0),
      poses: f.poses.map((p) => p.map((l) => [r4(l.x), r4(l.y), r4(l.z), r4(l.visibility)])),
    })),
  };
}

export function decodeFixture(fx: PoseFixture): PoseFrame[] {
  if (fx.version !== 1) throw new Error(`Unsupported fixture version ${String(fx.version)}`);
  return fx.frames.map((f) => ({
    t: f.t,
    aspect: fx.aspect,
    poses: f.poses.map((p) => p.map(([x, y, z, visibility]) => ({ x, y, z, visibility }))),
  }));
}

export class FixtureRecorder {
  recording = false;
  private frames: PoseFrame[] = [];

  get count(): number {
    return this.frames.length;
  }

  start(): void {
    this.frames = [];
    this.recording = true;
  }

  push(frame: PoseFrame): void {
    if (this.recording) this.frames.push(frame);
  }

  stop(name: string, note?: string): PoseFixture {
    this.recording = false;
    return encodeFrames(name, this.frames, note);
  }
}
