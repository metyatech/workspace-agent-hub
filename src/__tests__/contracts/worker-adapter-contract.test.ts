import { describe, expect, it } from 'vitest';
import type {
  WorkerAdapter,
  WorkerAvailability,
  WorkerHandle,
  WorkerOutputChunk,
  WorkerStatus,
  WorkerTask,
} from '../../worker-adapter/types.js';

class MockWorkerAdapter implements WorkerAdapter {
  readonly runtime = 'opencode';

  async start(task: WorkerTask): Promise<WorkerHandle> {
    return {
      runtime: this.runtime,
      taskId: task.id,
      sessionId: `${task.id}-session`,
    };
  }

  async resume(handle: WorkerHandle): Promise<WorkerHandle> {
    return handle;
  }

  async *streamOutput(handle: WorkerHandle): AsyncIterable<WorkerOutputChunk> {
    yield { kind: 'status', text: `${handle.taskId}:started` };
    yield { kind: 'output', text: `${handle.taskId}:done` };
  }

  async stop(): Promise<void> {}

  async getStatus(_handle: WorkerHandle): Promise<WorkerStatus> {
    return 'completed';
  }

  async isAvailable(): Promise<WorkerAvailability> {
    return { available: true };
  }
}

describe('worker-adapter contract', () => {
  it('supports the full adapter lifecycle', async () => {
    const adapter = new MockWorkerAdapter();
    const task: WorkerTask = {
      id: 'task-1',
      repoRoot: 'D:\\ghws\\workspace-agent-hub',
      prompt: 'Inspect the current task',
      runMode: 'read-only',
      writeScopes: [],
    };

    const handle = await adapter.start(task);
    expect(handle).toEqual({
      runtime: 'opencode',
      taskId: 'task-1',
      sessionId: 'task-1-session',
    });
    expect(await adapter.resume(handle)).toEqual(handle);
    expect(await adapter.getStatus(handle)).toBe('completed');
    expect(await adapter.isAvailable()).toEqual({ available: true });
    const chunks: WorkerOutputChunk[] = [];
    for await (const chunk of adapter.streamOutput(handle)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { kind: 'status', text: 'task-1:started' },
      { kind: 'output', text: 'task-1:done' },
    ]);
  });
});
