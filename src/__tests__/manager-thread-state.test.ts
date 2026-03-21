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
      },
      queue: [
        {
          id: 'queue-working',
          threadId: 'thread-working',
          content: 'AAして',
          createdAt: '2026-03-21T00:00:02.000Z',
          processed: false,
        },
        {
          id: 'queue-queued',
          threadId: 'thread-queued',
          content: 'BBして',
          createdAt: '2026-03-21T00:00:03.000Z',
          processed: false,
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
});
