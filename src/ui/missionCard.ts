/**
 * The mission board: the three active missions and the daily challenge, as they appear on the
 * menu and on the summary card, plus the small live toast the HUD shows when progress moves.
 *
 * Render-only. Everything it draws comes from `MissionView` / `DailyView` (src/app/progression.ts),
 * so the screens know nothing about the game, the wallet or storage.
 */

import './missions.css';
import type { MissionView } from '../game/missions';
import type { DailyView } from '../app/progression';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: ParentNode, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
};

/** A button that lets go of focus, so the next Enter reaches the game and not this button. */
export function missionButton(parent: ParentNode, cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, parent, label);
  b.type = 'button';
  b.addEventListener('click', () => {
    b.blur();
    onClick();
  });
  return b;
}

/** 0..1, never NaN: a bar must not run off its track or vanish on bad input. */
export const clampFrac = (v: number): number => (typeof v === 'number' && !Number.isNaN(v) ? Math.min(1, Math.max(0, v)) : 0);

export const pct = (v: number): string => `${Math.round(clampFrac(v) * 100)}%`;

// ---------------------------------------------------------------- one mission row

export interface MissionRowOptions {
  /** Show the coin reward chip. Default true. */
  reward?: boolean;
}

export function renderMissionRow(m: MissionView, opts: MissionRowOptions = {}): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ms-row';
  row.dataset.state = m.done ? 'done' : m.frac > 0 ? 'going' : 'new';
  row.dataset.group = m.group;

  const icon = el('div', 'ms-row-icon', row);
  el('span', 'ms-row-glyph', icon, m.done ? '✓' : m.icon);

  const body = el('div', 'ms-row-body', row);
  const head = el('div', 'ms-row-head', body);
  el('div', 'ms-row-label', head, m.label);
  if (opts.reward !== false) {
    const chip = el('div', 'ms-row-reward', head);
    el('span', 'ms-coin', chip, '₹');
    el('span', 'ms-row-reward-n', chip, String(m.reward));
  }

  const bar = el('div', 'ms-bar', body);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(m.target));
  bar.setAttribute('aria-valuenow', String(m.progress));
  bar.setAttribute('aria-label', m.label);
  const fill = el('div', 'ms-bar-fill', bar);
  fill.style.width = pct(m.frac);
  el('div', 'ms-row-count', body, m.text);
  return row;
}

// ---------------------------------------------------------------- the list

export interface MissionListOptions {
  title?: string;
  /** Shown when there are no missions at all. */
  empty?: string;
  reward?: boolean;
}

/** The three active missions. Detached and self-contained: the menu and the summary share it. */
export function renderMissionList(missions: readonly MissionView[], opts: MissionListOptions = {}): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ms-card ms-list';
  const head = el('div', 'ms-head', card);
  el('div', 'ms-head-title', head, opts.title ?? 'Missions');
  const doneCount = missions.filter((m) => m.done).length;
  el('div', 'ms-head-note', head, missions.length ? `${doneCount} of ${missions.length} done` : '');

  const rows = el('div', 'ms-rows', card);
  if (!missions.length) {
    el('div', 'ms-empty', rows, opts.empty ?? 'Take a run and the board fills up.');
    return card;
  }
  for (const m of missions) rows.append(renderMissionRow(m, { reward: opts.reward }));
  return card;
}

// ---------------------------------------------------------------- the daily challenge

export interface DailyCardOptions {
  /** The "Run it" button; omitted leaves the card read-only (the summary). */
  onPlay?(): void;
  playLabel?: string;
}

export function renderDailyCard(d: DailyView, opts: DailyCardOptions = {}): HTMLElement {
  const card = document.createElement('div');
  card.className = 'ms-card ms-daily';
  card.dataset.state = d.done ? 'done' : 'open';

  const head = el('div', 'ms-head', card);
  el('div', 'ms-head-title', head, 'Daily challenge');
  const streak = el('div', 'ms-streak', head);
  streak.dataset.on = d.streak > 0 ? 'on' : 'off';
  el('span', 'ms-streak-flame', streak, '');
  el('span', 'ms-streak-text', streak, d.streakText);

  const body = el('div', 'ms-daily-body', card);
  el('div', 'ms-daily-title', body, d.title);
  el('div', 'ms-daily-goal', body, d.goal);

  const bar = el('div', 'ms-bar ms-bar-big', body);
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', String(d.goalMeters));
  bar.setAttribute('aria-valuenow', String(Math.round(clampFrac(d.frac) * d.goalMeters)));
  bar.setAttribute('aria-label', `${d.title}: ${d.goal}`);
  const fill = el('div', 'ms-bar-fill', bar);
  fill.style.width = pct(d.frac);

  const foot = el('div', 'ms-daily-foot', card);
  el('div', 'ms-daily-count', foot, d.progressText);
  // Today's coins are paid once. Once they have been, the chip says so instead of advertising a
  // reward the next run will not pay — a player who runs 1,200 m again for nothing cannot tell
  // that apart from the game losing their coins.
  const chip = el('div', 'ms-row-reward', foot);
  chip.dataset.claimed = d.done ? 'yes' : 'no';
  el('span', 'ms-coin', chip, '₹');
  el('span', 'ms-row-reward-n', chip, d.done ? 'Claimed' : String(d.coins));
  if (opts.onPlay) missionButton(foot, 'ms-btn ms-btn-go', opts.playLabel ?? (d.done ? 'Run it again' : 'Run it'), opts.onPlay);
  return card;
}

// ---------------------------------------------------------------- the live toast

/**
 * The one line the HUD flashes when a mission moves. Progress is visible live only when it
 * changes — never as permanent clutter — so this is a detached node the caller shows and drops.
 */
export function renderMissionToast(m: MissionView): HTMLElement {
  const t = document.createElement('div');
  t.className = 'ms-toast';
  t.dataset.state = m.done ? 'done' : 'going';
  el('span', 'ms-toast-icon', t, m.done ? '🏅' : m.icon);
  const body = el('span', 'ms-toast-body', t);
  el('span', 'ms-toast-label', body, m.done ? 'Mission complete!' : m.label);
  el('span', 'ms-toast-count', body, m.done ? `${m.label} · +₹${m.reward}` : m.text);
  return t;
}

// ---------------------------------------------------------------- the menu panel

export interface MissionBoardModel {
  missions: readonly MissionView[];
  daily: DailyView | null;
  /** "LEVEL 4" and the bar under it; omit to hide the level strip. */
  level?: { text: string; sub: string; frac: number };
  /** Coins in the wallet, formatted. */
  coins?: string;
}

export interface MissionBoardHandlers {
  onPlayDaily?(): void;
  onShop?(): void;
}

/**
 * The menu's mission panel. Rebuilds only when the model actually differs, so it can be handed
 * a fresh model every frame without dirtying layout.
 */
export class MissionBoard {
  private readonly root: HTMLElement;
  private readonly handlers: MissionBoardHandlers;
  private key = '';

  constructor(root: HTMLElement, handlers: MissionBoardHandlers = {}) {
    this.root = root;
    this.handlers = handlers;
    root.classList.add('ms-board');
  }

  update(m: MissionBoardModel | null): void {
    const key = JSON.stringify(m);
    if (key === this.key) return;
    this.key = key;
    if (!m) {
      this.root.replaceChildren();
      this.root.dataset.on = 'off';
      return;
    }
    this.root.dataset.on = 'on';
    const frag = document.createDocumentFragment();

    if (m.level || m.coins !== undefined) {
      const strip = el('div', 'ms-card ms-level', frag);
      const head = el('div', 'ms-level-head', strip);
      el('div', 'ms-level-text', head, m.level?.text ?? '');
      if (m.coins !== undefined) {
        const purse = el('div', 'ms-purse', head);
        el('span', 'ms-coin', purse, '₹');
        el('span', 'ms-purse-n', purse, m.coins);
      }
      if (m.level) {
        const bar = el('div', 'ms-bar', strip);
        el('div', 'ms-bar-fill', bar).style.width = pct(m.level.frac);
        el('div', 'ms-level-sub', strip, m.level.sub);
      }
      if (this.handlers.onShop) missionButton(head, 'ms-btn ms-btn-shop', 'Shop', this.handlers.onShop);
    }

    if (m.daily) frag.append(renderDailyCard(m.daily, { onPlay: this.handlers.onPlayDaily }));
    frag.append(renderMissionList(m.missions));
    this.root.replaceChildren(frag);
  }

  destroy(): void {
    this.root.replaceChildren();
    this.root.classList.remove('ms-board');
    delete this.root.dataset.on;
    this.key = '';
  }
}
