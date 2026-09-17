import { describe, expect, it } from 'vitest';
import { BOARD_ASPECT, BOARD_CACHE_SIZE, LruCache, splitBalanced } from '../../src/world/models/stationBoards';

describe('LruCache', () => {
  it('keeps at most `capacity` entries, evicting the least recently used', () => {
    const evicted: string[] = [];
    const lru = new LruCache<string, number>(3, (_v, k) => evicted.push(k));
    let made = 0;
    const get = (k: string) => lru.getOrCreate(k, () => ++made);
    get('a');
    get('b');
    get('c');
    expect(get('a')).toBe(1); // refreshes a
    get('d'); // evicts b
    expect(evicted).toEqual(['b']);
    expect(lru.size).toBe(3);
    expect([...lru.keys()]).toEqual(['c', 'a', 'd']);
    expect(get('b')).toBe(5); // rebuilt
    expect(evicted).toEqual(['b', 'c']);
    expect(made).toBe(5);
  });

  it('does not create or evict on a hit', () => {
    const lru = new LruCache<object, string>(2, () => {
      throw new Error('no eviction expected');
    });
    const k = {};
    expect(lru.getOrCreate(k, () => 'x')).toBe('x');
    expect(lru.getOrCreate(k, () => 'y')).toBe('x');
    expect(lru.get({})).toBeUndefined();
    expect(lru.has(k)).toBe(true);
  });

  it('bounds station boards to about eight textures on a 4:1 board', () => {
    expect(BOARD_CACHE_SIZE).toBe(8);
    expect(BOARD_ASPECT).toBe(4);
  });
});

describe('splitBalanced', () => {
  it('breaks a long name at the space nearest its middle', () => {
    expect(splitBalanced('CHHATRAPATI SHIVAJI MAHARAJ TERMINUS')).toEqual(['CHHATRAPATI SHIVAJI', 'MAHARAJ TERMINUS']);
    expect(splitBalanced('GURU TEGH BAHADUR NAGAR')).toEqual(['GURU TEGH', 'BAHADUR NAGAR']);
    expect(splitBalanced('PANVEL')).toEqual(['PANVEL', '']);
  });
});
