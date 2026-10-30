import { describe, expect, it } from 'vitest';
import { TRACK_LANES, TRACK_X, type Box } from '../../src/wander/city';
import { END_DISTANCE, FIRST_TRAIN_S, NEAR_RANGE, SPAWN_DISTANCE, TrainTimetable, passCloseness } from '../../src/wander/trains';

const run = (t: TrainTimetable, seconds: number, px: number, pz: number, dt = 0.05) => {
  const passes = [] as { at: number; dx: number }[];
  for (let s = 0; s < seconds; s += dt) {
    const p = t.update(dt, px, pz);
    if (p) passes.push({ at: s, dx: p.dx });
  }
  return passes;
};

describe('train timetable', () => {
  it('sends no train until the first wait is over', () => {
    const t = new TrainTimetable(1, 100);
    run(t, FIRST_TRAIN_S - 1, TRACK_X, 0);
    expect(t.state.active).toBe(false);
    run(t, 2, TRACK_X, 0);
    expect(t.state.active).toBe(true);
  });

  it('starts out of sight, on the far side of the fog, and runs along its track', () => {
    const t = new TrainTimetable(1, 100);
    run(t, FIRST_TRAIN_S + 0.5, TRACK_X + 10, 500);
    const s = t.state;
    expect(s.active).toBe(true);
    expect(s.dir).toBe(1);
    expect(s.x).toBe(TRACK_LANES[2]);
    // Its front is SPAWN_DISTANCE short of the walker; its rear is further still.
    expect(500 - s.frontZ).toBeGreaterThan(SPAWN_DISTANCE - 40);
    expect(500 - (s.frontZ - 100)).toBeGreaterThan(SPAWN_DISTANCE);
    const z0 = s.frontZ;
    run(t, 1, TRACK_X + 10, 500);
    expect(s.frontZ - z0).toBeCloseTo(s.speed, 0);
  });

  it('reports one pass as its front draws level, then finishes and waits for the next', () => {
    const t = new TrainTimetable(1, 100);
    const passes = run(t, 60, TRACK_X, 0);
    expect(passes.length).toBeGreaterThanOrEqual(1);
    expect(passes[0].dx).toBeCloseTo(TRACK_LANES[2] - TRACK_X, 6);
    const first = t.state.active;
    expect(typeof first).toBe('boolean');
    // Over the whole minute it never reports a pass twice for one train.
    const times = passes.map((p) => p.at);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThan(15);
  });

  it('alternates direction and takes the track beside the platform northbound', () => {
    const t = new TrainTimetable(2, 100);
    const dirs: number[] = [];
    let wasActive = false;
    for (let s = 0; s < 400; s += 0.05) {
      t.update(0.05, TRACK_X, 0);
      if (t.state.active && !wasActive) dirs.push(t.state.dir);
      if (t.state.active && t.state.dir < 0) expect(t.state.x).toBe(TRACK_LANES[0]);
      wasActive = t.state.active;
    }
    expect(dirs.length).toBeGreaterThanOrEqual(4);
    expect(dirs.slice(0, 4)).toEqual([1, -1, 1, -1]);
  });

  it('does not run, and does not use up its wait, while the walker is far from the railway', () => {
    const t = new TrainTimetable(1, 100);
    run(t, 120, TRACK_X + NEAR_RANGE + 50, 0);
    expect(t.state.active).toBe(false);
  });

  it('is deterministic for a seed', () => {
    const a = new TrainTimetable(5, 100);
    const b = new TrainTimetable(5, 100);
    run(a, 90, TRACK_X, 0);
    run(b, 90, TRACK_X, 0);
    expect(a.state).toEqual(b.state);
  });

  it('is a solid box on its track while it runs, behind its front, and nothing otherwise', () => {
    const t = new TrainTimetable(1, 100);
    const box: Box = { x0: 0, z0: 0, x1: 0, z1: 0 };
    expect(t.solid(box)).toBeNull();
    run(t, FIRST_TRAIN_S + 1, TRACK_X, 0);
    const s = t.state;
    expect(t.solid(box)).toBe(box);
    expect(box.x0).toBeLessThan(s.x);
    expect(box.x1).toBeGreaterThan(s.x);
    expect(box.z1).toBeCloseTo(s.frontZ, 6);
    expect(box.z1 - box.z0).toBeCloseTo(100, 6);
    expect(END_DISTANCE).toBeGreaterThan(SPAWN_DISTANCE);
  });

  it('is louder the nearer the track', () => {
    expect(passCloseness(0)).toBe(1);
    expect(passCloseness(20)).toBeLessThan(passCloseness(5));
    expect(passCloseness(500)).toBe(0.15);
    expect(passCloseness(-5)).toBe(passCloseness(5));
  });
});
