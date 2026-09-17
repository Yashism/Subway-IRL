# Subway IRL — Visual Overhaul (spec addendum)

**Date:** 2026-09-17
**Status:** Approved by the user ("full permission, implement from the spec, no separate plan").
**Extends:** `2026-09-16-subway-irl-design.md` §6. It replaces the Phase 2 placeholder boxes with a Subway Surfers-grade look.
**Style reference:** the research notes (camera, curved world, palette, juice), summarised below.

## Goals

- **Look:** chunky, saturated, toon-lit 3D with a curved horizon. The Subway Surfers feel, but every design is original and Mumbai-themed.
- **Assets:** every asset is generated in code (procedural geometry plus canvas-drawn textures), or is a free CC0/CC-BY model. The user's ripped Subway Surfers and Brawl Stars files in `assets/` are local-only and gitignored. They are never the default, and never committed.
- **Gameplay stays authoritative:** visuals must match the collision shapes in `src/game/obstacles.ts` and `TUNING`, and must never change game behaviour.
- **Performance:** 60 fps on an Intel Arc 140T iGPU. The pixel ratio stays at or below 1.25, with at most about 150 draw calls and 500k triangles.

## Shared rendering core (done: `src/world/render/`)

| File | What it provides |
|---|---|
| `materials.ts` | `toonMaterial()` for hero objects, `flatMaterial()` for the environment, `basicMaterial()` for unlit surfaces, `addOutline(root)` (an inverted-hull outline, for hero objects only), `enableShadows(root)`, and `curveUniforms` (the curved-world bend; the runner is at z = 0) |
| `canvasTexture.ts` | `canvasTexture(key, w, h, draw)` (cached), `seededRandom(seed)`, `speckle()`, `streaks()` |

**Gallery:** `gallery.html?only=<id-substring>[&angle=<deg>]` shows every entry exported from any `src/world/**/*.gallery.ts` (`export const entries: GalleryEntry[]`, typed in `src/gallery/types.ts`). Use it with `shoot` to check models visually.

## Model contract (every obstacle/prop builder)

- Units are metres. The object stands on y = 0, is centred on x = 0, and its **near end is at z = 0, extending toward −z** by its length. This is the same convention the world view uses: world z = −(s − runnerS).
- Builders are pure functions that return a `THREE.Group`. Share geometries and materials through module-level caches. Never allocate per frame.
- Visual extents must match the collision boxes:

| Kind | Length along the track | Height band (y) | Visual width | Notes |
|---|---|---|---|---|
| `trainParked` | variable (the `length` argument; default 30) | 0 → 3.2 (the roof is walkable at 3.2) | ≤ 2.3 | local-train coach(es); the underframe may look recessed, but the solid body must fill 0–3.2 |
| `trainMoving` | variable | 0 → 3.2 | ≤ 2.3 | yellow nose facing +z (toward the runner), headlights, a different livery |
| `barrierLow` | 0.5 | 0 → 1.0 | 2.0 | bamboo / red-white striped railway barrier: jump over it |
| `handcart` | 1.5 | 0 → 1.1 | 1.6 | wooden thela with fruit and vegetables: jump over it |
| `bannerHigh` | 0.5 | a 1.0 → 3.0 board | 2.2 | a flex banner or signboard on two thin posts; the posts must be thin and at the lane edges (x = ±1.1) |
| `auto` | 3.0 | 0 → 2.0 | 1.4 | a Mumbai black-and-yellow auto-rickshaw facing +z |
| `cow` | 2.5 | 0 → 1.6 | 1.0 | a sitting or standing cow |
| `ramp` | 8 | walkable surface rising 0 → 3.2 over the first 7 m | 2.2 | a wooden or steel ramp up to the train roof |

- Pickups: coin (a ₹ coin about 0.7 m in diameter, gold and emissive), magnet, Diwali rocket and Kolhapuri chappals, each about 0.9 m, centred at y = 1.
- Characters: runner (1.8 m tall), TT (1.85 m) and street dog (0.6 m). They face −z (running away from the camera). Each has an animation API (see below).

## Modules to build

| Area | Files | Contents |
|---|---|---|
| Trains | `src/world/models/trains.ts` (+ `.gallery.ts`) | coach builder (length, livery `western` \| `central`, `seed`); oncoming variant with cab nose; ramp |
| Track and scenery | `src/world/models/scenery.ts`, `src/world/models/trackKit.ts` (+ galleries) | ballast/sleeper/rail instancing kit; catenary masts and wires; signals; platform with canopy; foot overbridge; chawl buildings (several variants, balconies, AC units, laundry); graffiti walls; fences; billboards (fictional ads); water tanks; trees; far skyline card; sky dome gradient |
| Props and pickups | `src/world/models/props.ts` (+ gallery) | auto, cow, handcart, low barrier, banner (fictional Hindi/English text), coin, magnet, rocket, chappals, hoverboard (flying carpet or board) |
| Characters | `src/world/models/characters.ts` (+ gallery) | runner kid, TT, dog, as articulated models with a code-driven animation controller (see below) |
| Integration and juice | `src/world/worldView.ts`, `src/world/fx.ts`, `src/ui/*` | swap the placeholders for the kits; camera rig; curved world; bloom; coin sparkles; speed lines; crash shake; magnet aura; rocket flame; restyle the HUD in the Subway Surfers layout |

### Character animation API

```ts
export type CharacterAction = 'idle' | 'run' | 'jump' | 'roll' | 'fall' | 'stumble' | 'caught' | 'hover' | 'fly';
export interface CharacterRig {
  root: THREE.Group;
  /** Advance the animation. speed is in m/s; lean runs -1..1 (lane change direction). */
  update(dt: number, state: { action: CharacterAction; speed: number; lean: number; airborneT?: number }): void;
}
export function createRunner(): CharacterRig;
export function createInspector(): CharacterRig;
export function createDog(): CharacterRig;
```

Procedural rigs (jointed limbs animated in code) are the guaranteed baseline. A CC0 rigged GLB (Quaternius and similar) may replace them later behind the same API.

## Camera and look (research notes, scaled to our 2.5 m lanes)

- **Camera:** FOV 62°, 3.4 m above the rails and 6.2 m behind the runner, looking at a point about 10 m ahead at 1.2 m.
  - Lane follow: exponential at 8 Hz, tracking 60% of the runner's x.
  - Jump follow: 45% of the runner's height.
  - Crash shake: 0.18 m and ±3°, decaying over 0.35 s.
  - FOV: +5° while on the rocket.
- **Curve:** vertical 0.0016 and horizontal 0.0004 per m², applied ahead of the runner only.
- **Light:** sun `#FFF1D6` with soft PCF shadows (a tight frustum around the runner), hemisphere light `#BFE3FF` / `#6B5B4A`, and Khronos PBR Neutral tone mapping by default. AgX was the first choice, but it dulled the saturated yellows; AgX and ACES stay available through `?tone=agx` and `?tone=aces`.
- **Sky:** a gradient dome from `#7EC8F2` to `#FFE1A8`, with fog matched to the horizon colour from 60 to 170 m.
- **Palette:** as in the research notes. Graffiti accents `#E5399B #29C7E0 #FF7A29 #FFD400`; chawl facades `#D9A441 #4C8C7D #8FB8C9 #C1622B #EDE6D6`.
- **Liveries:**
  - Western: cream `#F0E6C8`, maroon band `#7A2E3A`, yellow nose `#FFD400`, red first-class stripe `#E8433A`
  - Central: grey-blue `#B7C4CC`, navy band `#274472`

## Verification

- Every module ships its gallery entries and is checked with `shoot http://localhost:5173/gallery.html?only=<id>`. The PNG is opened and inspected.
- The integrated game is checked with `?autopilot&perf` screenshots and fps/draw-call numbers.
- All existing tests keep passing, and `tsc` and `npm run build` stay green.
