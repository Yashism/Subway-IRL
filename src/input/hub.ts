import type { ActivityStatus, CommandSource, GameCommand } from './commands';

/** Combines keyboard, pose and bot sources into one. */
export class InputHub implements CommandSource {
  constructor(readonly sources: CommandSource[]) {}

  drain(): GameCommand[] {
    return this.sources.flatMap((s) => s.drain());
  }

  activity(tMs: number): ActivityStatus {
    const all = this.sources.map((s) => s.activity(tMs));
    const jog = all.filter((a) => a.tracksJogging);
    return {
      tracksJogging: jog.length > 0,
      msSinceStep: jog.length ? Math.min(...jog.map((a) => a.msSinceStep)) : Infinity,
      cadenceSpm: Math.max(0, ...jog.map((a) => a.cadenceSpm)),
      steps: all.reduce((n, a) => n + a.steps, 0),
      squatting: all.some((a) => a.squatting),
      lost: all.some((a) => a.lost),
    };
  }
}
