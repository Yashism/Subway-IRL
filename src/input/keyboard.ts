import type { ActivityStatus, CommandSource, GameCommand } from './commands';

export interface KeyLike {
  code: string;
  repeat?: boolean;
}

/** Holding J jogs at 160 steps per minute. */
const JOG_STEP_MS = 375;

const KEYMAP: Record<string, GameCommand> = {
  ArrowLeft: { type: 'shiftLane', dir: -1 },
  KeyA: { type: 'shiftLane', dir: -1 },
  ArrowRight: { type: 'shiftLane', dir: 1 },
  KeyD: { type: 'shiftLane', dir: 1 },
  ArrowUp: { type: 'jump' },
  KeyW: { type: 'jump' },
  ArrowDown: { type: 'roll' },
  KeyS: { type: 'roll' },
  Space: { type: 'hoverboard' },
  Enter: { type: 'start' },
  Escape: { type: 'pause' },
  KeyP: { type: 'pause' },
};

/** Keyboard controls. With jogEnabled, holding J stands in for jogging in place. */
export class KeyboardInput implements CommandSource {
  jogEnabled = false;
  private queue: GameCommand[] = [];
  private jogStart: number | null = null;
  private jogStoppedAt = -Infinity;
  private stepsBefore = 0;

  /** Returns true when the key is one the game uses (so the caller can preventDefault). */
  keyDown(e: KeyLike, tMs: number): boolean {
    if (e.code === 'KeyJ') {
      this.jogStart ??= tMs;
      return true;
    }
    const cmd = KEYMAP[e.code];
    if (!cmd) return false;
    if (!e.repeat) this.queue.push({ ...cmd });
    return true;
  }

  keyUp(e: KeyLike, tMs: number): void {
    if (e.code !== 'KeyJ' || this.jogStart === null) return;
    this.stepsBefore += this.jogSteps(tMs);
    this.jogStart = null;
    this.jogStoppedAt = tMs;
  }

  drain(): GameCommand[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  activity(tMs: number): ActivityStatus {
    const jogging = this.jogStart !== null;
    return {
      tracksJogging: this.jogEnabled,
      msSinceStep: jogging ? 0 : tMs - this.jogStoppedAt,
      cadenceSpm: jogging ? 160 : 0,
      steps: this.stepsBefore + this.jogSteps(tMs),
      squatting: false,
      lost: false,
    };
  }

  attach(target: EventTarget, now: () => number = () => performance.now()): () => void {
    const down = (e: Event) => {
      if (this.keyDown(e as KeyboardEvent, now())) e.preventDefault();
    };
    const up = (e: Event) => this.keyUp(e as KeyboardEvent, now());
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
    };
  }

  private jogSteps(tMs: number): number {
    return this.jogStart === null ? 0 : Math.floor((tMs - this.jogStart) / JOG_STEP_MS) + 1;
  }
}
