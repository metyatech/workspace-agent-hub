import { describe, expect, it, vi } from 'vitest';

vi.mock('../repo-auditor.js', () => ({
  auditWorkspaceContracts: vi.fn().mockResolvedValue([
    {
      repoRoot: 'D:\\ghws\\workspace-agent-hub',
      audit: { valid: true, snapshot: {}, issues: [] },
    },
    {
      repoRoot: 'D:\\ghws\\opencode',
      audit: {
        valid: false,
        snapshot: {},
        issues: [{ code: 'missing-license' }],
      },
    },
  ]),
}));

vi.mock('../manager-repos.js', () => ({
  readManagedRepos: vi.fn().mockResolvedValue([
    {
      id: 'workspace-agent-hub',
      label: 'workspace-agent-hub',
      repoRoot: 'D:\\ghws\\workspace-agent-hub',
      defaultBranch: 'main',
      verifyCommand: 'npm run verify',
      supportedWorkerRuntimes: ['opencode', 'codex', 'claude'],
      preferredWorkerRuntime: 'opencode',
      mergeLaneEnabled: true,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    },
  ]),
}));

vi.mock('../manager-work-items.js', () => ({
  readManagerWorkItems: vi.fn().mockResolvedValue([
    {
      id: 'thread-1',
      title: 'Need a reply',
      status: 'active',
      updatedAt: '2026-04-18T00:00:00.000Z',
      createdAt: '2026-04-18T00:00:00.000Z',
      messages: [],
      uiState: 'user-reply-needed',
      canonicalStateReason: 'Need a human answer',
      previewText: '',
      lastSender: null,
      hiddenByDefault: false,
      routingConfirmationNeeded: false,
      routingHint: null,
      derivedFromThreadIds: [],
      derivedChildThreadIds: [],
      managedRepoId: 'workspace-agent-hub',
      managedRepoLabel: 'workspace-agent-hub',
      managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
      repoTargetKind: 'existing-repo',
      newRepoName: null,
      newRepoRoot: null,
      managedBaseBranch: 'main',
      managedVerifyCommand: 'npm run verify',
      requestedWorkerRuntime: 'opencode',
      requestedRunMode: 'write',
      queueDepth: 1,
      isWorking: false,
      queueOrder: null,
      queuePriority: null,
      assigneeKind: null,
      assigneeLabel: null,
      workerAgentId: null,
      workerRuntimeState: null,
      workerRuntimeDetail: null,
      workerWriteScopes: [],
      workerBlockedByThreadIds: [],
      supersededByThreadId: null,
      workerLiveLog: [],
      workerLiveOutput: null,
      workerLiveAt: null,
      seedRecoveryPending: false,
      seedRecoveryRepoRoot: null,
      seedRecoveryRepoLabel: null,
      seedRecoveryChangedFiles: [],
      pendingReplyAt: null,
      strandedAutoResumeCount: 0,
      strandedAutoResumeLastAttemptAt: null,
      recentStateTransitions: [],
    },
  ]),
}));

vi.mock('../manager-backend.js', () => ({
  readSession: vi.fn().mockResolvedValue({
    activeAssignments: [],
    dispatchingThreadId: null,
    dispatchingStartedAt: null,
  }),
  readQueue: vi.fn().mockResolvedValue([]),
}));

vi.mock('../worker-adapter/availability.js', () => ({
  listWorkerRuntimeAvailability: vi.fn().mockReturnValue([
    { runtime: 'opencode', available: true },
    { runtime: 'codex', available: false },
  ]),
}));

import {
  deriveWorkspaceHealth,
  deriveWorkspaceHealthFromPreflight,
} from '../workspace-health.js';

describe('workspace-health', () => {
  it('combines repo audits, approvals, runs, merge lanes, and runtime health', async () => {
    const snapshot = await deriveWorkspaceHealth('D:\\ghws');

    expect(snapshot.inScopeRepoCount).toBe(2);
    expect(snapshot.invalidRepoCount).toBe(1);
    expect(snapshot.approvalQueueCount).toBe(1);
    expect(snapshot.runCount).toBe(0);
    expect(snapshot.mergeLaneCount).toBe(1);
    expect(snapshot.unavailableRuntimeCount).toBe(1);
  });

  it('derives the same health counters from a preflight report bridge', () => {
    const snapshot = deriveWorkspaceHealthFromPreflight({
      workspaceRoot: 'D:\\ghws',
      generatedAt: '2026-04-19T00:00:00.000Z',
      overall: 'warn',
      checks: [],
      summary: {
        inScopeRepoCount: 2,
        invalidRepoCount: 1,
        approvalQueueCount: 1,
        runCount: 0,
        mergeLaneCount: 1,
        unavailableRuntimeCount: 1,
      },
      repoAudits: [
        {
          repoRoot: 'D:\\ghws\\workspace-agent-hub',
          audit: {
            valid: true,
            snapshot: { repoRoot: 'D:\\ghws\\workspace-agent-hub' },
            issues: [],
          },
        },
      ],
      totalDurationMs: 15,
    });

    expect(snapshot).toMatchObject({
      workspaceRoot: 'D:\\ghws',
      inScopeRepoCount: 2,
      invalidRepoCount: 1,
      approvalQueueCount: 1,
      runCount: 0,
      mergeLaneCount: 1,
      unavailableRuntimeCount: 1,
    });
  });
});
