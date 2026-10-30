import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export type ModelVariant = 'full' | 'lite';

export interface LandmarkerConfig {
  variant: ModelVariant;
  delegate: 'GPU' | 'CPU';
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  /** Load the ES-module wasm loader (needed inside module workers). */
  useModule?: boolean;
  /**
   * How many people to track. One by default: with a single pose the model follows the player from
   * frame to frame instead of running its person detector on every frame, which is the single
   * largest saving in the whole pipeline.
   */
  numPoses?: number;
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
    numPoses: cfg.numPoses ?? 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

/**
 * Pulls the pose model and its WebAssembly into the browser cache ahead of time, at low priority,
 * so that "Use webcam" does not wait on ~20 MB of download. Safe to call more than once and never
 * throws: a failed warm-up only means the real load fetches the files itself.
 */
let warmed = false;
export function warmPoseAssets(variant: ModelVariant = 'full'): void {
  if (warmed || typeof fetch !== 'function') return;
  warmed = true;
  const root = base();
  const urls = [
    `${root}/models/pose_landmarker_${variant}.task`,
    `${root}/wasm/vision_wasm_module_internal.js`,
    `${root}/wasm/vision_wasm_module_internal.wasm`,
  ];
  // One after another: three parallel downloads would compete with the game's own start-up.
  void urls.reduce(
    (chain, url) =>
      chain.then(() =>
        fetch(url, { priority: 'low' } as RequestInit).then(
          (r) => r.arrayBuffer().then(() => undefined),
          () => undefined,
        ),
      ),
    Promise.resolve(),
  );
}
