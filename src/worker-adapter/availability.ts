import { describeWorkerRuntimeCliAvailability } from '../manager-worker-runtime.js';
import type { WorkerAvailability, WorkerRuntime } from './types.js';

export interface WorkerRuntimeAvailability extends WorkerAvailability {
  runtime: WorkerRuntime;
  command: string;
  resolvedPath: string | null;
  detail: string;
}

export const KNOWN_WORKER_RUNTIMES: WorkerRuntime[] = [
  'opencode',
  'codex',
  'claude',
  'gemini',
  'copilot',
];

export function getWorkerRuntimeAvailability(
  runtime: WorkerRuntime,
  options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
): WorkerRuntimeAvailability {
  const availability = describeWorkerRuntimeCliAvailability(runtime, options);
  return {
    runtime,
    command: availability.command,
    resolvedPath: availability.resolvedPath,
    available: availability.available,
    detail: availability.detail,
    reason: availability.available ? undefined : availability.detail,
  };
}

export function listWorkerRuntimeAvailability(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): WorkerRuntimeAvailability[] {
  return KNOWN_WORKER_RUNTIMES.map((runtime) =>
    getWorkerRuntimeAvailability(runtime, options)
  );
}
