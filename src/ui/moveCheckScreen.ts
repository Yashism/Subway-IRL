import './moveCheck.css';
import { MOVE_ORDER, type MoveCheckHandlers, type MoveCheckModel, type MoveCheckSummary, type MoveId, type MoveStepModel } from '../pose/moveCheckTypes';
import type { PlayMode } from '../pose/types';

// ---------------------------------------------------------------- pure view helpers

const MODE_NAMES: Record<PlayMode, string> = { full: 'Full body', small: 'Small room' };

/** What each move does in the game — the right-hand side of the cheat-sheet rows. */
export const CONTROL_EFFECT: Record<MoveId, string> = {
  jog: 'keep running',
  left: 'move one lane left',
  right: 'move one lane right',
  jump: 'jump the barrier',
  roll: 'roll under it',
  hover: 'ride the hoverboard',
};

/** Keyboard fallbacks, listed on the cheat sheet (see src/input/keyboard.ts). */
export const KEY_ROWS: readonly { keys: readonly string[]; does: string }[] = [
  { keys: ['←', '→'], does: 'change lane' },
  { keys: ['Space'], does: 'jump' },
  { keys: ['S'], does: 'roll' },
  { keys: ['Ctrl'], does: 'hoverboard' },
  { keys: ['J'], does: 'jog' },
  { keys: ['Enter'], does: 'start' },
];

/** 0..1, never NaN: the strength bar must not run off its track or vanish on bad input. */
export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

export const strengthPercent = (progress: number): string => `${Math.round(clamp01(progress) * 100)}%`;

/** How the bar is coloured: nothing yet / on the way / got there. */
export function strengthLevel(progress: number): 'none' | 'low' | 'near' | 'full' {
  const p = clamp01(progress);
  if (p >= 1) return 'full';
  if (p >= 0.5) return 'near';
  return p > 0 ? 'low' : 'none';
}

/** The detector's own units, rounded so a number the player cannot act on stays short. */
export function formatPeak(peak: number | null): string {
  if (peak === null || !Number.isFinite(peak)) return '—';
  return Math.abs(peak) >= 10 ? String(Math.round(peak)) : peak.toFixed(2);
}

export const stepCounter = (m: MoveCheckModel): string =>
  m.summary ? 'All done!' : `Move ${Math.min(m.index + 1, m.steps.length)} of ${m.steps.length}`;

// ---------------------------------------------------------------- DOM helpers

const SVG = 'http://www.w3.org/2000/svg';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: Element, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
};

const svg = (tag: string, attrs: Record<string, string>, parent: Element): SVGElement => {
  const e = document.createElementNS(SVG, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.append(e);
  return e;
};

/** A button that lets go of focus, so the next Enter reaches the game and not this button. */
function button(parent: Element, cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, parent, label);
  b.type = 'button';
  b.addEventListener('click', () => {
    b.blur();
    onClick();
  });
  return b;
}

// ---------------------------------------------------------------- the mime figure

/**
 * A chunky stick player that mimes the move. One figure, posed by CSS off `data-move`
 * / `data-mode` on the root, so switching steps never rebuilds (or restarts) anything else.
 */
function figure(parent: Element): SVGElement {
  // The viewBox leaves 70 units of headroom above the head so a jump is not clipped.
  const s = svg('svg', { class: 'mc-fig', viewBox: '0 0 220 360', 'aria-hidden': 'true' }, parent);
  svg('ellipse', { class: 'mc-shadow', cx: '110', cy: '326', rx: '54', ry: '9' }, s);
  const body = svg('g', { class: 'mc-fig-body' }, s);

  // Each limb is drawn twice: a fat ink line under a cream one, so an arm crossing the
  // torso still reads as an arm. Limbs after the torso are in front of it, legs behind.
  const limb = (cls: string, d: string, origin: string): void => {
    const g = svg('g', { class: cls }, body);
    (g as SVGElement).style.transformOrigin = origin;
    svg('path', { class: 'mc-limb-ink', d }, g);
    svg('path', { class: 'mc-limb', d }, g);
  };

  limb('mc-leg mc-leg-l', 'M100 206 L96 262 L98 314', '100px 206px');
  limb('mc-leg mc-leg-r', 'M120 206 L124 262 L122 314', '120px 206px');
  svg('path', {
    class: 'mc-torso',
    d: 'M93 118 L127 118 Q137 118 137 130 L134 198 Q134 212 121 212 L99 212 Q86 212 86 198 L83 130 Q83 118 93 118 Z',
  }, body);
  limb('mc-arm mc-arm-l', 'M92 134 L74 168 L79 200', '92px 134px');
  limb('mc-arm mc-arm-r', 'M128 134 L146 168 L141 200', '128px 134px');
  svg('circle', { class: 'mc-head', cx: '110', cy: '94', r: '25' }, body);
  return s;
}

// ---------------------------------------------------------------- the cheat sheet

/**
 * The controls card: every move for this mode with ✓ / skipped and what was measured.
 * Detached and self-contained, so the pause screen can show the very same card as "Controls".
 */
export function renderSummaryCard(summary: MoveCheckSummary, opts: { title?: string } = {}): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mc-sheet';
  card.dataset.mode = summary.mode;
  const head = el('div', 'mc-sheet-head', card);
  el('div', 'mc-sheet-title', head, opts.title ?? 'Your controls');
  el('div', 'mc-sheet-mode', head, MODE_NAMES[summary.mode]);

  const rows = el('div', 'mc-rows', card);
  const byId = new Map(summary.steps.map((s) => [s.id, s]));
  for (const id of MOVE_ORDER) {
    const step = byId.get(id);
    if (!step) continue;
    const done = step.status === 'done';
    const row = el('div', 'mc-row', rows);
    row.dataset.status = done ? 'done' : 'skipped';
    el('div', 'mc-row-icon', row, done ? '✓' : '–');
    const text = el('div', 'mc-row-text', row);
    el('div', 'mc-row-move', text, step.label);
    el('div', 'mc-row-how', text, `${step.how} — ${CONTROL_EFFECT[id]}`);
    const meas = el('div', 'mc-row-meas', row);
    if (done && step.peak !== null) {
      el('div', 'mc-row-peak', meas, formatPeak(step.peak));
      el('div', 'mc-row-peak-label', meas, 'measured');
    } else {
      el('div', 'mc-row-skipped', meas, done ? 'done' : 'skipped');
    }
  }

  const gesture = el('div', 'mc-row mc-row-gesture', rows);
  gesture.dataset.status = 'gesture';
  el('div', 'mc-row-icon', gesture, '✋');
  const gtext = el('div', 'mc-row-text', gesture);
  el('div', 'mc-row-move', gtext, 'Right hand up');
  el('div', 'mc-row-how', gtext, 'Hold it up — start the run');
  el('div', 'mc-row-meas', gesture);

  if (summary.asymmetryNote) {
    const note = el('div', 'mc-note', card);
    el('span', 'mc-note-icon', note, '⚖');
    el('span', 'mc-note-text', note, summary.asymmetryNote);
  }

  const tunedCount = Object.keys(summary.tuned).length;
  el('div', 'mc-tuned', card, tunedCount ? `Tuned ${tunedCount} setting${tunedCount === 1 ? '' : 's'} to the way you move.` : 'Nothing measured — the default settings stay.');

  const keys = el('div', 'mc-keys', card);
  el('div', 'mc-keys-title', keys, 'KEYBOARD');
  const keyList = el('div', 'mc-keys-list', keys);
  for (const r of KEY_ROWS) {
    const k = el('div', 'mc-key', keyList);
    const caps = el('div', 'mc-key-caps', k);
    for (const key of r.keys) el('kbd', 'mc-cap', caps, key);
    el('div', 'mc-key-does', k, r.does);
  }
  return card;
}

// ---------------------------------------------------------------- the screen

const JOG_PIPS = 4;

/**
 * The guided move rehearsal, rendered from a MoveCheckModel and nothing else.
 * Spec: docs/superpowers/specs/2026-09-17-move-check.md
 */
export class MoveCheckScreen {
  private readonly root: HTMLElement;
  private readonly handlers: MoveCheckHandlers;
  private readonly lastText = new Map<Element, string>();
  private readonly attrs = new Map<Element, Map<string, string>>();
  private mounted = false;
  private last: MoveCheckModel | null = null;

  // built on mount
  private sub!: HTMLElement;
  private dots!: HTMLElement[];
  private moveName!: HTMLElement;
  private how!: HTMLElement;
  private stage!: HTMLElement;
  private jogBox!: HTMLElement;
  private jogCount!: HTMLElement;
  private jogPips!: HTMLElement[];
  private bar!: HTMLElement;
  private barFill!: HTMLElement;
  private barValue!: HTMLElement;
  private hint!: HTMLElement;
  private peak!: HTMLElement;
  private skipBtn!: HTMLButtonElement;
  private acceptBtn!: HTMLButtonElement;
  private skipAllBtn!: HTMLButtonElement;
  private sheetBox!: HTMLElement;
  private sheetKey = '';

  constructor(root: HTMLElement, handlers: MoveCheckHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  /** Builds the DOM. Idempotent; `update` calls it for you. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    const root = this.root;
    root.classList.add('move-check');
    root.dataset.phase = 'steps';

    // ---- banner + step dots
    const top = el('div', 'mc-top', root);
    const banner = el('div', 'mc-banner', top);
    el('div', 'mc-banner-tab', banner, 'MOVE CHECK');
    this.sub = el('div', 'mc-banner-sub', banner);

    const dots = el('div', 'mc-dots', top);
    this.dots = MOVE_ORDER.map((_, i) => {
      const d = el('div', 'mc-dot', dots);
      el('span', 'mc-dot-mark', d, String(i + 1));
      el('span', 'mc-dot-label', d);
      return d;
    });

    // ---- the active step
    const card = el('div', 'mc-card', root);
    const live = el('div', 'mc-live', card);
    live.setAttribute('aria-live', 'polite');
    this.moveName = el('div', 'mc-move-name', live);
    this.how = el('div', 'mc-how', live);

    this.stage = el('div', 'mc-stage', card);
    figure(this.stage);
    for (const cue of ['l', 'r', 'up', 'down', 'hands'] as const) el('div', `mc-cue mc-cue-${cue}`, this.stage, cue === 'l' ? '‹‹' : cue === 'r' ? '››' : cue === 'up' ? '▲' : cue === 'down' ? '▼' : '✦');

    this.jogBox = el('div', 'mc-jog', card);
    this.jogCount = el('div', 'mc-jog-count', this.jogBox);
    const pips = el('div', 'mc-jog-pips', this.jogBox);
    this.jogPips = Array.from({ length: JOG_PIPS }, () => el('div', 'mc-jog-pip', pips));

    const strength = el('div', 'mc-strength', card);
    const sHead = el('div', 'mc-strength-head', strength);
    el('div', 'mc-strength-title', sHead, 'HOW BIG WAS IT');
    this.barValue = el('div', 'mc-strength-value', sHead);
    el('div', 'mc-strength-goal', sHead, '100% IS ENOUGH');
    this.bar = el('div', 'mc-bar', strength);
    this.bar.setAttribute('role', 'progressbar');
    this.bar.setAttribute('aria-valuemin', '0');
    this.bar.setAttribute('aria-valuemax', '100');
    this.barFill = el('div', 'mc-bar-fill', this.bar);
    el('div', 'mc-bar-goal', this.bar);
    const foot = el('div', 'mc-strength-foot', strength);
    this.hint = el('div', 'mc-hint', foot);
    this.peak = el('div', 'mc-peak', foot);

    // ---- buttons (the row keeps its height whether or not any are shown)
    const actions = el('div', 'mc-actions', root);
    this.skipBtn = button(actions, 'mc-btn mc-btn-alt mc-btn-skip', 'Skip this move', () => this.handlers.skipStep());
    this.acceptBtn = button(actions, 'mc-btn mc-btn-accept', 'Use my best attempt', () => this.handlers.acceptBest());
    this.skipAllBtn = button(actions, 'mc-btn mc-btn-ghost mc-btn-skip-all', 'Skip all', () => this.handlers.skipAll());

    // ---- summary
    const sum = el('div', 'mc-summary', root);
    this.sheetBox = el('div', 'mc-sheet-box', sum);
    const sActions = el('div', 'mc-actions mc-actions-summary', sum);
    button(sActions, 'mc-btn mc-btn-go', 'START PLAYING', () => this.handlers.start());
    button(sActions, 'mc-btn mc-btn-alt', 'Redo the check', () => this.handlers.redo());
    button(sActions, 'mc-btn mc-btn-ghost', 'Reset to defaults', () => this.handlers.resetTuning());
  }

  /** Renders one model; `null` hides the whole layer. */
  update(m: MoveCheckModel | null): void {
    this.mount();
    if (m === this.last) return;
    this.last = m;
    this.attr(this.root, 'data-on', m ? 'on' : 'off');
    if (!m) return;

    this.attr(this.root, 'data-mode', m.mode);
    this.attr(this.root, 'data-phase', m.summary ? 'summary' : 'steps');
    this.text(this.sub, `${stepCounter(m)} · ${MODE_NAMES[m.mode]}`);

    for (let i = 0; i < this.dots.length; i++) {
      const step: MoveStepModel | undefined = m.steps[i];
      const dot = this.dots[i];
      this.attr(dot, 'data-status', step ? step.status : 'todo');
      this.text(dot.firstElementChild as Element, step?.status === 'done' ? '✓' : step?.status === 'skipped' ? '–' : String(i + 1));
      this.text(dot.lastElementChild as Element, step?.label ?? '');
      dot.setAttribute('aria-label', step ? `${step.label}: ${step.status}` : '');
    }

    if (m.summary) {
      this.renderSheet(m.summary);
      return;
    }

    const step = m.steps[m.index];
    if (!step) return;
    this.attr(this.root, 'data-move', step.id);
    this.text(this.moveName, step.label);
    this.text(this.how, step.how);

    const jog = step.steps;
    this.jogBox.hidden = !jog;
    if (jog) {
      this.text(this.jogCount, `${jog.seen} of ${jog.needed} steps`);
      for (let i = 0; i < this.jogPips.length; i++) this.attr(this.jogPips[i], 'data-on', i < jog.seen ? 'on' : 'off');
    }

    const p = clamp01(step.progress);
    this.barFill.style.width = strengthPercent(p);
    this.attr(this.bar, 'data-level', strengthLevel(p));
    this.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    this.bar.setAttribute('aria-label', `${step.label}: how big your best attempt was`);
    this.text(this.barValue, strengthPercent(p));
    this.text(this.hint, step.hint ?? '');
    this.attr(this.hint, 'data-on', step.hint ? 'on' : 'off');
    this.text(this.peak, step.peak === null ? '' : `best ${formatPeak(step.peak)}`);

    this.skipBtn.hidden = !step.canSkip;
    this.acceptBtn.hidden = !step.canAccept;
    this.skipAllBtn.hidden = false;
  }

  destroy(): void {
    this.root.replaceChildren();
    this.lastText.clear();
    this.attrs.clear();
    this.root.classList.remove('move-check');
    delete this.root.dataset.phase;
    delete this.root.dataset.move;
    delete this.root.dataset.on;
    delete this.root.dataset.mode;
    this.mounted = false;
    this.last = null;
    this.sheetKey = '';
  }

  // ---------------------------------------------------------------- internals

  private renderSheet(s: MoveCheckSummary): void {
    // The card is static once the check is over; rebuild only when it actually differs.
    const key = JSON.stringify([s.mode, s.asymmetryNote, Object.keys(s.tuned).sort(), s.steps.map((x) => [x.id, x.status, x.peak, x.how])]);
    if (key === this.sheetKey) return;
    this.sheetKey = key;
    this.sheetBox.replaceChildren(renderSummaryCard(s));
  }

  private text(e: Element, value: string): void {
    if (this.lastText.get(e) === value) return;
    this.lastText.set(e, value);
    e.textContent = value;
  }

  private attr(e: Element, name: string, value: string): void {
    let map = this.attrs.get(e);
    if (!map) this.attrs.set(e, (map = new Map()));
    if (map.get(name) === value) return;
    map.set(name, value);
    e.setAttribute(name, value);
  }
}
