import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { createLandmarker, type ModelVariant } from './landmarker';
import { mirrorPoses } from './mirror';
import type { Pose } from './types';

export type WorkerIn = { type: 'init'; variant: ModelVariant; numPoses?: number } | { type: 'frame'; bitmap: ImageBitmap; t: number };
export type WorkerOut =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'result'; t: number; aspect: number; poses: Pose[] };

const ctx = self as unknown as {
  postMessage(msg: WorkerOut): void;
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
};

let landmarker: PoseLandmarker | null = null;

ctx.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      landmarker?.close();
      landmarker = null;
      landmarker = await createLandmarker({
        variant: msg.variant,
        numPoses: msg.numPoses,
        delegate: 'GPU',
        canvas: new OffscreenCanvas(1, 1),
        useModule: true,
      });
      ctx.postMessage({ type: 'ready' });
    } catch (err) {
      ctx.postMessage({ type: 'error', message: String(err) });
    }
    return;
  }

  const { bitmap, t } = msg;
  try {
    if (!landmarker) return;
    const result = landmarker.detectForVideo(bitmap, t);
    ctx.postMessage({ type: 'result', t, aspect: bitmap.width / bitmap.height, poses: mirrorPoses(result.landmarks) });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: String(err) });
  } finally {
    bitmap.close();
  }
};
