import type { ActivityStatus } from '../input/commands';
import { TUNING } from './config';

/** The TT and dog: how far behind the runner they are. */
export class Chaser {
  gap = TUNING.chaserStartGap;

  get visible(): boolean {
    return this.gap < TUNING.chaserFarGap - TUNING.chaserHideMargin;
  }

  update(dt: number, close: boolean): void {
    const target = close ? TUNING.chaserNearGap : TUNING.chaserFarGap;
    const rate = target < this.gap ? TUNING.chaserApproachRate : TUNING.chaserRecedeRate;
    this.gap += (target - this.gap) * (1 - Math.exp(-rate * dt));
  }

  catchUp(): void {
    this.gap = TUNING.chaserCaughtGap;
  }

  reset(): void {
    this.gap = TUNING.chaserStartGap;
  }
}

/** A second side-clip within the window means caught. */
export class StumbleTracker {
  private last = -Infinity;

  hit(tSec: number): 'stumble' | 'caught' {
    const caught = this.recent(tSec);
    this.last = tSec;
    return caught ? 'caught' : 'stumble';
  }

  recent(tSec: number): boolean {
    return tSec - this.last <= TUNING.stumbleWindowSeconds;
  }

  reset(): void {
    this.last = -Infinity;
  }
}

export type IdleLevel = 'ok' | 'warn' | 'caught';

/**
 * The game's own "stopped jogging" clock (spec §5.5). Steps, jumps, rolls,
 * lane changes and resuming all count as activity; a held squat counts for at most 1 s.
 */
export class IdleClock {
  private lastActive = 0;
  private squatSince: number | null = null;

  resume(tMs: number): void {
    this.lastActive = tMs;
    this.squatSince = null;
  }

  action(tMs: number): void {
    this.lastActive = Math.max(this.lastActive, tMs);
  }

  idleMs(tMs: number): number {
    return tMs - this.lastActive;
  }

  update(tMs: number, a: ActivityStatus): IdleLevel {
    if (!a.tracksJogging) {
      this.lastActive = tMs;
      return 'ok';
    }
    if (Number.isFinite(a.msSinceStep)) this.lastActive = Math.max(this.lastActive, tMs - a.msSinceStep);
    if (a.squatting) {
      this.squatSince ??= tMs;
      this.lastActive = Math.max(this.lastActive, Math.min(tMs, this.squatSince + TUNING.squatIdleCreditMs));
    } else {
      this.squatSince = null;
    }
    const idle = this.idleMs(tMs);
    return idle >= TUNING.idleCaughtMs ? 'caught' : idle >= TUNING.idleWarnMs ? 'warn' : 'ok';
  }
}
