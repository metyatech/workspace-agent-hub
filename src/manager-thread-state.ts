import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { Thread } from '@metyatech/thread-inbox';
import type { QueueEntry, ManagerSession } from './manager-backend.js';

export const MANAGER_THREAD_META_FILE =
  '.workspace-agent-hub-manager-thread-meta.json';

export type ManagerUiState =
  | 'routing-confirmation-needed'
  | 'user-reply-needed'
  | 'ai-finished-awaiting-user-confirmation'
  | 'queued'
  | 'ai-working'
  | 'done';

export interface ManagerThreadMeta {
  routingConfirmationNeeded?: boolean;
  routingHint?: string | null;
  lastRoutingAt?: string | null;
}

export interface ManagerThreadView extends Thread {
  uiState: ManagerUiState;
  previewText: string;
  lastSender: 'ai' | 'user' | null;
  hiddenByDefault: boolean;
  routingConfirmationNeeded: boolean;
  routingHint: string | null;
  queueDepth: number;
  isWorking: boolean;
}

type ManagerThreadMetaMap = Record<string, ManagerThreadMeta>;

function atomicTmpPath(filePath: string): string {
  return `${filePath}.tmp`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = atomicTmpPath(filePath);
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, filePath);
}

export function managerThreadMetaFilePath(dir: string): string {
  return join(resolvePath(dir), MANAGER_THREAD_META_FILE);
}

export async function readManagerThreadMeta(
  dir: string
): Promise<ManagerThreadMetaMap> {
  const filePath = managerThreadMetaFilePath(dir);
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    if (!content.trim()) {
      return {};
    }
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed as ManagerThreadMetaMap;
  } catch {
    return {};
  }
}

export async function writeManagerThreadMeta(
  dir: string,
  meta: ManagerThreadMetaMap
): Promise<void> {
  const filePath = managerThreadMetaFilePath(dir);
  await atomicWrite(filePath, JSON.stringify(meta, null, 2));
}

export async function updateManagerThreadMeta(
  dir: string,
  threadId: string,
  updater: (current: ManagerThreadMeta | null) => ManagerThreadMeta | null
): Promise<void> {
  const current = await readManagerThreadMeta(dir);
  const nextEntry = updater(current[threadId] ?? null);
  if (nextEntry) {
    current[threadId] = nextEntry;
  } else {
    delete current[threadId];
  }
  await writeManagerThreadMeta(dir, current);
}

export async function clearManagerThreadMeta(
  dir: string,
  threadId: string
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, () => null);
}

function lastSender(thread: Thread): 'ai' | 'user' | null {
  const lastMessage = thread.messages.at(-1);
  return lastMessage?.sender ?? null;
}

function previewText(thread: Thread): string {
  const lastMessage = thread.messages.at(-1);
  if (!lastMessage) {
    return 'まだやり取りはありません';
  }
  const senderLabel = lastMessage.sender === 'ai' ? '[ai]' : '[user]';
  return `${senderLabel} ${lastMessage.content.replace(/\s+/g, ' ').trim()}`;
}

function deriveUiState(input: {
  thread: Thread;
  meta: ManagerThreadMeta | null;
  queueDepth: number;
  isWorking: boolean;
}): ManagerUiState {
  if (input.thread.status === 'resolved') {
    return 'done';
  }

  if (input.meta?.routingConfirmationNeeded) {
    return 'routing-confirmation-needed';
  }

  if (input.thread.status === 'needs-reply') {
    return 'user-reply-needed';
  }

  if (input.thread.status === 'review') {
    return 'ai-finished-awaiting-user-confirmation';
  }

  if (input.isWorking) {
    return 'ai-working';
  }

  if (input.thread.status === 'waiting' || input.queueDepth > 0) {
    return 'queued';
  }

  if (lastSender(input.thread) === 'ai') {
    return 'ai-finished-awaiting-user-confirmation';
  }

  return 'queued';
}

function compareByPriority(
  left: ManagerThreadView,
  right: ManagerThreadView
): number {
  const priority: Record<ManagerUiState, number> = {
    'routing-confirmation-needed': 0,
    'user-reply-needed': 1,
    'ai-finished-awaiting-user-confirmation': 2,
    queued: 3,
    'ai-working': 4,
    done: 5,
  };

  const leftPriority = priority[left.uiState];
  const rightPriority = priority[right.uiState];
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return (
    new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

export function deriveManagerThreadViews(input: {
  threads: Thread[];
  session: ManagerSession;
  queue: QueueEntry[];
  meta: ManagerThreadMetaMap;
}): ManagerThreadView[] {
  const currentQueueEntry =
    input.session.currentQueueId === null
      ? null
      : (input.queue.find(
          (entry) => entry.id === input.session.currentQueueId
        ) ?? null);

  const pendingQueueDepth = new Map<string, number>();
  for (const entry of input.queue) {
    if (entry.processed) {
      continue;
    }
    pendingQueueDepth.set(
      entry.threadId,
      (pendingQueueDepth.get(entry.threadId) ?? 0) + 1
    );
  }

  const views = input.threads.map((thread) => {
    const meta = input.meta[thread.id] ?? null;
    const queueDepth = pendingQueueDepth.get(thread.id) ?? 0;
    const isWorking =
      currentQueueEntry?.threadId === thread.id &&
      input.session.status === 'busy';
    const uiState = deriveUiState({
      thread,
      meta,
      queueDepth,
      isWorking,
    });

    return {
      ...thread,
      uiState,
      previewText: previewText(thread),
      lastSender: lastSender(thread),
      hiddenByDefault: uiState === 'done',
      routingConfirmationNeeded: Boolean(meta?.routingConfirmationNeeded),
      routingHint: meta?.routingHint ?? null,
      queueDepth,
      isWorking,
    } satisfies ManagerThreadView;
  });

  return views.sort(compareByPriority);
}
