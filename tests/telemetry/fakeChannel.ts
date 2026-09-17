/** Synchronous in-memory BroadcastChannel for tests. Messages are structured-cloned like the real one. */
export class FakeBroadcastChannel {
  static registry = new Map<string, Set<FakeBroadcastChannel>>();
  static reset(): void {
    FakeBroadcastChannel.registry.clear();
  }

  onmessage: ((e: MessageEvent) => void) | null = null;
  private listeners = new Set<(e: MessageEvent) => void>();
  private closed = false;

  constructor(readonly name: string) {
    let set = FakeBroadcastChannel.registry.get(name);
    if (!set) FakeBroadcastChannel.registry.set(name, (set = new Set()));
    set.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new Error('channel closed');
    for (const peer of FakeBroadcastChannel.registry.get(this.name) ?? []) {
      if (peer === this) continue;
      peer.deliver(structuredClone(data));
    }
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (type === 'message') this.listeners.add(fn);
  }

  removeEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (type === 'message') this.listeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }

  private deliver(data: unknown): void {
    const e = { data } as MessageEvent;
    this.onmessage?.(e);
    for (const fn of this.listeners) fn(e);
  }
}

/** A monitor-side peer that records what it receives. */
export function peer(name = 'subway-irl') {
  const ch = new FakeBroadcastChannel(name);
  const got: Record<string, unknown>[] = [];
  ch.onmessage = (e) => got.push(e.data as Record<string, unknown>);
  const kinds = (k: string) => got.filter((m) => m.kind === k);
  return { ch, got, kinds, send: (m: unknown) => ch.postMessage(m) };
}
