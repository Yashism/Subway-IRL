import { TUNING } from './config';

export type PowerupKind = 'magnet' | 'rocket' | 'chappal';
export const POWERUP_KINDS: readonly PowerupKind[] = ['magnet', 'rocket', 'chappal'];

/** Remaining seconds for each timed power-up. */
export class Powerups {
  magnet = 0;
  rocket = 0;
  chappal = 0;
  hoverboard = 0;
  /** Invulnerability after a hoverboard crash or a rocket landing. */
  grace = 0;
  hoverboardsLeft = TUNING.hoverboardsPerRun;

  get invulnerable(): boolean {
    return this.rocket > 0 || this.grace > 0;
  }

  activate(kind: PowerupKind): void {
    if (kind === 'magnet') this.magnet = TUNING.magnetSeconds;
    else if (kind === 'rocket') this.rocket = TUNING.rocketSeconds;
    else this.chappal = TUNING.chappalSeconds;
  }

  activateHoverboard(): boolean {
    if (this.hoverboard > 0 || this.hoverboardsLeft <= 0) return false;
    this.hoverboardsLeft--;
    this.hoverboard = TUNING.hoverboardSeconds;
    return true;
  }

  /** Uses up an active hoverboard to survive a head-on crash. */
  absorbCrash(): boolean {
    if (this.hoverboard <= 0) return false;
    this.hoverboard = 0;
    this.grace = TUNING.crashGraceSeconds;
    return true;
  }

  update(dt: number): { rocketEnded: boolean } {
    const hadRocket = this.rocket > 0;
    this.magnet = Math.max(0, this.magnet - dt);
    this.rocket = Math.max(0, this.rocket - dt);
    this.chappal = Math.max(0, this.chappal - dt);
    this.hoverboard = Math.max(0, this.hoverboard - dt);
    this.grace = Math.max(0, this.grace - dt);
    return { rocketEnded: hadRocket && this.rocket === 0 };
  }

  reset(): void {
    this.magnet = this.rocket = this.chappal = this.hoverboard = this.grace = 0;
    this.hoverboardsLeft = TUNING.hoverboardsPerRun;
  }
}

/** Fills while the player jogs fast; while full, coins count double until it drains empty. */
export class JoshMeter {
  value = 0;
  active = false;

  get multiplier(): number {
    return this.active ? 2 : 1;
  }

  update(dt: number, cadenceSpm: number): void {
    const rate = cadenceSpm >= TUNING.joshCadence ? 1 / TUNING.joshFillSeconds : -1 / TUNING.joshDrainSeconds;
    this.value = Math.min(1, Math.max(0, this.value + rate * dt));
    if (this.value >= 1) this.active = true;
    if (this.value <= 0) this.active = false;
  }

  reset(): void {
    this.value = 0;
    this.active = false;
  }
}
