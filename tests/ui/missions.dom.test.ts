// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHARACTER,
  ProgressionStore,
  dailyChallenge,
  dailyView,
  emptyDaily,
  shopModel,
  type DailyView,
  type ShopModel,
} from '../../src/app/progression';
import type { MissionView } from '../../src/game/missions';
import {
  MissionBoard,
  clampFrac,
  pct,
  renderDailyCard,
  renderMissionList,
  renderMissionRow,
  renderMissionToast,
} from '../../src/ui/missionCard';
import { ShopScreen, buttonFor } from '../../src/ui/shop';

class FakeStorage {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

const DAY = '2026-09-18';

const view = (over: Partial<MissionView> = {}): MissionView => ({
  id: 'jog-steps',
  group: 'movement',
  icon: '👟',
  label: 'Jog 250 steps in one run',
  progress: 100,
  target: 250,
  frac: 0.4,
  done: false,
  text: '100 / 250 steps',
  reward: 75,
  ...over,
});

let root: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

// ---------------------------------------------------------------- helpers

describe('bar helpers', () => {
  it('clamps and never yields NaN%', () => {
    expect(pct(0.5)).toBe('50%');
    expect(pct(2)).toBe('100%');
    expect(pct(-1)).toBe('0%');
    expect(pct(Number.NaN)).toBe('0%');
    expect(clampFrac(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

// ---------------------------------------------------------------- mission rows

describe('renderMissionRow', () => {
  it('shows the goal, the count, the reward and a bar at the right width', () => {
    const row = renderMissionRow(view());
    expect(row.querySelector('.ms-row-label')!.textContent).toBe('Jog 250 steps in one run');
    expect(row.querySelector('.ms-row-count')!.textContent).toBe('100 / 250 steps');
    expect(row.querySelector('.ms-row-reward-n')!.textContent).toBe('75');
    expect((row.querySelector('.ms-bar-fill') as HTMLElement).style.width).toBe('40%');
    expect(row.dataset.state).toBe('going');
    expect(row.dataset.group).toBe('movement');
  });

  it('ticks a finished mission instead of showing its icon', () => {
    const row = renderMissionRow(view({ done: true, progress: 250, frac: 1, text: 'Done!' }));
    expect(row.dataset.state).toBe('done');
    expect(row.querySelector('.ms-row-glyph')!.textContent).toBe('✓');
    expect((row.querySelector('.ms-bar-fill') as HTMLElement).style.width).toBe('100%');
  });

  it('is announced to a screen reader as a progress bar', () => {
    const bar = renderMissionRow(view()).querySelector('.ms-bar')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuemax')).toBe('250');
    expect(bar.getAttribute('aria-label')).toContain('Jog 250 steps');
  });

  it('can drop the reward chip for the summary card', () => {
    expect(renderMissionRow(view(), { reward: false }).querySelector('.ms-row-reward')).toBeNull();
  });
});

describe('renderMissionList', () => {
  it('lists every mission and counts the finished ones', () => {
    const card = renderMissionList([view(), view({ id: 'jumps', done: true }), view({ id: 'rolls' })]);
    expect(card.querySelectorAll('.ms-row')).toHaveLength(3);
    expect(card.querySelector('.ms-head-note')!.textContent).toBe('1 of 3 done');
  });

  it('invites a first run instead of showing an empty box', () => {
    const card = renderMissionList([]);
    expect(card.querySelectorAll('.ms-row')).toHaveLength(0);
    expect(card.querySelector('.ms-empty')!.textContent).toBeTruthy();
  });

  it('takes a title for the summary', () => {
    expect(renderMissionList([view()], { title: 'Mission progress' }).querySelector('.ms-head-title')!.textContent).toBe('Mission progress');
  });
});

// ---------------------------------------------------------------- daily card

const daily = (over: Partial<DailyView> = {}): DailyView => ({
  ...dailyView(dailyChallenge(DAY), emptyDaily(DAY)),
  ...over,
});

describe('renderDailyCard', () => {
  it('names the route, the goal and the reward', () => {
    const c = dailyChallenge(DAY);
    const card = renderDailyCard(daily());
    expect(card.querySelector('.ms-daily-title')!.textContent).toBe(c.title);
    expect(card.querySelector('.ms-daily-goal')!.textContent).toBe(c.goal);
    expect(card.querySelector('.ms-row-reward-n')!.textContent).toBe(String(c.coins));
    expect(card.dataset.state).toBe('open');
  });

  it('lights the flame only on a live streak', () => {
    expect(renderDailyCard(daily()).querySelector('.ms-streak')!.getAttribute('data-on')).toBe('off');
    expect(renderDailyCard(daily({ streak: 3, streakText: '3 days in a row' })).querySelector('.ms-streak')!.getAttribute('data-on')).toBe('on');
  });

  it('reads as done when it is done', () => {
    const card = renderDailyCard(daily({ done: true, frac: 1, progressText: 'Done today!' }));
    expect(card.dataset.state).toBe('done');
    expect(card.querySelector('.ms-daily-count')!.textContent).toBe('Done today!');
  });

  it('advertises the coins while they are still there to win', () => {
    const chip = renderDailyCard(daily({ coins: 220 })).querySelector('.ms-row-reward') as HTMLElement;
    expect(chip.dataset.claimed).toBe('no');
    expect(chip.textContent).toContain('220');
  });

  it('stops advertising them once they are paid, because a repeat run pays nothing', () => {
    const chip = renderDailyCard(daily({ coins: 220, done: true, frac: 1 })).querySelector('.ms-row-reward') as HTMLElement;
    expect(chip.dataset.claimed).toBe('yes');
    expect(chip.textContent).not.toContain('220');
    expect(chip.textContent).toContain('Claimed');
  });

  it('offers the run button only when there is something to do with it', () => {
    expect(renderDailyCard(daily()).querySelector('.ms-btn-go')).toBeNull();
    const onPlay = vi.fn();
    const card = renderDailyCard(daily(), { onPlay });
    const btn = card.querySelector('.ms-btn-go') as HTMLButtonElement;
    btn.click();
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it('blurs the button on click, so the next Enter reaches the game', () => {
    const card = renderDailyCard(daily(), { onPlay: () => undefined });
    document.body.append(card);
    const btn = card.querySelector('.ms-btn-go') as HTMLButtonElement;
    btn.focus();
    expect(document.activeElement).toBe(btn);
    btn.click();
    expect(document.activeElement).not.toBe(btn);
  });
});

describe('renderMissionToast', () => {
  it('says what moved, and shouts when a mission is done', () => {
    expect(renderMissionToast(view()).querySelector('.ms-toast-label')!.textContent).toBe('Jog 250 steps in one run');
    const done = renderMissionToast(view({ done: true }));
    expect(done.dataset.state).toBe('done');
    expect(done.querySelector('.ms-toast-label')!.textContent).toBe('Mission complete!');
    expect(done.querySelector('.ms-toast-count')!.textContent).toContain('+₹75');
  });
});

// ---------------------------------------------------------------- the board

describe('MissionBoard', () => {
  it('draws the level strip, the daily and the list', () => {
    const b = new MissionBoard(root, {});
    b.update({ missions: [view(), view({ id: 'jumps' })], daily: daily(), level: { text: 'LEVEL 4', sub: '200 / 1,200', frac: 0.16 }, coins: '1,240' });
    expect(root.dataset.on).toBe('on');
    expect(root.querySelector('.ms-level-text')!.textContent).toBe('LEVEL 4');
    expect(root.querySelector('.ms-purse-n')!.textContent).toBe('1,240');
    expect(root.querySelector('.ms-daily')).not.toBeNull();
    expect(root.querySelectorAll('.ms-row')).toHaveLength(2);
  });

  it('hides on a null model and comes back', () => {
    const b = new MissionBoard(root, {});
    b.update({ missions: [view()], daily: null });
    b.update(null);
    expect(root.dataset.on).toBe('off');
    expect(root.children).toHaveLength(0);
    b.update({ missions: [view()], daily: null });
    expect(root.dataset.on).toBe('on');
  });

  it('does not rebuild when the model has not changed', () => {
    const b = new MissionBoard(root, {});
    const m = { missions: [view()], daily: null };
    b.update(m);
    const first = root.querySelector('.ms-row');
    b.update({ missions: [view()], daily: null });
    expect(root.querySelector('.ms-row')).toBe(first);
  });

  it('wires the shop and daily buttons', () => {
    const onShop = vi.fn();
    const onPlayDaily = vi.fn();
    const b = new MissionBoard(root, { onShop, onPlayDaily });
    b.update({ missions: [], daily: daily(), level: { text: 'LEVEL 1', sub: '', frac: 0 } });
    (root.querySelector('.ms-btn-shop') as HTMLButtonElement).click();
    (root.querySelector('.ms-btn-go') as HTMLButtonElement).click();
    expect(onShop).toHaveBeenCalledOnce();
    expect(onPlayDaily).toHaveBeenCalledOnce();
  });

  it('cleans up after itself', () => {
    const b = new MissionBoard(root, {});
    b.update({ missions: [view()], daily: null });
    b.destroy();
    expect(root.children).toHaveLength(0);
    expect(root.classList.contains('ms-board')).toBe(false);
  });
});

// ---------------------------------------------------------------- the shop

describe('buttonFor', () => {
  const it0 = (state: 'equipped' | 'owned' | 'afford' | 'locked', over = {}) =>
    ({ id: 'x', kind: 'character' as const, name: 'X', blurb: '', icon: '🧒', price: 250, priceText: '250', swatch: ['#000', '#111', '#222'] as const, state, held: null, short: 100, ...over });

  it('says the right thing in each state', () => {
    expect(buttonFor(it0('equipped'))).toMatchObject({ label: 'Equipped', action: 'none' });
    expect(buttonFor(it0('owned'))).toMatchObject({ label: 'Equip', action: 'equip' });
    expect(buttonFor(it0('afford'))).toMatchObject({ label: 'Buy 250', action: 'buy' });
    expect(buttonFor(it0('locked'))).toMatchObject({ label: '100 more', action: 'none' });
  });
});

describe('ShopScreen', () => {
  const model = (setup: (s: ProgressionStore) => void = () => undefined): ShopModel => {
    const s = new ProgressionStore(new FakeStorage());
    setup(s);
    return shopModel(s.state);
  };

  it('starts hidden and opens on a model', () => {
    const shop = new ShopScreen(root, { buy: vi.fn(), equip: vi.fn() });
    expect(root.dataset.on).toBe('off');
    shop.update(model());
    expect(root.dataset.on).toBe('on');
    shop.update(null);
    expect(root.dataset.on).toBe('off');
  });

  it('groups the items and shows the purse and the level', () => {
    const shop = new ShopScreen(root, { buy: vi.fn(), equip: vi.fn() });
    shop.update(model((s) => s.award(500)));
    expect(root.querySelector('.sh-purse-n')!.textContent).toBe('500');
    expect(root.querySelectorAll('.sh-section')).toHaveLength(3);
    expect(root.querySelectorAll('.sh-item').length).toBeGreaterThan(5);
    expect(root.querySelector('.sh-level-text')!.textContent).toMatch(/^LEVEL /);
  });

  it('shows every state and disables the ones that do nothing', () => {
    const shop = new ShopScreen(root, { buy: vi.fn(), equip: vi.fn() });
    shop.update(model((s) => {
      s.award(300);
      s.buy('runner-college');
      s.equip('runner-college');
    }));
    const at = (id: string) => root.querySelector(`.sh-item[data-state]:has(+ *), .sh-item`) && [...root.querySelectorAll('.sh-item')].find((e) => e.querySelector('.sh-name')!.textContent === id)!;
    const equipped = at('College kid') as HTMLElement;
    expect(equipped.dataset.state).toBe('equipped');
    expect((equipped.querySelector('.sh-btn') as HTMLButtonElement).disabled).toBe(true);

    const owned = at('Street kid') as HTMLElement;
    expect(owned.dataset.state).toBe('owned');
    expect((owned.querySelector('.sh-btn') as HTMLButtonElement).disabled).toBe(false);

    const locked = at('Maharaja') as HTMLElement;
    expect(locked.dataset.state).toBe('locked');
    expect((locked.querySelector('.sh-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(locked.querySelector('.sh-btn')!.textContent).toContain('more');
  });

  it('calls back with the id that was clicked', () => {
    const buy = vi.fn();
    const equip = vi.fn();
    const shop = new ShopScreen(root, { buy, equip });
    // Bought but not equipped, so the screen has one of every state to click.
    shop.update(model((s) => {
      s.award(700);
      s.buy('runner-college');
    }));
    const items = [...root.querySelectorAll('.sh-item')];
    const affordable = items.find((e) => (e as HTMLElement).dataset.state === 'afford')!;
    (affordable.querySelector('.sh-btn') as HTMLButtonElement).click();
    expect(buy).toHaveBeenCalledOnce();

    const ownedItem = items.find((e) => (e as HTMLElement).dataset.state === 'owned')!;
    (ownedItem.querySelector('.sh-btn') as HTMLButtonElement).click();
    expect(equip).toHaveBeenCalledOnce();
  });

  it('counts the boosts a player holds', () => {
    const shop = new ShopScreen(root, { buy: vi.fn(), equip: vi.fn() });
    shop.update(model((s) => {
      s.award(400);
      s.buy('magnet-boost');
      s.buy('magnet-boost');
    }));
    const boost = [...root.querySelectorAll('.sh-item')].find((e) => e.querySelector('.sh-name')!.textContent === 'Magnet boost')!;
    expect(boost.querySelector('.sh-held')!.textContent).toBe('×2');
  });

  it('does not put an item the game cannot spend on the shelf', () => {
    const shop = new ShopScreen(root, { buy: vi.fn(), equip: vi.fn() });
    shop.update(model((s) => s.award(2000)));
    const names = [...root.querySelectorAll('.sh-name')].map((e) => e.textContent);
    expect(names).toContain('Magnet boost');
    expect(names).not.toContain('Head start');
  });

  it('offers a way back only when there is somewhere to go', () => {
    const noClose = new ShopScreen(root, { buy: vi.fn(), equip: vi.fn() });
    noClose.update(model());
    expect(root.querySelector('.sh-actions')).toBeNull();

    const close = vi.fn();
    const other = document.createElement('div');
    document.body.append(other);
    const shop = new ShopScreen(other, { buy: vi.fn(), equip: vi.fn(), close });
    shop.update(model());
    (other.querySelector('.sh-actions .ms-btn') as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the default character owned so something is always equipped', () => {
    const m = model();
    expect(m.items.find((i) => i.id === DEFAULT_CHARACTER)!.state).toBe('equipped');
  });
});
