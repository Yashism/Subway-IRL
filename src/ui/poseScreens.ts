import './poseScreens.css';
import { nextMode, type CheckState, type FlowInput, type FlowScreen, type ModeChoice, type ScreenModel } from '../app/flow';
import { isIrCamera, type CameraInfo } from '../pose/camera';
import type { PlayMode } from '../pose/types';

// ---------------------------------------------------------------- pure view helpers

export interface CameraOption {
  id: string;
  label: string;
  selected: boolean;
}

/** Picker entries: IR cameras hidden (kept, labelled, only if nothing else exists); the chosen one selected. */
export function cameraOptions(cams: readonly CameraInfo[], selectedId: string | null): CameraOption[] {
  const rgb = cams.filter((c) => !isIrCamera(c.label));
  const list = rgb.length ? rgb.map((c) => ({ id: c.deviceId, label: c.label })) : cams.map((c) => ({ id: c.deviceId, label: `${c.label} (IR)` }));
  const hit = list.some((c) => c.id === selectedId);
  return list.map((c, i) => ({ ...c, selected: hit ? c.id === selectedId : i === 0 }));
}

const MODE_NAMES: Record<PlayMode, string> = { full: 'Full body', small: 'Small room' };

export function modeChipLabel(choice: ModeChoice, detected: PlayMode | null): string {
  if (choice !== 'auto') return MODE_NAMES[choice];
  return detected ? `Auto · ${MODE_NAMES[detected]}` : 'Auto';
}

export const checkIcon = (s: CheckState): string => (s === 'ok' ? '✓' : s === 'bad' ? '✗' : '…');

/** stroke-dashoffset for a ring of the given circumference at progress p (0 = empty). */
export function ringDash(p: number, circumference: number): string {
  const f = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  return ((1 - f) * circumference).toFixed(1);
}

export interface Toast {
  level: 'slow' | 'stalled';
  text: string;
}

const TOAST_SLOW: Toast = { level: 'slow', text: 'Camera is slow — tracking may lag' };
const TOAST_STALLED: Toast = { level: 'stalled', text: 'Camera stalled — pausing' };
const TOAST_STALLED_IDLE: Toast = { level: 'stalled', text: 'Camera stalled — no frames coming in' };

/**
 * The stalled toast beats the slow one. `running` says whether there is a live run to pause:
 * on the calibration or ready screen nothing is paused, so it must not promise it.
 */
export const warningToast = (slow: boolean, stalled: boolean, running = true): Toast | null =>
  stalled ? (running ? TOAST_STALLED : TOAST_STALLED_IDLE) : slow ? TOAST_SLOW : null;

type CopyScreen = Exclude<FlowScreen, 'menu' | 'playing'>;
const COPY: Record<CopyScreen, { tab: string; title: string; body: string }> = {
  cameraPrompt: {
    tab: 'CAMERA TIME',
    title: 'Your body is the controller!',
    body: 'Video never leaves this laptop. Nothing is recorded or uploaded.',
  },
  cameraStarting: { tab: 'HOLD ON', title: 'Starting camera…', body: 'Allow camera access if your browser asks.' },
  cameraError: { tab: 'UH-OH', title: 'Camera trouble', body: '' },
  calibrating: { tab: 'GET IN POSITION', title: 'Stand inside the outline', body: '' },
  ready: { tab: 'READY!', title: 'Calibrated!', body: '' },
};

export const screenCopy = (s: CopyScreen) => COPY[s];

export interface MessageParts {
  /** Leading exclamation ("Calibrated!"), shown under the banner. */
  head: string;
  main: string;
  /** Trailing parenthetical, shown small ("or press Enter"). */
  sub: string;
}

/** Splits "Calibrated! Raise your RIGHT hand to start (or press Enter)" into banner / pill / small print. */
export function messageParts(msg: string): MessageParts {
  let rest = msg;
  let head = '';
  const bang = rest.indexOf('! ');
  if (bang >= 0) {
    head = rest.slice(0, bang + 1);
    rest = rest.slice(bang + 2);
  }
  let sub = '';
  const m = /\s*\(([^)]*)\)\s*$/.exec(rest);
  if (m) {
    sub = m[1];
    rest = rest.slice(0, m.index);
  }
  return { head, main: rest, sub };
}

// ---------------------------------------------------------------- DOM

const SVG = 'http://www.w3.org/2000/svg';
const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

// Static silhouette geometry (viewBox 0 0 200 400).
const BODY_PATH =
  'M88 82 L88 96 Q88 100 84 100 L66 102 Q52 104 50 120 L40 232 Q40 244 50 244 Q58 244 60 234 L68 150 L70 214 ' +
  'L68 376 Q68 388 80 388 L88 388 Q96 388 96 376 L98 250 Q100 244 102 250 L104 376 Q104 388 112 388 L120 388 ' +
  'Q132 388 132 376 L130 214 L132 150 L140 234 Q142 244 150 244 Q160 244 160 232 L150 120 Q148 104 134 102 ' +
  'L116 100 Q112 100 112 96 L112 82 Z';
const VIEW_FULL = '20 8 160 390';
const VIEW_SMALL = '20 8 160 220';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, text?: string): HTMLElementTagNameMap[K] => {
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

function ring(parent: HTMLElement, cls: string): { box: HTMLElement; arc: SVGElement; core: HTMLElement } {
  const box = el('div', `ps-ring ${cls}`, parent);
  const s = svg('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' }, box);
  svg('circle', { class: 'ps-ring-track', cx: '32', cy: '32', r: String(RING_R) }, s);
  const arc = svg('circle', {
    class: 'ps-ring-arc',
    cx: '32',
    cy: '32',
    r: String(RING_R),
    'stroke-dasharray': RING_C.toFixed(1),
    'stroke-dashoffset': RING_C.toFixed(1),
  }, s);
  const core = el('div', 'ps-ring-core', box);
  return { box, arc, core };
}

export interface PoseScreensHandlers {
  /** Every button, chip and picker action, as a flow input. */
  onInput(input: FlowInput): void;
  /** The player picked a camera: remember it (e.g. localStorage). */
  onSaveCamera?(id: string): void;
}

interface CheckRow {
  row: HTMLElement;
  icon: HTMLElement;
}

interface Picker {
  box: HTMLElement;
  select: HTMLSelectElement;
}

/**
 * Webcam setup and calibration screens, rendered from the SessionFlow screen model.
 * Writes to the DOM only on change; all dynamic text goes through textContent.
 * The root is `pointer-events: none` like the HUD; buttons opt back in.
 */
export class PoseScreens {
  private readonly root: HTMLElement;
  private readonly handlers: PoseScreensHandlers;
  private last: ScreenModel | null = null;
  private readonly lastText = new Map<Element, string>();
  private readonly pickers: Picker[] = [];
  private cams: readonly CameraInfo[] = [];
  private camId: string | null = null;
  private modeChoice: ModeChoice = 'auto';

  // menu
  private readonly menuIcon: HTMLElement;
  private readonly menuTitle: HTMLElement;
  private readonly menuSub: HTMLElement;
  private readonly menuSwitch: HTMLButtonElement;
  // error
  private readonly errorText: HTMLElement;
  // calibration
  private readonly calTab: HTMLElement;
  private readonly calTitle: HTMLElement;
  private readonly silhouette: SVGElement;
  private readonly checks: Record<'body' | 'distance' | 'light', CheckRow>;
  private readonly modeChip: HTMLButtonElement;
  private readonly modeLabel: HTMLElement;
  private readonly calRing: ReturnType<typeof ring>;
  private readonly startRing: ReturnType<typeof ring>;
  private readonly message: HTMLElement;
  private readonly messageSub: HTMLElement;
  // play
  private readonly playAgain: HTMLElement;
  // toasts
  private readonly toast: HTMLElement;
  private readonly toastText: HTMLElement;

  constructor(root: HTMLElement, handlers: PoseScreensHandlers) {
    this.root = root;
    this.handlers = handlers;
    root.classList.add('pose-ui');
    root.dataset.screen = 'menu';

    // ---- menu: input-mode card, top right under nothing (the HUD hides its play pills in the menu)
    const menu = el('div', 'ps-layer ps-menu', root);
    const mcard = el('div', 'ps-mode-card', menu);
    this.menuIcon = el('div', 'ps-mode-card-icon', mcard);
    const mtext = el('div', 'ps-mode-card-text', mcard);
    this.menuTitle = el('div', 'ps-mode-card-title', mtext);
    this.menuSub = el('div', 'ps-mode-card-sub', mtext);
    this.menuSwitch = this.button(mcard, 'ps-btn ps-btn-small', '', () =>
      this.emit({ type: this.last?.input === 'keyboard' ? 'useWebcam' : 'useKeyboard' }),
    );

    // ---- camera prompt
    const prompt = this.modal('ps-prompt', COPY.cameraPrompt.tab);
    const hero = el('div', 'ps-hero', prompt);
    el('div', 'ps-hero-cam', hero, '📷');
    el('div', 'ps-title', prompt, COPY.cameraPrompt.title);
    el('div', 'ps-body', prompt, 'Your webcam watches you move — that is how you play.');
    const moves = el('div', 'ps-moves', prompt);
    for (const [icon, label, cls] of [
      ['🏃', 'Jog', 'jog'],
      ['⤴', 'Jump', 'jump'],
      ['⤵', 'Duck', 'duck'],
      ['⇆', 'Step', 'step'],
    ]) {
      const m = el('div', `ps-move ps-move-${cls}`, moves);
      el('div', 'ps-move-icon', m, icon);
      el('div', 'ps-move-label', m, label);
    }
    const privacy = el('div', 'ps-privacy', prompt);
    el('span', 'ps-privacy-icon', privacy, '🔒');
    el('span', 'ps-privacy-text', privacy, COPY.cameraPrompt.body);
    const pActions = el('div', 'ps-actions', prompt);
    this.button(pActions, 'ps-btn ps-btn-go', 'USE WEBCAM', () => this.emit({ type: 'startPressed' }));
    this.button(pActions, 'ps-btn ps-btn-alt', 'Play with keyboard', () => this.emit({ type: 'useKeyboard' }));
    el('div', 'ps-foot', prompt, 'Your browser will ask for camera permission.');

    // ---- camera starting
    const starting = this.modal('ps-starting', COPY.cameraStarting.tab);
    const spin = el('div', 'ps-spinner', starting);
    el('div', 'ps-spinner-cam', spin, '📷');
    el('div', 'ps-title', starting, COPY.cameraStarting.title);
    el('div', 'ps-body', starting, COPY.cameraStarting.body);
    const sActions = el('div', 'ps-actions', starting);
    this.button(sActions, 'ps-btn ps-btn-alt', 'Play with keyboard', () => this.emit({ type: 'useKeyboard' }));

    // ---- camera error
    const error = this.modal('ps-error', COPY.cameraError.tab);
    const eh = el('div', 'ps-hero ps-hero-error', error);
    el('div', 'ps-hero-cam', eh, '📷');
    el('div', 'ps-hero-x', eh, '!');
    el('div', 'ps-title', error, COPY.cameraError.title);
    this.errorText = el('div', 'ps-body ps-error-text', error);
    this.picker(error, 'ps-picker-inline');
    const eActions = el('div', 'ps-actions', error);
    this.button(eActions, 'ps-btn ps-btn-go', 'RETRY', () => this.emit({ type: 'retry' }));
    this.button(eActions, 'ps-btn ps-btn-alt', 'Play with keyboard', () => this.emit({ type: 'useKeyboard' }));

    // ---- calibration / ready
    const cal = el('div', 'ps-layer ps-calib', root);
    const banner = el('div', 'ps-banner', cal);
    this.calTab = el('div', 'ps-banner-tab', banner);
    this.calTitle = el('div', 'ps-banner-sub', banner);

    const fig = el('div', 'ps-figure', cal);
    this.silhouette = svg('svg', { class: 'ps-silhouette', viewBox: VIEW_FULL, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true' }, fig);
    svg('circle', { class: 'ps-sil-shape', cx: '100', cy: '48', r: '30' }, this.silhouette);
    svg('path', { class: 'ps-sil-shape', d: BODY_PATH }, this.silhouette);

    const side = el('div', 'ps-side', cal);
    const list = el('div', 'ps-checks', side);
    el('div', 'ps-checks-title', list, 'CHECKLIST');
    const check = (label: string): CheckRow => {
      const row = el('div', 'ps-check', list);
      const icon = el('div', 'ps-check-icon', row);
      el('div', 'ps-check-label', row, label);
      return { row, icon };
    };
    this.checks = { body: check('Body in view'), distance: check('Distance'), light: check('Light') };
    const tools = el('div', 'ps-tools', side);
    this.modeChip = this.button(tools, 'ps-chip', '', () => this.emit({ type: 'chooseMode', mode: nextMode(this.modeChoice) }));
    el('span', 'ps-chip-kicker', this.modeChip, 'MODE');
    this.modeLabel = el('span', 'ps-chip-label', this.modeChip);
    el('span', 'ps-chip-cycle', this.modeChip, '⟳');
    this.picker(tools, 'ps-picker-side');
    const toolRow = el('div', 'ps-tool-row', tools);
    this.button(toolRow, 'ps-btn ps-btn-small ps-recal-ready', 'Recalibrate', () => this.emit({ type: 'recalibrate' }));
    this.button(toolRow, 'ps-btn ps-btn-small ps-btn-ghost', 'Use keyboard', () => this.emit({ type: 'useKeyboard' }));

    const status = el('div', 'ps-status', cal);
    this.calRing = ring(status, 'ps-ring-cal');
    this.startRing = ring(status, 'ps-ring-start');
    this.startRing.core.textContent = '✋';
    const msg = el('div', 'ps-msg-text', status);
    this.message = el('div', 'ps-message', msg);
    this.messageSub = el('div', 'ps-message-sub', msg);

    // ---- playing
    const play = el('div', 'ps-layer ps-play', root);
    this.playAgain = el('div', 'ps-again', play);
    this.button(play, 'ps-btn ps-btn-small ps-recal', '⟳ Recalibrate', () => this.emit({ type: 'recalibrate' }));

    // ---- toasts (any screen)
    this.toast = el('div', 'ps-toast', root);
    el('span', 'ps-toast-icon', this.toast, '📷');
    this.toastText = el('span', 'ps-toast-text', this.toast);
  }

  update(m: ScreenModel): void {
    if (m === this.last) return;
    const prev = this.last;
    this.last = m;
    this.modeChoice = m.modeChoice;
    this.attr(this.root, 'data-screen', m.screen);
    this.attr(this.root, 'data-input', m.input);
    this.attr(this.root, 'data-game', m.gameState);
    const html = document.documentElement;
    if (html.dataset.poseScreen !== m.screen) html.dataset.poseScreen = m.screen;
    if (html.dataset.poseInput !== m.input) html.dataset.poseInput = m.input;

    if (m.screen === 'menu') {
      const cam = m.input === 'webcam';
      this.text(this.menuIcon, cam ? '📷' : '⌨️');
      this.text(this.menuTitle, cam ? 'Webcam mode' : 'Keyboard mode');
      this.text(this.menuSub, cam ? 'Enter or raise your right hand' : 'Enter to start');
      this.text(this.menuSwitch, cam ? 'Use keyboard' : 'Use webcam');
    }
    if (m.screen === 'cameraError') this.text(this.errorText, m.error);
    if (!prev || prev.cameraId !== m.cameraId) {
      this.camId = m.cameraId;
      this.fillPickers();
    }

    if (m.screen === 'calibrating' || m.screen === 'ready') {
      const ready = m.screen === 'ready';
      const parts = messageParts(m.message || m.hint);
      this.text(this.calTab, ready ? COPY.ready.tab : COPY.calibrating.tab);
      this.text(this.calTitle, ready ? parts.head || (m.recheck ? 'Welcome back!' : COPY.ready.title) : COPY.calibrating.title);
      this.attr(this.root, 'data-hint', m.hint ? 'on' : 'off');
      for (const k of ['body', 'distance', 'light'] as const) {
        const s = m.checks[k];
        this.attr(this.checks[k].row, 'data-state', s);
        this.text(this.checks[k].icon, checkIcon(s));
      }
      this.text(this.modeLabel, modeChipLabel(m.modeChoice, m.detectedMode));
      const small = (m.modeChoice === 'auto' ? m.detectedMode : m.modeChoice) === 'small';
      this.attr(this.silhouette, 'viewBox', small ? VIEW_SMALL : VIEW_FULL);
      this.attr(this.root, 'data-small', small ? 'on' : 'off');
      this.attr(this.calRing.arc, 'stroke-dashoffset', ringDash(m.progress, RING_C));
      this.text(this.calRing.core, `${Math.round(m.progress * 100)}%`);
      this.attr(this.startRing.arc, 'stroke-dashoffset', ringDash(m.startProgress, RING_C));
      this.attr(this.root, 'data-holding', m.startProgress > 0 ? 'on' : 'off');
      this.text(this.message, parts.main);
      this.text(this.messageSub, parts.sub);
    }

    this.text(this.playAgain, m.playAgain);
    this.attr(this.root, 'data-recal', m.showRecalibrate ? 'on' : 'off');
  }

  /** Fills every camera dropdown. Call after permission is granted (labels are empty before). */
  setCameras(cams: readonly CameraInfo[], selectedId: string | null): void {
    this.cams = cams;
    this.camId = selectedId;
    this.fillPickers();
  }

  /** Pose warnings: status.slowPose and a stalled stream (see isStalled in pip.ts). */
  setWarnings(slow: boolean, stalled: boolean): void {
    const m = this.last;
    const live = !!m && m.screen === 'playing' && (m.gameState === 'playing' || m.gameState === 'countdown');
    const t = warningToast(slow, stalled, live);
    this.attr(this.toast, 'data-level', t ? t.level : 'none');
    if (t) this.text(this.toastText, t.text);
  }

  destroy(): void {
    this.root.replaceChildren();
    // The dedupe caches key on the nodes that just went away.
    this.lastText.clear();
    this.attrs.clear();
    this.pickers.length = 0;
    this.last = null;
    this.root.classList.remove('pose-ui');
    delete document.documentElement.dataset.poseScreen;
    delete document.documentElement.dataset.poseInput;
  }

  // ---------------------------------------------------------------- internals

  private emit(i: FlowInput): void {
    this.handlers.onInput(i);
  }

  private modal(cls: string, tab: string): HTMLElement {
    const layer = el('div', `ps-layer ps-modal ${cls}`, this.root);
    const card = el('div', 'ps-card', layer);
    el('div', 'ps-card-tab', card, tab);
    return card;
  }

  private button(parent: HTMLElement, cls: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', cls, parent, label);
    b.type = 'button';
    b.addEventListener('click', () => {
      // Drop focus so a later Enter goes to the game's key handler, not this button.
      b.blur();
      onClick();
    });
    return b;
  }

  private picker(parent: HTMLElement, cls: string): void {
    const box = el('label', `ps-picker ${cls}`, parent);
    el('span', 'ps-picker-label', box, '📷 Camera');
    const select = el('select', 'ps-select', box);
    // Keys typed into the dropdown must not reach the game's window key handler. Enter and Escape
    // close it, and a select that keeps focus would swallow every later key (Enter, V, M) for the
    // rest of the session, so let go of it there.
    select.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Esc') select.blur();
    });
    select.addEventListener('change', () => {
      const id = select.value;
      select.blur();
      this.handlers.onSaveCamera?.(id);
      this.emit({ type: 'chooseCamera', id });
    });
    this.pickers.push({ box, select });
    this.fillPicker({ box, select });
  }

  private fillPickers(): void {
    for (const p of this.pickers) this.fillPicker(p);
  }

  private fillPicker({ box, select }: Picker): void {
    const opts = cameraOptions(this.cams, this.camId);
    box.hidden = opts.length < 2;
    select.replaceChildren(
      ...opts.map((o) => {
        const e = document.createElement('option');
        e.value = o.id;
        e.textContent = o.label;
        e.selected = o.selected;
        return e;
      }),
    );
  }

  private text(e: Element, value: string): void {
    if (this.lastText.get(e) === value) return;
    this.lastText.set(e, value);
    e.textContent = value;
  }

  private readonly attrs = new Map<Element, Map<string, string>>();

  private attr(e: Element, name: string, value: string): void {
    let m = this.attrs.get(e);
    if (!m) this.attrs.set(e, (m = new Map()));
    if (m.get(name) === value) return;
    m.set(name, value);
    e.setAttribute(name, value);
  }
}
