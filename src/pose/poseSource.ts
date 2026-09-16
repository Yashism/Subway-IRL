import type { PoseFrame } from './types';

export interface PoseSource {
  /** Which backend is running, e.g. "worker-gpu-full" or "replay". */
  readonly backend: string;
  start(onFrame: (frame: PoseFrame) => void): Promise<void>;
  stop(): void;
}
