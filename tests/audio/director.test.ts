/**
 * The director's decisions, against a fake sink. No Web Audio anywhere in this file — that is the
 * whole point of the split.
 */
import { describe, expect, it } from 'vitest';
import { Director, PULSE, type DirectorFrame } from '../../src/audio/director';
import type { AudioSink, CueName, MixChannel } from '../../src/audio/types';
import { TUNING } from '../../src/game/config';
import type { GameEvent, GameState } from '../../src/game/game';
import type { ActivityStatus } from '../../src/input/commands';

class FakeSink implements AudioSink {
  readonly cues: { cue: CueName; gain: number; rate: number }[] = [];
  readonly mix_: Partial<Record<MixChannel, number>> = {};
  mixCalls = 0;
  readonly tempos: number[] = [];
  readonly transports: boolean[] = [];

  cue(cue: CueName, gain: number, rate: number): void {
    this.cues.push({ cue, gain, rate });
  }
  mix(channel: MixChannel, value: number): void {
    this.mix_[channel] = value;
    this.mixCalls++;
  }
  tempo(bpm: number): void {
    this.tempos.push(bpm);
  }
  transport(running: boolean): void {
    this.transports.push(running);
  }

  named(name: CueName): { cue: CueName; gain: number; rate: number }[] {
    return this.cues.filter((c) => c.cue === name);
  }
  clear(): void {
    this.cues.length = 0;
    this.tempos.length = 0;
    this.transports.length = 0;
    this.mixCalls = 0;
  }
  level(channel: MixChannel): number {
    return this.mix_[channel] ?? 0;
  }
}

const activity = (over: Partial<ActivityStatus> = {}): ActivityStatus => ({
  tracksJogging: true,
  msSinceStep: 300,
  cadenceSpm: 150,
  steps: 100,
  squatting: false,
  lost: false,
  ...over,
});

const frame = (over: Partial<DirectorFrame> = {}): DirectorFrame => ({
  dt: 1 / 60,
  state: 'playing',
  countdown: 0,
  speedFraction: 0.5,
  idleMs: 0,
  idleLevel: 'ok',
  chaserGap: TUNING.chaserFarGap,
  joshValue: 0,
  joshActive: false,
  airborne: false,
  hoverboard: false,
  rocket: false,
  magnet: false,
  activity: activity(),
  ...over,
});

/** Runs `seconds` of frames, optionally mutating the frame each step. */
function run(d: Director, f: DirectorFrame, seconds: number, each?: (f: DirectorFrame, i: number) => void): void {
  const steps = Math.round(seconds / f.dt);
  for (let i = 0; i < steps; i++) {
    each?.(f, i);
    d.update(f, []);
  }
}

const setup = (over?: Partial<DirectorFrame>, random = () => 0.5) => {
  const sink = new FakeSink();
  const d = new Director(sink, { random });
  const f = frame(over);
  return { sink, d, f };
};

describe('countdown', () => {
  it('beeps on each whole second and lands GO on the state change', () => {
    const { sink, d, f } = setup({ state: 'countdown', countdown: 3 });
    run(d, f, 3, (fr, i) => {
      fr.countdown = 3 - i * fr.dt;
    });
    expect(sink.named('countdown')).toHaveLength(3);
    // The last beep is the high one.
    expect(sink.named('countdown')[2].rate).toBeGreaterThan(1);
    expect(sink.named('go')).toHaveLength(0);

    f.state = 'playing';
    d.update(f, [{ type: 'state', state: 'playing' }]);
    expect(sink.named('go')).toHaveLength(1);
  });

  it('holds the sequencer still while it counts', () => {
    const { sink, d, f } = setup({ state: 'countdown', countdown: 3 });
    d.update(f, []);
    expect(sink.transports.at(-1)).toBe(false);
    expect(sink.level('tabla')).toBe(0);
  });
});

describe('coins', () => {
  it('climbs a scale over a streak and resets after a gap', () => {
    const { sink, d, f } = setup();
    d.update(f, []);
    const coin: GameEvent = { type: 'coin' };
    for (let i = 0; i < 4; i++) d.update(f, [coin]);
    const rates = sink.named('coin').map((c) => c.rate);
    expect(rates).toHaveLength(4);
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThan(rates[i - 1]);

    // Long enough with no coin and the ladder starts again at the bottom.
    run(d, f, 1.5);
    d.update(f, [coin]);
    expect(sink.named('coin').at(-1)!.rate).toBeCloseTo(1, 5);
  });

  it('uses the Josh variant while coins are doubled', () => {
    const { sink, d, f } = setup({ joshActive: true });
    d.update(f, [{ type: 'coin' }]);
    expect(sink.named('coinJosh')).toHaveLength(1);
    expect(sink.named('coin')).toHaveLength(0);
    expect(sink.named('joshStart')).toHaveLength(1);
  });

  it('caps the ladder rather than climbing out of hearing', () => {
    const { sink, d, f } = setup();
    for (let i = 0; i < 40; i++) d.update(f, [{ type: 'coin' }]);
    const rates = sink.named('coin').map((c) => c.rate);
    expect(Math.max(...rates)).toBeLessThanOrEqual(4.01);
  });
});

describe('ducking', () => {
  it('dips the music for a loud cue and brings it back', () => {
    const { sink, d, f } = setup();
    d.update(f, []);
    expect(sink.level('music')).toBeCloseTo(1, 5);

    d.update(f, [{ type: 'stumble' }]);
    const ducked = sink.level('music');
    expect(ducked).toBeLessThan(0.7);

    run(d, f, 1);
    expect(sink.level('music')).toBeCloseTo(1, 2);
  });

  it('ducks hardest for the caught sting', () => {
    const { sink, d, f } = setup();
    d.update(f, [{ type: 'caught', reason: 'crash' }]);
    expect(sink.level('music')).toBeLessThan(0.15);
    expect(sink.named('caught')).toHaveLength(1);
  });
});

describe('the chaser', () => {
  it('raises the footsteps as the gap closes', () => {
    const { sink, d, f } = setup({ chaserGap: TUNING.chaserFarGap });
    d.update(f, []);
    expect(sink.level('chaserSteps')).toBeCloseTo(0, 3);

    f.chaserGap = (TUNING.chaserFarGap + TUNING.chaserNearGap) / 2;
    d.update(f, []);
    const mid = sink.level('chaserSteps');

    f.chaserGap = TUNING.chaserNearGap;
    d.update(f, []);
    expect(sink.level('chaserSteps')).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
  });

  it('whistles more often, louder and higher the closer he gets', () => {
    const near = setup({ chaserGap: TUNING.chaserNearGap });
    run(near.d, near.f, 10);
    const far = setup({ chaserGap: TUNING.chaserFarGap - 3 });
    run(far.d, far.f, 10);

    expect(near.sink.named('whistle').length).toBeGreaterThan(far.sink.named('whistle').length);
    expect(near.sink.named('whistle')[0].gain).toBeGreaterThan(far.sink.named('whistle')[0].gain);
    expect(near.sink.named('whistle')[0].rate).toBeGreaterThan(far.sink.named('whistle')[0].rate);
  });

  it('says nothing at all while he is out of earshot', () => {
    const { sink, d, f } = setup({ chaserGap: TUNING.chaserFarGap + 5 });
    run(d, f, 20);
    expect(sink.named('whistle')).toHaveLength(0);
  });
});

describe('the idle warning', () => {
  const idleFrame = (idleMs: number) =>
    frame({ idleMs, idleLevel: idleMs >= TUNING.idleWarnMs ? 'warn' : 'ok', speedFraction: 1 });

  it('thins the bed and brings the heartbeat up as the deadline closes', () => {
    const { sink, d } = setup();
    let f = idleFrame(0);
    run(d, f, 1);
    const calm = { tabla: sink.level('tabla'), riff: sink.level('riff'), pulse: sink.level('pulse') };
    expect(sink.level('heartbeat')).toBe(0);

    f = idleFrame(TUNING.idleWarnMs + 500);
    d.update(f, []);
    expect(sink.level('tabla')).toBeLessThan(calm.tabla);
    expect(sink.level('riff')).toBeLessThan(calm.riff);
    expect(sink.level('heartbeat')).toBeGreaterThan(0.4);

    // The jog pulse is the one thing that gets LOUDER: it is what they put a foot back onto.
    expect(sink.level('pulse')).toBeGreaterThan(calm.pulse);

    f = idleFrame(TUNING.idleCaughtMs);
    d.update(f, []);
    expect(sink.level('heartbeat')).toBeCloseTo(1, 5);
    expect(sink.level('riff')).toBe(0);
    expect(sink.level('drone')).toBeGreaterThan(0);
  });

  it('fires the warning sting once per crossing, not once per frame', () => {
    const { sink, d } = setup();
    const f = idleFrame(0);
    run(d, f, 0.5);
    f.idleLevel = 'warn';
    f.idleMs = TUNING.idleWarnMs;
    run(d, f, 0.5);
    expect(sink.named('idleWarn')).toHaveLength(1);

    f.idleLevel = 'ok';
    f.idleMs = 0;
    run(d, f, 0.5);
    f.idleLevel = 'warn';
    f.idleMs = TUNING.idleWarnMs;
    d.update(f, []);
    expect(sink.named('idleWarn')).toHaveLength(2);
  });
});

describe('the music bed', () => {
  it('adds layers as the run speeds up', () => {
    const slow = setup({ speedFraction: 0 });
    run(slow.d, slow.f, 0.2);
    const fast = setup({ speedFraction: 1 });
    run(fast.d, fast.f, 0.2);

    expect(slow.sink.level('bass')).toBe(0);
    expect(slow.sink.level('riff')).toBe(0);
    expect(fast.sink.level('bass')).toBeGreaterThan(0.5);
    expect(fast.sink.level('riff')).toBeGreaterThan(0.5);
    expect(fast.sink.level('tabla')).toBeGreaterThan(slow.sink.level('tabla'));
    expect(fast.sink.level('wind')).toBeGreaterThan(slow.sink.level('wind'));
  });

  it('drops to almost nothing when paused, and silences everything when caught', () => {
    const { sink, d, f } = setup();
    run(d, f, 0.2);
    f.state = 'paused';
    d.update(f, [{ type: 'state', state: 'paused' }]);
    expect(sink.level('music')).toBeLessThan(0.35);
    expect(sink.level('tabla')).toBe(0);
    expect(sink.transports.at(-1)).toBe(false);

    f.state = 'caught';
    d.update(f, [{ type: 'state', state: 'caught' }]);
    expect(sink.level('music')).toBe(0);
    expect(sink.level('drone')).toBe(0);
    expect(sink.level('pulse')).toBe(0);
    expect(sink.level('ambience')).toBeGreaterThan(0);
  });

  it('swells for the Josh meter', () => {
    const { sink, d, f } = setup();
    run(d, f, 0.2);
    const off = sink.level('josh');
    f.joshActive = true;
    d.update(f, []);
    expect(sink.level('josh')).toBeGreaterThan(off);
    f.joshActive = false;
    d.update(f, []);
    expect(sink.named('joshEnd')).toHaveLength(1);
  });
});

describe('the jog pulse', () => {
  it('locks onto a steady jogger at their own cadence', () => {
    const { sink, d, f } = setup({ speedFraction: 0 });
    f.activity = activity({ cadenceSpm: 150 });
    run(d, f, 8);
    expect(d.pulse.bpm).toBeCloseTo(150, 0);
    expect(d.pulse.locked).toBe(true);
    expect(sink.tempos.at(-1)).toBeCloseTo(150, 0);
  });

  it('sits a little above a jogger who has drifted slow, and never above what the run asks for', () => {
    const { d, f } = setup({ speedFraction: 1 });
    f.activity = activity({ cadenceSpm: 140 });
    run(d, f, 10);
    const demand = d.pulse.demand(1);
    expect(d.pulse.bpm).toBeGreaterThan(140);
    expect(d.pulse.bpm).toBeLessThan(demand);
    expect(d.pulse.bpm - 140).toBeLessThanOrEqual(PULSE.leadMax + 0.5);
  });

  it('does not drag a fast jogger back down', () => {
    const { d, f } = setup({ speedFraction: 0 });
    f.activity = activity({ cadenceSpm: 185 });
    run(d, f, 8);
    expect(d.pulse.bpm).toBeGreaterThan(180);
    expect(d.pulse.lead).toBeCloseTo(0, 1);
  });

  it('holds the tempo when they stop, so there is something to come back to', () => {
    const { d, f } = setup({ speedFraction: 0.3 });
    f.activity = activity({ cadenceSpm: 165 });
    run(d, f, 8);
    const held = d.pulse.bpm;
    f.activity = activity({ cadenceSpm: 0, msSinceStep: 4000 });
    run(d, f, 3);
    expect(d.pulse.bpm).toBeCloseTo(held, 0);
  });

  it('is a plain metronome at what the run asks for when nothing measures cadence', () => {
    const { d, f } = setup({ speedFraction: 1 });
    f.activity = activity({ tracksJogging: false, cadenceSpm: 0, msSinceStep: Infinity });
    run(d, f, 10);
    expect(d.pulse.bpm).toBeCloseTo(PULSE.demandFast, 0);
    expect(d.pulse.locked).toBe(false);
  });

  it('keeps the tick inside a jogagble range whatever the cadence reads', () => {
    for (const cadenceSpm of [0, 12, 400, Number.NaN]) {
      const { d, f } = setup({ speedFraction: 0.5 });
      f.activity = activity({ cadenceSpm });
      run(d, f, 6);
      expect(d.pulse.bpm).toBeGreaterThanOrEqual(PULSE.min);
      expect(d.pulse.bpm).toBeLessThanOrEqual(PULSE.max);
    }
  });

  it('is quieter once the player is locked on, and louder while they are not', () => {
    const locked = setup({ speedFraction: 0 });
    locked.f.activity = activity({ cadenceSpm: 140 });
    run(locked.d, locked.f, 8);

    const adrift = setup({ speedFraction: 1 });
    adrift.f.activity = activity({ cadenceSpm: 0, msSinceStep: 3000 });
    run(adrift.d, adrift.f, 8);

    expect(locked.sink.level('pulse')).toBeLessThan(adrift.sink.level('pulse'));
  });
});

describe('the body', () => {
  it('fires a landing on the way down, not on the way up', () => {
    const { sink, d, f } = setup();
    d.update(f, [{ type: 'jump' }]);
    expect(sink.named('jump')).toHaveLength(1);
    f.airborne = true;
    run(d, f, 0.3);
    expect(sink.named('land')).toHaveLength(0);
    f.airborne = false;
    d.update(f, []);
    expect(sink.named('land')).toHaveLength(1);
  });

  it('has a cue for each of the run event types', () => {
    const { sink, d, f } = setup();
    const events: GameEvent[] = [
      { type: 'roll' },
      { type: 'lane' },
      { type: 'pickup', kind: 'magnet' },
      { type: 'pickup', kind: 'rocket' },
      { type: 'pickup', kind: 'chappal' },
      { type: 'hoverboard' },
      { type: 'hoverboardSaved' },
      { type: 'rocketLanding' },
    ];
    d.update(f, events);
    for (const name of [
      'roll',
      'lane',
      'pickupMagnet',
      'pickupRocket',
      'pickupChappal',
      'hoverboard',
      'hoverboardSave',
      'rocketLanding',
    ] as CueName[]) {
      expect(sink.named(name), name).toHaveLength(1);
    }
  });

  it('holds the power-up layers while they are running', () => {
    const { sink, d, f } = setup({ hoverboard: true, rocket: true, magnet: true });
    d.update(f, []);
    expect(sink.level('hover')).toBeGreaterThan(0);
    expect(sink.level('rocket')).toBeGreaterThan(0);
    expect(sink.level('magnet')).toBeGreaterThan(0);
    f.hoverboard = f.rocket = f.magnet = false;
    d.update(f, []);
    expect(sink.level('hover')).toBe(0);
    expect(sink.level('rocket')).toBe(0);
    expect(sink.level('magnet')).toBe(0);
  });
});

describe('the frame path', () => {
  it('sends a mix level only when it has actually moved', () => {
    const { sink, d, f } = setup({ speedFraction: 0.5 });
    f.activity = activity({ cadenceSpm: 150 });
    run(d, f, 5);
    sink.clear();
    run(d, f, 5);
    // Nothing about the frame changed, so nothing but the settled ramps should be sent.
    expect(sink.mixCalls).toBeLessThan(10);
    expect(sink.transports).toHaveLength(0);
  });

  it('survives a nonsense dt', () => {
    const { sink, d, f } = setup();
    for (const dt of [0, -1, Number.NaN, 100]) {
      f.dt = dt;
      expect(() => d.update(f, [])).not.toThrow();
    }
    expect(Number.isFinite(sink.level('music'))).toBe(true);
  });

  it('resync makes the next frame state everything again', () => {
    const { sink, d, f } = setup();
    run(d, f, 1);
    sink.clear();
    d.resync();
    d.update(f, []);
    expect(sink.mixCalls).toBeGreaterThan(8);
    expect(sink.transports).toEqual([true]);
  });
});

describe('the other screens', () => {
  it('keeps a bed under the menu and the summary', () => {
    for (const state of ['menu', 'summary'] as GameState[]) {
      const { sink, d, f } = setup({ state });
      run(d, f, 0.2);
      expect(sink.level('drone'), state).toBeGreaterThan(0.3);
      expect(sink.level('pulse'), state).toBe(0);
      expect(sink.transports.at(-1), state).toBe(true);
    }
  });

  it('plays a chord when the summary arrives', () => {
    const { sink, d, f } = setup({ state: 'caught' });
    run(d, f, 0.2);
    f.state = 'summary';
    d.update(f, [{ type: 'state', state: 'summary' }]);
    expect(sink.named('summary')).toHaveLength(1);
  });

  it('lets the app fire its own cues', () => {
    const { sink, d } = setup();
    d.fire('uiClick', 0.5, 1);
    d.trainPass(1);
    expect(sink.named('uiClick')).toHaveLength(1);
    expect(sink.named('trainPass')).toHaveLength(1);
    // A near pass is louder and pitched down by the Doppler shift on its way out.
    expect(sink.named('trainPass')[0].rate).toBeLessThan(1);
  });
});
