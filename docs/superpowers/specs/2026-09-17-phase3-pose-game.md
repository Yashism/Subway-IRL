# Subway IRL — Phase 3: Webcam Control in the Game (spec addendum)

**Date:** 2026-09-17
**Status:** Approved by the user ("go ahead with phase 3; run it in parallel; I will test live and give feedback; I need a live debug view in another page").
**Extends:** `2026-09-16-subway-irl-design.md` §3, §4, §5.5, §5.8, §7, §8.

## Goals

1. Play the game with the body through the webcam, with the keyboard still working alongside.
2. Add an in-game camera setup and a calibration flow, a small camera preview (PiP) with the skeleton, and warnings for a lost, slow or stalled camera.
3. Add a **live monitor page** (`monitor.html`) that runs in a second tab next to the game. It shows what the game sees and does in real time, and it records sessions to a file the user can send back for debugging and replay.
4. Test everything automatically with synthetic and recorded pose streams. No real camera is needed for any automated check.

## Architecture

```
src/input/poseSource.ts   PoseCommandSource: PoseController events/status → GameCommand + ActivityStatus
src/app/flow.ts           Session flow: menu → camera setup → calibrate → game countdown (app layer; src/game unchanged)
src/app/poseRuntime.ts    Owns the camera, LivePoseSource / ReplayPoseSource and PoseController; feeds frames; exposes status
src/ui/poseScreens.ts     Camera permission / picker / error screens, calibration overlay (outline, hints, progress ring, mode chooser)
src/ui/pip.ts             Corner camera preview with the skeleton, tracking dot, fps, "slow"/"stalled" badges
src/telemetry/            Telemetry over BroadcastChannel('subway-irl'): publisher (game side) + subscriber (monitor)
src/monitor/ + monitor.html   Live monitor page and session recorder
```

### Pose → game mapping (`PoseCommandSource`, a `CommandSource`)

| Pose event | Game command |
|---|---|
| `lane` | `setLane` |
| `laneShift` | `shiftLane` |
| `jump` | `jump` |
| `roll` | `roll` |
| `hoverboard` | `hoverboard` |
| `start` | `start` |
| `lost` | `lost` flag |
| `found` | clears the `lost` flag |

The `ActivityStatus` it reports is built from these rules:
- **`tracksJogging`** is true once the controller is calibrated.
- **`msSinceStep`** is `status.jog.msSinceStep`, plus the time since the last pose frame (the `tMs` passed to `activity()` minus `status.lastFrameT`), so a stalled stream still ages.
- **`cadenceSpm`** comes straight from the jog status.
- **`steps`** must never decrease: add the previous run's total when the controller recalibrates or resets.
- **`squatting`** comes from `status.squatting`.
- **`lost`** is true when a `lost` event is pending, or when no frame has arrived for `staleMs`, which is a stalled stream. The class default is 1.5 s; the game page passes the controller's `lostMs` (1.0 s) instead, so a full stall pauses at the same moment the controller would call the pose lost (P3 ruling).

Pose events keep the pose clock. The source converts them into commands when the game drains it. The game's own idle clock already restarts on resume.

### Session flow (app layer)

- **Keyboard-only:** the flow is unchanged. Enter goes straight to the countdown.
- **Webcam mode:** Enter or a raised right hand (Start) opens a flow with these steps:
  1. **Camera setup:** a permission explainer, then the camera picker (IR cameras hidden, the choice remembered), then any error with retry or "use keyboard instead".
  2. **Calibration:** a body outline and live hints (body visible, distance, "too dark" from the frame luma), a progress ring, and full-body / small-room detection with a manual override. After 2 s of standing still it shows "Calibrated", and a Start gesture then begins the countdown.
  3. **Game countdown:** after this the run proceeds normally.
- **During play:** a `lost` flag pauses the game ("Step back into frame"). When the pose is found again, a quick position check runs, then the countdown.
- **After a run:** the summary shows a "Raise hand to play again" hint in webcam mode.
- **URL options:**
  - `?input=keyboard` forces keyboard-only play.
  - `?input=webcam` is the default when a camera is available; otherwise the game falls back to the keyboard with a notice.
  - `?posereplay=<fixture>` drives the pose pipeline from `tests/fixtures/<fixture>.json` in place of the camera. This is used for automated screenshots and for replaying the user's recordings.

### Live monitor (`monitor.html`)

**Transport.** A `BroadcastChannel('subway-irl')` carries messages between same-origin tabs:

| Direction | Message | Frequency | Contents |
|---|---|---|---|
| game → monitor | `frame` | ~15 Hz, throttled | landmarks (mirrored), aspect, t |
| game → monitor | `status` | ~10 Hz | PoseStatus minus the pose, and the backend |
| game → monitor | `poseEvents` | as they happen | pose events |
| game → monitor | `commands` | as they happen | game commands, each tagged with its source (pose / keyboard) |
| game → monitor | `gameEvents` | as they happen | game events |
| game → monitor | `game` | ~10 Hz | state, s, speed, lane, runner y, rolling/airborne, idleLevel, idle ms, jog, josh, powerups, pausedByLoss, caughtReason |
| monitor → game | `setSensitivity` | on demand | new sensitivity |
| monitor → game | `setThreshold` | on demand | threshold key and value |
| monitor → game | `recalibrate` | on demand | — |
| monitor → game | `forceMode` | on demand | play mode |

**Page layout:**
- A skeleton view with guide lines. It reuses `src/debug/overlay.ts` and has no camera of its own, drawing from the frames.
- A status panel.
- A merged timeline: pose events, commands and game events, each with a relative timestamp and colour-coded.
- A game-state panel with an idle-clock bar.
- Threshold and sensitivity controls that act live on the game.
- A "connected / waiting for game" indicator.

**Recording.** A **Record session** button saves JSON (a `SessionRecording`, version 1) containing:
- the full-rate pose frames (the game sends all frames while recording is on)
- every command, pose event and game event, each with a timestamp
- the game seed, difficulty, mode, thresholds and sensitivity
- a free-text note from the user

The game can replay a recording (`?session=<file in tests/fixtures/sessions>`), which feeds the same pose frames at the same seed. Commands are derived again from those frames, so a detector fix can be checked against the user's real session.

## Testing

- **Unit tests:**
  - the `PoseCommandSource` mapping, monotonic steps, stall → lost, and msSinceStep ageing
  - the flow state machine
  - the telemetry message encoding
  - `SessionRecording` round-trip
- **Integration tests** (headless, synthetic `Scenario` pose data → `PoseController` → `PoseCommandSource` → `Game`):
  - jog + jump clears a barrier
  - squat → roll under a banner
  - a step sideways changes lane (full body)
  - a lean shifts lane (small room)
  - stopping jogging → caught after 2 s
  - leaving the frame → paused (not caught); coming back → countdown → play
  - raising both hands → hoverboard
  - `synth-full` and `synth-small` fixtures replayed through the game
- **Visual checks:** `shoot` the game with `?posereplay=synth-full&autopilot=0`, the calibration screens and the PiP, plus the monitor page connected to a game tab. The monitor check needs two tabs: use one Chrome instance with two targets, or have the monitor open the game in an iframe for the test. Open every PNG.
- **Manual:** the user plays live with the monitor open in a second tab, and records sessions for any problem.

## Constraints

- `src/game` stays unchanged, except for anything a genuine bug requires.
- `src/pose` changes are allowed only for bugs or telemetry hooks.
- Webcam pose runs through `LivePoseSource`, whose worker/GPU fallback chain is already built.
- Dev server for this worktree: `http://localhost:5174`.
