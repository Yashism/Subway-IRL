import { expect, it } from 'vitest';
import { FixedStepper } from '../../src/game/loop';

it('turns variable frames into fixed steps and caps long frames', () => {
  const f = new FixedStepper();
  expect(f.advance(1 / 60)).toBe(1);
  expect(f.advance(1 / 120)).toBe(0);
  expect(f.advance(1 / 120)).toBe(1);
  expect(f.advance(0.1)).toBe(6);
  expect(f.advance(5)).toBe(15);
  expect(f.advance(-1)).toBe(0);
});
