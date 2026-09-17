import './pip.css';
import type { PlayMode, PoseStatus } from '../pose/types';

// ---------------------------------------------------------------- pure helpers

export type TrackingLevel = 'ok' | 'slow' | 'lost';

/** Dot colour: red when lost or stalled, amber when the pose model runs slowly, else green. */
export const trackingLevel = (tracking: boolean, slow: boolean, stalled: boolean): TrackingLevel =>
  !tracking || stalled ? 'lost' : slow ? 'slow' : 'ok';

export const STALL_MS = 1500;

/** No pose frame for `ms` (same clock as PoseFrame.t, i.e. performance.now()). */
export const isStalled = (lastFrameT: number | null, nowMs: number, ms = STALL_MS): boolean =>
  lastFrameT !== null && nowMs - lastFrameT > ms;

/** Mean frame luma (0..255) below this reads as "too dark". */
export const DARK_LUMA = 45;

/** Shown in the jog pill while there is no cadence to show (dim, like the greyed-out pill). */
const NO_CADENCE = '—';
export const isDark = (luma: number | null): boolean => luma !== null && luma < DARK_LUMA;

export const modeBadge = (m: PlayMode | null): string => (m === 'full' ? 'FULL' : m === 'small' ? 'SMALL' : '—');

/** `?pip=0`, `?pip=off` or `?nopip` hide the preview. */
export function pipVisibleFromUrl(search: string): boolean {
  const p = new URLSearchParams(search);
  if (p.has('nopip')) return false;
  const v = p.get('pip');
  return !(v === '0' || v === 'off' || v === 'false');
}

// ---------------------------------------------------------------- drawing

// Bone pairs, flat: [a0, b0, a1, b1, ...].
const BONES = [11, 12, 11, 13, 13, 15, 12, 14, 14, 16, 11, 23, 12, 24, 23, 24, 23, 25, 25, 27, 24, 26, 26, 28];
const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const MIN_VIS = 0.5;
const LEVEL_TEXT: Record<TrackingLevel, string> = { ok: 'LIVE', slow: 'SLOW', lost: 'LOST' };
const PULSE_FRAMES: Keyframe[] = [
  { transform: 'scale(1)' },
  { transform: 'scale(1.45) rotate(-8deg)' },
  { transform: 'scale(1)' },
];
const PULSE_OPTS: KeyframeAnimationOptions = { duration: 220, easing: 'ease-out' };

export type PipLayout = 'corner' | 'stage';

export interface PipOptions {
  visible?: boolean;
}

const div = (cls: string, parent: HTMLElement, text?: string): HTMLDivElement => {
  const e = document.createElement('div');
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.append(e);
  return e;
};

/**
 * Camera preview card with the tracked skeleton. `corner` is the small bottom-left card during
 * play; `stage` is the big centred view behind the calibration outline.
 * update() is meant to run every animation frame and does not allocate.
 */
export class PosePip {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly dot: HTMLElement;
  private readonly state: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly mode: HTMLElement;
  private readonly jog: HTMLElement;
  private readonly jogIcon: HTMLElement;
  private readonly cadence: HTMLElement;
  private video: HTMLVideoElement | null = null;
  private layout: PipLayout = 'corner';
  private shown: boolean;
  private active = true;

  private cw = 0;
  private ch = 0;
  private sizeDirty = true;
  private lastPose: unknown = undefined;
  private lastLevel = '';
  private lastMode: PlayMode | null | undefined = undefined;
  private lastFpsAt = -1e9;
  private lastFps = -1;
  private lastSteps = -1;
  private lastJog = false;
  private lastCadence = -1;
  private lastCadenceAt = -1e9;
  private lumaCtx: CanvasRenderingContext2D | null = null;
  private lumaAt = -1e9;
  private luma: number | null = null;
  private readonly onResize = () => {
    this.sizeDirty = true;
  };
  /** Only the card's own size transition matters; the jog pill's opacity bubbles up here too. */
  private readonly onTransition = (e: TransitionEvent) => {
    if (e.target === this.card) this.sizeDirty = true;
  };

  constructor(root: HTMLElement, opts: PipOptions = {}) {
    this.root = root;
    root.classList.add('pip-root');
    this.card = div('pip no-video', root);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pip-canvas';
    this.card.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    const top = div('pip-bar', this.card);
    const live = div('pip-live', top);
    this.dot = div('pip-dot', live);
    this.state = div('pip-state', live, 'LOST');
    this.fps = div('pip-fps', live);
    this.mode = div('pip-mode', top, '—');
    this.jog = div('pip-jog', this.card);
    this.jogIcon = div('pip-jog-icon', this.jog, '🏃');
    this.cadence = div('pip-cadence', this.jog);
    div('pip-key', this.card, 'V hides');

    this.shown = opts.visible ?? true;
    this.card.classList.toggle('hidden', !this.shown);
    window.addEventListener('resize', this.onResize);
    // The corner ↔ stage change animates the card size; measure again once it settles.
    this.card.addEventListener('transitionend', this.onTransition);
  }

  get visible(): boolean {
    return this.shown;
  }

  /** The player's choice (V key / ?pip=0). Only hides the corner card; the calibration stage always shows. */
  setVisible(v: boolean): void {
    if (v === this.shown) return;
    this.shown = v;
    this.card.classList.toggle('hidden', !v);
    this.sizeDirty = true;
  }

  /** App-driven: false while there is nothing to preview (menu, keyboard play, camera screens). */
  setActive(v: boolean): void {
    if (v === this.active) return;
    this.active = v;
    this.card.classList.toggle('inactive', !v);
    this.sizeDirty = true;
  }

  toggle(): void {
    this.setVisible(!this.shown);
  }

  /** Toggles on the V key (ignores key repeat and typing in form fields). Returns a detach function. */
  attachToggleKey(target: Window | HTMLElement = window, key = 'v'): () => void {
    const onKey = (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.repeat || k.ctrlKey || k.metaKey || k.altKey || k.key.toLowerCase() !== key) return;
      const t = k.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      this.toggle();
    };
    target.addEventListener('keydown', onKey);
    return () => target.removeEventListener('keydown', onKey);
  }

  /** Shows the (already playing) camera video, mirrored. Pass null for replay: skeleton on a dark card. */
  setVideo(video: HTMLVideoElement | null): void {
    if (video === this.video) return;
    this.video?.remove();
    this.video = video;
    if (video) {
      video.classList.add('pip-video');
      video.muted = true;
      video.playsInline = true;
      this.card.prepend(video);
    }
    this.card.classList.toggle('no-video', !video);
    this.luma = null;
  }

  setLayout(layout: PipLayout): void {
    if (layout === this.layout) return;
    this.layout = layout;
    this.card.classList.toggle('stage', layout === 'stage');
    this.sizeDirty = true;
    this.lastPose = undefined;
  }

  /**
   * Redraws the skeleton when the pose changed and refreshes the badges.
   * `aspect` is the camera image width / height (PoseFrame.aspect); defaults to the video's.
   */
  update(st: PoseStatus, stalled: boolean, nowMs: number, aspect?: number): void {
    if (!this.active || (!this.shown && this.layout === 'corner')) return;
    if (this.sizeDirty) this.resize();

    const level = trackingLevel(st.tracking, st.slowPose, stalled);
    if (level !== this.lastLevel) {
      this.lastLevel = level;
      this.card.dataset.level = level;
      this.state.textContent = LEVEL_TEXT[level];
    }
    if (nowMs - this.lastFpsAt >= 500 && st.poseFps !== this.lastFps) {
      this.lastFpsAt = nowMs;
      this.lastFps = st.poseFps;
      this.fps.textContent = st.poseFps > 0 ? `${st.poseFps} fps` : '';
    }
    if (st.mode !== this.lastMode) {
      this.lastMode = st.mode;
      this.mode.textContent = modeBadge(st.mode);
    }
    const jog = st.jog;
    if (jog.active !== this.lastJog) {
      this.lastJog = jog.active;
      this.jog.classList.toggle('on', jog.active);
      if (!jog.active) {
        // The pill greys out; leaving the last spm under it reads as "still jogging at 150".
        this.cadence.textContent = NO_CADENCE;
        this.lastCadence = -1;
        this.lastCadenceAt = -1e9;
      }
    }
    if (jog.active && jog.cadenceSpm !== this.lastCadence && nowMs - this.lastCadenceAt >= 500) {
      this.lastCadenceAt = nowMs;
      this.lastCadence = jog.cadenceSpm;
      this.cadence.textContent = jog.cadenceSpm > 0 ? `${jog.cadenceSpm}` : NO_CADENCE;
    }
    if (jog.steps > this.lastSteps && this.lastSteps >= 0) this.pulse();
    this.lastSteps = jog.steps;

    if (st.pose !== this.lastPose) {
      this.lastPose = st.pose;
      const a = aspect ?? (this.video && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 4 / 3);
      this.draw(st, a);
    }
  }

  /** Mean luma (0..255) of the video, sampled at most every 500 ms; null without video. */
  sampleLuma(nowMs: number): number | null {
    const v = this.video;
    if (!v || v.readyState < 2) return null;
    if (nowMs - this.lumaAt < 500) return this.luma;
    this.lumaAt = nowMs;
    if (!this.lumaCtx) {
      const c = document.createElement('canvas');
      c.width = 16;
      c.height = 12;
      this.lumaCtx = c.getContext('2d', { willReadFrequently: true });
      if (!this.lumaCtx) return null;
    }
    const ctx = this.lumaCtx;
    ctx.drawImage(v, 0, 0, 16, 12);
    const d = ctx.getImageData(0, 0, 16, 12).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    this.luma = sum / (d.length / 4);
    return this.luma;
  }

  /**
   * Tears the card down. The <video> belongs to the PoseRuntime and keeps the camera decoding,
   * so it is only detached from the card: park it afterwards (PoseRuntime.parkVideo).
   */
  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.card.removeEventListener('transitionend', this.onTransition);
    this.setVideo(null);
    this.card.remove();
    this.root.classList.remove('pip-root');
  }

  // ---------------------------------------------------------------- internals

  private pulse(): void {
    if (typeof this.jogIcon.animate !== 'function') return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.jogIcon.animate(PULSE_FRAMES, PULSE_OPTS);
  }

  private resize(): void {
    this.sizeDirty = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (pw !== this.canvas.width || ph !== this.canvas.height) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.cw = w;
    this.ch = h;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastPose = undefined;
  }

  private draw(st: PoseStatus, aspect: number): void {
    const ctx = this.ctx;
    const W = this.cw;
    const H = this.ch;
    ctx.clearRect(0, 0, W, H);
    const pose = st.pose;
    if (!pose || W === 0) return;
    // Letterbox like object-fit: contain, matching the video element.
    const iw = Math.min(W, H * aspect);
    const ih = iw / aspect;
    const ox = (W - iw) / 2;
    const oy = (H - ih) / 2;
    const k = Math.max(1, W / 220);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Two passes: dark outline, then the bright bone on top.
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? 'rgba(27,16,53,0.85)' : '#ffffff';
      ctx.lineWidth = (pass === 0 ? 7 : 3.5) * k;
      ctx.beginPath();
      for (let i = 0; i < BONES.length; i += 2) {
        const a = pose[BONES[i]];
        const b = pose[BONES[i + 1]];
        if (a.visibility < MIN_VIS || b.visibility < MIN_VIS) continue;
        ctx.moveTo(ox + a.x * iw, oy + a.y * ih);
        ctx.lineTo(ox + b.x * iw, oy + b.y * ih);
      }
      ctx.stroke();
    }

    // Head: a ring around the nose, sized from the shoulders.
    const n = pose[0];
    const ls = pose[11];
    const rs = pose[12];
    if (n.visibility >= MIN_VIS) {
      const r = Math.max(4 * k, Math.hypot((ls.x - rs.x) * iw, (ls.y - rs.y) * ih) * 0.32);
      ctx.beginPath();
      ctx.arc(ox + n.x * iw, oy + n.y * ih, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,212,0,0.25)';
      ctx.fill();
      ctx.lineWidth = 6 * k;
      ctx.strokeStyle = 'rgba(27,16,53,0.85)';
      ctx.stroke();
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = '#ffd400';
      ctx.stroke();
    }

    ctx.fillStyle = '#ffd400';
    ctx.strokeStyle = '#1b1035';
    ctx.lineWidth = 2 * k;
    for (let i = 0; i < JOINTS.length; i++) {
      const p = pose[JOINTS[i]];
      if (p.visibility < MIN_VIS) continue;
      ctx.beginPath();
      ctx.arc(ox + p.x * iw, oy + p.y * ih, 3.5 * k, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
