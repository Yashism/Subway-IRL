# Subway IRL — Lane spots (set left, centre and right by standing on them)

**Date:** 2026-09-18
**Status:** Chosen by the user: "Have an option to set the left, center, right manually as well as
an option" — answered "Stand on your own spots" over a distance slider or on-screen buttons.
**Extends:** `2026-09-16-subway-irl-design.md` §4 (full-body lanes), `2026-09-17-move-check.md`,
`2026-09-18-settings-workout.md`.

## What it is

In **full-body** mode the lane comes from how far the player's hips are from where they calibrated,
in torso lengths, against one symmetric threshold (`laneEnter` / `laneExit`, tuned by the Move
Check). That assumes the player's left and right steps are equally big and that the room suits the
default distance. Lane spots replace that, *as an option*, with the player's own three positions:
they stand where they want their left lane, their centre lane and their right lane, and the game
records them.

- A setting **Lanes: Automatic / My spots** (default Automatic — the game as it is today).
- **Small-room mode is unaffected.** It changes lanes by leaning (a swipe gesture), not by position,
  so spots do not apply there; the UI says so rather than hiding the option silently.

## Units and storage

- Each spot is recorded as the hip's sideways offset from the calibration baseline, in torso
  lengths — exactly the quantity `FullBodyMoves` already computes (`MoveMagnitudes.lane`). Relative
  to the calibrated centre, so spots survive the laptop being moved (the player recalibrates where
  they stand) and scale with the player's distance from the camera.
- Full-body mode never drifts the baseline's x (`driftBaseline` leaves x alone by design), so spots
  stay put during a run.
- Stored in `localStorage` under `subway-irl.laneSpots.v1`: `{ left, centre, right, at }`. Loading
  is total: corrupt, partial, wrong-order or non-finite data is ignored (and Automatic is used), never
  thrown on.

## Detection with spots

- Boundaries sit halfway between the centre spot and each side spot:
  `bL = (left + centre) / 2`, `bR = (right + centre) / 2`.
- Hysteresis like today's (enter 0.5, exit 0.35 is 30 % of the way back): a side lane is entered
  beyond its boundary and left only once the hips come back past a point 30 % of the way from the
  boundary to the centre spot. Moving straight from left to right (past `bR`) still works, as now.
- Sensitivity still applies: each boundary's distance from the centre spot is divided by it, so a
  higher sensitivity needs smaller steps, exactly as it does for the automatic thresholds.
- While spots are in force, the Move Check's `laneEnter`/`laneExit` tuning does not decide full-body
  lanes (the spots do); it still applies in small-room mode and whenever Lanes is Automatic.
- Generalise `nextLane` to asymmetric enter/exit positions rather than duplicating it; the
  automatic path must produce identical results to today (a test pins that).

## The setup (guided, like the Move Check)

Reachable from **Settings › Movement** ("Set my lane spots"), from the **ready** screen, and offered
when the player picks "My spots" with none recorded. Requires a calibrated full-body player.

1. **Centre** — "Stand where you want the centre lane". 2. **Left** — "Step to where you want the
left lane". 3. **Right** — "Step to where you want the right lane".

- A spot is taken when the player holds still there for **1 s** (hip offset within a small band),
  with a visible hold ring — the same interaction as calibration.
- A live marker shows where the player is now against the spots taken so far, so they can see it.
- A side spot must be on the correct side and at least **0.25 torso lengths** from the centre spot;
  closer or on the wrong side shows "Step further left/right" instead of taking it.
- The summary shows the three spots with their distances, **Save**, **Redo**, **Cancel**. Cancel and
  every other exit (Home, Esc, recalibrate, mode change, camera loss) leave the saved spots as they
  were. Saving switches Lanes to My spots.

## Everything else

- Telemetry: the monitor shows whether spots are in force and their values.
- Recorded sessions carry the spots in force, so a replay decides lanes the same way.
- The start gesture is ignored during the setup, as during the Move Check.

## Testing

- Unit: the generalised `nextLane` (identical to today on symmetric input; asymmetric spots;
  hysteresis; sensitivity scaling; a direct left→right move); the setup state machine (hold timing,
  steadiness, wrong side, too close, ordering, redo); storage (round trip, corrupt/hostile data).
- Integration: synthetic full-body pose data through the real `PoseController`: with spots set at
  asymmetric positions the player changes lane exactly at the recorded midpoints; small-room mode is
  untouched; Automatic behaves exactly as before.
- Visual: the setup at each step (with the live marker and a hold in progress), the "step further"
  hint, the summary, and the Settings controls. Every PNG opened.
