import { describe, expect, it } from 'vitest';
import { withSerializedKeyLock } from '../promise-lock.js';

describe('withSerializedKeyLock', () => {
  it('releases later waiters even when the previous holder rejects', async () => {
    const locks = new Map<string, Promise<void>>();
    let allowFirst!: () => void;
    let firstEntered!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      allowFirst = resolve;
    });

    const first = withSerializedKeyLock(locks, 'workspace', async () => {
      firstEntered();
      await firstBlocked;
      throw new Error('boom');
    });

    await firstReady;

    const second = withSerializedKeyLock(locks, 'workspace', async () => 'ok');

    allowFirst();

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(locks.size).toBe(0);
  });

  it('keeps different keys independent', async () => {
    const locks = new Map<string, Promise<void>>();
    let releaseA!: () => void;
    let aEntered!: () => void;
    const aReady = new Promise<void>((resolve) => {
      aEntered = resolve;
    });
    const aBlocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const first = withSerializedKeyLock(locks, 'a', async () => {
      aEntered();
      await aBlocked;
      return 'a';
    });

    await aReady;

    const second = withSerializedKeyLock(locks, 'b', async () => 'b');

    await expect(second).resolves.toBe('b');
    releaseA();
    await expect(first).resolves.toBe('a');
  });
});
