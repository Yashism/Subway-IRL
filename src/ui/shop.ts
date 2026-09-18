/**
 * The shop: what the coins are for. Characters and hoverboard skins are palette/prop swaps on
 * the rig the world already has, and the two boosts are mild and consumable — nothing sold here
 * touches the catch rules or lets a player out of jogging.
 *
 * Render-only: it draws a `ShopModel` (src/app/progression.ts) and calls back. It owns no state.
 */

import './missions.css';
import './shop.css';
import type { ShopItemView, ShopKind, ShopModel } from '../app/progression';
import { missionButton, pct } from './missionCard';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: ParentNode, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
};

export interface ShopHandlers {
  buy(id: string): void;
  equip(id: string): void;
  close?(): void;
}

const SECTIONS: readonly { kind: ShopKind; title: string; note: string }[] = [
  { kind: 'character', title: 'Runners', note: 'Same moves, different kid' },
  { kind: 'board', title: 'Hoverboards', note: 'Recolours of the flying carpet' },
  { kind: 'consumable', title: 'Boosts', note: 'One run each' },
];

/** What the item's button says and whether it does anything. */
export function buttonFor(it: ShopItemView): { label: string; action: 'buy' | 'equip' | 'none'; cls: string } {
  switch (it.state) {
    case 'equipped':
      return { label: 'Equipped', action: 'none', cls: 'sh-btn sh-btn-on' };
    case 'owned':
      return { label: 'Equip', action: 'equip', cls: 'sh-btn sh-btn-equip' };
    case 'afford':
      return { label: it.price === 0 ? 'Take it' : `Buy ${it.priceText}`, action: 'buy', cls: 'sh-btn sh-btn-buy' };
    default:
      return { label: `${it.short.toLocaleString('en-IN')} more`, action: 'none', cls: 'sh-btn sh-btn-locked' };
  }
}

function renderItem(it: ShopItemView, h: ShopHandlers): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sh-item';
  card.dataset.state = it.state;
  card.dataset.kind = it.kind;

  const art = el('div', 'sh-art', card);
  el('div', 'sh-art-glyph', art, it.icon);
  const chips = el('div', 'sh-swatch', art);
  for (const c of it.swatch) el('span', 'sh-chip', chips).style.background = c;

  const body = el('div', 'sh-body', card);
  const head = el('div', 'sh-item-head', body);
  el('div', 'sh-name', head, it.name);
  if (it.held !== null && it.held > 0) el('div', 'sh-held', head, `×${it.held}`);
  el('div', 'sh-blurb', body, it.blurb);

  const foot = el('div', 'sh-foot', body);
  const price = el('div', 'sh-price', foot);
  el('span', 'ms-coin', price, '🪙');
  el('span', 'sh-price-n', price, it.priceText);

  const b = buttonFor(it);
  if (b.action === 'none') {
    const dead = el('button', b.cls, foot, b.label);
    dead.type = 'button';
    dead.disabled = true;
  } else {
    missionButton(foot, b.cls, b.label, () => (b.action === 'buy' ? h.buy(it.id) : h.equip(it.id)));
  }
  return card;
}

/**
 * The full-screen unlock screen. `update(null)` hides it; the layer starts hidden so the CSS
 * always has a state to look at.
 */
export class ShopScreen {
  private readonly root: HTMLElement;
  private readonly handlers: ShopHandlers;
  private key = '';

  constructor(root: HTMLElement, handlers: ShopHandlers) {
    this.root = root;
    this.handlers = handlers;
    root.classList.add('shop');
    root.dataset.on = 'off';
  }

  update(m: ShopModel | null): void {
    const key = JSON.stringify(m);
    if (key === this.key) return;
    this.key = key;
    if (!m) {
      this.root.dataset.on = 'off';
      this.root.replaceChildren();
      return;
    }
    this.root.dataset.on = 'on';
    const frag = document.createDocumentFragment();

    // ---- header: the title, the purse and the level bar
    const top = el('div', 'sh-top', frag);
    el('div', 'sh-title', top, 'SHOP');
    const purse = el('div', 'sh-purse', top);
    el('span', 'ms-coin', purse, '🪙');
    el('span', 'sh-purse-n', purse, m.balanceText);

    const lvl = el('div', 'sh-level', frag);
    const lhead = el('div', 'sh-level-head', lvl);
    el('div', 'sh-level-text', lhead, m.levelText);
    el('div', 'sh-level-sub', lhead, m.levelSub);
    const bar = el('div', 'ms-bar', lvl);
    el('div', 'ms-bar-fill', bar).style.width = pct(m.levelFrac);
    el('div', 'sh-level-note', lvl, 'Levels only pay out coins — nothing is ever locked behind one.');

    // ---- the sections
    const body = el('div', 'sh-sections', frag);
    for (const s of SECTIONS) {
      const items = m.items.filter((i) => i.kind === s.kind);
      if (!items.length) continue;
      const sec = el('div', 'sh-section', body);
      const head = el('div', 'sh-section-head', sec);
      el('div', 'sh-section-title', head, s.title);
      el('div', 'sh-section-note', head, s.note);
      const grid = el('div', 'sh-grid', sec);
      for (const it of items) grid.append(renderItem(it, this.handlers));
    }

    if (this.handlers.close) {
      const actions = el('div', 'sh-actions', frag);
      missionButton(actions, 'ms-btn', '⌂ Back', () => this.handlers.close?.());
    }
    this.root.replaceChildren(frag);
  }

  destroy(): void {
    this.root.replaceChildren();
    this.root.classList.remove('shop');
    delete this.root.dataset.on;
    this.key = '';
  }
}
