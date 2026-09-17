import { describe, expect, it } from 'vitest';
import { KeyboardInput } from '../../src/input/keyboard';

describe('KeyboardInput', () => {
  it('maps keys to commands and ignores auto-repeat', () => {
    const k = new KeyboardInput();
    for (const code of ['ArrowLeft', 'KeyD', 'ArrowUp', 'KeyS', 'ControlLeft', 'Enter', 'Escape']) k.keyDown({ code }, 0);
    k.keyDown({ code: 'ArrowUp', repeat: true }, 0);
    expect(k.keyDown({ code: 'KeyZ' }, 0)).toBe(false);
    expect(k.drain()).toEqual([
      { type: 'shiftLane', dir: -1 },
      { type: 'shiftLane', dir: 1 },
      { type: 'jump' },
      { type: 'roll' },
      { type: 'hoverboard' },
      { type: 'start' },
      { type: 'pause' },
    ]);
    expect(k.drain()).toEqual([]);
  });

  it('jumps on Space, W and Up; rolls on S and Down', () => {
    const k = new KeyboardInput();
    for (const code of ['Space', 'KeyW', 'ArrowUp', 'KeyS', 'ArrowDown']) k.keyDown({ code }, 0);
    expect(k.drain()).toEqual([{ type: 'jump' }, { type: 'jump' }, { type: 'jump' }, { type: 'roll' }, { type: 'roll' }]);
  });

  it('uses either Ctrl for the hoverboard and leaves Ctrl combos to the browser', () => {
    const k = new KeyboardInput();
    expect(k.keyDown({ code: 'ControlLeft' }, 0)).toBe(true);
    expect(k.keyDown({ code: 'ControlRight' }, 0)).toBe(true);
    expect(k.drain()).toEqual([{ type: 'hoverboard' }, { type: 'hoverboard' }]);
    // Ctrl+R / Ctrl+T: the letter key is not the game's, so its keydown is not blocked.
    expect(k.keyDown({ code: 'KeyR' }, 0)).toBe(false);
    expect(k.keyDown({ code: 'KeyT' }, 0)).toBe(false);
    expect(k.drain()).toEqual([]);
  });

  it('does not track jogging unless enabled', () => {
    expect(new KeyboardInput().activity(0).tracksJogging).toBe(false);
  });

  it('treats holding J as jogging at 160 spm', () => {
    const k = new KeyboardInput();
    k.jogEnabled = true;
    expect(k.activity(0).msSinceStep).toBe(Infinity);
    k.keyDown({ code: 'KeyJ' }, 1000);
    k.keyDown({ code: 'KeyJ', repeat: true }, 1500);
    const on = k.activity(2000);
    expect(on).toMatchObject({ tracksJogging: true, msSinceStep: 0, cadenceSpm: 160, steps: 3 });
    k.keyUp({ code: 'KeyJ' }, 2000);
    const off = k.activity(3500);
    expect(off).toMatchObject({ msSinceStep: 1500, cadenceSpm: 0, steps: 3 });
    expect(k.drain()).toEqual([]);
  });
});
