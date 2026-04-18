export type WorkerRuntime =
  | 'opencode'
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'copilot';

export type WorkerRunMode = 'read-only' | 'write';

export type WorkerStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'needs-human'
  | 'failed'
  | 'cancelled';

export interface WorkerTask {
  id: string;
  repoRoot: string;
  prompt: string;
  runMode: WorkerRunMode;
  writeScopes: string[];
}

export interface WorkerHandle {
  runtime: WorkerRuntime;
  taskId: string;
  sessionId: string | null;
}

export interface WorkerOutputChunk {
  kind: 'status' | 'output' | 'error';
  text: string;
}

export interface WorkerAvailability {
  available: boolean;
  reason?: string;
}

export interface WorkerAdapter {
  readonly runtime: WorkerRuntime;
  start(task: WorkerTask): Promise<WorkerHandle>;
  resume(handle: WorkerHandle): Promise<WorkerHandle>;
  streamOutput(handle: WorkerHandle): AsyncIterable<WorkerOutputChunk>;
  stop(handle: WorkerHandle): Promise<void>;
  getStatus(handle: WorkerHandle): Promise<WorkerStatus>;
  isAvailable(): Promise<WorkerAvailability>;
}
