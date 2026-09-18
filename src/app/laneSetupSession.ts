/**
 * The lane-spots setup as the game page runs it: it owns the LaneSetup the flow asks for, feeds it
 * the pose frames and saves the result when — and only when — the player presses Save.
 * Spec: docs/superpowers/specs/2026-09-18-lane-spots.md
 *
 * DOM-free, so the whole routing can be tested headless: `main.ts` renders `model` with
 * LaneSetupScreen and hands `handlers` to it.
 */
import { LaneSetup, type LaneSetupModel } from '../pose/laneSetup';
import { LaneSpotsStore, type LaneSpots } from '../pose/laneSpots';
import type { MoveMagnitudes, PlayMode } from '../pose/types';

/** What the setup needs from the pose pipeline each frame. `PoseController` satisfies it. */
export interface LaneSetupSource {
  readonly magnitudes: Readonly<MoveMagnitudes>;
  /** Null when nobody is in view (the magnitudes then read 0, which is not "at the centre"). */
  readonly body: unknown;
  readonly baseline: { readonly mode: PlayMode } | null;
}

/** What the setup screen can ask for. The session supplies these. */
export interface LaneSetupHandlers {
  /** Keep the three spots and switch Lanes to My spots. Only does anything once all three are taken. */
  save(): void;
  /** Forget the spots taken so far and start again from the centre. */
  redo(): void;
  /** Leave without saving; the saved spots stay as they were. */
  cancel(): void;
}

export interface LaneSetupSessionOptions {
  /** Default: the browser's localStorage-backed store. */
  store?: LaneSpotsStore;
  /** Epoch ms for a saved record. Default: Date.now. */
  now?: () => number;
  /** New spots were just saved. The page switches Lanes to My spots and puts them in force. */
  onSaved?: (spots: LaneSpots) => void;
  /** Save or Cancel: the page tells the flow the setup is finished with (`lanesDone`). */
  onDone?: () => void;
}

export class LaneSetupSession {
  readonly store: LaneSpotsStore;
  readonly handlers: LaneSetupHandlers;
  private readonly opts: LaneSetupSessionOptions;
  private setup: LaneSetup | null = null;

  constructor(opts: LaneSetupSessionOptions = {}) {
    this.opts = opts;
    this.store = opts.store ?? new LaneSpotsStore();
    this.handlers = {
      save: () => this.save(),
      redo: () => this.setup?.redo(),
      cancel: () => {
        if (this.setup) this.opts.onDone?.();
      },
    };
  }

  /** The model to render, or null when no setup is running (the screen hides itself on null). */
  get model(): LaneSetupModel | null {
    return this.setup?.model ?? null;
  }

  get running(): boolean {
    return this.setup !== null;
  }

  /** The flow's `startLaneSetup` effect: a fresh setup, from the centre spot. */
  begin(): void {
    this.setup = new LaneSetup();
  }

  /**
   * The flow's `endLaneSetup` effect. Every way out comes through here — Save, Cancel, Home, Esc,
   * a recalibration, a camera failure — and none of them writes anything: Save already has.
   */
  end(): void {
    this.setup = null;
  }

  /** One pose frame. Only a tracked, full-body-calibrated player has an offset to stand on. */
  frame(src: LaneSetupSource, tMs: number): void {
    const setup = this.setup;
    if (!setup) return;
    const offset = src.body !== null && src.baseline?.mode === 'full' ? src.magnitudes.lane : null;
    setup.update(offset, tMs);
  }

  private save(): void {
    const result = this.setup?.model.result;
    if (!result) return;
    if (!this.store.save(result, this.opts.now?.() ?? Date.now())) return;
    this.opts.onSaved?.({ ...result });
    this.opts.onDone?.();
  }
}
