// @vitest-environment jsdom
/**
 * The audio *wiring*, headless: AppLoop + Game + IntroRunner + a real `GameAudio` that is never
 * unlocked, so the director runs and the Web Audio graph is never built.
 *
 * None of us can hear it, so everything here is structural: which call happened, with which
 * arguments, in which order. The director's own decisions are covered in tests/audio.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionFlow } from '../../src/app/flow';
import { IntroRunner, type IntroCue, type IntroStage } from '../../src/app/intro';
import { AppLoop } from '../../src/app/loop';
import { GestureUnlock, soundAllowed } from '../../src/app/sound';
import { AudioSettingsStore, GameAudio } from '../../src/audio';
import { Game, type GameEvent } from '../../src/game/game';
import { KeyboardInput } from '../../src/input/keyboard';
import { EMPTY_TRACK } from '../helpers/poseDrive';

const HZ = 60;
const DT = 1 / HZ;

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

/** A stand-in for WorldView's cinematic, on the caller's clock. */
function fakeStage(duration = 4.2) {
  let t = 0;
  let cut = false;
  const stage: IntroStage<Game> = {
    get introBeat() {
      return Math.min(4, Math.floor(t / (duration / 4)) + 1);
    },
    get introTime() {
      return t;
    },
    startIntro() {
      t = 0;
      cut = false;
    },
    advanceIntro(dt) {
      t += dt;
      return !cut && t < duration;
    },
    renderIntro() {},
    skipIntro() {
      t = duration;
      cut = true;
    },
    endIntro() {},
  };
  return stage;
}

function page(o: { intro?: boolean; autopilot?: boolean; replay?: boolean; search?: string } = {}) {
  const storage = new FakeStorage();
  const audio = new GameAudio({ settings: new AudioSettingsStore(storage), search: o.search ?? '' });
  const updates = vi.spyOn(audio, 'update');
  const cues: IntroCue[] = [];
  const unlocks = vi.spyOn(audio, 'unlock');

  const game = new Game({ seed: 3, difficulty: 'cardio', chunks: EMPTY_TRACK });
  const flow = new SessionFlow({ input: 'keyboard', moveCheckSeen: true });
  const keyboard = new KeyboardInput();
  const emitted: GameEvent[][] = [];
  const intro = new IntroRunner<Game>({
    stage: fakeStage(),
    onCue: (cue, gain) => {
      cues.push(cue);
      audio.intro(cue, gain);
    },
    onEnd: () => loop.queueStart(),
  });

  const target = document.createElement('div');
  document.body.append(target);
  const gesture = new GestureUnlock({
    target,
    enabled: soundAllowed({ autopilot: !!o.autopilot, replay: !!o.replay, search: o.search ?? '' }),
    onUnlock: () => audio.unlock(),
  });

  const loop: AppLoop = new AppLoop({
    game,
    flow,
    keyboard,
    onStep: (dt, activity, events) => {
      emitted.push([...events]);
      audio.update(dt, game, activity, events);
    },
    holdStart: () => {
      if (!o.intro || intro.played) return false;
      intro.begin();
      return true;
    },
    onSkip: () => intro.skip(),
  });

  let now = 0;
  const frame = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += 1000 / HZ;
      intro.advance(DT, game);
      loop.beginFrame();
      loop.step(DT, now);
      loop.endFrame(now);
    }
  };
  const key = (code: string) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code }));
    keyboard.keyDown({ code }, now);
  };
  return { audio, storage, game, loop, intro, gesture, updates, unlocks, cues, emitted, frame, key, target };
}

describe('the audio frame', () => {
  it('runs once per game step, with that step’s dt and the game it stepped', () => {
    const p = page();
    p.frame(4);
    expect(p.updates).toHaveBeenCalledTimes(4);
    for (const call of p.updates.mock.calls) {
      expect(call[0]).toBe(DT);
      expect(call[1]).toBe(p.game);
    }
  });

  it('is handed exactly the events the game emitted on that step', () => {
    const p = page();
    p.key('Enter');
    p.frame(3);
    expect(p.updates.mock.calls.length).toBe(p.emitted.length);
    p.updates.mock.calls.forEach((call, i) => {
      expect([...(call[3] as readonly GameEvent[])]).toEqual(p.emitted[i]);
    });
    // The run started, so at least one of those frames carried the countdown.
    const states = p.emitted.flat().filter((e) => e.type === 'state');
    expect(states.length).toBeGreaterThan(0);
  });

  it('keeps running under the cinematic and through the handover', () => {
    const p = page({ intro: true });
    p.key('Enter');
    p.frame(Math.round(4.2 * HZ) + 3);
    expect(p.game.state).toBe('countdown');
    expect(p.updates.mock.calls.length).toBeGreaterThan(4 * HZ);
  });
});

describe('nothing sounds before a gesture', () => {
  it('the graph is not built at boot, and is built once on the first key', () => {
    const p = page();
    p.frame(30);
    expect(p.unlocks).not.toHaveBeenCalled();
    expect(p.audio.ready).toBe(false);

    p.key('Enter');
    expect(p.unlocks).toHaveBeenCalledTimes(1);
    p.key('Space');
    p.target.dispatchEvent(new Event('pointerdown'));
    expect(p.unlocks).toHaveBeenCalledTimes(1);
  });

  it('an autopilot or replay demo never unlocks, however many keys it sees', () => {
    for (const o of [{ autopilot: true }, { replay: true }]) {
      const p = page(o);
      p.key('Enter');
      p.frame(60);
      p.target.dispatchEvent(new Event('pointerdown'));
      expect(p.unlocks, JSON.stringify(o)).not.toHaveBeenCalled();
      // The director still runs — it is only the output that is missing.
      expect(p.updates.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it('?audio lets a demo be heard by someone watching it', () => {
    const p = page({ autopilot: true, search: '?audio' });
    p.key('Enter');
    expect(p.unlocks).toHaveBeenCalledTimes(1);
  });
});

describe('the cinematic is not silent', () => {
  it('fires its three sounds through the facade as it plays', () => {
    const p = page({ intro: true });
    const intro = vi.spyOn(p.audio, 'intro');
    p.key('Enter');
    p.frame(Math.round(4.2 * HZ) + 2);
    expect(p.cues).toContain('brush');
    expect(p.cues).toContain('unfurl');
    expect(p.cues).toContain('whistle');
    expect(intro.mock.calls.length).toBe(p.cues.length);
    for (const [, gain] of intro.mock.calls) {
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });
});

describe('the mixer round-trips', () => {
  it('a volume change is in force at once and is still there next session', () => {
    const p = page();
    expect(p.audio.volumes.music).not.toBe(0.2);
    p.audio.setVolumes({ music: 0.2, sfx: 0.4 });
    expect(p.audio.volumes.music).toBe(0.2);
    expect(p.audio.volumes.sfx).toBe(0.4);

    const later = new GameAudio({ settings: new AudioSettingsStore(p.storage), search: '' });
    expect(later.volumes.music).toBe(0.2);
    expect(later.volumes.sfx).toBe(0.4);
  });

  it('mute toggles, persists, and reports back for the HUD speaker', () => {
    const p = page();
    expect(p.audio.muted).toBe(false);
    expect(p.audio.toggleMute()).toBe(true);
    expect(p.audio.muted).toBe(true);
    expect(new GameAudio({ settings: new AudioSettingsStore(p.storage), search: '' }).muted).toBe(true);
    p.audio.setMuted(false);
    expect(p.audio.muted).toBe(false);
  });

  it('?mute and ?vol apply for the session without being written back', () => {
    const p = page();
    p.audio.setVolumes({ master: 0.9 });
    const flagged = new GameAudio({ settings: new AudioSettingsStore(p.storage), search: '?mute&vol=0.25' });
    expect(flagged.muted).toBe(true);
    expect(flagged.volumes.master).toBe(0.25);
    // The saved game is untouched: a shared link cannot silence someone's game for good.
    expect(JSON.parse(p.storage.getItem('subway-irl.audio.v1')!).muted).toBe(false);
    expect(JSON.parse(p.storage.getItem('subway-irl.audio.v1')!).master).toBe(0.9);
  });
});
