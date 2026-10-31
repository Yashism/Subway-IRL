# Contributing to Subway IRL

Thanks for wanting to help. Every size of contribution is welcome, from a typo to a new city.

## Getting set up

You need Node.js 20.19 or newer (22 recommended).

```bash
git clone https://github.com/Yashism/Subway-IRL.git
cd Subway-IRL
npm install
npm run dev        # http://localhost:5173/
```

No webcam? Add `?input=keyboard` to the URL, or `?autopilot` to watch the bot play. The camera-free harness pages
(`debug.html`, `gallery.html`, `settings-harness.html` and friends, listed in the README) let you work on one screen
at a time.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same three on every pull request. A few things we care about:

- **Keep the simulation deterministic.** Code under `src/game/` must not use `Math.random()` or the wall clock; use the
  seeded RNG (`src/game/rng.ts`). Same seed and inputs must give the same run.
- **New obstacle patterns must be passable.** Add them to `src/game/chunks.ts` and run the chunk tests: the passability
  solver rejects an unfair pattern.
- **Pose changes need tests.** The detectors in `src/pose/` are covered by fixture-driven tests; extend them rather than
  tuning by feel. If you change a threshold, say what recording or measurement justified it.
- **Use the UI kit.** Screens are built from `src/ui/kit.css` and `src/ui/icons.ts` (`gk-btn`, `gk-panel`, `gk-ribbon`
  and so on), so a button looks the same everywhere. Please do not add one-off button styles.
- **No emoji as icons in new UI.** Add an SVG to `icons.ts`.
- **Assets must be openly licensed.** Anything you add under `public/` needs a source, author and licence in the matching
  `CREDITS.md`. No assets from other games, ever.
- **Privacy is a feature.** Video must never leave the device. Do not add analytics, uploads or third-party scripts.

## Reporting a bug

Use the bug report form. For "my move did not register", the most useful thing you can attach is a **recorded session**:
open the live monitor (`/monitor.html` or press <kbd>M</kbd>) in a separate window, press **Record session**, reproduce the
problem, and attach the JSON file.

## Commit messages

We use short conventional-style subjects (`feat(ui): ...`, `fix(pose): ...`, `perf: ...`, `docs: ...`, `test: ...`).
Explain the why in the body when it is not obvious.

## Code of conduct

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

By contributing you agree that your contribution is released under the project's [MIT licence](LICENSE).
