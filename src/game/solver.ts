import type { Lane } from '../pose/types';
import { TUNING } from './config';
import { lengthOf, OBSTACLES, type ObstacleSpec } from './obstacles';
import { jumpHeightAt, NORMAL_JUMP, type JumpProfile } from './runner';

export interface Block {
  lane: Lane;
  s0: number;
  s1: number;
  need: 'lane' | 'jump' | 'roll';
  /** Height a jump has to clear. */
  top: number;
  /** Start of the ramp that leads onto this train's roof, if any. */
  rampS: number | null;
}

export type PlanAction =
  | { s: number; type: 'jump' }
  | { s: number; type: 'roll' }
  | { s: number; type: 'lane'; lane: Lane };

export interface PlanOptions {
  speed: number;
  /** Seconds that must pass between actions. */
  minGap: number;
  startLane: Lane;
  /** The runner starts on the roof of a ramp-served train in its lane. */
  onRoof?: boolean;
  /** How jumps go (chappals make them higher and longer). Default NORMAL_JUMP. */
  jump?: JumpProfile;
  /**
   * Where `jump` runs out: jumps that start before `from` use it, jumps from `to` on use
   * NORMAL_JUMP, and none start in between (it is uncertain which profile applies there).
   */
  jumpExpiry?: { from: number; to: number };
}

/** Extra room around an oncoming train's danger zone (runner speed drifts while it approaches). */
const MOVING_MARGIN = 2;
const JUMP_CLEARANCE = 0.02;
/** A runner in the ramp's lane within this distance after the ramp starts goes up onto the roof. */
const ROOF_BOARDING = 1;

const RUN = 0;
const AIR = 1;
const ROLL = 2;
const CHANGE = 3;
/** Dropping off a roof or ramp to the ground; no actions until landed. */
const FALL = 4;
type Mode = typeof RUN | typeof AIR | typeof ROLL | typeof CHANGE | typeof FALL;

interface Node {
  lane: Lane;
  /** Lane being left while changing (equals lane otherwise). */
  from: Lane;
  mode: Mode;
  /** Frame the current mode began. */
  start: number;
  /** First frame a new action may start. */
  free: number;
  /** Index of the roof block the runner is on, or -1. */
  roof: number;
  /** This lane change leaves a raised surface, so the runner falls once it ends. */
  drop: boolean;
  /** The current jump uses `PlanOptions.jump` rather than NORMAL_JUMP. */
  boosted: boolean;
  parent: Node | null;
  action: PlanAction | null;
}

export function toBlocks(specs: readonly ObstacleSpec[], speed: number): Block[] {
  const pad = TUNING.runnerHalfDepth;
  const ramps = specs.filter((o) => o.kind === 'ramp');
  const out: Block[] = [];
  for (const o of specs) {
    const info = OBSTACLES[o.kind];
    const need = info.action;
    if (need === 'none') continue;
    let s0 = o.s - pad;
    let s1 = o.s + lengthOf(o) + pad;
    if (info.moving) {
      s0 -= MOVING_MARGIN;
      s1 = o.s + lengthOf(o) / (1 + TUNING.oncomingTrainSpeed / speed) + pad + MOVING_MARGIN;
    }
    const ramp =
      info.walkTop === null ? undefined : ramps.find((r) => r.lane === o.lane && Math.abs(r.s + lengthOf(r) - o.s) < 0.5);
    out.push({ lane: o.lane, s0, s1, need, top: info.yMax, rampS: ramp ? ramp.s : null });
  }
  return out;
}

/** Finds a sequence of actions that gets from fromS to toS without touching any block, or null. */
export function plan(blocks: readonly Block[], fromS: number, toS: number, o: PlanOptions): PlanAction[] | null {
  const hz = TUNING.stepHz;
  const ds = o.speed / hz;
  const steps = Math.ceil((toS - fromS) / ds);
  const gap = Math.ceil(o.minGap * hz);
  const boost = o.jump ?? NORMAL_JUMP;
  const expiry = o.jumpExpiry ?? { from: Infinity, to: Infinity };
  const profileOf = (n: Node) => (n.boosted ? boost : NORMAL_JUMP);
  const airFramesOf = (n: Node) => Math.round(profileOf(n).seconds * hz);
  const rollFrames = Math.round(TUNING.rollSeconds * hz);
  const changeFrames = Math.ceil(TUNING.laneChangeSeconds * hz);
  const relevant = blocks.filter((b) => b.s1 >= fromS && b.s0 <= toS);
  // Frames to fall from a train roof to the ground (+1 for float rounding at the roof edge).
  const gravity = (8 * NORMAL_JUMP.height) / NORMAL_JUMP.seconds ** 2;
  const fallFrames = Math.ceil(Math.sqrt((2 * TUNING.trainHeight) / gravity) * hz) + 1;

  const startRoof = o.onRoof
    ? relevant.findIndex((b) => b.lane === o.startLane && b.rampS !== null && fromS >= b.s0 && fromS <= b.s1)
    : -1;

  const put = (map: Map<string, Node>, n: Node, at: number) => {
    const age = n.mode === RUN ? 0 : at - n.start;
    const key = `${n.lane}|${n.from}|${n.mode}|${age}|${n.roof}|${n.drop}|${n.mode === AIR && n.boosted}`;
    const old = map.get(key);
    if (!old || n.free < old.free) map.set(key, n);
  };

  const settle = (n: Node, i: number, s: number): Node => {
    let m = n;
    const age = i - n.start;
    if (n.mode === CHANGE && n.drop && age >= changeFrames) {
      m = { ...m, mode: FALL, from: m.lane, start: i, drop: false };
    } else if (
      (n.mode === AIR && age >= airFramesOf(n)) ||
      (n.mode === ROLL && age >= rollFrames) ||
      (n.mode === CHANGE && age >= changeFrames) ||
      (n.mode === FALL && age >= fallFrames)
    ) {
      m = { ...m, mode: RUN, from: m.lane };
    }
    // Past the end of the roof the runner drops to the ground.
    if (m.roof >= 0 && s >= relevant[m.roof].s1) {
      m = { ...m, mode: FALL, from: m.lane, start: i, roof: -1 };
    }
    // Only a runner on its feet (running or rolling) walks up a ramp.
    if (m.roof < 0 && (m.mode === RUN || m.mode === ROLL)) {
      const idx = relevant.findIndex(
        (b) => b.rampS !== null && b.lane === m.lane && s >= b.rampS && s <= b.rampS + ROOF_BOARDING,
      );
      if (idx >= 0) m = { ...m, roof: idx };
    }
    return m;
  };

  /** On a roof, or possibly on a ramp (any runner in a ramp's lane past its start). */
  const raised = (n: Node, s: number): boolean =>
    n.roof >= 0 || relevant.some((b) => b.rampS !== null && b.lane === n.lane && s >= b.rampS && s <= b.s1);

  const valid = (n: Node, i: number, s: number): boolean => {
    for (let bi = 0; bi < relevant.length; bi++) {
      const b = relevant[bi];
      if (s < b.s0 || s > b.s1) continue;
      const inside = n.mode === CHANGE ? b.lane === n.lane || b.lane === n.from : b.lane === n.lane;
      if (!inside) continue;
      if (b.need === 'lane') {
        if (n.roof === bi && n.mode !== CHANGE) continue;
        return false;
      }
      // A runner raised on a ramp or roof is not where a jump or roll is modelled.
      if (raised(n, s)) return false;
      if (b.need === 'jump') {
        if (n.mode !== AIR) return false;
        if (jumpHeightAt((i - n.start) / hz, profileOf(n)) < b.top + JUMP_CLEARANCE) return false;
        continue;
      }
      if (n.mode !== ROLL) return false;
    }
    return true;
  };

  let frontier = new Map<string, Node>();
  put(
    frontier,
    { lane: o.startLane, from: o.startLane, mode: RUN, start: 0, free: 0, roof: startRoof, drop: false, boosted: false, parent: null, action: null },
    0,
  );

  for (let i = 0; i <= steps; i++) {
    const s = fromS + i * ds;
    const next = new Map<string, Node>();
    for (const raw of frontier.values()) {
      const n = settle(raw, i, s);
      if (!valid(n, i, s)) continue;
      if (i === steps) return actionsOf(n);
      put(next, n, i + 1);
      if (n.mode !== RUN || i < n.free) continue;
      // Jumps start only from the ground (a jump off a roof or ramp is not modelled).
      const up = raised(n, s);
      if (!up && (s < expiry.from || s >= expiry.to)) {
        const boosted = s < expiry.from;
        put(next, { ...n, mode: AIR, start: i, free: i + gap, boosted, parent: n, action: { s, type: 'jump' } }, i + 1);
      }
      put(next, { ...n, mode: ROLL, start: i, free: i + gap, parent: n, action: { s, type: 'roll' } }, i + 1);
      for (const d of [-1, 1] as const) {
        const lane = n.lane + d;
        if (lane < -1 || lane > 1) continue;
        const to = lane as Lane;
        put(
          next,
          { ...n, lane: to, from: n.lane, mode: CHANGE, start: i, free: i + gap, roof: -1, drop: up, parent: n, action: { s, type: 'lane', lane: to } },
          i + 1,
        );
      }
    }
    if (next.size === 0) return null;
    frontier = next;
  }
  return null;
}

function actionsOf(n: Node): PlanAction[] {
  const out: PlanAction[] = [];
  for (let c: Node | null = n; c; c = c.parent) if (c.action) out.push(c.action);
  return out.reverse();
}

/** The first entry lane from which the stretch cannot be passed, or null if every lane works. */
export function unpassableFrom(specs: readonly ObstacleSpec[], fromS: number, toS: number, speed: number, minGap: number): Lane | null {
  const blocks = toBlocks(specs, speed);
  for (const lane of [-1, 0, 1] as const) {
    if (!plan(blocks, fromS, toS, { speed, minGap, startLane: lane })) return lane;
  }
  return null;
}
