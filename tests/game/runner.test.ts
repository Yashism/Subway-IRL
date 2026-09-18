import { describe, expect, it } from 'vitest';
import { TUNING } from '../../src/game/config';
import { CHAPPAL_JUMP, jumpHeightAt, NORMAL_JUMP, Runner } from '../../src/game/runner';

const DT = 1 / 60;
function run(r: Runner, frames: number, surface = 0) {
  for (let i = 0; i < frames; i++) r.update(DT, surface);
}

describe('Runner lanes', () => {
  it('slides to the new lane in 0.15 s', () => {
    const r = new Runner();
    expect(r.setLane(1)).toBe(true);
    run(r, 7);
    expect(r.changingLane).toBe(true);
    run(r, 2);
    expect(r.x).toBeCloseTo(2.5, 9);
    expect(r.changingLane).toBe(false);
  });

  it('clamps at the edges and bounces back to the previous lane', () => {
    const r = new Runner();
    expect(r.shiftLane(1)).toBe(true);
    expect(r.shiftLane(1)).toBe(false);
    expect(r.setLane(1)).toBe(false);
    r.bounceBack();
    expect(r.lane).toBe(0);
    expect(r.prevLane).toBe(1);
  });
});

describe('Runner jump and roll', () => {
  it('follows the analytic jump arc at frame times', () => {
    const r = new Runner();
    expect(r.jump()).toBe(true);
    expect(r.jump()).toBe(false);
    const frames = Math.round(TUNING.jumpSeconds / DT);
    for (let f = 1; f < frames; f++) {
      r.update(DT, 0);
      expect(r.y).toBeCloseTo(jumpHeightAt(f * DT, NORMAL_JUMP), 9);
    }
    r.update(DT, 0);
    expect(r.y).toBe(0);
    expect(r.airborne).toBe(false);
    expect(jumpHeightAt(TUNING.jumpSeconds / 2, NORMAL_JUMP)).toBeCloseTo(TUNING.jumpHeight, 9);
  });

  it('rolls for 0.6 s at reduced height', () => {
    const r = new Runner();
    r.roll();
    expect(r.height).toBe(TUNING.rollHeight);
    run(r, 35);
    expect(r.rolling).toBe(true);
    run(r, 2);
    expect(r.rolling).toBe(false);
    expect(r.height).toBe(TUNING.runnerHeight);
  });

  it('slams down when rolling in the air and rolls on landing', () => {
    const r = new Runner();
    r.jump();
    run(r, 6);
    r.roll();
    let frames = 0;
    while (r.airborne && frames < 60) {
      r.update(DT, 0);
      frames++;
    }
    expect(frames).toBeLessThan(6);
    expect(r.rolling).toBe(true);
  });

  it('cancels a roll with a jump', () => {
    const r = new Runner();
    r.roll();
    run(r, 5);
    expect(r.jump()).toBe(true);
    expect(r.rolling).toBe(false);
  });

  it('jumps much higher with chappals', () => {
    const r = new Runner();
    r.jump(CHAPPAL_JUMP);
    run(r, 27);
    expect(r.y).toBeCloseTo(TUNING.chappalJumpHeight, 6);
  });
});

describe('Runner surfaces and flight', () => {
  it('walks up to a surface and falls when it ends', () => {
    const r = new Runner();
    r.update(DT, 0.2);
    expect(r.y).toBeCloseTo(0.2, 9);
    r.y = TUNING.trainHeight;
    r.update(DT, TUNING.trainHeight);
    expect(r.airborne).toBe(false);
    r.update(DT, 0);
    expect(r.airborne).toBe(true);
    run(r, 40);
    expect(r.y).toBe(0);
    expect(r.airborne).toBe(false);
  });

  it('lands on a higher surface when falling onto it', () => {
    const r = new Runner();
    r.jump(CHAPPAL_JUMP);
    run(r, 30, 0); // past the 3.8 m peak, still above the roof
    run(r, 30, TUNING.trainHeight);
    expect(r.y).toBe(TUNING.trainHeight);
    expect(r.airborne).toBe(false);
  });

  it('climbs to rocket height while flying and falls afterwards', () => {
    const r = new Runner();
    r.flying = true;
    expect(r.jump()).toBe(false);
    run(r, 60);
    expect(r.y).toBe(TUNING.rocketHeight);
    r.flying = false;
    run(r, 60);
    expect(r.y).toBe(0);
  });
});
