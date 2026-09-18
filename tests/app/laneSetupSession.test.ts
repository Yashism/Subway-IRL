import { describe, expect, it } from 'vitest';
import { LaneSetupSession, type LaneSetupSource } from '../../src/app/laneSetupSession';
import { SPOT_ADVANCE_MS, SPOT_HOLD_MS } from '../../src/pose/laneSetup';
import { LANE_SPOTS_KEY, LaneSpotsStore, type LaneSpots } from '../../src/pose/laneSpots';
import { emptyMagnitudes } from '../../src/pose/moves';

function memStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

/** A pose source the test moves by hand: `at(x)` puts the hips at offset x, `gone()` takes the player away. */
function source(mode: 'full' | 'small' = 'full') {
  type Mutable = { -readonly [K in keyof LaneSetupSource]: LaneSetupSource[K] };
  const src: Mutable & { at(x: number): void; gone(): void } = {
    magnitudes: emptyMagnitudes(),
    body: {},
    baseline: { mode },
    at(x: number) {
      (this.magnitudes as { lane: number }).lane = x;
      this.body = {};
    },
    gone() {
      (this.magnitudes as { lane: number }).lane = 0;
      this.body = null;
    },
  };
  return src;
}

function rig(saved: LaneSpots | null = null) {
  const storage = memStorage();
  const store = new LaneSpotsStore(storage);
  if (saved) store.save(saved, 5);
  const log: string[] = [];
  const got: LaneSpots[] = [];
  const s = new LaneSetupSession({
    store,
    now: () => 1_700_000_000_000,
    onSaved: (spots) => {
      got.push(spots);
      log.push('saved');
    },
    onDone: () => log.push('done'),
  });
  const src = source();
  let t = 0;
  const hold = (x: number, ms = SPOT_HOLD_MS + SPOT_ADVANCE_MS + 200) => {
    src.at(x);
    for (const end = t + ms; t < end; t += 1000 / 30) s.frame(src, t);
  };
  return { s, store, storage, log, got, src, hold, frame: () => s.frame(src, (t += 33)) };
}

const OLD: LaneSpots = { left: -0.5, centre: 0, right: 0.5 };

describe('LaneSetupSession', () => {
  it('has nothing to render until the flow starts it, and nothing after it ends', () => {
    const r = rig();
    expect(r.s.model).toBeNull();
    r.s.begin();
    expect(r.s.model?.step).toBe('centre');
    r.s.end();
    expect(r.s.model).toBeNull();
    expect(r.s.running).toBe(false);
  });

  it('Save stores all three spots, reports them and finishes', () => {
    const r = rig();
    r.s.begin();
    r.hold(0.05);
    r.hold(-0.7);
    r.hold(0.6);
    expect(r.s.model?.result).not.toBeNull();
    r.s.handlers.save();
    expect(r.log).toEqual(['saved', 'done']);
    const saved = r.store.get()!;
    expect(saved.left).toBeCloseTo(-0.7, 6);
    expect(saved.centre).toBeCloseTo(0.05, 6);
    expect(saved.right).toBeCloseTo(0.6, 6);
    expect(saved.at).toBe(1_700_000_000_000);
    expect(JSON.parse(r.storage.data.get(LANE_SPOTS_KEY)!).right).toBeCloseTo(0.6, 6);
    expect(r.got[0]).toEqual({ left: saved.left, centre: saved.centre, right: saved.right });
  });

  it('Save does nothing before all three spots are taken', () => {
    const r = rig(OLD);
    r.s.begin();
    r.hold(0.05);
    r.s.handlers.save();
    expect(r.log).toEqual([]);
    expect(r.store.get()).toEqual({ ...OLD, at: 5 });
  });

  it('Cancel finishes without touching the saved spots', () => {
    const r = rig(OLD);
    r.s.begin();
    r.hold(0.05);
    r.hold(-0.7);
    r.hold(0.6);
    r.s.handlers.cancel();
    expect(r.log).toEqual(['done']);
    expect(r.store.get()).toEqual({ ...OLD, at: 5 });
  });

  it('every other way out (the flow’s endLaneSetup) leaves the saved spots alone too', () => {
    const r = rig(OLD);
    r.s.begin();
    r.hold(0.05);
    r.hold(-0.7);
    r.hold(0.6);
    r.s.end();
    expect(r.store.get()).toEqual({ ...OLD, at: 5 });
    expect(r.log).toEqual([]);
    // And a stale button press after it is gone does nothing at all.
    r.s.handlers.save();
    r.s.handlers.cancel();
    expect(r.log).toEqual([]);
  });

  it('Redo starts again from the centre', () => {
    const r = rig();
    r.s.begin();
    r.hold(0.05);
    r.hold(-0.7);
    r.s.handlers.redo();
    expect(r.s.model?.step).toBe('centre');
    expect(r.s.model?.spots.centre).toBeNull();
  });

  it('a player out of view is not standing at the centre', () => {
    const r = rig();
    r.s.begin();
    r.src.gone();
    for (let i = 0; i < 60; i++) r.frame();
    expect(r.s.model?.live).toBeNull();
    expect(r.s.model?.spots.centre).toBeNull();
  });

  it('only a full-body calibration has spots to stand on', () => {
    const r = rig();
    r.s.begin();
    r.src.baseline = { mode: 'small' };
    r.src.at(0);
    for (let i = 0; i < 60; i++) r.frame();
    expect(r.s.model?.spots.centre).toBeNull();
    r.src.baseline = null;
    for (let i = 0; i < 60; i++) r.frame();
    expect(r.s.model?.spots.centre).toBeNull();
  });

  it('begin always starts fresh', () => {
    const r = rig();
    r.s.begin();
    r.hold(0.05);
    r.s.begin();
    expect(r.s.model?.spots.centre).toBeNull();
  });
});
