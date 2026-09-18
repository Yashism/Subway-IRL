# Subway IRL

An endless runner you play with your body. A webcam watches you through a pose model: **jog in
place to keep running**, and if you stop for more than two seconds the ticket inspector catches
you. Mumbai Local theme — chawls, catenary masts, real station names, and a TT who does not give up.

Runs entirely on this laptop. The video never leaves the machine and nothing is uploaded.

## Play

```bash
npm run dev          # then open http://localhost:5173/ in Windows Chrome
```

Allow the camera, stand back far enough to be seen, hold still for two seconds to calibrate, then
**raise your right hand** to start.

| You do | The game does |
|---|---|
| Jog in place | Keep running (stop > 2 s and you are caught) |
| Jog fast | Fill the Josh meter — double coins |
| Step / lean left or right | Change lane |
| Jump | Jump |
| Squat or duck | Roll |
| Both hands up | Hoverboard |
| Right hand up | Start the run |

**Keyboard** (works alongside, and on its own): ← → lanes · Space jump · S roll · Ctrl hoverboard ·
Enter start · Esc pause · N mute · M live monitor.

### Two play modes

- **Full body** — room to jog, knees and arms visible. Lanes change by stepping sideways.
- **Small room** — a desk, a sofa, a small flat. Lanes change by leaning; arm pumps count as jogging.

Auto-detected, overridable in Settings.

### The Move Check

After calibration (and any time you Recalibrate) the game walks you through all six moves one at a
time, shows you how far each attempt got, and **tunes its thresholds to your body** — roughly 55 %
of what you actually managed, so a move is comfortably reachable but still above your noise floor.
If a move will not register, "Use my best attempt" accepts what you managed. Tuning is saved per
mode. The summary doubles as a controls cheat sheet, and is on the pause screen as **Controls**.

## Screens

- **Menu** — missions, the daily challenge, your level, the shop.
- **Settings** (⚙, from the menu or pause) — sensitivity, play mode, camera, audio, line
  (Western / Central / Harbour), difficulty (Chill / Cardio / Beast), reduced motion and effects,
  export or clear your data.
- **Your runs** — today's active minutes and steps, a week chart with your streak, all-time totals,
  and your last 30 runs. Calories are a rough estimate and labelled as one.
- **Live monitor** (`/monitor.html`, or press **M**) — open it in a **separate window**,
  not a tab: a hidden tab pauses the game. It shows the skeleton the game sees, the moves it
  detected, the commands they became, and the idle clock, live. **Record session** saves a JSON file
  that can be replayed with `?session=`, which is the best way to report a problem.

## URL options

`?input=keyboard` · `?mode=full|small` · `?line=western|central|harbour` · `?difficulty=` ·
`?sens=` · `?intro=always|off` · `?movecheck=skip|force` · `?mute` · `?vol=0.5` · `?audio=0` ·
`?posereplay=<fixture>` · `?session=<recording>` · `?autopilot` · `?perf` · `?god`

## Development

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + vite build
```

Harness pages, all camera-free: `debug.html` (pose), `gallery.html` (3D models),
`moveCheck-harness.html`, `settings-harness.html`, `missions-harness.html`, `intro-harness.html`,
`audio-lab.html` (renders every sound cue offline and draws its waveform), `monitor-harness.html`.

Screenshots for visual checks use `shoot <url> <out.png> [readyExpr] [settleMs]`. Playwright is not
used in this project.

### How it is put together

```
src/pose/      MediaPipe in a worker, smoothing, calibration, jog/lane/jump/roll detectors, move check
src/game/      Deterministic fixed-step simulation: track, collision, rules, power-ups, missions
src/world/     three.js: procedural models and textures, curved world, the intro cinematic
src/audio/     Web Audio: sampled cues with synthesised fallbacks, music bed, jog pulse
src/app/       Session flow, the frame loop, settings, stats, progression
src/ui/         HUD and screens
src/monitor/   The live debug page and session recorder
```

The simulation is deterministic and seeded: the same seed and inputs produce the same run, which is
what lets recorded sessions be replayed and the autopilot bot be a test.

## Assets and licences

All 3D models and textures are generated in code, except a few CC0/CC-BY character models in
`public/models/`. Sound is real recordings where a freely licensed one exists and synthesis where
none does. Every file is listed with its source, author and licence in `public/audio/CREDITS.md`
and `public/models/CREDITS.md`, including what was rejected and why.

`assets/` holds the owner's local reference rips. It is gitignored, never used by the game, and
never committed.

## Name

"Subway IRL" is a personal, local-only working title. "Subway" and "Subway Surfers" are existing
trademarks, so the name would need changing before this went anywhere public.
