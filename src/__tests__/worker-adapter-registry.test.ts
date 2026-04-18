import { afterEach, describe, expect, it } from 'vitest';
import {
  clearWorkerAdapterRegistry,
  getWorkerAdapter,
  listWorkerAdapters,
  registerWorkerAdapter,
} from '../worker-adapter/registry.js';
import type {
  WorkerAdapter,
  WorkerAvailability,
  WorkerHandle,
  WorkerOutputChunk,
  WorkerStatus,
  WorkerTask,
} from '../worker-adapter/types.js';

class RegistryTestAdapter implements WorkerAdapter {
  constructor(readonly runtime: 'opencode' | 'codex') {}

  async start(task: WorkerTask): Promise<WorkerHandle> {
    return { runtime: this.runtime, taskId: task.id, sessionId: task.id };
  }

  async resume(handle: WorkerHandle): Promise<WorkerHandle> {
    return handle;
  }

  async *streamOutput(): AsyncIterable<WorkerOutputChunk> {
    yield { kind: 'status', text: 'ok' };
  }

  async stop(): Promise<void> {}

  async getStatus(): Promise<WorkerStatus> {
    return 'completed';
  }

  async isAvailable(): Promise<WorkerAvailability> {
    return { available: true };
  }
}

afterEach(() => {
  clearWorkerAdapterRegistry();
});

describe('worker-adapter registry', () => {
  it('registers and resolves adapters by runtime', () => {
    const adapter = new RegistryTestAdapter('opencode');
    registerWorkerAdapter(adapter);

    expect(getWorkerAdapter('opencode')).toBe(adapter);
    expect(getWorkerAdapter('codex')).toBeNull();
  });

  it('lists registered adapters in insertion order', () => {
    const openCodeAdapter = new RegistryTestAdapter('opencode');
    const codexAdapter = new RegistryTestAdapter('codex');
    registerWorkerAdapter(openCodeAdapter);
    registerWorkerAdapter(codexAdapter);

    expect(listWorkerAdapters()).toEqual([openCodeAdapter, codexAdapter]);
  });
});
