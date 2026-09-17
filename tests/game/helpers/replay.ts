import { findHit, surfaceAt, type Hit } from '../../../src/game/collision';
import { TUNING } from '../../../src/game/config';
import { lengthOf, movingFrontAt, OBSTACLES, type Obstacle, type ObstacleSpec } from '../../../src/game/obstacles';
import { Runner } from '../../../src/game/runner';
import type { PlanAction } from '../../../src/game/solver';
import type { Lane } from '../../../src/pose/types';

/** Runs the real runner physics along a plan at constant speed; returns the first collision or null. */
export function replayPlan(specs: readonly ObstacleSpec[], actions: readonly PlanAction[], startLane: Lane, speed: number, length: number): Hit | null {
  const dt = 1 / TUNING.stepHz;
  const obstacles: Obstacle[] = specs.map((o, id) => ({
    id,
    kind: o.kind,
    lane: o.lane,
    length: lengthOf(o),
    front: OBSTACLES[o.kind].moving ? movingFrontAt(o.s, 0, speed) : o.s,
  }));
  const r = new Runner();
  r.lane = startLane;
  r.prevLane = startLane;
  r.x = startLane * 2.5;
  const queue = [...actions];
  const steps = Math.ceil(length / (speed * dt));
  for (let i = 0; i <= steps; i++) {
    const s = i * speed * dt;
    while (queue.length && queue[0].s <= s + 1e-6) {
      const a = queue.shift()!;
      if (a.type === 'jump') r.jump();
      else if (a.type === 'roll') r.roll();
      else r.setLane(a.lane);
    }
    const next = s + speed * dt;
    for (const o of obstacles) if (OBSTACLES[o.kind].moving) o.front -= TUNING.oncomingTrainSpeed * dt;
    const box = { s: next, x: r.x, y: r.y, height: r.height };
    r.update(dt, surfaceAt(box, obstacles));
    const hit = findHit({ s: next, x: r.x, y: r.y, height: r.height }, r.lane, r.changingLane, obstacles);
    if (hit) return hit;
  }
  return null;
}
