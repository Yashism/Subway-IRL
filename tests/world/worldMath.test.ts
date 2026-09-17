import { describe, expect, it } from 'vitest';
import { BUILDING_PALETTE, buildingAt, repeatingOffsets } from '../../src/world/worldMath';

describe('repeatingOffsets', () => {
  it('lists items on a fixed grid around the runner', () => {
    expect(repeatingOffsets(10, 4, 3, 10)).toEqual([-2, 2, 6, 10]);
    const offs = repeatingOffsets(123.4, 1.5, 12, 220);
    expect(offs[0]).toBeGreaterThanOrEqual(-12);
    expect(offs[offs.length - 1]).toBeLessThanOrEqual(220);
    for (let i = 1; i < offs.length; i++) expect(offs[i] - offs[i - 1]).toBeCloseTo(1.5, 9);
  });
});

describe('buildingAt', () => {
  it('is deterministic, varied and uses the palette', () => {
    expect(buildingAt(7, 1)).toEqual(buildingAt(7, 1));
    expect(buildingAt(7, 1)).not.toEqual(buildingAt(7, -1));
    const heights = new Set<number>();
    for (let k = 0; k < 50; k++) {
      const b = buildingAt(k, -1);
      heights.add(Math.round(b.height));
      expect(b.height).toBeGreaterThanOrEqual(6);
      expect(b.height).toBeLessThanOrEqual(22);
      expect(b.width).toBeGreaterThanOrEqual(7);
      expect(b.width).toBeLessThanOrEqual(11);
      expect(BUILDING_PALETTE).toContain(b.color);
    }
    expect(heights.size).toBeGreaterThan(5);
  });
});
