import type { ActivityStatus, CommandSource, GameCommand } from './commands';

/** Combines keyboard, pose and bot sources into one. */
export class InputHub implements CommandSource {
  /** Scratch status, refilled by activity() so the 60 Hz step does not allocate. */
  private readonly merged: ActivityStatus = {
    tracksJogging: false,
    msSinceStep: Infinity,
    cadenceSpm: 0,
    steps: 0,
    squatting: false,
    lost: false,
  };

  constructor(readonly sources: CommandSource[]) {}

  drain(): GameCommand[] {
    return this.sources.flatMap((s) => s.drain());
  }

  /**
   * The merged activity: jogging figures come from the sources that track it (the closest step,
   * the fastest cadence), everything else from all of them. The same object every call: read it
   * at once, never keep it.
   */
  activity(tMs: number): ActivityStatus {
    const r = this.merged;
    r.tracksJogging = false;
    r.msSinceStep = Infinity;
    r.cadenceSpm = 0;
    r.steps = 0;
    r.squatting = false;
    r.lost = false;
    const sources = this.sources;
    for (let i = 0; i < sources.length; i++) {
      const a = sources[i].activity(tMs);
      r.steps += a.steps;
      if (a.squatting) r.squatting = true;
      if (a.lost) r.lost = true;
      if (!a.tracksJogging) continue;
      r.tracksJogging = true;
      if (a.msSinceStep < r.msSinceStep) r.msSinceStep = a.msSinceStep;
      if (a.cadenceSpm > r.cadenceSpm) r.cadenceSpm = a.cadenceSpm;
    }
    return r;
  }
}
