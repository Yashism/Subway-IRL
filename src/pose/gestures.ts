import type { Body } from './landmarks';
import type { Thresholds } from './thresholds';
import type { PoseEvent } from './types';

/**
 * Hand gestures: both hands up activates the hoverboard; holding the right hand up means start.
 * A wrist only counts as raised when the model can see it; a hidden wrist counts as down.
 */
export class GestureDetector {
  startProgress = 0;
  private hoverSince: number | null = null;
  private hoverArmed = true;
  private startSince: number | null = null;
  private startArmed = true;

  constructor(private th: Thresholds) {}

  reset(): void {
    this.startProgress = 0;
    this.hoverSince = null;
    this.hoverArmed = true;
    this.startSince = null;
    this.startArmed = true;
  }

  update(b: Body, t: number): PoseEvent[] {
    const events: PoseEvent[] = [];
    const leftDown = !b.wristLVisible || b.wristL.y > b.shoulderL.y;
    const rightDown = !b.wristRVisible || b.wristR.y > b.shoulderR.y;

    const bothUp = b.wristLVisible && b.wristRVisible && b.wristL.y < b.nose.y && b.wristR.y < b.nose.y;
    if (!bothUp) {
      this.hoverSince = null;
      if (leftDown || rightDown) this.hoverArmed = true;
    } else if (this.hoverArmed) {
      this.hoverSince ??= t;
      if (t - this.hoverSince >= this.th.hoverHoldMs) {
        this.hoverArmed = false;
        this.hoverSince = null;
        events.push({ type: 'hoverboard' });
      }
    }

    const rightOnly = !rightDown && leftDown;
    if (!rightOnly) {
      this.startSince = null;
      this.startProgress = 0;
      if (rightDown) this.startArmed = true;
    } else if (this.startArmed) {
      this.startSince ??= t;
      this.startProgress = Math.min(1, (t - this.startSince) / this.th.startHoldMs);
      if (this.startProgress >= 1) {
        this.startArmed = false;
        this.startSince = null;
        this.startProgress = 0;
        events.push({ type: 'start' });
      }
    }
    return events;
  }
}
