import { describeCameraError, isIrCamera, listCameras, openCamera, pickDefaultCamera } from '../pose/camera';
import { PoseController } from '../pose/controller';
import { FixtureRecorder } from '../pose/fixtures';
import { LivePoseSource, MODEL_LOAD_FAILED } from '../pose/liveSource';
import type { PoseSource } from '../pose/poseSource';
import { ReplayPoseSource } from '../pose/replaySource';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../pose/thresholds';
import type { PlayMode, PoseEvent, PoseFrame } from '../pose/types';
import { drawOverlay } from './overlay';

const CAMERA_KEY = 'subway-irl.cameraId';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('overlay');
const stage = $<HTMLElement>('stage');
const banner = $<HTMLDivElement>('banner');
const cameraSel = $<HTMLSelectElement>('camera');
const modeSel = $<HTMLSelectElement>('mode');
const sens = $<HTMLInputElement>('sens');
const sensOut = $<HTMLOutputElement>('sensOut');
const recordBtn = $<HTMLButtonElement>('record');
const statusEl = $<HTMLDListElement>('status');
const logEl = $<HTMLOListElement>('log');
const ctx = canvas.getContext('2d')!;

const ctrl = new PoseController({ thresholds: { ...DEFAULT_THRESHOLDS } });
const recorder = new FixtureRecorder();
let source: PoseSource | null = null;
let aspect = 4 / 3;
let sourceFps = 0;
const frameTimes: number[] = [];

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function showBanner(text: string | null): void {
  banner.hidden = !text;
  banner.textContent = text ?? '';
}

function describe(e: PoseEvent): string {
  if (e.type === 'lane') return `lane → ${['left', 'centre', 'right'][e.lane + 1]}`;
  if (e.type === 'laneShift') return `lane shift ${e.dir < 0 ? '←' : '→'}`;
  return e.type;
}

function log(e: PoseEvent): void {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${describe(e)}`;
  logEl.prepend(li);
  while (logEl.children.length > 50) logEl.lastElementChild!.remove();
}

function onFrame(f: PoseFrame): void {
  aspect = f.aspect;
  const now = performance.now();
  frameTimes.push(now);
  while (now - frameTimes[0] > 2000) frameTimes.shift();
  sourceFps = frameTimes.length / 2;
  recorder.push(f);
  for (const e of ctrl.update(f)) log(e);
}

function renderStatus(): void {
  const s = ctrl.status;
  const rows: [string, string][] = [
    ['Backend', source?.backend ?? '—'],
    ['Pose fps', `${sourceFps.toFixed(0)}`],
    ['Tracking', s.tracking ? `yes (${(s.confidence * 100).toFixed(0)}%)` : 'no'],
    ['Calibrated', s.calibrated ? `yes — ${s.mode === 'full' ? 'full body' : 'small room'}` : `${Math.round(s.calibration.progress * 100)}% (${s.calibration.distance})`],
    ['Lane', ['left', 'centre', 'right'][s.lane + 1]],
    ['Jogging', s.jog.active ? `yes — ${s.jog.cadenceSpm} spm` : 'no'],
    ['Since step', Number.isFinite(s.jog.msSinceStep) ? `${(s.jog.msSinceStep / 1000).toFixed(1)} s` : '—'],
    ['Steps', `${s.jog.steps}`],
    ['Start hold', `${Math.round(s.startProgress * 100)}%`],
    ['Recording', recorder.recording ? `${recorder.count} frames` : 'off'],
  ];
  statusEl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function render(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay(ctx, { width: w, height: h, aspect }, ctrl.status, ctrl.baseline, ctrl.th);
  renderStatus();
  requestAnimationFrame(render);
}

function buildThresholdInputs(): void {
  const box = $<HTMLDivElement>('thresholds');
  for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
    const label = document.createElement('label');
    label.textContent = key;
    label.htmlFor = `th-${key}`;
    const input = document.createElement('input');
    input.id = `th-${key}`;
    input.type = 'number';
    input.step = key.endsWith('Ms') ? '10' : key.endsWith('Deg') ? '1' : '0.01';
    input.value = String(ctrl.th[key]);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) ctrl.th[key] = v;
    });
    box.append(label, input);
  }
}

function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fillCameras(activeId: string | undefined): Promise<void> {
  const cams = await listCameras();
  cameraSel.replaceChildren(
    ...cams.map((c) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = isIrCamera(c.label) ? `${c.label} (IR — not recommended)` : c.label;
      o.selected = c.deviceId === activeId;
      return o;
    }),
  );
}

const stopStream = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());
/** Bumped by every startCamera call, so an older call that is still awaiting can tell it was superseded. */
let startGen = 0;

async function startCamera(deviceId?: string): Promise<void> {
  const gen = ++startGen;
  source?.stop();
  source = null;
  stopStream(video.srcObject as MediaStream | null);
  video.srcObject = null;
  let stream: MediaStream | null = null;
  let live: LivePoseSource | null = null;
  // After every await: if a newer call started, release whatever this call created and give up.
  const superseded = () => {
    if (gen === startGen) return false;
    live?.stop();
    stopStream(stream);
    return true;
  };
  try {
    showBanner('Starting camera…');
    stream = await openCamera(deviceId).catch(() => openCamera());
    if (superseded()) return;
    const cams = await listCameras();
    if (superseded()) return;
    const pick = pickDefaultCamera(cams, deviceId ?? store.get(CAMERA_KEY));
    const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (pick && pick.deviceId !== activeId) {
      stopStream(stream);
      stream = null;
      stream = await openCamera(pick.deviceId);
      if (superseded()) return;
    }
    const finalId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (finalId) store.set(CAMERA_KEY, finalId);
    video.srcObject = stream;
    await video.play();
    if (superseded()) return;
    await fillCameras(finalId);
    if (superseded()) return;
    showBanner('Loading pose model…');
    live = new LivePoseSource(video);
    source = live;
    await live.start(onFrame);
    if (superseded()) return;
    showBanner(null);
  } catch (err) {
    if (superseded()) return;
    const message = err instanceof Error ? err.message : '';
    showBanner(message.startsWith(MODEL_LOAD_FAILED) ? message : describeCameraError(err));
  }
}

async function startReplay(name: string): Promise<void> {
  video.hidden = true;
  cameraSel.disabled = true;
  try {
    const replay = await ReplayPoseSource.load(`/tests/fixtures/${encodeURIComponent(name)}.json`);
    source = replay;
    await replay.start(onFrame);
  } catch (err) {
    showBanner(err instanceof Error ? err.message : String(err));
  }
}

$<HTMLButtonElement>('recalibrate').addEventListener('click', () => ctrl.recalibrate());
modeSel.addEventListener('change', () => {
  ctrl.forcedMode = (modeSel.value || null) as PlayMode | null;
  ctrl.recalibrate();
});
sens.addEventListener('input', () => {
  ctrl.sensitivity = Number(sens.value);
  sensOut.textContent = Number(sens.value).toFixed(2);
});
cameraSel.addEventListener('change', () => void startCamera(cameraSel.value));
recordBtn.addEventListener('click', () => {
  if (!recorder.recording) {
    recorder.start();
    recordBtn.textContent = '■ Stop';
    recordBtn.classList.add('recording');
    return;
  }
  recordBtn.textContent = '● Record';
  recordBtn.classList.remove('recording');
  const name = window.prompt('Fixture name (e.g. full-jog-jump)', 'recording') ?? 'recording';
  const note = window.prompt('What did you do in this recording?', '') ?? '';
  download(name, recorder.stop(name, note));
});

buildThresholdInputs();
requestAnimationFrame(render);
const replay = new URLSearchParams(location.search).get('replay');
void (replay ? startReplay(replay) : startCamera());
