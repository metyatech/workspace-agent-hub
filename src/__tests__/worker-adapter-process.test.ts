import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ProcessWorkerAdapter } from '../worker-adapter/process-adapter.js';
import type { WorkerTask } from '../worker-adapter/types.js';

class MockStream extends EventEmitter {
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

class MockChild extends EventEmitter {
  stdout = new MockStream();
  stderr = new MockStream();
  killed = false;

  kill(): void {
    this.killed = true;
    this.emit('close', 0);
  }
}

describe('process worker adapter', () => {
  it('starts, streams output, and completes a process-backed run', async () => {
    const child = new MockChild();
    const adapter = new ProcessWorkerAdapter(
      'opencode',
      (() => child) as never
    );
    const task: WorkerTask = {
      id: 'task-1',
      repoRoot: 'D:\\ghws\\workspace-agent-hub',
      prompt: 'Inspect the current task',
      runMode: 'read-only',
      writeScopes: [],
    };

    const handle = await adapter.start(task);
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'text', part: { text: 'hello' } }) + '\n'
      )
    );
    child.emit('close', 0);

    const chunks = [];
    for await (const chunk of adapter.streamOutput(handle)) {
      chunks.push(chunk);
    }

    expect(chunks.some((chunk) => chunk.text.includes('Started Worker'))).toBe(
      true
    );
    expect(chunks.some((chunk) => chunk.text === 'hello')).toBe(true);
    expect(await adapter.getStatus(handle)).toBe('completed');
  });

  it('stops an active run', async () => {
    const child = new MockChild();
    const adapter = new ProcessWorkerAdapter(
      'opencode',
      (() => child) as never
    );
    const handle = await adapter.start({
      id: 'task-2',
      repoRoot: 'D:\\ghws\\workspace-agent-hub',
      prompt: 'Stop me',
      runMode: 'write',
      writeScopes: ['src/index.ts'],
    });

    await adapter.stop(handle);
    expect(child.killed).toBe(true);
  });
});
