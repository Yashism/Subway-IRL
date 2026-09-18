import * as THREE from 'three';
import type { GameEvent } from '../game/game';
import type { PowerupKind } from '../game/track';
import { basicMaterial, curveUniforms } from './render/materials';

/**
 * Game-feel effects layer: pooled particles (coin sparkles, pickup bursts, dust,
 * rocket flame, Josh streaks), a full-screen speed-line quad, the magnet aura and
 * the camera shake / FOV pulse. It is purely visual and never touches game state.
 *
 * Conventions: floating origin (the runner is at z = 0, the world scrolls toward +z
 * at `speed`). Everything is preallocated; update() and onEvents() allocate nothing.
 */

export interface FxFrame {
  speed: number;
  flying: boolean;
  magnet: boolean;
  josh: boolean;
  runnerPos: THREE.Vector3;
}

export interface FxOutput {
  /** Camera position offset (m). */
  shake: THREE.Vector3;
  /** Camera roll (radians). */
  roll: number;
  /** Degrees to add to the base FOV. */
  fovDelta: number;
}

export interface FxOptions {
  /** Particle capacity per pool (glow and dust). */
  capacity?: number;
  /** Attach the full-screen speed-line quad to the camera (default true). */
  speedLines?: boolean;
}

// ---------------------------------------------------------------- tuning

export const FX = {
  speedLinesFrom: 18,
  speedLinesFull: 30,
  flyFov: 5,
  fovRiseTau: 0.25 / 3,
  fovFallTau: 0.4 / 3,
  caught: { amp: 0.18, rot: 3, dur: 0.35, tau: 0.12 },
  stumble: { amp: 0.05, rot: 1, dur: 0.15, tau: 0.05 },
  thud: { amp: 0.08, rot: 1.2, dur: 0.25, tau: 0.08 },
  flameRate: 80,
  smokeRate: 14,
  joshRate: 55,
  magnetSparkRate: 12,
} as const;

const SHAPE_ROUND = 0;
const SHAPE_STAR = 1;
const SHAPE_STREAK = 2;
const SHAPE_PUFF = 3;

const PICKUP_COLORS: Record<PowerupKind, [number, number]> = {
  magnet: [0xff3b4e, 0x6fd1ff],
  rocket: [0xff7a29, 0xffd400],
  chappal: [0xffc93c, 0x8fe36b],
};

// ---------------------------------------------------------------- particle pool

const PARTICLE_VERTEX = /* glsl */ `
uniform float uViewportH;
uniform float uCurveVertical;
uniform float uCurveHorizontal;
uniform float uCurveEnabled;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
attribute float aShape;
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  float dz = min( world.z, 0.0 );
  float d2 = dz * dz * uCurveEnabled;
  world.y -= d2 * uCurveVertical;
  // Same sideways bend as materials.ts: smooth through x = 0.
  world.x -= clamp( world.x / 4.0, -1.0, 1.0 ) * d2 * uCurveHorizontal;
  vec4 mv = viewMatrix * world;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aAlpha <= 0.0 ? 0.0 : aSize * projectionMatrix[1][1] * uViewportH * 0.5 / max( 0.2, -mv.z );
  vColor = aColor;
  vAlpha = aAlpha;
  vShape = aShape;
}`;

const PARTICLE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vShape;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length( p );
  float a;
  vec3 col = vColor;
  if ( vShape < 0.5 ) {
    a = smoothstep( 1.0, 0.0, r );
    a *= a;
  } else if ( vShape < 1.5 ) {
    float core = smoothstep( 0.5, 0.0, r );
    float cx = smoothstep( 0.16, 0.0, abs( p.x ) ) * smoothstep( 1.0, 0.1, abs( p.y ) );
    float cy = smoothstep( 0.16, 0.0, abs( p.y ) ) * smoothstep( 1.0, 0.1, abs( p.x ) );
    a = max( core, max( cx, cy ) );
    col = mix( col, vec3( 1.0 ), smoothstep( 0.22, 0.0, r ) * 0.6 );
  } else if ( vShape < 2.5 ) {
    a = smoothstep( 0.3, 0.0, abs( p.x ) ) * smoothstep( 1.0, 0.2, abs( p.y ) );
    col = mix( col, vec3( 1.0, 0.95, 0.7 ), smoothstep( 0.12, 0.0, abs( p.x ) ) * 0.6 );
  } else {
    a = smoothstep( 1.0, 0.55, r );
    col *= 0.85 + 0.25 * ( 1.0 - smoothstep( -0.6, 0.6, p.y + p.x * 0.3 ) );
  }
  a *= vAlpha;
  if ( a < 0.01 ) discard;
  gl_FragColor = vec4( col, a );
  #include <colorspace_fragment>
}`;

/** Reusable emit description (module scratch, so emitting allocates nothing). */
interface EmitSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  shape: number;
  c0: THREE.Color;
  c1: THREE.Color;
  gravity: number;
  drag: number;
  /** 0 = moves with the runner, 1 = stays put in the scrolling world. */
  anchor: number;
}

const spec: EmitSpec = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0.5, size0: 0.3, size1: 0.1, alpha: 1,
  shape: SHAPE_ROUND, c0: new THREE.Color(), c1: new THREE.Color(), gravity: 0, drag: 0, anchor: 0,
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

class ParticlePool {
  readonly points: THREE.Points;
  private readonly cap: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly shape: Float32Array;
  private readonly vel: Float32Array;
  private readonly c0: Float32Array;
  private readonly c1: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly anchor: Float32Array;
  private readonly attrs: THREE.BufferAttribute[];
  private cursor = 0;
  alive = 0;
  /** False drops every emit on the floor ("reduced effects"); the pool keeps running down. */
  enabled = true;

  constructor(cap: number, additive: boolean) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.shape = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.c0 = new Float32Array(cap * 3);
    this.c1 = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap).fill(1);
    this.size0 = new Float32Array(cap);
    this.size1 = new Float32Array(cap);
    this.alpha0 = new Float32Array(cap);
    this.gravity = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.anchor = new Float32Array(cap);

    const geo = new THREE.BufferGeometry();
    const dyn = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    const aPos = dyn(this.pos, 3);
    const aCol = dyn(this.col, 3);
    const aSize = dyn(this.size, 1);
    const aAlpha = dyn(this.alpha, 1);
    const aShape = dyn(this.shape, 1);
    geo.setAttribute('position', aPos);
    geo.setAttribute('aColor', aCol);
    geo.setAttribute('aSize', aSize);
    geo.setAttribute('aAlpha', aAlpha);
    geo.setAttribute('aShape', aShape);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.attrs = [aPos, aCol, aSize, aAlpha, aShape];

    const material = new THREE.ShaderMaterial({
      uniforms: { uViewportH: { value: 800 }, ...curveUniforms },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 10;
    this.points.name = additive ? 'fx-glow' : 'fx-dust';
    const size = new THREE.Vector2();
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(size);
      material.uniforms.uViewportH.value = size.y;
    };
  }

  emit(s: EmitSpec): void {
    if (!this.enabled) return;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    if (this.life[i] <= 0) this.alive++;
    const i3 = i * 3;
    this.pos[i3] = s.x;
    this.pos[i3 + 1] = s.y;
    this.pos[i3 + 2] = s.z;
    this.vel[i3] = s.vx;
    this.vel[i3 + 1] = s.vy;
    this.vel[i3 + 2] = s.vz;
    this.c0[i3] = s.c0.r;
    this.c0[i3 + 1] = s.c0.g;
    this.c0[i3 + 2] = s.c0.b;
    this.c1[i3] = s.c1.r;
    this.c1[i3 + 1] = s.c1.g;
    this.c1[i3 + 2] = s.c1.b;
    this.col[i3] = s.c0.r;
    this.col[i3 + 1] = s.c0.g;
    this.col[i3 + 2] = s.c0.b;
    this.life[i] = s.life;
    this.maxLife[i] = s.life;
    this.size0[i] = s.size0;
    this.size1[i] = s.size1;
    this.size[i] = s.size0;
    this.alpha0[i] = s.alpha;
    this.alpha[i] = 0;
    this.shape[i] = s.shape;
    this.gravity[i] = s.gravity;
    this.drag[i] = s.drag;
    this.anchor[i] = s.anchor;
  }

  update(dt: number, worldSpeed: number): void {
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      const left = (this.life[i] -= dt);
      if (left <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      alive++;
      const i3 = i * 3;
      const t = 1 - left / this.maxLife[i];
      const damp = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp - this.gravity[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += (this.vel[i3 + 2] + worldSpeed * this.anchor[i]) * dt;
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      const fadeIn = Math.min(1, t * 12);
      const fadeOut = 1 - t * t;
      this.alpha[i] = this.alpha0[i] * fadeIn * fadeOut;
      for (let k = 0; k < 3; k++) this.col[i3 + k] = this.c0[i3 + k] + (this.c1[i3 + k] - this.c0[i3 + k]) * t;
    }
    this.alive = alive;
    for (const a of this.attrs) a.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.alive = 0;
    for (const a of this.attrs) a.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- textures

/** Procedural alpha texture (white RGB), no DOM needed. */
function alphaTexture(size: number, fn: (x: number, y: number) => number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size) * 2 - 1;
      const y = ((j + 0.5) / size) * 2 - 1;
      const a = Math.max(0, Math.min(1, fn(x, y)));
      const o = (j * size + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

let bubbleTex: THREE.DataTexture | null = null;
let ringTex: THREE.DataTexture | null = null;

function bubbleTexture(): THREE.DataTexture {
  bubbleTex ??= alphaTexture(256, (x, y) => {
    const r = Math.hypot(x, y);
    if (r > 1) return 0;
    const fill = 0.03 + 0.12 * r ** 4;
    const rim = smooth(0.8, 0.93, r) * (1 - smooth(0.93, 0.995, r));
    const glint = Math.exp(-((x + 0.4) ** 2 + (y - 0.45) ** 2) / 0.006) * 0.8;
    const glint2 = Math.exp(-((x - 0.5) ** 2 + (y + 0.52) ** 2) / 0.002) * 0.4;
    return fill + rim * 0.75 + glint + glint2;
  });
  return bubbleTex;
}

function ringTexture(): THREE.DataTexture {
  ringTex ??= alphaTexture(128, (x, y) => {
    const r = Math.hypot(x, y);
    return Math.exp(-(((r - 0.82) / 0.07) ** 2)) + 0.25 * Math.exp(-(((r - 0.82) / 0.2) ** 2));
  });
  return ringTex;
}

// ---------------------------------------------------------------- speed lines

const SPEED_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

const SPEED_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uAspect;
varying vec2 vUv;
float hash( float n ) { return fract( sin( n ) * 43758.5453123 ); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  p.y -= 0.18;
  p.x *= uAspect;
  float r = length( p );
  float ang = atan( p.y, p.x ) / 6.2831853 + 0.5;
  float n = 150.0;
  float fa = ang * n;
  float id = floor( fa );
  float f = fract( fa ) - 0.5;
  float h = hash( id * 1.37 );
  float h2 = hash( id * 7.11 + 3.0 );
  float width = 0.06 + 0.16 * h2;
  float line = smoothstep( width, 0.0, abs( f ) );
  float dash = fract( r * ( 0.35 + 0.3 * h2 ) - uTime * ( 1.4 + 1.6 * h ) + h * 11.0 );
  float seg = smoothstep( 0.0, 0.08, dash ) * smoothstep( 0.75, 0.25, dash );
  float on = step( 1.0 - ( 0.35 + 0.35 * uIntensity ), h );
  float mask = smoothstep( 0.45 + 0.35 * ( 1.0 - uIntensity ), 1.5, r );
  float a = line * seg * on * mask * uIntensity;
  float edge = smoothstep( 0.9, 2.0, r ) * 0.18 * uIntensity;
  gl_FragColor = vec4( mix( vec3( 1.0 ), vec3( 1.0, 0.93, 0.8 ), h2 ), clamp( a * 0.75 + edge * 0.0, 0.0, 1.0 ) );
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- shake

class Shake {
  amp = 0;
  rot = 0;
  dur = 0;
  tau = 1;
  age = 1e9;

  start(p: { amp: number; rot: number; dur: number; tau: number }): void {
    // A stronger shake in progress wins.
    if (this.age < this.dur && this.current() > p.amp) return;
    this.amp = p.amp;
    this.rot = (p.rot * Math.PI) / 180;
    this.dur = p.dur;
    this.tau = p.tau;
    this.age = 0;
  }

  current(): number {
    return this.age >= this.dur ? 0 : this.amp * Math.exp(-this.age / this.tau);
  }

  /** Decay factor 0..1 for the current age. */
  k(): number {
    if (this.age >= this.dur) return 0;
    // Exponential decay, forced to reach exactly 0 at the end of the window.
    const e = Math.exp(-this.age / this.tau);
    const endE = Math.exp(-this.dur / this.tau);
    return Math.max(0, (e - endE) / (1 - endE));
  }
}

// ---------------------------------------------------------------- Fx

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();

export class Fx {
  readonly root = new THREE.Group();
  private readonly glow: ParticlePool;
  private readonly dust: ParticlePool;
  private readonly speedQuad: THREE.Mesh | null = null;
  private readonly speedMat: THREE.ShaderMaterial;
  private readonly aura = new THREE.Group();
  private readonly bubble: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly ring2: THREE.Mesh;
  private readonly bubbleMat: THREE.MeshBasicMaterial;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly ring2Mat: THREE.MeshBasicMaterial;
  private readonly auraBase = new THREE.Vector3();
  private readonly shake = new Shake();
  private readonly out: FxOutput = { shake: new THREE.Vector3(), roll: 0, fovDelta: 0 };

  private readonly colA = new THREE.Color();
  private readonly colB = new THREE.Color();
  private readonly gold = new THREE.Color(0xffd24a);
  private readonly amber = new THREE.Color(0xff8a1f);
  private readonly white = new THREE.Color(0xfff6d8);
  private readonly dustA = new THREE.Color(0xd9c3a3);
  private readonly dustB = new THREE.Color(0xb39a7c);
  private readonly flameA = new THREE.Color(0xffc94a);
  private readonly flameB = new THREE.Color(0xff3a0a);
  private readonly smokeA = new THREE.Color(0x9a8f88);
  private readonly smokeB = new THREE.Color(0xd8d2cc);
  private readonly joshA = new THREE.Color(0xffb13d);
  private readonly joshB = new THREE.Color(0xff3d00);
  private readonly magnetA = new THREE.Color(0xbdf0ff);
  private readonly magnetB = new THREE.Color(0x3fb8ff);
  private readonly cyan = new THREE.Color(0x29e0f0);

  /** Comfort/perf settings (see WorldView.setReduced). */
  private reducedMotion = false;

  private time = 0;
  private speed = 0;
  private speedK = 0;
  private fov = 0;
  private magnetK = 0;
  private flameAcc = 0;
  private smokeAcc = 0;
  private joshAcc = 0;
  private magnetAcc = 0;
  private lastY = 0;
  private lastVy = 0;
  private stillFor = 0;
  private wasFlying = false;

  constructor(scene: THREE.Object3D, private readonly camera: THREE.PerspectiveCamera, options: FxOptions = {}) {
    const cap = options.capacity ?? 640;
    this.root.name = 'fx';
    this.glow = new ParticlePool(cap, true);
    this.dust = new ParticlePool(Math.max(64, cap >> 1), false);
    this.root.add(this.dust.points, this.glow.points);

    // Magnet aura: camera-facing bubble + two ground ripples.
    this.bubbleMat = basicMaterial({
      color: 0x6fd1ff,
      map: bubbleTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    // Two separate curved materials: clone() would drop the curve patch (onBeforeCompile).
    const ringMap = ringTexture();
    const ringMaterial = () =>
      basicMaterial({
        color: 0x6fd1ff,
        map: ringMap,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
    this.ringMat = ringMaterial();
    this.ring2Mat = ringMaterial();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.bubble = new THREE.Mesh(quad, this.bubbleMat);
    this.bubble.scale.setScalar(3.1);
    this.bubble.renderOrder = 30;
    const flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(flat, this.ringMat);
    this.ring2 = new THREE.Mesh(flat, this.ring2Mat);
    this.ring.renderOrder = this.ring2.renderOrder = 5;
    this.aura.add(this.ring, this.ring2);
    this.aura.visible = false;
    this.bubble.visible = false;
    this.root.add(this.aura, this.bubble);
    this.bubble.onBeforeRender = (_r, _s, cam) => this.faceCamera(cam);

    this.speedMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uAspect: { value: 16 / 9 } },
      vertexShader: SPEED_VERTEX,
      fragmentShader: SPEED_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    if (options.speedLines !== false) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.speedMat);
      q.frustumCulled = false;
      q.renderOrder = 1000;
      q.visible = false;
      q.name = 'fx-speedlines';
      camera.add(q);
      if (!camera.parent) scene.add(camera);
      this.speedQuad = q;
    }
    scene.add(this.root);
  }

  /** Live particle count (both pools); for tests and perf overlays. */
  get particles(): number {
    return this.glow.alive + this.dust.alive;
  }

  get speedLineIntensity(): number {
    return this.speedMat.uniforms.uIntensity.value as number;
  }

  /**
   * The player's comfort settings. `motion` drops the camera shake, the roll, the FOV pulse and
   * the speed lines; `effects` stops emitting particles (the live ones still run down).
   * Both are also a cheap win on a weak GPU.
   */
  setReduced(o: { motion?: boolean; effects?: boolean }): void {
    if (o.motion !== undefined) this.reducedMotion = o.motion;
    if (o.effects !== undefined) {
      this.glow.enabled = this.dust.enabled = !o.effects;
      if (o.effects) {
        this.glow.clear();
        this.dust.clear();
      }
    }
  }

  /** Clears every particle and shake (e.g. on a new run). */
  reset(): void {
    this.glow.clear();
    this.dust.clear();
    this.shake.age = 1e9;
    this.lastVy = 0;
  }

  onEvents(events: readonly GameEvent[], runnerPos: THREE.Vector3): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const grounded = runnerPos.y < 0.05;
      switch (e.type) {
        case 'coin':
          this.coinBurst(runnerPos.x, runnerPos.y + 1.1, runnerPos.z - 0.5);
          break;
        case 'pickup':
          this.pickupBurst(runnerPos, e.kind);
          break;
        case 'jump':
          this.puff(runnerPos.x, runnerPos.y + 0.05, runnerPos.z + 0.1, 6, 0.8);
          break;
        case 'roll':
          this.puff(runnerPos.x, runnerPos.y + 0.05, runnerPos.z, 8, 0.9);
          break;
        case 'lane':
          if (grounded) this.puff(runnerPos.x, 0.05, runnerPos.z + 0.2, 4, 0.6);
          break;
        case 'stumble':
          this.shake.start(FX.stumble);
          this.puff(runnerPos.x, runnerPos.y + 0.3, runnerPos.z, 12, 1.2);
          this.stars(runnerPos.x, runnerPos.y + 1.3, runnerPos.z, 6, this.white, this.gold);
          break;
        case 'caught':
          this.shake.start(FX.caught);
          this.puff(runnerPos.x, runnerPos.y + 0.2, runnerPos.z, 18, 1.8);
          this.stars(runnerPos.x, runnerPos.y + 1.2, runnerPos.z, 10, this.white, this.amber);
          break;
        case 'hoverboard':
          this.colA.copy(this.cyan);
          this.burst(runnerPos.x, runnerPos.y + 0.4, runnerPos.z, 18, this.colA, this.white, 4, 0.35);
          break;
        case 'hoverboardSaved':
          this.shake.start(FX.thud);
          this.burst(runnerPos.x, runnerPos.y + 0.9, runnerPos.z, 26, this.white, this.cyan, 6, 0.45);
          this.puff(runnerPos.x, runnerPos.y + 0.1, runnerPos.z, 14, 1.5);
          break;
        case 'rocketLanding':
          this.shake.start(FX.thud);
          this.puff(runnerPos.x, 0.05, runnerPos.z, 16, 1.6);
          break;
        default:
          break;
      }
    }
  }

  update(dt: number, s: FxFrame): FxOutput {
    this.time += dt;
    this.speed = s.speed;
    const p = s.runnerPos;

    // Landing dust: a fall that has stopped (y unchanged for at least one sim step).
    if (dt > 0) {
      const dy = p.y - this.lastY;
      if (dy !== 0) {
        this.lastVy = dy / dt;
        this.stillFor = 0;
      } else {
        this.stillFor += dt;
        if (this.lastVy < -1.5 && this.stillFor >= 0.02 && !s.flying) {
          this.puff(p.x, p.y + 0.05, p.z + 0.1, 12, 1.3);
          this.lastVy = 0;
        }
      }
      this.lastY = p.y;
    }

    // Rocket flame + smoke.
    if (s.flying) {
      this.flameAcc += dt * FX.flameRate;
      while (this.flameAcc >= 1) {
        this.flameAcc--;
        this.flame(p);
      }
      this.smokeAcc += dt * FX.smokeRate;
      while (this.smokeAcc >= 1) {
        this.smokeAcc--;
        this.smoke(p);
      }
    } else {
      this.flameAcc = this.smokeAcc = 0;
    }
    if (s.flying !== this.wasFlying && s.flying) this.burst(p.x, p.y + 0.3, p.z + 0.2, 20, this.flameA, this.flameB, 5, 0.4);
    this.wasFlying = s.flying;

    // Josh streaks.
    if (s.josh) {
      this.joshAcc += dt * FX.joshRate;
      while (this.joshAcc >= 1) {
        this.joshAcc--;
        this.joshStreak(p);
      }
    } else {
      this.joshAcc = 0;
    }

    // Magnet aura.
    this.magnetK = ease(this.magnetK, s.magnet ? 1 : 0, dt, 0.08);
    const showAura = this.magnetK > 0.01;
    this.aura.visible = this.bubble.visible = showAura;
    if (showAura) {
      const k = this.magnetK;
      const pulse = 0.5 + 0.5 * Math.sin((this.time * Math.PI * 2) / 0.6);
      this.auraBase.set(p.x, p.y + 0.95, p.z);
      this.bubble.position.copy(this.auraBase);
      this.bubble.scale.setScalar(2.35 + 0.08 * pulse);
      this.bubbleMat.opacity = k * (0.5 + 0.2 * pulse);
      this.aura.position.set(p.x, p.y + 0.04, p.z);
      const r1 = ((this.time / 1.2) % 1 + 1) % 1;
      const r2 = (r1 + 0.5) % 1;
      this.ring.scale.setScalar(1.4 + 2.6 * r1);
      this.ring2.scale.setScalar(1.4 + 2.6 * r2);
      this.ringMat.opacity = k * 0.55 * (1 - r1) * Math.min(1, r1 * 6);
      this.ring2Mat.opacity = k * 0.55 * (1 - r2) * Math.min(1, r2 * 6);
      if (s.magnet) {
        this.magnetAcc += dt * FX.magnetSparkRate;
        while (this.magnetAcc >= 1) {
          this.magnetAcc--;
          this.magnetSpark(p);
        }
      }
    }

    // Particles.
    this.glow.update(dt, s.speed);
    this.dust.update(dt, s.speed);

    // Speed lines.
    const over = (s.speed - FX.speedLinesFrom) / (FX.speedLinesFull - FX.speedLinesFrom);
    const target = this.reducedMotion ? 0 : s.flying ? 1 : Math.max(0, Math.min(1, over)) * 0.6;
    this.speedK = this.reducedMotion ? 0 : ease(this.speedK, target, dt, 0.2);
    const u = this.speedMat.uniforms;
    u.uIntensity.value = this.speedK;
    u.uTime.value = this.time;
    u.uAspect.value = this.camera.aspect;
    if (this.speedQuad) this.speedQuad.visible = this.speedK > 0.01;

    // FOV pulse (eased: ~0.25 s in, ~0.4 s out).
    const fovTarget = s.flying ? FX.flyFov : 0;
    // Reduced motion drops the pulse outright rather than easing it away: a comfort setting that
    // leaves a tenth of a degree of FOV drift on screen has not really been honoured.
    this.fov = this.reducedMotion ? 0 : ease(this.fov, fovTarget, dt, fovTarget > this.fov ? FX.fovRiseTau : FX.fovFallTau);

    // Shake.
    const sh = this.shake;
    sh.age += dt;
    const k = this.reducedMotion ? 0 : sh.k();
    const o = this.out;
    if (k > 0) {
      const t = this.time;
      const a = sh.amp * k;
      o.shake.set(
        a * (Math.sin(t * 53.1) * 0.6 + Math.sin(t * 91.7 + 1.3) * 0.4),
        a * (Math.sin(t * 61.3 + 0.7) * 0.6 + Math.sin(t * 83.9 + 2.1) * 0.4),
        a * 0.5 * Math.sin(t * 47.9 + 0.4),
      );
      o.roll = sh.rot * k * (Math.sin(t * 57.7 + 2.9) * 0.7 + Math.sin(t * 97.3) * 0.3);
    } else {
      o.shake.set(0, 0, 0);
      o.roll = 0;
    }
    o.fovDelta = this.fov;
    return o;
  }

  // ------------------------------------------------------------ emitters

  private coinBurst(x: number, y: number, z: number): void {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
      const sp = rand(2.2, 4.2);
      this.set(x, y, z, Math.cos(a) * sp, Math.sin(a) * sp + 1.2, rand(-1, 1), rand(0.3, 0.5));
      spec.size0 = rand(0.26, 0.38);
      spec.size1 = 0.04;
      spec.shape = SHAPE_STAR;
      spec.c0.copy(i % 3 === 0 ? this.white : this.gold);
      spec.c1.copy(this.amber);
      spec.gravity = 5;
      spec.drag = 3.5;
      spec.anchor = 0.2;
      this.glow.emit(spec);
    }
    this.set(x, y, z, 0, 0, 0, 0.16);
    spec.size0 = 0.9;
    spec.size1 = 1.5;
    spec.alpha = 0.8;
    spec.c0.copy(this.white);
    spec.c1.copy(this.gold);
    spec.anchor = 0.2;
    this.glow.emit(spec);
  }

  private pickupBurst(p: THREE.Vector3, kind: PowerupKind): void {
    const [a, b] = PICKUP_COLORS[kind];
    this.colA.setHex(a);
    this.colB.setHex(b);
    this.burst(p.x, p.y + 1.1, p.z - 0.3, 24, this.colA, this.colB, 5.5, 0.55);
    this.stars(p.x, p.y + 1.1, p.z - 0.3, 6, this.white, this.colB);
    this.set(p.x, p.y + 1.1, p.z - 0.3, 0, 0, 0, 0.25);
    spec.size0 = 1.0;
    spec.size1 = 2.2;
    spec.alpha = 0.4;
    spec.c0.copy(this.colB);
    spec.c1.copy(this.colA);
    spec.anchor = 0.2;
    this.glow.emit(spec);
  }

  private burst(x: number, y: number, z: number, n: number, c0: THREE.Color, c1: THREE.Color, speed: number, life: number): void {
    for (let i = 0; i < n; i++) {
      const u = rand(-1, 1);
      const th = rand(0, Math.PI * 2);
      const rr = Math.sqrt(1 - u * u);
      const sp = speed * rand(0.55, 1);
      this.set(x, y, z, rr * Math.cos(th) * sp, u * sp + 1, rr * Math.sin(th) * sp, life * rand(0.7, 1.2));
      spec.size0 = rand(0.22, 0.36);
      spec.size1 = 0.03;
      spec.c0.copy(i % 2 ? c0 : c1);
      spec.c1.copy(c1);
      spec.gravity = 4;
      spec.drag = 3;
      spec.anchor = 0.3;
      this.glow.emit(spec);
    }
  }

  private stars(x: number, y: number, z: number, n: number, c0: THREE.Color, c1: THREE.Color): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.set(x, y, z, Math.cos(a) * 2.2, Math.sin(a) * 1.2 + 1.6, rand(-0.5, 0.5), rand(0.45, 0.65));
      spec.size0 = 0.5;
      spec.size1 = 0.12;
      spec.shape = SHAPE_STAR;
      spec.c0.copy(c0);
      spec.c1.copy(c1);
      spec.gravity = 3;
      spec.drag = 2.5;
      spec.anchor = 0.3;
      this.glow.emit(spec);
    }
  }

  private puff(x: number, y: number, z: number, n: number, strength: number): void {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(1.2, 2.8) * strength;
      this.set(x + Math.cos(a) * 0.2, y, z + Math.sin(a) * 0.2, Math.cos(a) * sp, rand(0.3, 1.2) * strength, Math.sin(a) * sp * 0.6, rand(0.4, 0.7));
      spec.size0 = rand(0.25, 0.4) * strength;
      spec.size1 = rand(0.8, 1.2) * strength;
      spec.alpha = 0.6;
      spec.shape = SHAPE_PUFF;
      spec.c0.copy(this.dustA);
      spec.c1.copy(this.dustB);
      spec.gravity = -0.4;
      spec.drag = 4;
      spec.anchor = 1;
      this.dust.emit(spec);
    }
  }

  private flame(p: THREE.Vector3): void {
    this.set(p.x + rand(-0.1, 0.1), p.y + 0.15, p.z + 0.15 + rand(-0.05, 0.05), rand(-0.5, 0.5), rand(-6.5, -4), rand(1, 2.5), rand(0.18, 0.3));
    spec.size0 = rand(0.4, 0.55);
    spec.size1 = 0.1;
    spec.alpha = 0.6;
    spec.c0.copy(this.flameA);
    spec.c1.copy(this.flameB);
    spec.drag = 1.5;
    spec.anchor = 0.35;
    this.glow.emit(spec);
  }

  private smoke(p: THREE.Vector3): void {
    this.set(p.x + rand(-0.15, 0.15), p.y - 0.6, p.z + 0.5, rand(-0.6, 0.6), rand(-1.5, -0.5), rand(0, 1), rand(0.6, 0.9));
    spec.size0 = 0.4;
    spec.size1 = 1.3;
    spec.alpha = 0.35;
    spec.shape = SHAPE_PUFF;
    spec.c0.copy(this.smokeA);
    spec.c1.copy(this.smokeB);
    spec.drag = 2;
    spec.gravity = -0.5;
    spec.anchor = 0.8;
    this.dust.emit(spec);
  }

  private joshStreak(p: THREE.Vector3): void {
    const side = Math.random() < 0.5 ? -1 : 1;
    this.set(p.x + side * rand(0.25, 0.5), p.y + rand(0.2, 1.5), p.z + rand(0, 0.4), side * rand(0, 0.4), 0, rand(1, 3), rand(0.22, 0.34));
    spec.size0 = rand(0.45, 0.7);
    spec.size1 = 0.2;
    spec.alpha = 0.85;
    spec.shape = SHAPE_STREAK;
    spec.c0.copy(this.joshA);
    spec.c1.copy(this.joshB);
    spec.anchor = 1;
    this.glow.emit(spec);
  }

  private magnetSpark(p: THREE.Vector3): void {
    const a = rand(0, Math.PI * 2);
    const r = 1.1;
    this.set(p.x + Math.cos(a) * r, p.y + 0.95 + rand(-0.9, 0.9), p.z + Math.sin(a) * r * 0.6, -Math.cos(a) * 0.8, rand(0.3, 0.9), -Math.sin(a) * 0.5, rand(0.35, 0.55));
    spec.size0 = 0.28;
    spec.size1 = 0.05;
    spec.shape = SHAPE_STAR;
    spec.c0.copy(this.magnetA);
    spec.c1.copy(this.magnetB);
    this.glow.emit(spec);
  }

  /** Resets the shared spec with a position, velocity and life; callers tweak the rest. */
  private set(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number): void {
    spec.x = x;
    spec.y = y;
    spec.z = z;
    spec.vx = vx;
    spec.vy = vy;
    spec.vz = vz;
    spec.life = life;
    spec.size0 = 0.3;
    spec.size1 = 0.1;
    spec.alpha = 1;
    spec.shape = SHAPE_ROUND;
    spec.gravity = 0;
    spec.drag = 0;
    spec.anchor = 0;
  }

  /** Billboards the aura bubble and nudges it toward the camera so it wraps the runner. */
  private faceCamera(cam: THREE.Camera): void {
    const b = this.bubble;
    const parent = b.parent!;
    const worldBase = parent.localToWorld(tmpA.copy(this.auraBase));
    cam.getWorldPosition(tmpB);
    tmpB.sub(worldBase).normalize().multiplyScalar(0.9).add(worldBase);
    b.position.copy(parent.worldToLocal(tmpB));
    parent.getWorldQuaternion(tmpQ).invert();
    cam.getWorldQuaternion(tmpQ2);
    b.quaternion.multiplyQuaternions(tmpQ, tmpQ2);
    b.updateMatrixWorld();
  }
}

/** Exponential ease toward target with time constant tau (s). */
function ease(current: number, target: number, dt: number, tau: number): number {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}
