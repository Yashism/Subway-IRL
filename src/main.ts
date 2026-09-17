import './ui/hud.css';
import { Autopilot } from './game/autopilot';
import type { Difficulty } from './game/config';
import { Game, type GameEvent } from './game/game';
import { FixedStepper } from './game/loop';
import { InputHub } from './input/hub';
import { KeyboardInput } from './input/keyboard';
import { Hud } from './ui/hud';
import { WorldView, type ToneChoice } from './world/worldView';

const params = new URLSearchParams(location.search);
const DIFFICULTIES: Difficulty[] = ['chill', 'cardio', 'beast'];
const requested = params.get('difficulty') as Difficulty | null;
const difficulty: Difficulty = requested && DIFFICULTIES.includes(requested) ? requested : 'cardio';
const seedParam = Number(params.get('seed'));
const seed = Number.isFinite(seedParam) && params.has('seed') ? seedParam : Math.floor(Math.random() * 1e6);

const game = new Game({ seed, difficulty, god: params.has('god') });
const keyboard = new KeyboardInput();
keyboard.jogEnabled = params.has('jog');
keyboard.attach(window);
const autopilot = params.has('autopilot') ? new Autopilot(game) : null;
const input = new InputHub(autopilot ? [keyboard, autopilot] : [keyboard]);

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const TONES: ToneChoice[] = ['neutral', 'agx', 'aces'];
const toneParam = params.get('tone') as ToneChoice | null;
const world = new WorldView(canvas, { seed, tone: toneParam && TONES.includes(toneParam) ? toneParam : undefined });
const hud = new Hud(document.getElementById('hud')!);
const stepper = new FixedStepper();
Object.assign(window as unknown as { __game: Game; __world: WorldView }, { __game: game, __world: world });

const perf = params.has('perf') ? document.body.appendChild(document.createElement('div')) : null;
if (perf) perf.className = 'hud-perf';
let fps = 60;

function resize(): void {
  world.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
}
resize();
window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) game.pause();
});

let last = performance.now();
const frameEvents: GameEvent[] = [];
function frame(now: number): void {
  const dt = Math.max(0, (now - last) / 1000);
  last = now;
  const steps = stepper.advance(dt);
  frameEvents.length = 0;
  for (let i = 0; i < steps; i++) {
    autopilot?.tick();
    const events = game.step(stepper.stepSec, input.drain(), input.activity(now));
    for (const e of events) frameEvents.push(e);
  }
  world.render(game, dt, frameEvents);
  hud.update(game);
  if (perf && dt > 0) {
    fps += (1 / dt - fps) * 0.05;
    const s = world.stats;
    perf.textContent = `${fps.toFixed(0)} fps  ${s.calls} calls  ${(s.triangles / 1000).toFixed(1)}k tris  dpr ${s.pixelRatio}\nseed ${seed}  ${difficulty}  s=${game.s.toFixed(0)}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
