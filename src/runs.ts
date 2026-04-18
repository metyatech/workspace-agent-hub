import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { QueueEntry, ManagerSession } from './manager-backend.js';
import {
  readManagerThreadMeta,
  type ManagerThreadMeta,
} from './manager-thread-state.js';
import { writeFileAtomically } from './atomic-file.js';
import { notifyManagerUpdate } from './manager-live-updates.js';
import type { RunRecord, RunState } from './runs/types.js';

export const MANAGER_RUNS_FILE = '.workspace-agent-hub-runs.json';

export interface WorkspaceRunsSnapshot {
  generatedAt: string;
  runs: RunRecord[];
}

export function runsFilePath(dir: string): string {
  return join(resolvePath(dir), MANAGER_RUNS_FILE);
}

export async function readRuns(dir: string): Promise<WorkspaceRunsSnapshot> {
  const filePath = runsFilePath(dir);
  if (!existsSync(filePath)) {
    return { generatedAt: '', runs: [] };
  }
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as WorkspaceRunsSnapshot;
    return {
      generatedAt:
        typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch {
    return { generatedAt: '', runs: [] };
  }
}

export async function writeRuns(
  dir: string,
  snapshot: WorkspaceRunsSnapshot
): Promise<void> {
  await writeFileAtomically(
    runsFilePath(dir),
    JSON.stringify(snapshot, null, 2)
  );
  notifyManagerUpdate(dir);
}

function stateFromAssignment(
  assignment: ManagerSession['activeAssignments'][number]
): RunState {
  return 'running';
}

function repoRootForRun(
  dir: string,
  threadId: string,
  meta: Record<string, ManagerThreadMeta>,
  explicitRepoRoot: string | null | undefined
): string {
  return (
    explicitRepoRoot ?? meta[threadId]?.managedRepoRoot ?? resolvePath(dir)
  );
}

export function deriveRunsSnapshot(input: {
  dir: string;
  session: ManagerSession;
  queue: QueueEntry[];
  meta: Record<string, ManagerThreadMeta>;
}): WorkspaceRunsSnapshot {
  const runs = new Map<string, RunRecord>();

  for (const assignment of input.session.activeAssignments) {
    runs.set(assignment.id, {
      id: assignment.id,
      workItemId: assignment.threadId,
      repoRoot: repoRootForRun(
        input.dir,
        assignment.threadId,
        input.meta,
        assignment.targetRepoRoot
      ),
      runtime: assignment.workerRuntime,
      mode: assignment.writeScopes.length > 0 ? 'write' : 'read-only',
      state: stateFromAssignment(assignment),
      writeScopes: assignment.writeScopes,
      worktreeId: assignment.worktreePath,
      branch: assignment.worktreeBranch,
      createdAt: assignment.startedAt,
      updatedAt: assignment.lastProgressAt ?? assignment.startedAt,
      completedAt: null,
    });
  }

  if (input.session.dispatchingThreadId) {
    const runId = `dispatch:${input.session.dispatchingThreadId}`;
    runs.set(runId, {
      id: runId,
      workItemId: input.session.dispatchingThreadId,
      repoRoot: repoRootForRun(
        input.dir,
        input.session.dispatchingThreadId,
        input.meta,
        null
      ),
      runtime:
        input.meta[input.session.dispatchingThreadId]?.requestedWorkerRuntime ??
        'opencode',
      mode:
        input.meta[input.session.dispatchingThreadId]?.requestedRunMode ??
        'read-only',
      state: 'provisioning',
      writeScopes:
        input.meta[input.session.dispatchingThreadId]?.workerWriteScopes ?? [],
      worktreeId: null,
      branch: null,
      createdAt: input.session.dispatchingStartedAt ?? new Date().toISOString(),
      updatedAt: input.session.dispatchingStartedAt ?? new Date().toISOString(),
      completedAt: null,
    });
  }

  for (const entry of input.queue) {
    if (entry.processed) {
      continue;
    }
    const runId = `queue:${entry.id}`;
    if (runs.has(runId)) {
      continue;
    }
    runs.set(runId, {
      id: runId,
      workItemId: entry.threadId,
      repoRoot: repoRootForRun(
        input.dir,
        entry.threadId,
        input.meta,
        entry.targetRepoRoot
      ),
      runtime:
        entry.requestedWorkerRuntime ??
        input.meta[entry.threadId]?.requestedWorkerRuntime ??
        'opencode',
      mode:
        entry.requestedRunMode ??
        input.meta[entry.threadId]?.requestedRunMode ??
        'read-only',
      state: 'queued',
      writeScopes: entry.writeScopes ?? [],
      worktreeId: null,
      branch: null,
      blockedByRunIds: input.meta[
        entry.threadId
      ]?.workerBlockedByThreadIds?.map((threadId) => `thread:${threadId}`),
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
      completedAt: null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    runs: [...runs.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    ),
  };
}

export async function deriveRunsForWorkspace(
  dir: string,
  input: { session: ManagerSession; queue: QueueEntry[] }
): Promise<WorkspaceRunsSnapshot> {
  const meta = await readManagerThreadMeta(dir);
  return deriveRunsSnapshot({
    dir,
    session: input.session,
    queue: input.queue,
    meta,
  });
}
