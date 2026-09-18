/**
 * The page's ledger, headless: AppLoop + SessionFlow + Game + RunSession + IntroRunner, wired the
 * way main.ts wires them, driven by the keyboard.
 *
 * This is the test that guards the rulings the three feature modules depend on and that only the
 * app layer can get wrong: a run is banked once and only once, a demo banks nothing, the intro
 * holds the run back and releases it, and the daily challenge pins the track.
 */
import { describe, expect, it } from 'vitest';
import { SessionFlow } from '../../src/app/flow';
import { IntroRunner, type IntroStage } from '../../src/app/intro';
import { AppLoop } from '../../src/app/loop';
import { ProfileStore } from '../../src/app/profile';
import { ProgressionStore } from '../../src/app/progression';
import { RunSession } from '../../src/app/session';
import { Game } from '../../src/game/game';
import { KeyboardInput } from '../../src/input/keyboard';
import { EMPTY_TRACK } from '../helpers/poseDrive';

const HZ = 60;
const DT = 1 / HZ;
const NOW = () => Date.UTC(2026, 8, 18, 9);

/** A stand-in for WorldView's intro: it plays for four seconds of the caller's clock. */
function fakeStage(duration = 4.2) {
  let t = 0;
  let cut = false;
  const stage: IntroStage<Game> & { ends: number; starts: number } = {
    starts: 0,
    ends: 0,
    get introBeat() {
      return Math.min(4, Math.floor(t / (duration / 4)) + 1);
    },
    startIntro() {
      stage.starts++;
      t = 0;
      cut = false;
    },
    advanceIntro(dt) {
      t += dt;
      return !cut && t < duration;
    },
    renderIntro() {},
    skipIntro() {
      cut = true;
    },
    endIntro() {
      stage.ends++;
    },
  };
  return stage;
}

function page(o: { saveRuns?: boolean; intro?: boolean } = {}) {
  const game = new Game({ seed: 11, difficulty: 'cardio', chunks: EMPTY_TRACK });
  const flow = new SessionFlow({ input: 'keyboard', moveCheckSeen: true });
  const keyboard = new KeyboardInput();
  const progression = new ProgressionStore(null);
  const profile = new ProfileStore(null);
  const runs = new RunSession({ progression, profile, saveRuns: o.saveRuns, now: NOW });
  const stage = fakeStage();
  const summaries: number[] = [];
  let wantIntro = o.intro ?? false;

  const intro = new IntroRunner<Game>({ stage, onEnd: () => loop.queueStart() });
  const loop: AppLoop = new AppLoop({
    game,
    flow,
    keyboard,
    holdStart: () => {
      if (!wantIntro || intro.played) return false;
      intro.begin();
      return true;
    },
    onSkip: () => intro.skip(),
    onGameEvent: (e) => {
      if (e.type !== 'state') return;
      if (e.state === 'countdown') runs.beginRun();
      else if (e.state === 'summary') {
        summaries.push(summaries.length);
        runs.endRun({ difficulty: 'cardio', seed: game.options.seed, input: 'keyboard' }, game.caughtReason);
      } else if (e.state === 'menu') runs.abandonRun();
      runs.event(e);
    },
  });

  let now = 0;
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += 1000 / HZ;
      // main.ts's order: the cinematic advances first, so the handover and the countdown share a frame.
      intro.advance(DT, game);
      loop.beginFrame();
      loop.step(DT, now);
      loop.endFrame(now);
      runs.frame(game, DT);
    }
  };
  const key = (code: string) => keyboard.keyDown({ code }, now);
  /** Jog for `seconds`, then stand still until the TT gets you and the summary lands. */
  const fullRun = (seconds = 6) => {
    keyboard.jogEnabled = true;
    key('KeyJ');
    key('Enter');
    frame(Math.round(seconds * HZ));
    keyboard.keyUp({ code: 'KeyJ' }, now);
    for (let i = 0; i < HZ * 60 && game.state !== 'summary'; i++) frame();
    expect(game.state).toBe('summary');
  };
  return { game, flow, keyboard, progression, profile, runs, loop, intro, stage, summaries, frame, key, fullRun, forceIntro: (v: boolean) => (wantIntro = v) };
}

describe('the page ledger: banking a run', () => {
  it('a full run banks its coins, its profile row and its mission progress exactly once', () => {
    const p = page();
    p.fullRun();
    expect(p.summaries.length).toBe(1);
    expect(p.profile.profile.totalRuns).toBe(1);
    const banked = p.progression.balance;
    const score = p.progression.state.lifetimeScore;
    expect(score).toBe(Math.floor(p.game.stats.score));

    // Sitting on the summary for another second must not bank it again.
    p.frame(HZ);
    expect(p.profile.profile.totalRuns).toBe(1);
    expect(p.progression.balance).toBe(banked);
    expect(p.progression.state.lifetimeScore).toBe(score);
  });

  it('two runs bank twice, and the second starts from a clean set of counters', () => {
    const p = page();
    p.fullRun(4);
    const first = p.profile.profile.history[0].distance;
    p.fullRun(4);
    expect(p.profile.profile.totalRuns).toBe(2);
    expect(p.profile.profile.history[0].distance).toBeGreaterThan(0);
    expect(p.profile.profile.history[0].distance).not.toBe(first + first);
  });

  it('Home during a run abandons it: no row, no coins, no mission progress', () => {
    const p = page();
    p.keyboard.jogEnabled = true;
    p.key('KeyJ');
    p.key('Enter');
    p.frame(HZ * 5);
    const before = JSON.stringify(p.progression.state);
    p.loop.dispatch({ type: 'home' });
    p.frame(HZ);
    expect(p.game.state).toBe('menu');
    expect(p.summaries.length).toBe(0);
    expect(p.profile.profile.totalRuns).toBe(0);
    expect(JSON.stringify(p.progression.state)).toBe(before);
  });

  it('a demo run (autopilot / replay) reaches the summary and banks nothing', () => {
    const p = page({ saveRuns: false });
    p.fullRun();
    expect(p.summaries.length).toBe(1);
    expect(p.profile.profile.totalRuns).toBe(0);
    expect(p.progression.balance).toBe(0);
    expect(p.progression.state.lifetimeScore).toBe(0);
  });
});

describe('the page ledger: the daily challenge', () => {
  it('pins the track to the challenge seed, and marks only that run as an attempt', () => {
    const p = page();
    const challenge = p.runs.daily.challenge;
    p.game.options.seed = challenge.seed - p.game.runsStarted;
    p.runs.armDaily();
    p.fullRun(5);
    // The track the run actually used is the challenge's own seed.
    expect(p.profile.profile.history[0].seed).toBe(challenge.seed);
    expect(p.progression.state.daily.day).toBe('2026-09-18');
    expect(p.progression.state.daily.best).toBeGreaterThan(0);

    // The next run is ordinary: it must not move the daily's best.
    const best = p.progression.state.daily.best;
    p.game.options.seed = 11;
    p.fullRun(9);
    expect(p.progression.state.daily.best).toBe(best);
  });
});

describe('the page ledger: the intro cinematic', () => {
  it('holds the run back, plays out, and lands in the countdown with nothing banked yet', () => {
    const p = page({ intro: true });
    p.keyboard.jogEnabled = true;
    p.key('KeyJ');
    p.key('Enter');
    p.frame();
    expect(p.stage.starts).toBe(1);
    expect(p.loop.holdingStart).toBe(true);
    expect(p.game.state).toBe('menu');

    // Four seconds of cinema, then the run begins on the very frame after the handover.
    p.frame(Math.round(4.2 * HZ) + 1);
    expect(p.stage.ends).toBe(1);
    expect(p.intro.playing).toBe(false);
    p.frame();
    expect(p.game.state).toBe('countdown');
    expect(p.profile.profile.totalRuns).toBe(0);
  });

  it('plays once per session: the second run goes straight to the countdown', () => {
    const p = page({ intro: true });
    p.keyboard.jogEnabled = true;
    p.key('KeyJ');
    p.key('Enter');
    p.frame(Math.round(4.2 * HZ) + 3);
    expect(p.game.state).toBe('countdown');
    p.keyboard.keyUp({ code: 'KeyJ' }, 0);
    for (let i = 0; i < HZ * 60 && p.game.state !== 'summary'; i++) p.frame();

    p.key('KeyJ');
    p.key('Enter');
    p.frame(2);
    expect(p.stage.starts).toBe(1);
    expect(p.game.state).toBe('countdown');
  });

  it('skips at any beat into the same countdown, once', () => {
    for (const beatAt of [0, 1.3, 2.5, 3.6]) {
      const p = page({ intro: true });
      p.keyboard.jogEnabled = true;
      p.key('KeyJ');
      p.key('Enter');
      p.frame(Math.max(1, Math.round(beatAt * HZ)));
      expect(p.intro.playing).toBe(true);
      // Enter again: the loop swallows the start and turns it into a skip.
      p.key('Enter');
      p.frame(3);
      expect(p.stage.ends).toBe(1);
      expect(p.game.state).toBe('countdown');
      expect(p.summaries.length).toBe(0);
    }
  });
});
