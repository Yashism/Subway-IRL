import './ui/hud.css';
import { ProfileStore, type RunRecord } from './app/profile';
import { Autopilot } from './game/autopilot';
import type { Difficulty } from './game/config';
import { Game, type GameEvent } from './game/game';
import { FixedStepper } from './game/loop';
import { InputHub } from './input/hub';
import { KeyboardInput } from './input/keyboard';
import { Hud } from './ui/hud';
import { isLineId } from './world/stations';
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
const lineParam = params.get('line');
const world = new WorldView(canvas, {
  seed,
  tone: toneParam && TONES.includes(toneParam) ? toneParam : undefined,
  line: isLineId(lineParam) ? lineParam : undefined,
});
const hud = new Hud(document.getElementById('hud')!);
const stepper = new FixedStepper();

// Saved profile. Autopilot runs are demos: not saved unless ?saveAutopilot is set.
const profile = new ProfileStore();
const inputName = autopilot ? 'autopilot' : 'keyboard';
const saveRuns = !autopilot || params.has('saveAutopilot');
hud.setProfile(profile.profile, null);

/** Records the run that just ended; called once per run, on entering the summary. */
function recordRun(): void {
  if (!saveRuns) {
    hud.setProfile(profile.profile, null);
    return;
  }
  const s = game.stats;
  const run: RunRecord = {
    at: Date.now(),
    score: s.score,
    coins: s.coins,
    distance: s.distance,
    timeSec: s.timeSec,
    jumps: s.jumps,
    rolls: s.rolls,
    laneChanges: s.laneChanges,
    steps: s.steps,
    hoverboardsUsed: s.hoverboardsUsed,
    caughtReason: game.caughtReason,
    difficulty,
    seed,
    input: inputName,
  };
  const result = profile.recordRun(run);
  hud.setProfile(profile.profile, result);
}
Object.assign(window as unknown as { __game: Game; __world: WorldView }, { __game: game, __world: world });
(window as unknown as { __profile: ProfileStore }).__profile = profile;

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

// The GPU can drop the context (driver reset, too many tabs). preventDefault lets the browser
// restore it; three.js re-uploads its resources then, and the player resumes with Enter.
let contextLost = false;
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  contextLost = true;
  game.pause();
  console.warn('WebGL context lost; game paused until it is restored.');
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  resize();
  console.warn('WebGL context restored; press Enter to resume.');
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
    for (const e of events) {
      frameEvents.push(e);
      if (e.type === 'state' && e.state === 'summary') recordRun();
    }
  }
  if (!contextLost) world.render(game, dt, frameEvents);
  hud.update(game);
  if (perf && dt > 0) {
    fps += (1 / dt - fps) * 0.05;
    const s = world.stats;
    perf.textContent = `${fps.toFixed(0)} fps  ${s.calls} calls  ${(s.triangles / 1000).toFixed(1)}k tris  dpr ${s.pixelRatio}\nseed ${seed}  ${difficulty}  s=${game.s.toFixed(0)}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
