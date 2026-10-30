/**
 * Wander: a relaxed free-roam mode. Walk a Mumbai-style neighbourhood — chawls, street trees, parked
 * autos, billboards, a railway station you can walk onto, a local that passes now and then — with
 * no obstacles, no ticket inspector, no score and no game over.
 *
 * It is self-contained: its own scene on the game's renderer, its own keys, its own overlay. The
 * game page decides when it is on screen and calls `frame()` instead of its own loop, so Wander
 * never starts a run and never writes to the profile, the missions or the wallet.
 *
 * Control is the keyboard (see controls.ts) or, when a calibrated camera is running, the body: jog
 * in place to walk, lean or step to steer. The camera is never needed to enter the mode.
 */
import type * as THREE from 'three';
import type { RunnerPalette } from '../world/models/characters';
import type { LineId } from '../world/stations';
import { spawnPoint, type Box, type Solids } from './city';
import { WanderKeys, mergeInput, poseToInput, poseUsable, type PoseSample } from './controls';
import { placeAt } from './places';
import { WanderScene, type WanderStats } from './scene';
import { NO_INPUT, createFollowCamera, createWalker, resolveCollisions, stepFollowCamera, stepWalker, WALK, type FollowCamera, type WalkInput, type WalkerState } from './walker';
import { WanderHud } from './wanderHud';

export type { PoseSample } from './controls';

export interface WanderOptions {
  renderer: THREE.WebGLRenderer;
  seed: number;
  line: LineId;
  skin?: { id: string; palette?: RunnerPalette } | null;
  /** The pose pipeline as far as Wander cares; null while there is no camera running. */
  pose(): PoseSample | null;
  /** True when a camera could be turned on (C): a webcam game with no camera running yet. */
  canStartCamera(): boolean;
  /** C: the player asked for the camera. */
  startCamera(): void;
  /** A moving local has just drawn level with the walker (0.15..1, by how near the track is). */
  onTrainPass?(closeness: number): void;
  /** Wander has been left (Esc): hand the screen back to the menu. */
  onExit(): void;
}

const PLACE_EVERY_S = 0.2;

export class Wander {
  /** Wander is on screen and owns the frame. */
  active = false;
  paused = false;

  private scene: WanderScene | null = null;
  private hud: WanderHud | null = null;
  private readonly walker: WalkerState;
  private readonly follow: FollowCamera;
  private readonly keys: WanderKeys;
  private detachKeys: (() => void) | null = null;
  private readonly solids: Solids = { boxes: [], discs: [] };
  private readonly trainBox: Box = { x0: 0, z0: 0, x1: 0, z1: 0 };
  private readonly extra: Box[] = [];
  private readonly keyIn: WalkInput = { ...NO_INPUT };
  private readonly poseIn: WalkInput = { ...NO_INPUT };
  private readonly input: WalkInput = { ...NO_INPUT };
  private placeClock = 0;
  private snapCamera = true;
  private width = 1280;
  private height = 720;
  private readonly onVisibility = (): void => {
    if (document.hidden && this.active) this.setPaused(true);
  };

  constructor(private readonly o: WanderOptions) {
    const s = spawnPoint();
    this.walker = createWalker(s.x, s.z, s.heading);
    this.follow = createFollowCamera(s.heading);
    this.keys = new WanderKeys({
      exit: () => this.exit(),
      pause: () => this.setPaused(!this.paused),
      camera: () => {
        if (this.o.canStartCamera()) this.o.startCamera();
      },
    });
  }

  /** Where the walker is: for the page's debug hooks and tests. */
  get position(): { x: number; z: number; heading: number } {
    const w = this.walker;
    return { x: w.x, z: w.z, heading: w.heading };
  }

  /** The cost of the last frame. Null before the first one. */
  get stats(): WanderStats | null {
    return this.scene?.stats ?? null;
  }

  get currentScene(): WanderScene | null {
    return this.scene;
  }

  /** Puts the walker somewhere (a screenshot, a test). Facing is a heading, 0 = north (-z). */
  teleport(x: number, z: number, heading = this.walker.heading): void {
    const w = this.walker;
    w.x = x;
    w.z = z;
    w.heading = heading;
    w.vx = w.vz = w.speed = 0;
    // Never leave the walker inside something solid.
    if (this.scene) {
      this.scene.city.solidsNear(x, z, this.solids);
      resolveCollisions(w, WALK.radius, this.solids);
    }
    this.snapCamera = true;
    this.placeClock = PLACE_EVERY_S;
  }

  /** Brings Wander on screen. The first call builds the scene (and warms its shaders). */
  enter(): void {
    if (this.active) return;
    if (!this.scene) {
      this.scene = new WanderScene({ renderer: this.o.renderer, seed: this.o.seed, line: this.o.line, skin: this.o.skin, onTrainPass: this.o.onTrainPass });
      this.scene.resize(this.width, this.height);
    }
    this.hud ??= new WanderHud();
    this.scene.setLine(this.o.line);
    this.scene.setCurve(false);
    // Spawn clear of anything solid, then compile everything the walk will show.
    this.scene.city.solidsNear(this.walker.x, this.walker.z, this.solids);
    resolveCollisions(this.walker, WALK.radius, this.solids);
    this.scene.warm(this.walker);
    this.active = true;
    this.paused = false;
    this.snapCamera = true;
    this.placeClock = PLACE_EVERY_S;
    this.hud.setPaused(false);
    this.hud.show();
    document.documentElement.dataset.wander = 'on';
    this.detachKeys = this.keys.attach(window);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** Leaves Wander and hands the screen back (the page restores its own camera and HUD). */
  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.detachKeys?.();
    this.detachKeys = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.hud?.hide();
    this.scene?.setCurve(true);
    delete document.documentElement.dataset.wander;
    this.o.onExit();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.keys.release();
    this.hud?.setPaused(paused);
  }

  /** The equipped outfit and suburban line may change between visits. */
  refresh(o: { line?: LineId; skin?: WanderOptions['skin'] }): void {
    if (o.line) this.o.line = o.line;
    if (o.skin !== undefined) this.o.skin = o.skin;
    this.scene?.setLine(this.o.line);
    if (o.skin !== undefined) this.scene?.setSkin(o.skin);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.scene?.resize(width, height);
  }

  /** One frame: read the controls, walk, draw. `dtSec` is the real time since the last frame. */
  frame(dtSec: number): void {
    const scene = this.scene;
    const hud = this.hud;
    if (!this.active || !scene || !hud) return;
    const dt = this.paused || !Number.isFinite(dtSec) ? 0 : Math.min(Math.max(dtSec, 0), 0.1);
    const w = this.walker;

    const pose = this.o.pose();
    this.keys.read(this.keyIn);
    poseToInput(pose, this.poseIn);
    mergeInput(this.keyIn, this.poseIn, this.input);

    scene.city.solidsNear(w.x, w.z, this.solids);
    if (dt > 0) {
      this.extra.length = 0;
      if (scene.timetable.solid(this.trainBox)) this.extra.push(this.trainBox);
      stepWalker(w, this.input, dt, this.solids, this.extra);
    }
    stepFollowCamera(this.follow, w, dt, this.solids, this.snapCamera);
    this.snapCamera = false;
    scene.update({ walker: w, follow: this.follow, dt });
    scene.render();

    this.placeClock += dtSec > 0 ? dtSec : 0;
    if (this.placeClock >= PLACE_EVERY_S) {
      this.placeClock = 0;
      hud.setPlace(placeAt(this.o.seed, this.o.line, w.x, w.z));
      hud.setControls(this.controlsText(pose));
    }
  }

  private controlsText(pose: PoseSample | null): string {
    const keys = 'W A S D or arrows to walk and turn · Shift to run';
    if (poseUsable(pose)) return 'Camera on · jog in place to walk, lean or step to steer · ' + keys;
    if (pose?.running) return 'Camera on · stand still in view for a moment to calibrate · ' + keys;
    return this.o.canStartCamera() ? `${keys} · C to use the camera` : keys;
  }
}
