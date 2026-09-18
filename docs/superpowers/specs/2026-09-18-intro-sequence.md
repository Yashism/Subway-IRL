# Subway IRL — Intro sequence (the poster)

**Date:** 2026-09-18
**Status:** Chosen by the user: the kid is caught **pasting a hand-painted film poster** on a local
train ("in real subway surfers the guy is spray painting trains, in this one, what can do show him do").
**Extends:** `2026-09-16-subway-irl-design.md` §6 and `2026-09-17-visual-overhaul.md`.

## What happens

A short cinematic that explains why the TT chases you for the rest of the game. Dawn light, a
parked local at a quiet platform, a bucket of maida paste and a rolled-up poster.

| Beat | ~Time | What the player sees |
|---|---|---|
| 1 | 0.0–1.2 s | The kid, back to camera, slaps a folded poster onto the coach side, over a faded ad, and sweeps a brush across it. Paste splatters. |
| 2 | 1.2–2.4 s | The poster unfurls: a loud hand-painted film poster (original artwork — see below). He steps back, admires it, wipes his hands. |
| 3 | 2.4–3.4 s | A torch beam swings across the coach. The TT's whistle. "OY!" — the kid's head snaps around, the poster's corner flapping. |
| 4 | 3.4–4.2 s | He bolts toward the camera, which swings behind him and settles into the normal running camera as the countdown takes over. |

Total ≈ 4 s. It must never feel like a wall between the player and the game.

## How it is driven

- **The start gesture is the last brush stroke.** In webcam mode the raised right hand that starts a
  run plays beat 1–2; the rest follows on its own. The gesture the player already learned does the
  mischief, rather than a cutscene playing at them.
- **Keyboard:** Enter does the same.
- **Skippable always:** any key, a raised hand, or a click skips straight to the countdown. A skip
  must be possible from frame one — never a locked-out four seconds.
- **Shown:** on the first run of a session. "Play again" goes straight to the countdown, with the
  intro reachable from the menu. `?intro=always` / `?intro=off` for testing.
- It must not run in autopilot, replay (`?posereplay=`, `?session=`) or keyboard-test paths unless
  explicitly forced, so automated checks stay fast.

## The poster (original artwork, no real film or person)

Procedural canvas texture in the established style — hand-painted Bollywood poster pastiche, all
invented. Suggested: a lurid sunset, a local train mid-air, a kid mid-leap, big Devanagari and Latin
title, a fake censor certificate corner and a fake release strip.

- Title: **भागो! / BHAAGO!** (matches the HUD's own "BHAAGO!").
- Fictional credits only — invented star names, an invented banner ("JHAKAAS PICTURES"), an invented
  certificate ("U/A · 2026"). **No real actor, film, studio or logo, and no real person's likeness.**
- Tagline in Hinglish, e.g. "Ek local. Ek chance. BHAAGO!"
- A second variant is welcome (seeded) so the intro is not identical every time.

## Constraints

- Reuses the existing kit: the coach from `src/world/models/trains.ts`, the rigs from
  `characters.ts` (runner + inspector), platform/scenery, and the shared toon/curve materials. No
  new art pipeline, no external assets.
- Procedural textures through `canvasTexture()`; the poster is one cached texture.
- The whole sequence is one `THREE.Group` plus a camera track, torn down completely on skip or end;
  nothing may leak into the run (no stray objects, lights, listeners or rAF).
- Budget: it must not push past the existing draw-call/triangle ceiling, and it must not stall the
  first frame of the run — reuse loaded assets, warm nothing new at the last moment.
- `src/game` is not involved: the intro is an app/world-layer thing that ends by handing control to
  the normal countdown.

## Verification

- Gallery/harness entries so each beat can be shot and inspected without the camera.
- `shoot` each beat, plus the handover frame into the run, and open every PNG.
- A test that the sequence tears down cleanly (object/listener counts back to baseline) and that a
  skip at any beat lands in the countdown with the world in the same state as an unskipped run.
