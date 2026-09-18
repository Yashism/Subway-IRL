/**
 * Lane spots end to end, through the real PoseController on synthetic full-body pose data:
 * the lane changes exactly at the recorded midpoints, the automatic lanes are unchanged, small-room
 * mode is untouched, and a recording replays with the spots it was made with.
 * Spec: docs/superpowers/specs/2026-09-18-lane-spots.md ("Testing").
 */
import { describe, expect, it } from 'vitest';
import { applyLiveSettings } from '../../src/app/liveSettings';
import { LaneSetupSession } from '../../src/app/laneSetupSession';
import { DEFAULT_SETTINGS } from '../../src/app/settings';
import { PoseController } from '../../src/pose/controller';
import { cleanLaneSpots, LaneSpotsStore, spotZones, type LaneSpots } from '../../src/pose/laneSpots';
import type { Lane, PoseEvent, PoseFrame } from '../../src/pose/types';
import { decodePoses, decodeSession, encodeSession, type SessionMeta } from '../../src/telemetry/messages';
import { ramp, Scenario, STAND, type SynthParams } from '../helpers/synth';

const T = STAND.torso;
const SMALL: Partial<SynthParams> = { lowerVisible: false };

/** Hips at `k` torso lengths from where the player calibrated. */
const at = (k: number): Partial<SynthParams> => ({ hipX: STAND.hipX + k * T });

/** A slow walk between offsets (torso lengths), so each frame moves the hips only a little. */
function walk(sc: Scenario, from: number, to: number, ms: number): Scenario {
  return sc.add(ms, (t) => at(from + (to - from) * ramp(t, ms)));
}

/**
 * Calibrate, then walk slowly: centre → right → back → left → back. (A move straight from one side
 * lane to the other in a single frame is `nextLane`'s job and is pinned in its unit tests; a real
 * 30 Hz stream passes through the middle on the way.)
 */
function sweep(c = 0): Scenario {
  const sc = new Scenario(30).hold(2600);
  walk(sc, 0, c, 600).hold(400, at(c));
  walk(sc, c, 0.9, 5000);
  walk(sc, 0.9, c, 5000);
  walk(sc, c, -1.1, 5000);
  walk(sc, -1.1, c, 5000);
  return sc.hold(500, at(c));
}

interface Change {
  from: Lane;
  to: Lane;
  /** The offset on the frame before the change, and on the frame it happened. */
  before: number;
  after: number;
}

/** Feeds every frame, recording each lane change with the offsets either side of it. */
function play(ctrl: PoseController, frames: readonly PoseFrame[]): { changes: Change[]; events: PoseEvent[]; lanes: Lane[]; offsets: number[] } {
  const changes: Change[] = [];
  const events: PoseEvent[] = [];
  const lanes: Lane[] = [];
  const offsets: number[] = [];
  let prevOffset = Number.NaN;
  for (const f of frames) {
    const lane = ctrl.status.lane;
    const ev = ctrl.update(f);
    events.push(...ev);
    const offset = ctrl.magnitudes.lane;
    if (ctrl.baseline) {
      lanes.push(ctrl.status.lane);
      offsets.push(offset);
      for (const e of ev) if (e.type === 'lane') changes.push({ from: lane, to: e.lane, before: prevOffset, after: offset });
    }
    prevOffset = offset;
  }
  return { changes, events, lanes, offsets };
}

/** The change `from → to` crossed `point` on the way (direction-aware), exactly between two frames. */
function expectCrossing(changes: Change[], from: Lane, to: Lane, point: number): void {
  const c = changes.find((x) => x.from === from && x.to === to);
  expect(c, `${from} → ${to}`).toBeDefined();
  const lo = Math.min(c!.before, c!.after);
  const hi = Math.max(c!.before, c!.after);
  expect(point, `${from} → ${to} crossed ${point} between ${c!.before} and ${c!.after}`).toBeGreaterThanOrEqual(lo - 1e-9);
  expect(point).toBeLessThanOrEqual(hi + 1e-9);
  // And the frames are close together, so "between two frames" is a tight bound.
  expect(hi - lo).toBeLessThan(0.02);
}

/** `nextLane` exactly as it was before lane spots (the oracle the automatic lanes must match). */
function nextLaneBefore(lane: Lane, offset: number, enter: number, exit: number): Lane {
  if (lane === 0) return offset <= -enter ? -1 : offset >= enter ? 1 : 0;
  if (lane === -1) return offset > -exit ? (offset >= enter ? 1 : 0) : -1;
  return offset < exit ? (offset <= -enter ? -1 : 0) : 1;
}

const SPOTS: LaneSpots = { left: -0.9, centre: 0.1, right: 0.5 };

describe('lane spots through the real PoseController', () => {
  it('with asymmetric spots, the lane changes exactly at the recorded midpoints', () => {
    const ctrl = new PoseController({ forcedMode: 'full', laneSpots: SPOTS });
    const { changes } = play(ctrl, sweep(0.1).frames);
    const bL = (SPOTS.left + SPOTS.centre) / 2; // -0.4
    const bR = (SPOTS.right + SPOTS.centre) / 2; // 0.3
    expectCrossing(changes, 0, 1, bR);
    expectCrossing(changes, 0, -1, bL);
    // Hysteresis: back to the middle 30 % of the way from each boundary to the centre spot.
    expectCrossing(changes, 1, 0, bR - 0.3 * (bR - SPOTS.centre));
    expectCrossing(changes, -1, 0, bL + 0.3 * (SPOTS.centre - bL));
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual(['0>1', '1>0', '0>-1', '-1>0']);
  });

  it('the automatic ±0.5 would have changed lane somewhere else entirely', () => {
    const spots = play(new PoseController({ forcedMode: 'full', laneSpots: SPOTS }), sweep(0.1).frames).changes;
    const auto = play(new PoseController({ forcedMode: 'full' }), sweep(0.1).frames).changes;
    const first = (cs: Change[]) => cs.find((c) => c.from === 0 && c.to === 1)!.after;
    expect(first(spots)).toBeLessThan(0.32);
    expect(first(auto)).toBeGreaterThan(0.49);
  });

  it('sensitivity divides each boundary’s distance from the centre spot', () => {
    const ctrl = new PoseController({ forcedMode: 'full', laneSpots: SPOTS, sensitivity: 1.25 });
    const { changes } = play(ctrl, sweep(0.1).frames);
    const z = spotZones(SPOTS, 1.25);
    expectCrossing(changes, 0, 1, z.enterR);
    expectCrossing(changes, 0, -1, z.enterL);
    expectCrossing(changes, 1, 0, z.exitR);
    expect(z.enterR).toBeCloseTo(0.1 + 0.2 / 1.25, 12);
  });

  it('spots can be switched on and off live, mid-stream', () => {
    const ctrl = new PoseController({ forcedMode: 'full' });
    const frames = new Scenario(30).hold(2600).hold(600, at(0.4)).frames;
    play(ctrl, frames);
    expect(ctrl.status.lane).toBe(0); // 0.4 is inside the automatic ±0.5
    ctrl.laneSpots = SPOTS;
    play(ctrl, new Scenario(30).hold(300, at(0.4)).frames.map((f) => ({ ...f, t: f.t + 3200 })));
    expect(ctrl.status.lane).toBe(1); // past the 0.3 midpoint
  });

  it('refuses spots the setup could never have recorded, keeping the automatic lanes', () => {
    const ctrl = new PoseController({ forcedMode: 'full' });
    ctrl.laneSpots = { left: 0.5, centre: 0, right: -0.5 };
    expect(ctrl.laneSpots).toBeNull();
    ctrl.laneSpots = { left: -0.1, centre: 0, right: 0.5 };
    expect(ctrl.laneSpots).toBeNull();
    ctrl.laneSpots = { left: Number.NaN, centre: 0, right: 0.5 };
    expect(ctrl.laneSpots).toBeNull();
  });
});

describe('Automatic is exactly the game as it was', () => {
  it.each([1, 0.75, 1.25])('every frame at sensitivity %f takes the lane the old nextLane would', (sens) => {
    const ctrl = new PoseController({ forcedMode: 'full', sensitivity: sens });
    expect(ctrl.laneSpots).toBeNull();
    const { lanes, offsets, changes } = play(ctrl, sweep(0).frames);
    let lane: Lane = 0;
    const expected = offsets.map((o) => (lane = nextLaneBefore(lane, o, 0.5 / sens, 0.35 / sens)));
    expect(lanes).toEqual(expected);
    expect(changes.length).toBe(4);
  });

  it('turning spots off again restores it', () => {
    const ctrl = new PoseController({ forcedMode: 'full', laneSpots: SPOTS });
    ctrl.laneSpots = null;
    const { lanes, offsets } = play(ctrl, sweep(0).frames);
    let lane: Lane = 0;
    expect(lanes).toEqual(offsets.map((o) => (lane = nextLaneBefore(lane, o, 0.5, 0.35))));
  });
});

describe('small-room mode is untouched by spots', () => {
  /** Calibrate, then lean left and right and shift the head, twice over. */
  function leans(): Scenario {
    const sc = new Scenario(30).hold(2600, SMALL);
    for (let i = 0; i < 2; i++) {
      for (const dir of [-1, 1] as const) {
        sc.add(300, (t) => ({ ...SMALL, tiltDeg: dir * 22 * ramp(t, 300) }))
          .hold(400, { ...SMALL, tiltDeg: dir * 22 })
          .add(300, (t) => ({ ...SMALL, tiltDeg: dir * 22 * (1 - ramp(t, 300)) }))
          .hold(700, SMALL);
      }
      // Walking sideways, which would change a full-body lane, does nothing here.
      sc.add(1500, (t) => ({ ...SMALL, ...at(0.8 * ramp(t, 1500)) })).hold(600, { ...SMALL, ...at(0.8) });
    }
    return sc;
  }

  it('produces exactly the same events with spots set as without', () => {
    const frames = leans().frames;
    const plain = play(new PoseController({ forcedMode: 'small' }), frames).events;
    const spotted = play(new PoseController({ forcedMode: 'small', laneSpots: SPOTS }), frames).events;
    expect(spotted).toEqual(plain);
    expect(plain.filter((e) => e.type === 'laneShift').length).toBeGreaterThanOrEqual(4);
    expect(plain.some((e) => e.type === 'lane')).toBe(false);
  });
});

describe('from the setup to the game', () => {
  it('spots recorded by the setup, saved and put in force, decide the lanes at their own midpoints', () => {
    const ctrl = new PoseController({ forcedMode: 'full' });
    const store = new LaneSpotsStore(null);
    let done = false;
    const session = new LaneSetupSession({ store, now: () => 1, onDone: () => (done = true) });

    // Calibrate, open the setup, and stand on three spots in turn (with a walk between each). The
    // walk starts straight after calibrating: standing still a second longer would take the
    // calibrated spot as the centre, which is right, but not what this test is after.
    const sc = new Scenario(30).hold(2100);
    const stand = (from: number, to: number) => walk(sc, from, to, 600).hold(2000, at(to));
    stand(0, 0.15);
    stand(0.15, -0.55);
    stand(-0.55, 0.95);
    let begun = false;
    for (const f of sc.frames) {
      ctrl.update(f);
      if (ctrl.baseline && !begun) {
        session.begin();
        begun = true;
      }
      session.frame(ctrl, f.t);
    }
    const result = session.model!.result;
    expect(result, 'the setup did not finish').not.toBeNull();
    expect(result!.centre).toBeCloseTo(0.15, 2);
    expect(result!.left).toBeCloseTo(-0.55, 2);
    expect(result!.right).toBeCloseTo(0.95, 2);
    session.handlers.save();
    expect(done).toBe(true);

    // Lanes: My spots, the way the page applies a settings change.
    const saved = store.get()!;
    applyLiveSettings(
      { controller: ctrl, game: { options: { difficulty: 'cardio' } }, world: { setLine() {}, setReduced() {} }, pip: { setMirror() {} }, laneSpots: saved },
      { ...DEFAULT_SETTINGS, lanes: 'spots' },
    );
    expect(ctrl.laneSpots).toEqual({ left: saved.left, centre: saved.centre, right: saved.right });

    const t0 = sc.t;
    const run = new Scenario(30);
    walk(run, 0.95, saved.centre, 400).hold(600, at(saved.centre));
    walk(run, saved.centre, 1.0, 5000);
    walk(run, 1.0, -0.9, 8000);
    const { changes } = play(ctrl, run.frames.map((f) => ({ ...f, t: f.t + t0 })));
    expectCrossing(changes, 0, 1, (saved.right + saved.centre) / 2);
    expectCrossing(changes, 0, -1, (saved.left + saved.centre) / 2);
  });
});

describe('a recorded session replays with its spots', () => {
  function recording(laneSpots: unknown): ReturnType<typeof decodeSession> {
    const frames = sweep(0.1).frames;
    const meta = { seed: 1, difficulty: 'cardio', input: 'webcam', mode: 'full', sensitivity: 1, thresholds: {}, laneSpots } as SessionMeta;
    const rec = encodeSession({ note: '', createdAt: 'x', meta, backend: null, startT: 0, endT: frames.at(-1)!.t, frames, events: [], status: [], game: [] });
    return decodeSession(JSON.parse(JSON.stringify(rec)));
  }

  /** The replay's controller, built the way main.ts builds it from a recording's meta. */
  function replay(rec: ReturnType<typeof decodeSession>): Change[] {
    const ctrl = new PoseController({ forcedMode: 'full', laneSpots: rec.meta ? cleanLaneSpots(rec.meta.laneSpots) : null });
    return play(ctrl, rec.frames.map((f) => ({ t: f.t, aspect: rec.aspect, poses: decodePoses(f.poses) }))).changes;
  }

  it('changes lane at the recorded spots’ midpoints', () => {
    const changes = replay(recording(SPOTS));
    expectCrossing(changes, 0, 1, 0.3);
    expectCrossing(changes, 0, -1, -0.4);
  });

  it('a recording without spots (or with broken ones) replays with the automatic lanes', () => {
    for (const spots of [undefined, null, { left: 3, centre: 0, right: -3 }]) {
      const changes = replay(recording(spots));
      expectCrossing(changes, 0, 1, 0.5);
      expectCrossing(changes, 0, -1, -0.5);
    }
  });
});
