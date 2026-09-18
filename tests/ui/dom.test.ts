// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowInput, ScreenModel } from '../../src/app/flow';
import { Game } from '../../src/game/game';
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

describe('Hud: a pause notice the player did not ask for', () => {
  it('replaces the usual hint while set, stands out, and gives the hint back when cleared', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const hud = new Hud(root);
    const game = new Game({ seed: 1, difficulty: 'cardio' });
    game.state = 'paused';
    const sub = root.querySelector<HTMLElement>('.hud-pause-sub')!;

    hud.update(game);
    const usual = sub.textContent;
    expect(usual).toBe('Press Enter to resume');
    expect(sub.classList.contains('notice')).toBe(false);

    hud.setPauseNotice('The graphics are restarting — hang on a moment');
    hud.update(game);
    expect(sub.textContent).toBe('The graphics are restarting — hang on a moment');
    expect(sub.classList.contains('notice')).toBe(true);

    hud.setPauseNotice(null);
    hud.update(game);
    expect(sub.textContent).toBe(usual);
    expect(sub.classList.contains('notice')).toBe(false);
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
    // The card ends with the quiet button row, and Home is the last thing in it.
    const foot = kids.at(-1)!;
    expect(foot.classList.contains('hud-card-foot')).toBe(true);
    expect([...foot.children].at(-1)!.classList.contains('hud-home')).toBe(true);
    expect(kids.indexOf(card.querySelector('.hud-again')!)).toBeLessThan(kids.length - 2);
  });
});

describe('Hud: settings, the workout screen and the mission slots', () => {
  function hud() {
    const root = document.createElement('div');
    document.body.append(root);
    const log: string[] = [];
    const h = new Hud(root, {
      onHome: () => log.push('home'),
      onSettings: () => log.push('settings'),
      onWorkout: () => log.push('workout'),
    });
    return { root, h, log };
  }

  it('offers ⚙ Settings from the menu and from the pause card, and nowhere a run can be started by reflex', () => {
    const h = hud();
    const gears = [...h.root.querySelectorAll<HTMLButtonElement>('.hud-gear')];
    expect(gears).toHaveLength(2);
    expect(h.root.querySelector('.hud-menu .hud-gear')).not.toBeNull();
    expect(h.root.querySelector('.hud-paused .hud-gear')).not.toBeNull();
    expect(h.root.querySelector('.hud-summary .hud-gear')).toBeNull();
    for (const g of gears) {
      g.focus();
      g.click();
      expect(document.activeElement).not.toBe(g);
    }
    expect(h.log).toEqual(['settings', 'settings']);
  });

  it('offers "Your runs" from the menu and from the summary card', () => {
    const h = hud();
    expect(h.root.querySelector('.hud-menu .hud-workout')).not.toBeNull();
    expect(h.root.querySelector('.hud-summary .hud-workout')).not.toBeNull();
    h.root.querySelector<HTMLButtonElement>('.hud-summary .hud-workout')!.click();
    expect(h.log).toEqual(['workout']);
  });

  it('is inert rather than broken when the page wired no handlers', () => {
    const root = document.createElement('div');
    document.body.append(root);
    new Hud(root);
    for (const sel of ['.hud-gear', '.hud-workout']) {
      expect(() => root.querySelector<HTMLButtonElement>(sel)!.click()).not.toThrow();
    }
  });

  it('gives the mission board a home on the menu and the mission list one on the summary card', () => {
    const h = hud();
    expect(h.h.menuPanel.closest('.hud-menu')).not.toBeNull();
    expect(h.h.summaryPanel.closest('.hud-summary .hud-card')).not.toBeNull();
    // The summary list sits above PLAY AGAIN, not between it and the quiet button row.
    const card = h.root.querySelector('.hud-summary .hud-card')!;
    const kids = [...card.children];
    expect(kids.indexOf(h.h.summaryPanel)).toBeLessThan(kids.indexOf(card.querySelector('.hud-again')!));
  });

  it('shows one mission toast at a time and clears it on null', () => {
    const h = hud();
    const host = h.root.querySelector('.hud-toasts')!;
    const a = document.createElement('div');
    a.className = 'one';
    const b = document.createElement('div');
    b.className = 'two';
    h.h.setMissionToast(a);
    expect([...host.children]).toEqual([a]);
    h.h.setMissionToast(b);
    expect([...host.children]).toEqual([b]);
    h.h.setMissionToast(null);
    expect(host.children).toHaveLength(0);
  });

  it('the intro takes the screen: every card steps aside, the skip line does not', () => {
    const h = hud();
    expect(h.root.dataset.intro).toBeUndefined();
    h.h.setIntro(true);
    expect(h.root.dataset.intro).toBe('on');
    expect(h.root.querySelector('.hud-intro-hint')!.textContent).toMatch(/skip/i);
    h.h.setIntro(false);
    expect(h.root.dataset.intro).toBeUndefined();
  });
});

describe('Hud: the mute button', () => {
  function hud() {
    const root = document.createElement('div');
    document.body.append(root);
    const log: string[] = [];
    const h = new Hud(root, { onToggleSound: () => log.push('sound') });
    return { root, h, log, btn: root.querySelector<HTMLButtonElement>('.hud-sound')! };
  }

  it('sits outside every card, so it is reachable on the menu, in a run and under the intro', () => {
    const h = hud();
    expect(h.btn).not.toBeNull();
    expect(h.btn.closest('.hud-screen')).toBeNull();
    expect(h.btn.closest('.hud-play')).toBeNull();
    // The intro hides the cards and the play HUD; the speaker is neither.
    h.h.setIntro(true);
    expect(h.btn.closest('[data-intro]')).toBe(h.root);
  });

  it('reports the press and lets go of focus', () => {
    const h = hud();
    h.btn.focus();
    h.btn.click();
    expect(h.log).toEqual(['sound']);
    expect(document.activeElement).not.toBe(h.btn);
  });

  it('says which of the three states it is in, and says it to a screen reader too', () => {
    const h = hud();
    h.h.setSound({ muted: false, ready: false });
    expect(h.btn.classList.contains('idle')).toBe(true);
    expect(h.btn.getAttribute('aria-label')).toMatch(/first key or click/i);

    h.h.setSound({ muted: false, ready: true });
    expect(h.btn.classList.contains('idle')).toBe(false);
    expect(h.btn.classList.contains('muted')).toBe(false);
    expect(h.btn.getAttribute('aria-label')).toBe('Mute (N)');
    expect(h.btn.getAttribute('aria-pressed')).toBe('false');

    h.h.setSound({ muted: true, ready: true });
    expect(h.btn.classList.contains('muted')).toBe(true);
    expect(h.btn.textContent).toBe('\u{1F507}');
    expect(h.btn.getAttribute('aria-label')).toBe('Unmute (N)');
    expect(h.btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('is inert rather than broken when the page wired no handler', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const h = new Hud(root);
    expect(() => root.querySelector<HTMLButtonElement>('.hud-sound')!.click()).not.toThrow();
    expect(() => h.setSound({ muted: true, ready: true })).not.toThrow();
  });
});
