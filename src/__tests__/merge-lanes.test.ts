import { describe, expect, it } from 'vitest';
import { deriveMergeLanes } from '../merge-lanes.js';
import type { ManagedRepoConfig } from '../manager-repos.js';
import type { ManagerThreadView } from '../manager-thread-state.js';

function makeRepo(repoRoot: string): ManagedRepoConfig {
  return {
    id: repoRoot.split('\\').at(-1) ?? 'repo',
    label: repoRoot.split('\\').at(-1) ?? 'repo',
    repoRoot,
    defaultBranch: 'main',
    verifyCommand: 'npm run verify',
    supportedWorkerRuntimes: ['opencode', 'codex', 'claude'],
    preferredWorkerRuntime: 'opencode',
    mergeLaneEnabled: true,
    createdAt: '2026-04-18T00:00:00.000Z',
    updatedAt: '2026-04-18T00:00:00.000Z',
  };
}

function makeWorkItem(
  repoRoot: string,
  overrides: Partial<ManagerThreadView>
): ManagerThreadView {
  return {
    id: 'thread-1',
    title: 'Thread',
    status: 'active',
    updatedAt: '2026-04-18T00:00:00.000Z',
    createdAt: '2026-04-18T00:00:00.000Z',
    messages: [],
    uiState: 'queued',
    canonicalStateReason: null,
    previewText: '',
    lastSender: null,
    hiddenByDefault: false,
    routingConfirmationNeeded: false,
    routingHint: null,
    derivedFromThreadIds: [],
    derivedChildThreadIds: [],
    managedRepoId: 'repo',
    managedRepoLabel: 'repo',
    managedRepoRoot: repoRoot,
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
    ...overrides,
  };
}

describe('merge-lanes', () => {
  it('derives lane states and queue depth from repo-targeted work items', () => {
    const repoRoot = 'D:\\ghws\\workspace-agent-hub';
    const lanes = deriveMergeLanes({
      repos: [makeRepo(repoRoot)],
      workItems: [
        makeWorkItem(repoRoot, {
          uiState: 'ai-working',
          workerAgentId: 'run-1',
          queueDepth: 2,
        }),
      ],
    });

    expect(lanes).toEqual([
      {
        repoRoot,
        state: 'merging',
        queueDepth: 2,
        activeRunId: 'run-1',
      },
    ]);
  });

  it('marks lanes as needs-human when recovery is pending', () => {
    const repoRoot = 'D:\\ghws\\workspace-agent-hub';
    const lanes = deriveMergeLanes({
      repos: [makeRepo(repoRoot)],
      workItems: [makeWorkItem(repoRoot, { seedRecoveryPending: true })],
    });

    expect(lanes[0]?.state).toBe('needs-human');
  });
});
