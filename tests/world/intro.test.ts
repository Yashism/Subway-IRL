import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Node has no canvas: stub a 2D context that swallows every call.
const any: unknown = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : p === 'width' ? 10 : any),
  apply: () => any,
  set: () => true,
});

let intro: typeof import('../../src/world/intro');
let trains: typeof import('../../src/world/models/trains');

beforeAll(async () => {
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => any }),
  });
  intro = await import('../../src/world/intro');
  trains = await import('../../src/world/models/trains');
});

interface World {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

function world(): World {
  const scene = new THREE.Scene();
  // a marker so we can prove the intro only ever removes its own group
  const marker = new THREE.Group();
  marker.name = 'marker';
  scene.add(marker);
  return { scene, camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 900) };
}

/** Every distinct geometry and material hanging under `root`. */
function resources(root: THREE.Object3D): { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material> } {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.geometry) geometries.add(m.geometry);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (mat) materials.add(mat);
  });
  return { geometries, materials };
}

/** A pose fingerprint the camera can be compared by. */
function camState(c: THREE.PerspectiveCamera): number[] {
  const d = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
  return [c.position.x, c.position.y, c.position.z, d.x, d.y, d.z, c.fov];
}

function graph(root: THREE.Object3D): string[] {
  const out: string[] = [];
  root.traverse((o) => out.push(`${o.name}|${o.type}|${o.visible}`));
  return out;
}

function playThrough(seq: { update(dt: number): boolean }, to = intro.INTRO_DURATION): void {
  for (let t = 0; t < to - 1e-9; t += 1 / 60) seq.update(Math.min(1 / 60, to - t));
}

describe('createIntro', () => {
  it('adds exactly one group and dispose puts the scene back', () => {
    const { scene, camera } = world();
    const before = scene.children.slice();
    const seq = intro.createIntro({ scene, camera, seed: 1 });
    expect(scene.children).toHaveLength(before.length + 1);
    expect(scene.children.at(-1)).toBe(seq.root);
    seq.dispose();
    expect(scene.children).toEqual(before);
    expect(seq.root.children).toHaveLength(0);
  });

  it('dispose releases everything it allocated and nothing that is shared', () => {
    const { scene, camera } = world();
    // Build a coach first: buildTrain works off module caches, so every geometry and
    // material the intro's coach uses already exists and must survive the teardown.
    const shared = resources(trains.buildTrain(13, { livery: 'western', seed: 41 }));
    const sharedSpies = [...shared.geometries, ...shared.materials].map((r) => vi.spyOn(r, 'dispose'));

    const seq = intro.createIntro({ scene, camera, seed: 1 });
    const own = resources(seq.root);
    // the props the intro builds for itself
    const mine = ['paste-tin', 'brush', 'torch', 'torch-beam', 'torch-spot', 'shout', 'paste-splatter', 'poster-sheet', 'faded-ad'];
    const found = new Map<string, { geo: THREE.BufferGeometry; spy: ReturnType<typeof vi.spyOn> }[]>();
    for (const name of mine) {
      const node = seq.root.getObjectByName(name);
      expect(node, `${name} is in the scene`).toBeTruthy();
      const list: { geo: THREE.BufferGeometry; spy: ReturnType<typeof vi.spyOn> }[] = [];
      node!.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry) list.push({ geo: m.geometry, spy: vi.spyOn(m.geometry, 'dispose') });
      });
      expect(list.length, `${name} has meshes`).toBeGreaterThan(0);
      found.set(name, list);
    }

    playThrough(seq);
    seq.dispose();

    for (const [name, list] of found) {
      for (const { spy } of list) expect(spy, `${name} geometry disposed`).toHaveBeenCalled();
    }
    for (const spy of sharedSpies) expect(spy, 'shared coach resource kept').not.toHaveBeenCalled();
    // a second intro still builds, which it could not if a cached resource had gone
    const again = intro.createIntro({ scene, camera, seed: 2 });
    expect(resources(again.root).geometries.size).toBeGreaterThan(0);
    again.dispose();
    for (const spy of sharedSpies) spy.mockRestore();
    void own;
  });

  it('runs for its full duration and then reports done', () => {
    const { scene, camera } = world();
    const seq = intro.createIntro({ scene, camera });
    expect(seq.done).toBe(false);
    expect(seq.duration).toBeCloseTo(intro.INTRO_DURATION);
    let alive = 0;
    for (let i = 0; i < 400; i++) {
      if (!seq.update(1 / 60)) break;
      alive++;
    }
    expect(alive).toBeGreaterThan(intro.INTRO_DURATION * 60 - 3);
    expect(alive).toBeLessThan(intro.INTRO_DURATION * 60 + 3);
    expect(seq.done).toBe(true);
    expect(seq.update(1 / 60)).toBe(false);
    seq.dispose();
  });

  it('reports the beat it is showing', () => {
    const { scene, camera } = world();
    const seq = intro.createIntro({ scene, camera });
    for (const [t, beat] of [
      [0, 1],
      [1.1, 1],
      [1.3, 2],
      [2.5, 3],
      [3.5, 4],
      [4.2, 4],
    ] as const) {
      seq.seek(t);
      expect(seq.beat, `t=${t}`).toBe(beat);
    }
    seq.dispose();
  });

  it('hands the camera over exactly at the running camera', () => {
    const { scene, camera } = world();
    const seq = intro.createIntro({ scene, camera });
    playThrough(seq);
    const h = intro.INTRO_HANDOVER;
    expect(camera.position.x).toBeCloseTo(0, 4);
    expect(camera.position.y).toBeCloseTo(h.height, 4);
    expect(camera.position.z).toBeCloseTo(h.back, 4);
    expect(camera.fov).toBeCloseTo(h.fov, 4);
    const want = new THREE.Vector3(0, h.lookHeight, -h.lookAhead).sub(camera.position).normalize();
    const got = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(got.dot(want)).toBeCloseTo(1, 5);
    seq.dispose();
  });

  it('honours a caller-supplied handover pose', () => {
    const { scene, camera } = world();
    const handover = { height: 5, back: 9, lookAhead: 20, lookHeight: 2, fov: 55 };
    const seq = intro.createIntro({ scene, camera, handover });
    seq.skip();
    expect(camera.position.y).toBeCloseTo(5, 4);
    expect(camera.position.z).toBeCloseTo(9, 4);
    expect(camera.fov).toBeCloseTo(55, 4);
    seq.dispose();
  });

  it('skipping at any beat lands in the same state as playing through', () => {
    const { scene, camera } = world();
    const played = intro.createIntro({ scene, camera, seed: 7 });
    playThrough(played);
    const wantCam = camState(camera);
    const wantGraph = graph(played.root);
    played.dispose();
    const wantScene = scene.children.length;

    for (const at of [0, 0.6, 1.5, 2.6, 3.0, 3.9, 4.2]) {
      const seq = intro.createIntro({ scene, camera, seed: 7 });
      playThrough(seq, at);
      seq.skip();
      expect(seq.done, `skip at ${at} is done`).toBe(true);
      camState(camera).forEach((v, i) => expect(v, `skip at ${at} camera[${i}]`).toBeCloseTo(wantCam[i], 4));
      expect(graph(seq.root), `skip at ${at} scene graph`).toEqual(wantGraph);
      seq.dispose();
      expect(scene.children).toHaveLength(wantScene);
    }
  });

  it('skip and dispose are safe before the first update and after the end', () => {
    const { scene, camera } = world();
    const seq = intro.createIntro({ scene, camera });
    seq.skip();
    seq.skip();
    seq.dispose();
    seq.dispose();
    expect(() => seq.update(1 / 60)).not.toThrow();
    expect(seq.update(1 / 60)).toBe(false);
    expect(scene.children.map((c) => c.name)).toEqual(['marker']);
  });

  it('allocates no new buffers while playing', () => {
    const { scene, camera } = world();
    const seq = intro.createIntro({ scene, camera });
    const sheet = seq.root.getObjectByName('poster-sheet') as THREE.Mesh;
    const splats = seq.root.getObjectByName('paste-splatter') as THREE.InstancedMesh;
    const sheetArray = sheet.geometry.attributes.position.array;
    const splatArray = splats.instanceMatrix.array;
    const children = scene.children.length;
    const nodes = graph(seq.root).length;
    playThrough(seq);
    expect(sheet.geometry.attributes.position.array).toBe(sheetArray);
    expect(splats.instanceMatrix.array).toBe(splatArray);
    expect(scene.children).toHaveLength(children);
    expect(graph(seq.root)).toHaveLength(nodes);
    seq.dispose();
  });

  it('picks a poster variant from the seed, and the variant option wins', () => {
    const { scene, camera } = world();
    const seen = new Set<number>();
    for (let seed = 1; seed <= 12; seed++) {
      const a = intro.createIntro({ scene, camera, seed });
      const b = intro.createIntro({ scene, camera, seed });
      expect(b.posterVariant, `seed ${seed} is deterministic`).toBe(a.posterVariant);
      seen.add(a.posterVariant);
      a.dispose();
      b.dispose();
    }
    expect(seen.size).toBe(2);
    const forced = intro.createIntro({ scene, camera, seed: 1, variant: 1 });
    expect(forced.posterVariant).toBe(1);
    forced.dispose();
  });

  it('leaves the kid at the runner’s home, running, at the handover', () => {
    const { scene, camera } = world();
    const seq = intro.createIntro({ scene, camera });
    playThrough(seq);
    const kid = seq.root.getObjectByName('runner')!;
    expect(kid.position.length()).toBeLessThan(0.02);
    // facing -z (a whole number of turns away from 0)
    expect(Math.abs(Math.sin(kid.rotation.y))).toBeLessThan(0.02);
    expect(Math.cos(kid.rotation.y)).toBeGreaterThan(0.99);
    seq.dispose();
  });

  it('the flying paste settles before the torch arrives', () => {
    const { scene, camera } = world();
    const seq = intro.createIntro({ scene, camera });
    const splats = seq.root.getObjectByName('paste-splatter') as THREE.InstancedMesh;
    seq.seek(0.5);
    expect(splats.visible).toBe(true);
    seq.seek(3.0);
    expect(splats.visible).toBe(false);
    seq.dispose();
  });
});
