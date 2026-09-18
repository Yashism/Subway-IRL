# Audio credits

Every sound file in this folder is **CC0 / public domain**. Nothing here is non-commercial,
share-alike, or ripped from a game, film or recording. Each file was trimmed, made mono,
peak-normalised to −1 dBFS (the bed to −3) and re-encoded to `.ogg` (Vorbis q3) and `.m4a` (AAC 80k)
with `ffmpeg`; the sound itself is unaltered.

Anything the game plays that is **not** listed here is synthesised in code by `src/audio/voices.ts` —
see the header of `src/audio/manifest.ts` for which cues those are and why no recording was used.

## Kenney (CC0 1.0) — https://kenney.nl

All from Kenney's free asset packs, licensed CC0 1.0 Universal. Attribution is not required;
it is given here because it should be.

| File(s) | Source pack | Original | Author | License |
|---|---|---|---|---|
| `coin.*` | Interface Sounds, https://kenney.nl/assets/interface-sounds | `glass_001.ogg` | Kenney | CC0 1.0 |
| `ui-click.*` | Interface Sounds | `click_001.ogg` | Kenney | CC0 1.0 |
| `ui-back.*` | Interface Sounds | `back_001.ogg` | Kenney | CC0 1.0 |
| `ui-confirm.*` | Interface Sounds | `confirmation_001.ogg` | Kenney | CC0 1.0 |
| `move-ok.*` | Interface Sounds | `select_003.ogg` | Kenney | CC0 1.0 |
| `jump.*` | Interface Sounds | `maximize_001.ogg` | Kenney | CC0 1.0 |
| `roll.*` | Interface Sounds | `scratch_001.ogg` | Kenney | CC0 1.0 |
| `brush.*` | Interface Sounds | `scratch_003.ogg` | Kenney | CC0 1.0 |
| `land.*` | Impact Sounds, https://kenney.nl/assets/impact-sounds | `footstep_concrete_000.ogg` | Kenney | CC0 1.0 |
| `step-0.*` … `step-3.*` | Impact Sounds | `footstep_concrete_000–003.ogg` | Kenney | CC0 1.0 |
| `stumble.*` | Impact Sounds | `impactPlank_medium_003.ogg` | Kenney | CC0 1.0 |
| `pickup-chappal.*` | Impact Sounds | `impactPlank_medium_000.ogg` | Kenney | CC0 1.0 |
| `rocket-landing.*` | Impact Sounds | `impactPlate_heavy_000.ogg` | Kenney | CC0 1.0 |
| `caught-hit.*` | Impact Sounds | `impactPunch_heavy_000.ogg` | Kenney | CC0 1.0 |
| `caught-sting.*` | Digital Audio, https://kenney.nl/assets/digital-audio | `zapThreeToneDown.ogg` | Kenney | CC0 1.0 |
| `countdown.*` | Digital Audio | `tone1.ogg` | Kenney | CC0 1.0 |
| `go.*` | Digital Audio | `threeTone1.ogg` | Kenney | CC0 1.0 |
| `summary.*` | Digital Audio | `powerUp9.ogg` | Kenney | CC0 1.0 |
| `move-fanfare.*` | Digital Audio | `powerUp12.ogg` | Kenney | CC0 1.0 |
| `pickup-magnet.*` | Digital Audio | `powerUp5.ogg` | Kenney | CC0 1.0 |
| `pickup-rocket.*` | Digital Audio | `phaserUp3.ogg` | Kenney | CC0 1.0 |
| `hoverboard.*` | Digital Audio | `phaserUp1.ogg` | Kenney | CC0 1.0 |
| `hoverboard-save.*` | Digital Audio | `powerUp7.ogg` | Kenney | CC0 1.0 |
| `josh-start.*` | Digital Audio | `powerUp11.ogg` | Kenney | CC0 1.0 |
| `josh-end.*` | Digital Audio | `lowDown.ogg` | Kenney | CC0 1.0 |
| `unfurl.*` | RPG Audio, https://kenney.nl/assets/rpg-audio | `cloth1.ogg` | Kenney | CC0 1.0 |

## Wikimedia Commons

| File(s) | Source | Author | License |
|---|---|---|---|
| `whistle.*` | "218318 splicesound referee-whistle-blow-gymnasium.wav", https://commons.wikimedia.org/wiki/File:218318_splicesound_referee-whistle-blow-gymnasium.wav | splicesound | CC0 1.0 |
| `heartbeat.*` | "Heartbeat mitral valve 150 bpm.ogg", https://commons.wikimedia.org/wiki/File:Heartbeat_mitral_valve_150_bpm.ogg | Wikimedia Commons contributor | Public domain |
| `ambience-crowd.*` | "1 minute at the alexa mall in berlin.ogg", https://commons.wikimedia.org/wiki/File:1_minute_at_the_alexa_mall_in_berlin.ogg | Wikimedia Commons contributor | Public domain |

## Rejected, and why

Kept here so nobody repeats the search.

| Candidate | Why not |
|---|---|
| Carrion crow calls (Commons, via xeno-canto) | CC BY-SA 4.0. Share-alike is a copyleft obligation on a derivative, and a trimmed clip is a derivative. The crow is synthesised instead. |
| "Taiwan Railway Station Arrival Sound" (Commons, CC0) | Genuinely CC0, but it is platform noise: the spectrogram is flat broadband hiss with no chime in it. The station tannoy is synthesised. |
| "Train passing by in the Wirikuta Desert" (Commons, CC0) | Genuinely CC0, but every slice renders as featureless noise at a constant level — no approach, no recede, no wheel clacks. There is no Doppler in it to use, so the train pass-by is synthesised. |
| Freesound direct downloads | The API needs a token and the site needs a login; nothing there is reachable anonymously. |
| Mixkit | Free for commercial use, but its licence forbids redistributing a sound as a stand-alone file, which is exactly what committing it to this repo would be. |
| The `assets/` folder in this repo | Third-party rips supplied for local reference only. Gitignored, never used, never shipped. |
