import { onTestFinished } from 'vitest';

/** A Storage kept in a Map, so a test can give each simulated window its own. */
export class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function install(name: 'localStorage' | 'sessionStorage', value: Storage) {
  Object.defineProperty(window, name, { value, writable: true, configurable: true });
}

/**
 * Browser windows of one origin: one localStorage between them and a
 * sessionStorage each. Window 0 is current; `use(n)` makes window n the one the
 * code under test sees, and `reopen(n)` gives it a fresh sessionStorage, as a
 * closed and reopened tab has. The real storages are back after the test.
 */
export function simulateWindows(count: number) {
  const originalLocal = window.localStorage;
  const originalSession = window.sessionStorage;
  onTestFinished(() => {
    install('localStorage', originalLocal);
    install('sessionStorage', originalSession);
  });

  const local = new MemoryStorage();
  const sessions = Array.from({ length: count }, () => new MemoryStorage());
  install('localStorage', local);
  install('sessionStorage', sessions[0]);
  return {
    local,
    use: (index: number) => install('sessionStorage', sessions[index]),
    reopen: (index: number) => {
      sessions[index] = new MemoryStorage();
      install('sessionStorage', sessions[index]);
    },
  };
}
