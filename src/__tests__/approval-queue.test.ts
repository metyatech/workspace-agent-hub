import { describe, expect, it } from 'vitest';
import { deriveApprovalQueue } from '../approval-queue.js';
import type { ManagerThreadView } from '../manager-thread-state.js';

function makeItem(overrides: Partial<ManagerThreadView>): ManagerThreadView {
  return {
    id: 'thread-1',
    title: 'Test thread',
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
    managedRepoId: null,
    managedRepoLabel: null,
    managedRepoRoot: null,
    repoTargetKind: null,
    newRepoName: null,
    newRepoRoot: null,
    managedBaseBranch: null,
    managedVerifyCommand: null,
    requestedWorkerRuntime: null,
    requestedRunMode: null,
    queueDepth: 0,
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

describe('approval-queue', () => {
  it('derives human-gated items from manager thread views', () => {
    const items = deriveApprovalQueue([
      makeItem({
        id: 'routing',
        uiState: 'routing-confirmation-needed',
        routingHint: 'Need repo clarification',
      }),
      makeItem({
        id: 'reply',
        uiState: 'user-reply-needed',
        canonicalStateReason: 'Need a human answer',
      }),
      makeItem({
        id: 'done',
        uiState: 'ai-finished-awaiting-user-confirmation',
      }),
      makeItem({
        id: 'recovery',
        seedRecoveryPending: true,
        canonicalStateReason: 'Seed recovery required',
      }),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      'routing-confirmation',
      'human-reply',
      'delivery-confirmation',
      'recovery-needed',
    ]);
  });
});
