import type { Lane } from '../pose/types';
import type { ObstacleKind, ObstacleSpec } from './obstacles';
import type { Tier } from './speed';

export const CHUNK_LENGTH = 60;

export interface CoinRun {
  lane: Lane;
  s0: number;
  s1: number;
  /** line: at running height; arc: follows a jump over the middle; roof: on top of a train. */
  shape: 'line' | 'arc' | 'roof';
}

export interface ChunkDef {
  id: string;
  tier: Tier;
  obstacles: ObstacleSpec[];
  coins: CoinRun[];
  /** Where a power-up may appear (spawned with TUNING.pickupChance). */
  pickup?: { lane: Lane; s: number };
}

const L: Lane = -1;
const C: Lane = 0;
const R: Lane = 1;

const o = (kind: ObstacleKind, lane: Lane, s: number, length?: number): ObstacleSpec =>
  length === undefined ? { kind, lane, s } : { kind, lane, s, length };
const line = (lane: Lane, s0: number, s1: number): CoinRun => ({ lane, s0, s1, shape: 'line' });
const roof = (lane: Lane, s0: number, s1: number): CoinRun => ({ lane, s0, s1, shape: 'roof' });
/** Coins arcing over an obstacle whose middle is at s. */
const arc = (lane: Lane, s: number): CoinRun => ({ lane, s0: s - 6, s1: s + 6, shape: 'arc' });

export const CHUNKS: readonly ChunkDef[] = [
  // tier 0: warm-up
  { id: 'w-coins', tier: 0, obstacles: [], coins: [line(C, 15, 45)] },
  { id: 'w-barrier', tier: 0, obstacles: [o('barrierLow', C, 30)], coins: [arc(C, 30.25), line(L, 15, 45)] },
  { id: 'w-blockers', tier: 0, obstacles: [o('auto', L, 25), o('cow', R, 25)], coins: [line(C, 15, 45)] },
  { id: 'w-banner', tier: 0, obstacles: [o('bannerHigh', C, 30)], coins: [line(L, 15, 45)] },

  // tier 1
  { id: 't1-train-center', tier: 1, obstacles: [o('trainParked', C, 15)], coins: [line(L, 15, 45), line(R, 15, 45)], pickup: { lane: R, s: 52 } },
  {
    id: 't1-ramp-left',
    tier: 1,
    obstacles: [o('ramp', L, 15), o('trainParked', L, 23, 22), o('barrierLow', C, 40)],
    coins: [roof(L, 25, 43), arc(C, 40.25)],
    pickup: { lane: R, s: 30 },
  },
  { id: 't1-auto-barrier', tier: 1, obstacles: [o('auto', C, 20), o('barrierLow', L, 45)], coins: [line(R, 15, 45)], pickup: { lane: C, s: 50 } },
  { id: 't1-banner-cow', tier: 1, obstacles: [o('bannerHigh', C, 25), o('cow', L, 25)], coins: [line(R, 20, 45)] },
  { id: 't1-handcarts', tier: 1, obstacles: [o('handcart', L, 25), o('handcart', R, 25)], coins: [line(C, 15, 45)], pickup: { lane: L, s: 50 } },
  { id: 't1-oncoming', tier: 1, obstacles: [o('trainMoving', R, 25)], coins: [line(C, 15, 45)] },
  {
    id: 't1-barrier-row',
    tier: 1,
    obstacles: [o('barrierLow', L, 30), o('barrierLow', C, 30), o('barrierLow', R, 30)],
    coins: [arc(C, 30.25)],
  },

  // tier 2
  {
    id: 't2-trains-sides',
    tier: 2,
    obstacles: [o('trainParked', L, 15), o('trainParked', R, 15), o('barrierLow', C, 45)],
    coins: [line(C, 15, 36), arc(C, 45.25)],
  },
  {
    id: 't2-zigzag',
    tier: 2,
    obstacles: [o('auto', L, 15), o('auto', R, 15), o('cow', C, 45), o('auto', R, 45)],
    coins: [line(C, 15, 30), line(L, 33, 45)],
    pickup: { lane: L, s: 30 },
  },
  {
    id: 't2-banner-train',
    tier: 2,
    obstacles: [o('trainParked', C, 15), o('bannerHigh', L, 45), o('bannerHigh', R, 45)],
    coins: [line(L, 15, 40), line(R, 15, 40)],
  },
  { id: 't2-oncoming-barrier', tier: 2, obstacles: [o('trainMoving', C, 20), o('barrierLow', L, 45)], coins: [line(R, 15, 45)] },
  {
    id: 't2-roof-run',
    tier: 2,
    obstacles: [o('ramp', C, 15), o('trainParked', C, 23, 22), o('auto', L, 30), o('auto', R, 30)],
    coins: [roof(C, 25, 43)],
  },
  {
    id: 't2-double-barrier',
    tier: 2,
    obstacles: [o('barrierLow', C, 20), o('barrierLow', C, 45)],
    coins: [arc(C, 20.25), arc(C, 45.25)],
    pickup: { lane: L, s: 35 },
  },
  {
    id: 't2-handcart-banner',
    tier: 2,
    obstacles: [o('handcart', L, 20), o('bannerHigh', C, 20), o('handcart', R, 45)],
    coins: [line(R, 15, 40)],
  },

  // tier 3
  {
    id: 't3-corridor',
    tier: 3,
    obstacles: [o('trainParked', L, 15), o('trainParked', R, 15), o('bannerHigh', C, 45)],
    coins: [line(C, 15, 40)],
  },
  {
    id: 't3-oncoming-pair',
    tier: 3,
    obstacles: [o('trainMoving', L, 20), o('trainMoving', R, 20), o('bannerHigh', C, 45)],
    coins: [line(C, 15, 40)],
  },
  {
    id: 't3-roof-and-row',
    tier: 3,
    obstacles: [o('ramp', R, 15), o('trainParked', R, 23, 22), o('barrierLow', L, 30), o('barrierLow', C, 30)],
    coins: [roof(R, 25, 43), arc(C, 30.25)],
  },
  { id: 't3-weave', tier: 3, obstacles: [o('auto', R, 15), o('cow', L, 45), o('auto', C, 45)], coins: [line(R, 20, 45)], pickup: { lane: R, s: 30 } },
  {
    id: 't3-banner-train',
    tier: 3,
    obstacles: [o('bannerHigh', L, 15), o('bannerHigh', C, 15), o('bannerHigh', R, 15), o('trainParked', C, 40, 10)],
    coins: [line(L, 25, 45)],
  },
  { id: 't3-oncoming-center', tier: 3, obstacles: [o('trainMoving', C, 25), o('handcart', L, 45)], coins: [line(R, 15, 45)] },

  // tier 4
  {
    id: 't4-sides-banner',
    tier: 4,
    obstacles: [o('trainParked', L, 15), o('trainParked', R, 15), o('bannerHigh', C, 40)],
    coins: [line(C, 15, 35)],
  },
  { id: 't4-single-train', tier: 4, obstacles: [o('trainParked', C, 15)], coins: [line(L, 15, 45), line(R, 15, 45)], pickup: { lane: L, s: 52 } },
  {
    id: 't4-row-jump',
    tier: 4,
    obstacles: [o('barrierLow', L, 30), o('barrierLow', C, 30), o('barrierLow', R, 30)],
    coins: [arc(C, 30.25)],
  },
  { id: 't4-oncoming-side', tier: 4, obstacles: [o('trainMoving', L, 20)], coins: [line(C, 15, 45)], pickup: { lane: R, s: 35 } },
  {
    id: 't4-roof',
    tier: 4,
    obstacles: [o('ramp', C, 15), o('trainParked', C, 23, 22), o('cow', L, 35), o('auto', R, 35)],
    coins: [roof(C, 25, 43)],
  },
  {
    id: 't4-banner-row',
    tier: 4,
    obstacles: [o('bannerHigh', L, 30), o('bannerHigh', C, 30), o('bannerHigh', R, 30)],
    coins: [line(C, 20, 28)],
  },
];
