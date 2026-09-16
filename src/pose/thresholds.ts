/**
 * Detection thresholds. Distances are in torso lengths (full-body mode) or shoulder widths
 * (small-room mode), angles in degrees, times in milliseconds. Magnitudes are divided by the
 * sensitivity setting, so sensitivity > 1 makes moves easier to trigger.
 */
export const DEFAULT_THRESHOLDS = {
  // full-body
  laneEnter: 0.5,
  laneExit: 0.35,
  jumpVel: 1.5,
  jumpRise: 0.15,
  jumpRearm: 0.08,
  rollDrop: 0.3,
  rollHoldMs: 100,
  rollHeadDrop: 0.4,
  kneeLift: 0.12,
  kneeRelease: 0.06,
  // small-room
  leanDeg: 15,
  leanRearmDeg: 7,
  noseShift: 0.35,
  noseRearm: 0.2,
  smallJumpVel: 1.2,
  smallJumpRise: 0.12,
  smallJumpRearm: 0.06,
  duckDrop: 0.3,
  wristPump: 0.15,
  // jogging (both modes)
  bobMinAmp: 0.03,
  bobJumpFactor: 2.5,
  bobMaxStepGapMs: 700,
  bobMaxSwing: 0.25,
  // gestures, tracking, calibration
  hoverHoldMs: 300,
  startHoldMs: 1500,
  lostMs: 1000,
  calibHoldMs: 2000,
  calibStill: 0.15,
  calibMinTorso: 0.1,
  driftSettle: 0.1,
};

export type Thresholds = typeof DEFAULT_THRESHOLDS;
