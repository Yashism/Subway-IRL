import * as THREE from 'three';

/**
 * Shared "curved world" uniforms (Subway Surfers-style horizon bend). The runner is
 * always at z = 0 (floating origin), so the bend depends only on a vertex's world z.
 * One update of these values drives every curved material in the scene.
 */
export const curveUniforms = {
  uCurveVertical: { value: 0.0016 },
  uCurveHorizontal: { value: 0.0004 },
  uCurveEnabled: { value: 1 },
};

const CURVE_PATCHED = Symbol('curvePatched');

/** Adds the curved-world bend to any built-in material (works with instancing and skinning). */
export function applyCurve<T extends THREE.Material>(material: T): T {
  const m = material as T & { [CURVE_PATCHED]?: boolean };
  if (m[CURVE_PATCHED]) return material;
  m[CURVE_PATCHED] = true;
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    Object.assign(shader.uniforms, curveUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uCurveVertical;
uniform float uCurveHorizontal;
uniform float uCurveEnabled;`,
      )
      .replace(
        '#include <project_vertex>',
        `{
  vec4 curveWorld = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    curveWorld = instanceMatrix * curveWorld;
  #endif
  curveWorld = modelMatrix * curveWorld;
  float curveDz = min( curveWorld.z, 0.0 );
  float curveD2 = curveDz * curveDz * uCurveEnabled;
  vec3 curveOffset = vec3( -clamp( curveWorld.x / 4.0, -1.0, 1.0 ) * curveD2 * uCurveHorizontal, -curveD2 * uCurveVertical, 0.0 );
  mat3 curveToLocal = mat3( modelMatrix );
  #ifdef USE_INSTANCING
    curveToLocal = curveToLocal * mat3( instanceMatrix );
  #endif
  transformed += inverse( curveToLocal ) * curveOffset;
}
#include <project_vertex>`,
      );
  };
  const key = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${key()}|curved`;
  material.needsUpdate = true;
  return material;
}

let toonRamp: THREE.DataTexture | null = null;

/** Three-step light ramp for the toon look (shadow / mid / lit). */
export function toonGradient(): THREE.DataTexture {
  if (toonRamp) return toonRamp;
  const data = new Uint8Array([110, 110, 110, 255, 190, 190, 190, 255, 255, 255, 255, 255]);
  toonRamp = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  toonRamp.minFilter = THREE.NearestFilter;
  toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.needsUpdate = true;
  return toonRamp;
}

export interface ToonOptions {
  color?: THREE.ColorRepresentation;
  map?: THREE.Texture | null;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  vertexColors?: boolean;
}

/** Hero material: toon-shaded and curved. Use for characters, trains, obstacles, pickups. */
export function toonMaterial(o: ToonOptions = {}): THREE.MeshToonMaterial {
  return applyCurve(
    new THREE.MeshToonMaterial({
      color: o.color ?? 0xffffff,
      map: o.map ?? null,
      gradientMap: toonGradient(),
      emissive: o.emissive ?? 0x000000,
      emissiveIntensity: o.emissiveIntensity ?? 1,
      transparent: o.transparent ?? false,
      opacity: o.opacity ?? 1,
      side: o.side ?? THREE.FrontSide,
      vertexColors: o.vertexColors ?? false,
    }),
  );
}

/** Environment material: soft lit, no specular sheen, curved. */
export function flatMaterial(o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return applyCurve(new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o }));
}

/** Unlit material (sky cards, glows, flames), curved. */
export function basicMaterial(o: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  return applyCurve(new THREE.MeshBasicMaterial(o));
}

const outlineMaterials = new Map<string, THREE.MeshBasicMaterial>();

/**
 * Shared inverted-hull outline material (back faces pushed out along the normal, curved).
 * Cached per colour and thickness. Exported so instanced meshes (coins) can build their own
 * outline InstancedMesh with the same geometry.
 */
export function outlineMaterial(thickness = 0.03, color = 0x141414): THREE.MeshBasicMaterial {
  const cacheKey = `${color}|${thickness}`;
  let mat = outlineMaterials.get(cacheKey);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uOutline = { value: thickness };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uOutline;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize( normal ) * uOutline;');
    };
    mat.customProgramCacheKey = () => `outline-${thickness}`;
    applyCurve(mat);
    outlineMaterials.set(cacheKey, mat);
  }
  return mat;
}

/**
 * Inverted-hull outline: adds a slightly larger back-face black copy to every mesh
 * under `root`. Use only on hero objects (runner, trains, obstacles, pickups).
 */
export function addOutline(root: THREE.Object3D, thickness = 0.03, color = 0x141414): void {
  const mat = outlineMaterial(thickness, color);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.isOutline && !o.userData.noOutline) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    const skinned = mesh as THREE.SkinnedMesh;
    let hull: THREE.Mesh;
    if (skinned.isSkinnedMesh) {
      const s = new THREE.SkinnedMesh(mesh.geometry, mat);
      s.bind(skinned.skeleton, skinned.bindMatrix);
      hull = s;
    } else {
      hull = new THREE.Mesh(mesh.geometry, mat);
    }
    hull.userData.isOutline = true;
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.raycast = () => {};
    mesh.add(hull);
  }
}

/** Marks every mesh under root as casting and receiving shadows. */
export function enableShadows(root: THREE.Object3D, cast = true, receive = true): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !o.userData.isOutline) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
}
