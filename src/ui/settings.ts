/**
 * The settings screen: everything tunable, big enough to use standing two metres from the laptop.
 * Spec: docs/superpowers/specs/2026-09-18-settings-workout.md
 *
 * The screen owns no state. It renders a `SettingsView` and reports what the player pressed; the
 * app applies the change and hands back the settings that are actually in force. Nothing here
 * touches localStorage, the camera, the audio graph or the game — which is why the harness can
 * show every control with no hardware at all.
 */
import './settings.css';
import type { AudioSettings } from '../audio/types';
import {
  DIFFICULTIES,
  DIFFICULTY_BLURBS,
  DIFFICULTY_NAMES,
  LANE_BLURBS,
  LANE_CHOICES,
  LANE_NAMES,
  LINES,
  LINE_BLURBS,
  LINE_NAMES,
  MODE_BLURBS,
  MODE_CHOICES,
  OUTLINE_BLURBS,
  OUTLINE_CHOICES,
  OUTLINE_NAMES,
  QUALITY_BLURBS,
  QUALITY_CHOICES,
  QUALITY_NAMES,
  MODE_NAMES,
  OBSTACLE_AMOUNT_BLURBS,
  OBSTACLE_AMOUNT_NAMES,
  OBSTACLE_LEVEL_BLURBS,
  OBSTACLE_LEVEL_NAMES,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_STEP,
  sensitivityWords,
  type GameSettings,
  type LaneChoice,
} from '../app/settings';
import { OBSTACLE_AMOUNTS, obstacleLevel } from '../game/config';
import type { LaneSpots } from '../pose/laneSpots';
import type { CameraOption } from './poseScreens';
import { icon } from './icons';

// ---------------------------------------------------------------- DOM helpers (shared with workout.ts)

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: Element,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
};

/** A button that lets go of focus, so the next Enter reaches the game and not this button. */
export function button(parent: Element, cls: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, parent, label);
  b.type = 'button';
  b.addEventListener('click', () => {
    b.blur();
    onClick();
  });
  return b;
}

// ---------------------------------------------------------------- pure view helpers

/** Volume as a percentage, for the number beside each slider. */
export const volumePercent = (v: number): string => `${Math.round((Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0) * 100)}%`;

/** A toggle's state word. Fixed vocabulary so the badge can be a fixed width and nothing shifts. */
export const onOff = (on: boolean): string => (on ? 'ON' : 'OFF');

/** The weight the calorie estimate will use, as a label: their own, or the assumed one. */
export const weightLabel = (kg: number | null): string => (kg === null ? 'Not set' : `${kg} kg`);

/**
 * The line under the Lanes chips: what is actually deciding lanes, in words. Small-room mode leans
 * rather than standing anywhere, so it says spots do not apply rather than hiding the option.
 */
export function lanesNote(lanes: LaneChoice, spots: Readonly<LaneSpots> | null, smallRoom: boolean): string {
  if (smallRoom) return 'You are in Small room mode, where leaning changes lane — spots only apply in Full body mode.';
  const tail = 'Full body mode only.';
  if (!spots) {
    return lanes === 'spots' ? `No spots set yet, so the lanes are Automatic for now. ${tail}` : `No spots set yet. ${tail}`;
  }
  const d = (v: number) => Math.abs(v).toFixed(2);
  const yours = `Your spots: ${d(spots.centre - spots.left)} left and ${d(spots.right - spots.centre)} right of centre, in torso lengths.`;
  return `${yours} ${lanes === 'spots' ? 'In use.' : 'Not in use while Lanes is Automatic.'} ${tail}`;
}

/** The rungs the weight picker offers, inside the model's own 30–200 kg band. */
export const WEIGHT_CHOICES: readonly number[] = [40, 50, 60, 70, 80, 90, 100, 110, 125];

// ---------------------------------------------------------------- the screen

export interface SettingsView {
  /** False hides the whole layer. */
  open: boolean;
  settings: GameSettings;
  audio: AudioSettings;
  /** From `cameraOptions(cams, savedId)` in poseScreens.ts — the same list the setup screen uses. */
  cameras: readonly CameraOption[];
  /** False in keyboard mode: the camera and movement controls are shown but disabled and explained. */
  webcam: boolean;
  /** True when this machine has a saved move tuning, so "reset my tuning" has something to do. */
  hasTuning: boolean;
  /** The recorded lane spots, or null when none are recorded. */
  laneSpots: Readonly<LaneSpots> | null;
  /** The player is in small-room mode (chosen, or detected): lane spots do not apply there. */
  smallRoom: boolean;
}

/** What the screen can ask of the app. Every one of these is a player action, never a frame update. */
export interface SettingsHandlers {
  /** A settings change to apply live and persist. The app must call `update` with the result. */
  change(patch: Partial<GameSettings>): void;
  /** A mixer change, written through to the audio settings store. */
  audioChange(patch: Partial<AudioSettings>): void;
  chooseCamera(deviceId: string): void;
  /** Run the move check again. */
  redoMoveCheck(): void;
  /** Forget the saved tuning for the current play mode. Already confirmed by the screen. */
  resetTuning(): void;
  /** Run the lane-spots setup. Also what picking "My spots" with none recorded offers. */
  setLaneSpots(): void;
  /** Hand the player their data as a JSON file. */
  exportData(): void;
  /** Erase every run, the day streak and the lifetime totals — not the wallet. Already confirmed. */
  clearHistory(): void;
  /** Open the workout screen. */
  openWorkout(): void;
  /** Leave the settings screen. */
  close(): void;
}

interface Confirm {
  title: string;
  body: string;
  yes: string;
  danger: boolean;
  /** A "yes" that starts something rather than losing something: green, like every other go. */
  go?: boolean;
  onYes(): void;
}

const NO_CAMERAS: CameraOption = { id: '', label: 'No camera found', selected: true };

export class SettingsScreen {
  private readonly root: HTMLElement;
  private readonly handlers: SettingsHandlers;
  private readonly lastText = new Map<Element, string>();
  /** What each toggle was last *rendered* as, so a click asks for the opposite of the truth. */
  private readonly toggles = new Map<HTMLButtonElement, boolean>();
  private readonly attrs = new Map<Element, Map<string, string>>();
  private mounted = false;
  private pending: Confirm | null = null;

  // built on mount
  private sens!: HTMLInputElement;
  private sensValue!: HTMLElement;
  private sensWords!: HTMLElement;
  private modeChips!: Map<string, HTMLButtonElement>;
  private laneChips!: Map<string, HTMLButtonElement>;
  private laneNote!: HTMLElement;
  private laneBtn!: HTMLButtonElement;
  /** The last view rendered, so a chip can ask what it needs to know (are there spots at all?). */
  private view: SettingsView | null = null;
  private lineChips!: Map<string, HTMLButtonElement>;
  private diffChips!: Map<string, HTMLButtonElement>;
  private obstacles!: HTMLInputElement;
  private obstaclesValue!: HTMLElement;
  private obstaclesWords!: HTMLElement;
  private amountChips!: Map<string, HTMLButtonElement>;
  private qualityChips!: Map<string, HTMLButtonElement>;
  private outlineChips!: Map<string, HTMLButtonElement>;
  private camSelect!: HTMLSelectElement;
  private camKey = '';
  private mirrorBtn!: HTMLButtonElement;
  private reducedMotionBtn!: HTMLButtonElement;
  private reducedEffectsBtn!: HTMLButtonElement;
  private muteBtn!: HTMLButtonElement;
  private vol!: Record<'master' | 'music' | 'sfx', { input: HTMLInputElement; out: HTMLElement }>;
  private tuningBtn!: HTMLButtonElement;
  private checkBtn!: HTMLButtonElement;
  private camGroup!: HTMLElement;
  private moveGroup!: HTMLElement;
  private weightBtns!: HTMLElement;
  private weightValue!: HTMLElement;
  private dialog!: HTMLElement;
  private dlgTitle!: HTMLElement;
  private dlgBody!: HTMLElement;
  private dlgYes!: HTMLButtonElement;

  constructor(root: HTMLElement, handlers: SettingsHandlers) {
    this.root = root;
    this.handlers = handlers;
  }

  /** Builds the DOM. Idempotent; `update` calls it for you. */
  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    const root = this.root;
    root.classList.add('sw-screen', 'sw-settings');
    this.attr(root, 'data-on', 'off');

    const top = el('div', 'sw-top', root);
    el('div', 'sw-tab gk-ribbon', top, 'Settings');
    el('div', 'sw-tab-sub', top, 'Changes apply straight away.');

    const close = button(top, 'sw-close gk-btn gk-btn-round gk-btn-red gk-btn-sm', '', () => this.handlers.close());
    close.innerHTML = icon('close');
    close.setAttribute('aria-label', 'Close settings');
    const body = el('div', 'sw-grid', root);
    // Two columns, filled by hand so the panels end at about the same height.
    const left = el('div', 'sw-col', body);
    const right = el('div', 'sw-col', body);

    // ---- movement
    const moveBody = this.group(left, 'Movement', 'How big a move has to be before it counts', 'You are on the keyboard. These settings need the camera.');
    // The dimming rule reads `data-off` on the card, not on the body it fades.
    this.moveGroup = moveBody.parentElement as HTMLElement;
    const sensRow = el('div', 'sw-row sw-row-slider', moveBody);
    const sensHead = el('div', 'sw-row-head', sensRow);
    el('div', 'sw-row-label', sensHead, 'Sensitivity');
    this.sensValue = el('div', 'sw-row-value', sensHead);
    this.sens = this.slider(sensRow, SENSITIVITY_MIN, SENSITIVITY_MAX, SENSITIVITY_STEP, (v) => this.handlers.change({ sensitivity: v }));
    this.sens.setAttribute('aria-label', 'Move sensitivity');
    const scale = el('div', 'sw-scale', sensRow);
    el('span', 'sw-scale-end', scale, 'Big moves only');
    el('span', 'sw-scale-end', scale, 'Hair trigger');
    this.sensWords = el('div', 'sw-note', sensRow);

    this.modeChips = this.chips(moveBody, 'Play mode', MODE_CHOICES, MODE_NAMES, MODE_BLURBS, (v) =>
      this.handlers.change({ mode: v as GameSettings['mode'] }),
    );

    // Lanes: full body only, and said so rather than hidden (spec: lane spots, "Small-room mode").
    this.laneChips = this.chips(moveBody, 'Lanes', LANE_CHOICES, LANE_NAMES, LANE_BLURBS, (v) => this.pickLanes(v as LaneChoice));
    this.laneNote = el('div', 'sw-note sw-lanes-note', moveBody);

    const moveActions = el('div', 'sw-actions', moveBody);
    this.checkBtn = button(moveActions, 'sw-btn gk-btn gk-btn-green gk-btn-sm', 'Redo the move check', () => this.handlers.redoMoveCheck());
    this.laneBtn = button(moveActions, 'sw-btn gk-btn gk-btn-cream gk-btn-sm', 'Set my lane spots', () => this.handlers.setLaneSpots());
    this.tuningBtn = button(moveActions, 'sw-btn gk-btn gk-btn-orange gk-btn-sm', 'Reset my tuning', () =>
      this.ask({
        title: 'Reset your tuning?',
        body: 'The move check measured how big your moves are. Resetting puts every move back to the shipped defaults for this play mode. You can run the check again any time.',
        yes: 'Yes, reset it',
        danger: false,
        onYes: () => this.handlers.resetTuning(),
      }),
    );

    // ---- camera
    const camBody = this.group(left, 'Camera', 'Video never leaves this laptop', 'You are on the keyboard, so the camera is off.');
    this.camGroup = camBody.parentElement as HTMLElement;
    const camRow = el('div', 'sw-row', camBody);
    el('div', 'sw-row-label', camRow, 'Camera');
    this.camSelect = el('select', 'sw-select', camRow);
    this.camSelect.setAttribute('aria-label', 'Camera');
    this.camSelect.addEventListener('change', () => this.handlers.chooseCamera(this.camSelect.value));
    this.mirrorBtn = this.toggle(camBody, 'Mirror the preview', 'Flips what you see. Never changes what the game detects.', (on) =>
      this.handlers.change({ mirror: on }),
    );

    // ---- audio
    const audio = this.group(right, 'Sound', 'Music, effects and the overall level');
    this.vol = {
      master: this.volumeRow(audio, 'Everything', (v) => this.handlers.audioChange({ master: v })),
      music: this.volumeRow(audio, 'Music', (v) => this.handlers.audioChange({ music: v })),
      sfx: this.volumeRow(audio, 'Effects', (v) => this.handlers.audioChange({ sfx: v })),
    };
    this.muteBtn = this.toggle(audio, 'Mute everything', 'Silence, without losing your levels.', (on) =>
      this.handlers.audioChange({ muted: on }),
    );

    // ---- game
    const game = this.group(right, 'The run', 'Which line you run, and how hard it pushes');
    this.lineChips = this.chips(game, 'Line', LINES, LINE_NAMES, LINE_BLURBS, (v) => this.handlers.change({ line: v as GameSettings['line'] }));
    // Pace is the speed of the run; the obstacles below are their own setting.
    this.diffChips = this.chips(game, 'Pace', DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_BLURBS, (v) =>
      this.handlers.change({ difficulty: v as GameSettings['difficulty'] }),
    );
    const obsRow = el('div', 'sw-row sw-row-slider', game);
    const obsHead = el('div', 'sw-row-head', obsRow);
    el('div', 'sw-row-label', obsHead, 'Obstacle difficulty');
    this.obstaclesValue = el('div', 'sw-row-value', obsHead);
    this.obstacles = this.slider(obsRow, 1, 5, 1, (v) => this.handlers.change({ obstacleLevel: v }));
    this.obstacles.setAttribute('aria-label', 'Obstacle difficulty');
    const obsScale = el('div', 'sw-scale', obsRow);
    el('span', 'sw-scale-end', obsScale, 'Gentle');
    el('span', 'sw-scale-end', obsScale, 'Brutal');
    this.obstaclesWords = el('div', 'sw-note', obsRow);
    this.amountChips = this.chips(game, 'Obstacle amount', OBSTACLE_AMOUNTS, OBSTACLE_AMOUNT_NAMES, OBSTACLE_AMOUNT_BLURBS, (v) =>
      this.handlers.change({ obstacleAmount: v as GameSettings['obstacleAmount'] }),
    );

    // ---- picture
    const picture = this.group(right, 'Picture', 'How the game looks, and how hard it works your laptop');
    // First in its column: it is the one a player with a strong laptop comes looking for.
    right.prepend(picture.parentElement as HTMLElement);
    this.qualityChips = this.chips(picture, 'Graphics', QUALITY_CHOICES, QUALITY_NAMES, QUALITY_BLURBS, (v) =>
      this.handlers.change({ quality: v as GameSettings['quality'] }),
    );
    this.outlineChips = this.chips(picture, 'Outlines', OUTLINE_CHOICES, OUTLINE_NAMES, OUTLINE_BLURBS, (v) =>
      this.handlers.change({ outlines: v as GameSettings['outlines'] }),
    );
    this.reducedMotionBtn = this.toggle(picture, 'Reduced motion', 'No screen shake or speed lines.', (on) => this.handlers.change({ reducedMotion: on }));
    this.reducedEffectsBtn = this.toggle(picture, 'Reduced effects', 'No bloom. Kinder to a weaker laptop.', (on) =>
      this.handlers.change({ reducedEffects: on }),
    );

    // ---- data
    const data = this.group(left, 'Your data', 'All of it stays on this laptop');
    const weightRow = el('div', 'sw-row', data);
    const weightHead = el('div', 'sw-row-head', weightRow);
    el('div', 'sw-row-label', weightHead, 'Your weight');
    this.weightValue = el('div', 'sw-row-value', weightHead);
    el('div', 'sw-row-sub', weightRow, 'Optional, and only used to sharpen the rough calorie estimate. Leave it unset and the game assumes 70 kg.');
    this.weightBtns = el('div', 'sw-weights', weightRow);
    button(this.weightBtns, 'sw-weight', 'Not set', () => this.handlers.change({ weightKg: null }));
    // The model accepts 30–200 kg. These are the rungs the picker offers, widened so that a player
    // at either end is not forced to describe themselves as 50 or 100 and read a calorie estimate
    // that is a tenth out on the one screen that promises what they actually did.
    for (const kg of WEIGHT_CHOICES) {
      button(this.weightBtns, 'sw-weight', `${kg}`, () => this.handlers.change({ weightKg: kg }));
    }

    const dataActions = el('div', 'sw-actions', data);
    button(dataActions, 'sw-btn gk-btn gk-btn-cream gk-btn-sm', 'Export my data', () => this.handlers.exportData());
    button(dataActions, 'sw-btn gk-btn gk-btn-red gk-btn-sm', 'Clear my history', () =>
      this.ask({
        title: 'Clear everything?',
        body: 'This erases every run, your day streak, your best score and your lifetime totals. Your coins, level, missions and shop are not touched. It cannot be undone — export your data first if you want to keep it.',
        yes: 'Yes, erase it all',
        danger: true,
        onYes: () => this.handlers.clearHistory(),
      }),
    );

    // ---- footer
    const foot = el('div', 'sw-foot', root);
    button(foot, 'sw-btn gk-btn gk-btn-green gk-btn-lg', 'Done', () => this.handlers.close());
    button(foot, 'sw-btn gk-btn gk-btn-wood gk-btn-sm', 'Your runs', () => this.handlers.openWorkout());

    // ---- confirm dialog
    this.dialog = el('div', 'sw-dialog', root);
    this.attr(this.dialog, 'data-on', 'off');
    const box = el('div', 'sw-dialog-box', this.dialog);
    this.dlgTitle = el('div', 'sw-dialog-title', box);
    this.dlgBody = el('div', 'sw-dialog-body', box);
    const dlgActions = el('div', 'sw-actions sw-dialog-actions', box);
    // Backing out comes first and stays plain: green is this game's "go" colour everywhere else,
    // and spending it on Cancel would make the safe choice look like the action being asked for.
    button(dlgActions, 'sw-btn gk-btn gk-btn-cream gk-btn-sm', 'Cancel', () => this.setConfirm(null));
    this.dlgYes = button(dlgActions, 'sw-btn gk-btn gk-btn-red gk-btn-sm', 'Yes', () => {
      const p = this.pending;
      this.setConfirm(null);
      p?.onYes();
    });
  }

  /** Renders one view; `open: false` (or null) hides the layer. */
  update(v: SettingsView | null): void {
    this.mount();
    const on = v !== null && v.open;
    this.attr(this.root, 'data-on', on ? 'on' : 'off');
    if (!v) {
      this.setConfirm(null);
      return;
    }
    this.view = v;
    const s = v.settings;

    // A slider the player is dragging must never be written to underneath them.
    if (document.activeElement !== this.sens) this.sens.value = String(s.sensitivity);
    this.text(this.sensValue, s.sensitivity.toFixed(2));
    this.text(this.sensWords, sensitivityWords(s.sensitivity));

    this.select(this.modeChips, s.mode);
    this.select(this.laneChips, s.lanes);
    this.text(this.laneNote, lanesNote(s.lanes, v.laneSpots, v.smallRoom));
    this.select(this.lineChips, s.line);
    this.select(this.diffChips, s.difficulty);
    const level = obstacleLevel(s.obstacleLevel);
    if (document.activeElement !== this.obstacles) this.obstacles.value = String(level);
    this.text(this.obstaclesValue, `${level} · ${OBSTACLE_LEVEL_NAMES[level]}`);
    // Obstacles are laid when a run starts, so say when a change lands.
    this.text(this.obstaclesWords, `${OBSTACLE_LEVEL_BLURBS[level]}. Applies from your next run.`);
    this.select(this.amountChips, s.obstacleAmount);
    this.select(this.qualityChips, s.quality);
    this.select(this.outlineChips, s.outlines);

    this.setToggle(this.mirrorBtn, s.mirror);
    this.setToggle(this.reducedMotionBtn, s.reducedMotion);
    this.setToggle(this.reducedEffectsBtn, s.reducedEffects);
    this.setToggle(this.muteBtn, v.audio.muted);

    for (const ch of ['master', 'music', 'sfx'] as const) {
      const { input, out } = this.vol[ch];
      const value = Math.min(1, Math.max(0, v.audio[ch]));
      if (document.activeElement !== input) input.value = String(value);
      this.text(out, volumePercent(value));
      // Muted is not zero: the levels are still there, the bus is just off. Say so by dimming them.
      this.attr(input, 'data-muted', v.audio.muted ? 'on' : 'off');
    }

    this.text(this.weightValue, weightLabel(s.weightKg));
    for (const b of Array.from(this.weightBtns.children) as HTMLButtonElement[]) {
      const mine = b.textContent === 'Not set' ? s.weightKg === null : Number(b.textContent) === s.weightKg;
      this.attr(b, 'data-on', mine ? 'on' : 'off');
      b.setAttribute('aria-pressed', String(mine));
    }

    this.renderCameras(v.cameras);
    // Keyboard mode: the camera groups stay visible (so nothing jumps when the camera comes back)
    // but say plainly that they are doing nothing right now.
    this.attr(this.camGroup, 'data-off', v.webcam ? 'off' : 'on');
    this.attr(this.moveGroup, 'data-off', v.webcam ? 'off' : 'on');
    this.camSelect.disabled = !v.webcam || v.cameras.length === 0;
    this.checkBtn.disabled = !v.webcam;
    this.laneBtn.disabled = !v.webcam || v.smallRoom;
    this.text(this.laneBtn, v.laneSpots ? 'Redo my lane spots' : 'Set my lane spots');
    this.tuningBtn.disabled = !v.hasTuning;
  }

  destroy(): void {
    this.root.replaceChildren();
    this.lastText.clear();
    this.attrs.clear();
    this.root.classList.remove('sw-screen', 'sw-settings');
    delete this.root.dataset.on;
    this.mounted = false;
    this.pending = null;
    this.camKey = '';
  }

  /** The open confirm dialog, or null. Exposed so a test (and the harness) can drive it. */
  get confirm(): Readonly<Confirm> | null {
    return this.pending;
  }

  // ---------------------------------------------------------------- internals

  /**
   * "My spots" with none recorded would quietly do nothing, so it offers the setup instead: the
   * choice lands when the player saves their spots (Save switches Lanes to My spots). Anything else
   * is an ordinary settings change.
   */
  private pickLanes(v: LaneChoice): void {
    const view = this.view;
    if (v === 'spots' && view && !view.laneSpots && view.webcam && !view.smallRoom) {
      this.ask({
        title: 'Set your lane spots?',
        body: 'My spots uses three places you choose to stand: your left, centre and right lanes. You have not set them yet, so the lanes stay Automatic until you do. It takes about ten seconds.',
        yes: 'Set them now',
        danger: false,
        go: true,
        onYes: () => this.handlers.setLaneSpots(),
      });
      return;
    }
    this.handlers.change({ lanes: v });
  }

  /** A group card. `offNote` is the strip shown in its place of a reason when the group is inert. */
  private group(parent: Element, title: string, blurb: string, offNote?: string): HTMLElement {
    const g = el('div', 'sw-group', parent);
    const head = el('div', 'sw-group-head', g);
    el('div', 'sw-group-title', head, title);
    el('div', 'sw-group-blurb', head, blurb);
    // Greying a control out says it is unavailable; only the note says why, so it always comes with one.
    if (offNote !== undefined) el('div', 'sw-group-note', g, offNote);
    return el('div', 'sw-group-body', g);
  }

  private slider(parent: Element, min: number, max: number, step: number, onInput: (v: number) => void): HTMLInputElement {
    const i = el('input', 'sw-slider gk-range', parent);
    i.type = 'range';
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.addEventListener('input', () => onInput(Number(i.value)));
    return i;
  }

  private volumeRow(parent: Element, label: string, onInput: (v: number) => void): { input: HTMLInputElement; out: HTMLElement } {
    const row = el('div', 'sw-row sw-row-slider', parent);
    const head = el('div', 'sw-row-head', row);
    el('div', 'sw-row-label', head, label);
    const out = el('div', 'sw-row-value', head);
    const input = this.slider(row, 0, 1, 0.05, onInput);
    input.setAttribute('aria-label', `${label} volume`);
    return { input, out };
  }

  private chips<T extends string>(
    parent: Element,
    label: string,
    values: readonly T[],
    names: Record<T, string>,
    blurbs: Record<T, string>,
    onPick: (v: T) => void,
  ): Map<string, HTMLButtonElement> {
    const row = el('div', 'sw-row', parent);
    el('div', 'sw-row-label', row, label);
    const bar = el('div', 'sw-chips', row);
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', label);
    const map = new Map<string, HTMLButtonElement>();
    for (const v of values) {
      const b = button(bar, 'sw-chip', '', () => onPick(v));
      el('span', 'sw-chip-name', b, names[v]);
      el('span', 'sw-chip-blurb', b, blurbs[v]);
      map.set(v, b);
    }
    return map;
  }

  private select(map: Map<string, HTMLButtonElement>, value: string): void {
    for (const [k, b] of map) {
      const on = k === value;
      this.attr(b, 'data-on', on ? 'on' : 'off');
      b.setAttribute('aria-pressed', String(on));
    }
  }

  private toggle(parent: Element, label: string, blurb: string, onSet: (on: boolean) => void): HTMLButtonElement {
    const row = el('div', 'sw-row sw-row-toggle', parent);
    const text = el('div', 'sw-row-text', row);
    el('div', 'sw-row-label', text, label);
    el('div', 'sw-row-sub', text, blurb);
    // What it asks for is the opposite of what the *view* last said, not of this element's own
    // attribute: mute can be changed from outside this screen (the N key, the HUD speaker), and a
    // toggle that argues with its own stale DOM takes two presses to do one thing.
    const b = button(row, 'sw-toggle', '', () => onSet(this.toggles.get(b) !== true));
    this.toggles.set(b, false);
    el('span', 'sw-toggle-knob', b);
    el('span', 'sw-toggle-word', b);
    b.setAttribute('aria-label', label);
    return b;
  }

  private setToggle(b: HTMLButtonElement, on: boolean): void {
    this.toggles.set(b, on);
    this.attr(b, 'data-on', on ? 'on' : 'off');
    b.setAttribute('aria-pressed', String(on));
    this.text(b.lastElementChild as Element, onOff(on));
  }

  private renderCameras(cams: readonly CameraOption[]): void {
    const list = cams.length ? cams : [NO_CAMERAS];
    // Rebuilding the options resets the select, so only do it when the list has really changed.
    const key = list.map((c) => `${c.id}\u0000${c.label}`).join('\u0001');
    if (key !== this.camKey) {
      this.camKey = key;
      this.camSelect.replaceChildren();
      for (const c of list) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.label;
        this.camSelect.append(o);
      }
    }
    const chosen = list.find((c) => c.selected) ?? list[0];
    if (this.camSelect.value !== chosen.id) this.camSelect.value = chosen.id;
  }

  private ask(c: Confirm): void {
    this.setConfirm(c);
  }

  private setConfirm(c: Confirm | null): void {
    this.pending = c;
    this.attr(this.dialog, 'data-on', c ? 'on' : 'off');
    if (!c) return;
    this.text(this.dlgTitle, c.title);
    this.text(this.dlgBody, c.body);
    this.text(this.dlgYes, c.yes);
    this.dlgYes.className = c.go ? 'sw-btn gk-btn gk-btn-green gk-btn-sm' : c.danger ? 'sw-btn gk-btn gk-btn-red gk-btn-sm' : 'sw-btn gk-btn gk-btn-orange gk-btn-sm';
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
