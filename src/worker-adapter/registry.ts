import type { WorkerAdapter, WorkerRuntime } from './types.js';

const registry = new Map<WorkerRuntime, WorkerAdapter>();

export function registerWorkerAdapter(adapter: WorkerAdapter): void {
  registry.set(adapter.runtime, adapter);
}

export function getWorkerAdapter(runtime: WorkerRuntime): WorkerAdapter | null {
  return registry.get(runtime) ?? null;
}

export function listWorkerAdapters(): WorkerAdapter[] {
  return [...registry.values()];
}

export function clearWorkerAdapterRegistry(): void {
  registry.clear();
}
