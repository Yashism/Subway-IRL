import type { Profile, RecordResult } from '../app/profile';
import { TUNING } from '../game/config';
import type { CaughtReason, Game, GameState } from '../game/game';

export type TimerKind = 'magnet' | 'rocket' | 'chappal' | 'hoverboard';

export interface PowerupTimer {
  kind: TimerKind;
  icon: string;
  label: string;
  /** Whole seconds left, for display. */
  seconds: number;
  /** Remaining fraction 0..1 (drives the depleting bar). */
  frac: number;
}

export interface HudSummary {
  score: string;
  coins: string;
  distance: string;
  jumps: string;
  rolls: string;
  time: string;
}

export interface HudProfileModel {
  /** "BEST 1,500" under the score during a run; '' before any best exists. */
  best: string;
  /** The current run has beaten the stored best. */
  beatBest: boolean;
  /** Menu pills ("Best score 1,500", lifetime coins "12,345"); '' before any recorded run. */
  menuBest: string;
  menuCoins: string;
  /** Summary: the finished run set a new best. */
  newBest: boolean;
  /** Summary: "Previous best N" on a new best, else "Best: N". */
  summaryBest: string;
  lifetime: { runs: string; coins: string; distance: string };
}

/** What the HUD knows about the saved profile (see Hud.setProfile). */
export interface HudProfileView {
  profile: Readonly<Profile> | null;
  /** Result of recording the run that just ended, or null if it was not recorded. */
  last: RecordResult | null;
}

export interface HudModel {
  state: GameState;
  score: string;
  coins: string;
  speed: string;
  center: string;
  sub: string;
  powerups: string[];
  timers: PowerupTimer[];
  hoverboards: number;
  /** Josh meter fill, 0..1. */
  josh: number;
  joshActive: boolean;
  /** "×2" while Josh is active, else "". */
  multiplier: string;
  /** Show the "GO!" flash (first moments of a run). */
  go: boolean;
  /** Stopped jogging: flash the screen edges. */
  danger: boolean;
  summary: HudSummary;
  profile: HudProfileModel;
}

const CAUGHT_TEXT: Record<CaughtReason, string> = {
  crash: 'You crashed',
  stumble: 'Two stumbles in a row',
  idle: 'You stopped jogging',
};

const TIMERS: { kind: TimerKind; icon: string; label: string; total: number }[] = [
  { kind: 'magnet', icon: '🧲', label: 'Magnet', total: TUNING.magnetSeconds },
  { kind: 'rocket', icon: '🚀', label: 'Rocket', total: TUNING.rocketSeconds },
  { kind: 'chappal', icon: '🩴', label: 'Chappals', total: TUNING.chappalSeconds },
  { kind: 'hoverboard', icon: '🛹', label: 'Hoverboard', total: TUNING.hoverboardSeconds },
];

function centerText(g: Game): string {
  switch (g.state) {
    case 'menu':
      return 'Subway IRL';
    case 'countdown':
      return String(Math.max(1, Math.ceil(g.countdown - 1e-9)));
    case 'paused':
      return g.pausedByLoss ? 'Step back into frame' : 'Paused';
    case 'caught':
      return 'Pakda gaya!';
    case 'summary':
      return `Score ${g.stats.score}`;
    default:
      return g.idleLevel === 'warn' ? 'Bhaago!' : '';
  }
}

function subText(g: Game): string {
  switch (g.state) {
    case 'menu':
      return 'Press Enter to start · ←/→ lanes · Space jump · S/↓ duck · Ctrl hoverboard';
    case 'paused':
      return g.pausedByLoss ? 'Stand where the camera can see you' : 'Press Enter to resume';
    case 'caught':
      return g.caughtReason ? CAUGHT_TEXT[g.caughtReason] : '';
    case 'summary': {
      const s = g.stats;
      return `₹${s.coins} · ${Math.floor(s.distance)} m · ${s.jumps} jumps · ${s.rolls} rolls · Enter to play again`;
    }
    default:
      return '';
  }
}

const powerupLeft = (g: Game, kind: TimerKind): number => g.powerups[kind];

const fmtTime = (sec: number): string => {
  const t = Math.floor(sec);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** 12345 → "12,345". */
export const fmtInt = (n: number): string => String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const NO_PROFILE: HudProfileModel = Object.freeze({
  best: '',
  beatBest: false,
  menuBest: '',
  menuCoins: '',
  newBest: false,
  summaryBest: '',
  lifetime: Object.freeze({ runs: '', coins: '', distance: '' }),
});

function profileModel(g: Game, view: HudProfileView | undefined): HudProfileModel {
  const p = view?.profile;
  if (!p) return NO_PROFILE;
  const hasBest = p.bestScore > 0;
  const last = view.last;
  const newBest = g.state === 'summary' && !!last?.newBest;
  let summaryBest = '';
  if (newBest && last) summaryBest = last.previousBest > 0 ? `Previous best ${fmtInt(last.previousBest)}` : 'First score on the board!';
  else if (hasBest) summaryBest = `Best: ${fmtInt(p.bestScore)}`;
  const played = p.totalRuns > 0;
  return {
    best: hasBest ? `BEST ${fmtInt(p.bestScore)}` : '',
    beatBest: hasBest && g.stats.score > p.bestScore,
    menuBest: hasBest ? `Best score ${fmtInt(p.bestScore)}` : '',
    menuCoins: played ? fmtInt(p.totalCoins) : '',
    newBest,
    summaryBest,
    lifetime: played
      ? { runs: fmtInt(p.totalRuns), coins: fmtInt(p.totalCoins), distance: `${(p.totalDistance / 1000).toFixed(1)} km` }
      : NO_PROFILE.lifetime,
  };
}

export function hudModel(g: Game, view?: HudProfileView): HudModel {
  const p = g.powerups;
  const timers: PowerupTimer[] = [];
  for (const t of TIMERS) {
    const left = powerupLeft(g, t.kind);
    if (left > 0) timers.push({ kind: t.kind, icon: t.icon, label: t.label, seconds: Math.ceil(left), frac: Math.min(1, left / t.total) });
  }
  const s = g.stats;
  return {
    state: g.state,
    score: String(s.score),
    coins: `₹${s.coins}`,
    speed: `${g.speed.toFixed(0)} m/s`,
    center: centerText(g),
    sub: subText(g),
    powerups: timers.map((t) => `${t.icon} ${t.label} ${t.seconds}s`),
    timers,
    hoverboards: p.hoverboardsLeft,
    josh: g.josh.value,
    joshActive: g.josh.active,
    multiplier: g.josh.active ? '×2' : '',
    go: g.state === 'playing' && g.time < 0.7,
    danger: g.state === 'playing' && g.idleLevel === 'warn',
    summary: {
      score: String(s.score),
      coins: String(s.coins),
      distance: `${Math.floor(s.distance)} m`,
      jumps: String(s.jumps),
      rolls: String(s.rolls),
      time: fmtTime(s.timeSec),
    },
    profile: profileModel(g, view),
  };
}

export interface InputNoticeState {
  input: 'webcam' | 'keyboard';
  /** A camera (or pose replay) is feeding the pose pipeline. */
  cameraReady: boolean;
  /** Name of the pose replay, '' for a real camera. */
  replay: string;
  autopilot: boolean;
  /** Why the game fell back to the keyboard, '' if it did not. */
  fallback: string;
}

/** The menu's input line: what controls the game right now. */
export function menuNotice(s: InputNoticeState): string {
  if (s.autopilot) return 'Autopilot demo';
  if (s.input === 'keyboard') return s.fallback ? `${s.fallback} · playing with the keyboard` : 'Keyboard play · the webcam is off';
  if (s.replay) return `Pose replay “${s.replay}” · press Enter`;
  if (s.cameraReady) return 'Webcam ready · raise your right hand to start';
  return 'Webcam play · press Enter to set up your camera · keys work too';
}

/** Where the live monitor lives; the named window is reused by the link and the M key. */
export const MONITOR_URL = 'monitor.html';
export const MONITOR_WINDOW = 'subway-irl-monitor';
/** A real popup, not a tab: a tab would hide the game and pause the run behind it. */
export const MONITOR_FEATURES = 'popup=yes,width=1280,height=900';

/**
 * Opens (or re-focuses) the live monitor in its own window. Returns false when the popup was
 * blocked. Never opens a tab: `visibilitychange` would pause the very run being watched.
 */
export function openMonitorWindow(): boolean {
  return window.open(MONITOR_URL, MONITOR_WINDOW, MONITOR_FEATURES) !== null;
}

// ---------------------------------------------------------------- DOM

const el = (tag: string, cls: string, parent: HTMLElement, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
};

/** "Live monitor (M)": opens monitor.html in its own popup window. */
function monitorLink(parent: HTMLElement): HTMLAnchorElement {
  const a = el('a', 'hud-monitor-link', parent, '📈 Live monitor (M)') as HTMLAnchorElement;
  a.href = MONITOR_URL;
  a.target = MONITOR_WINDOW;
  a.title = 'Open the live monitor in a separate window to watch what the game sees';
  a.addEventListener('click', (e) => {
    // A plain navigation would open a tab and hide the game; and the focused link would swallow
    // the next Enter. Open the popup by hand and drop focus, like every PoseScreens button.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    a.blur();
    openMonitorWindow();
  });
  return a;
}

interface TimerRow {
  row: HTMLElement;
  fill: HTMLElement;
  secs: HTMLElement;
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scale-pop (1 → 1.3 → 1 over ~0.15 s) via WAAPI, so nothing forces a reflow. */
function pop(e: HTMLElement, scale = 1.3, ms = 160): void {
  if (reducedMotion() || typeof e.animate !== 'function') return;
  e.animate([{ transform: 'scale(1)' }, { transform: `scale(${scale})` }, { transform: 'scale(1)' }], {
    duration: ms,
    easing: 'ease-out',
  });
}

/**
 * Game HUD in the Subway Surfers layout (STYLE.md §5): score and coins top right,
 * power-up timers and hoverboards top left, Josh ×2 badge beside the score, and
 * full-screen cards for menu / countdown / caught / summary / paused.
 * Writes to the DOM only when a value changes; dynamic data only via textContent.
 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly score: HTMLElement;
  private readonly coinPill: HTMLElement;
  private readonly coins: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly boardsPill: HTMLElement;
  private readonly boards: HTMLElement;
  private readonly josh: HTMLElement;
  private readonly joshLabel: HTMLElement;
  private readonly timers = new Map<TimerKind, TimerRow>();
  private readonly warn: HTMLElement;
  private readonly go: HTMLElement;
  private readonly countNums = new Map<string, HTMLElement>();
  private readonly caughtReason: HTMLElement;
  private readonly pauseTitle: HTMLElement;
  private readonly pauseSub: HTMLElement;
  private readonly pauseIcon: HTMLElement;
  private readonly sum: Record<keyof HudSummary, HTMLElement>;
  private readonly best: HTMLElement;
  private readonly menuStats: HTMLElement;
  private readonly menuBest: HTMLElement;
  private readonly menuCoins: HTMLElement;
  private readonly newBest: HTMLElement;
  private readonly cardBest: HTMLElement;
  private readonly life: HTMLElement;
  private readonly lifeVals: Record<keyof HudProfileModel['lifetime'], HTMLElement>;
  private readonly view: HudProfileView = { profile: null, last: null };
  private readonly menuFoot: HTMLElement;

  private readonly lastText = new Map<HTMLElement, string>();
  private readonly lastStyle = new Map<string, string>();
  private lastCoins = -1;
  private lastBoards = -1;
  private lastState = '';

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('hud');
    this.vignette = el('div', 'hud-vignette', root);

    // Top left: hoverboards + power-up timers.
    const tl = el('div', 'hud-tl hud-play', root);
    this.boardsPill = el('div', 'hud-pill hud-boards', tl);
    el('span', 'hud-boards-icon', this.boardsPill, '🛹');
    this.boards = el('span', 'hud-pill-val', this.boardsPill);
    const stack = el('div', 'hud-timers', tl);
    for (const t of TIMERS) {
      const row = el('div', `hud-timer hud-timer-${t.kind}`, stack);
      el('div', 'hud-timer-icon', row, t.icon);
      const body = el('div', 'hud-timer-body', row);
      const head = el('div', 'hud-timer-head', body);
      el('span', 'hud-timer-label', head, t.label);
      const secs = el('span', 'hud-timer-secs', head);
      const bar = el('div', 'hud-timer-bar', body);
      const fill = el('div', 'hud-timer-fill', bar);
      this.timers.set(t.kind, { row, fill, secs });
    }

    // Top right: josh badge + score, coin pill, speed.
    const tr = el('div', 'hud-tr hud-play', root);
    const scoreRow = el('div', 'hud-score-row', tr);
    this.josh = el('div', 'hud-josh', scoreRow);
    el('div', 'hud-josh-ring', this.josh);
    el('div', 'hud-josh-core', this.josh, '🔥');
    this.joshLabel = el('div', 'hud-josh-x', this.josh, '×2');
    this.score = el('div', 'hud-score', scoreRow);
    this.best = el('div', 'hud-best', tr);
    this.coinPill = el('div', 'hud-pill hud-coins', tr);
    const coinIcon = el('span', 'hud-coin', this.coinPill);
    el('span', 'hud-coin-glyph', coinIcon, '₹');
    this.coins = el('span', 'hud-pill-val', this.coinPill);
    this.speed = el('div', 'hud-speed', tr);

    this.warn = el('div', 'hud-warn', root);
    this.go = el('div', 'hud-go', root, 'GO!');

    // Menu.
    const menu = el('div', 'hud-screen hud-menu', root);
    const logo = el('div', 'hud-logo', menu);
    el('div', 'hud-logo-top', logo, 'SUBWAY');
    el('div', 'hud-logo-big', logo, 'IRL');
    el('div', 'hud-ribbon', menu, 'Run for real. Bhaago!');
    this.menuStats = el('div', 'hud-menu-stats', menu);
    const bestPill = el('div', 'hud-pill hud-menu-pill hud-menu-best', this.menuStats);
    el('span', 'hud-menu-pill-icon', bestPill, '🏆');
    this.menuBest = el('span', 'hud-menu-pill-text', bestPill);
    const coinPill = el('div', 'hud-pill hud-menu-pill hud-menu-coins', this.menuStats);
    el('span', 'hud-coin-glyph', el('span', 'hud-coin', coinPill), '₹');
    this.menuCoins = el('span', 'hud-menu-pill-text', coinPill);
    el('span', 'hud-menu-pill-unit', coinPill, 'coins');
    const cta = el('div', 'hud-cta', menu);
    el('span', 'hud-cta-text', cta, 'PRESS ENTER');
    const bottom = el('div', 'hud-menu-bottom', menu);
    const foot = el('div', 'hud-menu-foot', bottom);
    this.menuFoot = el('span', 'hud-menu-foot-text', foot, 'Press Enter to start');
    monitorLink(foot);
    const controls = el('div', 'hud-controls', bottom);
    const control = (keys: string[], label: string) => {
      const c = el('div', 'hud-control', controls);
      const k = el('div', 'hud-keys', c);
      for (const key of keys) el('span', 'hud-key', k, key);
      el('span', 'hud-control-label', c, label);
    };
    control(['←', '→'], 'Lanes');
    control(['Space'], 'Jump');
    control(['S', '↓'], 'Duck');
    control(['Ctrl'], 'Hoverboard');
    control(['Esc'], 'Pause');

    // Countdown: one element per digit, so showing it restarts its CSS animation.
    const count = el('div', 'hud-screen hud-count', root);
    for (const n of ['3', '2', '1']) this.countNums.set(n, el('div', 'hud-count-num', count, n));
    el('div', 'hud-count-sub', count, 'Get ready!');

    // Caught.
    const caught = el('div', 'hud-screen hud-caught', root);
    el('div', 'hud-flash', caught);
    el('div', 'hud-stamp', caught, 'PAKDA GAYA!');
    this.caughtReason = el('div', 'hud-caught-reason', caught);

    // Summary card.
    const summary = el('div', 'hud-screen hud-summary', root);
    const card = el('div', 'hud-card', summary);
    el('div', 'hud-card-title', card, 'RUN OVER');
    el('div', 'hud-card-label', card, 'SCORE');
    const sumScore = el('div', 'hud-card-score', card);
    this.newBest = el('div', 'hud-newbest', card, 'NEW BEST!');
    this.cardBest = el('div', 'hud-card-best', card);
    const grid = el('div', 'hud-card-grid', card);
    const tile = (icon: string, label: string, cls: string): HTMLElement => {
      const t = el('div', `hud-tile ${cls}`, grid);
      el('div', 'hud-tile-icon', t, icon);
      const v = el('div', 'hud-tile-val', t);
      el('div', 'hud-tile-label', t, label);
      return v;
    };
    const sumCoins = tile('₹', 'Coins', 'hud-tile-coins');
    const sumDist = tile('📏', 'Distance', 'hud-tile-dist');
    const sumJumps = tile('⤴', 'Jumps', 'hud-tile-jumps');
    const sumRolls = tile('⤵', 'Rolls', 'hud-tile-rolls');
    const timeRow = el('div', 'hud-card-time', card);
    el('span', '', timeRow, 'Time ');
    const sumTime = el('span', 'hud-card-time-val', timeRow);
    this.life = el('div', 'hud-card-life', card);
    el('div', 'hud-card-life-title', this.life, 'All time');
    const lifeRow = el('div', 'hud-card-life-row', this.life);
    const lifeItem = (label: string): HTMLElement => {
      const item = el('div', 'hud-life-item', lifeRow);
      const v = el('div', 'hud-life-val', item);
      el('div', 'hud-life-label', item, label);
      return v;
    };
    this.lifeVals = { runs: lifeItem('Runs'), coins: lifeItem('Coins ₹'), distance: lifeItem('Distance') };
    const again = el('div', 'hud-again', card);
    el('span', 'hud-again-text', again, 'PLAY AGAIN');
    el('div', 'hud-again-hint', card, 'Press Enter to run again');
    this.sum = { score: sumScore, coins: sumCoins, distance: sumDist, jumps: sumJumps, rolls: sumRolls, time: sumTime };

    // Paused.
    const paused = el('div', 'hud-screen hud-paused', root);
    this.pauseIcon = el('div', 'hud-pause-icon', paused);
    this.pauseTitle = el('div', 'hud-pause-title', paused);
    this.pauseSub = el('div', 'hud-pause-sub', paused);
    monitorLink(paused);
  }

  /** The menu's input line (see menuNotice). */
  setInputNotice(text: string): void {
    this.text(this.menuFoot, text);
  }

  /**
   * Hands the HUD the saved profile and the result of recording the run that just
   * ended (null when that run was not recorded, e.g. an autopilot demo).
   */
  setProfile(profile: Readonly<Profile> | null, lastResult: RecordResult | null = null): void {
    this.view.profile = profile;
    this.view.last = lastResult;
  }

  update(g: Game): void {
    const m = hudModel(g, this.view);
    if (m.state !== this.lastState) {
      this.lastState = m.state;
      this.root.dataset.state = m.state;
    }

    this.text(this.score, m.score);
    this.text(this.coins, String(g.stats.coins));
    this.text(this.speed, m.speed);
    this.text(this.boards, `×${m.hoverboards}`);
    this.flag(this.boardsPill, 'empty', m.hoverboards <= 0);
    if (g.stats.coins !== this.lastCoins) {
      if (g.stats.coins > this.lastCoins && this.lastCoins >= 0) pop(this.coinPill, 1.18, 150);
      this.lastCoins = g.stats.coins;
    }
    if (m.hoverboards !== this.lastBoards) {
      if (m.hoverboards < this.lastBoards) pop(this.boardsPill, 1.25, 220);
      this.lastBoards = m.hoverboards;
    }

    for (const [kind, row] of this.timers) {
      const t = m.timers.find((x) => x.kind === kind);
      this.flag(row.row, 'on', !!t);
      if (!t) continue;
      this.text(row.secs, `${t.seconds}s`);
      this.flag(row.row, 'low', t.seconds <= 3);
      this.style(row.fill, `timer-${kind}`, 'transform', `scaleX(${t.frac.toFixed(3)})`);
    }

    this.style(this.josh, 'josh', '--josh', m.josh.toFixed(3));
    this.flag(this.josh, 'active', m.joshActive);
    this.text(this.joshLabel, m.multiplier || '×2');

    this.flag(this.vignette, 'danger', m.danger);
    this.text(this.warn, g.state === 'playing' ? m.center : '');
    this.flag(this.warn, 'on', g.state === 'playing' && m.center !== '');
    this.flag(this.go, 'on', m.go);

    if (m.state === 'countdown') for (const [n, e] of this.countNums) this.flag(e, 'on', n === m.center);
    if (m.state === 'caught') this.text(this.caughtReason, m.sub);
    if (m.state === 'paused') {
      this.text(this.pauseTitle, m.center);
      this.text(this.pauseSub, m.sub);
      this.text(this.pauseIcon, g.pausedByLoss ? '📷' : '');
      this.flag(this.pauseIcon, 'lost', g.pausedByLoss);
    }
    const pm = m.profile;
    this.text(this.best, pm.best);
    this.flag(this.best, 'beat', pm.beatBest);
    if (m.state === 'menu') {
      this.text(this.menuBest, pm.menuBest);
      this.text(this.menuCoins, pm.menuCoins);
      this.flag(this.menuStats, 'on', pm.menuBest !== '' || pm.menuCoins !== '');
    }
    if (m.state === 'summary') {
      const s = m.summary;
      for (const key of Object.keys(this.sum) as (keyof HudSummary)[]) this.text(this.sum[key], s[key]);
      this.flag(this.newBest, 'on', pm.newBest);
      this.text(this.cardBest, pm.summaryBest);
      this.flag(this.cardBest, 'record', pm.newBest);
      this.flag(this.life, 'on', pm.lifetime.runs !== '');
      for (const key of Object.keys(this.lifeVals) as (keyof HudProfileModel['lifetime'])[]) this.text(this.lifeVals[key], pm.lifetime[key]);
    }
  }

  private text(e: HTMLElement, value: string): void {
    if (this.lastText.get(e) === value) return;
    this.lastText.set(e, value);
    e.textContent = value;
  }

  private style(e: HTMLElement, key: string, prop: string, value: string): void {
    if (this.lastStyle.get(key) === value) return;
    this.lastStyle.set(key, value);
    e.style.setProperty(prop, value);
  }

  private readonly flags = new Map<HTMLElement, Map<string, boolean>>();

  private flag(e: HTMLElement, cls: string, on: boolean): void {
    let m = this.flags.get(e);
    if (!m) {
      m = new Map();
      this.flags.set(e, m);
    }
    if (m.get(cls) === on) return;
    m.set(cls, on);
    e.classList.toggle(cls, on);
  }
}
