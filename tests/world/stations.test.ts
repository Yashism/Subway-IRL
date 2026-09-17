import { describe, expect, it } from 'vitest';
import { LINES, LINE_IDS, isLineId, lineForSeed, platformNumber, stationForPlatform, stationIndex } from '../../src/world/stations';

const DEVANAGARI = /[ऀ-ॿ]/;

describe('suburban line data', () => {
  it('has the three lines with their real termini', () => {
    expect(LINE_IDS).toEqual(['western', 'central', 'harbour']);
    const ends = (id: keyof typeof LINES) => {
      const s = LINES[id].stations;
      return [s[0].en, s[s.length - 1].en];
    };
    expect(ends('western')).toEqual(['Churchgate', 'Virar']);
    expect(ends('central')).toEqual(['Chhatrapati Shivaji Maharaj Terminus', 'Kalyan Junction']);
    expect(ends('harbour')).toEqual(['Chhatrapati Shivaji Maharaj Terminus', 'Panvel']);
    expect(LINES.western.stations[0].mr).toBe('चर्चगेट');
    expect(LINES.central.stations[0].code).toBe('CSMT');
  });

  it('keeps each line in running order with known stations in place', () => {
    const order = (id: keyof typeof LINES, names: string[]) => {
      const idx = names.map((n) => LINES[id].stations.findIndex((s) => s.en === n));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    };
    order('western', ['Churchgate', 'Mumbai Central', 'Dadar', 'Bandra', 'Andheri', 'Borivali', 'Vasai Road', 'Virar']);
    order('central', ['Chhatrapati Shivaji Maharaj Terminus', 'Byculla', 'Dadar', 'Kurla', 'Ghatkopar', 'Thane', 'Dombivli', 'Kalyan Junction']);
    order('harbour', ['Chhatrapati Shivaji Maharaj Terminus', 'Wadala Road', 'Kurla', 'Chembur', 'Vashi', 'Nerul', 'CBD Belapur', 'Panvel']);
    expect(LINES.western.stations).toHaveLength(29);
    expect(LINES.central.stations).toHaveLength(26);
    expect(LINES.harbour.stations).toHaveLength(25);
  });

  for (const id of LINE_IDS) {
    it(`${id}: non-empty, no duplicates, Marathi in Devanagari`, () => {
      const list = LINES[id].stations;
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((s) => s.en)).size).toBe(list.length);
      expect(new Set(list.map((s) => s.mr)).size).toBe(list.length);
      const codes = list.map((s) => s.code).filter(Boolean);
      expect(new Set(codes).size).toBe(codes.length);
      for (const s of list) {
        expect(s.en.trim()).toBe(s.en);
        expect(s.en.length).toBeGreaterThan(0);
        expect(s.mr.trim().length).toBeGreaterThan(0);
        expect(s.mr).toMatch(DEVANAGARI);
        expect(s.mr).not.toMatch(/[A-Za-z]/);
      }
      expect(LINES[id].termini.length).toBeGreaterThan(0);
      expect(LINES[id].id).toBe(id);
    });
  }
});

describe('platform to station mapping', () => {
  it('gives the nth platform the nth station, looping at the end', () => {
    const w = LINES.western.stations;
    expect(stationForPlatform('western', 0)).toBe(w[0]);
    expect(stationForPlatform('western', 1)).toBe(w[1]);
    expect(stationForPlatform('western', w.length - 1).en).toBe('Virar');
    expect(stationForPlatform('western', w.length).en).toBe('Churchgate');
    expect(stationForPlatform('western', w.length * 3 + 2)).toBe(w[2]);
    expect(stationForPlatform('harbour', 24).en).toBe('Panvel');
    expect(stationForPlatform('harbour', 25).en).toBe('Chhatrapati Shivaji Maharaj Terminus');
  });

  it('wraps negative platform numbers (scenery behind the start)', () => {
    expect(stationIndex(29, -1)).toBe(28);
    expect(stationIndex(29, -29)).toBe(0);
    expect(stationForPlatform('central', -1).en).toBe('Kalyan Junction');
  });

  it('numbers platforms continuously across corridor repeats', () => {
    expect(platformNumber(0, 0, 4)).toBe(0);
    expect(platformNumber(0, 3, 4)).toBe(3);
    expect(platformNumber(1, 0, 4)).toBe(4);
    expect(platformNumber(2, 1, 4)).toBe(9);
    expect(platformNumber(-1, 3, 4)).toBe(-1);
  });

  it('picks a line deterministically from the seed', () => {
    for (const seed of [0, 1, 2, 3, 7, 42, 123456, -5]) {
      expect(lineForSeed(seed)).toBe(lineForSeed(seed));
      expect(isLineId(lineForSeed(seed))).toBe(true);
    }
    expect(new Set([0, 1, 2, 3, 4, 5].map(lineForSeed)).size).toBe(3);
    expect(lineForSeed(Number.NaN)).toBe('western');
    expect(isLineId('eastern')).toBe(false);
  });
});
