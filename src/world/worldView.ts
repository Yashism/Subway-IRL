import * as THREE from 'three';
import { CHUNKS } from '../game/chunks';
import { LANE_WIDTH, laneX } from '../game/config';
import type { Game, GameEvent, GameState } from '../game/game';
import { OBSTACLES, type ObstacleKind } from '../game/obstacles';
import type { Track, PowerupKind } from '../game/track';
import { CHAPPAL_JUMP, NORMAL_JUMP } from '../game/runner';
import { Fx } from './fx';
import { createDog, createInspector, createRunner, type CharacterRig, type RunnerPalette } from './models/characters';
import { createIntro, type IntroSequence } from './intro';
import {
  buildAuto,
  buildBanner,
  buildCow,
  buildHandcart,
  buildHoverboard,
  buildLowBarrier,
  buildPickup,
  coinGeometry,
  coinMaterial,
  type BoardPalette,
} from './models/props';
import { SKY_HORIZON, buildSkyDome, buildSkyline, createSideScenery, type SideScenery } from './models/scenery';
import { createCatenary, createTrackBed, type Catenary, type TrackBed } from './models/trackKit';
import { buildRamp, buildTrain } from './models/trains';
import { KeyedPool } from './pools';
import { LINES, type LineId, type Station } from './stations';
import { applyAgxLook } from './toneLook';
import { outlineMaterial } from './render/materials';
import {
  OBSTACLE_VARIANTS,
  airborneProgress,
  damp,
  isTrain,
  laneLean,
  obstacleKey,
  obstacleVariant,
  runnerAction,
  trainLengths,
  trainLook,
} from './viewState';

// ------------------------------------------------------------------ tuning

const MAX_PIXEL_RATIO = 1.25;
/** Obstacles, coins and pickups are drawn this far ahead (the fog is opaque from 170 m). */
const VIEW_AHEAD = 172;
const VIEW_BEHIND = 8;
/**
 * Level of detail: beyond this the inverted-hull outlines and small parts (lamps, plates,
 * decals, un-outlined detail meshes) are a few pixels and fogged, so skip their draw calls.
 */
const LOD_FAR = 55;
/** Parts whose bounding sphere is smaller than this (m) count as small (lamps, plates, meters). */
const SMALL_PART = 0.55;
/** Parts smaller than this (m) cast no shadow: a few texels in the shadow map, one draw call each. */
const SHADOW_MIN_PART = 0.6;
const FOG_NEAR = 60;
const FOG_FAR = 170;
const SCENERY_AHEAD = 175;
const SCENERY_BEHIND = 12;
const MAX_COINS = 320;
/**
 * Tone mapping. AgX (the spec's first choice) turns the #FFD400 cab yellow, the auto hood and
 * the coins khaki at any exposure; Khronos PBR Neutral keeps hue and saturation, which is what
 * a toon runner needs. AgX (with a punchy look) and ACES stay selectable for comparison.
 */
export type ToneChoice = 'neutral' | 'agx' | 'aces';
const TONE: Record<ToneChoice, { mapping: THREE.ToneMapping; exposure: number }> = {
  neutral: { mapping: THREE.NeutralToneMapping, exposure: 0.9 },
  agx: { mapping: THREE.AgXToneMapping, exposure: 1.5 },
  aces: { mapping: THREE.ACESFilmicToneMapping, exposure: 1.0 },
};
const STUMBLE_SECONDS = 0.36;
const COIN_TINT = 0xffffff;
const COIN_GLOW = 0xffd000;
const COIN_GLOW_INTENSITY = 0.42;
/** Magnet: coins this close fly visibly toward the runner. */
const MAGNET_PULL_RANGE = 14;

export const CAMERA = {
  fov: 62,
  height: 3.4,
  back: 6.2,
  lookAhead: 10,
  lookHeight: 1.2,
  laneFollow: 0.6,
  /** Share of a jump's height the camera follows. */
  jumpFollow: 0.45,
  /** Share of a standing height (train roof, rocket) the camera follows. */
  standFollow: 0.8,
  rate: 8,
  standRate: 3.5,
  /** Menu: a lower, closer showcase of the idle runner, framed right of the logo. */
  menu: { height: 2.0, back: 4.4, lookAhead: 6, lookHeight: 1.15, x: -1.7, lookX: -3.6 },
  /** Caught: swing to the side nearer the track centre and dolly in on the grab. */
  caught: { height: 2.9, back: 4.4, lookAhead: 1.8, lookHeight: 1.15, x: 2.6, lookX: 0 },
};

const SUN_OFFSET = new THREE.Vector3(-7, 15, 9);

/** Two lanes away is the far side of the corridor; the same lane is right past your ear. */
const TRAIN_PASS_RANGE = 2 * LANE_WIDTH;
const trainCloseness = (trainX: number, runnerX: number): number =>
  Math.max(0.15, 1 - Math.min(1, Math.abs(trainX - runnerX) / TRAIN_PASS_RANGE));

const NO_EVENTS: readonly GameEvent[] = [];

// ------------------------------------------------------------------ pooled objects

interface Pooled {
  root: THREE.Group;
  /** Hidden when far away: outline hulls and small or detail-only parts. */
  minor: THREE.Object3D[];
  near: boolean;
}

interface Active {
  id: number;
  key: string;
  item: Pooled;
  stamp: number;
}

function isMinorPart(o: THREE.Object3D): boolean {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh) return false;
  if (o.userData.isOutline) return true;
  const g = mesh.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  const scale = o.getWorldScale(new THREE.Vector3());
  if (g.boundingSphere!.radius * Math.max(scale.x, scale.y, scale.z) < SMALL_PART) return true;
  // Un-outlined, plain vertex-coloured detail (train fittings, fruit, spokes).
  const mat = mesh.material as THREE.MeshToonMaterial;
  return !!o.userData.noOutline && mat.vertexColors === true && !mat.map && mat.emissive?.getHex() === 0;
}

/**
 * Every shadow caster is drawn a second time in the shadow pass, so only parts whose shadow
 * shows cast: not LOD-minor parts, not tiny ones, and not a train's flush decals (end faces,
 * lamps), which sit inside the body's own shadow.
 */
function castsShadow(o: THREE.Mesh, minor: boolean, train: boolean): boolean {
  if (!o.castShadow || minor) return false;
  if (train && o.userData.noOutline) return false;
  const g = o.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  const scale = o.getWorldScale(new THREE.Vector3());
  return g.boundingSphere!.radius * Math.max(scale.x, scale.y, scale.z) >= SHADOW_MIN_PART;
}

function pooled(object: THREE.Object3D, train = false): Pooled {
  const root = new THREE.Group();
  root.add(object);
  root.updateMatrixWorld(true);
  const minor: THREE.Object3D[] = [];
  root.traverse((o) => {
    const isMinor = isMinorPart(o);
    if (isMinor) minor.push(o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = castsShadow(mesh, isMinor, train);
    // A transparent double-sided material is drawn in two passes (back faces, then front);
    // for small tinted glass one pass looks the same and saves a draw call.
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
  });
  root.visible = false;
  return { root, minor, near: true };
}

function setNear(p: Pooled, near: boolean): void {
  if (p.near === near) return;
  p.near = near;
  for (const o of p.minor) o.visible = near;
}

function buildObstacle(kind: ObstacleKind, variant: number, length: number, destinations: readonly string[]): THREE.Object3D {
  switch (kind) {
    case 'trainParked':
    case 'trainMoving': {
      const look = trainLook(variant);
      return buildTrain(length, { livery: look.livery, seed: look.seed, oncoming: kind === 'trainMoving', destinations });
    }
    case 'ramp':
      return buildRamp(variant);
    case 'barrierLow':
      return buildLowBarrier(variant);
    case 'handcart':
      return buildHandcart(variant);
    case 'bannerHigh':
      return buildBanner(variant);
    case 'auto':
      return buildAuto(variant);
    case 'cow':
      return buildCow(variant, 'stand');
    case 'cowSitting':
      return buildCow(variant, 'sit');
  }
}

/** A list of live pooled objects keyed by game id, allocation-free per frame. */
class ActiveSet {
  readonly list: Active[] = [];
  private readonly byId = new Map<number, Active>();

  get(id: number): Active | undefined {
    return this.byId.get(id);
  }

  add(a: Active): void {
    this.list.push(a);
    this.byId.set(a.id, a);
  }

  /** Removes entries not stamped this frame; calls release for each. */
  sweep(stamp: number, release: (a: Active) => void): void {
    const list = this.list;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.stamp === stamp) list[w++] = a;
      else {
        this.byId.delete(a.id);
        release(a);
      }
    }
    list.length = w;
  }
}

// ------------------------------------------------------------------ view

export interface WorldViewOptions {
  /** Seeds the side-scenery layout. */
  seed?: number;
  /**
   * A moving local has just swept past the runner, `closeness` 0..1 by how near it went. There is
   * no game event for this — the sim only knows the train is an obstacle — so the view, which is
   * the thing that actually draws it going by, is what reports it.
   */
  onTrainPass?: (closeness: number) => void;
  /** Tone mapping (default 'neutral'). */
  tone?: ToneChoice;
  /** Mumbai suburban line whose real station names the platforms show (default: from the seed). */
  line?: LineId;
}

export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.1, 900);
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;
  private readonly skyline: THREE.Mesh;
  private readonly bed: TrackBed;
  private readonly ohe: Catenary;
  private readonly side: SideScenery;
  private readonly fx: Fx;

  private readonly obstacleRoot = new THREE.Group();
  private readonly obstaclePool: KeyedPool<Pooled>;
  private readonly obstacles = new ActiveSet();
  private readonly pickupPool: KeyedPool<Pooled>;
  private readonly pickups = new ActiveSet();
  private readonly coins: THREE.InstancedMesh;
  private readonly coinOutlines: THREE.InstancedMesh;

  private runner: CharacterRig;
  private board: THREE.Group;
  private readonly rocket: THREE.Group;
  private readonly tt: CharacterRig;
  private readonly dog: CharacterRig;

  private readonly onTrainPass: ((closeness: number) => void) | null;
  /** Moving trains already reported as passed, so each one sounds exactly once. */
  private readonly passed = new Set<number>();

  /** The equipped shop skins, so a re-equip of the same id is a no-op. */
  private characterSkin = '';
  private boardSkin = '';
  /** The intro cinematic while it owns the camera; null the rest of the time. */
  private intro: IntroSequence | null = null;

  private track: Track | null = null;
  private trackS = 0;
  private stamp = 0;
  private clock = 0;
  private stumbleLeft = 0;
  private jumpLaunch = 0;
  private prevState: GameState | null = null;
  private chaserX = 0;
  private standY = 0;
  private camReady = false;
  /** Which side (+1 right, -1 left) the caught camera swings to; the chasers stand opposite. */
  private caughtSide = 1;

  // scratch (render() allocates nothing)
  private readonly tmp = new THREE.Object3D();
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly camPosTarget = new THREE.Vector3();
  private readonly camLookTarget = new THREE.Vector3();
  private readonly runnerPos = new THREE.Vector3();
  private readonly fxFrame = { speed: 0, flying: false, magnet: false, josh: false, runnerPos: this.runnerPos };
  private readonly runnerState = { action: 'idle' as ReturnType<typeof runnerAction>, speed: 0, lean: 0, airborneT: 0 };
  private readonly chaserState = { action: 'idle' as ReturnType<typeof runnerAction>, speed: 0, lean: 0 };
  private readonly look = { state: 'menu' as GameState, flying: false, airborne: false, rolling: false, hoverboard: false, stumbling: false };

  constructor(canvas: HTMLCanvasElement, options: WorldViewOptions = {}) {
    this.onTrainPass = options.onTrainPass ?? null;
    applyAgxLook();
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    const tone = TONE[options.tone ?? 'neutral'] ?? TONE.neutral;
    r.toneMapping = tone.mapping;
    r.toneMappingExposure = tone.exposure;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;

    const scene = this.scene;
    const horizon = new THREE.Color(SKY_HORIZON);
    scene.background = horizon;
    scene.fog = new THREE.Fog(horizon, FOG_NEAR, FOG_FAR);

    // Light: warm sun from behind-left, cool sky fill so shadow sides never go black.
    scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6b5b4a, 1.15));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff1d6, 2.7));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 15, bottom: -15, near: 8, far: 60 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);

    // Sky and far skyline follow the camera (unlit, uncurved).
    this.sky = buildSkyDome();
    this.skyline = buildSkyline();
    scene.add(this.sky, this.skyline);

    // Track, overhead wires, side scenery.
    this.side = createSideScenery(options.seed ?? 1, { behind: SCENERY_BEHIND, ahead: SCENERY_AHEAD, lodFar: LOD_FAR, line: options.line });
    this.bed = createTrackBed(SCENERY_BEHIND, SCENERY_AHEAD);
    this.ohe = createCatenary({ behind: SCENERY_BEHIND, ahead: SCENERY_AHEAD, signalFilter: (s) => !this.side.isStation(s) });
    scene.add(this.bed.root, this.ohe.root, this.side.root);

    // Obstacles and pickups (pooled, pre-warmed).
    this.obstacleRoot.name = 'obstacles';
    scene.add(this.obstacleRoot);
    this.obstaclePool = new KeyedPool<Pooled>((p) => this.obstacleRoot.add(p.root));
    this.pickupPool = new KeyedPool<Pooled>((p) => this.obstacleRoot.add(p.root));
    this.prewarm();

    // Coins: one instanced mesh plus its own instanced outline hull.
    const coinGeo = coinGeometry();
    const coinMat = coinMaterial() as THREE.MeshToonMaterial;
    // Warmer, brighter gold so coins pop against the toon-lit track.
    coinMat.color.set(COIN_TINT);
    coinMat.emissive.set(COIN_GLOW);
    coinMat.emissiveIntensity = COIN_GLOW_INTENSITY;
    this.coins = new THREE.InstancedMesh(coinGeo, coinMat, MAX_COINS);
    this.coinOutlines = new THREE.InstancedMesh(coinGeo, outlineMaterial(0.03), MAX_COINS);
    this.coinOutlines.instanceMatrix = this.coins.instanceMatrix;
    for (const m of [this.coins, this.coinOutlines]) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
    this.coins.name = 'coins';
    scene.add(this.coins, this.coinOutlines);

    // Characters.
    this.runner = createRunner();
    this.board = buildHoverboard();
    this.board.visible = false;
    this.rocket = new THREE.Group();
    const rocketModel = buildPickup('rocket');
    rocketModel.rotation.z = 0.55; // undo the pickup's display tilt: nose up
    rocketModel.scale.setScalar(1.25);
    this.rocket.add(rocketModel);
    this.rocket.visible = false;
    this.tt = createInspector();
    this.dog = createDog();
    this.tt.root.visible = this.dog.root.visible = false;
    scene.add(this.runner.root, this.board, this.rocket, this.tt.root, this.dog.root);

    this.fx = new Fx(scene, this.camera);

    this.camera.position.set(0, CAMERA.menu.height, CAMERA.menu.back);
    this.compileAll();
  }

  /** The suburban line this run shows. */
  get line(): LineId {
    return this.side.line;
  }

  /** Switches the line whose station names the platforms show (a live settings change). */
  setLine(line: LineId): void {
    this.side.setLine(line);
  }

  /**
   * The player's comfort settings: `motion` drops the camera shake, roll, FOV pulse and speed
   * lines, `effects` stops the particle emitters. Both are also a cheap win on a weak GPU.
   */
  setReduced(o: { motion?: boolean; effects?: boolean }): void {
    this.fx.setReduced(o);
  }

  /**
   * The equipped character and hoverboard (src/app/progression.ts). Each is built once per id and
   * swapped in place; passing the same ids again does nothing, so this is safe to call every frame.
   */
  setSkins(skins: { character?: { id: string; palette?: RunnerPalette } | null; board?: { id: string; palette?: BoardPalette } | null }): void {
    const c = skins.character ?? null;
    if (c && c.id !== this.characterSkin) {
      this.characterSkin = c.id;
      const next = createRunner({ skin: c });
      next.root.position.copy(this.runner.root.position);
      next.root.visible = this.runner.root.visible;
      this.scene.remove(this.runner.root);
      this.scene.add(next.root);
      this.runner = next;
    }
    const b = skins.board ?? null;
    if (b && b.id !== this.boardSkin) {
      this.boardSkin = b.id;
      const next = buildHoverboard(b);
      next.position.copy(this.board.position);
      next.rotation.copy(this.board.rotation);
      next.visible = this.board.visible;
      this.scene.remove(this.board);
      this.scene.add(next);
      this.board = next;
    }
  }

  // ---------------------------------------------------------------- the intro cinematic

  /** The intro is on screen and owns the camera. */
  get introPlaying(): boolean {
    return this.intro !== null;
  }

  /** The beat being shown, 1..4, or 0 when no intro is running. */
  get introBeat(): number {
    return this.intro?.beat ?? 0;
  }

  /** Seconds into the cinematic, 0 when none is running. */
  get introTime(): number {
    return this.intro?.time ?? 0;
  }

  /**
   * Starts the intro cinematic. The game's own characters are hidden for its duration — the
   * cinematic brings its own kid and TT — and the camera track ends exactly at this view's
   * running camera, so `endIntro` can swap one for the other inside a single frame.
   */
  startIntro(o: { seed?: number; variant?: number } = {}): void {
    if (this.intro) return;
    this.intro = createIntro({
      scene: this.scene,
      camera: this.camera,
      seed: o.seed,
      variant: o.variant,
      handover: { height: CAMERA.height, back: CAMERA.back, lookAhead: CAMERA.lookAhead, lookHeight: CAMERA.lookHeight, fov: CAMERA.fov },
    });
    this.runner.root.visible = false;
    this.board.visible = this.rocket.visible = this.tt.root.visible = this.dog.root.visible = false;
    this.fx.reset();
  }

  /** Skip: jumps to the last frame. The next `advanceIntro` reports it done. */
  skipIntro(): void {
    this.intro?.skip();
  }

  /** Advances the intro by `dt`. False once it has played out (then call `endIntro`). */
  advanceIntro(dt: number): boolean {
    const intro = this.intro;
    if (!intro) return false;
    return intro.update(Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0);
  }

  /** Draws the intro frame (the cinematic owns the camera; the game is not read at all). */
  renderIntro(): void {
    if (!this.intro) return;
    const cam = this.camera;
    // Belt and braces: the cinematic brings its own kid and TT, and the game's are never in shot.
    this.runner.root.visible = false;
    this.board.visible = this.rocket.visible = this.tt.root.visible = this.dog.root.visible = false;
    this.sky.position.copy(cam.position);
    this.skyline.position.copy(cam.position);
    this.bed.update(0);
    this.ohe.update(0);
    this.side.update(0);
    this.sun.target.position.set(0, 0, -2);
    this.sun.position.copy(this.sun.target.position).add(SUN_OFFSET);
    this.renderer.render(this.scene, cam);
  }

  /**
   * Hands the run back the camera. The real runner and chaser are put exactly where the game
   * wants them *before* the cinematic is torn down, so the handover costs no visible frame, and
   * the camera is left un-damped so the first game frame snaps to the pose the intro ended on.
   */
  endIntro(g: Game): void {
    const intro = this.intro;
    if (!intro) return;
    this.runner.root.visible = true;
    this.updateCharacters(g, 0);
    this.camReady = false;
    this.intro = null;
    intro.dispose();
  }

  /**
   * The station of the platform the runner is at or approaching (for a "Next station" HUD).
   * Stable object per station; `en` is the English name, `mr` the Marathi.
   */
  get currentStation(): Station {
    return this.side.stationAt(this.trackS);
  }

  get stats(): { calls: number; triangles: number; pixelRatio: number } {
    const i = this.renderer.info.render;
    return { calls: i.calls, triangles: i.triangles, pixelRatio: this.renderer.getPixelRatio() };
  }

  /** Pool diagnostics (objects built; built on demand during play). */
  get poolStats(): { built: number; misses: number } {
    return {
      built: this.obstaclePool.built + this.pickupPool.built,
      misses: this.obstaclePool.misses + this.pickupPool.misses,
    };
  }

  resize(width: number, height: number, dpr: number): void {
    this.renderer.setPixelRatio(Math.min(dpr, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(g: Game, dtSec: number, events: readonly GameEvent[] = NO_EVENTS): void {
    const dt = Number.isFinite(dtSec) ? Math.min(Math.max(dtSec, 0), 0.1) : 0;
    const animDt = g.state === 'paused' ? 0 : dt;
    this.clock += animDt;
    this.stamp++;

    if (g.track !== this.track) {
      this.track = g.track;
      this.passed.clear();
      this.obstacles.sweep(-1, (a) => this.releaseObstacle(a));
      this.pickups.sweep(-1, (a) => this.releasePickup(a));
    }
    this.handleEvents(g, events);
    this.prevState = g.state;

    const r = g.runner;
    this.runnerPos.set(r.x, r.y, 0);

    this.updateCharacters(g, animDt);
    this.updateCamera(g, dt);

    const f = this.fxFrame;
    f.speed = g.state === 'playing' ? g.speed : 0;
    f.flying = r.flying;
    f.magnet = g.powerups.magnet > 0;
    f.josh = g.josh.active;
    this.fx.onEvents(events, this.runnerPos);
    const out = this.fx.update(animDt, f);
    const cam = this.camera;
    cam.position.copy(this.camPos).add(out.shake);
    cam.lookAt(this.camLook);
    cam.rotateZ(out.roll);
    const fov = CAMERA.fov + out.fovDelta;
    if (cam.fov !== fov) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    this.sky.position.copy(cam.position);
    this.skyline.position.copy(cam.position);

    this.trackS = g.s;
    this.bed.update(g.s);
    this.ohe.update(g.s);
    this.side.update(g.s);
    this.updateObstacles(g);
    this.updateCoins(g);
    this.updatePickups(g);

    // Tight shadow frustum around the runner.
    this.sun.target.position.set(this.camPos.x, this.standY, -7);
    this.sun.position.copy(this.sun.target.position).add(SUN_OFFSET);

    this.renderer.render(this.scene, cam);
  }

  dispose(): void {
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- setup

  private get termini(): readonly string[] {
    return LINES[this.side.line].termini;
  }

  private prewarm(): void {
    const lengths = trainLengths(CHUNKS);
    for (const kind of Object.keys(OBSTACLES) as ObstacleKind[]) {
      const n = OBSTACLE_VARIANTS[kind];
      const lens = isTrain(kind) ? lengths[kind as 'trainParked' | 'trainMoving'] : [OBSTACLES[kind].length];
      if (lens.length === 0) lens.push(OBSTACLES[kind].length);
      for (const len of lens) {
        for (let v = 0; v < n; v++) {
          const key = obstacleKey(kind, v, len);
          // Small props can repeat within one chunk (a row of banners), so keep two ready.
          this.obstaclePool.warm(key, () => pooled(buildObstacle(kind, v, len, this.termini), isTrain(kind)), isTrain(kind) ? 1 : 2);
        }
      }
    }
    for (const kind of ['magnet', 'rocket', 'chappal'] as PowerupKind[]) {
      this.pickupPool.warm(kind, () => pooled(buildPickup(kind)), 1);
    }
  }

  /** Compile every shader up front (pooled objects shown once, far away) so play never hitches. */
  private compileAll(): void {
    const kids = this.obstacleRoot.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].visible = true;
      kids[i].position.set(0, 0, -30);
    }
    this.board.visible = this.rocket.visible = this.tt.root.visible = this.dog.root.visible = true;
    this.coins.count = 1;
    this.side.update(0); // shows the first station's name boards, so their shader compiles too
    this.renderer.compile(this.scene, this.camera);
    for (let i = 0; i < kids.length; i++) kids[i].visible = false;
    this.board.visible = this.rocket.visible = this.tt.root.visible = this.dog.root.visible = false;
    this.coins.count = 0;
  }

  // ---------------------------------------------------------------- per frame

  private handleEvents(g: Game, events: readonly GameEvent[]): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'stumble') this.stumbleLeft = STUMBLE_SECONDS;
      else if (e.type === 'jump') {
        const p = g.powerups.chappal > 0 ? CHAPPAL_JUMP : NORMAL_JUMP;
        this.jumpLaunch = (4 * p.height) / p.seconds;
      } else if (e.type === 'state' && e.state === 'countdown' && (this.prevState === 'menu' || this.prevState === 'summary')) {
        this.fx.reset();
        this.stumbleLeft = 0;
      }
    }
  }

  private updateCharacters(g: Game, dt: number): void {
    const r = g.runner;
    const p = g.powerups;
    const playing = g.state === 'playing' || g.state === 'paused';
    this.stumbleLeft = Math.max(0, this.stumbleLeft - dt);

    const look = this.look;
    look.state = g.state;
    look.flying = r.flying;
    look.airborne = r.airborne && !r.flying;
    look.rolling = r.rolling;
    look.hoverboard = playing && p.hoverboard > 0;
    look.stumbling = this.stumbleLeft > 0;
    const action = runnerAction(look);

    if (!r.airborne) this.jumpLaunch = 0;
    const launch = this.jumpLaunch > 0 ? this.jumpLaunch : (4 * NORMAL_JUMP.height) / NORMAL_JUMP.seconds;
    const st = this.runnerState;
    st.action = action;
    st.speed = playing ? g.speed : 0;
    st.lean = playing ? laneLean(r.x, r.lane) : 0;
    st.airborneT = look.airborne ? (this.jumpLaunch > 0 ? airborneProgress(r.vy, launch) : Math.max(0.5, airborneProgress(r.vy, launch))) : 0;

    const root = this.runner.root;
    root.position.set(r.x, r.y, 0);
    this.runner.update(dt, st);
    // Blink while invulnerable after a hoverboard save.
    root.visible = p.grace <= 0 || r.flying || Math.floor(this.clock * 14) % 2 === 0;

    // Hoverboard under the feet (the rig lifts itself in hover).
    const board = this.board;
    board.visible = look.hoverboard && root.visible;
    if (board.visible) {
      const hover = action === 'hover';
      board.position.set(r.x, r.y + (hover ? 0.2 + 0.03 * Math.sin(this.clock * Math.PI * 2) : 0.06), 0.05);
      board.rotation.set(0, 0, -st.lean * 0.3);
    }

    // Diwali rocket ridden like a jetpack.
    this.rocket.visible = r.flying;
    if (r.flying) {
      this.rocket.position.set(r.x, r.y + 0.75, 0.32);
      this.rocket.rotation.set(0.35 + 0.05 * Math.sin(this.clock * 30), 0, 0.04 * Math.sin(this.clock * 23));
    }

    // TT and dog.
    const caught = g.state === 'caught' || g.state === 'summary';
    const show = caught || (g.chaser.visible && g.state !== 'menu');
    this.tt.root.visible = this.dog.root.visible = show;
    if (!show) {
      this.chaserX = r.x;
      return;
    }
    this.chaserX += (r.x - this.chaserX) * damp(caught ? 12 : 4, dt);
    const gap = g.chaser.gap;
    const cs = this.chaserState;
    cs.action = caught ? 'caught' : g.state === 'playing' ? 'run' : 'idle';
    cs.speed = g.state === 'playing' ? g.speed : 0;
    cs.lean = 0;
    if (caught) {
      const away = -this.caughtSide;
      this.tt.root.position.set(this.chaserX + away * 0.4, 0, gap + 0.1);
      this.dog.root.position.set(this.chaserX + away * 1.25, 0, gap - 0.9);
    } else {
      this.tt.root.position.set(this.chaserX - 0.85, 0, gap);
      this.dog.root.position.set(this.chaserX + 0.95, 0, gap - 0.7);
    }
    this.tt.update(dt, cs);
    this.dog.update(dt, cs);
  }

  private updateCamera(g: Game, dt: number): void {
    const r = g.runner;
    const st = g.state;
    const k = this.camReady ? damp(CAMERA.rate, dt) : 1;
    // Height the runner stands on (train roof, rocket altitude), followed more than a jump arc.
    if (!r.airborne || r.flying) this.standY += (r.y - this.standY) * (this.camReady ? damp(CAMERA.standRate, dt) : 1);
    if (r.y < this.standY) this.standY = Math.max(r.y, this.standY - 12 * dt);
    const jump = Math.max(0, r.y - this.standY);

    let height: number = CAMERA.height;
    let back: number = CAMERA.back;
    let ahead: number = CAMERA.lookAhead;
    let lookH: number = CAMERA.lookHeight;
    let dx = 0;
    let lookDx = 0;
    const caught = st === 'caught' || st === 'summary';
    const shot = st === 'menu' ? CAMERA.menu : caught ? CAMERA.caught : null;
    if (shot) ({ height, back, lookAhead: ahead, lookHeight: lookH, x: dx, lookX: lookDx } = shot);
    if (caught) dx *= this.caughtSide;
    else this.caughtSide = r.x > 0.1 ? -1 : 1;

    const lift = this.standY * CAMERA.standFollow + jump * CAMERA.jumpFollow;
    const x = caught ? r.x : r.x * CAMERA.laneFollow;
    this.camPosTarget.set(x + dx, height + lift, back);
    this.camLookTarget.set(x + lookDx, lookH + lift, -ahead);
    const kk = st === 'menu' || st === 'caught' || st === 'summary' ? damp(3, dt) : k;
    this.camPos.lerp(this.camPosTarget, this.camReady ? kk : 1);
    this.camLook.lerp(this.camLookTarget, this.camReady ? kk : 1);
    this.camReady = true;
  }

  private updateObstacles(g: Game): void {
    const s = g.s;
    const stamp = this.stamp;
    for (const o of g.track.obstacles) {
      const z = -(o.front - s);
      if (z < -VIEW_AHEAD || z - o.length > VIEW_BEHIND) continue;
      let a = this.obstacles.get(o.id);
      if (!a) {
        const variant = obstacleVariant(o.kind, o.id);
        const key = obstacleKey(o.kind, variant, o.length);
        const item = this.obstaclePool.acquire(key, () => pooled(buildObstacle(o.kind, variant, o.length, this.termini), isTrain(o.kind)));
        item.root.visible = true;
        const sz = o.kind === 'ramp' ? o.length / OBSTACLES.ramp.length : 1;
        item.root.scale.set(1, 1, sz);
        a = { id: o.id, key, item, stamp };
        this.obstacles.add(a);
      }
      a.stamp = stamp;
      a.item.root.position.set(laneX(o.lane), 0, z);
      setNear(a.item, z > -LOD_FAR);
      // A moving local draws level with the runner: report it once, as loud as it went near.
      if (this.onTrainPass && o.kind === 'trainMoving' && z >= 0 && !this.passed.has(o.id)) {
        this.passed.add(o.id);
        this.onTrainPass(trainCloseness(laneX(o.lane), g.runner.x));
      }
    }
    this.obstacles.sweep(stamp, (a) => this.releaseObstacle(a));
  }

  private releaseObstacle(a: Active): void {
    a.item.root.visible = false;
    this.obstaclePool.release(a.key, a.item);
  }

  private releasePickup(a: Active): void {
    a.item.root.visible = false;
    this.pickupPool.release(a.key, a.item);
  }

  private updateCoins(g: Game): void {
    const t = this.tmp;
    const r = g.runner;
    const magnet = g.powerups.magnet > 0;
    const spin = this.clock * Math.PI;
    const bob = Math.sin(this.clock * Math.PI * 2);
    let n = 0;
    for (const c of g.track.coins) {
      if (c.taken) continue;
      const ahead = c.s - g.s;
      if (ahead > VIEW_AHEAD || ahead < -VIEW_BEHIND) continue;
      if (n >= MAX_COINS) break;
      let x = laneX(c.lane);
      let y = c.y + 0.12 + 0.05 * bob;
      let z = -ahead;
      if (magnet && ahead > 0 && ahead < MAGNET_PULL_RANGE) {
        const u = 1 - ahead / MAGNET_PULL_RANGE;
        const pull = u * u * (3 - 2 * u);
        x += (r.x - x) * pull;
        y += (r.y + 1 - y) * pull;
        z *= 1 - 0.6 * pull;
      }
      t.position.set(x, y, z);
      t.rotation.set(0, spin + c.s * 0.05, 0);
      t.updateMatrix();
      this.coins.setMatrixAt(n++, t.matrix);
    }
    this.coins.count = n;
    this.coinOutlines.count = n;
    this.coins.instanceMatrix.needsUpdate = true;
  }

  private updatePickups(g: Game): void {
    const stamp = this.stamp;
    for (const p of g.track.pickups) {
      if (p.taken) continue;
      const ahead = p.s - g.s;
      if (ahead > VIEW_AHEAD || ahead < -VIEW_BEHIND) continue;
      let a = this.pickups.get(p.id);
      if (!a) {
        const kind = p.kind;
        const item = this.pickupPool.acquire(kind, () => pooled(buildPickup(kind)));
        item.root.visible = true;
        a = { id: p.id, key: kind, item, stamp };
        this.pickups.add(a);
      }
      a.stamp = stamp;
      const root = a.item.root;
      root.position.set(laneX(p.lane), 1 + 0.12 * Math.sin(this.clock * 3 + p.id), -ahead);
      root.rotation.y = this.clock * 2.2;
      setNear(a.item, ahead < LOD_FAR);
    }
    this.pickups.sweep(stamp, (a) => this.releasePickup(a));
  }
}

