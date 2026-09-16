import { describe, expect, it } from 'vitest';
import { toBody } from '../../src/pose/landmarks';
import { ASPECT, STAND, synthPose } from '../helpers/synth';

describe('toBody', () => {
  it('measures a standing body in height units', () => {
    const b = toBody(synthPose(), ASPECT);
    expect(b.torso).toBeCloseTo(0.25, 3);
    expect(b.shoulderWidth).toBeCloseTo(0.2, 3);
    expect(b.hip.x).toBeCloseTo(STAND.hipX, 3);
    expect(b.hip.y).toBeCloseTo(0.6, 3);
    expect(b.tiltDeg).toBeCloseTo(0, 3);
    expect(b.lowerBodyVisible).toBe(true);
    expect(b.kneeL).not.toBeNull();
    expect(b.confidence).toBeGreaterThan(0.9);
  });

  it("reports a negative tilt when leaning to the player's left", () => {
    expect(toBody(synthPose({ tiltDeg: -20 }), ASPECT).tiltDeg).toBeCloseTo(-20, 3);
  });

  it('drops knees when the lower body is hidden', () => {
    const b = toBody(synthPose({ lowerVisible: false }), ASPECT);
    expect(b.kneeL).toBeNull();
    expect(b.kneeR).toBeNull();
    expect(b.lowerBodyVisible).toBe(false);
  });
});
