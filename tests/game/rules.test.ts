import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { Chaser, IdleClock, StumbleTracker } from '../../src/game/rules';
import type { ActivityStatus } from '../../src/input/commands';

const act = (a: Partial<ActivityStatus>): ActivityStatus => ({
  tracksJogging: true,
  msSinceStep: Infinity,
  cadenceSpm: 0,
  steps: 0,
  squatting: false,
  lost: false,
  ...a,
});

describe('Chaser', () => {
  it('falls back, then closes in when alerted', () => {
    const c = new Chaser();
    expect(c.gap).toBe(TUNING.chaserStartGap);
    expect(c.visible).toBe(true);
    for (let i = 0; i < 240; i++) c.update(1 / 60, false);
    expect(c.gap).toBeGreaterThan(10);
    expect(c.visible).toBe(false);
    for (let i = 0; i < 60; i++) c.update(1 / 60, true);
    expect(c.gap).toBeLessThan(4);
    c.catchUp();
    expect(c.gap).toBeLessThan(1);
  });
});

describe('StumbleTracker', () => {
  it('catches on a second stumble within the window', () => {
    const s = new StumbleTracker();
    expect(s.recent(0)).toBe(false);
    expect(s.hit(10)).toBe('stumble');
    expect(s.recent(15)).toBe(true);
    expect(s.hit(18.5)).toBe('stumble');
    expect(s.hit(20)).toBe('caught');
  });
});

describe('IdleClock', () => {
  it('never catches when jogging is not tracked', () => {
    const c = new IdleClock();
    c.resume(0);
    expect(c.update(10_000, act({ tracksJogging: false }))).toBe('ok');
  });

  it('warns after 1 s and catches after 2 s without steps', () => {
    const c = new IdleClock();
    c.resume(0);
    expect(c.update(999, act({}))).toBe('ok');
    expect(c.update(1000, act({}))).toBe('warn');
    expect(c.update(2000, act({}))).toBe('caught');
  });

  it('counts steps, actions and resumes as activity', () => {
    const c = new IdleClock();
    c.resume(0);
    expect(c.update(1800, act({ msSinceStep: 100 }))).toBe('ok');
    expect(c.update(3000, act({ msSinceStep: 1300 }))).toBe('warn');
    c.action(3000);
    expect(c.update(3500, act({ msSinceStep: 1800 }))).toBe('ok');
    c.resume(10_000);
    expect(c.update(10_500, act({ msSinceStep: 7000 }))).toBe('ok');
    expect(c.idleMs(10_500)).toBe(500);
  });

  it('credits a held squat for at most 1 s', () => {
    const c = new IdleClock();
    c.resume(0);
    c.update(500, act({ squatting: true }));
    expect(c.update(2400, act({ squatting: true }))).toBe('ok');
    expect(c.update(2500, act({ squatting: true }))).toBe('warn');
    expect(c.update(3500, act({ squatting: true }))).toBe('caught');
  });
});
