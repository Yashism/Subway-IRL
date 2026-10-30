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
| Both hands up | Hoverboard — survives one crash, and is a **rest**: stop jogging for up to 30 s without being caught (3 per run) |
| Right hand up | Start the run |

**Keyboard** (works alongside, and on its own): ← → lanes · Space jump · S roll · Ctrl hoverboard ·
Enter start · Esc pause · N mute · M live monitor.

### On another device (phone, tablet, second laptop)

```bash
npm run lan            # serves https://<this computer's Wi-Fi address>:5174/ — it prints the link
npm run lan:forward    # WSL only, once (and again after a reboot): Windows asks for permission
```

Open the printed link on a device on the **same Wi-Fi**. It has to be `https`, because a browser
only lets a page use the camera on https or on localhost; the certificate is made by this computer,
so the first visit shows a "not private" warning — choose Advanced → Proceed (Chrome) or Show
Details → visit this website (Safari). Under WSL, `lan:forward` forwards port 5174 from Windows
into WSL and adds a firewall rule that lets in only that port and only devices on the local subnet;
`npm run lan:stop` removes both. `npm run lan` warns if WSL's address has changed since (it does
after a restart) — just run `lan:forward` again. This computer can keep using http://localhost:5173.

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

**Lane spots** (full-body mode). If one step either side of where you calibrated does not suit your
room, set **Lanes: My spots** and stand on your own left, centre and right spots, holding each for
a second. Lanes then change halfway between your spots. Reached from Settings › Movement ("Set my
lane spots") and from the ready screen. Small-room mode leans to change lane, so spots do not apply
there.

## Wander

A relaxed free-roam mode: walk a Mumbai-style neighbourhood (chawls, street trees, parked autos,
billboards, a railway station with a platform you can walk onto, a local that passes now and then)
with no obstacles, no inspector, no score. Menu → **Wander**, or open `/?wander`. Nothing in it is
scored or saved. **W / ↑** walk · **← →** (or A D) turn · **Q E** sidestep · **Shift** run · **P** pause ·
**Esc** back to the menu. With a calibrated camera you can jog in place to walk and lean or step to
steer (press **C** to turn the camera on from inside Wander). Code: `src/wander/`.

## Screens

- **Menu** — Play, Wander, Your runs and Settings down one side panel, with today's daily challenge,
  missions and your level beneath them. The shop is on the level strip.
- **Wander** — a free-roam walk round a Mumbai neighbourhood: streets, chawls, parks and a railway
  station with trains passing. No obstacles, no inspector, no score, and nothing is recorded.
  W / ↑ walk, ← → or A D turn, Q E sidestep, Shift run, P pause, Esc back to the menu. With the camera
  open and calibrated, jog in place to walk (jog fast to run) and lean or step to steer. `?wander`
  boots straight into it.
- **Settings** (⚙, from the menu or pause) — sensitivity, play mode, lanes (Automatic / My spots), camera, audio, line
  (Western / Central / Harbour), pace (Chill / Cardio / Beast), obstacle difficulty (1 Gentle – 5
  Brutal) and obstacle amount (Few / Normal / Lots), outlines (Off / Thin / Bold — the ink line round every model), reduced motion and effects, export or clear
  your data. Obstacle settings only ever choose among patterns the passability solver has checked,
  so every track stays clearable; the daily challenge always uses the designed ones.
- **Your runs** — today's active minutes and steps, a week chart with your streak, all-time totals,
  and your last 30 runs. Calories are a rough estimate and labelled as one.
- **Live monitor** (`/monitor.html`, or press **M**) — open it in a **separate window**,
  not a tab: a hidden tab pauses the game. It shows the skeleton the game sees, the moves it
  detected, the commands they became, and the idle clock, live. **Record session** saves a JSON file
  that can be replayed with `?session=`, which is the best way to report a problem.

## URL options

`?input=keyboard` · `?mode=full|small` · `?line=western|central|harbour` · `?difficulty=` ·
`?obstacles=1..5` · `?amount=few|normal|lots` · `?lanes=auto|spots` ·
`?sens=` · `?intro=always|off` · `?movecheck=skip|force` · `?mute` · `?vol=0.5` · `?audio=0` ·
`?posereplay=<fixture>` · `?session=<recording>` · `?autopilot` · `?perf` · `?god` · `?wander`

## Development

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run build        # typecheck + vite build
```

Harness pages, all camera-free: `debug.html` (pose), `gallery.html` (3D models),
`moveCheck-harness.html`, `laneSetup-harness.html`, `settings-harness.html`, `missions-harness.html`, `intro-harness.html`,
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
