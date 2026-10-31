import { TUNING } from './config';

/** Converts variable frame times into a whole number of fixed simulation steps. */
export class FixedStepper {
  private acc = 0;

  constructor(
    readonly stepSec = 1 / TUNING.stepHz,
    readonly maxFrameSec = 0.25,
  ) {}

  /** Seconds the accumulator holds past the last step: how far into the next step this frame is. */
  get remainderSec(): number {
    return this.acc;
  }

  advance(frameSec: number): number {
    this.acc += Math.min(Math.max(frameSec, 0), this.maxFrameSec);
    const n = Math.floor(this.acc / this.stepSec + 1e-9);
    this.acc = Math.max(0, this.acc - n * this.stepSec);
    return n;
  }
}
