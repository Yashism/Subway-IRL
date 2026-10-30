import { describe, expect, it } from 'vitest';
import { LINES, stationForPlatform } from '../../src/world/stations';
import { CHUNK, PLATFORM_X0 } from '../../src/wander/city';
import { PARK_NAMES, STREET_NAMES, placeAt, streetName } from '../../src/wander/places';

describe('place names', () => {
  it('names a station platform with the real station of the line', () => {
    const p = placeAt(1, 'western', 32, 20);
    expect(p.kind).toBe('platform');
    expect(p.primary).toBe(stationForPlatform('western', 0).en);
    expect(p.code).toBe('CCG');
    expect(p.marathi).toBe('चर्चगेट');
    // The next station along the railway, six rows south.
    const next = placeAt(1, 'western', 32, 6 * CHUNK + 20);
    expect(next.primary).toBe('Marine Lines');
    // The same spot on another line is another station.
    expect(placeAt(1, 'central', 32, 20).primary).toBe(LINES.central.stations[0].en);
  });

  it('names the forecourt as a station, and uses stations going north too', () => {
    const f = placeAt(1, 'western', 15, 30);
    expect(f.kind).toBe('station');
    expect(f.primary).toBe('Churchgate Station');
    expect(placeAt(1, 'western', 32, -6 * CHUNK + 20).primary).toBe(stationForPlatform('western', -1).en);
    // The platform edge x is the platform's west face.
    expect(placeAt(1, 'western', PLATFORM_X0 + 0.1, 20).kind).toBe('platform');
  });

  it('names streets by their grid line, the same all along, and a junction by both', () => {
    const a = placeAt(1, 'western', 64, 100);
    const b = placeAt(1, 'western', 64.5, 220);
    expect(a.kind).toBe('street');
    expect(a.primary).toBe(streetName('ns', 1, 1));
    expect(b.primary).toBe(a.primary);
    const j = placeAt(1, 'western', 128, 128);
    expect(j.kind).toBe('junction');
    expect(j.primary).toBe(streetName('ns', 2, 1));
    expect(j.secondary).toContain(streetName('ew', 2, 1));
  });

  it('gives neighbouring streets different names, and every street a real name', () => {
    for (let i = -50; i < 50; i++) {
      expect(streetName('ns', i)).not.toBe(streetName('ns', i + 1));
      expect(STREET_NAMES).toContain(streetName('ew', i));
    }
    expect(new Set(STREET_NAMES).size).toBe(STREET_NAMES.length);
    // Forty consecutive grid lines use forty different names.
    expect(new Set(Array.from({ length: 40 }, (_, i) => streetName('ns', i))).size).toBe(40);
  });

  it('calls the street where it meets the railway a level crossing', () => {
    const p = placeAt(1, 'western', 40, 3 * CHUNK + 1);
    expect(p.kind).toBe('crossing');
    expect(p.primary).toBe(streetName('ew', 3, 1));
  });

  it('addresses a spot inside a block by its nearest street and names parks', () => {
    let park = false;
    let block = false;
    for (let cx = -6; cx <= 6 && !(park && block); cx++) {
      for (let cz = -6; cz <= 6; cz++) {
        if (cx === 0) continue;
        const p = placeAt(3, 'harbour', cx * CHUNK + 32, cz * CHUNK + 32);
        if (p.kind === 'park') {
          park = true;
          expect(PARK_NAMES).toContain(p.primary as (typeof PARK_NAMES)[number]);
        } else {
          block = true;
          expect(p.kind).toBe('block');
          expect(STREET_NAMES).toContain(p.primary as (typeof STREET_NAMES)[number]);
        }
        expect(p.secondary.length).toBeGreaterThan(0);
      }
    }
    expect(park && block).toBe(true);
  });

  it('gives a distinct key for a distinct readout', () => {
    expect(placeAt(1, 'western', 64, 100).key).toBe(placeAt(1, 'western', 64.2, 101).key);
    expect(placeAt(1, 'western', 64, 100).key).not.toBe(placeAt(1, 'western', 64, 100 + 6 * CHUNK).key);
  });
});
