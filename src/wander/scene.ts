/**
 * Wander's three.js scene: the city streamed in around the walker, the railway with its passing
 * local, the avatar, a follow camera, sky and light. It shares the game's renderer (and canvas);
 * everything it draws is its own.
 *
 * Draw calls stay low because the city is instanced: every kind of building, tree, wall and so on
 * is one InstancedMesh per material, filled from the chunk plans around the walker whenever the
 * walker crosses into a new chunk — a few hundred matrices, not per frame.
 */
import * as THREE from 'three';
import { createRunner, type CharacterRig, type RunnerPalette } from '../world/models/characters';
import {
  SKY_HORIZON,
  buildBillboard,
  buildChawl,
  buildParkedAuto,
  buildPlatform,
  buildSkyDome,
  buildSkyline,
  buildTree,
  buildWall,
  platformBoardGeometry,
} from '../world/models/scenery';
import { createCatenary, createTrackBed, type Catenary, type TrackBed } from '../world/models/trackKit';
import { buildTrain } from '../world/models/trains';
import { curveUniforms } from '../world/render/materials';
import { stationBoardMaterial } from '../world/models/stationBoards';
import { LINES, stationForPlatform, type LineId } from '../world/stations';
import {
  AUTO_VARIANTS_IN_USE,
  BILLBOARD_VARIANTS_IN_USE,
  CHAWL_VARIANTS_IN_USE,
  CHUNK,
  CityIndex,
  PLATFORM_LENGTH,
  TRACK_X,
  TREE_VARIANTS_IN_USE,
  WALL_LONG,
  WALL_VARIANTS_IN_USE,
  WALL_SHORT,
  groundHeight,
  type ChunkPlan,
  type Prop,
  type PropKind,
  type TileKind,
} from './city';
import { rampGeometry, rampMaterial, tileGeometry, tileMaterial } from './tiles';
import { TrainTimetable, passCloseness, type TrainPass } from './trains';
import { CAMERA, stepFollowCamera, createFollowCamera, damp, type FollowCamera, type WalkerState } from './walker';

/** Chunks loaded each way from the walker's: a 5 x 5 patch, never less than 128 m of city in sight. */
export const LOAD_RADIUS = 2;
const CHAWL_LOOKS = CHAWL_VARIANTS_IN_USE;
const TREE_LOOKS = TREE_VARIANTS_IN_USE;
const AUTO_LOOKS = AUTO_VARIANTS_IN_USE;
const BILLBOARD_LOOKS = BILLBOARD_VARIANTS_IN_USE;
const WALL_LOOKS = WALL_VARIANTS_IN_USE;
const FOG_NEAR = 45;
const FOG_FAR = 135;
/** Rough radius of each kind of prop (m): a prop whose near edge is past the fog is not drawn. */
const REACH: Record<PropKind, number> = { chawl: 14, tree: 4.5, auto: 3.5, billboard: 5, wallLong: 14, wallShort: 6, platform: 33, ramp: 3 };
/** The instance buffers are refilled when the walker has moved this far since the last time. */
const REFILL_DISTANCE = 8;
const TRAIN_LENGTH = 104;
const SUN_OFFSET = new THREE.Vector3(-7, 15, 9);
const TILE_KINDS: TileKind[] = ['block', 'park', 'yard', 'yardCrossN', 'yardCrossS', 'station'];

type PartList = { geometry: THREE.BufferGeometry; material: THREE.Material }[];

/** The meshes of a built model group, as geometry + material pairs ready to instance. */
function partsOf(group: THREE.Group): PartList {
  const parts: PartList = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) parts.push({ geometry: m.geometry, material: m.material as THREE.Material });
  });
  return parts;
}

/** One kind of prop (a chawl look, a tree): an InstancedMesh per material. */
class InstancedKind {
  readonly meshes: THREE.InstancedMesh[] = [];
  private count = 0;
  private cap = 0;

  constructor(
    private readonly parent: THREE.Group,
    private readonly parts: PartList,
    private readonly receive: boolean,
    private readonly name: string,
  ) {}

  /** Sizes the meshes for `n` instances (growing, never shrinking) and starts a fresh fill. */
  begin(n: number): void {
    if (n > this.cap) {
      for (const m of this.meshes) {
        this.parent.remove(m);
        m.dispose();
      }
      this.meshes.length = 0;
      this.cap = Math.max(8, Math.ceil(n * 1.5));
      for (const p of this.parts) {
        const mesh = new THREE.InstancedMesh(p.geometry, p.material, this.cap);
        mesh.name = `${this.name}:${p.material.name}`;
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = this.receive;
        this.meshes.push(mesh);
        this.parent.add(mesh);
      }
    }
    this.count = 0;
    for (const m of this.meshes) m.count = 0;
  }

  /** Something is placed: its meshes are drawing. */
  get live(): boolean {
    return this.count > 0;
  }

  add(matrix: THREE.Matrix4): void {
    if (this.count >= this.cap) return;
    for (const m of this.meshes) m.setMatrixAt(this.count, matrix);
    this.count++;
  }

  end(): void {
    for (const m of this.meshes) {
      m.count = this.count;
      m.visible = this.count > 0;
      m.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const m of this.meshes) {
      this.parent.remove(m);
      m.dispose();
    }
    this.meshes.length = 0;
  }
}

export interface WanderSceneOptions {
  renderer: THREE.WebGLRenderer;
  seed: number;
  line: LineId;
  skin?: { id: string; palette?: RunnerPalette } | null;
  /** The local has drawn level with the walker: for the audio cue. */
  onTrainPass?: (closeness: number) => void;
}

export interface WanderStats {
  calls: number;
  triangles: number;
  pixelRatio: number;
  chunks: number;
}

/** What the scene needs of the walker each frame. */
export interface WanderFrame {
  walker: WalkerState;
  follow: FollowCamera;
  /** Seconds since the last frame (0 while paused: the world holds still, the camera still draws). */
  dt: number;
}

const scratch = new THREE.Object3D();

export class WanderScene {
  readonly city: CityIndex;
  readonly timetable: TrainTimetable;
  readonly camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.1, 900);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: THREE.Mesh;
  private readonly skyline: THREE.Mesh;
  private readonly cityRoot = new THREE.Group();
  private readonly kinds = new Map<string, InstancedKind>();
  private readonly tiles = new Map<TileKind, InstancedKind>();
  private readonly bed: TrackBed;
  private readonly ohe: Catenary;
  private readonly railRoot = new THREE.Group();
  private readonly trains: [THREE.Group, THREE.Group];
  private readonly boards: THREE.Mesh[] = [];
  private readonly boardGeometry: THREE.BufferGeometry;
  private readonly tileGeo: THREE.BufferGeometry;
  private readonly rampGeo: THREE.BufferGeometry;
  private avatar: CharacterRig;
  private avatarY = 0;
  private skinId: string;
  private readonly onTrainPass: ((closeness: number) => void) | null;
  private line: LineId;
  private centre = '';
  private loaded: ChunkPlan[] = [];
  private builtX = 0;
  private builtZ = 0;
  private lastCalls = 0;

  constructor(o: WanderSceneOptions) {
    this.renderer = o.renderer;
    this.line = o.line;
    this.onTrainPass = o.onTrainPass ?? null;
    this.city = new CityIndex(o.seed);
    this.timetable = new TrainTimetable(o.seed, TRAIN_LENGTH);

    const horizon = new THREE.Color(SKY_HORIZON);
    this.scene.background = horizon;
    this.scene.fog = new THREE.Fog(horizon, FOG_NEAR, FOG_FAR);
    this.scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6b5b4a, 1.15));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff1d6, 2.7));
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 12, bottom: -12, near: 6, far: 50 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);

    this.sky = buildSkyDome();
    this.skyline = buildSkyline();
    this.scene.add(this.sky, this.skyline);

    this.cityRoot.name = 'wander-city';
    this.scene.add(this.cityRoot);
    this.tileGeo = tileGeometry();
    this.rampGeo = rampGeometry();
    const tileCap = (2 * LOAD_RADIUS + 1) ** 2;
    for (const kind of TILE_KINDS) {
      const k = new InstancedKind(this.cityRoot, [{ geometry: this.tileGeo, material: tileMaterial(kind) }], true, `tile:${kind}`);
      k.begin(tileCap);
      k.end();
      this.tiles.set(kind, k);
    }

    // The railway: ballast, rails and sleepers, and the overhead wires, along the line of x = TRACK_X.
    this.scene.add(this.railRoot);
    this.bed = createTrackBed(FOG_FAR + 5, FOG_FAR + 5);
    // The kit's own ground plane would cover the city's streets: the tiles are the ground here.
    for (const m of this.bed.meshes) if (m.name === 'ground') m.visible = false;
    this.ohe = createCatenary({ behind: FOG_FAR + 5, ahead: FOG_FAR + 5 });
    for (const m of this.ohe.meshes) m.castShadow = false;
    this.railRoot.add(this.bed.root, this.ohe.root);

    const livery = o.line === 'western' ? 'western' : 'central';
    const termini = LINES[o.line].termini;
    const mk = (seed: number, rotY: number): THREE.Group => {
      const g = buildTrain(TRAIN_LENGTH, { livery, seed, oncoming: true, destinations: termini });
      const holder = new THREE.Group();
      g.rotation.y = rotY;
      holder.add(g);
      holder.visible = false;
      this.scene.add(holder);
      return holder;
    };
    // The model's cab faces +z; a train heading north is turned round.
    this.trains = [mk(1, 0), mk(2, Math.PI)];

    this.boardGeometry = platformBoardGeometry(PLATFORM_LENGTH);

    this.skinId = o.skin?.id ?? '';
    this.avatar = this.makeAvatar(o.skin ?? null);
    this.scene.add(this.avatar.root);

    this.camera.position.set(0, 4, 8);
  }

  private makeAvatar(skin: WanderSceneOptions['skin']): CharacterRig {
    const rig = createRunner(skin ? { skin } : {});
    rig.root.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh && !mesh.userData.isOutline) mesh.castShadow = true;
    });
    return rig;
  }

  /** Changes the avatar's outfit (the shop's equipped character). A repeat of the same id does nothing. */
  setSkin(skin: { id: string; palette?: RunnerPalette } | null): void {
    const id = skin?.id ?? '';
    if (id === this.skinId) return;
    this.skinId = id;
    const next = this.makeAvatar(skin);
    next.root.position.copy(this.avatar.root.position);
    next.root.rotation.copy(this.avatar.root.rotation);
    this.scene.remove(this.avatar.root);
    this.scene.add(next.root);
    this.avatar = next;
  }

  /** Which suburban line the station boards name (a live settings change). */
  setLine(line: LineId): void {
    if (line === this.line) return;
    this.line = line;
    this.centre = ''; // rebuild the boards on the next frame
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  get stats(): WanderStats {
    const i = this.renderer.info.render;
    return { calls: this.lastCalls || i.calls, triangles: i.triangles, pixelRatio: this.renderer.getPixelRatio(), chunks: this.loaded.length };
  }

  /** The curve is the runner's horizon bend; a walked city is flat. Call on the way in and out. */
  setCurve(on: boolean): void {
    curveUniforms.uCurveEnabled.value = on ? 1 : 0;
  }

  // ---------------------------------------------------------------- the city, streamed

  private kind(prop: PropKind, variant: number): InstancedKind {
    const key = `${prop}:${variant}`;
    let k = this.kinds.get(key);
    if (!k) {
      let parts: PartList;
      let receive = false;
      switch (prop) {
        case 'chawl':
          parts = partsOf(buildChawl(variant));
          break;
        case 'tree':
          parts = partsOf(buildTree(variant));
          break;
        case 'auto':
          parts = partsOf(buildParkedAuto(variant));
          break;
        case 'billboard':
          parts = partsOf(buildBillboard(variant));
          break;
        case 'wallLong':
          parts = partsOf(buildWall(WALL_LONG, variant));
          receive = true;
          break;
        case 'wallShort':
          parts = partsOf(buildWall(WALL_SHORT, variant));
          receive = true;
          break;
        case 'platform':
          parts = partsOf(buildPlatform(PLATFORM_LENGTH, 0, null));
          receive = true;
          break;
        case 'ramp':
          parts = [{ geometry: this.rampGeo, material: rampMaterial() }];
          receive = true;
          break;
      }
      k = new InstancedKind(this.cityRoot, parts, receive, key);
      this.kinds.set(key, k);
    }
    return k;
  }

  /** Fills every instanced mesh from the plans of the chunks around the walker. */
  private rebuild(chunks: ChunkPlan[], wx: number, wz: number): void {
    const shown = (p: Prop): boolean => Math.hypot(p.x - wx, p.z - wz) - REACH[p.kind] < FOG_FAR;
    const counts = new Map<string, number>();
    const tileCounts = new Map<TileKind, number>();
    for (const c of chunks) {
      tileCounts.set(c.tile, (tileCounts.get(c.tile) ?? 0) + 1);
      for (const p of c.props) {
        if (!shown(p)) continue;
        const key = `${p.kind}:${p.variant}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    // Kinds seen before but absent now are emptied, so nothing stale stays on screen.
    for (const [key, k] of this.kinds) {
      if (counts.has(key)) continue;
      k.begin(0);
      k.end();
    }
    const open = new Map<string, InstancedKind>();
    for (const [key, n] of counts) {
      const [prop, variant] = key.split(':');
      const k = this.kind(prop as PropKind, Number(variant));
      k.begin(n);
      open.set(key, k);
    }
    const tileOpen = new Map<TileKind, InstancedKind>();
    for (const kind of TILE_KINDS) {
      const k = this.tiles.get(kind)!;
      k.begin((2 * LOAD_RADIUS + 1) ** 2);
      tileOpen.set(kind, k);
    }

    let board = 0;
    for (const c of chunks) {
      scratch.position.set(c.cx * CHUNK, 0, c.cz * CHUNK);
      scratch.rotation.set(0, 0, 0);
      scratch.updateMatrix();
      tileOpen.get(c.tile)?.add(scratch.matrix);
      for (const p of c.props) {
        if (!shown(p)) continue;
        scratch.position.set(p.x, 0, p.z);
        scratch.rotation.set(0, p.rotY, 0);
        scratch.updateMatrix();
        open.get(`${p.kind}:${p.variant}`)?.add(scratch.matrix);
        if (p.kind === 'platform' && c.station !== null) this.placeBoard(board++, p, c.station);
      }
    }
    for (const k of open.values()) k.end();
    for (const k of tileOpen.values()) k.end();
    for (let i = board; i < this.boards.length; i++) this.boards[i].visible = false;
  }

  /** The station's name board stands on its own mesh: each station's board shows its own name. */
  private placeBoard(i: number, p: Prop, platformNumber: number): void {
    const material = stationBoardMaterial(stationForPlatform(this.line, platformNumber));
    let mesh = this.boards[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.boardGeometry, material);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.boards.push(mesh);
      this.cityRoot.add(mesh);
    }
    mesh.material = material;
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.set(0, p.rotY, 0);
    mesh.visible = true;
  }

  // ---------------------------------------------------------------- per frame

  /**
   * Places the walker and the camera, advances the train and the stride, and draws. `dt` is 0 while
   * paused: the avatar and train hold still but the frame is still drawn.
   */
  update(f: WanderFrame): TrainPass | null {
    const { walker: w, dt } = f;
    const cx = Math.floor(w.x / CHUNK);
    const cz = Math.floor(w.z / CHUNK);
    const centre = `${cx},${cz},${this.line}`;
    if (centre !== this.centre || Math.hypot(w.x - this.builtX, w.z - this.builtZ) > REFILL_DISTANCE) {
      this.centre = centre;
      this.builtX = w.x;
      this.builtZ = w.z;
      this.loaded = this.city.chunksAround(w.x, w.z, LOAD_RADIUS);
      this.rebuild(this.loaded, w.x, w.z);
    }

    // The railway follows the walker along z (the kit works in a window around a position).
    const near = Math.abs(w.x - TRACK_X) < FOG_FAR + 8;
    this.railRoot.visible = near;
    if (near) {
      this.railRoot.position.set(TRACK_X, 0, 0);
      this.bed.root.position.z = w.z;
      this.ohe.root.position.z = w.z;
      this.bed.update(-w.z);
      this.ohe.update(-w.z);
    }

    const pass = this.timetable.update(dt, w.x, w.z);
    const t = this.timetable.state;
    this.trains[0].visible = t.active && t.dir > 0;
    this.trains[1].visible = t.active && t.dir < 0;
    if (t.active) {
      const g = this.trains[t.dir > 0 ? 0 : 1];
      g.position.set(t.x, 0, t.frontZ);
    }
    if (pass) this.onTrainPass?.(passCloseness(pass.dx));

    // The avatar: feet on the ground (platforms and ramps are higher), stride from the real speed.
    const targetY = groundHeight(w.x, w.z);
    this.avatarY += (targetY - this.avatarY) * damp(14, Math.max(dt, 1 / 120));
    const root = this.avatar.root;
    root.position.set(w.x, this.avatarY, w.z);
    root.rotation.y = -w.heading;
    const moving = w.speed > 0.35;
    const stride = Math.min(1.3, Math.max(0.5, w.speed / 6.2));
    this.avatar.update(dt * (moving ? stride : 1), { action: moving ? 'run' : 'idle', speed: moving ? 12 : 0, lean: 0 });

    // The camera: behind along the damped yaw, lower when a wall has pulled it in close.
    const cam = f.follow;
    const k = cam.distance / CAMERA.distance;
    const bx = -Math.sin(cam.yaw);
    const bz = Math.cos(cam.yaw);
    const height = 1.6 + (CAMERA.height - 1.6) * k;
    this.camera.position.set(w.x + bx * cam.distance, this.avatarY + height, w.z + bz * cam.distance);
    this.camera.lookAt(w.x - bx * CAMERA.lookAhead * k, this.avatarY + CAMERA.lookHeight, w.z - bz * CAMERA.lookAhead * k);

    this.sky.position.copy(this.camera.position);
    this.skyline.position.copy(this.camera.position);
    this.sun.target.position.set(w.x, this.avatarY, w.z);
    this.sun.position.copy(this.sun.target.position).add(SUN_OFFSET);
    return pass;
  }

  /** Draws one frame and records its cost. */
  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.lastCalls = this.renderer.info.render.calls;
  }

  /**
   * Builds every kind of prop the city can show and compiles every shader, with a train on screen,
   * so walking never hitches on a new building or the first train.
   */
  warm(w: WalkerState): void {
    this.centre = '';
    this.update({ walker: w, follow: createFollowCamera(w.heading), dt: 0 });
    const kinds: [PropKind, number][] = [
      ...Array.from({ length: CHAWL_LOOKS }, (_, v): [PropKind, number] => ['chawl', v]),
      ...Array.from({ length: TREE_LOOKS }, (_, v): [PropKind, number] => ['tree', v]),
      ...Array.from({ length: AUTO_LOOKS }, (_, v): [PropKind, number] => ['auto', v]),
      ...Array.from({ length: BILLBOARD_LOOKS }, (_, v): [PropKind, number] => ['billboard', v]),
      ...Array.from({ length: WALL_LOOKS }, (_, v): [PropKind, number] => ['wallLong', v]),
      ['wallShort', 0],
      ['platform', 0],
      ['ramp', 0],
    ];
    // One instance of each, far under the ground, shown just for the compile.
    scratch.position.set(w.x, -50, w.z);
    scratch.rotation.set(0, 0, 0);
    scratch.updateMatrix();
    const shown: InstancedKind[] = [];
    for (const [prop, variant] of kinds) {
      const k = this.kind(prop, variant);
      if (k.live) continue;
      k.begin(1);
      k.add(scratch.matrix);
      k.end();
      shown.push(k);
    }
    for (const t of this.trains) {
      t.visible = true;
      t.position.set(TRACK_X, -50, w.z);
    }
    this.renderer.compile(this.scene, this.camera);
    for (const k of shown) {
      k.begin(0);
      k.end();
    }
    for (const t of this.trains) t.visible = false;
  }
  dispose(): void {
    for (const k of this.kinds.values()) k.dispose();
    for (const k of this.tiles.values()) k.dispose();
    this.tileGeo.dispose();
    this.rampGeo.dispose();
    this.scene.remove(this.avatar.root);
  }
}
