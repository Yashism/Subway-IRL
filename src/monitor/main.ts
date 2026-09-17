import './monitor.css';
import { drawOverlay } from '../debug/overlay';
import type { Baseline } from '../pose/calibration';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../pose/thresholds';
import type { PoseStatus } from '../pose/types';
import {
  CHANNEL_NAME,
  decodeSession,
  HELLO_INTERVAL_MS,
  isGameMessage,
  sessionFileName,
  type ControlMessage,
  type GameSnapshot,
  type HelloMsg,
  type SessionMeta,
  type SessionRecording,
  type WireStatus,
} from '../telemetry/messages';
import { SessionRecorder } from './recorder';
import {
  connection,
  formatRel,
  idleBar,
  initialState,
  isVisible,
  lastAtOrBefore,
  poseStatusOf,
  recordingTimeline,
  reduce,
  stallAge,
  TIMELINE_CAP,
  toPoseStatus,
  viewAt,
  type Filters,
  type LiveFrame,
  type MonitorState,
  type TimelineEntry,
} from './state';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const LANES = ['left', 'centre', 'right'];

// ---- live state -----------------------------------------------------------------------------

let state: MonitorState = initialState();
let dirty = true;
const recorder = new SessionRecorder();
const monitorId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random()).slice(2);
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : null;

function send(msg: HelloMsg | ControlMessage): void {
  channel?.postMessage(msg);
}
const hello = () => send({ kind: 'hello', id: monitorId, recording: recorder.active });

channel?.addEventListener('message', (e: MessageEvent) => {
  const msg: unknown = e.data;
  if (!isGameMessage(msg)) return;
  state = reduce(state, { type: 'message', msg, now: performance.now() });
  recorder.push(msg);
  dirty = true;
});
hello();
setInterval(hello, HELLO_INTERVAL_MS);
window.addEventListener('pagehide', () => channel?.close());

// ---- offline playback -----------------------------------------------------------------------

interface Offline {
  name: string;
  rec: SessionRecording;
  timeline: TimelineEntry[];
  time: number;
  playing: boolean;
  lastTick: number;
}
let offline: Offline | null = null;

// ---- key/value panels -----------------------------------------------------------------------

type Tone = '' | 'ok' | 'warn' | 'bad' | 'dim';

function kvPanel(el: HTMLElement, keys: [id: string, label: string][]) {
  const cells = new Map<string, HTMLElement>();
  for (const [id, label] of keys) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    el.append(dt, dd);
    cells.set(id, dd);
  }
  return (id: string, text: string, tone: Tone = '') => {
    const dd = cells.get(id)!;
    if (dd.textContent !== text) dd.textContent = text;
    if (dd.className !== tone) dd.className = tone;
  };
}

const setPose = kvPanel($('pose'), [
  ['tracking', 'Tracking'],
  ['calibrated', 'Calibrated'],
  ['mode', 'Mode'],
  ['lane', 'Lane'],
  ['fps', 'Pose fps'],
  ['backend', 'Backend'],
  ['jog', 'Jog'],
  ['spm', 'Cadence'],
  ['since', 'Since step'],
  ['steps', 'Steps'],
  ['squat', 'Squatting'],
  ['slow', 'Slow pose'],
  ['stall', 'Stall age'],
  ['start', 'Start hold'],
  ['frames', 'Frames rx'],
]);

const setGame = kvPanel($('game'), [
  ['state', 'State'],
  ['s', 'Distance'],
  ['speed', 'Speed'],
  ['lane', 'Lane'],
  ['y', 'Runner y'],
  ['flags', 'Flags'],
  ['josh', 'Josh'],
  ['powerups', 'Power-ups'],
  ['boards', 'Hoverboards'],
  ['caught', 'Caught'],
  ['score', 'Coins / score'],
  ['time', 'Run time'],
]);

const poseBadge = $('poseBadge');
const gameBadge = $('gameBadge');
const idleFill = $('idleFill');
const idleText = $('idleText');

function badge(el: HTMLElement, text: string, tone: Tone): void {
  el.textContent = text;
  el.className = `chip ${tone}`;
}

const yesNo = (b: boolean) => (b ? 'yes' : 'no');
const ms = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v)} ms`);

function renderPose(st: WireStatus | null, backend: string | null, stall: number | null, frames: string): void {
  if (!st) {
    for (const k of ['tracking', 'calibrated', 'mode', 'lane', 'fps', 'jog', 'spm', 'since', 'steps', 'squat', 'slow', 'stall', 'start']) setPose(k, '—', 'dim');
    setPose('backend', backend ?? '—', 'dim');
    setPose('frames', frames, 'dim');
    badge(poseBadge, 'no status', '');
    return;
  }
  setPose('tracking', st.tracking ? `yes · ${Math.round(st.confidence * 100)}%` : 'no', st.tracking ? 'ok' : 'bad');
  setPose(
    'calibrated',
    st.calibrated ? 'yes' : `no · ${Math.round(st.calibration.progress * 100)}% · ${st.calibration.bodyVisible ? st.calibration.distance : 'no body'}`,
    st.calibrated ? 'ok' : 'warn',
  );
  setPose('mode', st.mode === 'full' ? 'full body' : st.mode === 'small' ? 'small room' : '—');
  setPose('lane', LANES[st.lane + 1]);
  setPose('fps', String(st.poseFps), st.slowPose ? 'bad' : st.poseFps >= 24 ? 'ok' : 'warn');
  setPose('backend', backend ?? '—');
  setPose('jog', st.jog.active ? 'active' : 'idle', st.jog.active ? 'ok' : 'dim');
  setPose('spm', `${st.jog.cadenceSpm} spm`);
  const since = st.jog.msSinceStep;
  setPose('since', ms(since), since === null || !Number.isFinite(since) ? 'dim' : since >= 2000 ? 'bad' : since >= 1000 ? 'warn' : '');
  setPose('steps', String(st.jog.steps));
  setPose('squat', yesNo(st.squatting), st.squatting ? 'warn' : 'dim');
  setPose('slow', yesNo(st.slowPose), st.slowPose ? 'bad' : 'dim');
  setPose('stall', ms(stall), stall !== null && stall >= 1500 ? 'bad' : stall !== null && stall >= 300 ? 'warn' : '');
  setPose('start', `${Math.round(st.startProgress * 100)}%`, st.startProgress > 0 ? 'warn' : 'dim');
  setPose('frames', frames);
  if (!st.tracking) badge(poseBadge, 'not tracking', 'bad');
  else if (!st.calibrated) badge(poseBadge, 'calibrating', 'warn');
  else if (st.slowPose) badge(poseBadge, 'slow', 'bad');
  else badge(poseBadge, st.jog.active ? `jogging ${st.jog.cadenceSpm}` : 'tracking', 'ok');
}

const secs = (v: number) => `${v.toFixed(1)}s`;

function renderGame(g: GameSnapshot | null): void {
  if (!g) {
    for (const k of ['state', 's', 'speed', 'lane', 'y', 'flags', 'josh', 'powerups', 'boards', 'caught', 'score', 'time']) setGame(k, '—', 'dim');
    badge(gameBadge, 'no game data', '');
    idleFill.style.width = '0';
    idleText.textContent = '—';
    return;
  }
  const stateTone: Tone = g.state === 'playing' ? 'ok' : g.state === 'caught' ? 'bad' : g.state === 'paused' ? 'warn' : '';
  const stateText = g.state === 'paused' && g.pausedByLoss ? 'paused (pose lost)' : g.state === 'countdown' ? `countdown ${g.countdown.toFixed(1)}` : g.state;
  setGame('state', stateText, stateTone);
  badge(gameBadge, stateText, stateTone);
  setGame('s', `${g.s.toFixed(1)} m`);
  setGame('speed', `${g.speed.toFixed(2)} m/s`);
  setGame('lane', LANES[g.lane + 1]);
  setGame('y', `${g.y.toFixed(2)} m`);
  const flags = [g.airborne && 'airborne', g.rolling && 'rolling', g.flying && 'flying'].filter(Boolean).join(' · ');
  setGame('flags', flags || 'grounded', flags ? 'warn' : 'dim');
  setGame('josh', `${Math.round(g.josh.value * 100)}%${g.josh.active ? ' · ×2 active' : ''}`, g.josh.active ? 'ok' : '');
  const p = g.powerups;
  const ups = [
    p.magnet > 0 && `magnet ${secs(p.magnet)}`,
    p.rocket > 0 && `rocket ${secs(p.rocket)}`,
    p.chappal > 0 && `chappal ${secs(p.chappal)}`,
    p.hoverboard > 0 && `board ${secs(p.hoverboard)}`,
    p.grace > 0 && `grace ${secs(p.grace)}`,
  ].filter(Boolean);
  setGame('powerups', ups.join(' · ') || 'none', ups.length ? 'ok' : 'dim');
  setGame('boards', `${p.hoverboardsLeft} left`);
  setGame('caught', g.caughtReason ?? '—', g.caughtReason ? 'bad' : 'dim');
  setGame('score', `${g.coins} / ${g.score}`);
  setGame('time', secs(g.time));

  const bar = idleBar(g.idleMs);
  idleFill.style.width = `${(bar.fraction * 100).toFixed(1)}%`;
  idleFill.className = `fill ${bar.level}`;
  idleText.textContent = `${ms(g.idleMs)} · ${bar.level}`;
  idleText.style.color = bar.level === 'ok' ? '' : bar.level === 'warn' ? 'var(--warn)' : 'var(--bad)';
}

// ---- skeleton -------------------------------------------------------------------------------

const canvas = $<HTMLCanvasElement>('skeleton');
const stage = $('stage');
const stageEmpty = $('stageEmpty');
const frameInfo = $('frameInfo');
const ctx = canvas.getContext('2d')!;
let stageAspect = 0;

function thresholdsOf(meta: SessionMeta | null): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...(meta?.thresholds as Partial<Thresholds> | undefined) };
}

function renderSkeleton(frame: LiveFrame | null, st: PoseStatus, base: Baseline | null, meta: SessionMeta | null): void {
  const aspect = frame?.aspect ?? 4 / 3;
  if (aspect !== stageAspect) {
    stageAspect = aspect;
    stage.style.aspectRatio = String(aspect);
  }
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // drawOverlay's text is sized for a full-screen camera view; scale it down to the panel.
  if (!frame) {
    // drawOverlay would print calibration hints for an empty status; there is nothing to show yet.
    ctx.clearRect(0, 0, w, h);
  } else {
    const scale = Math.min(1, Math.max(0.45, w / 1100));
    ctx.save();
    ctx.scale(scale, scale);
    drawOverlay(ctx, { width: w / scale, height: h / scale, aspect }, st, base, thresholdsOf(meta));
    ctx.restore();
  }
  stageEmpty.hidden = frame !== null;
  if (frame && frame.poses.length === 0) {
    stageEmpty.hidden = false;
    stageEmpty.textContent = 'Frame has no person';
  } else stageEmpty.textContent = 'No pose frames yet';
}

// ---- timeline -------------------------------------------------------------------------------

const logEl = $<HTMLOListElement>('log');
const filters: Filters = { pose: true, command: true, game: true, coins: false };
let logPaused = false;
let renderedSeq = 0;
let lastRenderedT: number | null = null;
const KIND_LABEL = { pose: 'POSE', command: 'CMD', game: 'GAME', note: 'NOTE' } as const;

function entryItem(e: TimelineEntry, t0: number | null, prevT: number | null): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `k-${e.kind} t-${e.tone}`;
  const time = document.createElement('time');
  time.textContent = formatRel(e.t, t0);
  const dt = document.createElement('span');
  const delta = prevT === null ? null : e.t - prevT;
  dt.className = delta !== null && delta < 150 ? 'dt close' : 'dt';
  dt.textContent = delta === null ? '' : delta >= 100_000 ? '…' : `+${Math.round(delta)}`;
  const kind = document.createElement('span');
  kind.className = 'kind';
  kind.textContent = KIND_LABEL[e.kind];
  if (e.source) {
    const src = document.createElement('span');
    src.className = `src ${e.source}`;
    src.textContent = e.source === 'keyboard' ? 'kbd' : e.source === 'autopilot' ? 'bot' : 'pose';
    kind.append(src);
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = e.label;
  li.append(time, dt, kind, label);
  return li;
}

function emptyNote(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'log-empty';
  li.textContent = text;
  return li;
}

function rebuildLog(entries: readonly TimelineEntry[], t0: number | null, emptyText: string): void {
  const items: HTMLLIElement[] = [];
  let prev: number | null = null;
  for (const e of entries) {
    if (!isVisible(e, filters)) continue;
    items.push(entryItem(e, t0, prev));
    prev = e.t;
  }
  logEl.replaceChildren(...(items.length ? items : [emptyNote(emptyText)]));
  lastRenderedT = prev;
  logEl.scrollTop = logEl.scrollHeight;
}

function appendLog(entries: readonly TimelineEntry[], t0: number | null): void {
  let added = false;
  for (const e of entries) {
    if (e.seq <= renderedSeq) continue;
    renderedSeq = e.seq;
    if (!isVisible(e, filters)) continue;
    if (!added && logEl.firstElementChild?.classList.contains('log-empty')) logEl.replaceChildren();
    logEl.append(entryItem(e, t0, lastRenderedT));
    lastRenderedT = e.t;
    added = true;
  }
  if (!added) return;
  while (logEl.childElementCount > TIMELINE_CAP) logEl.firstElementChild!.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

function fullLiveRebuild(): void {
  rebuildLog(state.timeline, state.t0, 'No events yet. Play in the game tab.');
  renderedSeq = state.seq;
}

for (const input of document.querySelectorAll<HTMLInputElement>('[data-filter]')) {
  const key = input.dataset.filter as keyof Filters;
  input.checked = filters[key];
  input.addEventListener('change', () => {
    filters[key] = input.checked;
    if (offline) renderOffline(true);
    else fullLiveRebuild();
  });
}
const pauseBtn = $<HTMLButtonElement>('pauseLog');
pauseBtn.addEventListener('click', () => {
  logPaused = !logPaused;
  pauseBtn.setAttribute('aria-pressed', String(logPaused));
  pauseBtn.textContent = logPaused ? 'Resume' : 'Pause';
  if (!logPaused && !offline) appendLog(state.timeline, state.t0);
});
$('clearLog').addEventListener('click', () => {
  state = { ...state, timeline: [] };
  if (!offline) fullLiveRebuild();
});

// ---- controls -------------------------------------------------------------------------------

const sens = $<HTMLInputElement>('sens');
const sensOut = $<HTMLOutputElement>('sensOut');
const modeSel = $<HTMLSelectElement>('mode');
const recalBtn = $<HTMLButtonElement>('recalibrate');
const thBox = $('thresholds');
const thChanged = $('thChanged');
const thInputs = new Map<string, HTMLInputElement>();
let lastMeta: SessionMeta | null = null;

sens.addEventListener('input', () => {
  sensOut.textContent = Number(sens.value).toFixed(2);
  send({ kind: 'setSensitivity', value: Number(sens.value) });
});
modeSel.addEventListener('change', () => {
  const v = modeSel.value;
  send({ kind: 'forceMode', mode: v === 'full' || v === 'small' ? v : null });
});
recalBtn.addEventListener('click', () => send({ kind: 'recalibrate' }));

for (const key of Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[]) {
  const label = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = key;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = key.endsWith('Ms') ? '10' : key.endsWith('Deg') ? '1' : '0.01';
  input.value = String(DEFAULT_THRESHOLDS[key]);
  input.title = `default ${DEFAULT_THRESHOLDS[key]}`;
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (input.value !== '' && Number.isFinite(v)) send({ kind: 'setThreshold', key, value: v });
  });
  label.append(name, input);
  thBox.append(label);
  thInputs.set(key, input);
}

function syncControls(meta: SessionMeta | null, enabled: boolean): void {
  for (const el of [sens, modeSel, recalBtn, ...thInputs.values()]) el.disabled = !enabled;
  $('controlsNote').textContent = enabled ? 'act on the game tab' : offline ? 'read-only in playback' : 'connect a game tab to use';
  if (!meta || meta === lastMeta) return;
  lastMeta = meta;
  if (document.activeElement !== sens) {
    sens.value = String(meta.sensitivity);
    sensOut.textContent = meta.sensitivity.toFixed(2);
  }
  if (document.activeElement !== modeSel) modeSel.value = meta.mode === 'full' || meta.mode === 'small' ? meta.mode : '';
  let changed = 0;
  for (const [key, input] of thInputs) {
    const v = meta.thresholds[key];
    if (v === undefined) continue;
    if (document.activeElement !== input) input.value = String(v);
    const differs = v !== DEFAULT_THRESHOLDS[key as keyof Thresholds];
    input.parentElement!.classList.toggle('changed', differs);
    if (differs) changed++;
  }
  thChanged.textContent = changed ? `· ${changed} changed` : '';
}

// ---- recording ------------------------------------------------------------------------------

const recordBtn = $<HTMLButtonElement>('record');
const recordLabel = $('recordLabel');
const recInfo = $('recInfo');
const noteDlg = $<HTMLDialogElement>('noteDlg');
const noteText = $<HTMLTextAreaElement>('noteText');
const noteSummary = $('noteSummary');
const viewLast = $<HTMLButtonElement>('viewLast');
let pending: SessionRecording | null = null;
let lastSaved: { name: string; rec: SessionRecording } | null = null;
let savedName = '';

const clock = (msv: number) => {
  const s = Math.max(0, msv) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

recordBtn.addEventListener('click', () => {
  if (!recorder.active) {
    recorder.start({ meta: state.meta, backend: state.backend });
    savedName = '';
    hello();
  } else {
    pending = recorder.stop('', new Date().toISOString());
    hello();
    noteSummary.textContent = `${clock(pending.durationMs)} · ${pending.frames.length} frames · ${pending.events.length} events`;
    noteText.value = '';
    noteDlg.showModal();
  }
  renderRecording();
});

noteDlg.addEventListener('close', () => {
  const rec = pending;
  pending = null;
  if (!rec || noteDlg.returnValue !== 'save') {
    savedName = rec ? 'discarded' : '';
    renderRecording();
    return;
  }
  rec.note = noteText.value.trim();
  const name = sessionFileName(rec.createdAt);
  const url = URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  savedName = `saved ${name}`;
  lastSaved = { name, rec };
  renderRecording();
});

function renderRecording(): void {
  const on = recorder.active;
  recordBtn.setAttribute('aria-pressed', String(on));
  recordLabel.textContent = on ? 'Stop' : 'Record session';
  recInfo.classList.toggle('live', on);
  recInfo.textContent = on
    ? `${clock(recorder.durationMs)} · ${recorder.frameCount} frames · ${recorder.eventCount} ev${state.fullRate ? '' : ' · waiting for full rate'}`
    : savedName;
  viewLast.hidden = on || !lastSaved || savedName === 'discarded';
}
viewLast.addEventListener('click', () => {
  if (lastSaved) openRecording(lastSaved.name, lastSaved.rec);
});

// ---- loading a recording --------------------------------------------------------------------

const flash = $('flash');
const offlineBar = $('offline');
const scrub = $<HTMLInputElement>('scrub');
const scrubOut = $<HTMLOutputElement>('scrubOut');
const playBtn = $<HTMLButtonElement>('play');
let flashTimer = 0;
let lastOfflineKey = '';

function showFlash(text: string): void {
  flash.textContent = text;
  flash.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (flash.hidden = true), 8000);
}

$<HTMLInputElement>('load').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    openRecording(file.name, decodeSession(JSON.parse(await file.text())));
  } catch (err) {
    showFlash(`Could not load ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
});

function openRecording(name: string, rec: SessionRecording): void {
  offline = { name, rec, timeline: recordingTimeline(rec), time: 0, playing: false, lastTick: 0 };
  offlineBar.hidden = false;
  $('offName').textContent = name;
  $('offName').title = name;
  const m = rec.meta;
  const bits = [
    m ? `seed ${m.seed} · ${m.difficulty} · input ${m.input} · mode ${m.mode ?? 'auto'} · sens ${m.sensitivity}` : 'no meta',
    rec.backend ? `backend ${rec.backend}` : '',
    rec.createdAt,
  ].filter(Boolean);
  $('offNote').textContent = `${rec.note ? `“${rec.note}” — ` : ''}${bits.join(' · ')}`;
  scrub.max = String(Math.max(0, Math.ceil(rec.durationMs)));
  scrub.value = '0';
  lastOfflineKey = '';
  renderOffline(true);
}

function setTime(t: number): void {
  if (!offline) return;
  offline.time = Math.min(Math.max(0, t), offline.rec.durationMs);
  scrub.value = String(Math.round(offline.time));
  renderOffline(false);
}

function setPlaying(on: boolean): void {
  if (!offline) return;
  offline.playing = on;
  offline.lastTick = performance.now();
  playBtn.textContent = on ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
}

scrub.addEventListener('input', () => {
  setPlaying(false);
  setTime(Number(scrub.value));
});
playBtn.addEventListener('click', () => {
  if (!offline) return;
  if (!offline.playing && offline.time >= offline.rec.durationMs) setTime(0);
  setPlaying(!offline.playing);
});
function stepFrame(dir: -1 | 1): void {
  if (!offline) return;
  setPlaying(false);
  const frames = offline.rec.frames;
  const i = lastAtOrBefore(frames, offline.time);
  const j = Math.min(frames.length - 1, Math.max(0, dir < 0 ? (frames[i]?.t === offline.time ? i - 1 : i) : i + 1));
  if (frames[j]) setTime(frames[j].t);
}
$('prevFrame').addEventListener('click', () => stepFrame(-1));
$('nextFrame').addEventListener('click', () => stepFrame(1));
$('backLive').addEventListener('click', () => {
  offline = null;
  offlineBar.hidden = true;
  fullLiveRebuild();
  dirty = true;
});
window.addEventListener('keydown', (e) => {
  if (!offline || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === ' ') {
    e.preventDefault();
    playBtn.click();
  } else if (e.key === 'ArrowLeft' || e.key === ',') stepFrame(-1);
  else if (e.key === 'ArrowRight' || e.key === '.') stepFrame(1);
});

function renderOffline(forceLog: boolean): void {
  const o = offline;
  if (!o) return;
  const v = viewAt(o.rec, o.timeline, o.time, 200);
  const st = v.status?.status ?? null;
  // Sample t is relative to the recording; lastFrameT is on the game-tab clock.
  const last = st?.lastFrameT;
  const stall = v.status && typeof last === 'number' ? Math.max(0, v.status.t + o.rec.startT - last) : null;
  renderPose(st, v.status?.backend ?? o.rec.backend, stall, `${v.frameIndex + 1} / ${o.rec.frames.length}`);
  renderGame(v.game?.game ?? null);
  renderSkeleton(v.frame, toPoseStatus(st, v.frame?.poses[0] ?? null), v.status?.base ?? null, o.rec.meta);
  frameInfo.textContent = v.frame ? `frame ${v.frameIndex + 1} · t ${(v.frame.t / 1000).toFixed(3)}s` : '';
  scrubOut.textContent = `${(o.time / 1000).toFixed(3)} / ${(o.rec.durationMs / 1000).toFixed(3)} s`;
  setPill('offline', `playback · ${o.name}`);
  syncControls(o.rec.meta, false);
  const key = `${v.entries.length}:${v.entries.at(-1)?.seq ?? 0}`;
  if (forceLog || key !== lastOfflineKey) {
    lastOfflineKey = key;
    rebuildLog(v.entries, 0, 'No events before this point.');
    logEl.lastElementChild?.classList.add('now');
  }
}

// ---- main loop ------------------------------------------------------------------------------

const pill = $('pill');
function setPill(kind: string, text: string): void {
  if (pill.className !== `pill ${kind}`) pill.className = `pill ${kind}`;
  if (pill.textContent !== text) pill.textContent = text;
}

let lastPillCheck = 0;
function frame(now: number): void {
  if (offline) {
    if (offline.playing) {
      const dt = now - offline.lastTick;
      offline.lastTick = now;
      setTime(offline.time + dt);
      if (offline.time >= offline.rec.durationMs) setPlaying(false);
    }
  } else if (dirty || now - lastPillCheck > 250) {
    lastPillCheck = now;
    const c = channel ? connection(state, now) : { state: 'waiting' as const, label: 'BroadcastChannel unsupported in this browser' };
    setPill(c.state, c.label);
    const live = c.state === 'connected';
    syncControls(state.meta, live);
    if (dirty) {
      dirty = false;
      const age = stallAge(state);
      renderPose(state.status, state.backend, age, `${state.counts.frames}${state.fullRate ? ' · full rate' : ''}`);
      renderGame(state.game);
      renderSkeleton(state.frame, poseStatusOf(state), state.base, state.meta);
      frameInfo.textContent = state.frame ? `t ${formatRel(state.frame.t, state.t0)}s` : '';
      if (!logPaused) appendLog(state.timeline, state.t0);
    }
  }
  renderRecording();
  requestAnimationFrame(frame);
}

fullLiveRebuild();
renderPose(null, null, null, '0');
renderGame(null);
requestAnimationFrame(frame);

Object.assign(window as unknown as Record<string, unknown>, {
  __monitor: {
    get state() {
      return state;
    },
    get recorder() {
      return recorder;
    },
    openRecording,
    setTime,
  },
});
