import { expect, it } from 'vitest';
import type { ActivityStatus, CommandSource, GameCommand } from '../../src/input/commands';
import { InputHub } from '../../src/input/hub';

const source = (cmds: GameCommand[], a: Partial<ActivityStatus>): CommandSource => ({
  drain: () => cmds.splice(0),
  activity: () => ({ tracksJogging: false, msSinceStep: Infinity, cadenceSpm: 0, steps: 0, squatting: false, lost: false, ...a }),
});

it('merges commands and activity', () => {
  const hub = new InputHub([
    source([{ type: 'jump' }], { steps: 2 }),
    source([{ type: 'roll' }], { tracksJogging: true, msSinceStep: 300, cadenceSpm: 150, steps: 5, squatting: true }),
    source([], { tracksJogging: true, msSinceStep: 900, cadenceSpm: 170, lost: true }),
  ]);
  expect(hub.drain()).toEqual([{ type: 'jump' }, { type: 'roll' }]);
  expect(hub.drain()).toEqual([]);
  expect(hub.activity(0)).toEqual({ tracksJogging: true, msSinceStep: 300, cadenceSpm: 170, steps: 7, squatting: true, lost: true });
});

it('reports no jogging when no source tracks it', () => {
  const hub = new InputHub([source([], { cadenceSpm: 200 })]);
  expect(hub.activity(0)).toMatchObject({ tracksJogging: false, msSinceStep: Infinity, cadenceSpm: 0 });
});
