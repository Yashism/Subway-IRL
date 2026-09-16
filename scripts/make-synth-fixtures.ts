import { mkdir, writeFile } from 'node:fs/promises';
import { encodeFrames } from '../src/pose/fixtures';
import { jogParams, jumpArc, ramp, Scenario, STAND } from '../tests/helpers/synth';

const T = STAND.torso;
const out = new URL('../tests/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });

const full = new Scenario()
  .hold(2500)
  .add(300, (t) => ({ hipX: STAND.hipX + 0.8 * T * ramp(t, 300) }))
  .hold(700, { hipX: STAND.hipX + 0.8 * T })
  .add(300, (t) => ({ hipX: STAND.hipX + 0.8 * T * (1 - ramp(t, 300)) }))
  .hold(500)
  .add(500, (t) => ({ hipY: STAND.hipY - jumpArc(t, 500, 0.35) * T }))
  .hold(500)
  .add(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * ramp(t, 200) }))
  .hold(500, { hipY: STAND.hipY + 0.45 * T })
  .add(200, (t) => ({ hipY: STAND.hipY + 0.45 * T * (1 - ramp(t, 200)) }))
  .add(4000, (t) => jogParams(t))
  .hold(600, { arms: 'both-up' })
  .hold(1500);

const small = new Scenario()
  .hold(2500, { lowerVisible: false })
  .add(200, (t) => ({ lowerVisible: false, tiltDeg: -20 * ramp(t, 200) }))
  .hold(500, { lowerVisible: false, tiltDeg: -20 })
  .hold(500, { lowerVisible: false })
  .add(400, (t) => ({ lowerVisible: false, hipY: STAND.hipY - jumpArc(t, 400, 0.25) * T }))
  .hold(500, { lowerVisible: false })
  .add(4000, (t) => jogParams(t, { small: true, bob: 0 }))
  .hold(1500, { lowerVisible: false });

for (const [name, sc, note] of [
  ['synth-full', full, 'Synthetic: calibrate, lane right and back, jump, roll, hoverboard'],
  ['synth-small', small, 'Synthetic small-room: calibrate, lean left, hop, arm-pump jog'],
] as const) {
  await writeFile(new URL(`${name}.json`, out), JSON.stringify(encodeFrames(name, sc.frames, note)));
  console.log(`wrote tests/fixtures/${name}.json (${sc.frames.length} frames)`);
}
