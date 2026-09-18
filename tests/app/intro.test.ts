import { describe, expect, it } from 'vitest';
import { INTRO_CUES, IntroRunner, introMode, shouldPlayIntro, type IntroCue, type IntroStage } from '../../src/app/intro';
import { INTRO_BEATS, INTRO_BRUSH_STROKES, INTRO_DURATION } from '../../src/world/intro';

const ctx = (over: Partial<Parameters<typeof shouldPlayIntro>[0]> = {}) => ({
  mode: 'auto' as const,
  autopilot: false,
  replay: false,
  keyboardTest: false,
  played: false,
  ...over,
});

describe('introMode', () => {
  it('defaults to auto with no flag, and on a value it does not know', () => {
    expect(introMode('')).toBe('auto');
    expect(introMode('?seed=3')).toBe('auto');
    expect(introMode('?intro=maybe')).toBe('auto');
  });

  it('reads the two the spec names, and the obvious spellings of each', () => {
    expect(introMode('?intro=always')).toBe('always');
    expect(introMode('?intro')).toBe('always');
    expect(introMode('?intro=1')).toBe('always');
    expect(introMode('?intro=off')).toBe('off');
    expect(introMode('?intro=0')).toBe('off');
  });
});

describe('shouldPlayIntro', () => {
  it('plays on the first run of a session and never again', () => {
    expect(shouldPlayIntro(ctx())).toBe(true);
    expect(shouldPlayIntro(ctx({ played: true }))).toBe(false);
  });

  it('stays out of the way of every automated path', () => {
    expect(shouldPlayIntro(ctx({ autopilot: true }))).toBe(false);
    expect(shouldPlayIntro(ctx({ replay: true }))).toBe(false);
    expect(shouldPlayIntro(ctx({ keyboardTest: true }))).toBe(false);
  });

  it('?intro=always forces it even there, and even on a later run', () => {
    expect(shouldPlayIntro(ctx({ mode: 'always', autopilot: true, replay: true, played: true }))).toBe(true);
  });

  it('?intro=off wins over everything, including a first run', () => {
    expect(shouldPlayIntro(ctx({ mode: 'off' }))).toBe(false);
  });
});

/** The world, as the runner sees it: a log of the calls, in order. */
function stage(duration = 4.2) {
  const log: string[] = [];
  let t = 0;
  let ended = false;
  const s: IntroStage<{ name: string }> & { log: string[]; handedOverBefore: string[] } = {
    log,
    handedOverBefore: [],
    get introBeat() {
      return t >= duration ? 4 : Math.min(4, Math.floor(t / (duration / 4)) + 1);
    },
    get introTime() {
      return t;
    },
    startIntro(o) {
      log.push(`start:${o?.seed ?? ''}`);
      t = 0;
      ended = false;
    },
    advanceIntro(dt) {
      t += dt;
      return t < duration && !ended;
    },
    renderIntro() {
      log.push('draw');
    },
    skipIntro() {
      log.push('skip');
      // A skip is a jump to the end, exactly as the real sequence does it.
      t = duration;
      ended = true;
    },
    endIntro(game) {
      log.push(`end:${game.name}`);
    },
  };
  return s;
}

describe('IntroRunner', () => {
  it('plays out, hands the world back, then releases the run — in that order', () => {
    const st = stage();
    const order: string[] = [];
    const intro = new IntroRunner({ stage: st, seed: 7, onEnd: () => order.push('release') });
    intro.begin();
    expect(st.log).toEqual(['start:7']);
    expect(intro.playing).toBe(true);

    for (let i = 0; i < 100 && intro.playing; i++) {
      if (intro.advance(0.1, { name: 'game' })) intro.draw();
    }
    expect(intro.playing).toBe(false);
    // The handover happens before the caller is told it may start the run.
    expect(st.log.filter((l) => l.startsWith('end')).length).toBe(1);
    expect(st.log.at(-1)).toBe('end:game');
    expect(order).toEqual(['release']);
  });

  it('a skip at any beat lands in the same place: one end, one release', () => {
    for (const at of [0, 1.3, 2.5, 3.6]) {
      const st = stage();
      let released = 0;
      const intro = new IntroRunner({ stage: st, onEnd: () => released++ });
      intro.begin();
      let t = 0;
      while (intro.playing) {
        if (t >= at) intro.skip();
        intro.advance(0.1, { name: 'game' });
        t += 0.1;
      }
      expect(st.log.filter((l) => l === 'end:game')).toEqual(['end:game']);
      expect(released).toBe(1);
    }
  });

  it('is skippable from frame one, before a single frame has been advanced', () => {
    const st = stage();
    const intro = new IntroRunner({ stage: st });
    intro.begin();
    intro.skip();
    expect(st.log).toContain('skip');
    expect(intro.advance(1 / 60, { name: 'game' })).toBe(false);
  });

  it('begins once per session, and does nothing at all when it is not playing', () => {
    const st = stage();
    const intro = new IntroRunner({ stage: st });
    intro.begin();
    intro.begin();
    expect(st.log.filter((l) => l.startsWith('start')).length).toBe(1);
    expect(intro.played).toBe(true);

    while (intro.playing) intro.advance(0.5, { name: 'game' });
    const after = st.log.length;
    intro.skip();
    intro.draw();
    expect(intro.advance(0.5, { name: 'game' })).toBe(false);
    expect(st.log.length).toBe(after);
    expect(intro.beat).toBe(0);
  });
});

describe('the cinematic\u2019s own sounds', () => {
  const run = (over: { skipAt?: number } = {}) => {
    const st = stage();
    const cues: { cue: IntroCue; at: number }[] = [];
    const intro = new IntroRunner({ stage: st, onCue: (cue) => cues.push({ cue, at: st.introTime }) });
    intro.begin();
    let t = 0;
    while (intro.playing && t < 10) {
      if (over.skipAt !== undefined && t >= over.skipAt) intro.skip();
      intro.advance(1 / 60, { name: 'game' });
      t += 1 / 60;
    }
    return cues;
  };

  it('the brush strokes are the instants the paste flies, not a second guess at them', () => {
    expect(INTRO_CUES.filter((c) => c.cue === 'brush').map((c) => c.t)).toEqual([...INTRO_BRUSH_STROKES]);
  });

  it('every cue lands inside the sequence, in order, in the beat the spec puts it in', () => {
    const times = INTRO_CUES.map((c) => c.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times.at(-1)!).toBeLessThan(INTRO_DURATION);
    const at = (cue: IntroCue) => INTRO_CUES.filter((c) => c.cue === cue).map((c) => c.t);
    // Beat 1 is the pasting, beat 2 opens with the poster dropping, beat 3 is the torch.
    for (const t of at('brush')) expect(t).toBeLessThan(INTRO_BEATS[2]);
    expect(at('unfurl')).toEqual([INTRO_BEATS[1]]);
    for (const t of at('whistle')) {
      expect(t).toBeGreaterThanOrEqual(INTRO_BEATS[2]);
      expect(t).toBeLessThan(INTRO_BEATS[3]);
    }
  });

  it('plays each one once, in order, as the clock reaches it', () => {
    const cues = run();
    expect(cues.map((c) => c.cue)).toEqual(INTRO_CUES.map((c) => c.cue));
    for (const c of cues) {
      const due = INTRO_CUES.find((x) => x.cue === c.cue)!.t;
      expect(c.at).toBeGreaterThanOrEqual(due);
    }
  });

  it('a skip drops the cues it jumped over instead of firing them all at once', () => {
    const cues = run({ skipAt: 0.5 });
    // Two brush strokes had landed by 0.5 s; the rest of the sequence is gone.
    expect(cues.filter((c) => c.cue === 'brush').length).toBe(2);
    expect(cues.filter((c) => c.cue === 'unfurl').length).toBe(0);
    // …except the whistle, which is the sound the player is handed to the run by.
    expect(cues.filter((c) => c.cue === 'whistle').length).toBe(1);
  });

  it('says nothing at all when the page wired no sound', () => {
    const st = stage();
    const intro = new IntroRunner({ stage: st });
    intro.begin();
    expect(() => {
      while (intro.playing) intro.advance(1 / 60, { name: 'game' });
    }).not.toThrow();
  });
});
