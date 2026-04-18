import type { WorkerRuntime } from '../worker-adapter/types.js';

export type RunMode = 'read-only' | 'write';

export type RunState =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'verifying'
  | 'awaiting-merge'
  | 'merging'
  | 'conflict-resolving'
  | 'merged'
  | 'needs-human'
  | 'failed'
  | 'cancelled-as-superseded';

export interface RunRecord {
  id: string;
  workItemId: string;
  repoRoot: string;
  runtime: WorkerRuntime;
  mode: RunMode;
  state: RunState;
  writeScopes: string[];
  worktreeId?: string | null;
  branch?: string | null;
  blockedByRunIds?: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export const RUN_ALLOWED_TRANSITIONS: Record<RunState, RunState[]> = {
  queued: ['provisioning', 'cancelled-as-superseded'],
  provisioning: ['running', 'failed', 'needs-human', 'cancelled-as-superseded'],
  running: ['verifying', 'needs-human', 'failed', 'cancelled-as-superseded'],
  verifying: ['awaiting-merge', 'needs-human', 'failed'],
  'awaiting-merge': ['merging', 'needs-human', 'failed'],
  merging: ['conflict-resolving', 'merged', 'needs-human', 'failed'],
  'conflict-resolving': ['merging', 'needs-human', 'failed'],
  merged: [],
  'needs-human': ['queued', 'provisioning', 'merging', 'failed'],
  failed: [],
  'cancelled-as-superseded': [],
};

export function canTransitionRunState(from: RunState, to: RunState): boolean {
  return RUN_ALLOWED_TRANSITIONS[from].includes(to);
}
