import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveManagerThreadViews,
  reconcileManagerThreadMeta,
  writeManagerThreadMeta,
} from '../manager-thread-state.js';

describe('manager thread state derivation', () => {
  it('treats active AI-replied threads with no in-flight work as awaiting user confirmation', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-working',
          title: 'AA を進める',
          status: 'active',
          updatedAt: '2026-03-21T00:00:00.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'AAして',
              at: '2026-03-21T00:00:00.000Z',
            },
            {
              sender: 'ai',
              content: '進めています。次の更新で状況を返します。',
              at: '2026-03-21T00:00:05.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-03-21T00:00:00.000Z',
        lastMessageAt: '2026-03-21T00:00:05.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [],
      meta: {
        'thread-working': {
          managedRepoId: 'workspace-agent-hub',
          managedRepoLabel: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          managedBaseBranch: 'main',
          managedVerifyCommand: 'npm run verify',
          requestedRunMode: 'write',
        },
      },
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.uiState).toBe('ai-finished-awaiting-user-confirmation');
  });

  it('keeps only the in-flight queue owner in the working bucket', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-working',
          title: 'AA を進める',
          status: 'active',
          updatedAt: '2026-03-21T00:00:10.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'AAして',
              at: '2026-03-21T00:00:00.000Z',
            },
          ],
        },
        {
          id: 'thread-queued',
          title: 'BB を進める',
          status: 'active',
          updatedAt: '2026-03-21T00:00:11.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'BBして',
              at: '2026-03-21T00:00:01.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'busy',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: 1234,
        currentQueueId: 'queue-working',
        startedAt: '2026-03-21T00:00:00.000Z',
        lastMessageAt: '2026-03-21T00:00:12.000Z',
        priorityStreak: 0,
        lastProgressAt: '2026-03-21T00:00:12.000Z',
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [
          {
            id: 'assign-working',
            threadId: 'thread-working',
            queueEntryIds: ['queue-working'],
            assigneeKind: 'worker',
            targetKind: 'existing-repo',
            newRepoName: null,
            workingDirectory: null,
            workerRuntime: 'codex',
            workerModel: null,
            workerEffort: null,
            assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
            writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
            pid: 1234,
            startedAt: '2026-03-21T00:00:02.000Z',
            lastProgressAt: '2026-03-21T00:00:12.000Z',
            worktreePath: null,
            worktreeBranch: null,
            targetRepoRoot: null,
          },
        ],
      },
      queue: [
        {
          id: 'queue-working',
          threadId: 'thread-working',
          content: 'AAして',
          createdAt: '2026-03-21T00:00:02.000Z',
          processed: false,
          priority: 'normal',
        },
        {
          id: 'queue-queued',
          threadId: 'thread-queued',
          content: 'BBして',
          createdAt: '2026-03-21T00:00:03.000Z',
          processed: false,
          priority: 'normal',
        },
      ],
      meta: {},
    });

    expect(views).toHaveLength(2);
    expect(views[0]?.id).toBe('thread-queued');
    expect(views[0]?.uiState).toBe('queued');
    expect(views[1]?.id).toBe('thread-working');
    expect(views[1]?.uiState).toBe('ai-working');
  });

  it('shows a dispatching queued thread as ai-starting instead of queued', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-starting',
          title: 'README 調査',
          status: 'waiting',
          updatedAt: '2026-04-14T02:00:00.000Z',
          createdAt: '2026-04-14T02:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'README を確認してください',
              at: '2026-04-14T02:00:00.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: null,
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-14T02:00:00.000Z',
        lastMessageAt: '2026-04-14T02:00:00.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
        dispatchingThreadId: 'thread-starting',
        dispatchingQueueEntryIds: ['queue-starting'],
        dispatchingAssigneeKind: 'worker',
        dispatchingAssigneeLabel: 'Worker Codex gpt-5.4 (xhigh)',
        dispatchingDetail: '担当 worker agent の起動や再開を準備しています。',
        dispatchingStartedAt: '2026-04-14T02:00:01.000Z',
      },
      queue: [
        {
          id: 'queue-starting',
          threadId: 'thread-starting',
          content: 'README を確認してください',
          createdAt: '2026-04-14T02:00:01.000Z',
          processed: false,
          priority: 'normal',
        },
      ],
      meta: {},
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.uiState).toBe('ai-starting');
  });

  it('treats an in-flight needs-reply thread as ai-working while the assignment is still active', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-retrying',
          title: '再開中の task',
          status: 'needs-reply',
          updatedAt: '2026-04-09T10:58:00.000Z',
          createdAt: '2026-04-09T10:36:00.000Z',
          messages: [
            {
              sender: 'user',
              content: '続けてください',
              at: '2026-04-09T10:36:00.000Z',
            },
            {
              sender: 'ai',
              content: '[Manager] いったん失敗しました',
              at: '2026-04-09T10:47:34.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'busy',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: 46588,
        currentQueueId: 'queue-retrying',
        startedAt: '2026-04-09T10:36:00.000Z',
        lastMessageAt: '2026-04-09T10:58:00.000Z',
        priorityStreak: 0,
        lastProgressAt: '2026-04-09T10:58:00.000Z',
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [
          {
            id: 'assign-retrying',
            threadId: 'thread-retrying',
            queueEntryIds: ['queue-retrying'],
            assigneeKind: 'worker',
            targetKind: 'existing-repo',
            newRepoName: null,
            workingDirectory:
              'C:\\Users\\Origin\\AppData\\Local\\Temp\\wah-wt-assign-retrying',
            workerRuntime: 'codex',
            workerModel: null,
            workerEffort: null,
            assigneeLabel: 'Worker Codex gpt-5.4 (xhigh)',
            writeScopes: ['src'],
            pid: 46588,
            startedAt: '2026-04-09T10:47:27.000Z',
            lastProgressAt: '2026-04-09T10:58:00.000Z',
            worktreePath:
              'C:\\Users\\Origin\\AppData\\Local\\Temp\\wah-wt-assign-retrying',
            worktreeBranch: 'wah-worker-assign-retrying',
            targetRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          },
        ],
      },
      queue: [
        {
          id: 'queue-retrying',
          threadId: 'thread-retrying',
          content: '続けてください',
          createdAt: '2026-04-09T10:36:04.000Z',
          processed: false,
          priority: 'normal',
        },
      ],
      meta: {
        'thread-retrying': {
          assigneeKind: 'manager',
          assigneeLabel: 'Manager gpt-5.4 (xhigh)',
          workerAgentId: 'assign-retrying',
          workerRuntimeState: 'manager-answering',
          workerRuntimeDetail:
            'Manager が worker の成果をレビューし、必要な反映と引き渡しを進めています。',
          workerWriteScopes: ['src'],
          workerLiveOutput: 'Manager が worker の成果を確認しています…',
          workerLiveAt: '2026-04-09T10:58:00.000Z',
        },
      },
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.uiState).toBe('ai-working');
    expect(views[0]?.isWorking).toBe(true);
  });

  it('treats a requeued needs-reply thread as queued instead of leaving it under user reply needed', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-requeued',
          title: '再投入済みの task',
          status: 'needs-reply',
          updatedAt: '2026-04-09T10:58:00.000Z',
          createdAt: '2026-04-09T10:40:00.000Z',
          messages: [
            {
              sender: 'user',
              content: '左端切れを直してください',
              at: '2026-04-09T10:40:00.000Z',
            },
            {
              sender: 'ai',
              content: '[Manager] Worker 隔離環境の作成に失敗しました',
              at: '2026-04-09T10:47:59.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'busy',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: 46588,
        currentQueueId: 'queue-working',
        startedAt: '2026-04-09T10:40:00.000Z',
        lastMessageAt: '2026-04-09T10:58:00.000Z',
        priorityStreak: 0,
        lastProgressAt: '2026-04-09T10:58:00.000Z',
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [
          {
            id: 'assign-working',
            threadId: 'thread-other',
            queueEntryIds: ['queue-working'],
            assigneeKind: 'worker',
            targetKind: 'existing-repo',
            newRepoName: null,
            workingDirectory:
              'C:\\Users\\Origin\\AppData\\Local\\Temp\\wah-wt-assign-working',
            workerRuntime: 'codex',
            workerModel: null,
            workerEffort: null,
            assigneeLabel: 'Worker Codex gpt-5.4 (xhigh)',
            writeScopes: ['src'],
            pid: 46588,
            startedAt: '2026-04-09T10:47:27.000Z',
            lastProgressAt: '2026-04-09T10:58:00.000Z',
            worktreePath:
              'C:\\Users\\Origin\\AppData\\Local\\Temp\\wah-wt-assign-working',
            worktreeBranch: 'wah-worker-assign-working',
            targetRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          },
        ],
      },
      queue: [
        {
          id: 'queue-requeued',
          threadId: 'thread-requeued',
          content: '左端切れを直してください',
          createdAt: '2026-04-09T10:40:31.000Z',
          processed: false,
          priority: 'normal',
        },
      ],
      meta: {
        'thread-requeued': {
          assigneeKind: 'worker',
          assigneeLabel: 'Worker Codex gpt-5.4 (xhigh)',
          workerRuntimeState: 'blocked-by-scope',
          workerRuntimeDetail:
            '別の worker agent と書き込み範囲が重なるため待機しています。',
          workerWriteScopes: ['src'],
          workerBlockedByThreadIds: ['thread-other'],
        },
      },
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.uiState).toBe('queued');
    expect(views[0]?.queueDepth).toBe(1);
    expect(views[0]?.isWorking).toBe(false);
  });

  it('maps runtime-error needs-reply threads to the error lane', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-runtime-error',
          title: 'runtime error task',
          status: 'needs-reply',
          updatedAt: '2026-04-09T10:58:00.000Z',
          createdAt: '2026-04-09T10:36:00.000Z',
          messages: [
            {
              sender: 'user',
              content: '続けてください',
              at: '2026-04-09T10:36:00.000Z',
            },
            {
              sender: 'ai',
              content: '[Manager error] Worker exited with code 1.',
              at: '2026-04-09T10:47:34.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-09T10:36:00.000Z',
        lastMessageAt: '2026-04-09T10:58:00.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [],
      // legacy persisted meta may already contain runtimeErrorMessage; keep
      // that test covered separately. For regression, also ensure that when
      // the persisted meta lacks runtimeErrorMessage but the final AI
      // message begins with the exact prefix, we still classify as error.
      meta: {
        'thread-runtime-error': {
          // runtimeErrorMessage intentionally omitted to simulate older
          // persisted state; include a minimal manager footprint so the
          // thread remains manager-owned and is included in views.
          managedRepoId: 'workspace-agent-hub',
        },
      },
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.uiState).toBe('error');
    expect(views[0]?.canonicalStateReason).toContain(
      'Worker exited with code 1'
    );
  });

  it('falls back to last AI message when meta.runtimeErrorMessage is absent but message starts with [Manager error]', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-legacy-error',
          title: 'legacy error task',
          status: 'needs-reply',
          updatedAt: '2026-04-09T10:58:00.000Z',
          createdAt: '2026-04-09T10:36:00.000Z',
          messages: [
            {
              sender: 'user',
              content: '続けてください',
              at: '2026-04-09T10:36:00.000Z',
            },
            {
              sender: 'ai',
              content: '[Manager error] Worker exited with code 1.',
              at: '2026-04-09T10:47:34.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-09T10:36:00.000Z',
        lastMessageAt: '2026-04-09T10:58:00.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [],
      meta: {
        'thread-legacy-error': {
          // minimal manager footprint to ensure inclusion in manager views
          managedRepoId: 'workspace-agent-hub',
        },
      },
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.uiState).toBe('error');
    expect(views[0]?.canonicalStateReason).toContain(
      'Worker exited with code 1'
    );
  });

  it('does not classify as error when final AI message does not start with the exact prefix [Manager error]', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-legacy-negative',
          title: 'legacy negative task',
          status: 'needs-reply',
          updatedAt: '2026-04-09T10:58:00.000Z',
          createdAt: '2026-04-09T10:36:00.000Z',
          messages: [
            {
              sender: 'user',
              content: '続けてください',
              at: '2026-04-09T10:36:00.000Z',
            },
            {
              sender: 'ai',
              // intentionally similar but NOT starting with the exact
              // '[Manager error]' prefix to lock the narrow heuristic.
              content: 'Manager error: Worker exited with code 1.',
              at: '2026-04-09T10:47:34.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-09T10:36:00.000Z',
        lastMessageAt: '2026-04-09T10:58:00.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [],
      meta: {
        'thread-legacy-negative': {
          // minimal manager footprint so the thread is considered manager-owned
          managedRepoId: 'workspace-agent-hub',
        },
      },
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.uiState).toBe('user-reply-needed');
    expect(views[0]?.canonicalStateReason).toBeNull();
  });

  it('orders queued threads by dispatch priority instead of newest update time', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-normal',
          title: '通常依頼',
          status: 'active',
          updatedAt: '2026-03-21T00:10:00.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'AA を進めてください',
              at: '2026-03-21T00:00:00.000Z',
            },
          ],
        },
        {
          id: 'thread-question',
          title: '質問',
          status: 'active',
          updatedAt: '2026-03-21T00:05:00.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'BB はどうなっていますか？',
              at: '2026-03-21T00:00:01.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-03-21T00:00:00.000Z',
        lastMessageAt: '2026-03-21T00:00:05.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [
        {
          id: 'queue-normal',
          threadId: 'thread-normal',
          content: 'AA を進めてください',
          createdAt: '2026-03-21T00:00:02.000Z',
          processed: false,
          priority: 'normal',
        },
        {
          id: 'queue-question',
          threadId: 'thread-question',
          content: 'BB はどうなっていますか？',
          createdAt: '2026-03-21T00:00:03.000Z',
          processed: false,
          priority: 'question',
        },
      ],
      meta: {},
    });

    expect(views[0]?.id).toBe('thread-question');
    expect(views[0]?.queuePriority).toBe('question');
    expect(views[1]?.id).toBe('thread-normal');
    expect(views[1]?.queuePriority).toBe('normal');
  });

  it('keeps the oldest normal backlog visible first once priority jumps hit the fairness cap', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-normal',
          title: '通常依頼',
          status: 'active',
          updatedAt: '2026-03-21T00:05:00.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'AA を進めてください',
              at: '2026-03-21T00:00:00.000Z',
            },
          ],
        },
        {
          id: 'thread-question',
          title: '質問',
          status: 'active',
          updatedAt: '2026-03-21T00:10:00.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'BB はどうなっていますか？',
              at: '2026-03-21T00:00:01.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-03-21T00:00:00.000Z',
        lastMessageAt: '2026-03-21T00:00:05.000Z',
        priorityStreak: 3,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [
        {
          id: 'queue-normal',
          threadId: 'thread-normal',
          content: 'AA を進めてください',
          createdAt: '2026-03-21T00:00:02.000Z',
          processed: false,
          priority: 'normal',
        },
        {
          id: 'queue-question',
          threadId: 'thread-question',
          content: 'BB はどうなっていますか？',
          createdAt: '2026-03-21T00:00:03.000Z',
          processed: false,
          priority: 'question',
        },
      ],
      meta: {},
    });

    expect(views[0]?.id).toBe('thread-normal');
    expect(views[0]?.queueOrder).toBe(0);
    expect(views[1]?.id).toBe('thread-question');
    expect(views[1]?.queueOrder).toBe(1);
  });

  it('builds parent and child graph links from derived work-item metadata', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-parent',
          title: '親作業',
          status: 'review',
          updatedAt: '2026-03-21T00:10:00.000Z',
          createdAt: '2026-03-21T00:00:00.000Z',
          messages: [
            {
              sender: 'ai',
              content: '完了報告です',
              at: '2026-03-21T00:10:00.000Z',
            },
          ],
        },
        {
          id: 'thread-child',
          title: '派生作業',
          status: 'waiting',
          updatedAt: '2026-03-21T00:12:00.000Z',
          createdAt: '2026-03-21T00:11:00.000Z',
          messages: [
            {
              sender: 'user',
              content: '追加依頼です',
              at: '2026-03-21T00:11:00.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-03-21T00:00:00.000Z',
        lastMessageAt: '2026-03-21T00:12:00.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [
        {
          id: 'queue-child',
          threadId: 'thread-child',
          content: '追加依頼です',
          createdAt: '2026-03-21T00:12:00.000Z',
          processed: false,
          priority: 'normal',
        },
      ],
      meta: {
        'thread-parent': {
          managedRepoId: 'workspace-agent-hub',
          managedRepoLabel: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          managedBaseBranch: 'main',
          managedVerifyCommand: 'npm run verify',
          requestedRunMode: 'read-only',
        },
        'thread-child': {
          derivedFromThreadIds: ['thread-parent'],
          managedRepoId: 'workspace-agent-hub',
          managedRepoLabel: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          managedBaseBranch: 'main',
          managedVerifyCommand: 'npm run verify',
          requestedRunMode: 'write',
        },
      },
    });

    const parent = views.find((view) => view.id === 'thread-parent');
    const child = views.find((view) => view.id === 'thread-child');

    expect(parent?.derivedFromThreadIds).toEqual([]);
    expect(parent?.derivedChildThreadIds).toEqual(['thread-child']);
    expect(child?.derivedFromThreadIds).toEqual(['thread-parent']);
    expect(child?.derivedChildThreadIds).toEqual([]);
  });

  it('does not surface plain waiting threads with no manager footprint as AI queue', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-dummy',
          title: 'x',
          status: 'waiting',
          updatedAt: '2026-03-29T01:10:13.388Z',
          createdAt: '2026-03-29T01:10:13.381Z',
          messages: [
            {
              sender: 'user',
              content: 'y',
              at: '2026-03-29T01:10:13.388Z',
            },
          ],
        },
        {
          id: 'thread-real',
          title: 'README 調査',
          status: 'waiting',
          updatedAt: '2026-03-31T00:00:00.000Z',
          createdAt: '2026-03-31T00:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'README を確認してください',
              at: '2026-03-31T00:00:00.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-03-31T00:00:00.000Z',
        lastMessageAt: '2026-03-31T00:00:00.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [
        {
          id: 'queue-real',
          threadId: 'thread-real',
          content: 'README を確認してください',
          createdAt: '2026-03-31T00:00:01.000Z',
          processed: false,
          priority: 'normal',
        },
      ],
      meta: {},
    });

    expect(views.map((view) => view.id)).toEqual(['thread-real']);
    expect(views[0]?.uiState).toBe('queued');
  });

  it('marks manager-owned waiting topics with only continuity metadata as stalled instead of queued', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-continuity-only',
          title: 'Markdown 表示改善',
          status: 'waiting',
          updatedAt: '2026-04-09T08:02:37.661Z',
          createdAt: '2026-04-09T08:02:37.655Z',
          messages: [
            {
              sender: 'user',
              content: '返信を見やすくしてほしい',
              at: '2026-04-09T08:02:37.661Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-09T08:02:37.655Z',
        lastMessageAt: '2026-04-09T08:02:37.661Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [],
      meta: {
        'thread-continuity-only': {
          managedRepoId: 'workspace-agent-hub',
          managedRepoLabel: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          managedBaseBranch: 'main',
          managedVerifyCommand: 'npm run verify',
          requestedWorkerRuntime: 'codex',
          workerSessionId: 'session-123',
          workerLastStartedAt: '2026-04-09T10:07:48.298Z',
        },
      },
    });

    expect(views).toHaveLength(1);
    expect(views[0]?.id).toBe('thread-continuity-only');
    expect(views[0]?.uiState).toBe('stalled');
  });

  it('persists canonical stalled state and reason for stranded waiting topics', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wah-thread-state-'));
    try {
      await writeManagerThreadMeta(tempDir, {
        'thread-stalled': {
          managedRepoId: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          requestedWorkerRuntime: 'codex',
        },
      });

      const threads = [
        {
          id: 'thread-stalled',
          title: '取り残し topic',
          status: 'waiting' as const,
          updatedAt: '2026-04-14T00:00:05.000Z',
          createdAt: '2026-04-14T00:00:00.000Z',
          messages: [
            {
              sender: 'user' as const,
              content: 'この続きも処理してほしい',
              at: '2026-04-14T00:00:05.000Z',
            },
          ],
        },
      ];
      const session = {
        workspaceKey: 'workspace',
        status: 'idle' as const,
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-14T00:00:00.000Z',
        lastMessageAt: '2026-04-14T00:00:05.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      };

      const reconciled = await reconcileManagerThreadMeta({
        dir: tempDir,
        threads,
        session,
        queue: [],
      });
      const views = deriveManagerThreadViews({
        threads,
        session,
        queue: [],
        meta: reconciled,
      });

      expect(reconciled['thread-stalled']?.canonicalState).toBe('stalled');
      expect(reconciled['thread-stalled']?.canonicalStateReason).toContain(
        '取り残し状態'
      );
      expect(views[0]?.uiState).toBe('stalled');
      expect(views[0]?.canonicalStateReason).toContain('取り残し状態');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('surfaces pending AI reply recovery metadata as stalled detail', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wah-thread-state-'));
    try {
      await writeManagerThreadMeta(tempDir, {
        'thread-pending-reply': {
          managedRepoId: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          pendingReplyStatus: 'review',
          pendingReplyContent: '保存待ちの review reply',
          pendingReplyAt: '2026-04-14T00:00:08.000Z',
        },
      });

      const threads = [
        {
          id: 'thread-pending-reply',
          title: '保存失敗 topic',
          status: 'waiting' as const,
          updatedAt: '2026-04-14T00:00:08.000Z',
          createdAt: '2026-04-14T00:00:00.000Z',
          messages: [
            {
              sender: 'user' as const,
              content: 'review 結果をください',
              at: '2026-04-14T00:00:08.000Z',
            },
          ],
        },
      ];
      const session = {
        workspaceKey: 'workspace',
        status: 'idle' as const,
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-14T00:00:00.000Z',
        lastMessageAt: '2026-04-14T00:00:08.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      };

      const reconciled = await reconcileManagerThreadMeta({
        dir: tempDir,
        threads,
        session,
        queue: [],
      });
      const views = deriveManagerThreadViews({
        threads,
        session,
        queue: [],
        meta: reconciled,
      });

      expect(reconciled['thread-pending-reply']?.canonicalState).toBe(
        'stalled'
      );
      expect(
        reconciled['thread-pending-reply']?.canonicalStateReason
      ).toContain('thread への保存に失敗');
      expect(views[0]?.pendingReplyAt).toBe('2026-04-14T00:00:08.000Z');
      expect(views[0]?.canonicalStateReason).toContain('thread への保存に失敗');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('excludes non-manager threads even when their statuses would otherwise map into manager buckets', () => {
    const views = deriveManagerThreadViews({
      threads: [
        {
          id: 'thread-direct-waiting',
          title: '個別エージェントの相談',
          status: 'waiting',
          updatedAt: '2026-04-11T11:30:00.000Z',
          createdAt: '2026-04-11T11:00:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'manager とは別件で相談したい',
              at: '2026-04-11T11:00:00.000Z',
            },
            {
              sender: 'ai',
              content: 'この thread は direct mode の bookkeeping です',
              at: '2026-04-11T11:30:00.000Z',
            },
          ],
        },
        {
          id: 'thread-direct-review',
          title: '別 repo の確認',
          status: 'review',
          updatedAt: '2026-04-11T11:31:00.000Z',
          createdAt: '2026-04-11T11:01:00.000Z',
          messages: [
            {
              sender: 'user',
              content: '通常会話のレビュー',
              at: '2026-04-11T11:01:00.000Z',
            },
            {
              sender: 'ai',
              content: 'manager 所有ではない完了報告',
              at: '2026-04-11T11:31:00.000Z',
            },
          ],
        },
        {
          id: 'thread-manager-review',
          title: 'manager 管理の作業',
          status: 'review',
          updatedAt: '2026-04-11T11:32:00.000Z',
          createdAt: '2026-04-11T11:02:00.000Z',
          messages: [
            {
              sender: 'user',
              content: 'manager で直してください',
              at: '2026-04-11T11:02:00.000Z',
            },
            {
              sender: 'ai',
              content: 'manager 側の作業結果です',
              at: '2026-04-11T11:32:00.000Z',
            },
          ],
        },
      ],
      session: {
        workspaceKey: 'workspace',
        status: 'idle',
        sessionId: 'codex-thread',
        routingSessionId: null,
        pid: null,
        currentQueueId: null,
        startedAt: '2026-04-11T11:00:00.000Z',
        lastMessageAt: '2026-04-11T11:32:00.000Z',
        priorityStreak: 0,
        lastProgressAt: null,
        lastErrorMessage: null,
        lastErrorAt: null,
        lastPauseMessage: null,
        lastPauseAt: null,
        activeAssignments: [],
      },
      queue: [],
      meta: {
        'thread-manager-review': {
          managedRepoId: 'workspace-agent-hub',
          managedRepoLabel: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          managedBaseBranch: 'main',
          managedVerifyCommand: 'npm run verify',
          requestedRunMode: 'write',
        },
      },
    });

    expect(views.map((view) => view.id)).toEqual(['thread-manager-review']);
    expect(views[0]?.uiState).toBe('ai-finished-awaiting-user-confirmation');
  });

  it('reconciles stale runtime metadata when no queue or active assignment remains', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wah-thread-state-'));
    try {
      await writeManagerThreadMeta(tempDir, {
        ghost: {
          managedRepoId: 'workspace-agent-hub',
          managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
          requestedWorkerRuntime: 'codex',
          assigneeKind: 'worker',
          assigneeLabel: 'Worker Codex gpt-5.4 (xhigh)',
          workerAgentId: 'assign_q_ghost',
          workerWriteScopes: ['src'],
          workerLiveOutput: 'still running...',
          workerLiveAt: '2026-04-09T10:30:00.000Z',
        },
      });

      const reconciled = await reconcileManagerThreadMeta({
        dir: tempDir,
        threads: [],
        session: {
          workspaceKey: 'workspace',
          status: 'idle',
          sessionId: 'codex-thread',
          routingSessionId: null,
          pid: null,
          currentQueueId: null,
          startedAt: '2026-04-09T10:00:00.000Z',
          lastMessageAt: '2026-04-09T10:30:00.000Z',
          priorityStreak: 0,
          lastProgressAt: null,
          lastErrorMessage: null,
          lastErrorAt: null,
          lastPauseMessage: null,
          lastPauseAt: null,
          activeAssignments: [],
        },
        queue: [],
      });

      expect(reconciled['ghost']).toEqual({
        managedRepoId: 'workspace-agent-hub',
        managedRepoRoot: 'D:\\ghws\\workspace-agent-hub',
        requestedWorkerRuntime: 'codex',
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
