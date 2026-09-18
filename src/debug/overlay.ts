import type { Baseline } from '../pose/calibration';
import type { LaneSpots } from '../pose/laneSpots';
import { TRACKED_INDICES } from '../pose/landmarks';
import type { Thresholds } from '../pose/thresholds';
import type { PoseStatus } from '../pose/types';

const CONNECTIONS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12],
];

export interface View {
  width: number;
  height: number;
  /** Image aspect ratio (width / height). */
  aspect: number;
}

/**
 * Draws the skeleton and detection guides, letterboxed like `object-fit: contain`. With full-body
 * lane `spots` in force, the lane lines are the recorded midpoints (before sensitivity, like the
 * automatic ±laneEnter lines) and each spot gets a solid tick of its own.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  view: View,
  st: PoseStatus,
  base: Baseline | null,
  th: Thresholds,
  spots: Readonly<LaneSpots> | null = null,
): void {
  const { width, height, aspect } = view;
  ctx.clearRect(0, 0, width, height);
  const imgW = Math.min(width, height * aspect);
  const imgH = imgW / aspect;
  const ox = (width - imgW) / 2;
  const oy = (height - imgH) / 2;
  // Height units → pixels: x is stored as x * aspect.
  const px = (xh: number) => ox + (xh / aspect) * imgW;
  const py = (y: number) => oy + y * imgH;

  if (base) {
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    if (base.mode === 'full') {
      const T = base.torso;
      ctx.strokeStyle = 'rgba(255,176,32,0.8)';
      const bounds = spots ? [(spots.left + spots.centre) / 2, (spots.right + spots.centre) / 2] : [-th.laneEnter, th.laneEnter];
      for (const dx of bounds) line(ctx, px(base.hip.x + dx * T), oy, px(base.hip.x + dx * T), oy + imgH);
      if (spots) {
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(41,199,224,0.95)';
        ctx.lineWidth = 4;
        const y = base.hip.y;
        for (const dx of [spots.left, spots.centre, spots.right]) line(ctx, px(base.hip.x + dx * T), py(y - 0.25 * T), px(base.hip.x + dx * T), py(y + 0.25 * T));
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
      }
      ctx.strokeStyle = 'rgba(62,207,142,0.8)';
      line(ctx, ox, py(base.hip.y - th.jumpRise * T), ox + imgW, py(base.hip.y - th.jumpRise * T));
      ctx.strokeStyle = 'rgba(255,93,93,0.8)';
      line(ctx, ox, py(base.hip.y + th.rollDrop * T), ox + imgW, py(base.hip.y + th.rollDrop * T));
    } else {
      const S = base.shoulderWidth;
      ctx.strokeStyle = 'rgba(255,176,32,0.8)';
      for (const dx of [-th.noseShift, th.noseShift]) line(ctx, px(base.nose.x + dx * S), oy, px(base.nose.x + dx * S), oy + imgH);
      ctx.strokeStyle = 'rgba(255,93,93,0.8)';
      line(ctx, ox, py(base.nose.y + th.duckDrop * S), ox + imgW, py(base.nose.y + th.duckDrop * S));
    }
    ctx.setLineDash([]);
  }

  const pose = st.pose;
  if (pose) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    for (const [a, b] of CONNECTIONS) {
      if (pose[a].visibility < 0.5 || pose[b].visibility < 0.5) continue;
      line(ctx, ox + pose[a].x * imgW, py(pose[a].y), ox + pose[b].x * imgW, py(pose[b].y));
    }
    ctx.fillStyle = '#ffb020';
    for (const i of TRACKED_INDICES) {
      if (pose[i].visibility < 0.5) continue;
      ctx.beginPath();
      ctx.arc(ox + pose[i].x * imgW, py(pose[i].y), 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.font = 'bold 28px system-ui, sans-serif';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  if (!st.calibrated) {
    const hint =
      !st.calibration.bodyVisible ? 'Step into view' :
      st.calibration.distance === 'closer' ? 'Come closer' :
      st.calibration.distance === 'back' ? 'Step back — show your knees' :
      `Hold still… ${Math.round(st.calibration.progress * 100)}%`;
    ctx.fillText(hint, ox + 20, oy + 44);
  } else if (st.mode === 'full') {
    ctx.fillText(`Lane ${['LEFT', 'CENTRE', 'RIGHT'][st.lane + 1]}`, ox + 20, oy + 44);
  }
  if (st.jog.active) {
    ctx.fillStyle = '#3ecf8e';
    ctx.fillText(`🏃 ${st.jog.cadenceSpm} spm`, ox + 20, oy + imgH - 24);
  }
  if (st.startProgress > 0) {
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(ox + imgW - 60, oy + 60, 30, -Math.PI / 2, -Math.PI / 2 + st.startProgress * Math.PI * 2);
    ctx.stroke();
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}
