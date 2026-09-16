import type { Pose } from './types';

interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** Mirror MediaPipe landmarks horizontally so the player's left is screen-left. */
export function mirrorPoses(landmarks: RawLandmark[][]): Pose[] {
  return landmarks.map((p) => p.map((l) => ({ x: 1 - l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })));
}
