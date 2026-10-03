export class SessionBlockedError extends Error {
  constructor() {
    super(
      "Sensor: выполнение остановлено пользователем. Продолжение этого дерева сессий заблокировано до перезапуска плагина.",
    );
    this.name = "SessionBlockedError";
  }
}

/** A latch is separate from abort: an abort alone does not prevent the next call. */
export class SessionGates {
  private readonly rejected = new Set<string>();
  private readonly held = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(private readonly parents: Map<string, string | null>) {}

  related(left: string, right: string): boolean {
    const lineage = (session: string) => {
      const ids = new Set<string>();
      while (!ids.has(session)) {
        ids.add(session);
        const parent = this.parents.get(session);
        if (!parent) break;
        session = parent;
      }
      return ids;
    };
    const a = lineage(left);
    return [...lineage(right)].some((id) => a.has(id));
  }

  isBlocked(session: string): boolean {
    return this.disposed || [...this.rejected].some((id) => this.related(id, session));
  }

  isHeld(session: string): boolean {
    return [...this.held.values()].some((id) => this.related(id, session));
  }

  hold(session: string, requestID: string): void {
    if (this.isBlocked(session)) throw new SessionBlockedError();
    this.held.set(requestID, session);
    this.wake();
  }

  release(requestID: string): void {
    this.held.delete(requestID);
    this.wake();
  }

  block(session: string): void {
    this.rejected.add(session);
    this.wake();
  }

  async wait(session: string): Promise<void> {
    while (true) {
      if (this.isBlocked(session)) throw new SessionBlockedError();
      if (!this.isHeld(session)) return;
      // No await between observing the state and registering a listener.
      await new Promise<void>((resolve) => this.listeners.add(resolve));
    }
  }

  close(): void {
    this.disposed = true;
    this.wake();
  }

  private wake(): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    listeners.forEach((resolve) => resolve());
  }
}
