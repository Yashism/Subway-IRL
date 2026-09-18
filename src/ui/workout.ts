/**
 * The workout screen — today, this week, all time, and the last thirty runs.
 * Spec: docs/superpowers/specs/2026-09-18-settings-workout.md ("Workout screen").
 *
 * This is the reason to come back tomorrow, so it is built around the streak and the week chart
 * rather than around a table. A player who has never run sees an invitation, not a wall of zeros.
 * Calories are always labelled a rough estimate and always name the weight they assumed; the game
 * never asks anyone to weigh themselves to look at their own runs.
 */
import './settings.css';
import './workout.css';
import { ASSUMED_WEIGHT_KG, activeMinutes, calories, formatCount, formatDistance, formatDuration, relativeDay, workoutStats, type RecentRun, type WorkoutStats } from '../app/stats';
import { dayKey, type Profile } from '../app/profile';
import { MODE_NAMES } from '../app/settings';
import { button, el } from './settings';

// ---------------------------------------------------------------- pure view helpers

/** A bar's height as a percentage of the week's tallest. Zero days keep a visible stub. */
export function barPercent(activeSeconds: number, peak: number): number {
  if (!(peak > 0) || !(activeSeconds > 0)) return 0;
  return Math.max(6, Math.round((activeSeconds / peak) * 100));
}

/**
 * "3 days in a row" / "Run today to start a streak". Never scolds, and never rounds a player down:
 * `capped` means the count ran off the end of the kept history, so it is a floor and says so.
 */
export function streakWords(streak: number, ranToday: boolean, capped = false): string {
  if (streak === 0) return 'Run today to start a streak';
  if (streak === 1) return ranToday ? 'Day one. Again tomorrow.' : 'One day so far — keep it going today';
  return `${streak}${capped ? '+' : ''} days in a row`;
}

/** The kcal line, with the caveat and the weight baked in — the two are never separated. */
export function caloriesLine(activeSeconds: number, weightKg: number | null): string {
  const kcal = Math.round(calories(activeSeconds, weightKg ?? ASSUMED_WEIGHT_KG));
  const who = weightKg === null ? `assuming ${ASSUMED_WEIGHT_KG} kg` : `at ${weightKg} kg`;
  return `≈ ${formatCount(kcal)} kcal · rough estimate, ${who}`;
}

/** "Full body · webcam" — how a run was played, for the history row. */
export function runHow(run: RecentRun): string {
  const mode = run.mode === 'full' || run.mode === 'small' ? MODE_NAMES[run.mode] : '';
  const input = run.input === 'keyboard' ? 'keyboard' : run.input === 'webcam' ? 'webcam' : run.input;
  return [mode, input].filter(Boolean).join(' · ') || '—';
}

// ---------------------------------------------------------------- the screen

export interface WorkoutView {
  /** False hides the whole layer. */
  open: boolean;
  profile: Profile;
  /** The player's volunteered weight, or null to use the stated assumed one. */
  weightKg: number | null;
  /** The instant to roll up against. Defaults to now; the harness and the tests pin it. */
  now?: number;
}

export interface WorkoutHandlers {
  /** Leave this screen and start running. */
  startRun(): void;
  openSettings(): void;
  close(): void;
}

/** How many runs the list shows before it stops. The profile keeps 30; all 30 are worth showing. */
export const RECENT_SHOWN = 30;

export class WorkoutScreen {
  private readonly root: HTMLElement;
  private readonly handlers: WorkoutHandlers;
  private readonly lastText = new Map<Element, string>();
  private readonly attrs = new Map<Element, Map<string, string>>();
  private mounted = false;
  private listKey = '';

  // built on mount
  private todayMinutes!: HTMLElement;
  private todayCals!: HTMLElement;
  private todayTiles!: Record<'steps' | 'distance' | 'coins' | 'runs', HTMLElement>;
  private streakNum!: HTMLElement;
  private streakLine!: HTMLElement;
  private bestStreak!: HTMLElement;
  private bars!: { root: HTMLElement; fill: HTMLElement; cap: HTMLElement; initial: HTMLElement }[];
  private weekTotal!: HTMLElement;
  private weekCals!: HTMLElement;
  private allTiles!: Record<string, HTMLElement>;
  private list!: HTMLElement;
  private listEmpty!: HTMLElement;

  constructor(root: HTMLElement, handlers: WorkoutHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  /** Builds the DOM. Idempotent; `update` calls it for you. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    const root = this.root;
    root.classList.add('sw-screen', 'wk-screen');
    this.attr(root, 'data-on', 'off');
    this.attr(root, 'data-empty', 'no');

    const top = el('div', 'sw-top', root);
    el('div', 'sw-tab wk-tab', top, 'YOUR RUNS');
    el('div', 'sw-tab-sub', top, 'Everything you have actually moved');

    // ---- the first-run invitation (shown instead of everything below)
    const invite = el('div', 'wk-invite', root);
    el('div', 'wk-invite-icon', invite, '🏃');
    el('div', 'wk-invite-title', invite, 'Nothing here yet');
    el('div', 'wk-invite-body', invite, 'Jog in place to keep the train moving. One run and this page fills up: minutes, steps, distance, a streak to keep.');
    const inviteActions = el('div', 'sw-actions wk-invite-actions', invite);
    button(inviteActions, 'sw-btn sw-btn-go sw-btn-wide', 'Run your first', () => this.handlers.startRun());

    /*
     * Two columns that each start at the top: "now" on the left (today, this week) and the record
     * on the right (all time, the runs). A plain two-column grid would open a hole under whichever
     * card in a row is the shorter one, and TODAY is always much shorter than THIS WEEK.
     */
    const grid = el('div', 'wk-grid', root);
    const now = el('div', 'wk-col', grid);
    const record = el('div', 'wk-col', grid);

    // ---- today
    const today = this.card(now, 'wk-card-today', 'TODAY');
    const hero = el('div', 'wk-hero', today);
    this.todayMinutes = el('div', 'wk-hero-num', hero);
    const heroText = el('div', 'wk-hero-text', hero);
    el('div', 'wk-hero-unit', heroText, 'active minutes');
    this.todayCals = el('div', 'wk-cals', heroText);
    const tiles = el('div', 'wk-tiles', today);
    this.todayTiles = {
      steps: this.tile(tiles, 'Steps'),
      distance: this.tile(tiles, 'Distance'),
      coins: this.tile(tiles, 'Coins'),
      runs: this.tile(tiles, 'Runs'),
    };

    // ---- this week
    const week = this.card(now, 'wk-card-week', 'THIS WEEK');
    const streak = el('div', 'wk-streak', week);
    const flame = el('div', 'wk-streak-badge', streak);
    el('span', 'wk-streak-flame', flame, '🔥');
    this.streakNum = el('span', 'wk-streak-num', flame);
    const streakText = el('div', 'wk-streak-text', streak);
    this.streakLine = el('div', 'wk-streak-words', streakText);
    this.bestStreak = el('div', 'wk-streak-best', streakText);

    const chart = el('div', 'wk-chart', week);
    chart.setAttribute('role', 'img');
    this.bars = Array.from({ length: 7 }, () => {
      const col = el('div', 'wk-bar', chart);
      const cap = el('div', 'wk-bar-cap', col);
      const track = el('div', 'wk-bar-track', col);
      const fill = el('div', 'wk-bar-fill', track);
      const initial = el('div', 'wk-bar-day', col);
      return { root: col, fill, cap, initial };
    });
    const weekFoot = el('div', 'wk-week-foot', week);
    this.weekTotal = el('div', 'wk-week-total', weekFoot);
    this.weekCals = el('div', 'wk-cals', weekFoot);

    // ---- all time
    const all = this.card(record, 'wk-card-all', 'ALL TIME');
    const allTiles = el('div', 'wk-tiles wk-tiles-all', all);
    this.allTiles = {
      runs: this.tile(allTiles, 'Runs'),
      minutes: this.tile(allTiles, 'Active min'),
      distance: this.tile(allTiles, 'Distance'),
      steps: this.tile(allTiles, 'Steps'),
      coins: this.tile(allTiles, 'Coins'),
      bestScore: this.tile(allTiles, 'Best score'),
      bestDistance: this.tile(allTiles, 'Best run'),
      longest: this.tile(allTiles, 'Longest run'),
      days: this.tile(allTiles, 'Days moved'),
    };

    // ---- recent runs
    const recent = this.card(record, 'wk-card-recent', 'RECENT RUNS');
    this.list = el('div', 'wk-list', recent);
    this.listEmpty = el('div', 'wk-list-empty', recent, 'No runs yet.');

    // ---- footer
    const foot = el('div', 'sw-foot', root);
    // Hidden when the screen is empty: the invitation card already owns the call to action there,
    // and "Run again" is the wrong word for someone who has not run once.
    button(foot, 'sw-btn sw-btn-go sw-btn-wide wk-foot-run', 'Run again', () => this.handlers.startRun());
    button(foot, 'sw-btn sw-btn-ghost', '⚙ Settings', () => this.handlers.openSettings());
    button(foot, 'sw-btn sw-btn-ghost', 'Done', () => this.handlers.close());
  }

  /** Renders one view; `open: false` (or null) hides the layer. */
  update(v: WorkoutView | null): void {
    this.mount();
    const on = v !== null && v.open;
    this.attr(this.root, 'data-on', on ? 'on' : 'off');
    if (!v) return;

    const s = workoutStats(v.profile, v.now ?? Date.now());
    this.attr(this.root, 'data-empty', s.empty ? 'yes' : 'no');
    // Nothing below the invitation is worth rendering for a player who has never run.
    if (s.empty) {
      this.listKey = '';
      return;
    }

    this.renderToday(s, v.weightKg);
    this.renderWeek(s, v.weightKg);
    this.renderAllTime(s);
    this.renderList(s);
  }

  destroy(): void {
    this.root.replaceChildren();
    this.lastText.clear();
    this.attrs.clear();
    this.root.classList.remove('sw-screen', 'wk-screen');
    delete this.root.dataset.on;
    delete this.root.dataset.empty;
    this.mounted = false;
    this.listKey = '';
  }

  // ---------------------------------------------------------------- internals

  private renderToday(s: WorkoutStats, weightKg: number | null): void {
    this.text(this.todayMinutes, String(activeMinutes(s.today.activeSeconds)));
    this.text(this.todayCals, caloriesLine(s.today.activeSeconds, weightKg));
    this.setTile(this.todayTiles.steps, formatCount(s.today.steps));
    this.setTile(this.todayTiles.distance, formatDistance(s.today.distance));
    this.setTile(this.todayTiles.coins, formatCount(s.today.coins));
    this.setTile(this.todayTiles.runs, String(s.today.runs));
  }

  private renderWeek(s: WorkoutStats, weightKg: number | null): void {
    this.text(this.streakNum, String(s.streak));
    this.text(this.streakLine, streakWords(s.streak, s.today.runs > 0, s.streakCapped));
    // Only worth saying when they have already beaten what they are on now.
    this.text(this.bestStreak, s.bestStreak > s.streak ? `Your best run of days: ${s.bestStreak}` : '');
    this.attr(this.streakNum.parentElement as Element, 'data-on', s.streak > 0 ? 'on' : 'off');

    for (let i = 0; i < this.bars.length; i++) {
      const d = s.week[i];
      const bar = this.bars[i];
      const mins = activeMinutes(d.activeSeconds);
      this.style(bar.fill, 'height', `${barPercent(d.activeSeconds, s.weekPeak)}%`);
      this.text(bar.cap, mins > 0 ? String(mins) : '');
      this.text(bar.initial, d.initial);
      this.attr(bar.root, 'data-today', d.today ? 'on' : 'off');
      this.attr(bar.root, 'data-empty', d.activeSeconds > 0 ? 'no' : 'yes');
      bar.root.setAttribute('aria-label', `${d.label}: ${mins} active minutes`);
    }
    this.text(this.weekTotal, `${activeMinutes(s.weekActiveSeconds)} min · ${s.weekRuns} run${s.weekRuns === 1 ? '' : 's'} this week`);
    this.text(this.weekCals, caloriesLine(s.weekActiveSeconds, weightKg));
  }

  private renderAllTime(s: WorkoutStats): void {
    const a = s.allTime;
    this.setTile(this.allTiles.runs, formatCount(a.runs));
    this.setTile(this.allTiles.minutes, formatCount(activeMinutes(a.activeSeconds)));
    this.setTile(this.allTiles.distance, formatDistance(a.distance));
    this.setTile(this.allTiles.steps, formatCount(a.steps));
    this.setTile(this.allTiles.coins, formatCount(a.coins));
    this.setTile(this.allTiles.bestScore, formatCount(a.bestScore));
    this.setTile(this.allTiles.bestDistance, formatDistance(a.bestDistance));
    this.setTile(this.allTiles.longest, formatDuration(a.longestRunSec));
    // Same floor as the streak: the day map only keeps so many days, so say "180+" rather than
    // quietly reporting the size of our storage as the size of their habit.
    this.setTile(this.allTiles.days, `${formatCount(a.activeDays)}${s.activeDaysCapped ? '+' : ''}`);
  }

  private renderList(s: WorkoutStats): void {
    const runs = s.recent.slice(0, RECENT_SHOWN);
    // The history only changes when a run ends: rebuild then, not on every open.
    const key = `${s.todayKey}${runs.map((r) => `${r.at}:${r.score}:${r.newBest}`).join(',')}`;
    if (key === this.listKey) return;
    this.listKey = key;
    this.listEmpty.hidden = runs.length > 0;
    this.list.replaceChildren();
    for (const r of runs) {
      const row = el('div', 'wk-run', this.list);
      if (r.newBest) row.dataset.best = 'on';
      const when = el('div', 'wk-run-when', row);
      el('div', 'wk-run-day', when, relativeDay(r.day || dayKey(r.at), s.todayKey));
      el('div', 'wk-run-how', when, runHow(r));
      const score = el('div', 'wk-run-score', row);
      el('div', 'wk-run-score-num', score, formatCount(r.score));
      el('div', 'wk-run-score-label', score, r.newBest ? 'NEW BEST' : 'score');
      const stats = el('div', 'wk-run-stats', row);
      for (const [label, value] of [
        ['dist', formatDistance(r.distance)],
        ['time', formatDuration(r.timeSec)],
        ['coins', formatCount(r.coins)],
      ] as const) {
        const cell = el('div', 'wk-run-stat', stats);
        el('div', 'wk-run-stat-val', cell, value);
        el('div', 'wk-run-stat-label', cell, label);
      }
    }
  }

  private card(parent: Element, cls: string, title: string): HTMLElement {
    const c = el('div', `wk-card ${cls}`, parent);
    el('div', 'wk-card-title', c, title);
    return el('div', 'wk-card-body', c);
  }

  private tile(parent: Element, label: string): HTMLElement {
    const t = el('div', 'wk-tile', parent);
    const v = el('div', 'wk-tile-val', t);
    el('div', 'wk-tile-label', t, label);
    return v;
  }

  private setTile(valueEl: Element, value: string): void {
    this.text(valueEl, value);
  }

  private text(e: Element, value: string): void {
    if (this.lastText.get(e) === value) return;
    this.lastText.set(e, value);
    e.textContent = value;
  }

  private style(e: HTMLElement, prop: 'height', value: string): void {
    if (e.style.getPropertyValue(prop) === value) return;
    e.style.setProperty(prop, value);
  }

  private attr(e: Element, name: string, value: string): void {
    let map = this.attrs.get(e);
    if (!map) this.attrs.set(e, (map = new Map()));
    if (map.get(name) === value) return;
    map.set(name, value);
    e.setAttribute(name, value);
  }
}
