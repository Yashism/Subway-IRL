import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLandmarker } from '../../src/pose/landmarker';
import { LivePoseSource } from '../../src/pose/liveSource';
import type { WorkerIn, WorkerOut } from '../../src/pose/pose.worker';

vi.mock('../../src/pose/landmarker', () => ({ createLandmarker: vi.fn() }));
const create = vi.mocked(createLandmarker);

type Landmarker = Awaited<ReturnType<typeof createLandmarker>>;
const model = (detect: () => unknown = () => ({ landmarks: [] })) =>
  ({ detectForVideo: vi.fn(detect), close: vi.fn() }) as unknown as Landmarker;
const failing = () =>
  model(() => {
    throw new Error('detect failed');
  });

function fakeVideo() {
  const video = {
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    cb: null as (() => void) | null,
    requestVideoFrameCallback(cb: () => void) {
      video.cb = cb;
      return 1;
    },
    cancelVideoFrameCallback() {},
    /** Runs the pending frame callback, like the browser would on the next video frame. */
    frame() {
      const cb = video.cb;
      video.cb = null;
      cb?.();
    },
  };
  return video;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
// A huge maxFps disables the frame-rate throttle, so every tick grabs.
const source = (video: ReturnType<typeof fakeVideo>) => new LivePoseSource(video as unknown as HTMLVideoElement, 1e9);

class FakeWorker {
  static instances: FakeWorker[] = [];
  static frameReply: () => WorkerOut = () => ({ type: 'result', t: 0, aspect: 4 / 3, poses: [] });
  onmessage: ((e: { data: WorkerOut }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: WorkerIn) {
    const reply: WorkerOut = msg.type === 'init' ? { type: 'ready' } : FakeWorker.frameReply();
    queueMicrotask(() => this.onmessage?.({ data: reply }));
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  create.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWorker.instances = [];
});

describe('LivePoseSource (main thread; no Worker in node)', () => {
  it('keeps the frame loop alive when a grab throws', async () => {
    create.mockResolvedValue(model());
    const video = fakeVideo();
    await source(video).start(() => {});
    Object.defineProperty(video, 'readyState', {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => video.frame()).toThrow('boom');
    expect(video.cb).not.toBeNull();
  });

  it('isolates exceptions thrown by the frame consumer', async () => {
    create.mockResolvedValue(model());
    const video = fakeVideo();
    const src = source(video);
    await src.start(() => {
      throw new Error('consumer bug');
    });
    expect(() => video.frame()).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('Pose frame consumer threw:', expect.any(Error));
    expect(video.cb).not.toBeNull();
  });

  it('drops a failing GPU model to CPU lite, then to failed', async () => {
    const gpu = failing();
    const cpu = failing();
    create.mockResolvedValueOnce(gpu).mockResolvedValueOnce(cpu);
    const video = fakeVideo();
    const src = source(video);
    await src.start(() => {});
    expect(src.backend).toBe('main-gpu-full');

    video.frame();
    await flush();
    expect(gpu.close).toHaveBeenCalled();
    expect(create).toHaveBeenLastCalledWith({ variant: 'lite', delegate: 'CPU' });
    expect(src.backend).toBe('main-cpu-lite');

    video.frame();
    await flush();
    expect(cpu.close).toHaveBeenCalled();
    expect(src.backend).toBe('failed');
    video.frame();
    expect(cpu.detectForVideo).toHaveBeenCalledTimes(1);
  });

  it('rejects with a model-load error when every backend fails', async () => {
    create.mockRejectedValue(new Error('no wasm'));
    const video = fakeVideo();
    const src = source(video);
    await expect(src.start(() => {})).rejects.toThrow(/^Pose model failed to load: no wasm/);
    expect(src.backend).toBe('failed');
    expect(video.cb).toBeNull();
  });

  it('abandons startup when stopped while a model is loading', async () => {
    let finish!: (m: Landmarker) => void;
    create.mockReturnValue(new Promise((r) => (finish = r)));
    const video = fakeVideo();
    const src = source(video);
    const started = src.start(() => {});
    await flush();
    src.stop();
    const late = model();
    finish(late);
    await expect(started).resolves.toBeUndefined();
    expect(late.close).toHaveBeenCalled();
    expect(src.backend).toBe('none');
    expect(video.cb).toBeNull();
  });
});

describe('LivePoseSource (worker)', () => {
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
  });

  it('falls back to the main thread after 5 worker frame errors in a row', async () => {
    create.mockResolvedValue(model());
    const video = fakeVideo();
    const src = source(video);
    await src.start(() => {});
    expect(src.backend).toBe('worker-gpu-full');

    const replies: WorkerOut[] = [
      ...Array.from({ length: 4 }, () => ({ type: 'error', message: 'bad frame' }) as const),
      { type: 'result', t: 0, aspect: 4 / 3, poses: [] },
      ...Array.from({ length: 4 }, () => ({ type: 'error', message: 'bad frame' }) as const),
    ];
    FakeWorker.frameReply = () => replies.shift() ?? { type: 'error', message: 'bad frame' };
    for (let i = 0; i < 9; i++) {
      video.frame();
      await flush();
    }
    // 4 errors, a success (resets the count), 4 more errors: still on the worker.
    expect(src.backend).toBe('worker-gpu-full');

    video.frame();
    await flush();
    await flush();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(src.backend).toBe('main-gpu-full');
  });

  it('abandons startup when stopped while the worker is initialising', async () => {
    const video = fakeVideo();
    const src = source(video);
    const post = FakeWorker.prototype.postMessage;
    vi.spyOn(FakeWorker.prototype, 'postMessage').mockImplementation(function (this: FakeWorker, msg: WorkerIn) {
      if (msg.type !== 'init') post.call(this, msg); // never answer init
    });
    const started = src.start(() => {});
    src.stop();
    await expect(started).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(video.cb).toBeNull();
  });
});
