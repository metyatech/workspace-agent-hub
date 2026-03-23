import { describe, expect, it } from 'vitest';
import {
  MAX_PRIORITY_STREAK,
  buildQueueDispatchPlan,
  detectManagerQueuePriority,
} from '../manager-queue-priority.js';

function makeEntry(input: {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
}) {
  return {
    ...input,
    processed: false,
  };
}

describe('manager queue priority scheduling', () => {
  it('detects explicit priority requests, questions, and normal work separately', () => {
    expect(detectManagerQueuePriority('この件は優先的にやってください。')).toBe(
      'explicit-priority'
    );
    expect(detectManagerQueuePriority('この件はどうなっていますか')).toBe(
      'question'
    );
    expect(detectManagerQueuePriority('AA を進めてください')).toBe('normal');
  });

  it('dispatches explicit-priority then questions before normal FIFO work', () => {
    const plan = buildQueueDispatchPlan(
      [
        makeEntry({
          id: 'q-normal-1',
          threadId: 'thread-normal-1',
          content: 'AA を進めてください',
          createdAt: '2026-03-21T00:00:00.000Z',
        }),
        makeEntry({
          id: 'q-question-1',
          threadId: 'thread-question-1',
          content: 'BB の状況はどうなっていますか？',
          createdAt: '2026-03-21T00:01:00.000Z',
        }),
        makeEntry({
          id: 'q-priority-1',
          threadId: 'thread-priority-1',
          content: 'この件は優先的に対応してください。',
          createdAt: '2026-03-21T00:02:00.000Z',
        }),
        makeEntry({
          id: 'q-question-2',
          threadId: 'thread-question-2',
          content: 'CC はどうなっていますか？',
          createdAt: '2026-03-21T00:03:00.000Z',
        }),
      ],
      {
        priorityStreak: 0,
      }
    );

    expect(
      plan.map((step) => [step.threadId, step.priority, step.order])
    ).toEqual([
      ['thread-priority-1', 'explicit-priority', 0],
      ['thread-question-1', 'question', 1],
      ['thread-question-2', 'question', 2],
      ['thread-normal-1', 'normal', 3],
    ]);
  });

  it('forces the oldest normal backlog item through after repeated priority jumps', () => {
    const plan = buildQueueDispatchPlan(
      [
        makeEntry({
          id: 'q-normal',
          threadId: 'thread-normal',
          content: 'DD を実装してください',
          createdAt: '2026-03-21T00:00:00.000Z',
        }),
        makeEntry({
          id: 'q-question',
          threadId: 'thread-question',
          content: 'EE はどうなっていますか？',
          createdAt: '2026-03-21T00:01:00.000Z',
        }),
      ],
      {
        priorityStreak: MAX_PRIORITY_STREAK,
      }
    );

    expect(plan[0]?.threadId).toBe('thread-normal');
    expect(plan[1]?.threadId).toBe('thread-question');
  });
});
