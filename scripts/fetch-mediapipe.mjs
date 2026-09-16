import { access, cp, mkdir, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const outDir = new URL('public/mediapipe/', root);
const MODELS = {
  'pose_landmarker_full.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  'pose_landmarker_lite.task':
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
};

const exists = (u) => access(u).then(() => true, () => false);

await mkdir(new URL('models/', outDir), { recursive: true });
await cp(new URL('node_modules/@mediapipe/tasks-vision/wasm/', root), new URL('wasm/', outDir), { recursive: true });

for (const [name, url] of Object.entries(MODELS)) {
  const dest = new URL(`models/${name}`, outDir);
  if (await exists(dest)) continue;
  console.log(`Downloading ${name}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${name}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}
console.log('MediaPipe assets ready in public/mediapipe/');
