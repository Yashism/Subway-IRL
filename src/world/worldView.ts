import * as THREE from 'three';
import { LANE_WIDTH, laneX, TUNING } from '../game/config';
import type { Game } from '../game/game';
import { OBSTACLES, type ObstacleKind } from '../game/obstacles';
import type { PowerupKind } from '../game/track';
import { BUILDING_SLOT, buildingAt, repeatingOffsets, type BuildingLook } from './worldMath';

const VIEW_AHEAD = 220;
const VIEW_BEHIND = 12;
const MAX_PIXEL_RATIO = 1.25;
const SLEEPER_SPACING = 1.5;
const MAX_COINS = 400;
const MAX_SLEEPERS = 3 * (Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / SLEEPER_SPACING) + 2);
const MAX_BUILDINGS = 2 * (Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / BUILDING_SLOT) + 2);
const OBSTACLE_WIDTH = 2;
const SKY = 0xf7c59f;
const TRACK_LENGTH = VIEW_AHEAD + VIEW_BEHIND + 40;

const OBSTACLE_COLORS: Record<ObstacleKind, number> = {
  trainParked: 0x9b2d30,
  trainMoving: 0x1f5aa6,
  barrierLow: 0xc8a165,
  handcart: 0x8b5a2b,
  bannerHigh: 0xff6f3c,
  auto: 0xf4c430,
  cow: 0xf1ede4,
  ramp: 0x8a8f96,
};

const PICKUP_COLORS: Record<PowerupKind, number> = {
  magnet: 0xe53935,
  rocket: 0xff9800,
  chappal: 0x8d6e63,
};

/** Floating origin: the runner is always at z = 0 and the track runs toward -z. */
const toZ = (itemS: number, runnerS: number) => -(itemS - runnerS);

function obstacleGeometry(kind: ObstacleKind): THREE.BufferGeometry {
  const info = OBSTACLES[kind];
  if (kind === 'ramp') {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(info.length, 0);
    shape.lineTo(info.length, TUNING.trainHeight);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: OBSTACLE_WIDTH, bevelEnabled: false });
    g.rotateY(Math.PI / 2); // profile x (along the track) -> -z, extrusion -> +x
    g.translate(-OBSTACLE_WIDTH / 2, 0, 0);
    return g;
  }
  const g = new THREE.BoxGeometry(OBSTACLE_WIDTH, info.yMax - info.yMin, 1);
  // Origin at the near end; scaling z by the length stretches it away from the runner.
  g.translate(0, (info.yMax + info.yMin) / 2, -0.5);
  return g;
}

const standard = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });

export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 400);
  private readonly lookAt = new THREE.Vector3(0, 1.2, -14);
  private readonly sun: THREE.DirectionalLight;
  private readonly tmp = new THREE.Object3D();
  private readonly color = new THREE.Color();

  private readonly obstacleGeo = {} as Record<ObstacleKind, THREE.BufferGeometry>;
  private readonly obstacleMat = {} as Record<ObstacleKind, THREE.Material>;
  private readonly obstacleMeshes = new Map<number, THREE.Mesh>();
  private readonly obstaclePool = new Map<ObstacleKind, THREE.Mesh[]>();

  private readonly pickupGeo = new THREE.IcosahedronGeometry(0.45, 1);
  private readonly pickupMeshes = new Map<number, THREE.Mesh>();

  private readonly sleepers: THREE.InstancedMesh;
  private readonly buildings: THREE.InstancedMesh;
  private readonly coins: THREE.InstancedMesh;

  private readonly runner = new THREE.Group();
  private readonly board: THREE.Mesh;
  private readonly flame: THREE.Mesh;
  private readonly chaser = new THREE.Group();
  private clock = 0;

  /** Scratch fields reused per frame so render() allocates nothing (spec §6.4). */
  private readonly camTargetPos = new THREE.Vector3();
  private readonly camTargetLookAt = new THREE.Vector3();
  private readonly seenObstacles = new Set<number>();
  private readonly seenPickups = new Set<number>();
  private readonly sleeperOffsets: number[] = [];
  private readonly buildingScratch: BuildingLook = { height: 0, width: 0, depth: 0, color: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = this.scene;
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 70, VIEW_AHEAD);

    scene.add(new THREE.HemisphereLight(0xfff3e0, 0x7a5c3e, 1.1));
    this.sun = new THREE.DirectionalLight(0xffd7a8, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -14, right: 14, top: 20, bottom: -20, near: 1, far: 70 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0005;
    scene.add(this.sun, this.sun.target);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, TRACK_LENGTH), standard(0xb08a63));
    ground.rotation.x = -Math.PI / 2;
    ground.position.z = -(TRACK_LENGTH / 2 - VIEW_BEHIND - 20);
    ground.receiveShadow = true;
    scene.add(ground);

    const ballastGeo = new THREE.BoxGeometry(LANE_WIDTH * 0.85, 0.12, TRACK_LENGTH);
    const railGeo = new THREE.BoxGeometry(0.08, 0.1, TRACK_LENGTH);
    const ballastMat = standard(0x7a6f66);
    const railMat = standard(0xaab0b6, { metalness: 0.6, roughness: 0.4 });
    for (const lane of [-1, 0, 1]) {
      const ballast = new THREE.Mesh(ballastGeo, ballastMat);
      ballast.position.set(laneX(lane), 0, ground.position.z);
      ballast.receiveShadow = true;
      scene.add(ballast);
      for (const side of [-0.7, 0.7]) {
        const rail = new THREE.Mesh(railGeo, railMat);
        rail.position.set(laneX(lane) + side, 0.16, ground.position.z);
        scene.add(rail);
      }
    }

    this.sleepers = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, 0.08, 0.25), standard(0x5a4632), MAX_SLEEPERS);
    this.sleepers.frustumCulled = false;
    this.sleepers.receiveShadow = true;
    scene.add(this.sleepers);

    this.buildings = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), standard(0xffffff, { roughness: 0.9 }), MAX_BUILDINGS);
    this.buildings.frustumCulled = false;
    this.buildings.castShadow = true;
    this.buildings.receiveShadow = true;
    scene.add(this.buildings);

    const coinGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.08, 20);
    coinGeo.rotateX(Math.PI / 2);
    this.coins = new THREE.InstancedMesh(
      coinGeo,
      standard(0xffc83d, { metalness: 0.7, roughness: 0.3, emissive: 0x6b4a00 }),
      MAX_COINS,
    );
    this.coins.frustumCulled = false;
    scene.add(this.coins);

    for (const kind of Object.keys(OBSTACLES) as ObstacleKind[]) {
      this.obstacleGeo[kind] = obstacleGeometry(kind);
      this.obstacleMat[kind] = standard(OBSTACLE_COLORS[kind], { roughness: 0.6 });
    }

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.8, 4, 12), standard(0xff7a1a, { roughness: 0.5 }));
    body.position.y = 0.78;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), standard(0xc68642));
    head.position.y = 1.62;
    this.board = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.08, 1.8), standard(0x00c2d1, { emissive: 0x004a52 }));
    this.board.position.y = 0.04;
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.9, 12), standard(0xff9800, { emissive: 0xff5a00 }));
    this.flame.rotation.x = Math.PI;
    this.flame.position.set(0, -0.2, 0.3);
    for (const m of [body, head, this.board]) m.castShadow = true;
    this.runner.add(body, head, this.board, this.flame);
    scene.add(this.runner);

    const coat = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.1, 0.5), standard(0x2b2b2b));
    coat.position.y = 0.55;
    const shirt = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.5), standard(0xf5f5f5));
    shirt.position.y = 1.4;
    const ttHead = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), standard(0x8d5524));
    ttHead.position.y = 1.9;
    const dog = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 0.9), standard(0xc49a6c));
    dog.position.set(0.9, 0.35, 0.4);
    for (const m of [coat, shirt, ttHead, dog]) m.castShadow = true;
    this.chaser.add(coat, shirt, ttHead, dog);
    scene.add(this.chaser);

    this.camera.position.set(0, 4.2, 7.5);
  }

  get stats(): { calls: number; triangles: number; pixelRatio: number } {
    const r = this.renderer.info.render;
    return { calls: r.calls, triangles: r.triangles, pixelRatio: this.renderer.getPixelRatio() };
  }

  resize(width: number, height: number, dpr: number): void {
    this.renderer.setPixelRatio(Math.min(dpr, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(g: Game, dtSec: number): void {
    this.clock += dtSec;
    this.updateRunner(g);
    this.updateCamera(g, dtSec);
    this.updateTrack(g.s);
    this.updateObstacles(g);
    this.updateCoins(g);
    this.updatePickups(g);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }

  private updateRunner(g: Game): void {
    const r = g.runner;
    this.runner.position.set(r.x, r.y, 0);
    this.runner.scale.y = r.rolling ? TUNING.rollHeight / TUNING.runnerHeight : 1;
    this.board.visible = g.powerups.hoverboard > 0;
    this.flame.visible = r.flying;
    this.runner.visible = g.powerups.grace <= 0 || Math.floor(this.clock * 12) % 2 === 0;

    const showChaser = g.chaser.visible || g.state === 'caught' || g.state === 'summary';
    this.chaser.visible = showChaser;
    this.chaser.position.set(r.x * 0.8, 0, g.chaser.gap + 0.8);

    this.sun.position.set(r.x - 12, 25, 10);
    this.sun.target.position.set(r.x, 0, -8);
  }

  private updateCamera(g: Game, dtSec: number): void {
    const r = g.runner;
    const k = dtSec > 0 ? 1 - Math.exp(-8 * dtSec) : 1;
    this.camTargetPos.set(r.x * 0.55, 4.2 + r.y * 0.7, 7.5);
    this.camera.position.lerp(this.camTargetPos, k);
    this.camTargetLookAt.set(r.x * 0.55, 1.2 + r.y * 0.7, -14);
    this.lookAt.lerp(this.camTargetLookAt, k);
    this.camera.lookAt(this.lookAt);
  }

  private updateTrack(s: number): void {
    const t = this.tmp;
    t.rotation.set(0, 0, 0);
    t.scale.set(1, 1, 1);
    let n = 0;
    const offsets = repeatingOffsets(s, SLEEPER_SPACING, VIEW_BEHIND, VIEW_AHEAD, this.sleeperOffsets);
    sleeperLoop: for (const ahead of offsets) {
      for (const lane of [-1, 0, 1]) {
        if (n >= MAX_SLEEPERS) break sleeperLoop;
        t.position.set(laneX(lane), 0.06, -ahead);
        t.updateMatrix();
        this.sleepers.setMatrixAt(n++, t.matrix);
      }
    }
    this.sleepers.count = n;
    this.sleepers.instanceMatrix.needsUpdate = true;

    n = 0;
    const first = Math.floor((s - VIEW_BEHIND) / BUILDING_SLOT);
    const last = Math.ceil((s + VIEW_AHEAD) / BUILDING_SLOT);
    for (const side of [-1, 1] as const) {
      for (let k = first; k <= last && n < MAX_BUILDINGS; k++) {
        const b = buildingAt(k, side, this.buildingScratch);
        t.position.set(side * (1.5 * LANE_WIDTH + 3 + b.width / 2), b.height / 2, toZ(k * BUILDING_SLOT + BUILDING_SLOT / 2, s));
        t.scale.set(b.width, b.height, b.depth);
        t.updateMatrix();
        this.buildings.setMatrixAt(n, t.matrix);
        this.buildings.setColorAt(n, this.color.setHex(b.color));
        n++;
      }
    }
    this.buildings.count = n;
    this.buildings.instanceMatrix.needsUpdate = true;
    if (this.buildings.instanceColor) this.buildings.instanceColor.needsUpdate = true;
  }

  private updateObstacles(g: Game): void {
    const seen = this.seenObstacles;
    seen.clear();
    for (const o of g.track.obstacles) {
      const z = toZ(o.front, g.s);
      if (z < -VIEW_AHEAD || z - o.length > VIEW_BEHIND) continue;
      seen.add(o.id);
      let mesh = this.obstacleMeshes.get(o.id);
      if (!mesh) {
        mesh = this.takeObstacleMesh(o.kind);
        this.obstacleMeshes.set(o.id, mesh);
      }
      mesh.position.set(laneX(o.lane), 0, z);
      mesh.scale.z = o.kind === 'ramp' ? o.length / OBSTACLES.ramp.length : o.length;
    }
    for (const [id, mesh] of this.obstacleMeshes) {
      if (seen.has(id)) continue;
      this.obstacleMeshes.delete(id);
      mesh.visible = false;
      this.obstaclePool.get(mesh.userData.kind as ObstacleKind)!.push(mesh);
    }
  }

  private takeObstacleMesh(kind: ObstacleKind): THREE.Mesh {
    let pool = this.obstaclePool.get(kind);
    if (!pool) {
      pool = [];
      this.obstaclePool.set(kind, pool);
    }
    let mesh = pool.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.obstacleGeo[kind], this.obstacleMat[kind]);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.kind = kind;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  private updateCoins(g: Game): void {
    const t = this.tmp;
    const r = g.runner;
    const magnet = g.powerups.magnet > 0;
    t.scale.set(1, 1, 1);
    let n = 0;
    for (const c of g.track.coins) {
      if (c.taken || n >= MAX_COINS) continue;
      const ahead = c.s - g.s;
      if (ahead > VIEW_AHEAD || ahead < -VIEW_BEHIND) continue;
      let x = laneX(c.lane);
      let y = c.y;
      if (magnet && ahead > 0 && ahead < TUNING.magnetRange) {
        const pull = 1 - ahead / TUNING.magnetRange;
        x += (r.x - x) * pull;
        y += (r.y + 1 - y) * pull;
      }
      t.position.set(x, y, -ahead);
      t.rotation.set(0, this.clock * 4 + c.id, 0);
      t.updateMatrix();
      this.coins.setMatrixAt(n++, t.matrix);
    }
    this.coins.count = n;
    this.coins.instanceMatrix.needsUpdate = true;
  }

  private updatePickups(g: Game): void {
    const seen = this.seenPickups;
    seen.clear();
    for (const p of g.track.pickups) {
      if (p.taken) continue;
      const ahead = p.s - g.s;
      if (ahead > VIEW_AHEAD || ahead < -VIEW_BEHIND) continue;
      seen.add(p.id);
      let mesh = this.pickupMeshes.get(p.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.pickupGeo, standard(PICKUP_COLORS[p.kind], { emissive: PICKUP_COLORS[p.kind], emissiveIntensity: 0.4 }));
        mesh.castShadow = true;
        this.scene.add(mesh);
        this.pickupMeshes.set(p.id, mesh);
      }
      mesh.position.set(laneX(p.lane), 1 + Math.sin(this.clock * 3 + p.id) * 0.2, -ahead);
      mesh.rotation.y = this.clock * 2;
    }
    for (const [id, mesh] of this.pickupMeshes) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      this.pickupMeshes.delete(id);
    }
  }
}
