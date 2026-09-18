/**
 * The facade the app will call: it must be safe to hold before any audio exists, and it must read
 * the game's state correctly once it does.
 */
import { describe, expect, it } from 'vitest';
import { GameAudio } from '../../src/audio';
import { AudioSettingsStore } from '../../src/audio/settings';
import { Game } from '../../src/game/game';
import type { ActivityStatus } from '../../src/input/commands';
import { asContext, FakeOfflineContext } from '../helpers/fakeWebAudio';

const activity: ActivityStatus = {
  tracksJogging: true,
  msSinceStep: 320,
  cadenceSpm: 150,
  steps: 0,
  squatting: false,
  lost: false,
};

const make = (over: Partial<ConstructorParameters<typeof GameAudio>[0]> = {}) =>
  new GameAudio({
    settings: new AudioSettingsStore(null),
    search: '',
    reverb: false,
    makeContext: () => asContext(new FakeOfflineContext(64, 8000)),
    ...over,
  });

const newGame = () => new Game({ seed: 1, difficulty: 'cardio' });

describe('GameAudio', () => {
  it('is silent and safe before any gesture', () => {
    const audio = make();
    const game = newGame();
    expect(audio.ready).toBe(false);
    expect(() => {
      for (let i = 0; i < 120; i++) {
        const events = game.step(1 / 60, i === 0 ? [{ type: 'start' }] : [], activity);
        audio.update(1 / 60, game, activity, events);
      }
    }).not.toThrow();
    // The director has been running all along, so the tick is already tracking the player.
    expect(audio.director.pulse.bpm).toBeGreaterThan(0);
  });

  it('builds the graph on unlock and drives it from the game', () => {
    const audio = make();
    const game = newGame();
    audio.unlock();
    expect(audio.ready).toBe(true);
    const engine = audio.engine!;
    expect(() => {
      for (let i = 0; i < 600; i++) {
        const events = game.step(1 / 60, i === 0 ? [{ type: 'start' }] : [], activity);
        audio.update(1 / 60, game, activity, events);
      }
    }).not.toThrow();
    expect(game.state).toBe('playing');
    expect(engine.ctx).toBeTruthy();
  });

  it('stays usable when the browser has no AudioContext at all', () => {
    const audio = make({ makeContext: () => null as unknown as BaseAudioContext });
    expect(() => audio.unlock()).not.toThrow();
    expect(audio.ready).toBe(false);
    expect(() => {
      audio.ui('click');
      audio.trainPass(1);
      audio.moveCheck('fanfare');
      audio.intro('brush');
      audio.play('coin', 1, 1);
      audio.suspend();
      audio.resume();
      audio.dispose();
    }).not.toThrow();
  });

  it('remembers the mixer', () => {
    const store = new AudioSettingsStore(null);
    const audio = make({ settings: store });
    expect(audio.toggleMute()).toBe(true);
    expect(store.get().muted).toBe(true);
    audio.setVolumes({ music: 0.3 });
    expect(audio.volumes.music).toBe(0.3);
    expect(audio.toggleMute()).toBe(false);
  });

  it('honours the URL flags without writing them back', () => {
    const store = new AudioSettingsStore(null);
    const audio = make({ settings: store, search: '?mute&vol=0.3' });
    expect(audio.muted).toBe(true);
    expect(audio.volumes.master).toBe(0.3);
    expect(new AudioSettingsStore(null).get().muted).toBe(false);
  });

  it('reads the run state the director needs', () => {
    const audio = make();
    audio.unlock();
    const game = newGame();
    game.step(1 / 60, [{ type: 'start' }], activity);
    for (let i = 0; i < 400; i++) game.step(1 / 60, [], activity);
    game.powerups.activate('rocket');
    const events = game.step(1 / 60, [], activity);
    audio.update(1 / 60, game, activity, events);
    // Whatever the run is doing, the frame the director sees has to be finite and in range.
    expect(audio.director.pulse.bpm).toBeGreaterThan(100);
    expect(Number.isFinite(game.chaser.gap)).toBe(true);
  });
});
