import { describe, expect, it } from 'vitest';
import { ProfileStore } from '../../src/app/profile';
import { ProgressionStore, DEFAULT_CHARACTER } from '../../src/app/progression';
import { RunSession } from '../../src/app/session';
import type { ChunkDef } from '../../src/game/chunks';
import { TUNING } from '../../src/game/config';
import { Game } from '../../src/game/game';
import type { ActivityStatus } from '../../src/input/commands';

const EMPTY: ChunkDef[] = [{ id: 'empty', tier: 0, obstacles: [], coins: [] }];
const DT = 1 / 60;
/** Jogging: the idle clock stays at 'ok', so a run only ends when the test stops feeding steps. */
const JOGGING: ActivityStatus = { tracksJogging: true, msSinceStep: 0, cadenceSpm: 165, steps: 0, squatting: false, lost: false };
const STILL: ActivityStatus = { ...JOGGING, msSinceStep: 60_000, cadenceSpm: 0 };

function setup(o: { saveRuns?: boolean } = {}) {
  const game = new Game({ seed: 4, difficulty: 'cardio', chunks: EMPTY });
  const progression = new ProgressionStore(null);
  const profile = new ProfileStore(null);
  const runs = new RunSession({ progression, profile, saveRuns: o.saveRuns, now: () => Date.UTC(2026, 8, 18, 9) });

  let steps = 0;
  /** One frame, wired exactly the way main.ts wires it: state events first, then the sample. */
  const frame = (activity: ActivityStatus, commands: { type: string }[] = []) => {
    steps++;
    const events = game.step(DT, commands as never, { ...activity, steps: Math.floor(steps / 20) });
    for (const e of events) {
      if (e.type === 'state' && e.state === 'countdown') {
        // main.ts's own hook, verbatim: the boosts are spent here and applied to this run.
        if (runs.beginRun().magnet) game.powerups.activate('magnet');
      } else if (e.type === 'state' && e.state === 'menu') runs.abandonRun();
      runs.event(e);
    }
    runs.frame(game, DT);
    return events;
  };
  const play = (seconds: number, activity: ActivityStatus = JOGGING) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) frame(activity);
  };
  /** Start, run for a while, then stand still until the TT gets you and the summary arrives. */
  const fullRun = (seconds = 6) => {
    frame(JOGGING, [{ type: 'start' }]);
    play(seconds);
    for (let i = 0; i < 60 * 40 && game.state !== 'summary'; i++) frame(STILL);
    expect(game.state).toBe('summary');
  };
  const end = () => runs.endRun({ difficulty: 'cardio', seed: 4, input: 'webcam' }, game.caughtReason);
  return { game, progression, profile, runs, frame, play, fullRun, end };
}

describe('RunSession: banking a run', () => {
  it('banks the run once: the coins, the profile row and the mission progress all move exactly once', () => {
    const s = setup();
    s.fullRun();
    const picked = s.game.stats.coins;
    const result = s.end();

    expect(result.outcome).not.toBeNull();
    expect(result.outcome!.runCoins).toBe(picked);
    expect(s.profile.profile.totalRuns).toBe(1);
    const balance = s.progression.balance;
    expect(balance).toBeGreaterThanOrEqual(picked);

    // A second summary for the same run (a re-entered state, a double hook) must change nothing.
    const again = s.end();
    expect(again.outcome).toBeNull();
    expect(s.profile.profile.totalRuns).toBe(1);
    expect(s.progression.balance).toBe(balance);
  });

  it('records the distance and the steps the run actually produced', () => {
    const s = setup();
    s.fullRun(8);
    s.end();
    const row = s.profile.profile.history[0];
    expect(row.distance).toBeCloseTo(s.game.stats.distance, 5);
    expect(row.steps).toBe(s.game.stats.steps);
    // `timeSec` only advances while playing, so it is the active time the workout screen wants.
    expect(row.activeSeconds).toBeCloseTo(s.game.stats.timeSec, 5);
    expect(row.day).toBe('2026-09-18');
  });

  it('a run abandoned before the summary banks nothing', () => {
    const s = setup();
    s.frame(JOGGING, [{ type: 'start' }]);
    s.play(5);
    for (const e of s.game.toMenu()) {
      if (e.type === 'state' && e.state === 'menu') s.runs.abandonRun();
    }
    const result = s.end();
    expect(result.outcome).toBeNull();
    expect(s.profile.profile.totalRuns).toBe(0);
    expect(s.progression.balance).toBe(0);
  });

  it('a demo run (autopilot, replay) banks nothing at all, however far it gets', () => {
    const s = setup({ saveRuns: false });
    s.fullRun();
    expect(s.game.stats.coins).toBeGreaterThanOrEqual(0);
    const result = s.end();
    expect(result.outcome).toBeNull();
    expect(result.record).toBeNull();
    expect(s.profile.profile.totalRuns).toBe(0);
    expect(s.progression.balance).toBe(0);
    expect(s.progression.state.missions.active.length).toBe(0);
  });
});

describe('RunSession: the daily challenge', () => {
  it('only the run that was armed is scored against today, and the arming is used up', () => {
    const s = setup();
    expect(s.runs.dailyArmed).toBe(false);
    s.runs.armDaily();
    expect(s.runs.dailyArmed).toBe(true);
    s.fullRun();
    expect(s.runs.dailyArmed).toBe(false);
    expect(s.end().daily).toBe(true);

    // The next run is an ordinary one again.
    s.fullRun();
    expect(s.end().daily).toBe(false);
  });

  it('gives the same challenge all day and a different one tomorrow', () => {
    const today = setup().runs.daily.challenge;
    const progression = new ProgressionStore(null);
    const tomorrow = new RunSession({
      progression,
      profile: new ProfileStore(null),
      now: () => Date.UTC(2026, 8, 19, 9),
    }).daily.challenge;
    expect(today.day).toBe('2026-09-18');
    expect(tomorrow.day).toBe('2026-09-19');
    expect(tomorrow.seed).not.toBe(today.seed);
  });
});

describe('RunSession: the board and the toasts', () => {
  it('fills the board for the player it has, and keeps a keyboard off the jogging missions', () => {
    const s = setup();
    s.runs.setCapabilities({ mode: 'full', tracksJogging: false });
    const ids = s.runs.liveMissions().map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => /jog|step|josh/i.test(id))).toBe(false);
  });

  it('toasts a mission when its bar moves a quarter, never twice for the same quarter, and never a completion', () => {
    const s = setup();
    s.runs.setCapabilities({ mode: 'full', tracksJogging: true });
    // Collect every toast as the run goes, not just the ones left over at the end.
    const toasts: { id: string; frac: number; done: boolean }[] = [];
    const drain = () => {
      for (let t = s.runs.takeToast(); t; t = s.runs.takeToast()) toasts.push({ id: t.id, frac: t.frac, done: t.done });
    };
    s.frame(JOGGING, [{ type: 'start' }]);
    for (let i = 0; i < Math.round(20 / DT); i++) {
      s.frame(JOGGING);
      drain();
    }
    expect(toasts.length).toBeGreaterThan(0);
    const seen = new Map<string, number>();
    for (const t of toasts) {
      // A live toast is progress only: the medal is the summary card's to give.
      expect(t.done, t.id).toBe(false);
      expect(t.frac, t.id).toBeLessThan(1);
      expect(t.frac, t.id).toBeGreaterThan(seen.get(t.id) ?? 0);
      seen.set(t.id, t.frac);
    }
  });

  it('starts every player on the free character and board', () => {
    const s = setup();
    expect(s.progression.state.unlocks.character).toBe(DEFAULT_CHARACTER);
  });
});

describe('RunSession: the boosts a run was bought', () => {
  it('a magnet boost is spent once and is already running when play begins', () => {
    const s = setup();
    s.progression.award(500);
    expect(s.progression.buy('magnet-boost').ok).toBe(true);
    expect(s.progression.held('magnet-boost')).toBe(1);

    s.frame(JOGGING, [{ type: 'start' }]);
    // Spent on the run that is counting down, and the magnet is on before the first playing frame.
    expect(s.progression.held('magnet-boost')).toBe(0);
    expect(s.game.state).toBe('countdown');
    expect(s.game.powerups.magnet).toBeGreaterThan(0);
    const atCountdown = s.game.powerups.magnet;
    s.play(TUNING.countdownSeconds + 0.1);
    expect(s.game.state).toBe('playing');
    // The countdown does not tick power-ups, so none of the boost was spent waiting for GO.
    expect(s.game.powerups.magnet).toBeGreaterThan(atCountdown - 0.3);

    // The next run has none left, so it starts without one.
    for (let i = 0; i < 60 * 40 && s.game.state !== 'summary'; i++) s.frame(STILL);
    s.end();
    s.frame(JOGGING, [{ type: 'start' }]);
    expect(s.game.powerups.magnet).toBe(0);
  });

  it('a demo run pays for nothing, so it is given nothing', () => {
    const s = setup({ saveRuns: false });
    s.progression.award(500);
    s.progression.buy('magnet-boost');
    s.frame(JOGGING, [{ type: 'start' }]);
    expect(s.progression.held('magnet-boost')).toBe(1);
    expect(s.game.powerups.magnet).toBe(0);
  });

  it('a run with nothing bought starts clean', () => {
    const s = setup();
    s.frame(JOGGING, [{ type: 'start' }]);
    expect(s.game.powerups.magnet).toBe(0);
  });
});

describe('RunSession: an abandoned daily gives back what it borrowed', () => {
  it('disarms, so the next ordinary run is not scored as today’s attempt', () => {
    const s = setup();
    s.runs.armDaily();
    expect(s.runs.dailyArmed).toBe(true);
    // The player backs out before the run ever starts.
    s.runs.disarmDaily();
    expect(s.runs.dailyArmed).toBe(false);
    s.fullRun();
    expect(s.end().daily).toBe(false);
  });

  it('a run abandoned mid-flight leaves nothing armed either', () => {
    const s = setup();
    s.runs.armDaily();
    s.frame(JOGGING, [{ type: 'start' }]);
    expect(s.runs.dailyArmed).toBe(false); // consumed by the run that started
    for (const e of s.game.toMenu()) if (e.type === 'state' && e.state === 'menu') s.runs.abandonRun();
    s.runs.disarmDaily();
    s.fullRun();
    expect(s.end().daily).toBe(false);
    expect(s.progression.state.daily.best).toBe(0);
  });
});
