/**
 * Wander's walker: movement integration, collision against the city's solids, and the follow
 * camera's maths. Pure — no three.js — so it can be tested.
 *
 * Heading 0 faces -z and a positive heading turns to the right (towards +x): forward is
 * (sin h, -cos h). Steering turns the walker; the camera swings round behind.
 */
import type { Box, Disc, Solids } from './city';

export interface WalkerState {
  x: number;
  z: number;
  /** Radians; see the file comment. */
  heading: number;
  /** Velocity in m/s, in the world frame. */
  vx: number;
  vz: number;
  /** Metres per second actually covered last step (0 when pressed against a wall): drives the stride. */
  speed: number;
}

export interface WalkInput {
  /** -1 (back) .. 1 (forward). */
  forward: number;
  /** -1 (left) .. 1 (right): the rate of turning, as a share of the full turn rate. */
  turn: number;
  /** -1 (left) .. 1 (right) sidestep. */
  strafe: number;
  run: boolean;
}

export const NO_INPUT: Readonly<WalkInput> = Object.freeze({ forward: 0, turn: 0, strafe: 0, run: false });

export const WALK = {
  walkSpeed: 3.6,
  runSpeed: 7.6,
  backSpeed: 1.8,
  strafeSpeed: 2.4,
  /** Full turn rate, rad/s (about 115 degrees a second). */
  turnRate: 2,
  /** How quickly velocity follows the wanted velocity, per second. */
  accel: 10,
  /** The walker is a disc of this radius. */
  radius: 0.38,
  /** A step is never longer than this, so a fast walker cannot tunnel through a thin wall. */
  maxStep: 0.25,
} as const;

export function createWalker(x = 0, z = 0, heading = 0): WalkerState {
  return { x, z, heading, vx: 0, vz: 0, speed: 0 };
}

const TAU = Math.PI * 2;

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}

/** The shortest signed angle from `from` to `to`. */
export const angleDelta = (from: number, to: number): number => wrapAngle(to - from);

/** Exponential smoothing factor for `rate` per second over `dt`: the share of the gap to close. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/**
 * Pushes a disc out of a box. Returns true when it moved. The disc may start inside the box (after
 * a moving solid arrives on top of it): it then leaves by the nearest face.
 */
export function pushOutOfBox(p: { x: number; z: number }, r: number, b: Box): boolean {
  const cx = Math.min(Math.max(p.x, b.x0), b.x1);
  const cz = Math.min(Math.max(p.z, b.z0), b.z1);
  const dx = p.x - cx;
  const dz = p.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    p.x = cx + (dx / d) * r;
    p.z = cz + (dz / d) * r;
    return true;
  }
  // Centre inside the box: leave by the nearest face.
  const toL = p.x - b.x0;
  const toR = b.x1 - p.x;
  const toN = p.z - b.z0;
  const toS = b.z1 - p.z;
  const m = Math.min(toL, toR, toN, toS);
  if (m === toL) p.x = b.x0 - r;
  else if (m === toR) p.x = b.x1 + r;
  else if (m === toN) p.z = b.z0 - r;
  else p.z = b.z1 + r;
  return true;
}

export function pushOutOfDisc(p: { x: number; z: number }, r: number, d: Disc): boolean {
  const dx = p.x - d.x;
  const dz = p.z - d.z;
  const min = r + d.r;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return false;
  if (d2 < 1e-12) {
    p.x = d.x + min;
    return true;
  }
  const dist = Math.sqrt(d2);
  p.x = d.x + (dx / dist) * min;
  p.z = d.z + (dz / dist) * min;
  return true;
}

/** Resolves a disc against every solid, a few passes so a corner (two walls) settles. */
export function resolveCollisions(p: { x: number; z: number }, r: number, solids: Solids, extra?: readonly Box[]): boolean {
  let hit = false;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const b of solids.boxes) if (pushOutOfBox(p, r, b)) moved = true;
    if (extra) for (const b of extra) if (pushOutOfBox(p, r, b)) moved = true;
    for (const d of solids.discs) if (pushOutOfDisc(p, r, d)) moved = true;
    if (!moved) break;
    hit = true;
  }
  return hit;
}

/** The velocity the input asks for, in the world frame, at the walker's current heading. */
export function wantedVelocity(heading: number, input: WalkInput, out: { vx: number; vz: number }): void {
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  // Right of forward is (cos h, sin h).
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  const f = Math.max(-1, Math.min(1, input.forward));
  const s = Math.max(-1, Math.min(1, input.strafe));
  const along = f > 0 ? f * (input.run ? WALK.runSpeed : WALK.walkSpeed) : f * WALK.backSpeed;
  const across = s * WALK.strafeSpeed;
  out.vx = fx * along + rx * across;
  out.vz = fz * along + rz * across;
}

const want = { vx: 0, vz: 0 };
const probe = { x: 0, z: 0 };

/**
 * One frame of walking: turn, accelerate towards the wanted velocity, move in short steps and slide
 * along whatever is in the way. `solids` are those near the walker (the caller caches them by
 * chunk); `extra` holds moving solids such as a train.
 */
export function stepWalker(w: WalkerState, input: WalkInput, dt: number, solids: Solids, extra?: readonly Box[]): void {
  if (!(dt > 0)) return;
  const step = Math.min(dt, 0.1);
  w.heading = wrapAngle(w.heading + Math.max(-1, Math.min(1, input.turn)) * WALK.turnRate * step);
  wantedVelocity(w.heading, input, want);
  const k = damp(WALK.accel, step);
  w.vx += (want.vx - w.vx) * k;
  w.vz += (want.vz - w.vz) * k;
  if (want.vx === 0 && want.vz === 0 && Math.hypot(w.vx, w.vz) < 0.02) w.vx = w.vz = 0;
  const startX = w.x;
  const startZ = w.z;
  const n = Math.max(1, Math.ceil((Math.hypot(w.vx, w.vz) * step) / WALK.maxStep));
  probe.x = w.x;
  probe.z = w.z;
  for (let i = 0; i < n; i++) {
    probe.x += (w.vx * step) / n;
    probe.z += (w.vz * step) / n;
    resolveCollisions(probe, WALK.radius, solids, extra);
  }
  w.x = probe.x;
  w.z = probe.z;
  w.speed = Math.hypot(w.x - startX, w.z - startZ) / step;
  // A walker pressed against a wall loses the velocity into it, so it does not stay "running".
  if (w.speed < Math.hypot(w.vx, w.vz) * 0.5) {
    w.vx *= 0.5;
    w.vz *= 0.5;
  }
}

// ---------------------------------------------------------------- the follow camera

export interface FollowCamera {
  /** Where the camera looks round to: damped towards the walker's heading. */
  yaw: number;
  /** Distance behind the walker, damped so a wall pulls the camera in smoothly and it eases back. */
  distance: number;
}

export const CAMERA = {
  distance: 6.2,
  minDistance: 1.6,
  height: 3.1,
  /** Height of the point the camera looks at, above the walker's feet. */
  lookHeight: 1.45,
  /** How far ahead of the walker the camera looks. */
  lookAhead: 3.2,
  yawRate: 3.2,
  fov: 58,
} as const;

export function createFollowCamera(heading = 0): FollowCamera {
  return { yaw: heading, distance: CAMERA.distance };
}

/** Slab test of the ray (x, z) + t * (dx, dz) against a box; the entry distance, or null. */
function rayBox(x: number, z: number, dx: number, dz: number, b: Box): number | null {
  let tmin = 0;
  let tmax = Infinity;
  const slabs: [number, number, number, number][] = [
    [x, dx, b.x0, b.x1],
    [z, dz, b.z0, b.z1],
  ];
  for (const [o, d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/**
 * The distance along the unit direction (dx, dz) from (x, z) at which a box or disc first gets in
 * the way, or `max` if the ray reaches that far clear. A margin keeps the camera off the surface.
 */
export function clearDistance(x: number, z: number, dx: number, dz: number, max: number, solids: Solids, margin = 0.5): number {
  let best = max;
  for (const b of solids.boxes) {
    const t = rayBox(x, z, dx, dz, b);
    if (t !== null && t - margin < best) best = Math.max(0, t - margin);
  }
  for (const c of solids.discs) {
    const px = c.x - x;
    const pz = c.z - z;
    const along = px * dx + pz * dz;
    if (along < 0 || along > max) continue;
    const off = Math.abs(px * dz - pz * dx);
    if (off < c.r + 0.2 && along - margin < best) best = Math.max(0, along - margin);
  }
  return best;
}

/** Eases the camera behind the walker; pulls it in when a building would sit between them. */
export function stepFollowCamera(cam: FollowCamera, w: WalkerState, dt: number, solids: Solids, snap = false): void {
  const step = Math.min(Math.max(dt, 0), 0.1);
  cam.yaw = wrapAngle(cam.yaw + angleDelta(cam.yaw, w.heading) * (snap ? 1 : damp(CAMERA.yawRate, step)));
  // Behind the walker, along the damped yaw.
  const bx = -Math.sin(cam.yaw);
  const bz = Math.cos(cam.yaw);
  const free = clearDistance(w.x, w.z, bx, bz, CAMERA.distance, solids);
  const want = Math.max(CAMERA.minDistance, free);
  // Pulled in at once (never look through a wall); eased back out.
  cam.distance = want < cam.distance || snap ? want : cam.distance + (want - cam.distance) * damp(2.5, step);
}
