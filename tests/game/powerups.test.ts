import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { JoshMeter, Powerups } from '../../src/game/powerups';

describe('Powerups', () => {
  it('runs each power-up for its duration and reports the rocket ending once', () => {
    const p = new Powerups();
    p.activate('magnet');
    p.activate('rocket');
    p.activate('chappal');
    expect([p.magnet, p.rocket, p.chappal]).toEqual([TUNING.magnetSeconds, TUNING.rocketSeconds, TUNING.chappalSeconds]);
    expect(p.invulnerable).toBe(true);
    expect(p.update(TUNING.rocketSeconds - 0.01).rocketEnded).toBe(false);
    expect(p.update(0.02).rocketEnded).toBe(true);
    expect(p.update(0.02).rocketEnded).toBe(false);
    expect(p.rocket).toBe(0);
    expect(p.magnet).toBeGreaterThan(0);
  });

  it('allows three hoverboards, one at a time, each absorbing one crash', () => {
    const p = new Powerups();
    expect(p.absorbCrash()).toBe(false);
    expect(p.activateHoverboard()).toBe(true);
    expect(p.activateHoverboard()).toBe(false);
    expect(p.absorbCrash()).toBe(true);
    expect(p.hoverboard).toBe(0);
    expect(p.invulnerable).toBe(true);
    p.update(TUNING.crashGraceSeconds + 0.01);
    expect(p.invulnerable).toBe(false);
    expect(p.activateHoverboard()).toBe(true);
    p.update(TUNING.hoverboardSeconds + 0.01);
    expect(p.hoverboard).toBe(0);
    expect(p.activateHoverboard()).toBe(true);
    p.update(TUNING.hoverboardSeconds + 0.01);
    expect(p.activateHoverboard()).toBe(false);
    expect(p.hoverboardsLeft).toBe(0);
    p.reset();
    expect(p.hoverboardsLeft).toBe(TUNING.hoverboardsPerRun);
  });
});

describe('JoshMeter', () => {
  it('fills with a fast cadence, doubles coins while full and drains otherwise', () => {
    const j = new JoshMeter();
    for (let i = 0; i < 290; i++) j.update(1 / 60, 170);
    expect(j.active).toBe(false);
    for (let i = 0; i < 20; i++) j.update(1 / 60, 170);
    expect(j.active).toBe(true);
    expect(j.multiplier).toBe(2);
    for (let i = 0; i < 120; i++) j.update(1 / 60, 150);
    expect(j.active).toBe(true);
    for (let i = 0; i < 70; i++) j.update(1 / 60, 150);
    expect(j.active).toBe(false);
    expect(j.multiplier).toBe(1);
  });
});
