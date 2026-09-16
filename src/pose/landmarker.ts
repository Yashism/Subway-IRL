import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export type ModelVariant = 'full' | 'lite';

export interface LandmarkerConfig {
  variant: ModelVariant;
  delegate: 'GPU' | 'CPU';
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /** Load the ES-module wasm loader (needed inside module workers). */
  useModule?: boolean;
}

const base = () => `${self.location.origin}${import.meta.env.BASE_URL}mediapipe`;

export async function createLandmarker(cfg: LandmarkerConfig): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(`${base()}/wasm`, cfg.useModule);
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: `${base()}/models/pose_landmarker_${cfg.variant}.task`,
      delegate: cfg.delegate,
    },
    canvas: cfg.canvas,
    runningMode: 'VIDEO',
    numPoses: 2,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}
