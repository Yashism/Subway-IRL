import { describe, expect, it } from 'vitest';
import { FrameLimiter, RENDER_SCALES, RenderScale } from '../../src/app/frameBudget';

/** Feeds `seconds` of frames of `ms` each; returns every scale change, in order. */
function run(s: RenderScale, ms: number, seconds: number): number[] {
  const changes: number[] = [];
  for (let t = 0; t < seconds * 1000; t += ms) {
    const c = s.update(ms);
    if (c !== null) changes.push(c);
  }
  return changes;
}

describe('FrameLimiter', () => {
  const drawn = (limiter: FrameLimiter, stepMs: number, frames: number) => {
    let n = 0;
    for (let i = 0; i < frames; i++) if (limiter.accept(i * stepMs)) n++;
    return n;
  };

  it('halves a 120 Hz screen to 60 drawn frames a second', () => {
    expect(drawn(new FrameLimiter(), 1000 / 120, 120)).toBe(60);
  });

  it('draws every frame of a 60 Hz screen, jitter included', () => {
    const l = new FrameLimiter();
    let t = 0;
    let n = 0;
    for (let i = 0; i < 120; i++) {
      t += 16.67 + (i % 3 === 0 ? -1.2 : 0.6);
      if (l.accept(t)) n++;
    }
    expect(n).toBe(120);
  });

  it('thins a 144 Hz screen without ever drawing faster than 60', () => {
    const l = new FrameLimiter();
    let last = -Infinity;
    let fastest = Infinity;
    for (let i = 0; i < 288; i++) {
      const t = i * (1000 / 144);
      if (l.accept(t)) {
        fastest = Math.min(fastest, t - last);
        last = t;
      }
    }
    expect(fastest).toBeGreaterThanOrEqual(13);
  });

  it('can be switched to draw every frame, and back, while running', () => {
    const l = new FrameLimiter();
    l.setMinMs(0);
    expect(drawn(l, 4, 50)).toBe(50);
    l.setMinMs(13);
    expect(drawn(new FrameLimiter(13), 1000 / 120, 120)).toBe(60);
  });

  it('draws everything when switched off, and survives a clock that goes backwards', () => {
    expect(drawn(new FrameLimiter(0), 4, 100)).toBe(100);
    const l = new FrameLimiter();
    expect(l.accept(1000)).toBe(true);
    expect(l.accept(5)).toBe(true);
  });
});

describe('RenderScale', () => {
  it('starts at full resolution and stays there while frames are on time', () => {
    const s = new RenderScale();
    expect(s.scale).toBe(1);
    expect(run(s, 16.7, 60)).toEqual([]);
    expect(s.scale).toBe(1);
  });

  it('steps down after a second and a half of slow frames, and keeps stepping while slow', () => {
    const s = new RenderScale();
    const changes = run(s, 30, 12);
    expect(changes[0]).toBe(0.9);
    expect(changes.length).toBeGreaterThan(2);
    expect(changes).toEqual([...changes].sort((a, b) => b - a));
  });

  it('never goes below the smallest scale', () => {
    const s = new RenderScale();
    run(s, 60, 120);
    expect(s.scale).toBe(RENDER_SCALES[RENDER_SCALES.length - 1]);
  });

  it('ignores a hitch: a few long frames are not a slow GPU', () => {
    const s = new RenderScale();
    for (let i = 0; i < 200; i++) expect(s.update(i % 40 === 0 ? 90 : 16.7)).toBeNull();
    expect(s.scale).toBe(1);
  });

  it('ignores multi-second gaps entirely, such as a hidden tab coming back', () => {
    const s = new RenderScale();
    for (let i = 0; i < 100; i++) expect(s.update(2500)).toBeNull();
    expect(s.scale).toBe(1);
  });

  it('still steps down on a GPU so slow that every frame is a quarter of a second', () => {
    const s = new RenderScale();
    expect(run(s, 250, 20).length).toBeGreaterThan(0);
  });

  it('tries a step back up once frames have been comfortable for a while', () => {
    const s = new RenderScale();
    run(s, 30, 4);
    const low = s.scale;
    expect(low).toBeLessThan(1);
    const up = run(s, 16.7, 12);
    expect(up[0]).toBeGreaterThan(low);
  });

  it('waits longer to try again after a step up that did not hold', () => {
    const s = new RenderScale();
    run(s, 30, 4); // down
    const firstUp = run(s, 16.7, 12);
    expect(firstUp.length).toBe(1);
    const down = run(s, 30, 4); // the probe fails
    expect(down.length).toBeGreaterThan(0);
    // The first probe waited 8 s; the next one must wait longer than that.
    expect(run(s, 16.7, 12)).toEqual([]);
    expect(run(s, 16.7, 12).length).toBe(1);
  });

  it('goes back to full resolution, with no history, on reset', () => {
    const s = new RenderScale();
    run(s, 30, 4);
    expect(s.scale).toBeLessThan(1);
    s.reset();
    expect(s.scale).toBe(1);
    expect(run(s, 16.7, 20)).toEqual([]);
  });

  it('ignores nonsense', () => {
    const s = new RenderScale();
    for (const v of [NaN, Infinity, -5, 0]) expect(s.update(v)).toBeNull();
  });
});
