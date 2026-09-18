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

## OpenGameArt (CC0 1.0) — https://opengameart.org

| File(s) | Source | Author | License |
|---|---|---|---|
| `crow.*` | "Crow caw", https://opengameart.org/content/crow-caw (recorded near the pyramids, Cairo, per the submission) | zeroisnotnull | CC0 1.0 |

## archive.org / radio aporee

| File(s) | Source | Author | License |
|---|---|---|---|
| `train-pass.*` | "Level crossing bells and train, Údolní 2, 147 00 Praha 4, Czechia", https://archive.org/details/aporee_56617_64769 (seconds 132–139 only: the pass itself) | Peter Cusack | Public Domain Mark 1.0 |

**A note on that one, so a reviewer can make their own call.** Public Domain Mark is an *assertion*
by the uploader that a work carries no known copyright, not a licence grant like CC0. Creative
Commons recommends CC0 for a creator releasing their own work. radio aporee contributors pick a
licence per upload and most choose CC BY-NC-SA, so choosing public domain here was a deliberate act
rather than a default — which is why it is used. It is the only file in this folder that is not
either CC0 or a Commons-reviewed public-domain item, and it is the one to drop first if anyone
disagrees: `trainPass` still has its full synth patch, so removing the file costs nothing but
texture.

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
| Carrion crow calls (Commons, via xeno-canto) | CC BY-SA 4.0 — share-alike is a copyleft obligation on a derivative, and a trimmed clip is a derivative. Superseded: OpenGameArt has a CC0 crow, which is what ships. |
| "Freight train — passing by with fast whooshes" (OpenGameArt) | GPL 3. A copyleft licence on an asset, which is not CC0 and not CC-BY. |
| "City rail bridge" (OpenGameArt) | GPL 3, same reason. |
| "Train Tunnel" (OpenGameArt) | CC BY-SA 3.0/4.0 — share-alike. |
| radio aporee train pass-bys (most of them) | CC BY-NC-ND or CC BY-NC: non-commercial, and several no-derivatives. |
| "Tabla 01" (OpenGameArt) | GPL 3. |
| "Electronic Indian tabla tune" (OpenGameArt, CC0) | Genuinely CC0, but it is a finished mix. The music bed sequences individual strokes so it can add layers with the run speed; a fixed tune would throw that away. |
| Tabla recitals (archive.org: NCAA, Sahapedia, ICCR) | CC BY-NC 4.0 or unmarked, and they are named artists' performances — sampling a recital into a game groove is exactly the lift this project does not do. |
| Kassel Hauptbahnhof hall (archive.org, Public Domain Mark) | A good station bed, and a real alternative to the one shipped — not used only to avoid putting the single largest file in the build on a Public Domain Mark rather than a Commons-reviewed licence. |
| Cantù Asnago train (archive.org, Public Domain Mark) | Used first, then replaced. It is real rail with real wheel clacks, but it starts mid-pass, so the swell and the pitch drop had to be synthesised on top of it. The Praha recording has both in the recording. |
| The level-crossing bell in that same Praha recording | Considered for the station chime, since it is a real railway bell rather than speech. Rejected on looking at it: the bell is far off under constant road traffic, and a distant noisy ding is worse than the clean synthesised chime. |
| House crow, *Corvus splendens* (Commons) | The right bird for Mumbai, and there are seven recordings of it — every one CC BY-SA. The CC0 crow that ships is a different corvid; the species is the price of the licence. |
| "Black Crow (*Corvus capensis*)" (Commons, British Library) | CC BY 4.0, so usable with attribution — but it is a Cape crow, no closer to a house crow than the CC0 one already shipping, so there was no reason to trade CC0 away for it. |
| Mridangam demonstration (archive.org, CC Public Domain Dedication) | The best-licensed Indian percussion found anywhere: a real dedication by the player, V. Raghuraman. Still rejected — it is thirty seconds of continuous solo with no isolated strokes in it, and the groove needs single hits. Carving a loop out of someone's performance is the lift this project does not do. |
| Commons Category:Tabla, Category:Dholak | Between them: one German pronunciation clip (CC BY-SA) and one 70 MB video of a sarangi recital. No instrument demos. |
| "Taiwan Railway Station Arrival Sound" (Commons, CC0) | Genuinely CC0, but it is platform noise: the spectrogram is flat broadband hiss with no chime in it. The station tannoy is synthesised. |
| "Train passing by in the Wirikuta Desert" (Commons, CC0) | Genuinely CC0, but every slice renders as featureless noise at a constant level — no approach, no recede, no wheel clacks. Superseded by the Cantù recording, which has real wheel clacks. |
| Station PA announcements (Kassel, Baltimore Penn, Cantù, El Palomar) | All public-domain-marked and all usable, but every one of them is SPEECH, in German, English, Italian or Spanish. A German platform announcement in a Mumbai station is worse than the synthesised chime. |
| Freesound direct downloads | The API needs a token and the site needs a login; nothing there is reachable anonymously. |
| Mixkit | Free for commercial use, but its licence forbids redistributing a sound as a stand-alone file, which is exactly what committing it to this repo would be. |
| The `assets/` folder in this repo | Third-party rips supplied for local reference only. Gitignored, never used, never shipped. |
