# Subway IRL — Move Check (guided rehearsal + per-player tuning)

**Date:** 2026-09-17
**Status:** Approved by the user ("When recalibrating add a thing such that I do all the possible things and I also get to know, plus you can also calibrate accordingly; you can also tell me about how to move left, right and stuff").
**Extends:** `2026-09-16-subway-irl-design.md` §4/§5 and `2026-09-17-phase3-pose-game.md` (the calibration step of the session flow).

## Why

Calibration today only records a resting posture: the player stands still for 2 s and the game
takes a baseline. Every detection threshold stays at its default, so a short player, a small room
or a cautious jumper all get the same numbers, and the player is never told what the moves are.

Move Check fixes both at once. The player performs each move once; the game (a) teaches the move,
(b) confirms it saw it, and (c) records how big that player's version of the move actually is and
tunes the thresholds to them.

## Where it runs

- After the standing baseline is recorded (`Calibrated`), before `ready`.
- **Always on Recalibrate.**
- On the **first ever** calibration on this machine (no saved tuning), so a new player is taught the
  moves. Afterwards it is offered but skippable in one click, and the saved tuning is reused.
- `?movecheck=skip` skips it, `?movecheck=force` always runs it (for automated checks).
- Skipping never blocks play: skipped moves keep their default (or previously saved) thresholds.

## The steps

In order, each step names the move, says how to do it **in the current play mode**, and waits for
the detector to fire.

| # | Move | Full-body instruction | Small-room instruction |
|---|---|---|---|
| 1 | Jog | "Jog in place — lift your knees" (needs 4 steps) | "Jog in place, or pump your arms" (4 steps) |
| 2 | Left | "Step to your LEFT" | "Lean your shoulders LEFT" |
| 3 | Right | "Step to your RIGHT" | "Lean your shoulders RIGHT" |
| 4 | Jump | "Jump up!" | "Jump, or hop on your toes" |
| 5 | Roll | "Squat down / duck" | "Duck your head down" |
| 6 | Hoverboard | "Both hands up!" | same |

The start gesture (right hand up) is taught by the existing `ready` screen that follows, and the
summary lists it too.

Per step:
- **Live feedback.** A near miss must say so rather than staying silent: when the measured peak
  reaches ≥ 50 % of the needed threshold but does not fire, show "Almost — go a bit further".
- **Attempt counter.** After ~10 s or 4 near misses, offer "Skip this move" and, for lanes/jump/roll,
  "Use an easier setting" — which accepts the player's best attempt as the tuning input even though
  it never crossed the default threshold (this is the whole point for players with a small room or
  limited range).
- **Success** shows a ✓ with the measured value, then advances after ~600 ms.

## Tuning

Each step records `peak`, the maximum magnitude of that move's own signal during the attempt
(the same quantity `src/pose/moves.ts` already compares against the threshold, so the units match).
Add a read-only magnitude readout to `PoseStatus` if one is not already available — that is an
allowed `src/pose` change.

For each tuned key: `next = clamp(TUNE_FRACTION * peak, 0.6 * dflt, 1.6 * dflt)` with
`TUNE_FRACTION = 0.55`, so the threshold sits a little over half of what the player actually did:
comfortably reachable, still above their noise floor.

| Step | Tunes (full body) | Tunes (small room) |
|---|---|---|
| Jog | `kneeLift` (+ `kneeRelease` proportional) | `wristPump`, `bobMinAmp` |
| Left / Right | `laneEnter` (+ `laneExit` proportional), from the mean of the two sides | `leanDeg` (+ `leanRearmDeg`), `noseShift` (+ `noseRearm`) |
| Jump | `jumpRise` (+ `jumpRearm`) | `smallJumpRise` (+ `smallJumpRearm`) |
| Roll | `rollDrop` | `duckDrop` |
| Hoverboard | nothing (a gesture, hold-timed) | nothing |

- **Re-arm keys keep their default ratio to the enter key** — this follows the existing
  sensitivity-exemption ruling in `thresholds.ts`; do not tune them independently.
- Left and right are averaged into one symmetric threshold, but if the two differ by more than 40 %
  the summary flags it ("your left step is much smaller than your right") rather than silently
  favouring the stronger side.
- The sensitivity setting keeps working exactly as now, on top of the tuned values.
- A skipped step tunes nothing.

**Persistence.** `localStorage` key `subway-irl.moveTuning.v1`, one record per play mode:
the tuned threshold keys, the raw peaks, the mode and a timestamp. Loaded at startup and applied
to the controller before the first run. A "Reset to defaults" control clears it. Corrupt or
wrong-version stored data is ignored, never thrown on.

## The summary / cheat sheet

After the last step, a card lists every control for the current mode, each with ✓ / skipped and
the measured value:

> Jog in place — keep running · Step LEFT / RIGHT — change lane · Jump — jump · Squat — roll
> Both hands up — hoverboard · Right hand up — start · (Keyboard: ← → Space S Ctrl)

with **Redo the check**, **Reset to defaults** and **Start playing**. The same card is reachable
from the pause screen as "Controls", so the player can re-read the moves without recalibrating.

## Telemetry

The monitor gets the move-check progress: each step's start, result, peak and the tuned values,
on the existing `BroadcastChannel`. Recorded sessions include the tuning in effect, so a replay of
the user's session uses the thresholds they actually played with.

## Testing

- Unit: the step machine (advance, skip, near-miss hints, attempt counts), the tuning maths
  (clamping, proportional re-arm, left/right averaging and the asymmetry flag), persistence
  (round-trip, corrupt data, wrong version, per-mode separation).
- Integration: synthetic pose data drives a full check in both modes, then a run proves the tuned
  thresholds are the ones in force.
- Visual: `shoot` each step, a near-miss hint, the summary card and the pause-screen cheat sheet,
  in both modes. Open every PNG.
- Nothing may require a real camera.
