import { extractManagerMessagePlainText } from './manager-message.js';

export type ManagerQueuePriority = 'explicit-priority' | 'question' | 'normal';

export interface QueuePriorityEntryLike {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
  processed: boolean;
  priority?: ManagerQueuePriority | null;
}

export interface QueuePrioritySessionLike {
  priorityStreak?: number | null;
}

export interface QueueBatchPlan<T extends QueuePriorityEntryLike> {
  startIndex: number;
  entries: T[];
  threadId: string;
  priority: ManagerQueuePriority;
  createdAt: string;
}

export const MAX_PRIORITY_STREAK = 3;

const PRIORITY_RANK: Record<ManagerQueuePriority, number> = {
  'explicit-priority': 0,
  question: 1,
  normal: 2,
};

const EXPLICIT_PRIORITY_PATTERNS = [
  /最優先/,
  /優先(?:して|で|的に|的|対応|実行|処理|回答|返信|お願い)/,
  /優先順位(?:を)?(?:上げ|高く|先に)/,
  /先に(?:答え|見|対応|や|処理|進め|お願いします|して)/,
  /急ぎ/,
  /至急/,
  /\basap\b/i,
  /\burgent\b/i,
];

const QUESTION_PATTERNS = [
  /[\?？]/,
  /(?:です|ます|でした|ました|でしょう)?か(?:\s|$)/,
  /^(?:何|なに|どう|どこ|いつ|なぜ|どうして|なんで|どれ)\b/,
  /\b(?:what|why|how|when|where|which)\b/i,
  /教えて/,
  /どうなって(?:います|る|た)/,
  /確認できますか/,
  /わかりますか/,
  /できますか/,
  /でしょうか/,
];

function timestampOrMax(value: string): number {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? Number.MAX_SAFE_INTEGER : timestamp;
}

function compareCreatedAt(left: string, right: string): number {
  return timestampOrMax(left) - timestampOrMax(right);
}

function compareBatches<T extends QueuePriorityEntryLike>(
  left: QueueBatchPlan<T>,
  right: QueueBatchPlan<T>
): number {
  const leftRank = PRIORITY_RANK[left.priority];
  const rightRank = PRIORITY_RANK[right.priority];
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const dateDiff = compareCreatedAt(left.createdAt, right.createdAt);
  if (dateDiff !== 0) {
    return dateDiff;
  }

  return left.startIndex - right.startIndex;
}

function batchPriority<T extends QueuePriorityEntryLike>(
  entries: T[]
): ManagerQueuePriority {
  let best: ManagerQueuePriority = 'normal';
  for (const entry of entries) {
    const priority = getManagerQueuePriority(entry);
    if (PRIORITY_RANK[priority] < PRIORITY_RANK[best]) {
      best = priority;
    }
  }
  return best;
}

export function parseManagerQueuePriority(
  value: unknown
): ManagerQueuePriority | null {
  return value === 'explicit-priority' ||
    value === 'question' ||
    value === 'normal'
    ? value
    : null;
}

export function detectManagerQueuePriority(
  content: string
): ManagerQueuePriority {
  const text = extractManagerMessagePlainText(content).trim().toLowerCase();
  if (!text) {
    return 'normal';
  }

  if (EXPLICIT_PRIORITY_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'explicit-priority';
  }

  if (QUESTION_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'question';
  }

  return 'normal';
}

export function getManagerQueuePriority<T extends QueuePriorityEntryLike>(
  entry: T
): ManagerQueuePriority {
  return (
    parseManagerQueuePriority(entry.priority) ??
    detectManagerQueuePriority(entry.content)
  );
}

export function normalizeManagerQueueEntry<T extends QueuePriorityEntryLike>(
  entry: T
): T & { priority: ManagerQueuePriority } {
  return {
    ...entry,
    priority: getManagerQueuePriority(entry),
  };
}

export function collectContiguousQueueBatch<T extends QueuePriorityEntryLike>(
  queue: T[],
  startIndex: number
): T[] {
  const first = queue[startIndex];
  if (!first || first.processed) {
    return [];
  }

  const batch = [first];
  for (let index = startIndex + 1; index < queue.length; index += 1) {
    const candidate = queue[index];
    if (
      !candidate ||
      candidate.processed ||
      candidate.threadId !== first.threadId
    ) {
      break;
    }
    batch.push(candidate);
  }
  return batch;
}

export function buildPendingQueueBatches<T extends QueuePriorityEntryLike>(
  queue: T[]
): QueueBatchPlan<T>[] {
  const batches: QueueBatchPlan<T>[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const entry = queue[index];
    if (!entry || entry.processed) {
      continue;
    }

    const entries = collectContiguousQueueBatch(queue, index);
    if (entries.length === 0) {
      continue;
    }

    batches.push({
      startIndex: index,
      entries,
      threadId: entry.threadId,
      priority: batchPriority(entries),
      createdAt: entry.createdAt,
    });
    index += entries.length - 1;
  }
  return batches;
}

export function chooseNextQueueBatch<T extends QueuePriorityEntryLike>(
  queue: T[],
  session: QueuePrioritySessionLike
): QueueBatchPlan<T> | null {
  const batches = buildPendingQueueBatches(queue);
  if (batches.length === 0) {
    return null;
  }

  const streak = Math.max(0, session.priorityStreak ?? 0);
  const hasNormal = batches.some((batch) => batch.priority === 'normal');
  const hasPriority = batches.some((batch) => batch.priority !== 'normal');

  if (streak >= MAX_PRIORITY_STREAK && hasNormal && hasPriority) {
    return (
      batches
        .filter((batch) => batch.priority === 'normal')
        .reduce((best, candidate) =>
          compareBatches(candidate, best) < 0 ? candidate : best
        ) ?? null
    );
  }

  return batches.reduce((best, candidate) =>
    compareBatches(candidate, best) < 0 ? candidate : best
  );
}

export function advanceManagerQueuePriorityStreak(
  currentStreak: number,
  dispatchedPriority: ManagerQueuePriority,
  remainingQueue: QueuePriorityEntryLike[]
): number {
  if (dispatchedPriority === 'normal') {
    return 0;
  }

  const remainingHasNormal = buildPendingQueueBatches(remainingQueue).some(
    (batch) => batch.priority === 'normal'
  );
  return remainingHasNormal ? currentStreak + 1 : 0;
}

export function buildQueueDispatchPlan<T extends QueuePriorityEntryLike>(
  queue: T[],
  session: QueuePrioritySessionLike
): Array<QueueBatchPlan<T> & { order: number }> {
  let remaining = queue.filter((entry) => !entry.processed);
  let streak = Math.max(0, session.priorityStreak ?? 0);
  const plan: Array<QueueBatchPlan<T> & { order: number }> = [];

  while (remaining.length > 0) {
    const next = chooseNextQueueBatch(remaining, {
      priorityStreak: streak,
    });
    if (!next) {
      break;
    }

    plan.push({
      ...next,
      order: plan.length,
    });

    const selectedIds = new Set(next.entries.map((entry) => entry.id));
    const nextRemaining = remaining.filter(
      (entry) => !selectedIds.has(entry.id)
    );
    streak = advanceManagerQueuePriorityStreak(
      streak,
      next.priority,
      nextRemaining
    );
    remaining = nextRemaining;
  }

  return plan;
}
