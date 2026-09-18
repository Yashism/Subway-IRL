// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GestureUnlock, soundAllowed } from '../../src/app/sound';

const ctx = (over: Partial<Parameters<typeof soundAllowed>[0]> = {}) => ({
  autopilot: false,
  replay: false,
  search: '',
  ...over,
});

describe('soundAllowed', () => {
  it('a player gets sound; a bot demo and a replay do not', () => {
    expect(soundAllowed(ctx())).toBe(true);
    expect(soundAllowed(ctx({ autopilot: true }))).toBe(false);
    expect(soundAllowed(ctx({ replay: true }))).toBe(false);
  });

  it('?audio forces it on for a demo someone is watching, ?audio=0 silences anything', () => {
    expect(soundAllowed(ctx({ autopilot: true, search: '?audio' }))).toBe(true);
    expect(soundAllowed(ctx({ replay: true, search: '?autopilot&audio=1' }))).toBe(true);
    expect(soundAllowed(ctx({ search: '?audio=0' }))).toBe(false);
    expect(soundAllowed(ctx({ search: '?audio=off' }))).toBe(false);
  });

  it('survives a search string it cannot parse', () => {
    expect(soundAllowed(ctx({ search: '%' }))).toBe(true);
    expect(soundAllowed(ctx({ autopilot: true, search: '%' }))).toBe(false);
  });
});

describe('GestureUnlock', () => {
  const target = () => document.createElement('div');

  it('does not unlock before a gesture, and unlocks exactly once after one', () => {
    const el = target();
    let unlocks = 0;
    const g = new GestureUnlock({ target: el, onUnlock: () => unlocks++ });
    expect(g.unlocked).toBe(false);
    expect(unlocks).toBe(0);

    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(g.unlocked).toBe(true);
    expect(unlocks).toBe(1);

    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    el.dispatchEvent(new Event('pointerdown'));
    expect(unlocks).toBe(1);
  });

  it('a click is a gesture too', () => {
    const el = target();
    let unlocks = 0;
    new GestureUnlock({ target: el, onUnlock: () => unlocks++ });
    el.dispatchEvent(new Event('pointerdown'));
    expect(unlocks).toBe(1);
  });

  it('a raised hand never reaches the DOM, so fire() stands in for it', () => {
    const el = target();
    let unlocks = 0;
    const g = new GestureUnlock({ target: el, onUnlock: () => unlocks++ });
    g.fire();
    expect(unlocks).toBe(1);
    // …and the listeners are gone, so the next key does not unlock a second time.
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(unlocks).toBe(1);
  });

  it('disabled means silent: no listeners, and fire() does nothing', () => {
    const el = target();
    let unlocks = 0;
    const g = new GestureUnlock({ target: el, onUnlock: () => unlocks++, enabled: false });
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    el.dispatchEvent(new Event('pointerdown'));
    g.fire();
    expect(unlocks).toBe(0);
    expect(g.unlocked).toBe(false);
  });

  it('detach stops listening without unlocking', () => {
    const el = target();
    let unlocks = 0;
    const g = new GestureUnlock({ target: el, onUnlock: () => unlocks++ });
    g.detach();
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(unlocks).toBe(0);
    expect(g.unlocked).toBe(false);
  });

  it('listens in the capture phase, so a focused control cannot swallow the gesture', () => {
    const el = target();
    document.body.append(el);
    const inner = document.createElement('button');
    el.append(inner);
    inner.addEventListener('keydown', (e) => e.stopPropagation());
    let unlocks = 0;
    new GestureUnlock({ target: el, onUnlock: () => unlocks++ });
    inner.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    expect(unlocks).toBe(1);
    el.remove();
  });
});
