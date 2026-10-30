/**
 * Wander's own little overlay: where you are (a quiet station-sign card), how to leave, and a pause
 * note. DOM only, styled by wander.css. Nothing here knows about the game's HUD.
 */
import './wander.css';
import type { Place } from './places';

const el = (tag: string, cls: string, text = ''): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export class WanderHud {
  readonly root = el('div', 'wander');
  private readonly place = el('div', 'wander-place');
  private readonly code = el('span', 'wander-code');
  private readonly name = el('div', 'wander-name');
  private readonly sub = el('div', 'wander-sub');
  private readonly mr = el('div', 'wander-mr');
  private readonly controls = el('div', 'wander-controls');
  private readonly hint = el('div', 'wander-hint');
  private readonly pause = el('div', 'wander-pause');
  private placeKey = '';
  private controlsText = '';

  constructor(parent: HTMLElement = document.body) {
    const head = el('div', 'wander-head');
    head.append(this.code, this.name);
    this.place.append(head, this.sub, this.mr);
    this.place.hidden = true;

    const esc = el('kbd', 'wander-key', 'Esc');
    const p = el('kbd', 'wander-key', 'P');
    this.hint.append(esc, document.createTextNode(' Back to menu'), el('span', 'wander-gap'), p, document.createTextNode(' Pause'));

    const title = el('div', 'wander-pause-title', 'Paused');
    const note = el('div', 'wander-pause-note');
    note.append(el('kbd', 'wander-key', 'P'), document.createTextNode(' Resume'), el('span', 'wander-gap'), el('kbd', 'wander-key', 'Esc'), document.createTextNode(' Back to menu'));
    this.pause.append(title, note);
    this.pause.hidden = true;

    this.root.hidden = true;
    this.root.append(this.place, this.controls, this.hint, this.pause);
    parent.append(this.root);
  }

  show(): void {
    this.root.hidden = false;
    this.root.dataset.fresh = '1';
    // The controls line is a hint for the first few seconds, then it gets out of the way.
    window.setTimeout(() => delete this.root.dataset.fresh, 9000);
  }

  hide(): void {
    this.root.hidden = true;
  }

  setPlace(p: Place): void {
    if (p.key === this.placeKey) return;
    this.placeKey = p.key;
    this.place.hidden = false;
    this.name.textContent = p.primary;
    this.sub.textContent = p.secondary;
    this.code.textContent = p.code ?? '';
    this.code.hidden = !p.code;
    this.mr.textContent = p.marathi ?? '';
    this.mr.hidden = !p.marathi;
    this.place.dataset.kind = p.kind;
    // Re-run the fade-in so a new name is noticed without being loud.
    this.place.classList.remove('wander-swap');
    void this.place.offsetWidth;
    this.place.classList.add('wander-swap');
  }

  /** The faint line of control hints under the place card ('' hides it). */
  setControls(text: string): void {
    if (text === this.controlsText) return;
    this.controlsText = text;
    this.controls.textContent = text;
    this.controls.hidden = !text;
  }

  setPaused(paused: boolean): void {
    this.pause.hidden = !paused;
  }

  dispose(): void {
    this.root.remove();
  }
}
