import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { Thread } from '@metyatech/thread-inbox';
import type { QueueEntry, ManagerSession } from './manager-backend.js';
import { writeFileAtomically } from './atomic-file.js';
import {
  buildQueueDispatchPlan,
  type ManagerQueuePriority,
} from './manager-queue-priority.js';
import { summarizeManagerMessage } from './manager-message.js';
import { notifyManagerUpdate } from './manager-live-updates.js';
import type {
  ManagerRunMode,
  ManagerTargetKind,
  ManagerWorkerRuntime,
} from './manager-repos.js';

export const MANAGER_THREAD_META_FILE =
  '.workspace-agent-hub-manager-thread-meta.json';

export type ManagerUiState =
  | 'routing-confirmation-needed'
  | 'user-reply-needed'
  | 'ai-finished-awaiting-user-confirmation'
  | 'queued'
  | 'ai-working'
  | 'cancelled-as-superseded'
  | 'done';

export type ManagerWorkerRuntimeState =
  | 'manager-answering'
  | 'manager-recovery'
  | 'worker-running'
  | 'blocked-by-scope'
  | 'cancelled-as-superseded';

export interface ManagerWorkerLiveEntry {
  at: string;
  text: string;
  kind: 'status' | 'output' | 'error';
}

export interface ManagerThreadMeta {
  managerOwned?: boolean;
  routingConfirmationNeeded?: boolean;
  routingHint?: string | null;
  derivedFromThreadIds?: string[] | null;
  lastRoutingAt?: string | null;
  managedRepoId?: string | null;
  managedRepoLabel?: string | null;
  managedRepoRoot?: string | null;
  repoTargetKind?: ManagerTargetKind | null;
  newRepoName?: string | null;
  newRepoRoot?: string | null;
  managedBaseBranch?: string | null;
  managedVerifyCommand?: string | null;
  requestedWorkerRuntime?: ManagerWorkerRuntime | null;
  requestedRunMode?: ManagerRunMode | null;
  workerSessionId?: string | null;
  workerSessionRuntime?: ManagerWorkerRuntime | null;
  workerSessionModel?: string | null;
  workerSessionEffort?: string | null;
  pausedAssignmentId?: string | null;
  pausedWorktreePath?: string | null;
  pausedWorktreeBranch?: string | null;
  pausedTargetRepoRoot?: string | null;
  workerLastStartedAt?: string | null;
  assigneeKind?: 'manager' | 'worker' | null;
  assigneeLabel?: string | null;
  workerAgentId?: string | null;
  workerRuntimeState?: ManagerWorkerRuntimeState | null;
  workerRuntimeDetail?: string | null;
  workerWriteScopes?: string[] | null;
  workerBlockedByThreadIds?: string[] | null;
  supersededByThreadId?: string | null;
  workerLiveLog?: ManagerWorkerLiveEntry[] | null;
  workerLiveOutput?: string | null;
  workerLiveAt?: string | null;
  seedRecoveryPending?: boolean;
  seedRecoveryRepoRoot?: string | null;
  seedRecoveryRepoLabel?: string | null;
  seedRecoveryChangedFiles?: string[] | null;
  consecutiveFailures?: number;
  nextRetryAfter?: string | null;
}

export interface ManagerThreadView extends Thread {
  uiState: ManagerUiState;
  previewText: string;
  lastSender: 'ai' | 'user' | null;
  hiddenByDefault: boolean;
  routingConfirmationNeeded: boolean;
  routingHint: string | null;
  derivedFromThreadIds: string[];
  derivedChildThreadIds: string[];
  managedRepoId: string | null;
  managedRepoLabel: string | null;
  managedRepoRoot: string | null;
  repoTargetKind: ManagerTargetKind | null;
  newRepoName: string | null;
  newRepoRoot: string | null;
  managedBaseBranch: string | null;
  managedVerifyCommand: string | null;
  requestedWorkerRuntime: ManagerWorkerRuntime | null;
  requestedRunMode: ManagerRunMode | null;
  queueDepth: number;
  isWorking: boolean;
  queueOrder: number | null;
  queuePriority: ManagerQueuePriority | null;
  assigneeKind: 'manager' | 'worker' | null;
  assigneeLabel: string | null;
  workerAgentId: string | null;
  workerRuntimeState: ManagerWorkerRuntimeState | null;
  workerRuntimeDetail: string | null;
  workerWriteScopes: string[];
  workerBlockedByThreadIds: string[];
  supersededByThreadId: string | null;
  workerLiveLog: ManagerWorkerLiveEntry[];
  workerLiveOutput: string | null;
  workerLiveAt: string | null;
  seedRecoveryPending: boolean;
  seedRecoveryRepoRoot: string | null;
  seedRecoveryRepoLabel: string | null;
  seedRecoveryChangedFiles: string[];
}

type ManagerThreadMetaMap = Record<string, ManagerThreadMeta>;

const metaWriteLocks = new Map<string, Promise<void>>();

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await writeFileAtomically(filePath, content);
}

async function withMetaWriteLock<T>(
  dir: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = resolvePath(dir);
  const previous = metaWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  metaWriteLocks.set(key, gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (metaWriteLocks.get(key) === gate) {
      metaWriteLocks.delete(key);
    }
  }
}

async function readManagerThreadMetaFile(
  filePath: string
): Promise<ManagerThreadMetaMap> {
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

export function managerThreadMetaFilePath(dir: string): string {
  return join(resolvePath(dir), MANAGER_THREAD_META_FILE);
}

export async function readManagerThreadMeta(
  dir: string
): Promise<ManagerThreadMetaMap> {
  return readManagerThreadMetaFile(managerThreadMetaFilePath(dir));
}

export async function writeManagerThreadMeta(
  dir: string,
  meta: ManagerThreadMetaMap
): Promise<void> {
  const filePath = managerThreadMetaFilePath(dir);
  await withMetaWriteLock(dir, () =>
    atomicWrite(filePath, JSON.stringify(meta, null, 2))
  );
  notifyManagerUpdate(dir);
}

export async function reconcileManagerThreadMeta(input: {
  dir: string;
  session: ManagerSession;
  queue: QueueEntry[];
  meta?: ManagerThreadMetaMap;
}): Promise<ManagerThreadMetaMap> {
  const current = input.meta ?? (await readManagerThreadMeta(input.dir));
  const activeThreadIds = new Set(
    (input.session.activeAssignments ?? []).map(
      (assignment) => assignment.threadId
    )
  );
  const pendingThreadIds = new Set(
    input.queue
      .filter((entry) => !entry.processed)
      .map((entry) => entry.threadId)
  );

  let changed = false;
  const nextEntries = Object.entries(current).flatMap(([threadId, meta]) => {
    if (
      activeThreadIds.has(threadId) ||
      pendingThreadIds.has(threadId) ||
      !hasManagerRuntimeFootprint(meta)
    ) {
      return [[threadId, meta] as const];
    }

    changed = true;
    const cleaned = stripManagerRuntimeStatePreservingContinuity(meta);
    return cleaned ? [[threadId, cleaned] as const] : [];
  });

  if (!changed) {
    return current;
  }

  const next = Object.fromEntries(nextEntries);
  await writeManagerThreadMeta(input.dir, next);
  return next;
}

export async function updateManagerThreadMeta(
  dir: string,
  threadId: string,
  updater: (current: ManagerThreadMeta | null) => ManagerThreadMeta | null
): Promise<void> {
  const filePath = managerThreadMetaFilePath(dir);
  await withMetaWriteLock(dir, async () => {
    const current = await readManagerThreadMetaFile(filePath);
    const nextEntry = updater(current[threadId] ?? null);
    if (nextEntry) {
      current[threadId] = nextEntry;
    } else {
      delete current[threadId];
    }
    await atomicWrite(filePath, JSON.stringify(current, null, 2));
  });
  notifyManagerUpdate(dir);
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
  return `${senderLabel} ${summarizeManagerMessage(lastMessage.content, 140)}`;
}

function normalizeDerivedFromThreadIds(
  value: string[] | null | undefined
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
    )
  );
}

function normalizeWorkerRuntimeState(
  value: unknown
): ManagerWorkerRuntimeState | null {
  if (
    value === 'manager-answering' ||
    value === 'manager-recovery' ||
    value === 'worker-running' ||
    value === 'blocked-by-scope' ||
    value === 'cancelled-as-superseded'
  ) {
    return value;
  }
  return null;
}

function normalizeManagedRepoText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeManagerTargetKind(value: unknown): ManagerTargetKind | null {
  return value === 'existing-repo' || value === 'new-repo' ? value : null;
}

function normalizeRequestedWorkerRuntime(
  value: unknown
): ManagerWorkerRuntime | null {
  return value === 'codex' ||
    value === 'claude' ||
    value === 'gemini' ||
    value === 'copilot'
    ? value
    : null;
}

function normalizeRequestedRunMode(value: unknown): ManagerRunMode | null {
  return value === 'read-only' || value === 'write' ? value : null;
}

function normalizeWorkerLiveLog(value: unknown): ManagerWorkerLiveEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const at = typeof record['at'] === 'string' ? record['at'].trim() : '';
    const text =
      typeof record['text'] === 'string' ? record['text'].trim() : '';
    const kind =
      record['kind'] === 'status' ||
      record['kind'] === 'output' ||
      record['kind'] === 'error'
        ? record['kind']
        : 'output';
    if (!at || !text) {
      return [];
    }

    return [{ at, text, kind } satisfies ManagerWorkerLiveEntry];
  });
}

function managerMetaValueHasContent(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) =>
      typeof entry === 'string' ? entry.trim().length > 0 : Boolean(entry)
    );
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return value > 0;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return value != null;
}

function managerThreadMetaHasContent(meta: ManagerThreadMeta | null): boolean {
  if (!meta) {
    return false;
  }
  return Object.values(meta).some((value) => managerMetaValueHasContent(value));
}

function hasManagerRuntimeFootprint(meta: ManagerThreadMeta | null): boolean {
  if (!meta) {
    return false;
  }

  return [
    meta.assigneeKind,
    meta.assigneeLabel,
    meta.workerAgentId,
    meta.workerRuntimeState,
    meta.workerRuntimeDetail,
    meta.workerWriteScopes,
    meta.workerBlockedByThreadIds,
    meta.supersededByThreadId,
    meta.workerLiveLog,
    meta.workerLiveOutput,
    meta.workerLiveAt,
  ].some((value) => managerMetaValueHasContent(value));
}

export function stripManagerRuntimeStatePreservingContinuity(
  meta: ManagerThreadMeta | null
): ManagerThreadMeta | null {
  if (!meta) {
    return null;
  }

  const next: ManagerThreadMeta = { ...meta };
  delete next.assigneeKind;
  delete next.assigneeLabel;
  delete next.workerAgentId;
  delete next.workerRuntimeState;
  delete next.workerRuntimeDetail;
  delete next.workerWriteScopes;
  delete next.workerBlockedByThreadIds;
  delete next.supersededByThreadId;
  delete next.workerLiveLog;
  delete next.workerLiveOutput;
  delete next.workerLiveAt;
  delete next.consecutiveFailures;
  delete next.nextRetryAfter;

  return managerThreadMetaHasContent(next) ? next : null;
}

function shouldIncludeInManagerThreadViews(input: {
  thread: Thread;
  meta: ManagerThreadMeta | null;
  queueDepth: number;
  isWorking: boolean;
}): boolean {
  const managerOwned =
    input.queueDepth > 0 ||
    input.isWorking ||
    managerThreadMetaHasContent(input.meta);
  if (!managerOwned) {
    return false;
  }

  if (input.thread.status !== 'waiting') {
    return true;
  }
  if (input.queueDepth > 0 || input.isWorking) {
    return true;
  }
  if (
    Boolean(input.meta?.routingConfirmationNeeded) ||
    hasManagerRuntimeFootprint(input.meta)
  ) {
    return true;
  }
  return true;
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

  if (input.meta?.workerRuntimeState === 'cancelled-as-superseded') {
    return 'cancelled-as-superseded';
  }

  if (input.isWorking) {
    return 'ai-working';
  }

  if (input.queueDepth > 0) {
    return 'queued';
  }

  if (input.thread.status === 'needs-reply') {
    return 'user-reply-needed';
  }

  if (input.thread.status === 'review') {
    return 'ai-finished-awaiting-user-confirmation';
  }

  if (input.thread.status === 'waiting') {
    if (
      input.queueDepth > 0 ||
      input.isWorking ||
      hasManagerRuntimeFootprint(input.meta)
    ) {
      return 'queued';
    }
    if (lastSender(input.thread) === 'ai') {
      return 'ai-finished-awaiting-user-confirmation';
    }
  }

  if (input.thread.status === 'active') {
    return lastSender(input.thread) === 'ai'
      ? 'ai-finished-awaiting-user-confirmation'
      : 'queued';
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
    'cancelled-as-superseded': 5,
    done: 6,
  };

  const leftPriority = priority[left.uiState];
  const rightPriority = priority[right.uiState];
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  if (left.uiState === 'queued' && right.uiState === 'queued') {
    const leftQueueOrder = left.queueOrder ?? Number.MAX_SAFE_INTEGER;
    const rightQueueOrder = right.queueOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftQueueOrder !== rightQueueOrder) {
      return leftQueueOrder - rightQueueOrder;
    }
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
  const currentBatchIds = new Set<string>();
  for (const assignment of input.session.activeAssignments ?? []) {
    for (const entryId of assignment.queueEntryIds) {
      currentBatchIds.add(entryId);
    }
  }

  const dispatchPlan = buildQueueDispatchPlan(
    input.queue.filter((entry) => !currentBatchIds.has(entry.id)),
    input.session
  );
  const queueOrderByThread = new Map<string, number>();
  const queuePriorityByThread = new Map<string, ManagerQueuePriority>();
  for (const batch of dispatchPlan) {
    if (queueOrderByThread.has(batch.threadId)) {
      continue;
    }
    queueOrderByThread.set(batch.threadId, batch.order);
    queuePriorityByThread.set(batch.threadId, batch.priority);
  }

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

  const derivedFromByThread = new Map<string, string[]>();
  const derivedChildrenByThread = new Map<string, string[]>();
  for (const [threadId, meta] of Object.entries(input.meta)) {
    const parentIds = normalizeDerivedFromThreadIds(meta.derivedFromThreadIds);
    derivedFromByThread.set(threadId, parentIds);
    for (const parentId of parentIds) {
      derivedChildrenByThread.set(parentId, [
        ...(derivedChildrenByThread.get(parentId) ?? []),
        threadId,
      ]);
    }
  }

  const views = input.threads.flatMap((thread) => {
    const meta = input.meta[thread.id] ?? null;
    const queueDepth = pendingQueueDepth.get(thread.id) ?? 0;
    const isWorking = (input.session.activeAssignments ?? []).some(
      (assignment) => assignment.threadId === thread.id
    );
    if (
      !shouldIncludeInManagerThreadViews({
        thread,
        meta,
        queueDepth,
        isWorking,
      })
    ) {
      return [];
    }
    const uiState = deriveUiState({
      thread,
      meta,
      queueDepth,
      isWorking,
    });

    return [
      {
        ...thread,
        uiState,
        previewText: previewText(thread),
        lastSender: lastSender(thread),
        hiddenByDefault: uiState === 'done',
        routingConfirmationNeeded: Boolean(meta?.routingConfirmationNeeded),
        routingHint: meta?.routingHint ?? null,
        derivedFromThreadIds: derivedFromByThread.get(thread.id) ?? [],
        derivedChildThreadIds: derivedChildrenByThread.get(thread.id) ?? [],
        managedRepoId: normalizeManagedRepoText(meta?.managedRepoId),
        managedRepoLabel: normalizeManagedRepoText(meta?.managedRepoLabel),
        managedRepoRoot: normalizeManagedRepoText(meta?.managedRepoRoot),
        repoTargetKind: normalizeManagerTargetKind(meta?.repoTargetKind),
        newRepoName: normalizeManagedRepoText(meta?.newRepoName),
        newRepoRoot: normalizeManagedRepoText(meta?.newRepoRoot),
        managedBaseBranch: normalizeManagedRepoText(meta?.managedBaseBranch),
        managedVerifyCommand: normalizeManagedRepoText(
          meta?.managedVerifyCommand
        ),
        requestedWorkerRuntime: normalizeRequestedWorkerRuntime(
          meta?.requestedWorkerRuntime
        ),
        requestedRunMode: normalizeRequestedRunMode(meta?.requestedRunMode),
        queueDepth,
        isWorking,
        queueOrder: queueOrderByThread.get(thread.id) ?? null,
        queuePriority: queuePriorityByThread.get(thread.id) ?? null,
        assigneeKind: meta?.assigneeKind ?? null,
        assigneeLabel: meta?.assigneeLabel ?? null,
        workerAgentId:
          typeof meta?.workerAgentId === 'string'
            ? meta.workerAgentId.trim() || null
            : null,
        workerRuntimeState: normalizeWorkerRuntimeState(
          meta?.workerRuntimeState
        ),
        workerRuntimeDetail:
          typeof meta?.workerRuntimeDetail === 'string'
            ? meta.workerRuntimeDetail.trim() || null
            : null,
        workerWriteScopes: normalizeDerivedFromThreadIds(
          meta?.workerWriteScopes
        ),
        workerBlockedByThreadIds: normalizeDerivedFromThreadIds(
          meta?.workerBlockedByThreadIds
        ),
        supersededByThreadId:
          typeof meta?.supersededByThreadId === 'string'
            ? meta.supersededByThreadId.trim() || null
            : null,
        workerLiveLog: normalizeWorkerLiveLog(meta?.workerLiveLog),
        workerLiveOutput:
          typeof meta?.workerLiveOutput === 'string'
            ? meta.workerLiveOutput
            : null,
        workerLiveAt:
          typeof meta?.workerLiveAt === 'string' ? meta.workerLiveAt : null,
        seedRecoveryPending: Boolean(meta?.seedRecoveryPending),
        seedRecoveryRepoRoot: normalizeManagedRepoText(
          meta?.seedRecoveryRepoRoot
        ),
        seedRecoveryRepoLabel: normalizeManagedRepoText(
          meta?.seedRecoveryRepoLabel
        ),
        seedRecoveryChangedFiles: normalizeDerivedFromThreadIds(
          meta?.seedRecoveryChangedFiles
        ),
      } satisfies ManagerThreadView,
    ];
  });

  return views.sort(compareByPriority);
}

// ---------------------------------------------------------------------------
// Thread fail counter — exponential backoff for consecutive failures
// ---------------------------------------------------------------------------

const FAIL_BACKOFF_BASE_MS = 15_000; // 15 seconds
const FAIL_BACKOFF_MAX_MS = 5 * 60_000; // 5 minutes
const FAIL_MAX_CONSECUTIVE = 3;

export async function recordThreadFailure(
  dir: string,
  threadId: string
): Promise<{ consecutiveFailures: number; shouldPause: boolean }> {
  let failures = 0;
  await updateManagerThreadMeta(dir, threadId, (current) => {
    failures = (current?.consecutiveFailures ?? 0) + 1;
    const backoffMs = Math.min(
      FAIL_BACKOFF_BASE_MS * Math.pow(2, failures - 1),
      FAIL_BACKOFF_MAX_MS
    );
    return {
      ...current,
      consecutiveFailures: failures,
      nextRetryAfter: new Date(Date.now() + backoffMs).toISOString(),
    };
  });
  return {
    consecutiveFailures: failures,
    shouldPause: failures >= FAIL_MAX_CONSECUTIVE,
  };
}

export async function resetThreadFailures(
  dir: string,
  threadId: string
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, (current) => {
    if (!current || (!current.consecutiveFailures && !current.nextRetryAfter)) {
      return current;
    }
    return {
      ...current,
      consecutiveFailures: 0,
      nextRetryAfter: null,
    };
  });
}

export function isThreadInBackoff(meta: ManagerThreadMeta | null): boolean {
  if (!meta?.nextRetryAfter) {
    return false;
  }
  return new Date(meta.nextRetryAfter).getTime() > Date.now();
}
