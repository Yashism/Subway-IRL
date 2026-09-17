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

function setup(flowOpts: FlowOptions, withPose = true, autopilot = false) {
  const game = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY_TRACK });
  const flow = new SessionFlow(flowOpts);
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
  });
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
  return { game, flow, keyboard, pose: pose!, tel, effects, loop, frame, key, openCamera, now: () => now };
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
