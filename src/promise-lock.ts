export async function withSerializedKeyLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, gate);
  try {
    try {
      await previous;
    } catch {
      // The previous caller already observed its own failure. Keep the queue
      // moving so one rejected mutation does not poison the lock forever.
    }
    return await fn();
  } finally {
    release();
    if (locks.get(key) === gate) {
      locks.delete(key);
    }
  }
}
