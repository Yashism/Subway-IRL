export const LANE_WIDTH = 2.5;
export const laneX = (lane: number): number => lane * LANE_WIDTH;

export type Difficulty = 'chill' | 'cardio' | 'beast';

/** Multipliers on top speed and on how fast the speed ramps up. */
export const DIFFICULTY: Record<Difficulty, { speed: number; ramp: number }> = {
  chill: { speed: 0.8, ramp: 0.8 },
  cardio: { speed: 1, ramp: 1 },
  beast: { speed: 1.2, ramp: 1.2 },
};

/** Every gameplay constant. Distances in metres, times in seconds unless named *Ms. */
export const TUNING = {
  stepHz: 60,
  // speed
  startSpeed: 12,
  topSpeed: 30,
  rampSeconds: 240,
  warmupSeconds: 20,
  minGapStart: 1.2,
  minGapFloor: 0.8,
  // runner
  laneChangeSeconds: 0.15,
  jumpSeconds: 0.6,
  jumpHeight: 1.2,
  chappalJumpSeconds: 0.9,
  chappalJumpHeight: 3.8,
  rollSeconds: 0.6,
  slamSpeed: 25,
  runnerHeight: 1.8,
  rollHeight: 0.8,
  runnerHalfWidth: 0.4,
  runnerHalfDepth: 0.4,
  rocketHeight: 6,
  rocketClimbSpeed: 8,
  laneSettleDistance: 0.3,
  surfaceSnap: 0.05,
  // world
  trainHeight: 3.2,
  oncomingTrainSpeed: 10,
  coinSpacing: 3,
  coinHeight: 0.8,
  pickupChance: 0.35,
  obstacleHalfWidth: 0.8,
  /** A roof holds the runner up to half a lane either side, so neighbouring roofs join up. */
  roofSupportHalfWidth: LANE_WIDTH / 2,
  stepUp: 0.5,
  rampLevelEarly: 1,
  coinReach: 1,
  coinReachHeight: 0.5,
  magnetCollect: 1.5,
  pickupReach: 1,
  pickupMaxHeight: 1.5,
  // rules
  stumbleWindowSeconds: 8,
  idleWarnMs: 1000,
  idleCaughtMs: 2000,
  squatIdleCreditMs: 1000,
  catchSeconds: 5,
  countdownSeconds: 3,
  // power-ups
  hoverboardsPerRun: 3,
  /**
   * The hoverboard is a rest: while it lasts the player may stop jogging and the TT cannot catch
   * them for it. When it ends, for any reason, the idle clock restarts, so they get the full
   * `idleCaughtMs` to start jogging again rather than being caught for time spent resting.
   */
  hoverboardSeconds: 30,
  /** Seconds before a rest ends that a player who is not moving is told to get ready to jog. */
  restWarnSeconds: 3,
  crashGraceSeconds: 1,
  /** Extra metres cleared around the grace stretch after a hoverboard save. */
  crashClearMargin: 1,
  magnetSeconds: 10,
  magnetRange: 30,
  rocketSeconds: 8,
  rocketLandingClearSeconds: 1,
  chappalSeconds: 10,
  rocketFallSeconds: 1.5,
  joshCadence: 160,
  joshFillSeconds: 5,
  joshDrainSeconds: 3,
  // chaser
  chaserStartGap: 1.5,
  chaserNearGap: 3,
  chaserFarGap: 12,
  chaserRecedeRate: 0.6,
  chaserApproachRate: 3,
  chaserCaughtGap: 0.5,
  chaserHideMargin: 1,
};
