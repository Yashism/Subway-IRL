// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlowInput, ScreenModel } from '../../src/app/flow';
import { Hud, MONITOR_URL, MONITOR_WINDOW } from '../../src/ui/hud';
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
