import { describe, expect, it } from 'vitest';
import { KeyedPool } from '../../src/world/pools';

describe('KeyedPool', () => {
  it('hands out pre-warmed objects without building', () => {
    let n = 0;
    const pool = new KeyedPool<{ id: number }>();
    pool.warm('a', () => ({ id: n++ }), 2);
    expect(pool.built).toBe(2);
    const x = pool.acquire('a', () => ({ id: 99 }));
    const y = pool.acquire('a', () => ({ id: 99 }));
    expect([x.id, y.id].sort()).toEqual([0, 1]);
    expect(pool.misses).toBe(0);
  });

  it('builds on demand with the registered factory and recycles releases', () => {
    let n = 0;
    const built: string[] = [];
    const pool = new KeyedPool<{ id: number }>((_item, key) => built.push(key));
    pool.warm('a', () => ({ id: n++ }), 1);
    const first = pool.acquire('a', () => ({ id: -1 }));
    const second = pool.acquire('a', () => ({ id: -1 }));
    expect(second.id).toBe(1); // the warm factory wins over the fallback
    expect(pool.misses).toBe(1);
    pool.release('a', first);
    pool.release('a', second);
    expect(pool.available('a')).toBe(2);
    pool.acquire('a', () => ({ id: -1 }));
    pool.acquire('a', () => ({ id: -1 }));
    expect(pool.built).toBe(2);
    expect(built).toEqual(['a', 'a']);
  });

  it('keeps keys apart', () => {
    const pool = new KeyedPool<string>();
    pool.warm('train|0|30', () => 'long');
    pool.warm('train|0|10', () => 'short');
    expect(pool.acquire('train|0|10', () => 'x')).toBe('short');
    expect(pool.acquire('train|0|30', () => 'x')).toBe('long');
    expect(pool.acquire('cow|1', () => 'cow')).toBe('cow');
  });
});
