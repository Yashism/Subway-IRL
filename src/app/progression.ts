/**
 * Progression (spec: docs/superpowers/specs/2026-09-18-missions.md): the wallet, the shop and
 * what is equipped, the level curve, the mission board and the daily challenge.
 *
 * Kept in its own localStorage key, separate from `subway-irl.profile.v1`. That is the whole
 * point of the "corrupt data resets that section only" rule: a profile that fails to parse can
 * never take the coins with it, and vice versa. Every section is validated on its own — a
 * broken `unlocks` block costs you the equipped skin, never the balance.
 */

import {
  applyRun,
  emptyMissions,
  missionViews,
  refreshMissions,
  tierFor,
  type MissionContext,
  type MissionRunContext,
  type MissionRunResult,
  type MissionView,
  type MissionsState,
  type RunCounters,
} from '../game/missions';
import { Rng } from '../game/rng';

// ---------------------------------------------------------------- the shop

export type ShopKind = 'character' | 'board' | 'consumable';

export interface ShopItem {
  id: string;
  kind: ShopKind;
  name: string;
  blurb: string;
  price: number;
  icon: string;
  /** Three CSS colours for the little preview chip on the card. */
  swatch: readonly [string, string, string];
  /**
   * Characters: overrides for the runner's colour map in `src/world/models/characters.ts`
   * (same keys). Boards: `base` / `trim` / `glow` for the flying carpet. Cosmetic only —
   * nothing here changes a hitbox, the catch rules or what the jog has to do.
   */
  palette?: Readonly<Record<string, number>>;
  /** A prop swap on the existing rig; the world decides what to hang on the runner. */
  prop?: 'bag' | 'tiffin' | 'bat';
  /** Consumables are bought over and over and held as a count. */
  repeatable?: boolean;
}

const item = (i: ShopItem): ShopItem => Object.freeze(i);

export const DEFAULT_CHARACTER = 'runner-street';
export const DEFAULT_BOARD = 'board-carpet';

/** Owned from the start, so a brand-new player always has something equipped. */
export const FREE_ITEMS: readonly string[] = [DEFAULT_CHARACTER, DEFAULT_BOARD];

export const SHOP_ITEMS: readonly ShopItem[] = Object.freeze([
  item({
    id: DEFAULT_CHARACTER,
    kind: 'character',
    name: 'Street kid',
    blurb: 'Orange hoodie, cyan cap. The one you started with.',
    price: 0,
    icon: '🧒',
    swatch: ['#ff5a36', '#35d0e6', '#3b5ea8'],
  }),
  item({
    id: 'runner-college',
    kind: 'character',
    name: 'College kid',
    blurb: 'Navy hoodie and a sling bag, running for the 8:41 fast.',
    price: 250,
    icon: '🎒',
    swatch: ['#2f3f7a', '#f2c53d', '#4a5a2e'],
    prop: 'bag',
    palette: {
      hoodie: 0x2f3f7a,
      hoodieDark: 0x1e2a56,
      accent: 0xf2c53d,
      cap: 0xe8433a,
      capDark: 0xa82b25,
      jeans: 0x4a5a2e,
      jeansDark: 0x35411f,
      jeansLight: 0x6f8248,
      bag: 0xd8401f,
      bagDark: 0xa02d12,
      shoeAccent: 0x29c7e0,
    },
  }),
  item({
    id: 'runner-vadapav',
    kind: 'character',
    name: 'Vada-pav seller',
    blurb: 'White vest, tiffin in hand, still faster than the TT.',
    price: 500,
    icon: '🥪',
    swatch: ['#f6f1e2', '#e8433a', '#8a6a3a'],
    prop: 'tiffin',
    palette: {
      hoodie: 0xf6f1e2,
      hoodieDark: 0xd8cfb6,
      accent: 0xe8433a,
      cap: 0xe8433a,
      capDark: 0xa82b25,
      jeans: 0x8a6a3a,
      jeansDark: 0x634923,
      jeansLight: 0xb2915c,
      bag: 0xc7cdd1,
      bagDark: 0x8e959a,
      shoeUpper: 0x8a6a3a,
      shoeAccent: 0xffc93c,
      sole: 0x3fb27f,
    },
  }),
  item({
    id: 'runner-cricket',
    kind: 'character',
    name: 'Gully cricketer',
    blurb: 'Blue jersey, whites and a bat. Gully to Wankhede.',
    price: 800,
    icon: '🏏',
    swatch: ['#1b5fbf', '#f4f4f4', '#ffc93c'],
    prop: 'bat',
    palette: {
      hoodie: 0x1b5fbf,
      hoodieDark: 0x12408a,
      accent: 0xffc93c,
      cap: 0x1b5fbf,
      capDark: 0x12408a,
      jeans: 0xf0ece0,
      jeansDark: 0xcdc7b6,
      jeansLight: 0xffffff,
      shoeUpper: 0xffffff,
      shoeAccent: 0x1b5fbf,
      sole: 0xe8433a,
      bag: 0xb9774b,
      bagDark: 0x8a5733,
    },
  }),
  item({
    id: DEFAULT_BOARD,
    kind: 'board',
    name: 'Flying carpet',
    blurb: 'The original. Red, gold-fringed, faintly smug.',
    price: 0,
    icon: '🧿',
    // No palette: this one *is* the carpet the world already builds, exactly as it is. The swatch
    // is the rug's own three colours, so the card shows what is under the runner and not a recolour.
    swatch: ['#b3122e', '#ffc93c', '#e5399b'],
  }),
  item({
    id: 'board-neon',
    kind: 'board',
    name: 'Neon Nite',
    blurb: 'Marine Drive after dark, condensed into a rug.',
    price: 200,
    icon: '💜',
    swatch: ['#2b1a52', '#29c7e0', '#e5399b'],
    palette: { base: 0x2b1a52, trim: 0x29c7e0, glow: 0xe5399b },
  }),
  item({
    id: 'board-chai',
    kind: 'board',
    name: 'Cutting chai',
    blurb: 'Steaming, slightly sticky, absolutely airborne.',
    price: 350,
    icon: '🫖',
    swatch: ['#a9753f', '#f6f1e2', '#ffc93c'],
    palette: { base: 0xa9753f, trim: 0xf6f1e2, glow: 0xffc93c },
  }),
  item({
    id: 'board-royal',
    kind: 'board',
    name: 'Maharaja',
    blurb: 'Bottle green and real gold thread. Allegedly.',
    price: 600,
    icon: '👑',
    swatch: ['#12503a', '#f2c53d', '#3fb27f'],
    palette: { base: 0x12503a, trim: 0xf2c53d, glow: 0x3fb27f },
  }),
  item({
    id: 'head-start',
    kind: 'consumable',
    name: 'Head start',
    blurb: 'Begin the run 200 m down the line. You still have to jog it.',
    price: 120,
    icon: '🚀',
    swatch: ['#ff7a29', '#ffd400', '#e8433a'],
    repeatable: true,
  }),
  item({
    id: 'magnet-boost',
    kind: 'consumable',
    name: 'Magnet boost',
    blurb: 'A magnet already running when the countdown ends.',
    price: 150,
    icon: '🧲',
    swatch: ['#29c7e0', '#ffd400', '#1b1035'],
    repeatable: true,
  }),
]);

const SHOP_BY_ID = new Map(SHOP_ITEMS.map((i) => [i.id, i]));

export const shopItem = (id: string): ShopItem | undefined => SHOP_BY_ID.get(id);

/** Consumable ids, in the order they are held. */
export const CONSUMABLE_IDS: readonly string[] = SHOP_ITEMS.filter((i) => i.repeatable).map((i) => i.id);

// ---------------------------------------------------------------- level

/** Cumulative lifetime score for a level: L2 at 400, L3 at 1200, L4 at 2400… */
export const levelThreshold = (level: number): number => 200 * Math.max(1, level) * (Math.max(1, level) - 1);

export function levelFor(lifetimeScore: number): number {
  const s = Number.isFinite(lifetimeScore) && lifetimeScore > 0 ? lifetimeScore : 0;
  return Math.max(1, Math.floor((1 + Math.sqrt(1 + s / 50)) / 2));
}

/** Coins handed out for reaching a level. Levels award coins and nothing else: no content is gated. */
export const levelReward = (level: number): number => 50 * Math.max(1, level);

export interface LevelProgress {
  level: number;
  /** Score into the current level, and the span of it. */
  into: number;
  span: number;
  frac: number;
}

export function levelProgress(lifetimeScore: number): LevelProgress {
  const s = Math.max(0, Number.isFinite(lifetimeScore) ? lifetimeScore : 0);
  const level = levelFor(s);
  const base = levelThreshold(level);
  const span = Math.max(1, levelThreshold(level + 1) - base);
  const into = Math.max(0, Math.min(span, s - base));
  return { level, into, span, frac: into / span };
}

// ---------------------------------------------------------------- the daily challenge

export const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local date key, "YYYY-MM-DD". Local on purpose: the challenge turns over at the player's midnight. */
export const dayKey = (d: Date = new Date()): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** The day before `day`, as a key. */
export function previousDay(day: string): string {
  const d = parseDay(day);
  if (!d) return '';
  d.setDate(d.getDate() - 1);
  return dayKey(d);
}

function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** FNV-1a over the date string: the same day always gives the same challenge. */
export function daySeed(day: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

/** Stretches of the Mumbai local, west to east and back. */
export const DAILY_ROUTES: readonly (readonly [string, string])[] = Object.freeze([
  ['Bandra', 'Andheri'],
  ['Churchgate', 'Dadar'],
  ['Dadar', 'Kurla'],
  ['CSMT', 'Byculla'],
  ['Ghatkopar', 'Mulund'],
  ['Vashi', 'Panvel'],
  ['Borivali', 'Virar'],
  ['Goregaon', 'Malad'],
  ['Matunga', 'Sion'],
  ['Kurla', 'Thane'],
  ['Andheri', 'Borivali'],
  ['Wadala', 'Chembur'],
]);

export const DAILY_GOALS: readonly number[] = Object.freeze([800, 1000, 1200, 1500, 1800]);

export interface DailyChallenge {
  /** "YYYY-MM-DD". */
  day: string;
  /** The game seed for the run: everyone playing today runs the same track. */
  seed: number;
  /** "Bandra to Andheri". */
  title: string;
  /** "1,200 m before the TT gets you". */
  goal: string;
  goalMeters: number;
  coins: number;
}

/** One challenge per local day, derived from the date alone — same all day, different tomorrow. */
export function dailyChallenge(day: string): DailyChallenge {
  const seed = daySeed(day);
  const rng = new Rng(seed);
  const [from, to] = rng.pick(DAILY_ROUTES);
  const goalMeters = rng.pick(DAILY_GOALS);
  return {
    day,
    seed,
    title: `${from} to ${to}`,
    goal: `${goalMeters.toLocaleString('en-IN')} m before the TT gets you`,
    goalMeters,
    coins: 100 + goalMeters / 10,
  };
}

export interface DailyState {
  /** The day the rest of this block is about. */
  day: string;
  done: boolean;
  /** Best distance reached on today's challenge. */
  best: number;
  /** Consecutive days completed. Missing a day costs the streak and nothing else. */
  streak: number;
  /** Last day completed, or '' — the only thing a missed day can touch. */
  lastDone: string;
}

export const emptyDaily = (day = ''): DailyState => ({ day, done: false, best: 0, streak: 0, lastDone: '' });

/** Rolls the daily block onto `day`, keeping the streak (and forgiving a gap by resetting it). */
export function rollDaily(d: DailyState, day: string): DailyState {
  if (d.day === day) return d;
  const kept = d.lastDone === day || d.lastDone === previousDay(day) ? d.streak : 0;
  return { day, done: false, best: 0, streak: kept, lastDone: d.lastDone };
}

// ---------------------------------------------------------------- state

export interface Wallet {
  /** Every coin ever earned, and every coin ever spent. Balance is the difference. */
  earned: number;
  spent: number;
}

export interface Unlocks {
  owned: string[];
  character: string;
  board: string;
}

export interface Progression {
  version: 1;
  wallet: Wallet;
  unlocks: Unlocks;
  /** Consumable id → how many are held. */
  consumables: Record<string, number>;
  missions: MissionsState;
  daily: DailyState;
  /** Lifetime score, which is all the level is. */
  lifetimeScore: number;
}

export const PROGRESSION_KEY = 'subway-irl.progression.v1';

export const emptyProgression = (): Progression => ({
  version: 1,
  wallet: { earned: 0, spent: 0 },
  unlocks: { owned: [...FREE_ITEMS], character: DEFAULT_CHARACTER, board: DEFAULT_BOARD },
  consumables: Object.fromEntries(CONSUMABLE_IDS.map((id) => [id, 0])),
  missions: emptyMissions(),
  daily: emptyDaily(),
  lifetimeScore: 0,
});

// ---------------------------------------------------------------- parsing

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
const int = (v: unknown): number => Math.floor(num(v));
const bool = (v: unknown): boolean => v === true;
const dayStr = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

/**
 * The wallet, rebuilt from whatever survived. `earned` only ever grows and `spent` is clamped to
 * it, so no shape of corrupt data can make a balance negative or take away a coin already earned.
 */
function parseWallet(v: unknown): Wallet {
  if (!isObj(v)) return { earned: 0, spent: 0 };
  const earned = int(v.earned);
  return { earned, spent: Math.min(earned, int(v.spent)) };
}

function parseUnlocks(v: unknown): Unlocks {
  const owned = new Set(FREE_ITEMS);
  if (isObj(v) && Array.isArray(v.owned)) {
    for (const id of v.owned) if (typeof id === 'string' && SHOP_BY_ID.has(id)) owned.add(id);
  }
  const pick = (want: unknown, kind: ShopKind, fallback: string): string => {
    const id = typeof want === 'string' ? want : '';
    const it = SHOP_BY_ID.get(id);
    return it && it.kind === kind && owned.has(id) ? id : fallback;
  };
  return {
    owned: [...owned],
    character: pick(isObj(v) ? v.character : null, 'character', DEFAULT_CHARACTER),
    board: pick(isObj(v) ? v.board : null, 'board', DEFAULT_BOARD),
  };
}

function parseConsumables(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of CONSUMABLE_IDS) out[id] = isObj(v) ? int(v[id]) : 0;
  return out;
}

function parseMissions(v: unknown): MissionsState {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.active)) return emptyMissions();
  const active = [];
  for (const m of v.active) {
    if (!isObj(m) || typeof m.id !== 'string') continue;
    const target = Math.max(1, int(m.target));
    active.push({
      id: m.id,
      tier: int(m.tier),
      target,
      progress: Math.min(target, int(m.progress)),
      done: bool(m.done),
      mark: typeof m.mark === 'string' ? m.mark.slice(0, 24) : null,
    });
  }
  return { version: 1, active, completed: int(v.completed), seed: int(v.seed) >>> 0 || 1 };
}

function parseDaily(v: unknown): DailyState {
  if (!isObj(v)) return emptyDaily();
  return {
    day: dayStr(v.day),
    done: bool(v.done),
    best: num(v.best),
    streak: int(v.streak),
    lastDone: dayStr(v.lastDone),
  };
}

/**
 * Validates stored JSON section by section. Anything unreadable falls back to that section's
 * empty value; the rest survives. Coins are never destroyed by a bad neighbour.
 */
export function parseProgression(raw: string | null): Progression {
  if (raw === null) return emptyProgression();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyProgression();
  }
  if (!isObj(data)) return emptyProgression();
  return {
    version: 1,
    wallet: parseWallet(data.wallet),
    unlocks: parseUnlocks(data.unlocks),
    consumables: parseConsumables(data.consumables),
    missions: parseMissions(data.missions),
    daily: parseDaily(data.daily),
    lifetimeScore: int(data.lifetimeScore),
  };
}

// ---------------------------------------------------------------- the store

export type ProgressionStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ProgressionStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // Access itself throws when storage is blocked.
  }
}

export type BuyFailure = 'unknown' | 'owned' | 'poor';
export type BuyResult = { ok: true; item: ShopItem; balance: number } | { ok: false; reason: BuyFailure };

/** One run's worth of outcomes, for the summary card. */
export interface RunOutcome {
  /** Coins the run itself was worth (what the player picked up). */
  runCoins: number;
  /** Coins from finished missions. */
  missionCoins: number;
  /** Coins from levels reached. */
  levelCoins: number;
  missions: MissionRunResult;
  levelUps: number[];
  level: number;
  /** The daily challenge was completed by this run. */
  dailyCompleted: boolean;
  dailyStreak: number;
  balance: number;
}

export interface RecordRunInput {
  counters: RunCounters;
  run: MissionRunContext;
  ctx: MissionContext;
  /** This run was an attempt at today's daily challenge. */
  daily?: boolean;
  /** Defaults to `run.day`. */
  today?: string;
}

export class ProgressionStore {
  private readonly storage: ProgressionStorage | null;
  private current: Progression;

  /** `storage` undefined means window.localStorage (when reachable); null means memory only. */
  constructor(storage?: ProgressionStorage | null, private readonly key = PROGRESSION_KEY) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    let raw: string | null = null;
    try {
      raw = this.storage ? this.storage.getItem(key) : null;
    } catch {
      raw = null;
    }
    this.current = parseProgression(raw);
  }

  get state(): Readonly<Progression> {
    return this.current;
  }

  /** Coins available to spend. Never negative. */
  get balance(): number {
    const { earned, spent } = this.current.wallet;
    return Math.max(0, earned - spent);
  }

  get level(): number {
    return levelFor(this.current.lifetimeScore);
  }

  /** The missions on the board right now, ready to render. */
  get missions(): MissionView[] {
    return missionViews(this.current.missions);
  }

  /** Today's challenge, and where the player is with it. */
  daily(today: string = dayKey()): { challenge: DailyChallenge; state: DailyState } {
    const state = rollDaily(this.current.daily, today);
    if (state !== this.current.daily) this.write({ ...this.current, daily: state });
    return { challenge: dailyChallenge(today), state };
  }

  /** How many of a consumable are held. */
  held(id: string): number {
    return Math.max(0, Math.floor(this.current.consumables[id] ?? 0));
  }

  /** Fills the mission board for this player's mode and capabilities. Safe to call any time. */
  refresh(ctx: MissionContext): MissionView[] {
    const missions = refreshMissions(this.current.missions, ctx);
    if (missions !== this.current.missions) this.write({ ...this.current, missions });
    return this.missions;
  }

  /** Adds coins. A negative or non-finite amount is ignored rather than trusted. */
  award(coins: number): number {
    const c = Math.floor(coins);
    if (!Number.isFinite(c) || c <= 0) return this.balance;
    this.write({ ...this.current, wallet: { ...this.current.wallet, earned: this.current.wallet.earned + c } });
    return this.balance;
  }

  buy(id: string): BuyResult {
    const it = SHOP_BY_ID.get(id);
    if (!it) return { ok: false, reason: 'unknown' };
    const owned = this.current.unlocks.owned.includes(id);
    if (owned && !it.repeatable) return { ok: false, reason: 'owned' };
    if (it.price > this.balance) return { ok: false, reason: 'poor' };
    const wallet = { ...this.current.wallet, spent: this.current.wallet.spent + it.price };
    const unlocks = owned ? this.current.unlocks : { ...this.current.unlocks, owned: [...this.current.unlocks.owned, id] };
    const consumables = it.repeatable
      ? { ...this.current.consumables, [id]: this.held(id) + 1 }
      : this.current.consumables;
    this.write({ ...this.current, wallet, unlocks, consumables });
    return { ok: true, item: it, balance: this.balance };
  }

  /** Equips an owned character or board. Returns false for anything not owned. */
  equip(id: string): boolean {
    const it = SHOP_BY_ID.get(id);
    if (!it || it.repeatable || !this.current.unlocks.owned.includes(id)) return false;
    const slot = it.kind === 'character' ? 'character' : 'board';
    if (this.current.unlocks[slot] === id) return true;
    this.write({ ...this.current, unlocks: { ...this.current.unlocks, [slot]: id } });
    return true;
  }

  /** Spends one consumable at the start of a run. False when none are held. */
  consume(id: string): boolean {
    if (this.held(id) <= 0) return false;
    this.write({ ...this.current, consumables: { ...this.current.consumables, [id]: this.held(id) - 1 } });
    return true;
  }

  /**
   * Folds one finished run in: mission progress, mission and level coins, the daily challenge.
   * Call exactly once per run, from the summary. The coins the player picked up are added here
   * too, so the wallet has a single writer.
   */
  recordRun(input: RecordRunInput): RunOutcome {
    const today = input.today ?? input.run.day;
    const before = this.current;
    const missions = applyRun(before.missions, input.ctx, input.counters, input.run);

    const runCoins = Math.max(0, Math.floor(input.counters.coins));
    const lifetimeScore = before.lifetimeScore + Math.max(0, Math.floor(input.counters.score));
    const oldLevel = levelFor(before.lifetimeScore);
    const newLevel = levelFor(lifetimeScore);
    const levelUps: number[] = [];
    let levelCoins = 0;
    for (let l = oldLevel + 1; l <= newLevel; l++) {
      levelUps.push(l);
      levelCoins += levelReward(l);
    }

    let daily = rollDaily(before.daily, today);
    let dailyCompleted = false;
    let dailyCoins = 0;
    if (input.daily) {
      const challenge = dailyChallenge(today);
      const best = Math.max(daily.best, input.counters.distance);
      if (!daily.done && best >= challenge.goalMeters) {
        dailyCompleted = true;
        dailyCoins = challenge.coins;
        const streak = daily.lastDone === previousDay(today) ? daily.streak + 1 : 1;
        daily = { ...daily, best, done: true, streak, lastDone: today };
      } else {
        daily = { ...daily, best };
      }
    }

    const earned = before.wallet.earned + runCoins + missions.coins + levelCoins + dailyCoins;
    this.write({
      ...before,
      wallet: { ...before.wallet, earned },
      missions: missions.state,
      daily,
      lifetimeScore,
    });

    return {
      runCoins,
      missionCoins: missions.coins + dailyCoins,
      levelCoins,
      missions,
      levelUps,
      level: newLevel,
      dailyCompleted,
      dailyStreak: daily.streak,
      balance: this.balance,
    };
  }

  /** Wipes the board and the daily, keeping every coin ever earned. For "reset my progress". */
  resetMissions(): void {
    this.write({ ...this.current, missions: emptyMissions(this.current.missions.seed), daily: emptyDaily() });
  }

  private write(next: Progression): void {
    this.current = next;
    try {
      this.storage?.setItem(this.key, JSON.stringify(next));
    } catch {
      // Quota or privacy mode: keep playing with the in-memory progression.
    }
  }
}

// ---------------------------------------------------------------- view models

export type ShopItemState = 'equipped' | 'owned' | 'afford' | 'locked';

export interface ShopItemView {
  id: string;
  kind: ShopKind;
  name: string;
  blurb: string;
  icon: string;
  price: number;
  priceText: string;
  swatch: readonly [string, string, string];
  state: ShopItemState;
  /** Consumables: how many are held. Null for everything else. */
  held: number | null;
  /** Coins still to save up, when locked. */
  short: number;
}

export interface ShopModel {
  balance: number;
  balanceText: string;
  level: number;
  levelText: string;
  levelFrac: number;
  levelSub: string;
  items: ShopItemView[];
}

export const fmtCoins = (n: number): string => Math.floor(Math.max(0, n)).toLocaleString('en-IN');

export function shopModel(p: Readonly<Progression>): ShopModel {
  const balance = Math.max(0, p.wallet.earned - p.wallet.spent);
  const owned = new Set(p.unlocks.owned);
  const lvl = levelProgress(p.lifetimeScore);
  return {
    balance,
    balanceText: fmtCoins(balance),
    level: lvl.level,
    levelText: `LEVEL ${lvl.level}`,
    levelFrac: lvl.frac,
    levelSub: `${fmtCoins(lvl.into)} / ${fmtCoins(lvl.span)} to level ${lvl.level + 1}`,
    items: SHOP_ITEMS.map((it): ShopItemView => {
      const held = it.repeatable ? Math.max(0, Math.floor(p.consumables[it.id] ?? 0)) : null;
      const isOwned = !it.repeatable && owned.has(it.id);
      const equipped = isOwned && (p.unlocks.character === it.id || p.unlocks.board === it.id);
      const state: ShopItemState = equipped ? 'equipped' : isOwned ? 'owned' : it.price <= balance ? 'afford' : 'locked';
      return {
        id: it.id,
        kind: it.kind,
        name: it.name,
        blurb: it.blurb,
        icon: it.icon,
        price: it.price,
        priceText: it.price === 0 ? 'Free' : fmtCoins(it.price),
        swatch: it.swatch,
        state,
        held,
        short: Math.max(0, it.price - balance),
      };
    }),
  };
}

export interface DailyView {
  title: string;
  goal: string;
  seed: number;
  goalMeters: number;
  coins: number;
  done: boolean;
  /** 0..1 towards today's goal. */
  frac: number;
  progressText: string;
  streak: number;
  streakText: string;
}

export function dailyView(challenge: DailyChallenge, state: DailyState): DailyView {
  const best = Math.max(0, state.day === challenge.day ? state.best : 0);
  const done = state.day === challenge.day && state.done;
  return {
    title: challenge.title,
    goal: challenge.goal,
    seed: challenge.seed,
    goalMeters: challenge.goalMeters,
    coins: challenge.coins,
    done,
    frac: Math.min(1, best / Math.max(1, challenge.goalMeters)),
    progressText: done ? 'Done today!' : `${Math.floor(best).toLocaleString('en-IN')} / ${challenge.goalMeters.toLocaleString('en-IN')} m`,
    streak: state.streak,
    streakText: state.streak > 0 ? `${state.streak} day${state.streak === 1 ? '' : 's'} in a row` : 'Start a streak',
  };
}

/** The mission tier the player is on, for anything that wants to show it. */
export const currentTier = (p: Readonly<Progression>): number => tierFor(p.missions.completed);
