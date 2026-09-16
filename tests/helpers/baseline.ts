import { Calibrator, type Baseline } from '../../src/pose/calibration';
import { toBody } from '../../src/pose/landmarks';
import { DEFAULT_THRESHOLDS } from '../../src/pose/thresholds';
import type { PlayMode } from '../../src/pose/types';
import { ASPECT, synthPose, type SynthParams } from './synth';

export function baselineFor(params: Partial<SynthParams> = {}, mode: PlayMode | null = null): Baseline {
  const cal = new Calibrator(DEFAULT_THRESHOLDS);
  for (let t = 0; t < 2500; t += 1000 / 30) {
    const b = cal.update(toBody(synthPose(params), ASPECT), t, mode);
    if (b) return b;
  }
  throw new Error('synthetic body did not calibrate');
}
