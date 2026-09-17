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
      return 'Press Enter to start · ←/→ lanes · ↑ jump · ↓ roll · Space hoverboard';
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

export function hudModel(g: Game): HudModel {
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
  };
}

// ---------------------------------------------------------------- DOM

const el = (tag: string, cls: string, parent: HTMLElement, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
};

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
    const cta = el('div', 'hud-cta', menu);
    el('span', 'hud-cta-text', cta, 'PRESS ENTER');
    el('span', 'hud-cta-sep', cta, '/');
    el('span', 'hud-cta-text', cta, 'RAISE HAND ✋');
    const bottom = el('div', 'hud-menu-bottom', menu);
    el('div', 'hud-menu-foot', bottom, 'Jog in place to run · jog fast to fill JOSH for ×2 coins');
    const controls = el('div', 'hud-controls', bottom);
    const control = (keys: string[], label: string) => {
      const c = el('div', 'hud-control', controls);
      const k = el('div', 'hud-keys', c);
      for (const key of keys) el('span', 'hud-key', k, key);
      el('span', 'hud-control-label', c, label);
    };
    control(['←', '→'], 'Lanes');
    control(['↑'], 'Jump');
    control(['↓'], 'Roll');
    control(['Space'], 'Hoverboard');
    control(['Esc'], 'Pause');

    // Countdown: one element per digit, so showing it restarts its CSS animation.
    const count = el('div', 'hud-screen hud-count', root);
    for (const n of ['3', '2', '1']) this.countNums.set(n, el('div', 'hud-count-num', count, n));
    el('div', 'hud-count-sub', count, 'Get ready to jog!');

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
    const again = el('div', 'hud-again', card);
    el('span', 'hud-again-text', again, 'PLAY AGAIN');
    el('div', 'hud-again-hint', card, 'Press Enter or raise your hand');
    this.sum = { score: sumScore, coins: sumCoins, distance: sumDist, jumps: sumJumps, rolls: sumRolls, time: sumTime };

    // Paused.
    const paused = el('div', 'hud-screen hud-paused', root);
    this.pauseIcon = el('div', 'hud-pause-icon', paused);
    this.pauseTitle = el('div', 'hud-pause-title', paused);
    this.pauseSub = el('div', 'hud-pause-sub', paused);
  }

  update(g: Game): void {
    const m = hudModel(g);
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
    if (m.state === 'summary') {
      const s = m.summary;
      for (const key of Object.keys(this.sum) as (keyof HudSummary)[]) this.text(this.sum[key], s[key]);
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
