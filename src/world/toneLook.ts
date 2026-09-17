import * as THREE from 'three';

/**
 * AgX "look" (Blender / Filament agxLook): three.js ships AgX without one, which reads flat
 * and dulls saturated yellows. This fills the empty look slot with a punchy-style grade:
 * a power curve for contrast and a saturation boost around luma. Call once, before any
 * material compiles. Idempotent.
 */
export interface AgxLook {
  power: number;
  saturation: number;
}

export const PUNCHY: AgxLook = { power: 1.35, saturation: 1.4 };

const MARKER = '// Apply AgX look';
let applied: string | null = null;

export function applyAgxLook(look: AgxLook = PUNCHY): boolean {
  const key = `${look.power}|${look.saturation}`;
  if (applied === key) return true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const src = chunks.tonemapping_pars_fragment;
  if (applied !== null || !src.includes(MARKER)) return false;
  const p = look.power.toFixed(4);
  const s = look.saturation.toFixed(4);
  chunks.tonemapping_pars_fragment = src.replace(
    MARKER,
    `${MARKER} (punchy)
	{
		float agxLuma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
		color = pow( max( color, vec3( 0.0 ) ), vec3( ${p} ) );
		color = max( vec3( agxLuma ) + ${s} * ( color - vec3( agxLuma ) ), vec3( 0.0 ) );
	}`,
  );
  applied = key;
  return true;
}
