# Subway IRL — Settings and Workout screens

**Date:** 2026-09-18
**Status:** Next phase after audio, approved by the user ("keep going with other things while I'm away").
**Extends:** `2026-09-16-subway-irl-design.md` §7 (build-order step 4: "UI screens, HUD, summary, history, settings").

## Why

Everything tunable currently lives in the debug monitor or a URL flag, which is fine for me and
wrong for the player. And the game already records every run — steps, distance, coins, time — but
never shows it back. For a game whose whole point is physical activity, the workout view is not a
nice-to-have: it is the reason to come back tomorrow.

## Settings screen

Reachable from the menu and the pause screen (a ⚙ button), and from the move-check summary.
Everything applies live and persists in `localStorage` (`subway-irl.settings.v1`), tolerant of
corrupt/missing/hostile data.

| Group | Control | Notes |
|---|---|---|
| **Movement** | Sensitivity slider (0.5–2.0) | The same value the monitor sends; show what it means in words ("moves trigger more easily"). |
| | Play mode: Auto / Full body / Small room | Same as the flow's mode chooser. Changing it re-applies that mode's saved tuning. |
| | **Redo the move check** | Runs the check from `src/pose/moveCheck.ts`. |
| | **Reset my tuning** | Clears the saved tuning for the current mode, with a confirm. |
| **Camera** | Camera picker | Reuses the existing list; remembers the choice. |
| | Mirror preview on/off | Display only, never affects detection. |
| **Audio** | Master / music / SFX volume, mute | Writes through to the audio settings (`subway-irl.audio.v1`). |
| **Game** | Line: Western / Central / Harbour | Today only `?line=`; make it a real setting. |
| | Difficulty: Cardio / Normal / Beast | Maps to the existing `GameOptions.difficulty`. |
| | Reduced motion / reduced effects | Cuts screen shake, speed lines and bloom for comfort and for weaker GPUs. |
| **Data** | Export my data (JSON), Clear history | Both with a confirm; clearing is irreversible and must say so. |

Keyboard and pose both navigate it: it must be usable while standing 2 m from the laptop, so
targets are large and the layout is readable at a distance.

## Workout screen

Reachable from the menu ("Your runs") and offered on the summary card after a run.

- **Today:** active minutes, steps (from the jog detector), distance run in-game, coins, runs.
- **This week:** a seven-bar chart of active minutes with today highlighted, and a streak count
  ("3 days in a row").
- **All time:** total runs, distance, coins, steps, best score, longest run, best distance.
- **Recent runs:** the last 30 from the existing profile history — score, distance, time, coins,
  mode, input, and whether it was a new best. Newest first.
- **Calories (approximate):** shown only with an explicit "rough estimate" label, derived from
  active minutes at a jogging-in-place MET; never presented as medical fact and never asks for the
  player's weight unless they offer it in settings (default: a stated assumed weight).
- Empty state for a new player that invites a first run rather than showing zeros.

## Data

`src/app/profile.ts` already stores runs (cap 30) and lifetime totals under
`subway-irl.profile.v1`. Extend rather than replace:
- Add per-run `steps`, `activeSeconds`, `mode`, `input`, and a day key (local date) so daily and
  weekly rollups are possible without keeping every run forever.
- Add a compact `days` map (local date → {activeSeconds, steps, distance, coins, runs}) capped at
  ~180 days, so the week chart and streak survive the 30-run history cap.
- Migrate old profiles forward silently; a missing field is never an error.

## Architecture

```
src/app/settings.ts    The settings model + store (pure, testable): defaults, validation, persistence
src/ui/settings.ts     The screen (+ settings.css)
src/ui/workout.ts      The screen (+ workout.css)
src/app/stats.ts       PURE rollups: today / week / streak / all-time / calories, from the profile
settings-harness.html  Both screens rendered from fixture data, no camera, no game
```

Screens follow the existing house style (`src/ui/poseScreens.css`, `hud.css`, `moveCheck.css`):
chunky rounded cards, the game's palette, every button blurs on click, no layout shift.

## Testing

- Unit: the settings store (defaults, clamping, corrupt data, migration), the stats rollups
  (day boundaries, streaks incl. a missed day, empty history, a single run, DST-safe local dates),
  and profile migration from a v1 record with no new fields.
- DOM tests (jsdom, per-file docblock) for the screens' rendering rules and button behaviour.
- Visual: `shoot` both screens from the harness — populated and empty states, and at a small window
  size. Open every PNG.
- Nothing may require a camera, audio device or network.
