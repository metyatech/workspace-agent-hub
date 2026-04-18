import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  buildWorkerRuntimeLaunchSpec,
  parseGenericRuntimeProgressLine,
} from '../manager-worker-runtime.js';
import {
  getWorkerRuntimeAvailability,
  type WorkerRuntimeAvailability,
} from './availability.js';
import type {
  WorkerAdapter,
  WorkerAvailability,
  WorkerHandle,
  WorkerOutputChunk,
  WorkerStatus,
  WorkerTask,
  WorkerRuntime,
} from './types.js';

interface AdapterState {
  handle: WorkerHandle;
  child: ChildProcessWithoutNullStreams;
  status: WorkerStatus;
  queue: WorkerOutputChunk[];
  waiters: Array<() => void>;
  done: boolean;
}

type SpawnLike = typeof spawn;

function wakeWaiters(state: AdapterState): void {
  while (state.waiters.length > 0) {
    state.waiters.shift()?.();
  }
}

function enqueue(state: AdapterState, chunk: WorkerOutputChunk): void {
  state.queue.push(chunk);
  wakeWaiters(state);
}

async function* streamState(
  state: AdapterState
): AsyncIterable<WorkerOutputChunk> {
  while (!state.done || state.queue.length > 0) {
    if (state.queue.length > 0) {
      yield state.queue.shift()!;
      continue;
    }
    await new Promise<void>((resolvePromise) => {
      state.waiters.push(resolvePromise);
    });
  }
}

function attachOutputParsers(state: AdapterState): void {
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const flushLines = (
    buffer: string,
    kind: 'stdout' | 'stderr'
  ): { remaining: string } => {
    const lines = buffer.split(/\r?\n/);
    const remaining = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      if (kind === 'stdout') {
        const parsed = parseGenericRuntimeProgressLine(line, 'Started');
        for (const entry of parsed.liveEntries) {
          enqueue(state, { kind: entry.kind, text: entry.text });
        }
      } else {
        enqueue(state, { kind: 'error', text: line.trim() });
      }
    }
    return { remaining };
  };

  state.child.stdout.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    stdoutBuffer = flushLines(stdoutBuffer, 'stdout').remaining;
  });

  state.child.stderr.on('data', (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
    stderrBuffer = flushLines(stderrBuffer, 'stderr').remaining;
  });

  state.child.on('close', (code) => {
    if (stdoutBuffer.trim()) {
      const parsed = parseGenericRuntimeProgressLine(stdoutBuffer, 'Started');
      for (const entry of parsed.liveEntries) {
        enqueue(state, { kind: entry.kind, text: entry.text });
      }
      stdoutBuffer = '';
    }
    if (stderrBuffer.trim()) {
      enqueue(state, { kind: 'error', text: stderrBuffer.trim() });
      stderrBuffer = '';
    }
    state.status =
      code === 0
        ? 'completed'
        : state.status === 'cancelled'
          ? 'cancelled'
          : 'failed';
    state.done = true;
    wakeWaiters(state);
  });

  state.child.on('error', (error) => {
    enqueue(state, { kind: 'error', text: error.message });
    state.status = 'failed';
    state.done = true;
    wakeWaiters(state);
  });
}

export class ProcessWorkerAdapter implements WorkerAdapter {
  readonly runtime: WorkerRuntime;
  private readonly spawnImpl: SpawnLike;
  private readonly states = new Map<string, AdapterState>();

  constructor(runtime: WorkerRuntime, spawnImpl: SpawnLike = spawn) {
    this.runtime = runtime;
    this.spawnImpl = spawnImpl;
  }

  async start(task: WorkerTask): Promise<WorkerHandle> {
    const launch = buildWorkerRuntimeLaunchSpec({
      runtime: this.runtime,
      prompt: task.prompt,
      sessionId: null,
      resolvedDir: task.repoRoot,
      runMode: task.runMode,
    });
    const child = this.spawnImpl(
      launch.command,
      launch.args,
      launch.spawnOptions
    ) as ChildProcessWithoutNullStreams;
    if (launch.prompt !== null) {
      child.stdin.write(launch.prompt);
      child.stdin.end();
    }
    const handle: WorkerHandle = {
      runtime: this.runtime,
      taskId: task.id,
      sessionId: launch.sessionId,
    };
    const state: AdapterState = {
      handle,
      child,
      status: 'running',
      queue: [{ kind: 'status', text: `Started ${launch.displayLabel}` }],
      waiters: [],
      done: false,
    };
    this.states.set(task.id, state);
    attachOutputParsers(state);
    return handle;
  }

  async resume(handle: WorkerHandle): Promise<WorkerHandle> {
    const state = this.states.get(handle.taskId);
    if (!state) {
      throw new Error(`No active run state found for ${handle.taskId}.`);
    }
    return state.handle;
  }

  async *streamOutput(handle: WorkerHandle): AsyncIterable<WorkerOutputChunk> {
    const state = this.states.get(handle.taskId);
    if (!state) {
      throw new Error(`No active run state found for ${handle.taskId}.`);
    }
    yield* streamState(state);
  }

  async stop(handle: WorkerHandle): Promise<void> {
    const state = this.states.get(handle.taskId);
    if (!state) {
      return;
    }
    state.status = 'cancelled';
    state.child.kill();
  }

  async getStatus(handle: WorkerHandle): Promise<WorkerStatus> {
    return this.states.get(handle.taskId)?.status ?? 'failed';
  }

  async isAvailable(): Promise<WorkerAvailability> {
    const availability = getWorkerRuntimeAvailability(this.runtime);
    return {
      available: availability.available,
      reason: availability.reason,
    };
  }
}

export function describeAdapterAvailability(
  runtime: WorkerRuntime
): WorkerRuntimeAvailability {
  return getWorkerRuntimeAvailability(runtime);
}
