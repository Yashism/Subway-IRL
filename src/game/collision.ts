import type { Lane } from '../pose/types';
import { laneX, TUNING } from './config';
import { clearTop, OBSTACLES, type Obstacle } from './obstacles';

export interface RunnerBox {
  s: number;
  x: number;
  y: number;
  height: number;
}

const nearLane = (x: number, lane: Lane, halfWidth: number) => Math.abs(x - laneX(lane)) < halfWidth;

export function overlaps(r: RunnerBox, o: Obstacle): boolean {
  const info = OBSTACLES[o.kind];
  if (info.yMax <= info.yMin) return false;
  const hd = TUNING.runnerHalfDepth;
  if (r.s + hd <= o.front || r.s - hd >= o.front + o.length) return false;
  if (!nearLane(r.x, o.lane, TUNING.obstacleHalfWidth + TUNING.runnerHalfWidth)) return false;
  // A runner a hair below a roof it is stepping onto or off grazes it rather than crashing; one whose
  // feet brush the top edge of a jump obstacle has cleared it.
  const top = info.walkTop === null ? clearTop(info) : info.yMax - TUNING.surfaceSnap;
  return r.y < top && r.y + r.height > info.yMin;
}

/** Height of the highest walkable surface under the runner that it can reach. */
export function surfaceAt(r: RunnerBox, obstacles: readonly Obstacle[]): number {
  const hd = TUNING.runnerHalfDepth;
  let top = 0;
  for (const o of obstacles) {
    const info = OBSTACLES[o.kind];
    // Inclusive, so the support of two neighbouring roofs meets exactly at the lane boundary.
    if (info.walkTop === null || Math.abs(r.x - laneX(o.lane)) > TUNING.roofSupportHalfWidth) continue;
    let h: number;
    if (o.kind === 'ramp') {
      if (r.s < o.front || r.s > o.front + o.length) continue;
      h = info.walkTop * Math.min(1, (r.s - o.front) / (o.length - TUNING.rampLevelEarly));
    } else {
      if (r.s + hd <= o.front || r.s - hd >= o.front + o.length) continue;
      h = info.walkTop;
    }
    if (h <= r.y + TUNING.stepUp && h > top) top = h;
  }
  return top;
}

export type HitKind = 'front' | 'side';

export interface Hit {
  kind: HitKind;
  obstacle: Obstacle;
}

/**
 * Only obstacles in the lane the runner is heading for count. Hitting one while
 * still sliding across is a side clip (stumble); otherwise it is head-on.
 */
export function findHit(r: RunnerBox, lane: Lane, changingLane: boolean, obstacles: readonly Obstacle[]): Hit | null {
  for (const o of obstacles) {
    if (o.lane !== lane || !overlaps(r, o)) continue;
    return { kind: changingLane ? 'side' : 'front', obstacle: o };
  }
  return null;
}
