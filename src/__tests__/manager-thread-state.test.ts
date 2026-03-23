import { describe, expect, it } from 'vitest';
import { deriveManagerThreadViews } from '../manager-thread-state.js';

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
      },
      queue: [],
      meta: {},
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
      },
      queue: [],
      meta: {
        'thread-child': {
          derivedFromThreadIds: ['thread-parent'],
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
});
