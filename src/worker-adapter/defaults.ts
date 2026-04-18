import { registerWorkerAdapter } from './registry.js';
import { ProcessWorkerAdapter } from './process-adapter.js';
import type { WorkerRuntime } from './types.js';

const DEFAULT_RUNTIMES: WorkerRuntime[] = [
  'opencode',
  'codex',
  'claude',
  'gemini',
  'copilot',
];

export function registerDefaultWorkerAdapters(): void {
  for (const runtime of DEFAULT_RUNTIMES) {
    registerWorkerAdapter(new ProcessWorkerAdapter(runtime));
  }
}
