import type { GameState } from '../game/game';
import type { CalibrationState, PlayMode } from '../pose/types';

/**
 * Session flow (spec "Session flow"): menu → camera setup → calibration → ready → game.
 * Pure state machine: no DOM, no timers, no camera. Callers feed it inputs and run the effects
 * it returns, in order and immediately (before the next pose status is dispatched).
 *
 * Once the screen is `playing`, the Game owns countdown / playing / paused / caught / summary;
 * the flow only listens (`gameState`) so it can offer "raise hand to play again" and recalibration.
 */

export type FlowScreen =
  | 'menu'
  | 'cameraPrompt'
  | 'cameraStarting'
  | 'cameraError'
  | 'calibrating'
  | 'moveCheck'
  /** The guided lane-spots setup (docs/superpowers/specs/2026-09-18-lane-spots.md). */
  | 'laneSetup'
  | 'ready'
  | 'playing';
export type InputMode = 'webcam' | 'keyboard';
export type ModeChoice = 'auto' | PlayMode;
export type CheckState = 'ok' | 'bad' | 'pending';

/**
 * When the guided move check runs after a calibration (spec "Where it runs"):
 * `auto` on a recalibration and on the first ever calibration on this machine, `skip` never,
 * `force` always. `?movecheck=skip|force` picks the last two.
 */
export type MoveCheckPolicy = 'auto' | 'skip' | 'force';

/** The parts of PoseStatus the flow needs, plus the frame-luma verdict. */
export interface PoseSnapshot {
  tracking: boolean;
  calibrated: boolean;
  mode: PlayMode | null;
  startProgress: number;
  calibration: CalibrationState;
  /** The camera image is too dark to track well (from frame luma); undefined until the first sample. */
  dark?: boolean | undefined;
}

export type FlowInput =
  | { type: 'startPressed' }
  | { type: 'retry' }
  | { type: 'back' }
  | { type: 'useKeyboard' }
  | { type: 'useWebcam' }
  | { type: 'chooseCamera'; id: string }
  | { type: 'chooseMode'; mode: ModeChoice }
  | { type: 'recalibrate' }
  /** "Check my moves" from the ready screen: run the check without recalibrating. */
  | { type: 'checkMoves' }
  /**
   * "Set my lane spots" (Settings, the ready screen, or picking My spots with none recorded). Needs
   * a calibrated full-body player: without a camera or a calibration it gets one first.
   */
  | { type: 'setLanes' }
  /** The lane setup is finished with — saved or cancelled; either way, back to where it came from. */
  | { type: 'lanesDone' }
  /** Back to the main menu from anywhere, abandoning whatever is on screen. */
  | { type: 'home' }
  | { type: 'cameraOk' }
  | { type: 'cameraFailed'; message: string }
  | { type: 'pose'; status: PoseSnapshot }
  | { type: 'startGesture' }
  /** `pausedByLoss` is Game.pausedByLoss at the moment of the change (a paused run that resumes itself). */
  | { type: 'gameState'; state: GameState; pausedByLoss?: boolean };

export type FlowEffect =
  | { type: 'openCamera'; cameraId: string | null }
  | { type: 'stopCamera' }
  /** Send one `start` command to the game (starts a run, or resumes a paused one). */
  | { type: 'startGame' }
  | { type: 'pauseGame' }
  /** Call PoseController.recalibrate(). */
  | { type: 'recalibrate' }
  /** Set PoseController.forcedMode. */
  | { type: 'setForcedMode'; mode: PlayMode | null }
  /** The move-check screen is up: build a MoveCheck and start feeding it pose frames. */
  | { type: 'startMoveCheck' }
  /** The move-check screen is gone: stop feeding it (whatever it measured is kept). */
  | { type: 'endMoveCheck' }
  /** The lane-setup screen is up: build a LaneSetup and start feeding it pose frames. */
  | { type: 'startLaneSetup' }
  /** The lane-setup screen is gone: drop it. Nothing is saved on the way out — only Save saves. */
  | { type: 'endLaneSetup' }
  /** Call Game.toMenu(): abandon the run on screen without scoring it. */
  | { type: 'homeGame' };

export interface ScreenModel {
  screen: FlowScreen;
  input: InputMode;
  error: string;
  cameraId: string | null;
  modeChoice: ModeChoice;
  detectedMode: PlayMode | null;
  tracking: boolean;
  checks: { body: CheckState; distance: CheckState; light: CheckState };
  /** Live fix-it hint, '' when every check passes. */
  hint: string;
  /** Calibration hold progress 0..1 (1 once calibrated). */
  progress: number;
  message: string;
  /** Right-hand start hold 0..1. */
  startProgress: number;
  /** The ready screen was reached by the quick re-check after a run, not a fresh calibration. */
  recheck: boolean;
  /** Summary hint in webcam mode, '' otherwise. */
  playAgain: string;
  showRecalibrate: boolean;
  /** The ready screen offers the move check in one click ("Check my moves"). */
  showMoveCheck: boolean;
  /** The ready screen offers the lane-spots setup: a calibrated full-body player. */
  showLaneSetup: boolean;
  gameState: GameState;
}

export interface FlowOptions {
  input?: InputMode;
  cameraId?: string | null;
  modeChoice?: ModeChoice;
  moveCheck?: MoveCheckPolicy;
  /** True when this machine already has a saved move tuning, so a new player is not taught twice. */
  moveCheckSeen?: boolean;
}

export const MSG_HOLD = 'Hold still…';
export const MSG_CALIBRATED = 'Calibrated! Raise your RIGHT hand to start (or press Enter)';
export const MSG_WELCOME_BACK = 'Looking good! Raise your RIGHT hand to go again (or press Enter)';
export const MSG_STEP_IN = 'Step into view (then raise your RIGHT hand)';
export const MSG_PLAY_AGAIN = '✋ Raise your right hand to play again';

const NONE: readonly FlowEffect[] = Object.freeze([]);
const START_CHECK: FlowEffect = Object.freeze({ type: 'startMoveCheck' });
const HOME_GAME: FlowEffect = Object.freeze({ type: 'homeGame' });
const END_CHECK: FlowEffect = Object.freeze({ type: 'endMoveCheck' });
const START_LANES: FlowEffect = Object.freeze({ type: 'startLaneSetup' });
const END_LANES: FlowEffect = Object.freeze({ type: 'endLaneSetup' });
const initialPose = (): PoseSnapshot => ({
  tracking: false,
  calibrated: false,
  mode: null,
  startProgress: 0,
  calibration: { progress: 0, bodyVisible: false, distance: 'ok' },
  dark: undefined,
});

const running = (s: GameState) => s === 'playing' || s === 'countdown';

export class SessionFlow {
  screen: FlowScreen = 'menu';
  input: InputMode;
  /** A camera stream is open and feeding the pose pipeline. */
  cameraReady = false;
  private cameraId: string | null;
  private modeChoice: ModeChoice;
  private error = '';
  private recheck = false;
  private gameState: GameState = 'menu';
  /** The game is paused because the pose was lost, so it will resume on its own. */
  private lossPaused = false;
  /** Owned copy of the last pose snapshot (callers may reuse theirs). */
  private readonly pose: PoseSnapshot = initialPose();
  private cached: ScreenModel | null = null;
  private readonly policy: MoveCheckPolicy;
  /** This machine has a saved move tuning, so the check is offered rather than run unprompted. */
  private seenCheck: boolean;
  /** The calibration now under way should be followed by the move check. */
  private pendingCheck = false;
  /**
   * The player asked for the lane setup before there was a calibrated full-body player to run it
   * with: it opens the moment there is one. Wins over a pending move check — it was asked for.
   */
  private pendingLanes = false;

  constructor(opts: FlowOptions = {}) {
    this.input = opts.input ?? 'webcam';
    this.cameraId = opts.cameraId ?? null;
    this.modeChoice = opts.modeChoice ?? 'auto';
    this.policy = opts.moveCheck ?? 'auto';
    this.seenCheck = opts.moveCheckSeen ?? false;
  }

  /**
   * Tells the flow whether a saved tuning exists now: true once a check has been saved, false
   * again after "Reset to defaults", so the next new player is still taught the moves.
   */
  setMoveCheckSeen(seen: boolean): void {
    this.seenCheck = seen;
  }

  /** The current screen model. The same object is returned until something visible changes. */
  get model(): ScreenModel {
    return (this.cached ??= this.build());
  }

  /** Applies one input; returns the effects to run, in order. The returned array must not be mutated. */
  dispatch(i: FlowInput): FlowEffect[] {
    const was = this.screen;
    const fx = this.route(i);
    // Every way off the move-check or lane-setup screen tears it down, so no caller has to remember to.
    if (was === this.screen) return fx;
    if (was === 'moveCheck') return [END_CHECK, ...fx];
    if (was === 'laneSetup') return [END_LANES, ...fx];
    return fx;
  }

  private route(i: FlowInput): FlowEffect[] {
    if (i.type === 'pose') return this.onPose(i.status);
    this.cached = null;
    if (i.type === 'gameState') {
      this.gameState = i.state;
      this.lossPaused = i.state === 'paused' && !!i.pausedByLoss;
      return NONE as FlowEffect[];
    }
    // Home works the same with or without a camera: it is the way out of every screen there is.
    if (i.type === 'home') return this.home();
    return this.input === 'keyboard' ? this.keyboard(i) : this.webcam(i);
  }

  private keyboard(i: FlowInput): FlowEffect[] {
    if (this.screen === 'menu' && i.type === 'startPressed') return this.play();
    if (this.screen === 'menu' && i.type === 'useWebcam') this.input = 'webcam';
    return NONE as FlowEffect[];
  }

  private webcam(i: FlowInput): FlowEffect[] {
    // Inputs that mean the same on every camera screen.
    switch (i.type) {
      case 'useKeyboard':
        return this.toKeyboard();
      case 'cameraFailed':
        return this.cameraFailed(i.message);
      case 'recalibrate':
        return this.recalibrate(NONE as FlowEffect[]);
      case 'checkMoves':
        return this.checkMoves();
      case 'setLanes':
        return this.setLanes();
      case 'chooseMode':
        return this.chooseMode(i.mode);
      case 'back':
        // Esc cancels the card in front of you and puts you back where you were. With a run still
        // on screen — paused behind a recalibration, say — "where you were" is the run, not the
        // menu: leaving the pause card sitting over the menu's own screen is neither.
        if (this.screen !== 'playing') this.screen = this.gameState === 'menu' ? 'menu' : 'playing';
        this.pendingLanes = false;
        return NONE as FlowEffect[];
      default:
        break;
    }

    switch (this.screen) {
      case 'menu':
        if (i.type === 'cameraOk') this.cameraReady = true;
        // The camera is already open here when permission was granted at boot, so a camera chosen
        // in Settings has to take effect now. Dropping it looked like it was accepted and was not.
        if (i.type === 'chooseCamera') return this.switchCamera(i.id);
        if (i.type === 'startPressed') return this.cameraReady ? this.quickStart() : this.go('cameraPrompt');
        if (i.type === 'startGesture' && this.cameraReady) return this.quickStart();
        return NONE as FlowEffect[];
      case 'cameraPrompt':
        if (i.type === 'startPressed') return this.openCamera();
        return NONE as FlowEffect[];
      case 'cameraStarting':
        if (i.type === 'cameraOk') {
          this.cameraReady = true;
          return this.go(this.pose.calibrated ? 'ready' : 'calibrating');
        }
        return NONE as FlowEffect[];
      case 'cameraError':
        // A camera start that succeeded after this screen was shown (a late or superseded failure):
        // move on instead of stranding the player on an error with a working camera.
        if (i.type === 'cameraOk') {
          this.cameraReady = true;
          this.error = '';
          return this.go(this.pose.calibrated ? 'ready' : 'calibrating');
        }
        if (i.type === 'retry' || i.type === 'startPressed') return this.openCamera();
        if (i.type === 'chooseCamera') {
          this.cameraId = i.id;
          return this.openCamera();
        }
        return NONE as FlowEffect[];
      case 'calibrating':
      case 'ready':
        if (i.type === 'chooseCamera') return this.switchCamera(i.id);
        if (this.screen === 'ready' && (i.type === 'startPressed' || i.type === 'startGesture')) return this.play();
        return NONE as FlowEffect[];
      case 'moveCheck':
        if (i.type === 'chooseCamera') return this.switchCamera(i.id);
        // "START PLAYING" (and Enter) means what it says: out of the check and into the run. The
        // start gesture is ignored here instead — the hoverboard step has both hands up, which is
        // one hand away from it, and a check must never be dropped by the move it is asking for.
        if (i.type === 'startPressed') return this.endCheck();
        return NONE as FlowEffect[];
      case 'laneSetup':
        if (i.type === 'chooseCamera') return this.switchCamera(i.id);
        if (i.type === 'lanesDone') return this.lanesDone();
        // Neither Enter nor a raised hand leaves the setup: the player is standing on spots, arms
        // anywhere, and Save / Cancel are the only answers to what it asks. Esc and Home still work.
        return NONE as FlowEffect[];
      case 'playing':
        if (i.type === 'chooseCamera') return this.switchCamera(i.id);
        if (i.type === 'startGesture') {
          if (this.gameState === 'summary') return this.quickStart();
          if (this.gameState === 'paused') return [{ type: 'startGame' }];
        }
        return NONE as FlowEffect[];
    }
  }

  /** Called every frame: copies into the owned snapshot, allocates nothing. */
  private onPose(p: PoseSnapshot): FlowEffect[] {
    if (!samePose(this.pose, p)) {
      copyPose(this.pose, p);
      this.cached = null;
    }
    if (this.input !== 'webcam') return NONE as FlowEffect[];
    if (this.screen === 'calibrating' && p.calibrated) {
      this.recheck = false;
      this.cached = null;
      if (this.pendingLanes) {
        // Asked for by the player, so it goes first; the check stays one click away on the ready screen.
        this.pendingCheck = false;
        this.screen = 'ready';
      } else if (this.pendingCheck) {
        this.pendingCheck = false;
        this.screen = 'moveCheck';
        return [START_CHECK];
      }
      this.screen = 'ready';
    } else if ((this.screen === 'ready' || this.screen === 'moveCheck' || this.screen === 'laneSetup') && !p.calibrated) {
      // The calibration went away under the check (a recalibration from the monitor, say):
      // there is nothing to measure against, so go back and offer it again afterwards. The lane
      // setup likewise starts again from the centre spot — spots are relative to the calibration.
      if (this.screen === 'laneSetup') this.pendingLanes = true;
      this.pendingCheck = this.screen === 'moveCheck' || (!this.pendingLanes && this.wantsCheck(false));
      this.screen = 'calibrating';
      this.recheck = false;
      this.cached = null;
    }
    if (this.screen === 'ready' && this.pendingLanes && p.calibrated) return this.enterLanes();
    return NONE as FlowEffect[];
  }

  private go(screen: FlowScreen): FlowEffect[] {
    if (screen === 'calibrating') this.pendingCheck = this.wantsCheck(false);
    this.screen = screen;
    return NONE as FlowEffect[];
  }

  /** Does a calibration that is not a recalibration lead into the check? */
  private wantsCheck(recalibrating: boolean): boolean {
    if (this.policy === 'skip') return false;
    if (this.policy === 'force') return true;
    return recalibrating || !this.seenCheck;
  }

  /** "Check my moves" on the ready screen: the check without a fresh calibration. */
  private checkMoves(): FlowEffect[] {
    if (this.screen !== 'ready' || !this.pose.calibrated || this.policy === 'skip') return NONE as FlowEffect[];
    this.pendingCheck = false;
    this.screen = 'moveCheck';
    this.cached = null;
    return [START_CHECK];
  }

  /**
   * "Set my lane spots". A calibrated full-body player goes straight in; one without a calibration
   * (or without a camera, from the menu) is walked there first and the setup opens when they arrive.
   * A run on screen is pinned down before the setup covers it.
   */
  private setLanes(): FlowEffect[] {
    const s = this.screen;
    if (s === 'laneSetup') return NONE as FlowEffect[];
    if (!this.cameraReady) {
      if (s !== 'menu') return NONE as FlowEffect[];
      this.pendingLanes = true;
      this.cached = null;
      return this.go('cameraPrompt');
    }
    if (s !== 'menu' && s !== 'ready' && s !== 'calibrating' && s !== 'playing') return NONE as FlowEffect[];
    // Small-room mode leans rather than standing somewhere: spots do not apply there.
    if (this.pose.calibrated && this.pose.mode !== 'full') return NONE as FlowEffect[];
    const fx: FlowEffect[] = this.mustPause() ? [{ type: 'pauseGame' }] : [];
    this.cached = null;
    if (this.pose.calibrated) {
      fx.push(...this.enterLanes());
      return fx;
    }
    this.pendingLanes = true;
    this.recheck = false;
    this.screen = 'calibrating';
    return fx;
  }

  /** Opens the setup for a calibrated player, if they are in full-body mode. */
  private enterLanes(): FlowEffect[] {
    this.pendingLanes = false;
    if (!this.pose.calibrated || this.pose.mode !== 'full') return NONE as FlowEffect[];
    this.screen = 'laneSetup';
    this.recheck = false;
    this.cached = null;
    return [START_LANES];
  }

  /**
   * Save or Cancel: back to where the setup was opened from. A run on screen (paused behind it)
   * is where they were; otherwise the ready screen, one raised hand from playing with the new lanes.
   */
  private lanesDone(): FlowEffect[] {
    this.cached = null;
    this.recheck = false;
    this.screen = this.gameState === 'menu' ? 'ready' : 'playing';
    return NONE as FlowEffect[];
  }

  /**
   * "START PLAYING" on the summary card: done with the check, straight into the run — the card
   * itself lists the start gesture, so there is nothing left for the ready screen to teach.
   * Without a calibration there is nothing to play with, so that falls back to the ready screen,
   * which the next pose frame turns into a fresh calibration.
   */
  private endCheck(): FlowEffect[] {
    this.recheck = false;
    this.cached = null;
    if (this.pose.calibrated) return this.play();
    this.screen = 'ready';
    return NONE as FlowEffect[];
  }

  /**
   * Back to the main menu from anywhere. The camera stays open, so a raised hand starts the next
   * run straight from the menu; the run on screen is abandoned without being scored.
   */
  private home(): FlowEffect[] {
    const running = this.gameState !== 'menu';
    if (this.screen === 'menu' && !running) return NONE as FlowEffect[];
    this.screen = 'menu';
    this.recheck = false;
    this.lossPaused = false;
    this.pendingLanes = false;
    this.cached = null;
    return running ? [HOME_GAME] : (NONE as FlowEffect[]);
  }

  private play(): FlowEffect[] {
    this.screen = 'playing';
    return [{ type: 'startGame' }];
  }

  /** Start from the menu or the summary without a full recalibration when the player is ready. */
  private quickStart(): FlowEffect[] {
    const p = this.pose;
    if (!p.calibrated) return this.go('calibrating');
    if (p.tracking) return this.play();
    this.recheck = true;
    return this.go('ready');
  }

  private openCamera(): FlowEffect[] {
    this.error = '';
    this.cameraReady = false;
    this.screen = 'cameraStarting';
    return [{ type: 'openCamera', cameraId: this.cameraId }];
  }

  private switchCamera(id: string): FlowEffect[] {
    if (id === this.cameraId && this.cameraReady) return NONE as FlowEffect[];
    this.cameraId = id;
    const fx: FlowEffect[] = [];
    if (this.mustPause()) fx.push({ type: 'pauseGame' });
    // On the menu the camera is a background service rather than a screen the player is looking
    // at: swap the stream where they stand instead of walking them back through the setup cards.
    if (this.screen === 'menu') {
      this.error = '';
      this.cameraReady = false;
      this.cached = null;
      fx.push({ type: 'openCamera', cameraId: id }, { type: 'recalibrate' });
      return fx;
    }
    fx.push(...this.openCamera(), { type: 'recalibrate' });
    return fx;
  }

  private cameraFailed(message: string): FlowEffect[] {
    this.cameraReady = false;
    this.error = message;
    this.pendingLanes = false;
    if (this.screen === 'menu') return NONE as FlowEffect[];
    const fx: FlowEffect[] = this.mustPause() ? [{ type: 'pauseGame' }] : [];
    this.screen = 'cameraError';
    return fx;
  }

  private toKeyboard(): FlowEffect[] {
    const fx: FlowEffect[] = [];
    if (this.cameraReady || this.screen === 'cameraStarting') fx.push({ type: 'stopCamera' });
    this.cameraReady = false;
    this.input = 'keyboard';
    this.recheck = false;
    this.pendingLanes = false;
    if (this.screen === 'menu' || this.screen === 'playing') return fx;
    fx.push(...this.play());
    return fx;
  }

  private recalibrate(before: FlowEffect[]): FlowEffect[] {
    if (!this.canCalibrate()) return NONE as FlowEffect[];
    const fx: FlowEffect[] = [];
    if (this.mustPause()) fx.push({ type: 'pauseGame' });
    fx.push(...before, { type: 'recalibrate' });
    this.recheck = false;
    // A recalibration (or a mode change) from inside the lane setup comes back to it afterwards,
    // from the centre spot: the old spots were taken against the calibration just thrown away.
    this.pendingLanes = this.screen === 'laneSetup';
    this.screen = 'calibrating';
    // Spec "Where it runs": the check always follows a recalibration.
    this.pendingCheck = this.wantsCheck(true);
    return fx;
  }

  private chooseMode(mode: ModeChoice): FlowEffect[] {
    if (mode === this.modeChoice) return NONE as FlowEffect[];
    this.modeChoice = mode;
    const force: FlowEffect = { type: 'setForcedMode', mode: mode === 'auto' ? null : mode };
    // Without a camera there is nothing to recalibrate yet; the forced mode applies to the next
    // calibration. Nor does a mode picked from the menu drag the player into one — they were
    // changing a setting, not asking to stand up and be measured.
    return this.screen !== 'menu' && this.canCalibrate() ? this.recalibrate([force]) : [force];
  }

  /**
   * A run is on screen and must be pinned down before an overlay takes over. A run paused by a
   * lost pose counts: it resumes the moment tracking is back (or the camera stops reporting it),
   * which would restart it behind the calibration or camera-error card.
   */
  private mustPause(): boolean {
    return this.screen === 'playing' && (running(this.gameState) || this.lossPaused);
  }

  /**
   * Calibration needs a running camera and a screen that can show it. The menu counts: the camera
   * is open there whenever permission was already granted, and "Redo the move check" in Settings
   * is reached from the menu more often than from anywhere else.
   */
  private canCalibrate(): boolean {
    const s = this.screen;
    return (
      this.cameraReady &&
      (s === 'menu' || s === 'calibrating' || s === 'ready' || s === 'moveCheck' || s === 'laneSetup' || s === 'playing')
    );
  }

  private build(): ScreenModel {
    const p = this.pose;
    const cal = p.calibration;
    const s = this.screen;
    const ready = s === 'ready' || (s !== 'calibrating' && p.calibrated);
    const body: CheckState = ready ? (this.recheck && !p.tracking ? 'bad' : 'ok') : cal.bodyVisible ? 'ok' : 'bad';
    const distance: CheckState = ready ? 'ok' : !cal.bodyVisible ? 'pending' : cal.distance === 'ok' ? 'ok' : 'bad';
    const light: CheckState = p.dark === undefined ? 'pending' : p.dark ? 'bad' : 'ok';

    let hint = '';
    if (body === 'bad') hint = 'Step into view';
    else if (distance === 'bad') hint = cal.distance === 'back' ? 'Step back — show your knees' : 'Come closer';
    else if (light === 'bad') hint = 'Too dark — turn on a light';

    let message = '';
    if (s === 'calibrating') message = hint ? '' : MSG_HOLD;
    else if (s === 'ready') message = !this.recheck ? MSG_CALIBRATED : p.tracking ? MSG_WELCOME_BACK : MSG_STEP_IN;

    const webcam = this.input === 'webcam';
    return {
      screen: s,
      input: this.input,
      error: this.error,
      cameraId: this.cameraId,
      modeChoice: this.modeChoice,
      detectedMode: p.mode,
      tracking: p.tracking,
      checks: { body, distance, light },
      hint,
      progress: ready ? 1 : cal.progress,
      message,
      startProgress: p.startProgress,
      recheck: this.recheck,
      playAgain: webcam && s === 'playing' && this.gameState === 'summary' ? MSG_PLAY_AGAIN : '',
      showRecalibrate: webcam && s === 'playing' && this.cameraReady,
      showMoveCheck: webcam && s === 'ready' && p.calibrated && this.policy !== 'skip',
      showLaneSetup: webcam && s === 'ready' && p.calibrated && p.mode === 'full',
      gameState: this.gameState,
    };
  }
}

function samePose(a: PoseSnapshot, b: PoseSnapshot): boolean {
  return (
    a.tracking === b.tracking &&
    a.calibrated === b.calibrated &&
    a.mode === b.mode &&
    a.startProgress === b.startProgress &&
    a.dark === b.dark &&
    a.calibration.progress === b.calibration.progress &&
    a.calibration.bodyVisible === b.calibration.bodyVisible &&
    a.calibration.distance === b.calibration.distance
  );
}

function copyPose(to: PoseSnapshot, from: PoseSnapshot): void {
  to.tracking = from.tracking;
  to.calibrated = from.calibrated;
  to.mode = from.mode;
  to.startProgress = from.startProgress;
  to.dark = from.dark;
  to.calibration.progress = from.calibration.progress;
  to.calibration.bodyVisible = from.calibration.bodyVisible;
  to.calibration.distance = from.calibration.distance;
}

/** Mode chip click order. */
export const nextMode = (m: ModeChoice): ModeChoice => (m === 'auto' ? 'full' : m === 'full' ? 'small' : 'auto');
