// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LaneSetupModel } from '../../src/pose/laneSetup';
import { floorEdge, floorPercent, holdDash, LaneSetupScreen, spotCounter, spotRows } from '../../src/ui/laneSetupScreen';

function model(over: Partial<LaneSetupModel> = {}): LaneSetupModel {
  return {
    step: 'left',
    index: 1,
    label: 'Left',
    how: 'Step to where you want the left lane',
    spots: { centre: 0.1, left: null, right: null },
    live: -0.4,
    hold: 0.5,
    blocked: null,
    hint: null,
    taken: false,
    result: null,
    ...over,
  };
}

function screen() {
  const root = document.createElement('div');
  document.body.append(root);
  const fired: string[] = [];
  const ui = new LaneSetupScreen(root, { save: () => fired.push('save'), redo: () => fired.push('redo'), cancel: () => fired.push('cancel') });
  return { root, ui, fired };
}

const btn = (root: Element, text: RegExp) => Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => text.test(b.textContent ?? ''))!;

describe('lane setup view helpers', () => {
  it('places offsets across the floor, clamped inside its ends', () => {
    expect(floorPercent(0)).toBe(50);
    expect(floorPercent(0.75)).toBe(75);
    expect(floorPercent(-9)).toBe(5);
    expect(floorPercent(Number.NaN)).toBe(50);
    expect(floorEdge(-2)).toBe('left');
    expect(floorEdge(2)).toBe('right');
    expect(floorEdge(0.5)).toBe('none');
  });

  it('describes each spot by the step it asks for', () => {
    const rows = spotRows({ left: -0.62, centre: 0.1, right: 0.58 });
    expect(rows.map((r) => [r.id, r.value, r.from])).toEqual([
      ['left', '0.72', 'left of centre'],
      ['centre', '0.10', 'right of where you calibrated'],
      ['right', '0.48', 'right of centre'],
    ]);
    expect(spotRows({ left: -0.6, centre: 0.01, right: 0.6 })[1].from).toBe('right where you calibrated');
  });

  it('counts spots and fills the ring', () => {
    expect(spotCounter(model())).toBe('Spot 2 of 3');
    expect(spotCounter(model({ result: { left: -1, centre: 0, right: 1 } }))).toBe('All three set!');
    expect(Number(holdDash(0))).toBeGreaterThan(160);
    expect(holdDash(1)).toBe('0.0');
    expect(holdDash(Number.NaN)).toBe(holdDash(0));
  });
});

describe('LaneSetupScreen', () => {
  it('stays hidden until there is a model, and hides again on null', () => {
    const { root, ui } = screen();
    ui.update(null);
    expect(root.getAttribute('data-on')).toBe('off');
    ui.update(model());
    expect(root.getAttribute('data-on')).toBe('on');
    ui.update(null);
    expect(root.getAttribute('data-on')).toBe('off');
  });

  it('shows the step, the pins taken so far and the player', () => {
    const { root, ui } = screen();
    ui.update(model());
    expect(root.querySelector('.ls-name')!.textContent).toBe('Left');
    expect(root.querySelector('.ls-pin-centre')!.getAttribute('data-on')).toBe('on');
    expect(root.querySelector('.ls-pin-left')!.getAttribute('data-on')).toBe('off');
    const you = root.querySelector<HTMLElement>('.ls-you')!;
    expect(you.style.left).toBe(`${floorPercent(-0.4).toFixed(2)}%`);
    expect(you.getAttribute('data-state')).toBe('holding');
    expect(root.querySelector('.ls-ring-core')!.textContent).toBe('50%');
  });

  it('a refused spot shows the hint and points the way', () => {
    const { root, ui } = screen();
    ui.update(model({ live: 0.05, hold: 0, blocked: 'tooClose', hint: 'Step further left' }));
    expect(root.querySelector('.ls-hint')!.textContent).toBe('Step further left');
    expect(root.querySelector('.ls-hint')!.getAttribute('data-on')).toBe('on');
    expect(root.querySelector('.ls-ring-core')!.textContent).toBe('◀');
    expect(root.querySelector('.ls-you')!.getAttribute('data-state')).toBe('blocked');
    expect(root.querySelector('.ls-near')!.getAttribute('data-on')).toBe('on');
  });

  it('nobody in view: no marker, and the ring asks', () => {
    const { root, ui } = screen();
    ui.update(model({ live: null, hold: 0, hint: 'Step back into view' }));
    expect(root.querySelector('.ls-you')!.getAttribute('data-on')).toBe('off');
    expect(root.querySelector('.ls-ring-core')!.textContent).toBe('?');
  });

  it('the summary lists the spots and offers Save, Redo and Cancel, each of which lets go of focus', () => {
    const { root, ui, fired } = screen();
    ui.update(model({ step: null, index: 3, spots: { centre: 0.1, left: -0.62, right: 0.58 }, result: { left: -0.62, centre: 0.1, right: 0.58 } }));
    expect(root.getAttribute('data-phase')).toBe('summary');
    expect(root.querySelector('[data-spot="left"] .ls-row-value')!.textContent).toBe('0.72');
    expect(root.querySelectorAll('.ls-bound[data-on="on"]')).toHaveLength(2);
    for (const [re, name] of [[/SAVE MY SPOTS/, 'save'], [/Redo/, 'redo']] as const) {
      const b = btn(root.querySelector('.ls-actions-summary')!, re);
      b.focus();
      b.click();
      expect(document.activeElement).not.toBe(b);
      expect(fired.at(-1)).toBe(name);
    }
    btn(root.querySelector('.ls-actions-summary')!, /Cancel/).click();
    expect(fired.at(-1)).toBe('cancel');
  });

  it('Start over only once there is something to start over', () => {
    const { root, ui } = screen();
    ui.update(model({ step: 'centre', index: 0, spots: { centre: null, left: null, right: null } }));
    expect(btn(root, /Start over/).hidden).toBe(true);
    ui.update(model());
    expect(btn(root, /Start over/).hidden).toBe(false);
  });

  it('builds once however often it is rendered, and comes down cleanly', () => {
    const { root, ui } = screen();
    for (let i = 0; i < 5; i++) ui.update(model({ live: -0.4 - i * 0.01 }));
    expect(root.querySelectorAll('.ls-card')).toHaveLength(1);
    ui.destroy();
    expect(root.children).toHaveLength(0);
    expect(root.className).toBe('');
  });
});
