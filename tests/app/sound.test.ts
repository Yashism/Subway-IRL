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

  /** A stand-in for the browser: `grant` is whether *this* attempt has user activation. */
  function audio() {
    const a = { built: false, running: false, attempts: 0, grant: true };
    return {
      a,
      unlock: () => {
        a.attempts++;
        a.built = true;
        // A context built without activation is created suspended and refuses to resume — and a
        // later call with activation resumes the one that is already there.
        if (a.grant) a.running = true;
      },
      audible: () => a.running,
    };
  }

  it('does not unlock before a gesture, and stands down once one has worked', () => {
    const el = target();
    const w = audio();
    const g = new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    expect(g.unlocked).toBe(false);
    expect(w.a.attempts).toBe(0);

    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(g.unlocked).toBe(true);
    expect(w.a.attempts).toBe(1);

    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    el.dispatchEvent(new Event('pointerdown'));
    expect(w.a.attempts).toBe(1);
  });

  it('a click is a gesture too', () => {
    const el = target();
    const w = audio();
    new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    el.dispatchEvent(new Event('pointerdown'));
    expect(w.a.attempts).toBe(1);
  });

  it('a raised hand never reaches the DOM, so fire() stands in for it', () => {
    const el = target();
    const w = audio();
    const g = new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    g.fire();
    expect(w.a.attempts).toBe(1);
    expect(g.unlocked).toBe(true);
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(w.a.attempts).toBe(1);
  });

  it('keeps trying when an attempt built a graph the browser will not run', () => {
    // This is the raised-hand path: a pose frame carries no user activation, so the context is
    // created suspended. Latching there left the player silent for the whole session.
    const el = target();
    const w = audio();
    w.a.grant = false;
    const g = new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    g.fire();
    expect(w.a.built).toBe(true);
    expect(g.unlocked).toBe(false);
    expect(w.a.attempts).toBe(1);

    // A real key press afterwards has activation, and gets through.
    w.a.grant = true;
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN' }));
    expect(w.a.running).toBe(true);
    expect(w.a.attempts).toBe(2);

    // …and only then does it stop listening.
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN' }));
    expect(w.a.attempts).toBe(2);
  });

  it('offers every gesture until one takes, however many that is', () => {
    const el = target();
    const w = audio();
    w.a.grant = false;
    new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    for (let i = 0; i < 5; i++) el.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    expect(w.a.attempts).toBe(5);
    w.a.grant = true;
    el.dispatchEvent(new Event('pointerdown'));
    expect(w.a.running).toBe(true);
    el.dispatchEvent(new Event('pointerdown'));
    expect(w.a.attempts).toBe(6);
  });

  it('a resume that only lands after the gesture is picked up by the next one', () => {
    const el = target();
    const w = audio();
    w.a.grant = false;
    const g = new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(g.unlocked).toBe(false);
    // The browser resumed it a moment later, out of band.
    w.a.running = true;
    expect(g.unlocked).toBe(true);
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(w.a.attempts).toBe(1); // no further attempt: it stood down instead
  });

  it('disabled means silent: no listeners, and fire() does nothing', () => {
    const el = target();
    const w = audio();
    const g = new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible, enabled: false });
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    el.dispatchEvent(new Event('pointerdown'));
    g.fire();
    expect(w.a.attempts).toBe(0);
    expect(g.unlocked).toBe(false);
  });

  it('detach stops listening without unlocking', () => {
    const el = target();
    const w = audio();
    const g = new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    g.detach();
    el.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(w.a.attempts).toBe(0);
    expect(g.unlocked).toBe(false);
  });

  it('listens in the capture phase, so a focused control cannot swallow the gesture', () => {
    const el = target();
    document.body.append(el);
    const inner = document.createElement('button');
    el.append(inner);
    inner.addEventListener('keydown', (e) => e.stopPropagation());
    const w = audio();
    new GestureUnlock({ target: el, onUnlock: w.unlock, audible: w.audible });
    inner.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    expect(w.a.attempts).toBe(1);
    el.remove();
  });
});
