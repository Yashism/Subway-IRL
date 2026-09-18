import { describe, expect, it } from 'vitest';
import { SessionFlow, type FlowEffect, type FlowOptions } from '../../src/app/flow';
import { AppLoop, type LoopPose, type LoopTelemetry } from '../../src/app/loop';
import type { RuntimeStatus } from '../../src/app/poseRuntime';
import { Autopilot } from '../../src/game/autopilot';
import { Game, type GameEvent } from '../../src/game/game';
import type { ActivityStatus, CommandSource, GameCommand } from '../../src/input/commands';
import { emptyPoseStatus } from '../../src/input/poseSource';
import { KeyboardInput } from '../../src/input/keyboard';
import { EMPTY_TRACK } from '../helpers/poseDrive';

const DT = 1 / 60;

/** A pose command source the test fills directly. */
class FakePoseCommands implements CommandSource {
  queue: GameCommand[] = [];
  act: ActivityStatus = { tracksJogging: true, msSinceStep: 0, cadenceSpm: 150, steps: 0, squatting: false, lost: false };
  drain(): GameCommand[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }
  activity(): ActivityStatus {
    return { ...this.act };
  }
}

class FakePose implements LoopPose {
  readonly commands = new FakePoseCommands();
  running = true;
  backend = 'fake';
  ctrl = { baseline: null };
  st: RuntimeStatus = { ...emptyPoseStatus(), dark: false };
  isDark = false;
  status(): RuntimeStatus {
    return this.st;
  }
  dark(): boolean {
    return this.isDark;
  }
}

class Recorder implements LoopTelemetry {
  log: string[] = [];
  statuses = 0;
  games: number[] = [];
  commands(c: readonly GameCommand[], source: string): void {
    if (c.length) this.log.push(`${source}:${c.map((x) => x.type).join(',')}`);
  }
  gameEvents(e: readonly GameEvent[]): void {
    for (const x of e) if (x.type === 'state') this.log.push(`state:${x.state}`);
  }
  game(_g: Game, idleMs: number): void {
    this.games.push(idleMs);
  }
  status(): void {
    this.statuses++;
  }
}

interface SetupExtras {
  /** A cinematic that takes the flow's `startGame` (the intro). */
  hold?: () => boolean;
}

function setup(flowOpts: FlowOptions, withPose = true, autopilot = false, extra: SetupExtras = {}) {
  const game = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY_TRACK });
  // Returning player by default: the move check between calibration and ready has its own tests.
  const flow = new SessionFlow({ moveCheckSeen: true, ...flowOpts });
  const keyboard = new KeyboardInput();
  const pose = withPose ? new FakePose() : null;
  const tel = new Recorder();
  const effects: FlowEffect[] = [];
  const loop = new AppLoop({
    game,
    flow,
    keyboard,
    pose,
    telemetry: tel,
    autopilot: autopilot ? new Autopilot(game) : null,
    onEffect: (fx) => effects.push(fx),
    holdStart: extra.hold,
    onSkip: () => skips.push(loop.holdingStart),
  });
  const skips: boolean[] = [];
  let now = 0;
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += 1000 / 60;
      loop.beginFrame();
      loop.step(DT, now);
      loop.endFrame(now);
    }
  };
  const key = (code: string) => keyboard.keyDown({ code }, now);
  /** Webcam flow: Enter twice opens the camera; the test answers cameraOk. */
  const openCamera = () => {
    key('Enter');
    frame();
    key('Enter');
    frame();
    expect(effects.at(-1)).toEqual({ type: 'openCamera', cameraId: null });
    loop.dispatch({ type: 'cameraOk' });
  };
  return { game, flow, keyboard, pose: pose!, tel, effects, loop, frame, key, openCamera, skips, now: () => now };
}

describe('AppLoop: keyboard mode', () => {
  it('Enter starts the countdown in the same step and the flow moves to playing', () => {
    const r = setup({ input: 'keyboard' });
    r.key('Enter');
    r.frame();
    expect(r.flow.screen).toBe('playing');
    expect(r.game.state).toBe('countdown');
    expect(r.tel.log).toEqual(['keyboard:start', 'state:countdown']);
  });

  it('keyboard start passes through once playing: pause, resume, play again', () => {
    const r = setup({ input: 'keyboard' });
    r.key('Enter');
    r.frame(200);
    expect(r.game.state).toBe('playing');
    r.key('Escape');
    r.frame();
    expect(r.game.state).toBe('paused');
    expect(r.flow.model.gameState).toBe('paused');
    r.key('Enter');
    r.frame();
    expect(r.game.state).toBe('countdown');
  });

  it('ignores pose commands and pose activity (a lost pose never pauses keyboard play)', () => {
    const r = setup({ input: 'keyboard' });
    r.pose.commands.act.lost = true;
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.flow.screen).toBe('menu');
    expect(r.game.state).toBe('menu');
    r.key('Enter');
    r.frame(200);
    r.pose.commands.queue.push({ type: 'jump' });
    r.frame();
    expect(r.game.state).toBe('playing');
    expect(r.game.stats.jumps).toBe(0);
    expect(r.tel.statuses).toBe(0);
    expect(r.loop.status).toBeNull();
  });

  it('autopilot starts through the flow, so the menu card does not stay up', () => {
    const r = setup({ input: 'keyboard' }, false, true);
    r.frame();
    expect(r.flow.screen).toBe('playing');
    expect(r.game.state).toBe('countdown');
  });

  it('publishes a game snapshot with idle ms every frame', () => {
    const r = setup({ input: 'keyboard' });
    r.frame(3);
    expect(r.tel.games).toEqual([0, 0, 0]);
  });
});

describe('AppLoop: webcam mode', () => {
  it('Enter opens the explainer, then asks for the camera; Esc goes back', () => {
    const r = setup({ input: 'webcam' });
    r.key('Enter');
    r.frame();
    expect(r.flow.screen).toBe('cameraPrompt');
    r.key('Escape');
    r.frame();
    expect(r.flow.screen).toBe('menu');
    expect(r.game.state).toBe('menu');
    r.openCamera();
    expect(r.flow.screen).toBe('calibrating');
  });

  it('a pose start gesture on the ready screen starts the game; pose moves then drive it', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    expect(r.flow.screen).toBe('ready');
    const mark = r.tel.log.length;
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.flow.screen).toBe('playing');
    expect(r.game.state).toBe('countdown');
    expect(r.tel.log.slice(mark)).toEqual(['pose:start', 'state:countdown']);
    r.frame(200);
    r.pose.commands.queue.push({ type: 'jump' });
    r.frame();
    expect(r.game.stats.jumps).toBe(1);
    expect(r.tel.statuses).toBeGreaterThan(0);
  });

  it('a pose start during play is dropped, never sent to the game', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    expect(r.game.state).toBe('playing');
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.game.state).toBe('playing');
  });

  it('a lost pose pauses; a start gesture is ignored until the pose returns by itself', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    r.pose.commands.act.lost = true;
    r.frame();
    expect(r.game.state).toBe('paused');
    expect(r.game.pausedByLoss).toBe(true);
    const sent: string[] = [];
    const step = r.game.step.bind(r.game);
    r.game.step = (dt, cmds, a) => {
      sent.push(...cmds.map((c) => c.type));
      return step(dt, cmds, a);
    };
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.game.state).toBe('paused');
    expect(sent).toEqual([]);
    r.pose.commands.act.lost = false;
    r.frame();
    expect(r.game.state).toBe('countdown');
  });

  it('a start gesture resumes a manual (Esc) pause', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    r.key('Escape');
    r.frame();
    expect(r.game.state).toBe('paused');
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.game.state).toBe('countdown');
  });

  it('recalibrating mid-run pauses the game, tells the flow, and forwards the camera effect', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    r.loop.dispatch({ type: 'recalibrate' });
    expect(r.game.state).toBe('paused');
    expect(r.flow.model.gameState).toBe('paused');
    expect(r.flow.screen).toBe('calibrating');
    expect(r.effects.at(-1)).toEqual({ type: 'recalibrate' });
    expect(r.tel.log.at(-1)).toBe('state:paused');
  });

  it('switching to the keyboard mid-run stops pose activity from pausing the game', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    r.loop.dispatch({ type: 'useKeyboard' });
    expect(r.effects.at(-1)).toEqual({ type: 'stopCamera' });
    r.pose.commands.act.lost = true;
    r.frame(10);
    expect(r.game.state).toBe('playing');
  });

  it('start gestures work again after a loss-pause has resumed', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    expect(r.game.state).toBe('playing');
    // Out of frame and back: the game pauses and resumes itself.
    r.pose.commands.act.lost = true;
    r.frame();
    expect(r.game.state).toBe('paused');
    r.pose.commands.act.lost = false;
    r.frame(200);
    expect(r.game.state).toBe('playing');
    // The run ends (the player stopped jogging) and the raised hand must still start a new one.
    r.pose.commands.act.msSinceStep = 5000;
    r.frame(600);
    expect(r.game.state).toBe('summary');
    r.pose.commands.act.msSinceStep = 0;
    r.pose.commands.queue.push({ type: 'start' });
    r.frame(2);
    expect(r.game.state).toBe('countdown');
  });

  it('a start gesture resumes a manual pause taken while the pose was lost', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    r.pose.commands.act.lost = true;
    r.frame();
    expect(r.game.pausedByLoss).toBe(true);
    // Esc while paused-by-loss makes it a real pause: the returning pose must not resume the run.
    r.loop.pauseGame();
    expect(r.game.pausedByLoss).toBe(false);
    r.pose.commands.act.lost = false;
    r.frame(10);
    expect(r.game.state).toBe('paused');
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.game.state).toBe('countdown');
  });

  it('recalibrating while paused-by-loss keeps the run paused behind the calibration screen', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    r.pose.commands.act.lost = true;
    r.frame();
    expect(r.game.state).toBe('paused');
    expect(r.game.pausedByLoss).toBe(true);
    r.loop.dispatch({ type: 'recalibrate' });
    expect(r.flow.screen).toBe('calibrating');
    expect(r.effects.at(-1)).toEqual({ type: 'recalibrate' });
    // Tracking comes back during calibration: the run must not restart behind the overlay.
    r.pose.commands.act.lost = false;
    r.pose.st.calibrated = false;
    r.frame(200);
    expect(r.game.state).toBe('paused');
    expect(r.game.pausedByLoss).toBe(false);
  });

  it('a camera failure while paused-by-loss keeps the run paused behind the error screen', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(200);
    r.pose.commands.act.lost = true;
    r.frame();
    expect(r.game.state).toBe('paused');
    r.loop.dispatch({ type: 'cameraFailed', message: 'Camera unplugged' });
    expect(r.flow.screen).toBe('cameraError');
    // With the camera gone nothing reports a lost pose any more, which used to resume the run.
    r.pose.commands.act.lost = false;
    r.frame(200);
    expect(r.game.state).toBe('paused');
  });

  it('a camera that starts after the error screen is shown moves the flow on', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.loop.dispatch({ type: 'cameraFailed', message: 'boom' });
    expect(r.flow.screen).toBe('cameraError');
    r.loop.dispatch({ type: 'cameraOk' });
    expect(r.flow.screen).toBe('calibrating');
    expect(r.flow.cameraReady).toBe(true);
  });

  it('flags a stalled camera and passes darkness to the flow', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.lastFrameT = r.now();
    r.pose.isDark = true;
    r.frame();
    expect(r.loop.stalled).toBe(false);
    expect(r.flow.model.checks.light).toBe('bad');
    r.frame(61);
    expect(r.loop.stalled).toBe(true);
  });
});

describe('AppLoop: the move check', () => {
  /** A first-ever calibration: the flow routes into the move check before the ready screen. */
  function firstRun() {
    const r = setup({ input: 'webcam', moveCheckSeen: false });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    return r;
  }

  it('hands startMoveCheck to the page, which is what builds the check', () => {
    const r = firstRun();
    expect(r.flow.screen).toBe('moveCheck');
    expect(r.effects.at(-1)).toEqual({ type: 'startMoveCheck' });
  });

  it('Enter finishes the check, tears it down and starts the run in one press', () => {
    const r = firstRun();
    r.key('Enter');
    r.frame();
    expect(r.flow.screen).toBe('playing');
    expect(r.effects.at(-1)).toEqual({ type: 'endMoveCheck' });
    expect(r.game.state).toBe('countdown');
  });

  it('Esc leaves the check for the menu, tearing it down on the way', () => {
    const r = firstRun();
    r.key('Escape');
    r.frame();
    expect(r.flow.screen).toBe('menu');
    expect(r.effects.at(-1)).toEqual({ type: 'endMoveCheck' });
  });

  it('a pose start gesture never drops the check (the hoverboard step is both hands up)', () => {
    const r = firstRun();
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.flow.screen).toBe('moveCheck');
    expect(r.game.state).toBe('menu');
  });

  it('recalibrating mid-run pauses the run before the check takes the screen', () => {
    const r = setup({ input: 'webcam' });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    r.key('Enter');
    r.frame(240);
    expect(r.game.state).toBe('playing');
    r.loop.dispatch({ type: 'recalibrate' });
    expect(r.game.state).toBe('paused');
    r.frame();
    expect(r.flow.screen).toBe('moveCheck');
    expect(r.effects.at(-1)).toEqual({ type: 'startMoveCheck' });
    // Still paused behind the check's scrim, not restarted.
    expect(r.game.state).toBe('paused');
  });
});

describe('AppLoop: Home', () => {
  /** A live keyboard run, a few seconds in. */
  function running() {
    const r = setup({ input: 'keyboard' });
    r.key('Enter');
    r.frame(240);
    expect(r.game.state).toBe('playing');
    return r;
  }

  it('abandons the run and reports the state change like a step would', () => {
    const r = running();
    const mark = r.tel.log.length;
    r.loop.dispatch({ type: 'home' });
    expect(r.game.state).toBe('menu');
    expect(r.flow.screen).toBe('menu');
    expect(r.flow.model.gameState).toBe('menu');
    // The run never passes through `summary`, which is what keeps it off the profile.
    expect(r.tel.log.slice(mark)).toEqual(['state:menu']);
  });

  it('never routes the abandoned run through the summary that records it', () => {
    const states: string[] = [];
    const r = setup({ input: 'keyboard' });
    // The same hook main.ts records a run from.
    const loop = new AppLoop({
      game: r.game,
      flow: r.flow,
      keyboard: new KeyboardInput(),
      onGameEvent: (e) => {
        if (e.type === 'state') states.push(e.state);
      },
    });
    loop.dispatch({ type: 'startPressed' });
    loop.beginFrame();
    loop.step(DT, 16);
    loop.dispatch({ type: 'home' });
    expect(states).toContain('menu');
    expect(states).not.toContain('summary');
  });

  it('starts a fresh run straight afterwards', () => {
    const r = running();
    r.loop.dispatch({ type: 'home' });
    const mark = r.tel.log.length;
    r.key('Enter');
    r.frame(240);
    expect(r.flow.screen).toBe('playing');
    expect(r.game.state).toBe('playing');
    // A whole new run, counted down from the top — not the abandoned one resumed.
    expect(r.tel.log.slice(mark)).toEqual(['keyboard:start', 'state:countdown', 'state:playing']);
  });

  it('leaves a live move check behind it', () => {
    const r = setup({ input: 'webcam', moveCheckSeen: false });
    r.openCamera();
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.frame();
    expect(r.flow.screen).toBe('moveCheck');
    r.loop.dispatch({ type: 'home' });
    expect(r.flow.screen).toBe('menu');
    expect(r.effects.at(-1)).toEqual({ type: 'endMoveCheck' });
  });

  it('does nothing when there is no run and the menu is already showing', () => {
    const r = setup({ input: 'keyboard' });
    r.loop.dispatch({ type: 'home' });
    expect(r.game.state).toBe('menu');
    expect(r.tel.log).toEqual([]);
  });
});

describe('AppLoop: a cinematic holding the run back (the intro)', () => {
  it('takes the flow\u2019s startGame instead of queueing the run', () => {
    const r = setup({ input: 'keyboard' }, false, false, { hold: () => true });
    r.key('Enter');
    r.frame(3);
    expect(r.flow.screen).toBe('playing');
    // The flow has moved on, but nothing has started: the cinematic owes us a queueStart().
    expect(r.game.state).toBe('menu');
    expect(r.loop.holdingStart).toBe(true);
  });

  it('swallows every further start while it holds, and reports each as a skip', () => {
    const r = setup({ input: 'keyboard' }, false, false, { hold: () => true });
    r.key('Enter');
    r.frame();
    r.key('Enter');
    r.key('Enter');
    r.frame(2);
    expect(r.game.state).toBe('menu');
    expect(r.skips.length).toBe(2);
    // The skip is reported while the hold is still on, so a handler can act on it.
    expect(r.skips.every(Boolean)).toBe(true);
  });

  it('a raised hand under the cinematic skips it rather than starting a run', () => {
    const r = setup({ input: 'webcam' }, true, false, { hold: () => true });
    r.pose.st.calibrated = true;
    r.pose.st.tracking = true;
    r.openCamera();
    r.frame();
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.flow.screen).toBe('playing');
    expect(r.game.state).toBe('menu');
    r.pose.commands.queue.push({ type: 'start' });
    r.frame();
    expect(r.skips.length).toBe(1);
    expect(r.game.state).toBe('menu');
  });

  it('queueStart releases exactly one run, and the hold is over', () => {
    const r = setup({ input: 'keyboard' }, false, false, { hold: () => true });
    r.key('Enter');
    r.frame();
    r.loop.queueStart();
    expect(r.loop.holdingStart).toBe(false);
    r.frame();
    expect(r.game.state).toBe('countdown');
    // The next Enter is an ordinary one again: it passes through to the running game.
    r.key('Enter');
    r.frame();
    expect(r.skips.length).toBe(0);
  });

  it('holdStart returning false leaves the old behaviour untouched', () => {
    const r = setup({ input: 'keyboard' }, false, false, { hold: () => false });
    r.key('Enter');
    r.frame();
    expect(r.game.state).toBe('countdown');
    expect(r.loop.holdingStart).toBe(false);
  });
});
