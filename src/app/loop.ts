import type { Game, GameEvent } from '../game/game';
import type { CommandSource, GameCommand } from '../input/commands';
import { InputHub } from '../input/hub';
import type { Baseline } from '../pose/calibration';
import type { PoseStatus } from '../pose/types';
import type { InputSourceName } from '../telemetry/messages';
import { isStalled } from '../ui/pip';
import type { FlowEffect, FlowInput, FlowScreen, SessionFlow } from './flow';
import type { RuntimeStatus } from './poseRuntime';

/** The parts of PoseRuntime the loop uses. */
export interface LoopPose {
  readonly commands: CommandSource;
  readonly running: boolean;
  readonly backend: string;
  readonly ctrl: { readonly baseline: Baseline | null };
  status(): RuntimeStatus;
  /** undefined while the frame luma is not known yet. */
  dark(nowMs: number): boolean | undefined;
}

/** The parts of TelemetryPublisher the loop uses. */
export interface LoopTelemetry {
  commands(c: readonly GameCommand[], source: InputSourceName, t: number): void;
  gameEvents(e: readonly GameEvent[], t: number): void;
  game(g: Game, idleMs: number, t: number): void;
  status(s: PoseStatus, backend: string, base?: Baseline | null): void;
}

export interface AppLoopOptions {
  game: Game;
  flow: SessionFlow;
  keyboard: CommandSource;
  autopilot?: (CommandSource & { tick(): void }) | null;
  pose?: LoopPose | null;
  telemetry?: LoopTelemetry | null;
  /** Flow effects the loop cannot run itself: openCamera, stopCamera, recalibrate, setForcedMode. */
  onEffect?: (fx: FlowEffect) => void;
  /** Every game event, after the flow has seen it. */
  onGameEvent?: (e: GameEvent) => void;
  /** No pose frame for this long reads as a stalled camera (default 1000 ms, the lost threshold). */
  stallMs?: number;
}

const START: GameCommand = Object.freeze({ type: 'start' });
const NONE: readonly GameCommand[] = Object.freeze([]);
/** Esc on these screens goes back to the menu. */
const BACK_SCREENS: ReadonlySet<FlowScreen> = new Set(['cameraPrompt', 'cameraStarting', 'cameraError', 'calibrating', 'moveCheck', 'ready']);

/**
 * The per-frame glue of the game page, kept free of the DOM so it can run headless:
 * drain every input source → route `start` through the session flow → game.step →
 * telemetry → flow state. main.ts calls beginFrame, step (0..n times) and endFrame on every
 * animation frame, with the rAF timestamp, which is the same clock as the pose frames.
 *
 * Start routing (ui-report): outside play the flow owns `start`. A pose `start` is always a
 * `startGesture` (ignored while the game is paused by a lost pose: that resumes by itself);
 * a keyboard or bot `start` is `startPressed` until the flow reaches `playing`, then passes
 * through. The flow's `startGame` effect injects one `start` into the next game step.
 */
export class AppLoop {
  /** Game events of the current frame (for the renderer). */
  readonly frameEvents: GameEvent[] = [];
  /** The pose status read by the last endFrame(), or null when the webcam is not the input. */
  status: RuntimeStatus | null = null;
  /** The camera is open but no pose frame arrived for `stallMs`. */
  stalled = false;

  private readonly game: Game;
  private readonly flow: SessionFlow;
  private readonly keyboard: CommandSource;
  private readonly autopilot: (CommandSource & { tick(): void }) | null;
  private readonly pose: LoopPose | null;
  private readonly telemetry: LoopTelemetry | null;
  private readonly onEffect: (fx: FlowEffect) => void;
  private readonly onGameEvent: ((e: GameEvent) => void) | null;
  private readonly stallMs: number;
  /** Activity without the camera (keyboard, bot) and with it. */
  private readonly hubOff: InputHub;
  private readonly hubOn: InputHub;
  private readonly merged: GameCommand[] = [];
  private startQueued = false;
  private lastNow = 0;

  constructor(o: AppLoopOptions) {
    this.game = o.game;
    this.flow = o.flow;
    this.keyboard = o.keyboard;
    this.autopilot = o.autopilot ?? null;
    this.pose = o.pose ?? null;
    this.telemetry = o.telemetry ?? null;
    this.onEffect = o.onEffect ?? (() => {});
    this.onGameEvent = o.onGameEvent ?? null;
    this.stallMs = o.stallMs ?? 1000;
    const base: CommandSource[] = this.autopilot ? [this.keyboard, this.autopilot] : [this.keyboard];
    this.hubOff = new InputHub(base);
    this.hubOn = new InputHub(this.pose ? [...base, this.pose.commands] : base);
  }

  /**
   * The webcam drives the game: pose commands and pose activity (jogging, lost) count.
   * Off in keyboard mode and while no camera is open, so a stopped camera never reads as "lost".
   */
  get poseActive(): boolean {
    return this.pose !== null && this.flow.input === 'webcam' && this.flow.cameraReady;
  }

  /** Feeds one input to the session flow and runs its effects. */
  dispatch(i: FlowInput): void {
    const fx = this.flow.dispatch(i);
    for (let k = 0; k < fx.length; k++) this.run(fx[k]);
  }

  /** Pauses a live run (Esc-style, resumed by Enter or a raised hand) and tells the flow and telemetry. */
  pauseGame(): void {
    const game = this.game;
    const before = game.state;
    const wasLoss = game.pausedByLoss;
    // A loss-pause resumes by itself as soon as the pose is back, and Game.pause() early-returns
    // while already paused: turn it into a real pause here, so the run waits for the player instead
    // of restarting behind the calibration or camera-error overlay.
    if (before === 'paused' && wasLoss) game.pausedByLoss = false;
    game.pause();
    // Game.pause() is a direct call and emits nothing: report the change like a step would.
    if (game.state !== before) this.gameEvents([{ type: 'state', state: game.state }], this.lastNow);
    else if (wasLoss !== game.pausedByLoss) this.dispatch({ type: 'gameState', state: game.state, pausedByLoss: false });
  }

  beginFrame(): void {
    this.frameEvents.length = 0;
  }

  /** One fixed game step at `nowMs`. */
  step(stepSec: number, nowMs: number): void {
    const { game, telemetry: tel } = this;
    this.lastNow = nowMs;
    this.autopilot?.tick();
    const kb = this.keyboard.drain();
    const pc = this.pose ? this.pose.commands.drain() : NONE;
    const bot = this.autopilot ? this.autopilot.drain() : NONE;
    if (tel) {
      tel.commands(kb, 'keyboard', nowMs);
      tel.commands(pc, 'pose', nowMs);
      tel.commands(bot, 'autopilot', nowMs);
    }

    const merged = this.merged;
    merged.length = 0;
    this.routeButtons(kb, merged);
    const usePose = this.poseActive;
    for (let k = 0; k < pc.length; k++) {
      const c = pc[k];
      if (c.type === 'start') {
        // Dropped only while the game is *currently* paused by a lost pose (it resumes by itself).
        // `pausedByLoss` is not cleared on resume, so the state has to be checked with it.
        if (usePose && !(game.state === 'paused' && game.pausedByLoss)) this.dispatch({ type: 'startGesture' });
      } else if (usePose) {
        merged.push(c);
      }
    }
    this.routeButtons(bot, merged);
    if (this.startQueued) {
      this.startQueued = false;
      merged.push(START);
    }

    const activity = (this.poseActive ? this.hubOn : this.hubOff).activity(nowMs);
    const events = game.step(stepSec, merged, activity);
    if (events.length) this.gameEvents(events, nowMs);
  }

  /** After the frame's steps: pose status → flow, warnings, telemetry snapshots. */
  endFrame(nowMs: number): void {
    this.lastNow = nowMs;
    const pose = this.pose;
    if (pose && this.flow.input === 'webcam') {
      const st = pose.status();
      st.dark = pose.dark(nowMs);
      this.stalled = this.flow.cameraReady && isStalled(st.lastFrameT, nowMs, this.stallMs);
      this.status = st;
      this.dispatch({ type: 'pose', status: st });
      if (pose.running) this.telemetry?.status(st, pose.backend, pose.ctrl.baseline);
    } else {
      this.status = null;
      this.stalled = false;
    }
    this.telemetry?.game(this.game, this.game.idleMs, nowMs);
  }

  /** Keyboard and bot commands: `start` / Esc belong to the flow until it reaches `playing`. */
  private routeButtons(cmds: readonly GameCommand[], out: GameCommand[]): void {
    for (let k = 0; k < cmds.length; k++) {
      const c = cmds[k];
      const screen = this.flow.screen;
      if (screen !== 'playing') {
        if (c.type === 'start') {
          this.dispatch({ type: 'startPressed' });
          continue;
        }
        if (c.type === 'pause' && BACK_SCREENS.has(screen)) {
          this.dispatch({ type: 'back' });
          continue;
        }
      }
      out.push(c);
    }
  }

  private gameEvents(events: readonly GameEvent[], nowMs: number): void {
    this.telemetry?.gameEvents(events, nowMs);
    for (let k = 0; k < events.length; k++) {
      const e = events[k];
      this.frameEvents.push(e);
      if (e.type === 'state') this.dispatch({ type: 'gameState', state: e.state, pausedByLoss: this.game.pausedByLoss });
      this.onGameEvent?.(e);
    }
  }

  private run(fx: FlowEffect): void {
    switch (fx.type) {
      case 'startGame':
        this.startQueued = true;
        break;
      case 'pauseGame':
        this.pauseGame();
        break;
      default:
        this.onEffect(fx);
    }
  }
}
