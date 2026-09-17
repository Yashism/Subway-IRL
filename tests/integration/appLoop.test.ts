import { describe, expect, it } from 'vitest';
import { SessionFlow, type FlowScreen } from '../../src/app/flow';
import { AppLoop } from '../../src/app/loop';
import { PoseRuntime } from '../../src/app/poseRuntime';
import { TUNING } from '../../src/game/config';
import { Game, type GameState } from '../../src/game/game';
import { lengthOf, type ObstacleSpec } from '../../src/game/obstacles';
import { KeyboardInput } from '../../src/input/keyboard';
import type { PoseSource } from '../../src/pose/poseSource';
import type { PoseFrame } from '../../src/pose/types';
import { EMPTY_TRACK } from '../helpers/poseDrive';
import { jogParams, jumpArc, Scenario, STAND } from '../helpers/synth';

const T = STAND.torso;
const HZ = 60;
const COUNTDOWN_MS = TUNING.countdownSeconds * 1000;

/** A replay the test clock feeds: every frame due by `now` is emitted before a game step. */
class ClockSource implements PoseSource {
  readonly backend = 'test-clock';
  private onFrame: ((f: PoseFrame) => void) | null = null;
  private next = 0;
  constructor(private readonly frames: PoseFrame[]) {}
  async start(onFrame: (f: PoseFrame) => void): Promise<void> {
    this.onFrame = onFrame;
  }
  stop(): void {
    this.onFrame = null;
  }
  feed(now: number): void {
    while (this.next < this.frames.length && this.frames[this.next].t <= now + 1e-6) this.onFrame?.(this.frames[this.next++]);
  }
}

/**
 * The game page's glue, headless: SessionFlow + PoseRuntime (real PoseController and
 * PoseCommandSource) + AppLoop, stepped exactly like main.ts (beginFrame, step, endFrame with
 * one shared ms clock). The pose timeline is a synthetic Scenario on that clock.
 */
function page(sc: Scenario) {
  const game = new Game({ seed: 1, difficulty: 'cardio', chunks: EMPTY_TRACK });
  const flow = new SessionFlow({ input: 'webcam' });
  const source = new ClockSource(sc.frames);
  const runtime = new PoseRuntime({ replay: async () => source, replayName: 'synth' });
  const keyboard = new KeyboardInput();
  let opening: Promise<void> | null = null;
  const loop: AppLoop = new AppLoop({
    game,
    flow,
    keyboard,
    pose: runtime,
    onEffect: (fx) => {
      if (fx.type === 'openCamera') {
        opening = runtime.start(fx.cameraId).then((ok) => {
          if (ok) loop.dispatch({ type: 'cameraOk' });
        });
      }
      if (fx.type === 'recalibrate') runtime.recalibrate();
    },
  });
  const screens: FlowScreen[] = [flow.screen];
  const states: GameState[] = [];
  let now = 0;
  let steps = 0;
  const run = (untilMs: number) => {
    while ((steps + 1) * (1000 / HZ) <= untilMs + 1e-6) {
      now = ++steps * (1000 / HZ);
      source.feed(now);
      loop.beginFrame();
      loop.step(1 / HZ, now);
      for (const e of loop.frameEvents) if (e.type === 'state') states.push(e.state);
      loop.endFrame(now);
      if (screens.at(-1) !== flow.screen) screens.push(flow.screen);
    }
  };
  const place = (spec: ObstacleSpec) =>
    game.track.obstacles.push({ id: 90_000 + game.track.obstacles.length, kind: spec.kind, lane: spec.lane, length: lengthOf(spec), front: spec.s });
  return {
    game,
    flow,
    runtime,
    keyboard,
    screens,
    states,
    run,
    place,
    opened: () => opening,
    get now() {
      return now;
    },
  };
}

/** Enter (explainer), Enter (use webcam), then the replay "camera" opens. */
async function openCamera(p: ReturnType<typeof page>) {
  p.keyboard.keyDown({ code: 'Enter' }, p.now);
  p.run(p.now + 20);
  p.keyboard.keyDown({ code: 'Enter' }, p.now);
  p.run(p.now + 20);
  await p.opened();
}

/**
 * Stand to calibrate (2.5 s), raise the right hand (1.6 s), jog through the countdown and
 * 1 s of play, then `extra` more pose timeline.
 */
function timeline(extra: (sc: Scenario) => void = () => {}): Scenario {
  const sc = new Scenario(30);
  sc.t = 100; // the camera opens ~2 frames in
  sc.hold(2500).hold(1600, { arms: 'right-up' });
  const t0 = sc.t;
  sc.add(COUNTDOWN_MS + 1000, (t) => jogParams(t0 + t));
  extra(sc);
  return sc;
}

describe('game page glue: calibrate → start gesture → play → jump', () => {
  it('walks the webcam flow and a raised hand starts the run', async () => {
    const sc = timeline();
    const p = page(sc);
    await openCamera(p);
    expect(p.flow.screen).toBe('calibrating');
    expect(p.runtime.running).toBe(true);

    p.run(2700);
    expect(p.flow.screen).toBe('ready');
    expect(p.game.state).toBe('menu');

    p.run(sc.t);
    expect(p.screens).toEqual(['menu', 'cameraPrompt', 'cameraStarting', 'calibrating', 'ready', 'playing']);
    expect(p.states).toEqual(['countdown', 'playing']);
    expect(p.game.s).toBeGreaterThan(0);
  });

  it('a real hip-arc jump while jogging clears a barrier; the same run without it crashes', async () => {
    const LEAD_MS = 350;
    const build = (jump: boolean) =>
      timeline((sc) => {
        const t0 = sc.t;
        sc.add(500, (t) => {
          const j = jogParams(t0 + t);
          return jump ? { ...j, hipY: j.hipY - jumpArc(t, 500, 0.4) * T } : j;
        });
        const t1 = sc.t;
        sc.add(1500, (t) => jogParams(t1 + t));
      });

    const results = [];
    for (const jump of [false, true]) {
      const sc = build(jump);
      const p = page(sc);
      await openCamera(p);
      const moveAt = 100 + 2500 + 1600 + COUNTDOWN_MS + 1000;
      p.run(moveAt);
      expect(p.game.state).toBe('playing');
      p.place({ kind: 'barrierLow', lane: p.game.runner.lane, s: p.game.s + (p.game.speed * LEAD_MS) / 1000 });
      p.run(sc.t);
      results.push({ jump, state: p.game.state, states: [...p.states], jumps: p.game.stats.jumps, reason: p.game.caughtReason });
    }
    expect(results[0].states).toContain('caught');
    expect(results[0].reason).toBe('crash');
    expect(results[1].state).toBe('playing');
    expect(results[1].jumps).toBe(1);
  });

  it('walking out of view pauses the run; coming back resumes it without a gesture', async () => {
    const sc = timeline((s) => {
      s.hold(2000, null);
      const t0 = s.t;
      s.add(COUNTDOWN_MS + 1000, (t) => jogParams(t0 + t));
    });
    const p = page(sc);
    await openCamera(p);
    p.run(sc.t);
    expect(p.states).toEqual(['countdown', 'playing', 'paused', 'countdown', 'playing']);
    expect(p.game.state).toBe('playing');
    expect(p.flow.screen).toBe('playing');
  });
});
