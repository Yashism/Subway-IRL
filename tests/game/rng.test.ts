import { expect, it } from 'vitest';
import { Rng } from '../../src/game/rng';

it('is deterministic per seed and stays in range', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  const xs = Array.from({ length: 1000 }, () => a.next());
  expect(Array.from({ length: 1000 }, () => b.next())).toEqual(xs);
  expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  expect(new Rng(43).next()).not.toBe(xs[0]);
});

it('picks, draws integers and flips coins', () => {
  const r = new Rng(7);
  const seen = new Set(Array.from({ length: 200 }, () => r.int(3)));
  expect([...seen].sort()).toEqual([0, 1, 2]);
  expect(['a', 'b']).toContain(r.pick(['a', 'b']));
  expect(new Rng(1).chance(0)).toBe(false);
  expect(new Rng(1).chance(1)).toBe(true);
});
