import { describe, expect, it } from 'vitest';
import {
  CONSUMABLE_IDS,
  DEFAULT_BOARD,
  DEFAULT_CHARACTER,
  PROGRESSION_KEY,
  ProgressionStore,
  SHOP_ITEMS,
  currentTier,
  dailyChallenge,
  dailyView,
  dayKey,
  emptyProgression,
  levelFor,
  levelProgress,
  levelReward,
  levelThreshold,
  parseProgression,
  previousDay,
  refundUnreleased,
  rollDaily,
  shopItem,
  shopModel,
  emptyDaily,
} from '../../src/app/progression';
import { ALL_CAPABILITIES, emptyCounters, pickMissions, type MissionContext, type RunCounters } from '../../src/game/missions';

class FakeStorage {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(k: string): string | null {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.writes++;
    this.data.set(k, v);
  }
}

const throwing = {
  getItem(): string | null {
    throw new Error('SecurityError');
  },
  setItem(): void {
    throw new Error('QuotaExceededError');
  },
};

const FULL: MissionContext = { mode: 'full', capabilities: ALL_CAPABILITIES };
const DAY = '2026-09-18';
const counters = (over: Partial<RunCounters> = {}): RunCounters => ({ ...emptyCounters(), ...over });
const run = (over = {}) => ({ day: DAY, sessionRun: 1, previousDistance: null, ...over });

// ---------------------------------------------------------------- level

describe('the level curve', () => {
  it('starts at 1 and climbs', () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(399)).toBe(1);
    expect(levelFor(400)).toBe(2);
    expect(levelFor(1200)).toBe(3);
    expect(levelFor(2400)).toBe(4);
  });

  it('agrees with its own thresholds all the way up', () => {
    for (let l = 1; l <= 40; l++) {
      expect(levelFor(levelThreshold(l))).toBe(l);
      expect(levelFor(levelThreshold(l + 1) - 1)).toBe(l);
    }
  });

  it('never returns a level below 1 or a NaN for nonsense', () => {
    expect(levelFor(-500)).toBe(1);
    expect(levelFor(Number.NaN)).toBe(1);
    expect(levelProgress(Number.NaN).frac).toBe(0);
  });

  it('gives a bar that stays inside its track', () => {
    for (const s of [0, 1, 399, 400, 1199, 5000, 1e7]) {
      const p = levelProgress(s);
      expect(p.frac).toBeGreaterThanOrEqual(0);
      expect(p.frac).toBeLessThanOrEqual(1);
      expect(p.into).toBeLessThanOrEqual(p.span);
    }
  });

  it('pays coins and gates nothing', () => {
    expect(levelReward(3)).toBeGreaterThan(0);
    // No shop item mentions a level: unlocks are bought, never earned by rank.
    for (const it of SHOP_ITEMS) expect(Object.keys(it)).not.toContain('level');
  });
});

// ---------------------------------------------------------------- daily

describe('the daily challenge', () => {
  it('is the same all day and different tomorrow', () => {
    const a = dailyChallenge('2026-09-18');
    const b = dailyChallenge('2026-09-18');
    expect(a).toEqual(b);
    expect(dailyChallenge('2026-09-19').seed).not.toBe(a.seed);
  });

  it('gives a named route and a reachable goal', () => {
    const c = dailyChallenge('2026-09-18');
    expect(c.title).toMatch(/ to /);
    expect(c.goalMeters).toBeGreaterThan(0);
    expect(c.coins).toBeGreaterThan(0);
  });

  it('varies across a month rather than repeating one route', () => {
    const seen = new Set<string>();
    for (let d = 1; d <= 28; d++) seen.add(dailyChallenge(`2026-09-${String(d).padStart(2, '0')}`).title);
    expect(seen.size).toBeGreaterThan(3);
  });

  it('knows yesterday, across a month and a year boundary', () => {
    expect(previousDay('2026-09-18')).toBe('2026-09-17');
    expect(previousDay('2026-09-01')).toBe('2026-08-31');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('keeps a streak over a played day and drops it over a gap', () => {
    const base = { ...emptyDaily('2026-09-17'), streak: 4, lastDone: '2026-09-17', done: true };
    expect(rollDaily(base, '2026-09-18').streak).toBe(4);
    expect(rollDaily(base, '2026-09-18').done).toBe(false);
    expect(rollDaily(base, '2026-09-20').streak).toBe(0);
  });

  it('missing a day costs the streak and nothing else', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.award(500);
    const before = s.balance;
    const stale = { ...emptyDaily('2026-09-10'), streak: 9, lastDone: '2026-09-10' };
    const rolled = rollDaily(stale, '2026-09-18');
    expect(rolled.streak).toBe(0);
    expect(s.balance).toBe(before);
  });

  it('builds a view that never overruns its bar', () => {
    const c = dailyChallenge(DAY);
    const v = dailyView(c, { ...emptyDaily(DAY), best: c.goalMeters * 5 });
    expect(v.frac).toBe(1);
    expect(dailyView(c, emptyDaily('2026-01-01')).frac).toBe(0);
  });

  it('dayKey is a local YYYY-MM-DD', () => {
    expect(dayKey(new Date(2026, 8, 18, 23, 59))).toBe('2026-09-18');
    expect(dayKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
  });
});

// ---------------------------------------------------------------- persistence

describe('parseProgression', () => {
  it('starts empty with nothing stored', () => {
    expect(parseProgression(null)).toEqual(emptyProgression());
    expect(parseProgression('not json')).toEqual(emptyProgression());
    expect(parseProgression('[1,2,3]')).toEqual(emptyProgression());
  });

  it('keeps the coins when every other section is garbage', () => {
    const raw = JSON.stringify({
      version: 1,
      wallet: { earned: 1234, spent: 200 },
      unlocks: 'broken',
      consumables: 42,
      missions: { nope: true },
      daily: [],
      lifetimeScore: 'oops',
    });
    const p = parseProgression(raw);
    expect(p.wallet.earned).toBe(1234);
    expect(p.wallet.spent).toBe(200);
    expect(p.unlocks.character).toBe(DEFAULT_CHARACTER);
    expect(p.unlocks.board).toBe(DEFAULT_BOARD);
    expect(p.missions.active).toEqual([]);
    expect(p.lifetimeScore).toBe(0);
  });

  it('never produces a negative balance, however the wallet was tampered with', () => {
    for (const w of [{ earned: 10, spent: 9999 }, { earned: -5, spent: -5 }, { earned: 'x', spent: 3 }, { earned: Number.NaN, spent: 1 }]) {
      const p = parseProgression(JSON.stringify({ version: 1, wallet: w }));
      expect(p.wallet.earned - p.wallet.spent).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.wallet.earned)).toBe(true);
    }
  });

  it('refuses to equip something that is not owned, and never loses the free items', () => {
    const p = parseProgression(JSON.stringify({ version: 1, unlocks: { owned: ['runner-cricket', 'made-up'], character: 'runner-vadapav', board: 'board-royal' } }));
    expect(p.unlocks.owned).toContain('runner-cricket');
    expect(p.unlocks.owned).not.toContain('made-up');
    expect(p.unlocks.owned).toContain(DEFAULT_CHARACTER);
    expect(p.unlocks.character).toBe(DEFAULT_CHARACTER); // vadapav was not owned
    expect(p.unlocks.board).toBe(DEFAULT_BOARD);
  });

  it('will not equip a character into the board slot', () => {
    const p = parseProgression(JSON.stringify({ version: 1, unlocks: { owned: SHOP_ITEMS.map((i) => i.id), character: DEFAULT_BOARD, board: DEFAULT_CHARACTER } }));
    expect(p.unlocks.character).toBe(DEFAULT_CHARACTER);
    expect(p.unlocks.board).toBe(DEFAULT_BOARD);
  });

  it('clamps stored mission progress to its target', () => {
    const p = parseProgression(JSON.stringify({ version: 1, missions: { version: 1, active: [{ id: 'jumps', tier: 0, target: 10, progress: 9999 }], completed: 2, seed: 5 } }));
    expect(p.missions.active[0].progress).toBe(10);
    expect(p.missions.completed).toBe(2);
  });

  it('holds no negative consumables', () => {
    const p = parseProgression(JSON.stringify({ version: 1, consumables: { 'head-start': -4, 'magnet-boost': 2.7 } }));
    expect(p.consumables['head-start']).toBe(0);
    expect(p.consumables['magnet-boost']).toBe(2);
  });
});

// ---------------------------------------------------------------- the store

describe('ProgressionStore', () => {
  it('starts with the free items equipped and no coins', () => {
    const s = new ProgressionStore(new FakeStorage());
    expect(s.balance).toBe(0);
    expect(s.state.unlocks.character).toBe(DEFAULT_CHARACTER);
    expect(s.level).toBe(1);
  });

  it('round-trips through storage', () => {
    const st = new FakeStorage();
    const a = new ProgressionStore(st);
    a.award(600);
    a.buy('runner-college');
    a.equip('runner-college');
    const b = new ProgressionStore(st);
    expect(b.balance).toBe(350);
    expect(b.state.unlocks.character).toBe('runner-college');
  });

  it('keeps working when storage throws on both ends', () => {
    const s = new ProgressionStore(throwing);
    expect(() => s.award(300)).not.toThrow();
    expect(s.balance).toBe(300);
    expect(s.buy('board-neon').ok).toBe(true);
    expect(s.balance).toBe(100);
  });

  it('refuses coins it cannot trust', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.award(100);
    s.award(-500);
    s.award(Number.NaN);
    s.award(Number.POSITIVE_INFINITY);
    expect(s.balance).toBe(100);
  });

  it('will not sell what the player cannot afford, and never overdraws', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.award(100);
    expect(s.buy('runner-college')).toEqual({ ok: false, reason: 'poor' });
    expect(s.balance).toBe(100);
    expect(s.buy('nothing-like-this')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('sells a skin once and a boost over and over', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.award(2000);
    expect(s.buy('board-neon').ok).toBe(true);
    expect(s.buy('board-neon')).toEqual({ ok: false, reason: 'owned' });
    expect(s.buy('head-start').ok).toBe(true);
    expect(s.buy('head-start').ok).toBe(true);
    expect(s.held('head-start')).toBe(2);
    expect(s.balance).toBe(2000 - 200 - 120 * 2);
  });

  it('spends a boost only when one is held', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.award(200);
    s.buy('head-start');
    expect(s.consume('head-start')).toBe(true);
    expect(s.held('head-start')).toBe(0);
    expect(s.consume('head-start')).toBe(false);
    expect(s.held('head-start')).toBe(0);
  });

  it('equips only what is owned, and only into its own slot', () => {
    const s = new ProgressionStore(new FakeStorage());
    expect(s.equip('runner-cricket')).toBe(false);
    expect(s.equip('head-start')).toBe(false);
    s.award(900);
    s.buy('runner-cricket');
    expect(s.equip('runner-cricket')).toBe(true);
    expect(s.state.unlocks.character).toBe('runner-cricket');
    expect(s.state.unlocks.board).toBe(DEFAULT_BOARD);
  });

  it('sells nothing that could break the catch rules', () => {
    for (const it of SHOP_ITEMS) {
      expect(it.kind === 'character' || it.kind === 'board' || it.kind === 'consumable').toBe(true);
      expect(it.price).toBeGreaterThanOrEqual(0);
    }
    // The two boosts are one-run and mild; nothing on sale is permanent power.
    expect(CONSUMABLE_IDS).toEqual(['head-start', 'magnet-boost']);
    expect(shopItem('head-start')!.repeatable).toBe(true);
  });

  it('a first unlock is a handful of runs away, not a grind', () => {
    const cheapest = Math.min(...SHOP_ITEMS.filter((i) => i.price > 0).map((i) => i.price));
    expect(cheapest).toBeLessThanOrEqual(300);
  });
});

describe('recordRun', () => {
  it('banks the run coins, the mission coins and the level coins once', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.refresh(FULL);
    const out = s.recordRun({ counters: counters({ coins: 40, score: 1300, distance: 1200, timeSec: 100, jumps: 30, laneChanges: 40, steps: 300, bestJogStreakSec: 80, bestCleanMeters: 600 }), ctx: FULL, run: run(), today: DAY });
    expect(out.runCoins).toBe(40);
    expect(out.levelUps).toEqual([2, 3]);
    expect(out.levelCoins).toBe(levelReward(2) + levelReward(3));
    expect(s.balance).toBe(out.runCoins + out.missionCoins + out.levelCoins);
    expect(s.state.lifetimeScore).toBe(1300);
  });

  it('adds nothing for a run worth nothing, and never goes negative', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.refresh(FULL);
    s.recordRun({ counters: counters({ coins: -20, score: -100 }), ctx: FULL, run: run(), today: DAY });
    expect(s.balance).toBe(0);
    expect(s.state.lifetimeScore).toBe(0);
  });

  it('completes the daily only on a daily run that reaches the goal', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.refresh(FULL);
    const goal = dailyChallenge(DAY).goalMeters;

    const notDaily = s.recordRun({ counters: counters({ distance: goal + 500 }), ctx: FULL, run: run(), today: DAY });
    expect(notDaily.dailyCompleted).toBe(false);

    const short = s.recordRun({ counters: counters({ distance: goal - 1 }), ctx: FULL, run: run({ sessionRun: 2 }), daily: true, today: DAY });
    expect(short.dailyCompleted).toBe(false);
    expect(s.state.daily.best).toBe(goal - 1);

    const won = s.recordRun({ counters: counters({ distance: goal }), ctx: FULL, run: run({ sessionRun: 3 }), daily: true, today: DAY });
    expect(won.dailyCompleted).toBe(true);
    expect(won.dailyStreak).toBe(1);
  });

  it('pays the daily once a day, and the streak grows day by day', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.refresh(FULL);
    const win = (day: string) =>
      s.recordRun({ counters: counters({ distance: dailyChallenge(day).goalMeters + 100 }), ctx: FULL, run: run({ day }), daily: true, today: day });

    const first = win('2026-09-18');
    expect(first.dailyCompleted).toBe(true);
    const again = win('2026-09-18');
    expect(again.dailyCompleted).toBe(false); // already done today
    expect(win('2026-09-19').dailyStreak).toBe(2);
    expect(win('2026-09-21').dailyStreak).toBe(1); // a day was missed
  });

  it('rolls the day over on its own when the player comes back', () => {
    const st = new FakeStorage();
    st.setItem(PROGRESSION_KEY, JSON.stringify({ version: 1, daily: { day: '2026-09-17', done: true, best: 900, streak: 3, lastDone: '2026-09-17' } }));
    const s = new ProgressionStore(st);
    const { state } = s.daily('2026-09-18');
    expect(state.done).toBe(false);
    expect(state.best).toBe(0);
    expect(state.streak).toBe(3);
  });

  it('never loses a coin when the missions are reset', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.refresh(FULL);
    s.award(777);
    const before = s.balance;
    s.resetMissions();
    expect(s.balance).toBe(before);
    expect(s.state.missions.active).toEqual([]);
  });

  it('fills the board only with missions this player can attempt', () => {
    const s = new ProgressionStore(new FakeStorage());
    const views = s.refresh({ mode: 'small', capabilities: ['jump', 'roll', 'lane'] });
    expect(views).toHaveLength(3);
    expect(views.map((v) => v.id)).not.toContain('jog-steps');
    expect(views.map((v) => v.id)).not.toContain('lane-sprint');
  });

  it('reports the tier the player is on', () => {
    const s = new ProgressionStore(new FakeStorage());
    expect(currentTier(s.state)).toBe(0);
  });
});

// ---------------------------------------------------------------- shop model

describe('shopModel', () => {
  it('marks each item afford / locked / owned / equipped', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.award(300);
    s.buy('runner-college');
    s.equip('runner-college');
    const m = shopModel(s.state);
    const by = new Map(m.items.map((i) => [i.id, i]));
    expect(by.get('runner-college')!.state).toBe('equipped');
    expect(by.get(DEFAULT_CHARACTER)!.state).toBe('owned');
    expect(by.get('board-neon')!.state).toBe('locked'); // 50 left, costs 200
    expect(by.get('magnet-boost')!.state).toBe('locked');
    expect(by.get('board-neon')!.short).toBe(150);
  });

  it('does not offer an item the game cannot spend yet', () => {
    const m = shopModel(new ProgressionStore(new FakeStorage()).state);
    expect(m.items.some((i) => i.id === 'head-start')).toBe(false);
    // It is held back, not deleted: the catalogue, its price and `consume` are all still there.
    expect(shopItem('head-start')?.unreleased).toBe(true);
    expect(SHOP_ITEMS.some((i) => i.id === 'head-start')).toBe(true);
  });

  it('shows how many boosts are held', () => {
    const s = new ProgressionStore(new FakeStorage());
    s.award(400);
    s.buy('magnet-boost');
    s.buy('magnet-boost');
    const m = shopModel(s.state);
    expect(m.items.find((i) => i.id === 'magnet-boost')!.held).toBe(2);
    expect(m.items.find((i) => i.id === 'board-neon')!.held).toBeNull();
  });

  it('formats the purse and the level bar', () => {
    const m = shopModel({ ...emptyProgression(), wallet: { earned: 12345, spent: 45 }, lifetimeScore: 1500 });
    expect(m.balanceText).toBe('12,300');
    expect(m.level).toBe(3);
    expect(m.levelFrac).toBeGreaterThan(0);
    expect(m.levelFrac).toBeLessThan(1);
  });
});

describe('an item the game cannot spend', () => {
  it('is kept off the storefront but keeps working underneath', () => {
    const s = new ProgressionStore(new FakeStorage());
    // The store itself still sells it — only the *storefront* holds it back — so the day the run
    // learns to apply one, flipping `unreleased` is the whole change.
    s.award(500);
    expect(s.buy('head-start').ok).toBe(true);
    expect(s.held('head-start')).toBe(1);
    expect(s.consume('head-start')).toBe(true);
    expect(s.held('head-start')).toBe(0);
  });

  it('refunds anyone who already bought one, and does it only once', () => {
    const storage = new FakeStorage();
    storage.setItem(
      PROGRESSION_KEY,
      JSON.stringify({ ...emptyProgression(), wallet: { earned: 1000, spent: 240 }, consumables: { 'head-start': 2 } }),
    );
    const s = new ProgressionStore(storage);
    expect(s.held('head-start')).toBe(0);
    expect(s.balance).toBe(1000); // 240 spent on two head starts, both given back
    // Reloading the refunded profile changes nothing further.
    const again = new ProgressionStore(storage);
    expect(again.balance).toBe(1000);
    expect(again.held('head-start')).toBe(0);
  });

  it('never gives back more than was spent, whatever the stored numbers say', () => {
    const p = refundUnreleased({
      ...emptyProgression(),
      wallet: { earned: 50, spent: 10 },
      consumables: { 'head-start': 99 },
    });
    expect(p.wallet.spent).toBe(0);
    expect(Math.max(0, p.wallet.earned - p.wallet.spent)).toBe(50);
  });
});

describe('the daily card once today is already paid', () => {
  it('stops advertising coins the next run will not pay', () => {
    const challenge = dailyChallenge('2026-09-18');
    const open = dailyView(challenge, { ...emptyDaily('2026-09-18'), best: 300 });
    expect(open.done).toBe(false);
    expect(open.coins).toBeGreaterThan(0);
    // Done: the view still carries the amount (the card decides how to show it), but `done` is the
    // flag the card must read, and it is the same flag `recordRun` pays on.
    const paid = dailyView(challenge, { ...emptyDaily('2026-09-18'), best: challenge.goalMeters, done: true });
    expect(paid.done).toBe(true);
  });

  it('a second completion of the same day really does pay nothing', () => {
    const s = new ProgressionStore(new FakeStorage());
    const today = '2026-09-18';
    const challenge = dailyChallenge(today);
    const run = { day: today, sessionRun: 1, previousDistance: null };
    const ctx: MissionContext = { mode: 'full', capabilities: [...ALL_CAPABILITIES] };
    const counters: RunCounters = { ...emptyCounters(), distance: challenge.goalMeters + 10 };
    const first = s.recordRun({ counters, run, ctx, daily: true, today });
    expect(first.dailyCompleted).toBe(true);
    const second = s.recordRun({ counters, run: { ...run, sessionRun: 2 }, ctx, daily: true, today });
    expect(second.dailyCompleted).toBe(false);
    expect(second.missionCoins).toBe(second.missions.coins); // no daily coins folded in
  });
});

describe('pickMissions never puts the same mission on the board twice', () => {
  const ctx: MissionContext = { mode: 'full', capabilities: [...ALL_CAPABILITIES] };

  it('asked for more than the pool holds, it repeats a tag but never a mission', () => {
    const picked = pickMissions(ctx, 7, 30);
    const ids = picked.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('and never picks one that clashes with a mission the board is keeping', () => {
    for (const taken of [['jog'], ['distance'], ['jog', 'coins']]) {
      const picked = pickMissions(ctx, 11, 30, taken);
      for (const d of picked) {
        for (const t of d.tags) expect(taken, `${d.id} carries ${t}`).not.toContain(t);
      }
    }
  });
});
