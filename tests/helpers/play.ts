import type { PoseController } from '../../src/pose/controller';
import type { PoseEvent, PoseFrame } from '../../src/pose/types';

export function play(ctrl: PoseController, frames: PoseFrame[]): PoseEvent[] {
  return frames.flatMap((f) => ctrl.update(f));
}

export const names = (events: PoseEvent[]) =>
  events.map((e) => (e.type === 'lane' ? `lane:${e.lane}` : e.type === 'laneShift' ? `shift:${e.dir}` : e.type));
