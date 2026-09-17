import { describe, expect, it } from 'vitest';
import { MoveCheckSession, summaryFromTuning } from '../../src/app/moveCheckSession';
import { ADVANCE_MS, OFFER_SKIP_MS, type MoveCheckSource } from '../../src/pose/moveCheck';
import { MOVE_TUNING_KEY, type MoveTuning } from '../../src/pose/moveCheckTypes';
import { emptyMagnitudes } from '../../src/pose/moves';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../../src/pose/thresholds';
import { MoveTuningStore, tunedValue, type TuningStorage } from '../../src/pose/tuning';
import type { MoveCheckEvent } from '../../src/telemetry/messages';
import type { MoveMagnitudes, PlayMode, PoseEvent } from '../../src/pose/types';

const FRAME_MS = 1000 / 30;

/** A localStorage stand-in whose contents survive a "reload" (a second store over the same data). */
function memStore(): TuningStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** The session driven from hand-written magnitudes, standing in for the pose pipeline. */
class Rig implements MoveCheckSource {
  readonly th: Thresholds = { ...DEFAULT_THRESHOLDS };
  sensitivity = 1;
  readonly magnitudes: MoveMagnitudes = emptyMagnitudes();
  readonly session: MoveCheckSession;
  /** Stands in for the PoseController's baseline pin. */
  readonly ctrl = { freezeBaseline: false };
  readonly told: MoveCheckEvent[] = [];
  readonly tuningChanges: (MoveTuning | null)[] = [];
  starts = 0;
  t = 0;

  constructor(storage: TuningStorage = memStore(), key = MOVE_TUNING_KEY) {
    this.session = new MoveCheckSession({
      thresholds: this.th,
      controller: this.ctrl,
      store: new MoveTuningStore(storage, key),
      now: () => 1_700_000_000_000,
      onStart: () => this.starts++,
      onTuningChanged: (t) => this.tuningChanges.push(t),
      onTelemetry: (_mode, e) => this.told.push(e),
    });
  }

  frame(set: Partial<MoveMagnitudes> = {}, events: readonly PoseEvent[] = [], dtMs = FRAME_MS): void {
    this.t += dtMs;
    Object.assign(this.magnitudes, set);
    this.session.frame(this, events, this.t);
  }

  wait(ms: number, set: Partial<MoveMagnitudes> = {}): void {
    const end = this.t + ms;
    while (this.t < end - 1e-9) this.frame(set, [], Math.min(FRAME_MS, end - this.t));
  }

  /** Jogs four steps, then does each remaining move once, big enough to fire. */
  walkThrough(mode: PlayMode): void {
    this.session.begin(mode);
    this.frame();
    for (let i = 1; i <= 4; i++) this.frame({ jogPrimary: 0.4, jogSteps: i });
    this.wait(ADVANCE_MS + FRAME_MS, { jogPrimary: 0.4, jogSteps: 4 });
    const lane = (dir: -1 | 1): PoseEvent[] =>
      mode === 'full' ? [{ type: 'lane', lane: dir }] : [{ type: 'laneShift', dir }];
    this.succeed({ lane: -0.5, tiltDeg: -20 }, lane(-1));
    this.succeed({ lane: 0.5, tiltDeg: 20 }, lane(1));
    this.succeed({ lane: 0, tiltDeg: 0, rise: 0.3 }, [{ type: 'jump' }]);
    this.succeed({ rise: 0, drop: 0.5, headDrop: 0.5 }, [{ type: 'roll' }]);
    this.succeed({ drop: 0, headDrop: 0 }, [{ type: 'hoverboard' }]);
  }

  private succeed(set: Partial<MoveMagnitudes>, events: readonly PoseEvent[]): void {
    this.frame(set, events);
    this.wait(ADVANCE_MS + FRAME_MS, set);
  }
}

const phases = (told: readonly MoveCheckEvent[]) =>
  told.map((e) => (e.phase === 'done' ? 'done' : `${e.phase}:${e.move}${e.phase === 'result' ? `:${e.result}` : ''}`));

describe('MoveCheckSession: running a check', () => {
  it('saves what the check measured and puts it in force on the live thresholds at once', () => {
    const r = new Rig();
    expect(r.th.kneeLift).toBe(DEFAULT_THRESHOLDS.kneeLift);
    r.walkThrough('full');
    expect(r.session.model!.summary).not.toBeNull();
    // 0.55 × the 0.4 knee lift the player actually managed.
    expect(r.th.kneeLift).toBeCloseTo(tunedValue('kneeLift', 0.4), 6);
    expect(r.session.store.get('full')!.thresholds.kneeLift).toBeCloseTo(r.th.kneeLift, 6);
    expect(r.tuningChanges).toHaveLength(1);
  });

  it('a saved tuning survives a reload and is applied before the first run', () => {
    const storage = memStore();
    new Rig(storage).walkThrough('full');
    const saved = JSON.parse(storage.data[MOVE_TUNING_KEY]) as { modes: Record<string, MoveTuning> };
    expect(saved.modes.full.mode).toBe('full');

    // A fresh page over the same storage.
    const next = new Rig(storage);
    expect(next.session.seen).toBe(true);
    expect(next.th.kneeLift).toBe(DEFAULT_THRESHOLDS.kneeLift);
    next.session.applyFor('full');
    expect(next.th.kneeLift).toBeCloseTo(tunedValue('kneeLift', 0.4), 6);
  });

  it('tuning is per play mode: a mode change swaps the thresholds in force', () => {
    const storage = memStore();
    new Rig(storage).walkThrough('full');
    const r = new Rig(storage);
    r.session.applyFor('full');
    const tuned = r.th.kneeLift;
    expect(tuned).not.toBe(DEFAULT_THRESHOLDS.kneeLift);
    // Small room has no record yet, so its check starts from the shipped defaults.
    r.session.applyFor('small');
    expect(r.th.kneeLift).toBe(DEFAULT_THRESHOLDS.kneeLift);
    r.session.applyFor('full');
    expect(r.th.kneeLift).toBeCloseTo(tuned, 6);
  });

  it('a skipped step keeps the value saved before it, rather than falling back to the default', () => {
    const storage = memStore();
    new Rig(storage).walkThrough('full');
    const first = new MoveTuningStore(storage).get('full')!.thresholds.kneeLift!;

    // Redo the check and skip everything: the earlier measurement must survive.
    const again = new Rig(storage);
    again.session.begin('full');
    again.frame();
    again.session.handlers.skipAll();
    expect(again.session.store.get('full')!.thresholds.kneeLift).toBeCloseTo(first, 6);
    expect(again.th.kneeLift).toBeCloseTo(first, 6);
  });

  it('"Reset to defaults" forgets the record, restores the defaults and starts over', () => {
    const storage = memStore();
    const r = new Rig(storage);
    r.walkThrough('full');
    expect(r.session.seen).toBe(true);
    r.session.handlers.resetTuning();
    expect(r.session.seen).toBe(false);
    expect(storage.data[MOVE_TUNING_KEY]).toBeUndefined();
    expect(r.th.kneeLift).toBe(DEFAULT_THRESHOLDS.kneeLift);
    // Back to the first step, ready to measure again.
    expect(r.session.model!.summary).toBeNull();
    expect(r.session.model!.index).toBe(0);
    expect(r.tuningChanges.at(-1)).toBeNull();
  });

  it('"Start playing" is handed straight back to the caller', () => {
    const r = new Rig();
    r.session.begin('full');
    r.session.handlers.start();
    expect(r.starts).toBe(1);
  });

  it('feeds nothing and renders nothing outside a check', () => {
    const r = new Rig();
    expect(r.session.model).toBeNull();
    expect(r.session.running).toBe(false);
    r.frame({ rise: 0.5 }, [{ type: 'jump' }]);
    expect(r.session.model).toBeNull();
    r.session.begin('full');
    expect(r.session.running).toBe(true);
    r.session.end();
    expect(r.session.model).toBeNull();
  });
});

describe('MoveCheckSession: the baseline pin', () => {
  it('holds the baseline still while a step is being measured, and lets go after', () => {
    // Drift chases a slow, sub-threshold lean, which is exactly the excursion being measured.
    const r = new Rig();
    expect(r.ctrl.freezeBaseline).toBe(false);
    r.session.begin('full');
    r.frame();
    expect(r.ctrl.freezeBaseline).toBe(true);
    // Nothing is being measured on the summary card: the baseline may follow the player again.
    r.session.handlers.skipAll();
    expect(r.ctrl.freezeBaseline).toBe(false);
    // "Redo the check" measures again, so it pins again.
    r.session.handlers.redo();
    expect(r.ctrl.freezeBaseline).toBe(true);
    r.session.end();
    expect(r.ctrl.freezeBaseline).toBe(false);
  });

  it('lets go of the baseline even when the check is abandoned mid-step', () => {
    const r = new Rig();
    r.session.begin('full');
    r.frame();
    r.session.end();
    expect(r.ctrl.freezeBaseline).toBe(false);
  });
});

describe('MoveCheckSession: telemetry', () => {
  it('reports every step start and result, then the tuned values', () => {
    const r = new Rig();
    r.walkThrough('full');
    const seen = phases(r.told);
    expect(seen[0]).toBe('start:jog');
    expect(seen).toContain('result:jog:done');
    expect(seen).toContain('start:hover');
    expect(seen).toContain('result:hover:done');
    expect(seen.at(-1)).toBe('done');
    const done = r.told.at(-1)!;
    if (done.phase !== 'done') throw new Error('last event should be the tuned values');
    expect(done.tuned.kneeLift).toBeCloseTo(tunedValue('kneeLift', 0.4), 6);
    expect(done.note).toBeNull();
  });

  it('reports a skipped step as skipped, with what it managed', () => {
    const r = new Rig();
    r.session.begin('full');
    r.frame();
    r.wait(OFFER_SKIP_MS + 100); // the step only offers a way out after ~10 s
    r.session.handlers.skipStep();
    expect(phases(r.told)).toEqual(['start:jog', 'result:jog:skipped', 'start:left']);
  });
});

describe('the controls cheat sheet', () => {
  it('uses this session’s summary when there is one', () => {
    const r = new Rig();
    r.walkThrough('full');
    expect(r.session.controls('full')).toBe(r.session.model!.summary);
  });

  it('falls back to the saved tuning, and hands back the same object each time', () => {
    const storage = memStore();
    const first = new Rig(storage);
    first.walkThrough('full');
    const live = first.session.model!.summary!;
    const r = new Rig(storage);
    const card = r.session.controls('full');
    expect(card).toBe(r.session.controls('full'));
    expect(card.mode).toBe('full');
    expect(card.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      'jog:done',
      'left:done',
      'right:done',
      'jump:done',
      'roll:done',
      'hover:done',
    ]);
    expect(card.tuned.kneeLift).toBeCloseTo(tunedValue('kneeLift', 0.4), 6);
    // A record stores only the measured keys; applyTuning derives the companions. The rebuilt
    // card must still list what the card the check itself ended on listed, or it would quietly
    // claim fewer tuned settings than the player was just told about.
    expect(Object.keys(r.session.store.get('full')!.thresholds)).not.toContain('kneeRelease');
    expect(card.tuned.kneeRelease).toBeDefined();
    expect(Object.keys(card.tuned).sort()).toEqual(Object.keys(live.tuned).sort());
  });

  it('describes the moves of the mode even with nothing saved at all', () => {
    const card = summaryFromTuning('small', null);
    expect(card.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(card.steps.find((s) => s.id === 'left')!.how).toMatch(/lean/i);
    expect(card.tuned).toEqual({});
  });
});
