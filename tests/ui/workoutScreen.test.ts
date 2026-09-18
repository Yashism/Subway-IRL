// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileStore, dayKey, emptyProfile, type Profile, type RunInput } from '../../src/app/profile';
import { ASSUMED_WEIGHT_KG, type RecentRun } from '../../src/app/stats';
import { WorkoutScreen, barPercent, caloriesLine, runHow, streakWords, type WorkoutHandlers, type WorkoutView } from '../../src/ui/workout';

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};

const run = (over: Partial<RunInput> = {}): RunInput => ({
  at: Date.now(),
  score: 1000,
  coins: 20,
  distance: 500,
  timeSec: 180,
  jumps: 3,
  rolls: 2,
  laneChanges: 8,
  steps: 200,
  hoverboardsUsed: 0,
  caughtReason: 'chaser',
  difficulty: 'cardio',
  seed: 1,
  input: 'webcam',
  activeSeconds: 160,
  mode: 'full',
  ...over,
});

function at(n: number, hour = 12): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
}

function profileOf(runs: RunInput[]): Profile {
  const store = new ProfileStore(memory());
  for (const r of runs) store.recordRun(r);
  return store.profile;
}

function screen() {
  const root = document.createElement('div');
  document.body.append(root);
  const fired: string[] = [];
  const handlers: WorkoutHandlers = {
    startRun: () => void fired.push('start'),
    openSettings: () => void fired.push('settings'),
    close: () => void fired.push('close'),
  };
  return { root, ui: new WorkoutScreen(root, handlers), fired };
}

const view = (over: Partial<WorkoutView> = {}): WorkoutView => ({
  open: true,
  profile: profileOf([run({ at: at(0) })]),
  weightKg: null,
  ...over,
});

const byText = (root: Element, sel: string, text: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(sel)).find((e) => e.textContent === text);

afterEach(() => {
  document.body.replaceChildren();
});

describe('view helpers', () => {
  it('scales a bar against the week peak, with a floor so a short day still shows', () => {
    expect(barPercent(0, 600)).toBe(0);
    expect(barPercent(600, 600)).toBe(100);
    expect(barPercent(300, 600)).toBe(50);
    expect(barPercent(1, 6000)).toBe(6);
  });

  it('refuses to divide by an empty week', () => {
    expect(barPercent(100, 0)).toBe(0);
    expect(barPercent(Number.NaN, 100)).toBe(0);
  });

  it('never scolds a player without a streak', () => {
    expect(streakWords(0, false)).toMatch(/start a streak/i);
    expect(streakWords(1, true)).toMatch(/Day one/);
    expect(streakWords(4, true)).toBe('4 days in a row');
  });

  it('never states a calorie figure without the caveat and the weight', () => {
    const line = caloriesLine(1800, null);
    expect(line).toMatch(/rough estimate/);
    expect(line).toContain(`${ASSUMED_WEIGHT_KG} kg`);
    expect(line).toMatch(/kcal/);
    const mine = caloriesLine(1800, 85);
    expect(mine).toContain('at 85 kg');
    expect(mine).toMatch(/rough estimate/);
  });

  it('describes how a run was played, and copes with a record that never said', () => {
    const recent = (mode: string, input: string): RecentRun => ({ ...run(), mode, input, day: '', activeSeconds: 0, newBest: false });
    expect(runHow(recent('small', 'keyboard'))).toBe('Small room · keyboard');
    expect(runHow(recent('', ''))).toBe('—');
  });
});

describe('the empty state', () => {
  it('invites a first run instead of showing a wall of zeros', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: emptyProfile() }));
    expect(root.dataset.empty).toBe('yes');
    expect(root.querySelector('.wk-invite-title')!.textContent).toMatch(/Nothing here yet/i);
    expect(byText(root, '.sw-btn', 'Run your first')).toBeTruthy();
  });

  it('starts a run from the invitation', () => {
    const { root, ui, fired } = screen();
    ui.update(view({ profile: emptyProfile() }));
    byText(root, '.sw-btn', 'Run your first')!.click();
    expect(fired).toEqual(['start']);
  });

  it('switches to the real thing the moment there is a run', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: emptyProfile() }));
    ui.update(view());
    expect(root.dataset.empty).toBe('no');
    expect(root.querySelectorAll('.wk-run').length).toBe(1);
  });
});

describe('today', () => {
  it('leads with active minutes and fills the tiles', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: profileOf([run({ at: at(0), timeSec: 400, activeSeconds: 360, steps: 640, distance: 1200, coins: 33 })]) }));
    expect(root.querySelector('.wk-hero-num')!.textContent).toBe('6');
    const tiles = Array.from(root.querySelectorAll('.wk-card-today .wk-tile-val')).map((e) => e.textContent);
    expect(tiles).toEqual(['640', '1.2 km', '33', '1']);
  });

  it('labels the calories for today as rough, with the assumed weight', () => {
    const { root, ui } = screen();
    ui.update(view());
    expect(root.querySelector('.wk-card-today .wk-cals')!.textContent).toMatch(/rough estimate, assuming 70 kg/);
  });

  it('uses the weight the player offered, once they offer one', () => {
    const { root, ui } = screen();
    ui.update(view({ weightKg: 95 }));
    expect(root.querySelector('.wk-card-today .wk-cals')!.textContent).toContain('at 95 kg');
  });
});

describe('the week chart', () => {
  it('draws seven bars with today last and highlighted', () => {
    const { root, ui } = screen();
    ui.update(view());
    const bars = root.querySelectorAll<HTMLElement>('.wk-bar');
    expect(bars).toHaveLength(7);
    expect(bars[6].dataset.today).toBe('on');
    expect(Array.from(bars).filter((b) => b.dataset.today === 'on')).toHaveLength(1);
  });

  it('scales the bars against the tallest day and marks the empty ones', () => {
    const { root, ui } = screen();
    ui.update(
      view({
        profile: profileOf([
          run({ at: at(2), timeSec: 700, activeSeconds: 600 }),
          run({ at: at(0), timeSec: 400, activeSeconds: 300 }),
        ]),
      }),
    );
    const fills = Array.from(root.querySelectorAll<HTMLElement>('.wk-bar-fill')).map((e) => e.style.height);
    expect(fills[4]).toBe('100%');
    expect(fills[6]).toBe('50%');
    expect(fills[5]).toBe('0%');
    expect(root.querySelectorAll<HTMLElement>('.wk-bar')[5].dataset.empty).toBe('yes');
  });

  it('labels a bar with its minutes, and leaves an empty day unlabelled', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: profileOf([run({ at: at(0), timeSec: 400, activeSeconds: 360 })]) }));
    const caps = Array.from(root.querySelectorAll('.wk-bar-cap')).map((e) => e.textContent);
    expect(caps[6]).toBe('6');
    expect(caps[0]).toBe('');
  });

  it('names each bar for a screen reader', () => {
    const { root, ui } = screen();
    ui.update(view());
    const label = root.querySelectorAll('.wk-bar')[6].getAttribute('aria-label')!;
    expect(label).toMatch(/active minutes/);
  });

  it('shows the streak, and the best one only once it has been beaten', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: profileOf([run({ at: at(1) }), run({ at: at(0) })]) }));
    expect(root.querySelector('.wk-streak-num')!.textContent).toBe('2');
    expect(root.querySelector('.wk-streak-badge')!.getAttribute('data-on')).toBe('on');
    expect(root.querySelector('.wk-streak-best')!.textContent).toBe('');

    ui.update(view({ profile: profileOf([run({ at: at(9) }), run({ at: at(8) }), run({ at: at(7) }), run({ at: at(0) })]) }));
    expect(root.querySelector('.wk-streak-num')!.textContent).toBe('1');
    expect(root.querySelector('.wk-streak-best')!.textContent).toMatch(/3/);
  });

  it('dims the streak badge when there is no streak', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: profileOf([run({ at: at(6) })]) }));
    expect(root.querySelector('.wk-streak-badge')!.getAttribute('data-on')).toBe('off');
    expect(root.querySelector('.wk-streak-words')!.textContent).toMatch(/start a streak/i);
  });
});

describe('the run list', () => {
  it('is newest first, with the best run badged', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: profileOf([run({ at: at(2), score: 100 }), run({ at: at(1), score: 900 }), run({ at: at(0), score: 300 })]) }));
    const rows = root.querySelectorAll<HTMLElement>('.wk-run');
    expect(Array.from(rows).map((r) => r.querySelector('.wk-run-score-num')!.textContent)).toEqual(['300', '900', '100']);
    expect(rows[1].dataset.best).toBe('on');
    expect(rows[1].querySelector('.wk-run-score-label')!.textContent).toBe('NEW BEST');
    expect(rows[0].dataset.best).toBeUndefined();
  });

  it('names the day in words for today and yesterday', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: profileOf([run({ at: at(1) }), run({ at: at(0) })]) }));
    const days = Array.from(root.querySelectorAll('.wk-run-day')).map((e) => e.textContent);
    expect(days).toEqual(['Today', 'Yesterday']);
  });

  it('shows distance, time and coins for each run', () => {
    const { root, ui } = screen();
    ui.update(view({ profile: profileOf([run({ at: at(0), distance: 820, timeSec: 195, coins: 41 })]) }));
    const stats = Array.from(root.querySelectorAll('.wk-run-stat-val')).map((e) => e.textContent);
    expect(stats).toEqual(['820 m', '3m', '41']);
  });

  it('rebuilds only when the history really changed', () => {
    const { root, ui } = screen();
    const v = view();
    ui.update(v);
    const first = root.querySelector('.wk-run');
    ui.update(v);
    expect(root.querySelector('.wk-run')).toBe(first);
    ui.update(view({ profile: profileOf([run({ at: at(0) }), run({ at: at(0), score: 5 })]) }));
    expect(root.querySelector('.wk-run')).not.toBe(first);
  });

  it('stops at the thirty runs the profile keeps', () => {
    const { root, ui } = screen();
    const runs = Array.from({ length: 40 }, (_, i) => run({ at: at(39 - i), score: i }));
    ui.update(view({ profile: profileOf(runs) }));
    expect(root.querySelectorAll('.wk-run')).toHaveLength(30);
  });
});

describe('all time', () => {
  it('reports the lifetime numbers', () => {
    const { root, ui } = screen();
    ui.update(
      view({
        profile: profileOf([
          run({ at: at(3), score: 400, distance: 900, coins: 10, steps: 180, timeSec: 200, activeSeconds: 180 }),
          run({ at: at(0), score: 2500, distance: 2100, coins: 30, steps: 420, timeSec: 500, activeSeconds: 450 }),
        ]),
      }),
    );
    const tiles = Array.from(root.querySelectorAll('.wk-card-all .wk-tile-val')).map((e) => e.textContent);
    // runs, active min, distance, steps, coins, best score, best run, longest run, days moved
    expect(tiles).toEqual(['2', '11', '3.0 km', '600', '40', '2,500', '2.1 km', '8m', '2']);
  });
});

describe('the frame', () => {
  it('shows and hides the layer, and goes back down on destroy', () => {
    const { root, ui } = screen();
    ui.update(view({ open: false }));
    expect(root.dataset.on).toBe('off');
    ui.update(view());
    expect(root.dataset.on).toBe('on');
    ui.destroy();
    expect(root.children).toHaveLength(0);
  });

  it('rolls up against the instant it was given', () => {
    const { root, ui } = screen();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    ui.update(view({ profile: profileOf([run({ at: at(0) })]), now: tomorrow.getTime() }));
    expect(root.querySelector('.wk-hero-num')!.textContent).toBe('0');
    expect(root.querySelector('.wk-run-day')!.textContent).toBe('Yesterday');
    expect(dayKey(tomorrow.getTime())).not.toBe(dayKey(Date.now()));
  });

  it('reports each footer button', () => {
    const { root, ui, fired } = screen();
    ui.update(view());
    byText(root, '.sw-btn', 'Run again')!.click();
    byText(root, '.sw-btn', '⚙ Settings')!.click();
    byText(root, '.sw-btn', 'Done')!.click();
    expect(fired).toEqual(['start', 'settings', 'close']);
  });
});
