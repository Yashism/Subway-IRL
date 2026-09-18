# Subway IRL — Design Spec

**Date:** 2026-09-16
**Status:** Draft, awaiting user review

## 1. Summary

Subway IRL is a browser endless-runner that plays like Subway Surfers, with an Indian (Mumbai Local) theme, controlled by the player's body through the laptop webcam. The player jogs in place to keep running, steps or leans to change lanes, jumps to jump, squats or ducks to roll, and raises both hands to activate a hoverboard. If they stop jogging for more than 2 seconds, the chaser (a railway TT and a street dog) catches them and the run ends. The game also works as a workout tracker: it counts moves and steps and estimates calories.

### Goals (V1)
- One world, **Mumbai Local**, with gameplay closely matching Subway Surfers.
- Pose controls with two play modes: **full-body** and **small-room**.
- High-detail stylised 3D at a steady 60 fps on the target laptop, with pose tracking running at the same time.
- Fitness summary per run and a local session history.
- Runs **locally only** (`npm run dev`), played in Windows Chrome or Edge.

### Non-goals (V1)
- Missions, score multipliers, shop, character unlocks, paid continues, daily challenges.
- Additional worlds (Delhi Metro, Varanasi, etc.) and festival events.
- Online hosting, accounts, leaderboards, backend.
- Mobile support.
- Any Subway Surfers assets, names, logos or music.

## 2. Target hardware and environment

- ASUS Zenbook 14 UX3405CA: Intel Core Ultra 7 255H (16 cores), Intel Arc 140T iGPU (shared memory), 32 GB RAM, 2880×1800 120 Hz display, "USB2.0 FHD UVC WebCam" plus an IR camera (must never be selected).
- Development happens in WSL2. The dev server runs in WSL. The game is opened at `http://localhost:5173` in **Windows** Chrome or Edge, because WSL2 has no webcam access and `localhost` counts as a secure context for `getUserMedia`.
- Recommended play conditions: laptop plugged in, Windows power mode set to "Best performance".

## 3. Architecture

**Stack:** Vite, TypeScript (strict), `three`, `@mediapipe/tasks-vision`, Vitest. The UI is plain TypeScript and CSS with no framework. The game loop is custom.

```
src/
  pose/     camera, MediaPipe worker, filtering, calibration, move detectors
  input/    merges pose + keyboard into one command stream
  game/     simulation: runner, lanes, chunks, collisions, power-ups, chaser, score, state machine
  world/    asset loading, chunk recycling, lighting, theme, quality tiers
  ui/       screens, HUD, camera PiP, summary, history, settings
  audio/    music + SFX
  main.ts
debug.html      pose debug page + fixture recorder
assets-src/     raw assets (FBX, GLB, PNG) -> public/assets/ via `npm run assets`
scripts/        asset pipeline
tests/          unit tests; tests/fixtures/ recorded landmark sessions
docs/asset-brief.md   Meshy/Tripo prompts + Mixamo checklist
```

### Module boundaries
- **`pose/`** knows nothing about the game. It outputs:
  - Events: `{type:'lane', lane:-1|0|1}` (full-body mode), `{type:'laneShift', dir:-1|1}` (small-room mode), `{type:'jump'}`, `{type:'roll'}`, `{type:'hoverboard'}`, `{type:'start'}`, `{type:'lost'}`, `{type:'found'}`.
  - Status (polled every frame): `{tracking, mode, poseFps, confidence, jog:{active, cadenceSpm, msSinceStep}, landmarks}`.
- **`input/`** turns pose events and keyboard input into `GameCommand`s: `setLane`, `shiftLane`, `jump`, `roll`, `hoverboard`, `start`, `pause`. Keyboard mapping: ←/A and →/D shift lane, Space (or ↑/W) jump, S/↓ roll (duck), Ctrl hoverboard, Enter start, Esc/P pause, **J held = jogging** (so the jog rule can be tested with the keyboard). In keyboard-only mode the jog rule is disabled unless J-jog is enabled in settings.
- **`game/`** knows nothing about the camera or rendering. It is a deterministic simulation with a fixed 60 Hz step and a seeded RNG. It consumes commands and the jog status, and exposes state for `world/` and `ui/` to render.
- **`world/`** reads the game state and renders it. It never changes the game state.

### Threads
- The pose model runs in a **Web Worker**. The main thread sends video frames to the worker as `ImageBitmap`s. The worker uses the GPU delegate through OffscreenCanvas.
- Fallback chain, applied automatically: worker + GPU → main thread + GPU → Lite model. A warning is shown if pose fps stays below 15.
- Pose runs at up to 30 fps. The game renders at 60 fps, or 120 when unlocked. Detectors use timestamps, not frame counts.

## 4. Pose detection (`pose/`)

**Model:** MediaPipe Pose Landmarker **Full** (Lite is the fallback), `numPoses: 2`. Camera request: 640×480, 30 fps, from the selected device. The image is mirrored for display and all left/right logic.

**Smoothing:** a One Euro filter on every landmark used.

**Units:** every threshold is expressed in **torso lengths** (T = distance from the shoulder midpoint to the hip midpoint) or, in small-room mode, **shoulder widths** (S). This keeps detection independent of the player's size and distance from the camera.

**Player lock:** when two people are detected, the game tracks the pose nearest the calibrated hip centre (or, before calibration, the largest pose).

### 4.1 Calibration (about 2 s, before every run)
- The player stands still with arms down inside an on-screen outline. Calibration succeeds after 2 s of low movement.
- It records the baseline: hip centre (x, y), shoulder centre, nose, knee heights, T and S.
- Live checks with hints:
  - body visible
  - distance ("step back" / "come closer")
  - brightness (average luma of the frame; "too dark")
- **Mode auto-select:** full-body mode if hips and both knees are visible (landmark visibility > 0.6); otherwise small-room mode. Can be overridden in settings.
- **Baseline drift:** while the player is still, the baseline follows the current position slowly (EMA with a ~3 s time constant). While jogging, the vertical baseline is the 1 s moving average of hip y.

### 4.2 Full-body mode

| Move | Rule |
|---|---|
| Lane | Hip-centre x offset from the calibrated centre sets the lane zone. Entering a side zone takes \|offset\| ≥ 0.5 T, leaving it takes \|offset\| < 0.35 T (hysteresis). Emits `lane` on every zone change. |
| Jump | Upward hip velocity > 1.5 T/s **and** rise above the vertical baseline > max(0.15 T, 2.5 × current jog bob amplitude). Re-armed once the hip is back within 0.08 T of baseline. |
| Roll | Hip drop > 0.3 T below baseline held ≥ 100 ms, **or** nose drop > 0.4 T. Re-armed on standing back up. |
| Jog step | Alternating knee lifts: a knee rises > 0.12 T above its standing height, and each step must come from the other knee than the previous one. Fallback when knees are not visible: hip vertical oscillation with amplitude > 0.03 T at 1.5–4 Hz, one step per half-cycle. |

A jump that follows a roll within 250 ms is allowed; the game cancels the roll.

### 4.3 Small-room mode

| Move | Rule |
|---|---|
| Lane | Swipe-style: shoulder-line tilt > 15° **or** nose x offset > 0.35 S emits `laneShift(dir)`. Re-armed when the player returns within 7° / 0.2 S. |
| Jump | Shoulder-midpoint rise > max(0.12 S, 2.5 × bob amplitude) with sharp upward velocity (> 1.2 S/s). |
| Roll | Nose drop > 0.3 S below baseline. |
| Jog step | Alternating wrist pumping (the wrists alternate vertically with amplitude > 0.15 S) **or** rhythmic shoulder/head bob (amplitude > 0.03 S at 1.5–4 Hz). |

### 4.4 Gestures (both modes)
- **Hoverboard:** both wrists above the nose for ≥ 300 ms.
- **Start / resume:** right wrist above the right shoulder for 1.5 s. The UI shows a ring filling up.
- **Lost:** no tracked pose for 1 s emits `lost` (the game pauses). A pose reappearing emits `found`, followed by a quick position check and a 3-2-1 countdown.

### 4.5 Sensitivity
A single sensitivity setting (0.75×–1.25×) scales every threshold. The debug page exposes each threshold individually.

## 5. Gameplay (`game/`)

### 5.1 Runner
- 3 lanes, 2.5 m apart. A lane change takes 0.15 s, with the body tilting slightly.
- Forward speed starts at 12 m/s and eases up to 30 m/s over about 240 s. Difficulty scales the curve: Chill ×0.8, Cardio ×1.0, Beast ×1.2 top speed and ramp rate.
- Jump: about 0.6 s airtime, clears low obstacles. Roll: about 0.6 s, clears overhead obstacles.
- Rolling in mid-air slams the runner down. Jumping during a roll cancels the roll.
- Train roofs are walkable surfaces reached by ramps (or by jumping while wearing the chappals).

### 5.2 Human-latency tuning
- Assumed input latency is about 350 ms, so obstacles become visible ≥ 2.5 s ahead.
- **Minimum gap between required actions:** 1.2 s at the start, tightening linearly with difficulty to a floor of 0.8 s.
- The first 20 s of a run are a warm-up with sparse obstacles and mostly coins.

### 5.3 Chunks
- About 30 hand-designed 60 m chunks, tagged by difficulty tier (1–4). The generator picks chunks by current tier using the seeded RNG. Each chunk declares its entry and exit lane states, so joins are always valid.
- **Solvability is enforced by a test:** for every chunk and every allowed join, a path exists that respects the minimum-gap rule at that tier's speed.

### 5.4 Obstacles

| Obstacle | Solution |
|---|---|
| Parked local train | Change lane, or take the ramp and run on the roof |
| Oncoming train | Change lane. Announced ≥ 3 s ahead with a horn and headlight |
| Low bamboo barrier / handcart | Jump |
| Overhead banner / signboard | Roll |
| Parked auto-rickshaw / sitting cow | Lane blocker, so change lane |

### 5.5 Failure rules
- **Frontal collision:** caught (run ends). Absorbed if a hoverboard is active.
- **Side clip while changing lanes:** stumble, bounce back to the previous lane, and the chaser closes in. A second stumble within 8 s means caught.
- **Idle:** once `msSinceStep` passes 1000, the warning starts (music drops out, red edge pulse, "Bhaago!", chaser visibly closes in). At `msSinceStep` ≥ 2000 the player is caught.
  - Jump, roll and lane events reset `msSinceStep`.
  - A held squat keeps resetting it for at most 1 s.
  - The idle timer is suspended during calibration, countdowns, pause and menus.
  - **A hoverboard is a rest** (added 2026-09-18 at the user's request: "Make hoverboard as thing where human can rest so don't have to jog"). While one is active the player may stop jogging and cannot be caught for it, the warning and heartbeat stay off, and the chaser falls back. When it ends — timed out, or spent absorbing a crash — the idle timer restarts, so the player gets the full 2 s to start jogging again rather than a catch for time they were allowed to rest. See §5.7.
- Losing tracking pauses the game. It never counts as idle.

### 5.6 Chaser
The TT and dog start right behind the runner, drop out of view after about 4 s, and return on a stumble or an idle warning. They play the catch animation on game over.

### 5.7 Collectibles and power-ups
- **Coins (₹):** placed in lines, arcs and along train roofs.
- **Score** = metres run + coins collected.
- **Josh meter:** fills while cadence stays ≥ 160 spm and drains otherwise. While full, coins count double.
- **Magnet (10 s):** pulls in coins from all lanes.
- **Diwali Rocket (8 s):** flight above the trains along a coin trail. Lane changes still work, jump and roll are disabled, and the **jog rule still applies**. It ends with a safe landing window of 1 s with no obstacles.
- **Kolhapuri Chappals (10 s):** higher, longer jumps that can reach train roofs.
- **Hoverboard:** 3 per run, activated by gesture (or Ctrl). Lasts 30 s or until it absorbs one crash. It can't be activated again while one is active.
  - **It is also a rest.** For a webcam player (the jog rule in force) the board suspends the idle catch, so it doubles as a breather mid-workout — three per run, up to 30 s each. The HUD names its timer "Rest", says "Rest — catch your breath" as it arrives, and "Get ready to jog!" in its last 3 s (`TUNING.restWarnSeconds`) if the player is still standing. The jog pulse drops to a faint tick while they rest (faint, not silent, so the tempo stays in their head) and returns at its strongest for those last seconds.
  - **Resting is still counted honestly.** The game keeps two idle signals: `idleLevel`, which the catch rule acts on and which a rest excuses, and `movingLevel`, which is never excused. Missions that ask for unbroken jogging read `movingLevel`, so a rest breaks the streak; and time spent resting (on the board and not moving) is left out of the workout's active minutes, because that screen promises what the player actually moved.
  - Keyboard play has no jog rule, so there the board is only a shield, labelled "Hoverboard" as before.

### 5.8 State machine
`Menu → Calibrate → Countdown → Playing ⇄ Paused → Caught → Summary → (Calibrate | Menu)`. `Paused` is entered on `lost`, a hidden tab, or WebGL context loss.

### 5.9 Persistence (`localStorage`, wrapped in try/catch)
- Best score and total coins.
- Settings.
- Selected camera `deviceId`.
- The last 30 session summaries.

## 6. World, assets and audio (`world/`, `audio/`)

### 6.1 Asset manifest
`public/assets/assets.json` maps each logical id to `{file, scale, rotation, animations{logical: clipName}, lods?}`. Every id also has a primitive placeholder defined in code. A missing or failed asset falls back to its placeholder with a console warning, so the game is always playable.

Logical ids (V1):
- `runner`, `tt`, `dog`
- `track_segment`, `train_car`, `ramp`
- `barrier_low`, `handcart`, `banner_high`, `auto`, `cow`
- `coin`, `pu_magnet`, `pu_rocket`, `pu_chappal`, `hoverboard`
- `side_chawl_*`, `side_platform_*`, `side_fob`, `side_wall_*`, `skyline`

### 6.2 Characters

| Id | Description | Budget | Animation clips |
|---|---|---|---|
| runner | Mumbai street kid: hoodie, jeans, sneakers, backpack | ≤ 30k tris, 2K texture | run, jump, roll, stumble, caught, idle, hover, fly (+ additive lean) |
| tt | Railway TT: white shirt, black coat, badge, clipboard, moustache | ≤ 25k tris | run, catch, whistle |
| dog | Indian street dog, tan | ≤ 10k tris | run, bark |

- **Runner and TT pipeline:**
  1. Generate the model in Meshy or Tripo (A-pose).
  2. Decimate it.
  3. Rig it in Mixamo and download each animation as FBX (one with skin, the rest without).
  4. `scripts/` converts the files with FBX2glTF and merges the clips into one GLB with gltf-transform.
- **Dog:** based on the Quaternius CC0 animated dog, recoloured, because Mixamo only rigs humanoids.

### 6.3 Environment
- **Track segment:** 20 m, tileable: three rail pairs, sleepers, ballast, OHE masts. Sleepers and masts are instanced.
- **Train car:** built in code from simple geometry with a detailed hand-painted/generated texture atlas (cream and maroon livery, open doors, window bars, roof vents, baked AO and grime).
- **Side strips,** chosen randomly per chunk:
  - chawls (laundry, AC units)
  - station platform with chai stall and benches
  - foot overbridge
  - walls with fictional ads
  - water tanks
  - tangled wires
- **Far background:** a skyline card with distance haze/fog to hide pop-in.
- **Sources:** Kenney and Quaternius CC0 packs for generic pieces, Meshy/Tripo for India-specific props. Every third-party source is listed in `CREDITS.md`.

### 6.4 Rendering
- Warm late-afternoon sun (a single shadow-casting directional light whose tight shadow frustum follows the runner), a hemisphere fill light, and a gradient sky dome.
- Khronos PBR Neutral tone mapping by default, with bloom on Medium and High. AgX was the first choice, but it dulled the saturated yellows (the cab, the auto hood, the coins). AgX and ACES stay available through `?tone=agx` and `?tone=aces`.
- Baked AO in the textures.
- Object pools for chunks, props and coins. Nothing is allocated per frame during play.

| Tier | Pixel ratio | Shadows | Bloom | LOD bias |
|---|---|---|---|---|
| Low | 1.0 | off | off | aggressive |
| Medium | 1.25 | 1024 | light | normal |
| High | 1.5 | 2048 | on | light |

- **Auto-tier:** start at Medium, measure frame time over the first 5 s of play, and step down if it's below 55 fps or up if it holds a comfortable 60 fps.
- **Frame target:** 60 fps (120 fps is an opt-in setting).
- **Budgets:** ≤ 150 draw calls, ≤ 500k visible triangles, ≤ 512 MB of textures.

### 6.5 Asset pipeline (`npm run assets`)
- Steps: FBX → GLB (FBX2glTF), clip merge, meshopt compression, KTX2 textures, LOD generation (gltf-transform simplify).
- Output goes to `public/assets/`.
- Required tools: Node, `@gltf-transform/cli`, FBX2glTF, KTX-Software (`toktx`). The pipeline script checks for them and prints install instructions when one is missing.

### 6.6 Audio
- Dhol/tabla music loop.
- SFX: coin, train horn, TT whistle, rocket, landing.
- Voice lines "Chalo!" and "Bhaago!" (recorded by the user or generated with TTS).
- CC0 sources only (Pixabay, Freesound), all listed in `CREDITS.md`.
- Audio starts after the first user gesture, as browser autoplay policy requires.

### 6.7 Asset brief
`docs/asset-brief.md` contains:
- ready-to-paste Meshy/Tripo prompts
- reference notes
- triangle and texture budgets
- a step-by-step Mixamo checklist with the exact clip names the manifest expects
- where to drop the files in `assets-src/`

The user produces the AI-generated and Mixamo assets. The code and pipeline are written by Claude.

## 7. UI (`ui/`)

- **Menu:** the 3D scene with the runner idling. "Raise your right hand to start (or press Enter)". Buttons for Settings and History.
- **Settings:**
  - mode (auto / full / small)
  - quality (auto / low / medium / high)
  - 120 fps unlock
  - difficulty
  - camera picker (devices whose label contains "IR" are hidden by default)
  - body weight (kg, default 60)
  - sensitivity
  - volume
  - keyboard J-jog
  - debug/perf overlay
- **Camera permission:** a short explanation first. If permission is denied or the camera is busy, show a message, a retry button, and a keyboard-only option.
- **Calibration:** body outline, live checklist, hints.
- **HUD:**
  - score and coins
  - power-up timers
  - hoverboard count
  - Josh meter
  - jog indicator (footsteps pulsing with each step, plus spm)
  - idle warning (red edge pulse)
  - move-detected icons
  - camera PiP with skeleton (toggleable)
- **Pause:** "Step back into frame", then a countdown.
- **Summary:**
  - score, coins, distance, time
  - jumps, rolls, lane changes, steps, average spm, jog % of run time, ≈ kcal
  - new-best badge
  - "Raise your hand to play again"
- **History:** the last 30 sessions and a weekly minutes/kcal bar chart.
- **Perf overlay:** fps, draw calls, triangles, pose fps, quality tier.

### Calorie estimate
- `kcal = Σ MET(cadence) × weightKg × Δhours`, where MET rises linearly from 6 at ≤ 100 spm to 10 at ≥ 180 spm, and is 3 while not jogging.
- Plus 0.2 kcal per jump and 0.3 kcal per roll/squat.
- Always displayed as an approximation ("≈").

## 8. Error handling

| Condition | Behaviour |
|---|---|
| No camera / permission denied / device busy | Message, retry button, keyboard-only mode |
| IR camera | Hidden by default; the chosen `deviceId` is remembered |
| Worker or GPU delegate failure | Fallback chain (§3); warning if pose fps < 15 |
| Low light | Hint during calibration |
| Multiple people | Lock onto the pose nearest the calibrated centre |
| Tab hidden / WebGL context lost | Pause; restore resources on context restore |
| Asset load failure | Placeholder plus console warning |
| `localStorage` unavailable | Game works; progress is simply not saved |

## 9. Testing

- **Unit tests (Vitest):**
  - One Euro filter
  - calibration maths
  - each detector, run against recorded fixtures:
    - jumps, rolls, leans, steps
    - pre-jump dip does **not** roll
    - jogging does **not** jump
    - jog → jump and jog → squat fire correctly
  - the game simulation:
    - lanes and collisions
    - stumble rule
    - idle warning at 1 s and caught at 2 s
    - timer suspension
    - power-up durations
    - hoverboard absorption
    - Josh meter
  - chunk solvability
  - calorie maths
- **Fixture recorder:** on `debug.html`. It saves timestamped landmark streams as JSON in `tests/fixtures/`, recorded by the user in both modes.
- **Replay mode:** `?replay=<fixture>.json` swaps the camera for a fixture-driven pose source. This lets the full game run headless.
- **Visual checks:** `shoot` screenshots of the menu, calibration, HUD in play, caught and summary screens, all under replay mode. Each PNG is read back and inspected.
- **Performance:** the perf overlay plus a manual playtest checklist on the target laptop (plugged in, Windows Chrome, both modes, 5-minute run, fps ≥ 55 on the chosen tier).

## 10. Build order (for the implementation plan)

1. Project scaffold, and `pose/` with `debug.html`, the fixture recorder and detector tests.
2. `game/` simulation with keyboard input, rendered with placeholders in `world/`.
3. Connect pose to input: calibration, the jog rule, the full play loop.
4. UI screens, HUD, summary, history, settings.
5. Asset pipeline, asset brief, Mumbai Local environment, lighting, quality tiers.
6. Characters and animations integrated as the user delivers them; audio.
7. Power-ups polish, perf tuning, playtest pass.

## 11. Notes

- "Subway IRL" is used as a personal, local-only project name. Before any public release, the name should be reconsidered, because "Subway" and "Subway Surfers" are existing trademarks.
