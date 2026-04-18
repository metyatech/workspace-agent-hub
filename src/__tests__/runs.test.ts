import { describe, expect, it } from 'vitest';
import { deriveRunsSnapshot } from '../runs.js';
import type { ManagerSession, QueueEntry } from '../manager-backend.js';
import type { ManagerThreadMeta } from '../manager-thread-state.js';

function makeSession(): ManagerSession {
  return {
    workspaceKey: 'workspace',
    status: 'idle',
    sessionId: null,
    routingSessionId: null,
    pid: null,
    currentQueueId: null,
    startedAt: null,
    lastMessageAt: null,
    priorityStreak: 0,
    lastProgressAt: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    lastPauseMessage: null,
    lastPauseAt: null,
    lastPauseAutoResumeAt: null,
    activeAssignments: [],
    dispatchingThreadId: null,
    dispatchingQueueEntryIds: [],
    dispatchingAssigneeKind: null,
    dispatchingAssigneeLabel: null,
    dispatchingDetail: null,
    dispatchingStartedAt: null,
  };
}

describe('runs', () => {
  it('derives queued, provisioning, and running records from manager state', () => {
    const session: ManagerSession = {
      ...makeSession(),
      dispatchingThreadId: 'thread-provisioning',
      dispatchingStartedAt: '2026-04-18T00:00:01.000Z',
      activeAssignments: [
        {
          id: 'assignment-running',
          threadId: 'thread-running',
          queueEntryIds: ['queue-running'],
          assigneeKind: 'worker',
          targetKind: 'existing-repo',
          newRepoName: null,
          workerRuntime: 'opencode',
          workerModel: null,
          workerEffort: null,
          assigneeLabel: 'Worker OpenCode',
          writeScopes: ['src/index.ts'],
          pid: 1234,
          startedAt: '2026-04-18T00:00:02.000Z',
          lastProgressAt: '2026-04-18T00:00:03.000Z',
          worktreePath: 'D:\\ghws\\repo-wt-task',
          worktreeBranch: 'wt/task',
          targetRepoRoot: 'D:\\ghws\\repo',
          workingDirectory: null,
          pendingOnboardingCommit: null,
        },
      ],
    };

    const queue: QueueEntry[] = [
      {
        id: 'queue-queued',
        threadId: 'thread-queued',
        content: 'Do the thing',
        createdAt: '2026-04-18T00:00:00.000Z',
        processed: false,
        priority: 'normal',
        requestedWorkerRuntime: 'codex',
        requestedRunMode: 'read-only',
        writeScopes: [],
      },
    ];

    const meta: Record<string, ManagerThreadMeta> = {
      'thread-provisioning': {
        managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
        requestedWorkerRuntime: 'opencode',
        requestedRunMode: 'write',
        workerWriteScopes: ['src/manager-backend.ts'],
      },
    };

    const snapshot = deriveRunsSnapshot({
      dir: 'D:\\ghws\\workspace-agent-hub',
      session,
      queue,
      meta,
    });

    expect(snapshot.runs.map((run) => run.state)).toEqual([
      'queued',
      'provisioning',
      'running',
    ]);
    expect(
      snapshot.runs.find((run) => run.id === 'assignment-running')?.mode
    ).toBe('write');
    expect(
      snapshot.runs.find((run) => run.id === 'queue:queue-queued')?.runtime
    ).toBe('codex');
  });
});
