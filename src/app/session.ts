/**
 * One browser session's worth of run bookkeeping: the mission tracker, the saved profile and the
 * progression store, and the single place a finished run is banked.
 * Spec: docs/superpowers/specs/2026-09-18-missions.md
 *
 * The rule this file exists to enforce is "exactly once". A run is banked when, and only when, it
 * reaches the summary under its own steam: a run abandoned with Home never passes through
 * `summary`, a second `summary` event for the same run finds the ledger already closed, and an
 * autopilot or replay demo (`saveRuns: false`) banks nothing at all — no coins, no missions, no
 * profile row. `ProgressionStore.recordRun` is the wallet's only writer, including for the coins
 * the player picked up, so nothing here ever calls `award()` beside it.
 *
 * Nothing in here touches the DOM, the camera or the world, so a whole run can be simulated in a
 * test and the ledger checked afterwards.
 */
import { dayKey, type ProfileStore, type RecordResult, type RunRecord } from './profile';
import { dailyView, type DailyChallenge, type DailyView, type ProgressionStore, type RunOutcome } from './progression';
import {
  MissionTracker,
  capabilitiesFor,
  missionDef,
  missionView,
  missionViews,
  runSample,
  type MissionCapability,
  type MissionContext,
  type MissionRunContext,
  type MissionView,
} from '../game/missions';
import type { Game, GameEvent } from '../game/game';
import type { PlayMode } from '../pose/types';

/** Progress has to move this much of the bar since the last toast before another one is worth it. */
export const TOAST_STEP = 0.25;

export interface RunSessionOptions {
  progression: ProgressionStore;
  profile: ProfileStore;
  /**
   * False for an autopilot or replay demo: the run is played and shown, and nothing is written to
   * the profile, the wallet or the mission board.
   */
  saveRuns?: boolean;
  /** Epoch ms. The tests pin it so a day boundary is never a flake. */
  now?: () => number;
}

/** The boosts a run starts with, already paid for and spent. */
export interface RunBoosts {
  /** A magnet is already running when the countdown ends. */
  magnet: boolean;
}

/** What main.ts knows about a finished run that the session cannot read off the Game. */
export interface RunFacts {
  difficulty: string;
  seed: number;
  input: string;
}

export interface RunResult {
  outcome: RunOutcome | null;
  record: RecordResult | null;
  /** The missions as they stand after the run, for the summary card. */
  missions: MissionView[];
  /** This run was an attempt at today's daily challenge. */
  daily: boolean;
}

export class RunSession {
  readonly tracker = new MissionTracker();
  private readonly o: RunSessionOptions;
  private readonly now: () => number;
  private mode: PlayMode = 'full';
  /** The mode something actually measured, as opposed to the fallback the missions need. */
  private detectedMode: PlayMode | null = null;
  private capabilities: MissionCapability[] = capabilitiesFor({ tracksJogging: true });
  private contextKey = '';
  /** 1-based index of the run under way within this session. */
  private sessionRun = 0;
  private previousDistance: number | null = null;
  /** A run is live: it has begun and has not been banked or abandoned. */
  private live = false;
  /** The player asked for today's challenge; consumed by the next run that starts. */
  private armedDaily = false;
  private dailyRun = false;
  /** Fraction of each active mission's bar already announced, so a toast is never repeated. */
  private readonly announced = new Map<string, number>();
  private toast: MissionView | null = null;

  constructor(o: RunSessionOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    if (o.saveRuns !== false) this.refresh();
  }

  get saveRuns(): boolean {
    return this.o.saveRuns !== false;
  }

  /** A run is between its countdown and its summary. */
  get running(): boolean {
    return this.live;
  }

  get dailyArmed(): boolean {
    return this.armedDaily;
  }

  get missionContext(): MissionContext {
    return { mode: this.mode, capabilities: this.capabilities };
  }

  /** Today's challenge and the player's standing with it. */
  get daily(): { challenge: DailyChallenge; view: DailyView } {
    const today = dayKey(this.now());
    const { challenge, state } = this.o.progression.daily(today);
    return { challenge, view: dailyView(challenge, state) };
  }

  /**
   * What this player can be asked to do: the detected play mode, and whether anything is measuring
   * their legs at all (a keyboard is not). Re-filling the board on a change is what keeps a
   * small-room or keyboard player off a mission they physically cannot make progress on.
   */
  setCapabilities(o: { mode: PlayMode | null; tracksJogging: boolean; skipped?: readonly string[] }): void {
    const mode = o.mode ?? this.mode;
    const capabilities = capabilitiesFor({ tracksJogging: o.tracksJogging, skipped: o.skipped });
    const key = `${mode}|${capabilities.join(',')}`;
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.detectedMode = o.mode;
    this.mode = mode;
    this.capabilities = capabilities;
    this.refresh();
  }

  /** Fills any empty mission slot for the current context. Safe to call at any time. */
  refresh(): MissionView[] {
    if (!this.saveRuns) return this.o.progression.missions;
    return this.o.progression.refresh(this.missionContext);
  }

  /** "Run it" on the daily card: the next run started is an attempt at today's challenge. */
  armDaily(): void {
    this.armedDaily = true;
  }

  disarmDaily(): void {
    this.armedDaily = false;
  }

  /**
   * The game reached `countdown`: a new run. Returns the boosts it starts with — spent here, once,
   * on the run they apply to, and never on a demo, which pays for nothing and so is given nothing.
   */
  beginRun(): RunBoosts {
    this.tracker.reset();
    this.toast = null;
    this.live = true;
    this.sessionRun++;
    this.dailyRun = this.armedDaily;
    this.armedDaily = false;
    // A mission is announced from where this run *found* it, not from zero. Without this, one that
    // is true until it is broken ("finish without stumbling") would toast "complete" on frame one.
    this.announced.clear();
    for (const m of this.liveMissions()) this.announced.set(m.id, Math.floor(m.frac / TOAST_STEP) * TOAST_STEP);
    return { magnet: this.saveRuns && this.o.progression.consume('magnet-boost') };
  }

  /** The run left without reaching the summary (Home, or back to the menu): nothing is banked. */
  abandonRun(): void {
    this.live = false;
    this.dailyRun = false;
    this.toast = null;
  }

  /** Every game event of the run, for the counters the stats do not carry (stumbles, the catch). */
  event(e: GameEvent): void {
    if (this.live) this.tracker.event(e);
  }

  /** One rendered frame of the run. Reads the game; decides nothing and changes nothing in it. */
  frame(game: Game, dt: number): void {
    if (!this.live) return;
    this.tracker.sample(runSample(game, dt));
    this.checkToasts();
  }

  /**
   * The run reached the summary. Banks it — once. A second call for the same run, a run that was
   * abandoned, or a demo run all return a result with nothing written.
   */
  endRun(facts: RunFacts, caughtReason: string | null): RunResult {
    const wasLive = this.live;
    this.live = false;
    const daily = this.dailyRun;
    this.dailyRun = false;
    if (!wasLive || !this.saveRuns) {
      return { outcome: null, record: null, missions: this.o.progression.missions, daily };
    }

    const at = this.now();
    const day = dayKey(at);
    const c = this.tracker.counters;
    const run: MissionRunContext = { day, sessionRun: this.sessionRun, previousDistance: this.previousDistance };
    const outcome = this.o.progression.recordRun({ counters: c, run, ctx: this.missionContext, daily, today: day });

    const record: RunRecord = {
      at,
      score: c.score,
      coins: c.coins,
      distance: c.distance,
      timeSec: c.timeSec,
      jumps: c.jumps,
      rolls: c.rolls,
      laneChanges: c.laneChanges,
      steps: c.steps,
      hoverboardsUsed: c.hoverboardsUsed,
      caughtReason,
      difficulty: facts.difficulty,
      seed: facts.seed,
      input: facts.input,
    };
    // `timeSec` only advances while the game is `playing`, so it already *is* the active time.
    // The play mode is only recorded when something really detected one: a keyboard run is not a
    // "full body" run, and the history row would be claiming something nobody measured.
    const result = this.o.profile.recordRun({ ...run, ...record, activeSeconds: c.timeSec, mode: this.detectedMode ?? '', day });
    this.previousDistance = c.distance;
    // The summary shows the board *as this run left it* — the two just finished still reading
    // "Done!" — and only then is it refilled for the next one.
    const missions = missionViews(outcome.missions.state);
    this.o.progression.refresh(this.missionContext);
    return { outcome, record: result, missions, daily };
  }

  /**
   * The missions as they stand *right now*, with the run in progress folded in. The stored state
   * only moves at the summary, so this is what the live toast and the summary list read.
   */
  liveMissions(): MissionView[] {
    const run: MissionRunContext = { day: dayKey(this.now()), sessionRun: Math.max(1, this.sessionRun), previousDistance: this.previousDistance };
    const c = this.tracker.counters;
    return this.o.progression.state.missions.active.map((m) => {
      const d = missionDef(m.id);
      if (!d || m.done || !this.live) return missionView(m);
      const raw = d.measure(c, run);
      const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      const next = d.accrual === 'run' ? Math.max(m.progress, value) : m.progress + value;
      return missionView({ ...m, progress: Math.min(m.target, Math.floor(next)) });
    });
  }

  /** The mission that just moved far enough to be worth a toast, once. Null the rest of the time. */
  takeToast(): MissionView | null {
    const t = this.toast;
    this.toast = null;
    return t;
  }

  /**
   * A quarter of a mission's bar is worth interrupting the run for. Nothing else is.
   *
   * Completion deliberately never toasts mid-run: a live measure can still be taken back — "finish
   * a run without stumbling" reads as done from the first metre and is undone by one stumble at the
   * twentieth second — and only `applyRun`, at the summary, decides. So the toast announces
   * progress and the summary card announces the medal.
   */
  private checkToasts(): void {
    if (this.toast) return;
    for (const m of this.liveMissions()) {
      if (m.done) continue;
      const shown = this.announced.get(m.id) ?? 0;
      const step = Math.floor(m.frac / TOAST_STEP) * TOAST_STEP;
      if (step >= 1 || step <= shown || step <= 0) continue;
      this.announced.set(m.id, step);
      this.toast = m;
      return;
    }
  }
}
