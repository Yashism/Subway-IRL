import { expect, it } from 'vitest';
import { mirrorPoses } from '../../src/pose/mirror';

it('mirrors x and defaults missing visibility to 0', () => {
  expect(mirrorPoses([[{ x: 0.2, y: 0.3, z: 0.1, visibility: 0.9 }, { x: 1, y: 0, z: 0 }]])).toEqual([
    [
      { x: 0.8, y: 0.3, z: 0.1, visibility: 0.9 },
      { x: 0, y: 0, z: 0, visibility: 0 },
    ],
  ]);
});
