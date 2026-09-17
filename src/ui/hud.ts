import type { CaughtReason, Game } from '../game/game';

export interface HudModel {
  score: string;
  coins: string;
  speed: string;
  center: string;
  sub: string;
  powerups: string[];
  hoverboards: number;
  /** Josh meter fill, 0..1. */
  josh: number;
  joshActive: boolean;
  /** Stopped jogging: flash the screen edges. */
  danger: boolean;
}

const CAUGHT_TEXT: Record<CaughtReason, string> = {
  crash: 'You crashed',
  stumble: 'Two stumbles in a row',
  idle: 'You stopped jogging',
};

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
      return g.pausedByLoss ? '' : 'Press Enter to resume';
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

export function hudModel(g: Game): HudModel {
  const p = g.powerups;
  const timers: [string, number][] = [
    ['🧲 Magnet', p.magnet],
    ['🚀 Rocket', p.rocket],
    ['🩴 Chappals', p.chappal],
    ['🛹 Hoverboard', p.hoverboard],
  ];
  return {
    score: String(g.stats.score),
    coins: `₹${g.stats.coins}`,
    speed: `${g.speed.toFixed(0)} m/s`,
    center: centerText(g),
    sub: subText(g),
    powerups: timers.filter(([, t]) => t > 0).map(([name, t]) => `${name} ${Math.ceil(t)}s`),
    hoverboards: p.hoverboardsLeft,
    josh: g.josh.value,
    joshActive: g.josh.active,
    danger: g.state === 'playing' && g.idleLevel === 'warn',
  };
}

const el = (tag: string, cls: string, parent: HTMLElement): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  parent.append(e);
  return e;
};

/** Minimal DOM HUD. Writes to the DOM only when a value changes. */
export class Hud {
  private readonly vignette: HTMLElement;
  private readonly score: HTMLElement;
  private readonly coins: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly center: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly powerups: HTMLElement;
  private readonly boards: HTMLElement;
  private readonly josh: HTMLElement;
  private readonly joshFill: HTMLElement;
  private last = new Map<HTMLElement, string>();

  constructor(root: HTMLElement) {
    this.vignette = el('div', 'hud-vignette', root);
    const top = el('div', 'hud-top', root);
    this.powerups = el('div', 'hud-powerups', top);
    const right = el('div', 'hud-right', top);
    this.score = el('div', 'hud-score', right);
    this.coins = el('div', 'hud-coins', right);
    this.speed = el('div', 'hud-speed', right);
    this.boards = el('div', 'hud-boards', right);
    this.center = el('div', 'hud-center', root);
    this.sub = el('div', 'hud-sub', root);
    this.josh = el('div', 'hud-josh', root);
    this.joshFill = el('div', 'hud-josh-fill', this.josh);
    el('span', 'hud-josh-label', this.josh).textContent = 'JOSH';
  }

  update(g: Game): void {
    const m = hudModel(g);
    this.text(this.score, m.score);
    this.text(this.coins, m.coins);
    this.text(this.speed, m.speed);
    this.text(this.center, m.center);
    this.text(this.sub, m.sub);
    this.text(this.powerups, m.powerups.join('\n'));
    this.text(this.boards, `🛹 × ${m.hoverboards}`);
    this.joshFill.style.transform = `scaleX(${m.josh.toFixed(3)})`;
    this.josh.classList.toggle('active', m.joshActive);
    this.vignette.classList.toggle('danger', m.danger);
    this.center.classList.toggle('big', g.state === 'countdown' || g.state === 'menu');
  }

  private text(e: HTMLElement, value: string): void {
    if (this.last.get(e) === value) return;
    this.last.set(e, value);
    e.textContent = value;
  }
}
