import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeFixture, encodeFrames, FixtureRecorder, type PoseFixture } from '../../src/pose/fixtures';
import { Scenario } from '../helpers/synth';
import { PoseController } from '../../src/pose/controller';
import { names, play } from '../helpers/play';

describe('fixtures', () => {
  it('round-trips frames with relative timestamps', () => {
    const sc = new Scenario().hold(100).add(100, () => null);
    const shifted = sc.frames.map((f) => ({ ...f, t: f.t + 5000 }));
    const fx = encodeFrames('demo', shifted, 'note');
    expect(fx.version).toBe(1);
    expect(fx.frames[0].t).toBe(0);
    const back = decodeFixture(JSON.parse(JSON.stringify(fx)) as PoseFixture);
    expect(back).toHaveLength(shifted.length);
    expect(back[0].poses[0][24].y).toBeCloseTo(shifted[0].poses[0][24].y, 4);
    expect(back.at(-1)!.poses).toEqual([]);
  });

  it('rejects unknown versions', () => {
    expect(() => decodeFixture({ version: 2 } as unknown as PoseFixture)).toThrow(/version/);
  });

  it('records only while recording', () => {
    const r = new FixtureRecorder();
    const [a, b] = new Scenario().hold(67).frames;
    r.push(a);
    r.start();
    r.push(b);
    expect(r.count).toBe(1);
    const fx = r.stop('x');
    expect(r.recording).toBe(false);
    expect(fx.frames).toHaveLength(1);
  });
});

const load = (name: string) =>
  decodeFixture(JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as PoseFixture);

describe('recorded fixtures', () => {
  it('synth-full produces the expected moves', () => {
    expect(names(play(new PoseController(), load('synth-full')))).toEqual(['lane:1', 'lane:0', 'jump', 'roll', 'hoverboard']);
  });

  it('synth-small produces the expected moves', () => {
    const ctrl = new PoseController();
    expect(names(play(ctrl, load('synth-small')))).toEqual(['shift:-1', 'jump']);
    expect(ctrl.status.jog.steps).toBeGreaterThanOrEqual(9);
  });
});
