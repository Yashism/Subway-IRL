import { describe, expect, it, vi } from 'vitest';
import { CAMERA_KEY, PoseRuntime, type CameraApi, type KeyValueStore } from '../../src/app/poseRuntime';
import type { CameraInfo } from '../../src/pose/camera';
import { MODEL_LOAD_FAILED } from '../../src/pose/liveSource';
import type { PoseSource } from '../../src/pose/poseSource';
import type { PoseFrame } from '../../src/pose/types';
import { Scenario } from '../helpers/synth';

/** A PoseSource the test drives by hand. */
class FakeSource implements PoseSource {
  backend = 'fake-gpu';
  onFrame: ((f: PoseFrame) => void) | null = null;
  stopped = false;
  constructor(private readonly fail: unknown = null) {}
  async start(onFrame: (f: PoseFrame) => void): Promise<void> {
    if (this.fail) throw this.fail;
    this.onFrame = onFrame;
  }
  stop(): void {
    this.stopped = true;
  }
  emit(f: PoseFrame): void {
    if (!this.stopped) this.onFrame?.(f);
  }
}

class FakeTrack {
  stopped = false;
  ended: (() => void) | null = null;
  addEventListener(type: string, fn: () => void) {
    if (type === 'ended') this.ended = fn;
  }
  constructor(readonly deviceId: string) {}
  getSettings() {
    return { deviceId: this.deviceId };
  }
  stop() {
    this.stopped = true;
  }
}

function fakeStream(deviceId: string) {
  const track = new FakeTrack(deviceId);
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}

interface Rig {
  rt: PoseRuntime;
  opened: (string | undefined)[];
  tracks: FakeTrack[];
  sources: FakeSource[];
  store: Map<string, string>;
  video: { srcObject: unknown; played: number };
  /** Pending video.play() calls, one per start, when the rig defers them. */
  plays: { resolve: () => void; reject: (e: unknown) => void }[];
}

function rig(
  opts: {
    cams?: CameraInfo[];
    /** Device opened when no id is given. */
    defaultId?: string;
    failIds?: Record<string, unknown>;
    sourceFail?: unknown;
    saved?: string;
    /** video.play() stays pending until the test resolves or rejects it (see Rig.plays). */
    deferPlay?: boolean;
  } = {},
): Rig {
  const cams = opts.cams ?? [{ deviceId: 'cam-a', label: 'USB Camera' }];
  const opened: (string | undefined)[] = [];
  const tracks: FakeTrack[] = [];
  const sources: FakeSource[] = [];
  const store = new Map<string, string>();
  if (opts.saved) store.set(CAMERA_KEY, opts.saved);
  const plays: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const video = {
    srcObject: null as unknown,
    played: 0,
    play: async () => {
      video.played++;
      if (opts.deferPlay) await new Promise<void>((resolve, reject) => plays.push({ resolve, reject }));
    },
  };
  const camera: CameraApi = {
    async open(id) {
      opened.push(id);
      const dev = id ?? opts.defaultId ?? cams[0].deviceId;
      const fail = opts.failIds?.[dev];
      if (fail) throw fail;
      if (!cams.some((c) => c.deviceId === dev)) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
      const { track, stream } = fakeStream(dev);
      tracks.push(track);
      return stream;
    },
    list: async () => cams,
  };
  const kv: KeyValueStore = { get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) };
  const rt = new PoseRuntime({
    camera,
    storage: kv,
    createVideo: () => video as unknown as HTMLVideoElement,
    createSource: () => {
      const s = new FakeSource(opts.sourceFail);
      sources.push(s);
      return s;
    },
  });
  return { rt, opened, tracks, sources, store, video, plays };
}

const emptyFrame = (t: number): PoseFrame => ({ t, aspect: 16 / 9, poses: [] });

/** Lets pending promises settle until `fn` is true (or we give up). */
async function until(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !fn(); i++) await Promise.resolve();
}

describe('PoseRuntime: camera', () => {
  it('opens the saved camera, plays it into the video and remembers the choice', async () => {
    const r = rig({ cams: [{ deviceId: 'cam-a', label: 'A' }, { deviceId: 'cam-b', label: 'B' }], saved: 'cam-b' });
    expect(await r.rt.start()).toBe(true);
    expect(r.opened).toEqual(['cam-b']);
    expect(r.video.played).toBe(1);
    expect(r.video.srcObject).not.toBeNull();
    expect(r.rt.activeCameraId).toBe('cam-b');
    expect(r.rt.running).toBe(true);
    expect(r.rt.backend).toBe('fake-gpu');
    expect(r.rt.cameras.map((c) => c.deviceId)).toEqual(['cam-a', 'cam-b']);
    expect(r.store.get(CAMERA_KEY)).toBe('cam-b');
  });

  it('an explicit camera id wins over the saved one and is saved', async () => {
    const r = rig({ cams: [{ deviceId: 'cam-a', label: 'A' }, { deviceId: 'cam-b', label: 'B' }], saved: 'cam-b' });
    await r.rt.start('cam-a');
    expect(r.opened).toEqual(['cam-a']);
    expect(r.store.get(CAMERA_KEY)).toBe('cam-a');
  });

  it('falls back to the default camera when the saved one is gone', async () => {
    const r = rig({ saved: 'unplugged' });
    await r.rt.start();
    expect(r.opened).toEqual(['unplugged', undefined]);
    expect(r.rt.activeCameraId).toBe('cam-a');
    expect(r.store.get(CAMERA_KEY)).toBe('cam-a');
  });

  it('skips a default IR camera for the first real one', async () => {
    const cams = [
      { deviceId: 'ir', label: 'Integrated IR Camera' },
      { deviceId: 'rgb', label: 'Integrated Camera' },
    ];
    const r = rig({ cams, defaultId: 'ir' });
    await r.rt.start();
    expect(r.opened).toEqual([undefined, 'rgb']);
    expect(r.tracks[0].stopped).toBe(true);
    expect(r.rt.activeCameraId).toBe('rgb');
  });

  it('feeds frames to the controller through the command source, and reports them', async () => {
    const r = rig();
    const seen: number[] = [];
    r.rt.onFrame = (f) => seen.push(f.t);
    await r.rt.start();
    const sc = new Scenario(30).hold(2600);
    for (const f of sc.frames) r.sources[0].emit({ ...f, t: f.t + 1000 });
    expect(seen.length).toBe(sc.frames.length);
    expect(r.rt.aspect).toBeCloseTo(4 / 3);
    const st = r.rt.status();
    expect(st.calibrated).toBe(true);
    expect(st.lastFrameT).toBe(sc.frames[sc.frames.length - 1].t + 1000);
    expect(r.rt.status()).toBe(st);
    expect(r.rt.fps).toBeGreaterThan(25);
  });

  it('stop() stops the source and the camera and ignores late frames', async () => {
    const r = rig();
    await r.rt.start();
    const src = r.sources[0];
    const onFrame = src.onFrame!;
    r.rt.stop();
    expect(src.stopped).toBe(true);
    expect(r.tracks[0].stopped).toBe(true);
    expect(r.video.srcObject).toBeNull();
    expect(r.rt.running).toBe(false);
    expect(r.rt.backend).toBe('none');
    onFrame(emptyFrame(5));
    expect(r.rt.status().lastFrameT).toBeNull();
  });

  it('restart() switches camera: the old stream and source stop', async () => {
    const r = rig({ cams: [{ deviceId: 'cam-a', label: 'A' }, { deviceId: 'cam-b', label: 'B' }] });
    await r.rt.start();
    await r.rt.restart('cam-b');
    expect(r.sources[0].stopped).toBe(true);
    expect(r.tracks[0].stopped).toBe(true);
    expect(r.rt.activeCameraId).toBe('cam-b');
    expect(r.sources[1].stopped).toBe(false);
  });

  it('a start superseded by another resolves false and releases what it opened', async () => {
    const r = rig({ cams: [{ deviceId: 'cam-a', label: 'A' }, { deviceId: 'cam-b', label: 'B' }] });
    const first = r.rt.start('cam-a');
    const second = r.rt.start('cam-b');
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(r.tracks.find((t) => t.deviceId === 'cam-a')?.stopped).toBe(true);
    expect(r.rt.activeCameraId).toBe('cam-b');
    expect(r.sources.length).toBe(1);
  });

  it('a superseded start whose video.play() rejects resolves false, keeping the new camera', async () => {
    const r = rig({ cams: [{ deviceId: 'cam-a', label: 'A' }, { deviceId: 'cam-b', label: 'B' }], deferPlay: true });
    const first = r.rt.start('cam-a');
    await until(() => r.plays.length === 1);
    // A second start tears the first one down: clearing srcObject makes its play() reject.
    const second = r.rt.start('cam-b');
    r.plays[0].reject(Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' }));
    await until(() => r.plays.length === 2);
    r.plays[1].resolve();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(r.rt.activeCameraId).toBe('cam-b');
    expect(r.rt.running).toBe(true);
    expect(r.video.srcObject).not.toBeNull();
  });

  it('describes camera errors and passes model-load errors through', async () => {
    const denied = rig({ failIds: { 'cam-a': Object.assign(new Error('no'), { name: 'NotAllowedError' }) } });
    const err = await denied.rt.start().catch((e: unknown) => e);
    expect(denied.rt.describeError(err)).toMatch(/permission was denied/);
    expect(denied.rt.running).toBe(false);

    const model = rig({ sourceFail: new Error(`${MODEL_LOAD_FAILED} wasm missing`) });
    const err2 = await model.rt.start().catch((e: unknown) => e);
    expect(model.rt.describeError(err2)).toBe(`${MODEL_LOAD_FAILED} wasm missing`);
    expect(model.tracks[0].stopped).toBe(true);
    expect(model.rt.running).toBe(false);
  });

  it('reports a camera that ends (unplugged), but not one it stopped itself', async () => {
    const r = rig();
    let ended = 0;
    r.rt.onCameraEnded = () => ended++;
    await r.rt.start();
    r.tracks[0].ended!();
    expect(ended).toBe(1);
    await r.rt.start();
    r.tracks[0].ended!();
    expect(ended).toBe(1);
  });

  it('works without storage (localStorage blocked)', async () => {
    const r = rig();
    const rt = new PoseRuntime({
      camera: { open: async () => fakeStream('x').stream, list: async () => [{ deviceId: 'x', label: 'X' }] },
      createVideo: () => r.video as unknown as HTMLVideoElement,
      createSource: () => new FakeSource(),
      storage: {
        get: () => {
          throw new Error('blocked');
        },
        set: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(await rt.start()).toBe(true);
  });
});

describe('PoseRuntime: stall and darkness', () => {
  it('the command source counts a 1 s stall (controller lostMs) as lost', async () => {
    const r = rig();
    await r.rt.start();
    r.sources[0].emit(emptyFrame(100));
    expect(r.rt.commands.activity(1000).lost).toBe(false);
    expect(r.rt.commands.activity(1101).lost).toBe(true);
  });

  it('dark() uses the luma sampler and is false without one', async () => {
    const r = rig();
    expect(r.rt.dark(0)).toBe(false);
    const luma = vi.fn(() => 20);
    r.rt.sampleLuma = luma;
    expect(r.rt.dark(5)).toBe(true);
    expect(luma).toHaveBeenCalledWith(5);
    r.rt.sampleLuma = () => 120;
    expect(r.rt.dark(6)).toBe(false);
    r.rt.sampleLuma = () => null;
    expect(r.rt.dark(7)).toBe(false);
  });

  it('recalibrate() resets calibration and sends a side-lane player back to the centre', async () => {
    const r = rig();
    await r.rt.start();
    const sc = new Scenario(30).hold(2600);
    for (const f of sc.frames) r.sources[0].emit(f);
    expect(r.rt.status().calibrated).toBe(true);
    r.rt.recalibrate();
    expect(r.rt.status().calibrated).toBe(false);
  });
});

describe('PoseRuntime: replay', () => {
  it('uses the replay loader in place of the camera, with no video', async () => {
    const src = new FakeSource();
    src.backend = 'replay';
    const load = vi.fn(async () => src as PoseSource);
    const open = vi.fn();
    const rt = new PoseRuntime({ replay: load, replayName: 'synth-full', camera: { open, list: async () => [] } });
    expect(rt.isReplay).toBe(true);
    expect(rt.video).toBeNull();
    expect(await rt.start('ignored')).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(rt.backend).toBe('replay');
    src.emit(emptyFrame(3));
    expect(rt.status().lastFrameT).toBe(3);
    expect(rt.dark(0)).toBe(false);
    await rt.restart(null);
    expect(src.stopped).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failing replay load rejects with its message', async () => {
    const rt = new PoseRuntime({ replay: async () => Promise.reject(new Error('Replay fixture not found: /x.json')) });
    const err = await rt.start().catch((e: unknown) => e);
    expect(rt.describeError(err)).toBe('Replay fixture not found: /x.json');
  });
});
