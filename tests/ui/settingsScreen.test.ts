// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type GameSettings } from '../../src/app/settings';
import { DEFAULT_SETTINGS as DEFAULT_AUDIO, type AudioSettings } from '../../src/audio/types';
import { AudioSettingsStore, GameAudio } from '../../src/audio';
import { SettingsScreen, onOff, volumePercent, weightLabel, type SettingsHandlers, type SettingsView } from '../../src/ui/settings';

/** The mixer's persistence, without a real localStorage. */
class FakeAudioStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

const CAMS = [
  { id: 'cam-a', label: 'Integrated Camera', selected: true },
  { id: 'cam-b', label: 'Logitech C920', selected: false },
];

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  open: true,
  settings: { ...DEFAULT_SETTINGS },
  audio: { ...DEFAULT_AUDIO },
  cameras: CAMS,
  webcam: true,
  hasTuning: true,
  ...over,
});

function screen() {
  const root = document.createElement('div');
  document.body.append(root);
  const calls: { change: Partial<GameSettings>[]; audio: Partial<AudioSettings>[]; camera: string[]; fired: string[] } = {
    change: [],
    audio: [],
    camera: [],
    fired: [],
  };
  const note = (name: string) => () => void calls.fired.push(name);
  const handlers: SettingsHandlers = {
    change: (p) => void calls.change.push(p),
    audioChange: (p) => void calls.audio.push(p),
    chooseCamera: (id) => void calls.camera.push(id),
    redoMoveCheck: note('redo'),
    resetTuning: note('resetTuning'),
    exportData: note('export'),
    clearHistory: note('clear'),
    openWorkout: note('workout'),
    close: note('close'),
  };
  const ui = new SettingsScreen(root, handlers);
  return { root, ui, calls };
}

const byText = (root: Element, sel: string, text: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(sel)).find((e) => e.textContent === text);

const chip = (root: Element, name: string) => byText(root, '.sw-chip-name', name)?.closest('button') as HTMLButtonElement;

const toggle = (root: Element, label: string) =>
  byText(root, '.sw-row-label', label)?.closest('.sw-row')?.querySelector('button') as HTMLButtonElement;

afterEach(() => {
  document.body.replaceChildren();
});

describe('view helpers', () => {
  it('shows a volume as a percentage and refuses nonsense', () => {
    expect(volumePercent(0)).toBe('0%');
    expect(volumePercent(0.755)).toBe('76%');
    expect(volumePercent(5)).toBe('100%');
    expect(volumePercent(Number.NaN)).toBe('0%');
  });

  it('has exactly two words for a toggle, so the badge never resizes', () => {
    expect(onOff(true)).toBe('ON');
    expect(onOff(false)).toBe('OFF');
  });

  it('says "not set" rather than inventing a weight', () => {
    expect(weightLabel(null)).toBe('Not set');
    expect(weightLabel(70)).toBe('70 kg');
  });
});

describe('mounting', () => {
  it('shows and hides the layer', () => {
    const { root, ui } = screen();
    ui.update(null);
    expect(root.dataset.on).toBe('off');
    ui.update(view());
    expect(root.dataset.on).toBe('on');
    ui.update(view({ open: false }));
    expect(root.dataset.on).toBe('off');
  });

  it('builds every group exactly once, however often it is updated', () => {
    const { root, ui } = screen();
    ui.update(view());
    ui.update(view());
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, line: 'harbour' } }));
    expect(root.querySelectorAll('.sw-group')).toHaveLength(5);
    expect(root.querySelectorAll('.sw-chip')).toHaveLength(9); // mode 3 + line 3 + difficulty 3
  });

  it('takes everything back down on destroy', () => {
    const { root, ui } = screen();
    ui.update(view());
    ui.destroy();
    expect(root.children).toHaveLength(0);
    expect(root.className).toBe('');
    // And can be brought back up again.
    ui.update(view());
    expect(root.querySelectorAll('.sw-group')).toHaveLength(5);
  });
});

describe('the controls', () => {
  it('marks exactly one chip in each group', () => {
    const { root, ui } = screen();
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, line: 'harbour', difficulty: 'beast', mode: 'small' } }));
    expect(chip(root, 'Harbour').dataset.on).toBe('on');
    expect(chip(root, 'Western').dataset.on).toBe('off');
    expect(chip(root, 'Beast').dataset.on).toBe('on');
    expect(chip(root, 'Small room').dataset.on).toBe('on');
    expect(root.querySelectorAll('.sw-chip[data-on="on"]')).toHaveLength(3);
  });

  it('asks for the change it was clicked for, and changes nothing itself', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    chip(root, 'Central').click();
    expect(calls.change).toEqual([{ line: 'central' }]);
    // The screen owns no state: until the app renders the new view, the old one still shows.
    expect(chip(root, 'Western').dataset.on).toBe('on');
  });

  it('flips a toggle to the opposite of what is shown', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    expect(toggle(root, 'Mirror the preview').dataset.on).toBe('on');
    toggle(root, 'Mirror the preview').click();
    expect(calls.change).toEqual([{ mirror: false }]);
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, mirror: false } }));
    expect(toggle(root, 'Mirror the preview').dataset.on).toBe('off');
    expect(toggle(root, 'Mirror the preview').textContent).toContain('OFF');
  });

  it('reports a slider drag as it happens', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    const sens = root.querySelector<HTMLInputElement>('.sw-row-slider .sw-slider')!;
    expect(sens.min).toBe('0.75');
    expect(sens.max).toBe('1.25');
    sens.value = '1.2';
    sens.dispatchEvent(new Event('input'));
    expect(calls.change).toEqual([{ sensitivity: 1.2 }]);
  });

  it('never writes over a slider the player has hold of', () => {
    const { root, ui } = screen();
    ui.update(view());
    const sens = root.querySelector<HTMLInputElement>('.sw-slider')!;
    sens.focus();
    sens.value = '1.25';
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, sensitivity: 0.75 } }));
    expect(sens.value).toBe('1.25');
    sens.blur();
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, sensitivity: 0.75 } }));
    expect(sens.value).toBe('0.75');
  });

  it('says what the sensitivity means in words', () => {
    const { root, ui } = screen();
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, sensitivity: 1.25 } }));
    const note = root.querySelector('.sw-note')!;
    expect(note.textContent).toMatch(/easily/i);
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, sensitivity: 0.75 } }));
    expect(note.textContent).toMatch(/big/i);
  });

  it('writes a volume change through, and shows the mixer it was given', () => {
    const { root, ui, calls } = screen();
    ui.update(view({ audio: { master: 0.4, music: 0.2, sfx: 1, muted: false } }));
    const values = Array.from(root.querySelectorAll('.sw-row-value')).map((e) => e.textContent);
    expect(values).toContain('40%');
    expect(values).toContain('20%');
    expect(values).toContain('100%');
    const music = Array.from(root.querySelectorAll<HTMLInputElement>('.sw-slider')).find((i) => i.getAttribute('aria-label') === 'Music volume')!;
    music.value = '0.6';
    music.dispatchEvent(new Event('input'));
    expect(calls.audio).toEqual([{ music: 0.6 }]);
  });

  it('shows muting without losing the levels', () => {
    const { root, ui } = screen();
    ui.update(view({ audio: { ...DEFAULT_AUDIO, muted: true } }));
    expect(toggle(root, 'Mute everything').dataset.on).toBe('on');
    expect(root.querySelector<HTMLInputElement>('.sw-slider[aria-label="Music volume"]')!.value).toBe(String(DEFAULT_AUDIO.music));
  });

  it('lists the cameras it was given and reports a pick', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    const sel = root.querySelector<HTMLSelectElement>('.sw-select')!;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['Integrated Camera', 'Logitech C920']);
    expect(sel.value).toBe('cam-a');
    sel.value = 'cam-b';
    sel.dispatchEvent(new Event('change'));
    expect(calls.camera).toEqual(['cam-b']);
  });

  it('rebuilds the camera list only when it really changed', () => {
    const { root, ui } = screen();
    ui.update(view());
    const first = root.querySelector('.sw-select')!.firstElementChild;
    ui.update(view());
    expect(root.querySelector('.sw-select')!.firstElementChild).toBe(first);
    ui.update(view({ cameras: [{ id: 'cam-c', label: 'New Camera', selected: true }] }));
    expect(root.querySelector('.sw-select')!.firstElementChild).not.toBe(first);
  });

  it('says so plainly when there is no camera at all', () => {
    const { root, ui } = screen();
    ui.update(view({ cameras: [] }));
    const sel = root.querySelector<HTMLSelectElement>('.sw-select')!;
    expect(sel.options[0].textContent).toBe('No camera found');
    expect(sel.disabled).toBe(true);
  });

  it('dims and disables the camera controls in keyboard mode', () => {
    const { root, ui } = screen();
    ui.update(view({ webcam: false }));
    const groups = Array.from(root.querySelectorAll('.sw-group')).filter((g) => g.getAttribute('data-off') === 'on');
    expect(groups).toHaveLength(2);
    expect(byText(root, '.sw-btn', 'Redo the move check')!.hasAttribute('disabled')).toBe(true);
  });

  it('offers "reset my tuning" only when there is a tuning to reset', () => {
    const { root, ui } = screen();
    ui.update(view({ hasTuning: false }));
    expect((byText(root, '.sw-btn', 'Reset my tuning') as HTMLButtonElement).disabled).toBe(true);
    ui.update(view({ hasTuning: true }));
    expect((byText(root, '.sw-btn', 'Reset my tuning') as HTMLButtonElement).disabled).toBe(false);
  });

  it('marks the weight the estimate will use', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    expect(byText(root, '.sw-weight', 'Not set')!.dataset.on).toBe('on');
    byText(root, '.sw-weight', '80')!.click();
    expect(calls.change).toEqual([{ weightKg: 80 }]);
    ui.update(view({ settings: { ...DEFAULT_SETTINGS, weightKg: 80 } }));
    expect(byText(root, '.sw-weight', '80')!.dataset.on).toBe('on');
    expect(byText(root, '.sw-weight', 'Not set')!.dataset.on).toBe('off');
  });
});

describe('the confirm dialog', () => {
  it('does not clear anything until it is confirmed', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    byText(root, '.sw-btn', 'Clear my history')!.click();
    expect(calls.fired).toEqual([]);
    expect(root.querySelector('.sw-dialog')!.getAttribute('data-on')).toBe('on');
    expect(root.querySelector('.sw-dialog-body')!.textContent).toMatch(/cannot be undone/i);
    byText(root, '.sw-btn', 'Yes, erase it all')!.click();
    expect(calls.fired).toEqual(['clear']);
    expect(root.querySelector('.sw-dialog')!.getAttribute('data-on')).toBe('off');
  });

  it('does nothing at all when it is cancelled', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    byText(root, '.sw-btn', 'Clear my history')!.click();
    byText(root, '.sw-btn', 'Cancel')!.click();
    expect(calls.fired).toEqual([]);
    expect(ui.confirm).toBeNull();
  });

  it('confirms a tuning reset too, in gentler words', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    byText(root, '.sw-btn', 'Reset my tuning')!.click();
    expect(ui.confirm?.danger).toBe(false);
    byText(root, '.sw-btn', 'Yes, reset it')!.click();
    expect(calls.fired).toEqual(['resetTuning']);
  });

  it('closes itself when the whole screen closes', () => {
    const { root, ui } = screen();
    ui.update(view());
    byText(root, '.sw-btn', 'Clear my history')!.click();
    ui.update(null);
    expect(ui.confirm).toBeNull();
    expect(root.querySelector('.sw-dialog')!.getAttribute('data-on')).toBe('off');
  });
});

describe('the rest of the buttons', () => {
  it('reports each one once, and lets go of focus so Enter reaches the game', () => {
    const { root, ui, calls } = screen();
    ui.update(view());
    const blur = vi.spyOn(HTMLElement.prototype, 'blur');
    byText(root, '.sw-btn', 'Redo the move check')!.click();
    byText(root, '.sw-btn', 'Export my data')!.click();
    byText(root, '.sw-btn', 'Done')!.click();
    byText(root, '.sw-btn', '📈 Your runs')!.click();
    expect(calls.fired).toEqual(['redo', 'export', 'close', 'workout']);
    expect(blur).toHaveBeenCalledTimes(4);
    blur.mockRestore();
  });
});

describe('the mixer sliders drive the real audio settings', () => {
  /** The screen wired the way main.ts wires it: its handlers write through to GameAudio. */
  function wired() {
    const storage = new FakeAudioStorage();
    const audio = new GameAudio({ settings: new AudioSettingsStore(storage), search: '' });
    const root = document.createElement('div');
    document.body.append(root);
    const render = () =>
      ui.update({
        open: true,
        settings: { ...DEFAULT_SETTINGS },
        audio: audio.volumes,
        cameras: CAMS,
        webcam: true,
        hasTuning: true,
      });
    const ui = new SettingsScreen(root, {
      change: () => render(),
      audioChange: (p) => {
        audio.setVolumes(p);
        render();
      },
      chooseCamera: () => render(),
      redoMoveCheck: () => {},
      resetTuning: () => {},
      exportData: () => {},
      clearHistory: () => {},
      openWorkout: () => {},
      close: () => {},
    });
    render();
    return { root, ui, audio, storage };
  }

  it('a volume slider is in force at once, shown back, and saved', () => {
    const w = wired();
    const music = byText(w.root, '.sw-row-label', 'Music')?.closest('.sw-row')?.querySelector('input') as HTMLInputElement;
    expect(music).toBeTruthy();
    music.value = '0.3';
    music.dispatchEvent(new Event('input', { bubbles: true }));

    expect(w.audio.volumes.music).toBeCloseTo(0.3, 5);
    // The screen renders what is actually in force, not what it asked for.
    expect(music.value).toBe('0.3');
    expect(JSON.parse(w.storage.getItem('subway-irl.audio.v1')!).music).toBeCloseTo(0.3, 5);
  });

  it('the mute toggle round-trips through the store and comes back on the next render', () => {
    const w = wired();
    const mute = toggle(w.root, 'Mute everything');
    expect(mute.dataset.on).toBe('off');
    mute.click();
    expect(w.audio.muted).toBe(true);
    expect(mute.dataset.on).toBe('on');
    mute.click();
    expect(w.audio.muted).toBe(false);
    expect(JSON.parse(w.storage.getItem('subway-irl.audio.v1')!).muted).toBe(false);
  });
});

describe('a toggle changed from outside the screen', () => {
  it('asks for the opposite of what the player can see, not of its own attribute', () => {
    // Mute is reachable from the N key and the HUD speaker as well as from here, so the screen
    // must be able to be told. Once it has been, one press undoes it — the two-press bug was the
    // app forgetting to re-render, and the screen is now decisive about which state it is showing.
    const s = screen();
    s.ui.update(view({ audio: { ...DEFAULT_AUDIO, muted: false } }));
    const mute = toggle(s.root, 'Mute everything');
    expect(mute.dataset.on).toBe('off');

    s.ui.update(view({ audio: { ...DEFAULT_AUDIO, muted: true } }));
    expect(mute.dataset.on).toBe('on');
    mute.click();
    expect(s.calls.audio).toEqual([{ muted: false }]);
  });

  it('still toggles normally when nothing outside has touched it', () => {
    const s = screen();
    s.ui.update(view());
    const mirror = toggle(s.root, 'Mirror the preview');
    mirror.click();
    expect(s.calls.change.at(-1)).toEqual({ mirror: false });
  });
});
