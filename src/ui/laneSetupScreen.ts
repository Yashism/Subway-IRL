import './moveCheck.css';
import './laneSetup.css';
import type { LaneSetupHandlers } from '../app/laneSetupSession';
import { SPOT_ORDER, type LaneSetupModel, type SpotId } from '../pose/laneSetup';
import { MIN_SPOT_GAP, type LaneSpots } from '../pose/laneSpots';

// ---------------------------------------------------------------- pure view helpers

/** Half-width of the floor strip, in torso lengths: a spot further out is pinned to the edge. */
export const FLOOR_RANGE = 1.5;

/** Where an offset sits across the floor strip, as a percentage, clamped inside its ends. */
export function floorPercent(offset: number, range = FLOOR_RANGE): number {
  if (!Number.isFinite(offset)) return 50;
  const p = 50 + (offset / range) * 50;
  return Math.min(95, Math.max(5, p));
}

/** Off the strip, and which way: the marker then sits at the end with an arrow. */
export function floorEdge(offset: number, range = FLOOR_RANGE): 'left' | 'right' | 'none' {
  if (!Number.isFinite(offset)) return 'none';
  return offset < -range * 0.94 ? 'left' : offset > range * 0.94 ? 'right' : 'none';
}

/** Torso lengths, short enough to read from across the room. */
export const fmtSpot = (v: number): string => (Number.isFinite(v) ? Math.abs(v).toFixed(2) : '—');

export interface SpotRow {
  id: SpotId;
  label: string;
  /** The distance, big. */
  value: string;
  /** What it is measured from. */
  from: string;
}

/**
 * The summary's three rows: each side spot's distance from the centre spot (that is the step the
 * player will make), and the centre spot's distance from where they calibrated.
 */
export function spotRows(s: LaneSpots): SpotRow[] {
  const c = s.centre;
  const centreFrom = Math.abs(c) < 0.02 ? 'right where you calibrated' : `${c < 0 ? 'left' : 'right'} of where you calibrated`;
  return [
    { id: 'left', label: 'Left', value: fmtSpot(c - s.left), from: 'left of centre' },
    { id: 'centre', label: 'Centre', value: Math.abs(c) < 0.02 ? '0.00' : fmtSpot(c), from: centreFrom },
    { id: 'right', label: 'Right', value: fmtSpot(s.right - c), from: 'right of centre' },
  ];
}

export const spotCounter = (m: LaneSetupModel): string =>
  m.result ? 'All three set!' : `Spot ${Math.min(m.index + 1, SPOT_ORDER.length)} of ${SPOT_ORDER.length}`;

/** The circle's circumference for r = 26 in a 64-unit box, and the dash offset for progress p. */
const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;
export function holdDash(p: number): string {
  const f = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  return ((1 - f) * RING_C).toFixed(1);
}

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

// ---------------------------------------------------------------- the screen

const PIN_LETTER: Record<SpotId, string> = { left: 'L', centre: 'C', right: 'R' };

/**
 * The guided lane-spots setup, rendered from a LaneSetupModel and nothing else.
 * Spec: docs/superpowers/specs/2026-09-18-lane-spots.md ("The setup").
 */
export class LaneSetupScreen {
  private readonly root: HTMLElement;
  private readonly handlers: LaneSetupHandlers;
  private readonly lastText = new Map<Element, string>();
  private readonly attrs = new Map<Element, Map<string, string>>();
  private readonly lefts = new Map<HTMLElement, string>();
  private mounted = false;
  private last: LaneSetupModel | null = null;

  // built on mount
  private sub!: HTMLElement;
  private dots!: HTMLElement[];
  private name!: HTMLElement;
  private how!: HTMLElement;
  private pins!: Record<SpotId, HTMLElement>;
  private bounds!: [HTMLElement, HTMLElement];
  /** The band around the centre spot a side spot may not be taken in. */
  private near!: HTMLElement;
  private you!: HTMLElement;
  private ringArc!: SVGElement;
  private ringCore!: HTMLElement;
  private holdLabel!: HTMLElement;
  private hint!: HTMLElement;
  private rows!: Record<SpotId, { value: HTMLElement; from: HTMLElement }>;
  private redoBtn!: HTMLButtonElement;

  constructor(root: HTMLElement, handlers: LaneSetupHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  /** Builds the DOM. Idempotent; `update` calls it for you. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    const root = this.root;
    root.classList.add('lane-setup');
    this.attr(root, 'data-on', 'off');
    this.attr(root, 'data-phase', 'steps');

    // ---- banner + step dots (the move check's, so the two read as one family)
    const top = el('div', 'mc-top', root);
    const banner = el('div', 'mc-banner', top);
    el('div', 'mc-banner-tab ls-tab', banner, 'LANE SPOTS');
    this.sub = el('div', 'mc-banner-sub', banner);
    const dots = el('div', 'mc-dots', top);
    this.dots = SPOT_ORDER.map((id, i) => {
      const d = el('div', 'mc-dot', dots);
      el('span', 'mc-dot-mark', d, String(i + 1));
      el('span', 'mc-dot-label', d, id === 'centre' ? 'Centre' : id === 'left' ? 'Left' : 'Right');
      return d;
    });

    // ---- the card: instruction, the floor, the hold
    const card = el('div', 'ls-card', root);
    const head = el('div', 'ls-head', card);
    const live = el('div', 'ls-live', head);
    live.setAttribute('aria-live', 'polite');
    this.name = el('div', 'ls-name', live);
    this.how = el('div', 'ls-how', live);

    const hold = el('div', 'ls-hold', head);
    const ring = el('div', 'ls-ring', hold);
    const rs = svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' }, ring);
    svg('circle', { class: 'ls-ring-track', cx: '32', cy: '32', r: String(RING_R) }, rs);
    this.ringArc = svg('circle', {
      class: 'ls-ring-arc',
      cx: '32',
      cy: '32',
      r: String(RING_R),
      'stroke-dasharray': RING_C.toFixed(1),
      'stroke-dashoffset': RING_C.toFixed(1),
    }, rs);
    this.ringCore = el('div', 'ls-ring-core', ring);
    this.holdLabel = el('div', 'ls-hold-label', hold);

    // The floor, seen from the camera's side: the player's left is screen-left, as in the preview.
    const floor = el('div', 'ls-floor', card);
    const strip = el('div', 'ls-strip', floor);
    for (const side of ['left', 'right'] as const) el('div', `ls-zone ls-zone-${side}`, strip);
    this.near = el('div', 'ls-near', strip);
    this.bounds = [el('div', 'ls-bound', strip), el('div', 'ls-bound', strip)];
    this.pins = {
      left: this.pin(strip, 'left'),
      centre: this.pin(strip, 'centre'),
      right: this.pin(strip, 'right'),
    };
    this.you = el('div', 'ls-you', strip);
    el('div', 'ls-you-dot', this.you, '●');
    el('div', 'ls-you-label', this.you, 'YOU');
    const scale = el('div', 'ls-scale', floor);
    el('span', 'ls-scale-end', scale, '◀ your left');
    el('span', 'ls-scale-mid', scale, 'where you calibrated');
    el('span', 'ls-scale-end', scale, 'your right ▶');

    this.hint = el('div', 'ls-hint', card);

    // ---- summary rows (inside the same card: the floor stays put between the two phases)
    const sum = el('div', 'ls-rows', card);
    const row = (id: SpotId) => {
      const r = el('div', 'ls-row', sum);
      r.dataset.spot = id;
      el('div', 'ls-row-pin', r, PIN_LETTER[id]);
      const text = el('div', 'ls-row-text', r);
      el('div', 'ls-row-label', text, id === 'centre' ? 'Centre' : id === 'left' ? 'Left lane' : 'Right lane');
      const from = el('div', 'ls-row-from', text);
      const value = el('div', 'ls-row-value', r);
      return { value, from };
    };
    this.rows = { left: row('left'), centre: row('centre'), right: row('right') };
    el(
      'div',
      'ls-note',
      card,
      'Distances in torso lengths (hip to shoulder). Lanes change halfway between your spots. Full body mode only — small room changes lane by leaning.',
    );

    // ---- buttons
    const actions = el('div', 'mc-actions ls-actions-steps', root);
    this.redoBtn = button(actions, 'mc-btn mc-btn-alt', '↺ Start over', () => this.handlers.redo());
    button(actions, 'mc-btn mc-btn-ghost', 'Cancel', () => this.handlers.cancel());
    const sActions = el('div', 'mc-actions ls-actions-summary', root);
    button(sActions, 'mc-btn mc-btn-go', 'SAVE MY SPOTS', () => this.handlers.save());
    button(sActions, 'mc-btn mc-btn-alt', '↺ Redo', () => this.handlers.redo());
    button(sActions, 'mc-btn mc-btn-ghost', 'Cancel', () => this.handlers.cancel());
  }

  /** Renders one model; `null` hides the whole layer. The model is mutated in place, so the per-node caches do the deduping. */
  update(m: LaneSetupModel | null): void {
    this.mount();
    if (m === null && this.last === null) return;
    this.last = m;
    this.attr(this.root, 'data-on', m ? 'on' : 'off');
    if (!m) return;

    const done = m.result !== null;
    this.attr(this.root, 'data-phase', done ? 'summary' : 'steps');
    this.attr(this.root, 'data-step', m.step ?? 'done');
    this.text(this.sub, `${spotCounter(m)} · Full body`);

    for (let i = 0; i < this.dots.length; i++) {
      const id = SPOT_ORDER[i];
      const taken = m.spots[id] !== null && (i < m.index || m.taken || done);
      const status = taken ? 'done' : i === m.index && !done ? 'active' : 'todo';
      this.attr(this.dots[i], 'data-status', status);
      this.text(this.dots[i].firstElementChild as Element, status === 'done' ? '✓' : String(i + 1));
    }

    // The floor: pins for the spots taken, the lane boundaries once both neighbours exist, you.
    for (const id of SPOT_ORDER) {
      const v = m.spots[id];
      const pin = this.pins[id];
      this.attr(pin, 'data-on', v === null ? 'off' : 'on');
      if (v !== null) this.left(pin, floorPercent(v));
    }
    const { left, centre, right } = m.spots;
    const bl = left !== null && centre !== null ? (left + centre) / 2 : null;
    const br = right !== null && centre !== null ? (right + centre) / 2 : null;
    this.attr(this.bounds[0], 'data-on', bl === null ? 'off' : 'on');
    this.attr(this.bounds[1], 'data-on', br === null ? 'off' : 'on');
    if (bl !== null) this.left(this.bounds[0], floorPercent(bl));
    if (br !== null) this.left(this.bounds[1], floorPercent(br));
    // The shaded side zones run from each boundary out to the strip's end.
    this.prop('--ls-bl', `${bl === null ? 0 : floorPercent(bl).toFixed(2)}%`);
    this.prop('--ls-br', `${br === null ? 100 : floorPercent(br).toFixed(2)}%`);

    // While a side spot is wanted, the band it may not be taken in is hatched on the floor.
    const side = m.step === 'left' || m.step === 'right';
    this.attr(this.near, 'data-on', side && centre !== null ? 'on' : 'off');
    if (side && centre !== null) {
      this.left(this.near, floorPercent(centre - MIN_SPOT_GAP));
      this.prop('--ls-near-w', `${(floorPercent(centre + MIN_SPOT_GAP) - floorPercent(centre - MIN_SPOT_GAP)).toFixed(2)}%`);
    }

    const you = m.live;
    this.attr(this.you, 'data-on', you === null ? 'off' : 'on');
    if (you !== null) {
      this.left(this.you, floorPercent(you));
      this.attr(this.you, 'data-edge', floorEdge(you));
    }
    this.attr(this.you, 'data-state', m.taken ? 'taken' : m.blocked ? 'blocked' : m.hold > 0 ? 'holding' : 'idle');

    if (done) {
      this.text(this.name, 'Your lanes');
      this.text(this.how, 'Step onto a spot and that is your lane.');
      const rows = spotRows(m.result!);
      for (const r of rows) {
        this.text(this.rows[r.id].value, r.value);
        this.text(this.rows[r.id].from, r.from);
      }
      this.attr(this.hint, 'data-on', 'off');
      return;
    }

    this.text(this.name, m.label);
    this.text(this.how, m.how);
    this.attr(this.ringArc, 'stroke-dashoffset', holdDash(m.hold));
    // Refused: the ring points the way to go instead of reading a useless 0 %.
    const arrow = m.step === 'left' ? '\u25c0' : m.step === 'right' ? '\u25b6' : '\u2194';
    this.text(this.ringCore, m.taken ? '\u2713' : you === null ? '?' : m.blocked ? arrow : `${Math.round(m.hold * 100)}%`);
    this.attr(this.ringCore.parentElement as Element, 'data-state', m.taken ? 'taken' : m.blocked ? 'blocked' : m.hold > 0 ? 'holding' : 'idle');
    this.text(
      this.holdLabel,
      m.taken ? 'GOT IT!' : you === null ? 'CAN’T SEE YOU' : m.blocked ? 'NOT HERE' : m.hold > 0 ? 'HOLD STILL…' : 'STAND STILL',
    );
    this.text(this.hint, m.hint ?? '');
    this.attr(this.hint, 'data-on', m.hint ? 'on' : 'off');
    this.redoBtn.hidden = m.spots.centre === null;
  }

  destroy(): void {
    this.root.replaceChildren();
    this.lastText.clear();
    this.attrs.clear();
    this.lefts.clear();
    this.root.classList.remove('lane-setup');
    this.root.removeAttribute('style');
    for (const a of ['data-on', 'data-phase', 'data-step']) this.root.removeAttribute(a);
    this.mounted = false;
    this.last = null;
  }

  // ---------------------------------------------------------------- internals

  private pin(parent: Element, id: SpotId): HTMLElement {
    const p = el('div', `ls-pin ls-pin-${id}`, parent);
    el('div', 'ls-pin-head', p, PIN_LETTER[id]);
    el('div', 'ls-pin-stem', p);
    return p;
  }

  private left(e: HTMLElement, pct: number): void {
    const v = `${pct.toFixed(2)}%`;
    if (this.lefts.get(e) === v) return;
    this.lefts.set(e, v);
    e.style.left = v;
  }

  /** A custom property on the root, deduped so a 60 fps render does not dirty style every frame. */
  private prop(name: string, value: string): void {
    const map = this.attrs.get(this.root) ?? new Map<string, string>();
    this.attrs.set(this.root, map);
    const key = `style:${name}`;
    if (map.get(key) === value) return;
    map.set(key, value);
    this.root.style.setProperty(name, value);
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
