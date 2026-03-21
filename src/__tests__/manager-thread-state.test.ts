import { describe, expect, it } from 'vitest';
import { deriveManagerThreadViews } from '../manager-thread-state.js';

describe('manager thread state derivation', () => {
  it('keeps active AI-owned threads in the working bucket instead of confirmation-waiting', () => {
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
    expect(views[0]?.uiState).toBe('ai-working');
  });
});
