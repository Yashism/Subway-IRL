/**
 * Keyed object pool. Objects are built once per key (kind + variant + length), handed out
 * while an obstacle is on screen and returned when it leaves, so nothing is built during
 * play once the pool is warm. Each key grows only to the peak number of simultaneous users.
 */
export class KeyedPool<T> {
  private readonly free = new Map<string, T[]>();
  private readonly factories = new Map<string, () => T>();
  /** Objects built so far (pre-warm plus any built on demand). */
  built = 0;
  /** Objects built on demand because the key's free list was empty. */
  misses = 0;

  constructor(private readonly onBuild: (item: T, key: string) => void = () => {}) {}

  /** Registers how to build `key` and pre-builds `count` objects for it. */
  warm(key: string, factory: () => T, count = 1): void {
    this.factories.set(key, factory);
    const list = this.list(key);
    for (let i = 0; i < count; i++) list.push(this.build(key, factory));
  }

  acquire(key: string, factory: () => T): T {
    const list = this.list(key);
    const item = list.pop();
    if (item !== undefined) return item;
    this.misses++;
    let f = this.factories.get(key);
    if (!f) this.factories.set(key, (f = factory));
    return this.build(key, f);
  }

  release(key: string, item: T): void {
    this.list(key).push(item);
  }

  /** Free objects waiting under `key`. */
  available(key: string): number {
    return this.free.get(key)?.length ?? 0;
  }

  private build(key: string, factory: () => T): T {
    const item = factory();
    this.built++;
    this.onBuild(item, key);
    return item;
  }

  private list(key: string): T[] {
    let list = this.free.get(key);
    if (!list) this.free.set(key, (list = []));
    return list;
  }
}
