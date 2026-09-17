// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { MOVE_ORDER, type MoveCheckHandlers, type MoveCheckModel, type MoveCheckSummary, type MoveId, type MoveStepModel } from '../../src/pose/moveCheckTypes';
import type { PlayMode } from '../../src/pose/types';
import { clamp01, formatPeak, MoveCheckScreen, renderSummaryCard, stepCounter, strengthLevel, strengthPercent } from '../../src/ui/moveCheckScreen';

const LABELS: Record<MoveId, string> = {
  jog: 'Jog in place',
  left: 'Step left',
  right: 'Step right',
  jump: 'Jump',
  roll: 'Squat',
  hover: 'Both hands up',
};

const step = (id: MoveId, over: Partial<MoveStepModel> = {}): MoveStepModel => ({
  id,
  status: 'todo',
  label: LABELS[id],
  how: `do ${id}`,
  hint: null,
  canSkip: false,
  canAccept: false,
  progress: 0,
  peak: null,
  steps: null,
  ...over,
});

/** A model with `at` active, everything before it done, nothing after it started. */
function model(at: MoveId, over: Partial<MoveStepModel> = {}, mode: PlayMode = 'full'): MoveCheckModel {
  const index = MOVE_ORDER.indexOf(at);
  const steps = MOVE_ORDER.map((id, i) =>
    i < index ? step(id, { status: 'done', progress: 1, peak: 0.4 }) : i === index ? step(id, { status: 'active', ...over }) : step(id),
  );
  return { mode, index, steps, summary: null };
}

function summaryModel(skipped: readonly MoveId[], asymmetryNote: string | null = null, mode: PlayMode = 'full'): MoveCheckModel {
  const steps = MOVE_ORDER.map((id) =>
    skipped.includes(id) ? step(id, { status: 'skipped', progress: 0.5 }) : step(id, { status: 'done', progress: 1, peak: 0.42 }),
  );
  const summary: MoveCheckSummary = { mode, steps, tuned: { laneEnter: 0.33 }, asymmetryNote };
  return { mode, index: steps.length, steps, summary };
}

interface Calls {
  log: string[];
  handlers: MoveCheckHandlers;
}

function calls(): Calls {
  const log: string[] = [];
  const push = (what: string) => () => log.push(what);
  return {
    log,
    handlers: {
      skipStep: push('skipStep'),
      acceptBest: push('acceptBest'),
      skipAll: push('skipAll'),
      redo: push('redo'),
      resetTuning: push('resetTuning'),
      start: push('start'),
    },
  };
}

function screen(m: MoveCheckModel | null = model('jog')) {
  const root = document.createElement('div');
  document.body.append(root);
  const c = calls();
  const ui = new MoveCheckScreen(root, c.handlers);
  ui.update(m);
  const btn = (cls: string) => root.querySelector<HTMLButtonElement>(cls)!;
  return { root, ui, log: c.log, btn };
}

const fillWidth = (root: HTMLElement): string => root.querySelector<HTMLElement>('.mc-bar-fill')!.style.width;

afterEach(() => document.body.replaceChildren());

describe('move check: pure helpers', () => {
  it('clamps the strength bar at both ends, and survives rubbish', () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(strengthPercent(-0.2)).toBe('0%');
    expect(strengthPercent(2)).toBe('100%');
    expect(strengthPercent(0.625)).toBe('63%');
  });

  it('colours the bar by how close the attempt got', () => {
    expect(strengthLevel(0)).toBe('none');
    expect(strengthLevel(0.2)).toBe('low');
    expect(strengthLevel(0.5)).toBe('near');
    expect(strengthLevel(1)).toBe('full');
    expect(strengthLevel(3)).toBe('full');
  });

  it('formats a measured peak short, and says nothing when there is none', () => {
    expect(formatPeak(null)).toBe('—');
    expect(formatPeak(0.4231)).toBe('0.42');
    expect(formatPeak(14.6)).toBe('15');
  });

  it('counts the steps, and stops counting once the summary is up', () => {
    expect(stepCounter(model('jump'))).toBe('Move 4 of 6');
    expect(stepCounter(summaryModel([]))).toBe('All done!');
  });
});

describe('MoveCheckScreen: buttons', () => {
  it('offers nothing but "skip all" until the model allows more', () => {
    const s = screen(model('left'));
    expect(s.btn('.mc-btn-skip').hidden).toBe(true);
    expect(s.btn('.mc-btn-accept').hidden).toBe(true);
    expect(s.btn('.mc-btn-skip-all').hidden).toBe(false);
  });

  it('shows skip and accept exactly when the step says so', () => {
    const s = screen(model('jump', { canSkip: true }));
    expect(s.btn('.mc-btn-skip').hidden).toBe(false);
    expect(s.btn('.mc-btn-accept').hidden).toBe(true);
    s.ui.update(model('jump', { canSkip: true, canAccept: true }));
    expect(s.btn('.mc-btn-accept').hidden).toBe(false);
    // …and takes them away again when the next step does not offer them.
    s.ui.update(model('roll'));
    expect(s.btn('.mc-btn-skip').hidden).toBe(true);
    expect(s.btn('.mc-btn-accept').hidden).toBe(true);
  });

  it('reports each press and drops focus, so the next Enter reaches the game', () => {
    const s = screen(model('jump', { canSkip: true, canAccept: true }));
    for (const [cls, name] of [
      ['.mc-btn-skip', 'skipStep'],
      ['.mc-btn-accept', 'acceptBest'],
      ['.mc-btn-skip-all', 'skipAll'],
    ] as const) {
      const b = s.btn(cls);
      b.focus();
      b.click();
      expect(document.activeElement).not.toBe(b);
    }
    expect(s.log).toEqual(['skipStep', 'acceptBest', 'skipAll']);
  });

  it('swaps the step buttons for the summary ones when the check is over', () => {
    const s = screen(summaryModel([]));
    expect(s.root.dataset.phase).toBe('summary');
    const actions = s.root.querySelectorAll('.mc-actions-summary .mc-btn');
    expect([...actions].map((b) => b.textContent)).toEqual(['START PLAYING', 'Redo the check', 'Reset to defaults']);
    for (const b of actions) {
      (b as HTMLButtonElement).focus();
      (b as HTMLButtonElement).click();
      expect(document.activeElement).not.toBe(b);
    }
    expect(s.log).toEqual(['start', 'redo', 'resetTuning']);
  });
});

describe('MoveCheckScreen: the active step', () => {
  it('shows the move, the how-to for the mode and the step dots', () => {
    const s = screen(model('left', {}, 'small'));
    expect(s.root.querySelector('.mc-move-name')!.textContent).toBe('Step left');
    expect(s.root.querySelector('.mc-how')!.textContent).toBe('do left');
    expect(s.root.dataset.move).toBe('left');
    expect(s.root.dataset.mode).toBe('small');
    expect(s.root.querySelector('.mc-banner-sub')!.textContent).toBe('Move 2 of 6 · Small room');
    const dots = [...s.root.querySelectorAll('.mc-dot')];
    expect(dots.map((d) => (d as HTMLElement).dataset.status)).toEqual(['done', 'active', 'todo', 'todo', 'todo', 'todo']);
    expect(dots[0].firstElementChild!.textContent).toBe('✓');
    expect(dots[1].firstElementChild!.textContent).toBe('2');
  });

  it('marks a skipped step on the dots', () => {
    const m = model('right');
    (m.steps as MoveStepModel[])[1] = step('left', { status: 'skipped' });
    const s = screen(m);
    const dots = [...s.root.querySelectorAll('.mc-dot')] as HTMLElement[];
    expect(dots[1].dataset.status).toBe('skipped');
    expect(dots[1].firstElementChild!.textContent).toBe('–');
  });

  it('drives the strength bar from progress, clamped at 0 and 1', () => {
    const s = screen(model('left', { progress: -1 }));
    expect(fillWidth(s.root)).toBe('0%');
    s.ui.update(model('left', { progress: 0.5 }));
    expect(fillWidth(s.root)).toBe('50%');
    expect(s.root.querySelector('.mc-bar')!.getAttribute('data-level')).toBe('near');
    expect(s.root.querySelector('.mc-bar')!.getAttribute('aria-valuenow')).toBe('50');
    s.ui.update(model('left', { progress: 4 }));
    expect(fillWidth(s.root)).toBe('100%');
    expect(s.root.querySelector('.mc-bar')!.getAttribute('data-level')).toBe('full');
  });

  it('shows the near-miss hint only when there is one, and the measured best', () => {
    const s = screen(model('jump', { progress: 0.6 }));
    const hint = s.root.querySelector<HTMLElement>('.mc-hint')!;
    expect(hint.dataset.on).toBe('off');
    expect(s.root.querySelector('.mc-peak')!.textContent).toBe('');
    s.ui.update(model('jump', { progress: 0.6, hint: 'Almost — go a bit further', peak: 0.081 }));
    expect(hint.dataset.on).toBe('on');
    expect(hint.textContent).toBe('Almost — go a bit further');
    expect(s.root.querySelector('.mc-peak')!.textContent).toBe('best 0.08');
  });

  it('shows the jog counter on the jog step only', () => {
    const s = screen(model('jog', { steps: { seen: 2, needed: 4 } }));
    const box = s.root.querySelector<HTMLElement>('.mc-jog')!;
    expect(box.hidden).toBe(false);
    expect(s.root.querySelector('.mc-jog-count')!.textContent).toBe('2 of 4 steps');
    const pips = [...s.root.querySelectorAll('.mc-jog-pip')] as HTMLElement[];
    expect(pips.map((p) => p.dataset.on)).toEqual(['on', 'on', 'off', 'off']);
    s.ui.update(model('left'));
    expect(box.hidden).toBe(true);
  });

  it('hides the whole layer for a null model, and clears up on destroy', () => {
    const s = screen(model('jog'));
    expect(s.root.dataset.on).toBe('on');
    s.ui.update(null);
    expect(s.root.dataset.on).toBe('off');
    s.ui.destroy();
    expect(s.root.children.length).toBe(0);
    expect(s.root.className).toBe('');
  });
});

describe('the controls card', () => {
  const card = (skipped: readonly MoveId[], note: string | null = null, mode: PlayMode = 'full'): HTMLElement =>
    renderSummaryCard(summaryModel(skipped, note, mode).summary!);

  it('lists every move with its measured value, and says which were skipped', () => {
    const c = card(['jump']);
    const rows = [...c.querySelectorAll('.mc-row:not(.mc-row-gesture)')] as HTMLElement[];
    expect(rows.map((r) => r.querySelector('.mc-row-move')!.textContent)).toEqual(MOVE_ORDER.map((id) => LABELS[id]));
    expect(rows.map((r) => r.dataset.status)).toEqual(['done', 'done', 'done', 'skipped', 'done', 'done']);
    const jump = rows[3];
    expect(jump.querySelector('.mc-row-peak')).toBeNull();
    expect(jump.querySelector('.mc-row-skipped')!.textContent).toBe('skipped');
    expect(rows[0].querySelector('.mc-row-peak')!.textContent).toBe('0.42');
  });

  it('always lists the start gesture and the keyboard, whatever was skipped', () => {
    const c = card(MOVE_ORDER);
    expect(c.querySelector('.mc-row-gesture .mc-row-move')!.textContent).toBe('Right hand up');
    const caps = [...c.querySelectorAll('.mc-cap')].map((k) => k.textContent);
    expect(caps).toEqual(['←', '→', 'Space', 'S', 'Ctrl', 'J', 'Enter']);
  });

  it('shows the asymmetry note only when the check found one', () => {
    expect(card(['jump']).querySelector('.mc-note')).toBeNull();
    const c = card([], 'Your left step is much smaller than your right');
    expect(c.querySelector('.mc-note-text')!.textContent).toBe('Your left step is much smaller than your right');
  });

  it('names the mode, so the pause screen can show it out of context', () => {
    expect(card([], null, 'small').querySelector('.mc-sheet-mode')!.textContent).toBe('Small room');
    expect(card([], null, 'small').dataset.mode).toBe('small');
  });

  it('can be titled for the pause screen', () => {
    const c = renderSummaryCard(summaryModel([]).summary!, { title: 'Controls' });
    expect(c.querySelector('.mc-sheet-title')!.textContent).toBe('Controls');
  });
});

describe('MoveCheckScreen wired to a live check', () => {
  it('re-renders when the very same model object is mutated in place', () => {
    // MoveCheck hands out one model and mutates it every frame; an identity memo here would
    // freeze the screen on the first frame it ever saw.
    const m = model('jog');
    const s = screen(m);
    expect(s.root.querySelector('.mc-move-name')!.textContent).toBe(LABELS.jog);

    const live = m as unknown as { index: number; steps: MoveStepModel[] };
    live.steps[0].status = 'done';
    live.steps[1].status = 'active';
    live.steps[1].progress = 0.75;
    live.index = 1;
    s.ui.update(m);
    expect(s.root.querySelector('.mc-move-name')!.textContent).toBe(LABELS.left);
    expect(fillWidth(s.root)).toBe('75%');
    expect(s.root.dataset.move).toBe('left');
  });

  it('shows and hides the layer as the check comes and goes', () => {
    const s = screen(null);
    expect(s.root.dataset.on).toBe('off');
    s.ui.update(model('jump'));
    expect(s.root.dataset.on).toBe('on');
    s.ui.update(null);
    expect(s.root.dataset.on).toBe('off');
  });
});
