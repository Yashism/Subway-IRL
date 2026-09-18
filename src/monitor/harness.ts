/**
 * Dev-only stand-in for the game tab: replays a pose fixture through PoseController, drives a
 * god-mode Game with the autopilot, and publishes everything over the telemetry channel.
 * Open /monitor-harness.html next to /monitor.html (or src/monitor/dual.html for both at once).
 */
import { Autopilot } from '../game/autopilot';
import { Game, type GameEvent } from '../game/game';
import type { GameCommand } from '../input/commands';
import { PoseController } from '../pose/controller';
import { ReplayPoseSource } from '../pose/replaySource';
import { TelemetryPublisher } from '../telemetry/publisher';

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') ?? 'synth-full';
const out = document.getElementById('out')!;

const pub = new TelemetryPublisher();
// ?spots: play with a set of lane spots in force, so the monitor's lanes readout has something to show.
const ctrl = new PoseController({ laneSpots: params.has('spots') ? { left: -0.62, centre: 0.04, right: 0.58 } : null });
const seed = 1234;
const game = new Game({ seed, difficulty: 'cardio', god: true });
const bot = new Autopilot(game);
let poseCommands: GameCommand[] = [];
let lastControl = '';

const sendMeta = () =>
  pub.meta({
    seed,
    difficulty: 'cardio',
    input: 'harness',
    mode: ctrl.forcedMode,
    sensitivity: ctrl.sensitivity,
    thresholds: { ...ctrl.th },
    laneSpots: ctrl.laneSpots ? { ...ctrl.laneSpots } : null,
  });
sendMeta();

pub.onControl((msg) => {
  lastControl = JSON.stringify(msg);
  if (msg.kind === 'setSensitivity') ctrl.sensitivity = msg.value;
  else if (msg.kind === 'setThreshold' && Object.hasOwn(ctrl.th, msg.key)) (ctrl.th as Record<string, number>)[msg.key] = msg.value;
  else if (msg.kind === 'recalibrate') pub.poseEvents(ctrl.recalibrate(), performance.now());
  else if (msg.kind === 'forceMode') {
    ctrl.forcedMode = msg.mode;
    pub.poseEvents(ctrl.recalibrate(), performance.now());
  }
  sendMeta();
});

const source = await ReplayPoseSource.load(`/tests/fixtures/${encodeURIComponent(fixture)}.json`);
void source.start((f) => {
  pub.frame(f);
  const events = ctrl.update(f);
  pub.poseEvents(events, f.t);
  for (const e of events) {
    if (e.type === 'lane') poseCommands.push({ type: 'setLane', lane: e.lane });
    else if (e.type === 'laneShift') poseCommands.push({ type: 'shiftLane', dir: e.dir });
    else if (e.type === 'jump' || e.type === 'roll' || e.type === 'hoverboard' || e.type === 'start') poseCommands.push({ type: e.type });
  }
});

const STEP = 1 / 60;
let last = performance.now();
let acc = 0;
let nextKey = last + 4000;
const events: GameEvent[] = [];

function tick(now: number): void {
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  events.length = 0;
  while (acc >= STEP) {
    acc -= STEP;
    bot.tick();
    const botCmds = bot.drain();
    const pose = poseCommands;
    poseCommands = [];
    const keys: GameCommand[] = [];
    if (now >= nextKey) {
      nextKey = now + 4000;
      keys.push({ type: 'shiftLane', dir: Math.random() < 0.5 ? -1 : 1 });
    }
    pub.commands(pose, 'pose', now);
    pub.commands(keys, 'keyboard', now);
    pub.commands(botCmds, 'autopilot', now);
    for (const e of game.step(STEP, [...pose, ...keys, ...botCmds], bot.activity(now))) events.push(e);
  }
  pub.gameEvents(events, now);
  // Fake idle clock: a sawtooth so the monitor's bar shows every level.
  const idleMs = (now / 3500) % 1 * 2600;
  pub.game(game, idleMs, now);
  pub.status(ctrl.status, source.backend, ctrl.baseline);
  out.textContent = `harness · ${fixture} · monitor ${pub.connected ? 'connected' : 'not connected'}${pub.fullRate ? ' (full rate)' : ''} · game ${game.state} s=${game.s.toFixed(0)} · last control ${lastControl || '—'}`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
