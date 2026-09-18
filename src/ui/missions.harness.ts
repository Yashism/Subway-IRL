/**
 * Visual harness for the mission board, the daily challenge and the shop (not part of the build;
 * no camera, no game). The fixtures drive the *real* modules — a memory-backed ProgressionStore
 * — so what you see is what the game would show.
 *
 * missions-harness.html?state=<name>
 */
import './hud.css';
import {
  PROGRESSION_KEY,
  ProgressionStore,
  dailyChallenge,
  dailyView,
  fmtCoins,
  levelProgress,
  shopModel,
  type DailyView,
  type ShopModel,
} from '../app/progression';
import { emptyCounters, missionViews, type MissionContext, type MissionView, type RunCounters } from '../game/missions';
import { MissionBoard, renderMissionList, renderMissionToast, type MissionBoardModel } from './missionCard';
import { ShopScreen } from './shop';

const STATES = [
  'board', 'board-complete', 'board-fresh', 'daily-done', 'summary', 'toast',
  'shop', 'shop-poor', 'shop-rich', 'small-room', 'keyboard',
] as const;
type State = (typeof STATES)[number];

const params = new URLSearchParams(location.search);
const state = (STATES as readonly string[]).includes(params.get('state') ?? '') ? (params.get('state') as State) : 'board';
if (params.has('shot')) document.body.classList.add('shot');

const nav = document.getElementById('nav')!;
for (const s of STATES) {
  const a = document.createElement('a');
  a.href = `?state=${s}`;
  a.textContent = s;
  if (s === state) a.dataset.on = 'on';
  nav.append(a);
}

// ---------------------------------------------------------------- fixtures

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

/** A fixed day, so a screenshot taken tomorrow looks like one taken today. */
const DAY = '2026-09-18';

const FULL: MissionContext = { mode: 'full', capabilities: ['jog', 'steps', 'josh', 'jump', 'roll', 'lane', 'hoverboard'] };
const SMALL: MissionContext = { mode: 'small', capabilities: ['jog', 'steps', 'josh', 'jump', 'roll', 'lane', 'hoverboard'] };
const KEYBOARD: MissionContext = { mode: 'full', capabilities: ['jump', 'roll', 'lane', 'hoverboard'] };

const counters = (over: Partial<RunCounters> = {}): RunCounters => ({ ...emptyCounters(), ...over });

/** A store seeded with some coins, some progress and a run or two behind it. */
function store(opts: { ctx?: MissionContext; coins?: number; score?: number; runs?: RunCounters[]; owned?: string[]; equip?: string } = {}): ProgressionStore {
  // Seeding through storage rather than through the API: it is the one way to hand the store a
  // lifetime score without also faking a run that the missions would then count.
  const mem = new MemoryStorage();
  mem.setItem(PROGRESSION_KEY, JSON.stringify({ version: 1, lifetimeScore: opts.score ?? 0 }));
  const s = new ProgressionStore(mem);
  const ctx = opts.ctx ?? FULL;
  s.refresh(ctx);
  s.award(opts.coins ?? 0);
  let i = 0;
  for (const c of opts.runs ?? []) {
    i++;
    s.recordRun({ counters: c, ctx, run: { day: DAY, sessionRun: i, previousDistance: i > 1 ? 500 : null }, today: DAY });
  }
  for (const id of opts.owned ?? []) s.buy(id);
  if (opts.equip) s.equip(opts.equip);
  return s;
}

function boardModel(s: ProgressionStore, opts: { daily?: DailyView | null } = {}): MissionBoardModel {
  const lvl = levelProgress(s.state.lifetimeScore);
  return {
    missions: missionViews(s.state.missions),
    daily: opts.daily !== undefined ? opts.daily : dailyView(dailyChallenge(DAY), s.state.daily),
    level: { text: `LEVEL ${lvl.level}`, sub: `${fmtCoins(lvl.into)} / ${fmtCoins(lvl.span)} to level ${lvl.level + 1}`, frac: lvl.frac },
    coins: fmtCoins(s.balance),
  };
}

// ---------------------------------------------------------------- render

const boardRoot = document.getElementById('board')!;
const shopRoot = document.getElementById('shop')!;
const loose = document.getElementById('loose')!;

const board = new MissionBoard(boardRoot, {
  onPlayDaily: () => undefined,
  onShop: () => (location.search = '?state=shop'),
});
const shop = new ShopScreen(shopRoot, {
  buy: (id) => {
    live?.buy(id);
    paint();
  },
  equip: (id) => {
    live?.equip(id);
    paint();
  },
  close: () => (location.search = '?state=board'),
});

let live: ProgressionStore | null = null;
let paint = (): void => undefined;

function show(opts: { model?: MissionBoardModel | null; shop?: ShopModel | null; extra?: HTMLElement }): void {
  board.update(opts.model ?? null);
  shop.update(opts.shop ?? null);
  loose.replaceChildren(...(opts.extra ? [opts.extra] : []));
}

switch (state) {
  case 'board': {
    // Two missions under way, one barely started, a daily part-run.
    const s = store({ coins: 340, score: 2600, runs: [counters({ steps: 70, jumps: 4, laneChanges: 6, distance: 310, coins: 18, score: 328, timeSec: 31, bestJogStreakSec: 17, bestJoshStreakSec: 3, bestCleanMeters: 130, stumbles: 2 })] });
    s.recordRun({ counters: counters({ distance: 740, coins: 18, score: 758, timeSec: 70, jumps: 3, laneChanges: 5, steps: 95, bestJogStreakSec: 21, bestJoshStreakSec: 4, bestCleanMeters: 180, stumbles: 1 }), ctx: FULL, run: { day: DAY, sessionRun: 2, previousDistance: 620 }, daily: true, today: DAY });
    show({ model: boardModel(s) });
    break;
  }
  case 'board-complete': {
    // One mission finished this run and sits there ticked until the board refreshes.
    const s = store({ coins: 610, score: 5200 });
    s.recordRun({
      // A clean run finishes one mission; the other two only inch forward.
      counters: counters({ steps: 480, jumps: 34, rolls: 16, laneChanges: 8, distance: 1480, coins: 96, score: 1576, timeSec: 138, bestJogStreakSec: 96, bestJoshStreakSec: 6, bestCleanMeters: 720, hoverboardSec: 26, magnetCoinsBest: 14, stumbles: 0 }),
      ctx: FULL,
      run: { day: DAY, sessionRun: 3, previousDistance: 900 },
      today: DAY,
    });
    show({ model: boardModel(s) });
    break;
  }
  case 'board-fresh': {
    const s = store({ ctx: FULL });
    show({ model: boardModel(s) });
    break;
  }
  case 'daily-done': {
    const s = store({ coins: 900, score: 9000 });
    s.recordRun({
      counters: counters({ distance: 2100, coins: 120, score: 2220, timeSec: 190, steps: 620, jumps: 40, laneChanges: 70, bestJogStreakSec: 130, bestCleanMeters: 1100 }),
      ctx: FULL,
      run: { day: DAY, sessionRun: 4, previousDistance: 1500 },
      daily: true,
      today: DAY,
    });
    show({ model: boardModel(s) });
    break;
  }
  case 'summary': {
    const s = store({ coins: 400, score: 3000, runs: [counters({ steps: 300, jumps: 21, laneChanges: 44, distance: 980, coins: 55, score: 1035, timeSec: 92, bestJogStreakSec: 70, bestCleanMeters: 480 })] });
    const list = renderMissionList(missionViews(s.state.missions), { title: 'Mission progress' });
    list.style.width = 'min(470px, 92vw)';
    show({ extra: list });
    break;
  }
  case 'toast': {
    const s = store({ coins: 200, runs: [counters({ steps: 210, jumps: 12, laneChanges: 30, distance: 700, coins: 40, score: 740, timeSec: 70, bestJogStreakSec: 44 })] });
    const views = missionViews(s.state.missions).filter((v) => !v.done);
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px';
    for (const v of views.slice(0, 2)) box.append(renderMissionToast(v));
    box.append(renderMissionToast({ ...(views[0] as MissionView), done: true, progress: views[0].target, frac: 1, text: 'Done!' }));
    show({ extra: box });
    break;
  }
  case 'shop':
  case 'shop-poor':
  case 'shop-rich': {
    const coins = state === 'shop-poor' ? 60 : state === 'shop-rich' ? 3000 : 560;
    const s = store({ coins, score: 4200, owned: state === 'shop-poor' ? [] : ['runner-college', 'board-neon', 'magnet-boost'], equip: state === 'shop-poor' ? undefined : 'runner-college' });
    live = s;
    paint = () => shop.update(shopModel(s.state));
    show({ shop: shopModel(s.state) });
    break;
  }
  case 'small-room': {
    const s = store({ ctx: SMALL, coins: 280, score: 1800, runs: [counters({ steps: 140, jumps: 9, laneChanges: 12, distance: 520, coins: 26, score: 546, timeSec: 55, bestJogStreakSec: 36, bestCleanMeters: 240 })] });
    show({ model: boardModel(s) });
    break;
  }
  case 'keyboard': {
    const s = store({ ctx: KEYBOARD, coins: 150, score: 900, runs: [counters({ jumps: 11, rolls: 5, laneChanges: 26, distance: 440, coins: 22, score: 462, timeSec: 44 })] });
    show({ model: boardModel(s) });
    break;
  }
}
