// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowInput, ScreenModel } from '../../src/app/flow';
import { MOVE_ORDER, type MoveCheckSummary } from '../../src/pose/moveCheckTypes';
import type { PlayMode } from '../../src/pose/types';
import { Hud, MONITOR_URL, MONITOR_WINDOW } from '../../src/ui/hud';
import { renderSummaryCard } from '../../src/ui/moveCheckScreen';
import { PoseScreens } from '../../src/ui/poseScreens';

/** The UI classes only read the model, so a plain literal is enough. */
const model = (over: Partial<ScreenModel> = {}): ScreenModel => ({
  screen: 'calibrating',
  input: 'webcam',
  error: '',
  cameraId: 'cam-a',
  modeChoice: 'auto',
  detectedMode: null,
  tracking: true,
  checks: { body: 'ok', distance: 'ok', light: 'ok' },
  hint: '',
  progress: 0.5,
  message: '',
  startProgress: 0,
  recheck: false,
  playAgain: '',
  showRecalibrate: false,
  showMoveCheck: false,
  gameState: 'menu',
  ...over,
});

const CAMS = [
  { deviceId: 'cam-a', label: 'Integrated Camera' },
  { deviceId: 'cam-b', label: 'Logitech C920' },
];

function screens() {
  const root = document.createElement('div');
  document.body.append(root);
  const inputs: FlowInput[] = [];
  const ui = new PoseScreens(root, { onInput: (i) => inputs.push(i) });
  ui.setCameras(CAMS, 'cam-a');
  ui.update(model());
  const select = root.querySelector<HTMLSelectElement>('.ps-select')!;
  return { root, ui, inputs, select };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('PoseScreens: camera picker keys', () => {
  it('keeps typed keys away from the game while the dropdown has focus', () => {
    const r = screens();
    const seen: string[] = [];
    window.addEventListener('keydown', (e) => seen.push(e.key));
    r.select.focus();
    r.select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(seen).toEqual([]);
  });

  it('lets go of the dropdown on Escape, so the keyboard is not dead afterwards', () => {
    const r = screens();
    const seen: string[] = [];
    window.addEventListener('keydown', (e) => seen.push(e.key));
    r.select.focus();
    expect(document.activeElement).toBe(r.select);
    r.select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).not.toBe(r.select);
    // The next Enter must reach the window handler (start / resume).
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(seen).toEqual(['Enter']);
  });

  it('lets go of the dropdown on Enter too', () => {
    const r = screens();
    r.select.focus();
    r.select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(document.activeElement).not.toBe(r.select);
  });

  it('a camera choice is reported and drops focus', () => {
    const r = screens();
    r.select.focus();
    r.select.value = 'cam-b';
    r.select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(r.inputs).toEqual([{ type: 'chooseCamera', id: 'cam-b' }]);
    expect(document.activeElement).not.toBe(r.select);
  });
});

describe('Hud: live monitor link', () => {
  function hud() {
    const root = document.createElement('div');
    document.body.append(root);
    new Hud(root);
    const link = root.querySelector<HTMLAnchorElement>('.hud-monitor-link')!;
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal('open', open);
    return { root, link, open };
  }

  it('opens a popup window instead of a tab, and does not keep focus', () => {
    const h = hud();
    h.link.focus();
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    h.link.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(h.open).toHaveBeenCalledTimes(1);
    const [url, name, features] = h.open.mock.calls[0] as unknown as [string, string, string];
    expect(url).toBe(MONITOR_URL);
    expect(name).toBe(MONITOR_WINDOW);
    expect(features).toMatch(/popup=yes/);
    expect(document.activeElement).not.toBe(h.link);
  });

  it('leaves ctrl-click and middle-click to the browser', () => {
    const h = hud();
    const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    h.link.dispatchEvent(ctrl);
    const middle = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 });
    h.link.dispatchEvent(middle);
    expect(h.open).not.toHaveBeenCalled();
    expect(ctrl.defaultPrevented).toBe(false);
  });
});

describe('Hud: the pause screen’s Controls card', () => {
  const summary = (mode: PlayMode = 'full'): MoveCheckSummary => ({
    mode,
    steps: MOVE_ORDER.map((id) => ({
      id,
      status: 'done' as const,
      label: id,
      how: `do ${id}`,
      hint: null,
      canSkip: false,
      canAccept: false,
      progress: 1,
      peak: 0.4,
      steps: null,
    })),
    tuned: { laneEnter: 0.3 },
    asymmetryNote: null,
  });

  it('shows the cheat sheet on the paused card, and swaps or clears it on demand', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const hud = new Hud(root);
    const box = root.querySelector<HTMLElement>('.hud-pause-controls')!;
    expect(box.children).toHaveLength(0);

    const card = renderSummaryCard(summary(), { title: 'Controls' });
    hud.setControls(card);
    expect(box.firstElementChild).toBe(card);
    expect(box.querySelector('.mc-sheet-title')!.textContent).toBe('Controls');
    expect(box.querySelectorAll('.mc-row')).toHaveLength(MOVE_ORDER.length + 1); // + the start gesture

    // The same element every frame must not be re-attached.
    const before = box.firstElementChild;
    hud.setControls(card);
    expect(box.firstElementChild).toBe(before);

    const other = renderSummaryCard(summary('small'));
    hud.setControls(other);
    expect(box.firstElementChild).toBe(other);
    hud.setControls(null);
    expect(box.children).toHaveLength(0);
  });
});

describe('Hud: the Home button', () => {
  function hud() {
    const root = document.createElement('div');
    document.body.append(root);
    const log: string[] = [];
    const h = new Hud(root, { onHome: () => log.push('home') });
    return { root, h, log, buttons: [...root.querySelectorAll<HTMLButtonElement>('.hud-home')] };
  }

  it('sits on the pause card and the run summary, and lets go of focus on click', () => {
    const h = hud();
    expect(h.buttons).toHaveLength(2);
    expect(h.root.querySelector('.hud-paused .hud-home')).not.toBeNull();
    expect(h.root.querySelector('.hud-summary .hud-home')).not.toBeNull();
    for (const b of h.buttons) {
      expect(b.textContent).toBe('⌂ Main menu');
      b.focus();
      b.click();
      // A focused button would swallow the Enter that starts the next run.
      expect(document.activeElement).not.toBe(b);
    }
    expect(h.log).toEqual(['home', 'home']);
  });

  it('is inert rather than broken when the page wired no handler', () => {
    const root = document.createElement('div');
    document.body.append(root);
    new Hud(root);
    const btn = root.querySelector<HTMLButtonElement>('.hud-home')!;
    expect(() => btn.click()).not.toThrow();
  });

  it('keeps the summary card’s Home well clear of the PLAY AGAIN target', () => {
    // Reflex on the summary is Enter or the big PLAY AGAIN badge; Home must not be next to it.
    const h = hud();
    const card = h.root.querySelector('.hud-summary .hud-card')!;
    const kids = [...card.children];
    expect(kids.at(-1)!.classList.contains('hud-home')).toBe(true);
    expect(kids.indexOf(card.querySelector('.hud-again')!)).toBeLessThan(kids.length - 2);
  });
});
