import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import type { Thread, ThreadStatus } from '@metyatech/thread-inbox';
import type { QueueEntry, ManagerSession } from './manager-backend.js';
import { writeFileAtomically } from './atomic-file.js';
import {
  buildQueueDispatchPlan,
  type ManagerQueuePriority,
} from './manager-queue-priority.js';
import { summarizeManagerMessage } from './manager-message.js';
import { notifyManagerUpdate } from './manager-live-updates.js';
import { withSerializedKeyLock } from './promise-lock.js';
import type {
  ManagerRunMode,
  ManagerTargetKind,
  ManagerWorkerRuntime,
} from './manager-repos.js';

export const MANAGER_THREAD_META_FILE =
  '.workspace-agent-hub-manager-thread-meta.json';

export type ManagerUiState =
  | 'routing-confirmation-needed'
  | 'error'
  | 'user-reply-needed'
  | 'stalled'
  | 'ai-finished-awaiting-user-confirmation'
  | 'queued'
  | 'ai-starting'
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

export interface ManagerStateTransitionEntry {
  at: string;
  fromState: ManagerUiState;
  toState: ManagerUiState;
  fromReason: string | null;
  toReason: string | null;
}

export interface ManagerThreadMeta {
  managerOwned?: boolean;
  canonicalState?: ManagerUiState | null;
  canonicalStateReason?: string | null;
  runtimeErrorMessage?: string | null;
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
  pendingReplyStatus?: Extract<
    ThreadStatus,
    'active' | 'review' | 'needs-reply'
  > | null;
  pendingReplyContent?: string | null;
  pendingReplyAt?: string | null;
  strandedAutoResumeCount?: number;
  strandedAutoResumeLastUserAt?: string | null;
  strandedAutoResumeLastAttemptAt?: string | null;
  consecutiveFailures?: number;
  nextRetryAfter?: string | null;
  recentStateTransitions?: ManagerStateTransitionEntry[] | null;
}

export interface ManagerThreadView extends Thread {
  uiState: ManagerUiState;
  canonicalStateReason: string | null;
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
  pendingReplyAt: string | null;
  strandedAutoResumeCount: number;
  strandedAutoResumeLastAttemptAt: string | null;
  recentStateTransitions: ManagerStateTransitionEntry[];
}

type ManagerThreadMetaMap = Record<string, ManagerThreadMeta>;

const metaWriteLocks = new Map<string, Promise<void>>();
const MANAGER_STATE_TRANSITION_HISTORY_LIMIT = 12;

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await writeFileAtomically(filePath, content);
}

async function withMetaWriteLock<T>(
  dir: string,
  fn: () => Promise<T>
): Promise<T> {
  return withSerializedKeyLock(metaWriteLocks, resolvePath(dir), fn);
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
  threads: Thread[];
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

  const next: ManagerThreadMetaMap = {};
  const seenThreadIds = new Set<string>();
  let changed = false;

  for (const thread of input.threads) {
    seenThreadIds.add(thread.id);
    const currentMeta = current[thread.id] ?? null;
    const queueDepth = pendingQueueDepth.get(thread.id) ?? 0;
    const isStarting = input.session.dispatchingThreadId === thread.id;
    const isWorking = activeThreadIds.has(thread.id);
    const managerOwned =
      queueDepth > 0 ||
      isStarting ||
      isWorking ||
      managerThreadMetaHasContent(currentMeta);
    if (!managerOwned) {
      continue;
    }

    const cleanedMeta =
      isStarting ||
      isWorking ||
      pendingThreadIds.has(thread.id) ||
      !hasManagerRuntimeFootprint(currentMeta)
        ? currentMeta
        : stripManagerRuntimeStatePreservingContinuity(currentMeta);
    const canonical = deriveCanonicalStateInfo({
      thread,
      meta: cleanedMeta,
      queueDepth,
      isStarting,
      isWorking,
    });
    const previousCanonicalState = normalizeCanonicalUiState(
      currentMeta?.canonicalState
    );
    const previousCanonicalReason =
      typeof currentMeta?.canonicalStateReason === 'string'
        ? currentMeta.canonicalStateReason.trim() || null
        : null;
    const recentStateTransitions = normalizeStateTransitionHistory(
      cleanedMeta?.recentStateTransitions
    );
    const nextMeta: ManagerThreadMeta = {
      ...(cleanedMeta ?? {}),
      canonicalState: canonical.uiState,
      canonicalStateReason: canonical.reason,
      recentStateTransitions:
        previousCanonicalState && previousCanonicalState !== canonical.uiState
          ? [
              ...recentStateTransitions,
              {
                at: new Date().toISOString(),
                fromState: previousCanonicalState,
                toState: canonical.uiState,
                fromReason: previousCanonicalReason,
                toReason: canonical.reason,
              } satisfies ManagerStateTransitionEntry,
            ].slice(-MANAGER_STATE_TRANSITION_HISTORY_LIMIT)
          : recentStateTransitions,
    };
    next[thread.id] = nextMeta;

    if (JSON.stringify(nextMeta) !== JSON.stringify(currentMeta ?? {})) {
      changed = true;
    }
  }

  for (const [threadId, meta] of Object.entries(current)) {
    if (seenThreadIds.has(threadId)) {
      continue;
    }
    const cleaned = clearCanonicalThreadState(
      stripManagerRuntimeStatePreservingContinuity(meta) ?? meta
    );
    if (managerThreadMetaHasContent(cleaned)) {
      next[threadId] = cleaned;
    }
    if (
      JSON.stringify(cleaned) !== JSON.stringify(meta) ||
      !managerThreadMetaHasContent(cleaned)
    ) {
      changed = true;
    }
  }

  if (!changed && Object.keys(next).length === Object.keys(current).length) {
    return current;
  }

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

function lastUserMessage(thread: Thread): Thread['messages'][number] | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.sender === 'user') {
      return message;
    }
  }
  return null;
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

function normalizeCanonicalUiState(value: unknown): ManagerUiState | null {
  return value === 'routing-confirmation-needed' ||
    value === 'error' ||
    value === 'user-reply-needed' ||
    value === 'stalled' ||
    value === 'ai-finished-awaiting-user-confirmation' ||
    value === 'queued' ||
    value === 'ai-starting' ||
    value === 'ai-working' ||
    value === 'cancelled-as-superseded' ||
    value === 'done'
    ? value
    : null;
}

function normalizePendingReplyStatus(
  value: unknown
): Extract<ThreadStatus, 'active' | 'review' | 'needs-reply'> | null {
  return value === 'active' || value === 'review' || value === 'needs-reply'
    ? value
    : null;
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

function normalizeStateTransitionHistory(
  value: unknown
): ManagerStateTransitionEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const record = entry as Record<string, unknown>;
    const at = typeof record['at'] === 'string' ? record['at'].trim() : '';
    const fromState = normalizeCanonicalUiState(record['fromState']);
    const toState = normalizeCanonicalUiState(record['toState']);
    const fromReason =
      typeof record['fromReason'] === 'string'
        ? record['fromReason'].trim() || null
        : null;
    const toReason =
      typeof record['toReason'] === 'string'
        ? record['toReason'].trim() || null
        : null;

    if (!at || !fromState || !toState) {
      return [];
    }

    return [
      {
        at,
        fromState,
        toState,
        fromReason,
        toReason,
      } satisfies ManagerStateTransitionEntry,
    ];
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

function clearCanonicalThreadState(meta: ManagerThreadMeta): ManagerThreadMeta {
  const next = { ...meta };
  delete next.canonicalState;
  delete next.canonicalStateReason;
  return next;
}

function staleReason(input: {
  thread: Thread;
  meta: ManagerThreadMeta | null;
}): string {
  if (
    typeof input.meta?.pendingReplyContent === 'string' &&
    input.meta.pendingReplyContent.trim() &&
    normalizePendingReplyStatus(input.meta.pendingReplyStatus)
  ) {
    return 'AI の返答は準備できていますが、thread への保存に失敗したため自動回復を待っています。';
  }

  const lastUser = lastUserMessage(input.thread);
  const autoResumedForCurrentTurn =
    Boolean(lastUser?.at) &&
    input.meta?.strandedAutoResumeLastUserAt === lastUser?.at &&
    (input.meta?.strandedAutoResumeCount ?? 0) > 0;
  if (autoResumedForCurrentTurn) {
    return '前回の user 依頼を自動で再開しましたが、まだ正常状態へ戻っていません。必要なら内容を確認して再送してください。';
  }

  return 'Manager が処理すべき user 依頼でしたが、現在はキューにも実行中にも存在しない取り残し状態です。';
}

function isOperationalBlocker(meta: ManagerThreadMeta | null): boolean {
  if (!meta) return false;

  // Narrow set of operational blocker indicators. Only these fields are
  // considered operational (non-judgment) blockers per the policy change.
  if (typeof meta.pausedWorktreePath === 'string' && meta.pausedWorktreePath)
    return true;
  if (typeof meta.pausedAssignmentId === 'string' && meta.pausedAssignmentId)
    return true;
  if (meta.workerRuntimeState === 'blocked-by-scope') return true;
  if (
    Array.isArray(meta.workerBlockedByThreadIds) &&
    meta.workerBlockedByThreadIds.length > 0
  )
    return true;
  if (
    typeof meta.strandedAutoResumeCount === 'number' &&
    meta.strandedAutoResumeCount > 0
  )
    return true;
  if (meta.seedRecoveryPending) return true;

  return false;
}

function inferLegacyOperationalBlockerMessage(thread: Thread): string | null {
  const lastMessage = thread.messages.at(-1);
  if (lastMessage?.sender !== 'ai' || typeof lastMessage.content !== 'string') {
    return null;
  }

  const text = lastMessage.content.trim();
  const knownOperationalPrefixes = [
    '[Manager error]',
    '[Manager] この既存リポジトリは managed-worktree-system (`mwt`) 初期化前のため、Manager の isolated write task を開始できませんでした。',
    '[Manager] 保存されていた paused managed task worktree を再利用できませんでした。',
    '[Manager] Worker の workingDirectory を確定できませんでした。',
    '[Manager] Worker 隔離環境の作成に失敗しました:',
    '[Manager] Worker 隔離環境の作成に失敗しました。',
  ];

  return knownOperationalPrefixes.some((prefix) => text.startsWith(prefix))
    ? text
    : null;
}

function deriveCanonicalStateInfo(input: {
  thread: Thread;
  meta: ManagerThreadMeta | null;
  queueDepth: number;
  isStarting: boolean;
  isWorking: boolean;
}): {
  uiState: ManagerUiState;
  reason: string | null;
} {
  let uiState: ManagerUiState;
  const runtimeErrorMessage = (() => {
    const explicit =
      typeof input.meta?.runtimeErrorMessage === 'string'
        ? input.meta.runtimeErrorMessage.trim() || null
        : null;
    if (explicit) return explicit;

    return inferLegacyOperationalBlockerMessage(input.thread);
  })();
  const hasNeedsReplyRuntimeError =
    Boolean(runtimeErrorMessage) &&
    (input.thread.status === 'needs-reply' ||
      (input.thread.status === 'waiting' &&
        normalizePendingReplyStatus(input.meta?.pendingReplyStatus) ===
          'needs-reply'));

  if (input.thread.status === 'resolved') {
    uiState = 'done';
  } else if (input.meta?.routingConfirmationNeeded) {
    uiState = 'routing-confirmation-needed';
  } else if (input.meta?.workerRuntimeState === 'cancelled-as-superseded') {
    uiState = 'cancelled-as-superseded';
  } else if (input.isWorking) {
    uiState = 'ai-working';
  } else if (input.isStarting) {
    uiState = 'ai-starting';
  } else if (input.queueDepth > 0) {
    uiState = 'queued';
  } else if (hasNeedsReplyRuntimeError) {
    uiState = 'error';
  } else if (
    input.thread.status === 'needs-reply' &&
    isOperationalBlocker(input.meta)
  ) {
    // Operational blockers should be surfaced as errors so operators can act
    // on them. Preserve explicit routing-confirmation and runtime-error
    // semantics.
    uiState = 'error';
  } else if (input.thread.status === 'needs-reply') {
    uiState = 'user-reply-needed';
  } else if (input.thread.status === 'review') {
    uiState = 'ai-finished-awaiting-user-confirmation';
  } else if (input.thread.status === 'waiting') {
    if (
      input.queueDepth > 0 ||
      input.isStarting ||
      input.isWorking ||
      hasManagerRuntimeFootprint(input.meta)
    ) {
      uiState = input.isStarting ? 'ai-starting' : 'queued';
    } else if (lastSender(input.thread) === 'ai') {
      uiState = 'ai-finished-awaiting-user-confirmation';
    } else {
      uiState = 'stalled';
    }
  } else if (input.thread.status === 'active') {
    uiState =
      lastSender(input.thread) === 'ai'
        ? 'ai-finished-awaiting-user-confirmation'
        : 'queued';
  } else if (lastSender(input.thread) === 'ai') {
    uiState = 'ai-finished-awaiting-user-confirmation';
  } else {
    uiState = 'queued';
  }

  return {
    uiState,
    reason:
      uiState === 'error'
        ? runtimeErrorMessage
        : uiState === 'stalled'
          ? staleReason(input)
          : null,
  };
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
  isStarting: boolean;
  isWorking: boolean;
}): boolean {
  const managerOwned =
    input.queueDepth > 0 ||
    input.isStarting ||
    input.isWorking ||
    managerThreadMetaHasContent(input.meta);
  if (!managerOwned) {
    return false;
  }

  if (input.thread.status !== 'waiting') {
    return true;
  }
  if (input.queueDepth > 0 || input.isStarting || input.isWorking) {
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
  isStarting: boolean;
  isWorking: boolean;
}): ManagerUiState {
  const canonical = normalizeCanonicalUiState(input.meta?.canonicalState);
  if (canonical) {
    return canonical;
  }
  return deriveCanonicalStateInfo(input).uiState;
}

function compareByPriority(
  left: ManagerThreadView,
  right: ManagerThreadView
): number {
  const priority: Record<ManagerUiState, number> = {
    'routing-confirmation-needed': 0,
    error: 1,
    'user-reply-needed': 2,
    stalled: 3,
    'ai-finished-awaiting-user-confirmation': 4,
    queued: 5,
    'ai-starting': 6,
    'ai-working': 7,
    'cancelled-as-superseded': 8,
    done: 9,
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
    const isStarting = input.session.dispatchingThreadId === thread.id;
    const isWorking = (input.session.activeAssignments ?? []).some(
      (assignment) => assignment.threadId === thread.id
    );
    if (
      !shouldIncludeInManagerThreadViews({
        thread,
        meta,
        queueDepth,
        isStarting,
        isWorking,
      })
    ) {
      return [];
    }
    const uiState = deriveUiState({
      thread,
      meta,
      queueDepth,
      isStarting,
      isWorking,
    });

    // compute canonicalStateReason: prefer explicit meta.canonicalStateReason;
    // when absent, preserve runtime error reason for threads whose uiState is
    // 'error' by deriving the canonical info from current inputs. Do NOT
    // synthesize reasons for other states (keep stalled behavior unchanged).
    const explicitCanonicalStateReason =
      typeof meta?.canonicalStateReason === 'string'
        ? meta.canonicalStateReason.trim() || null
        : null;
    let computedCanonicalStateReason: string | null =
      explicitCanonicalStateReason;
    if (computedCanonicalStateReason === null && uiState === 'error') {
      computedCanonicalStateReason = deriveCanonicalStateInfo({
        thread,
        meta,
        queueDepth,
        isStarting,
        isWorking,
      }).reason;
    }

    return [
      {
        ...thread,
        uiState,
        canonicalStateReason: computedCanonicalStateReason,
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
        pendingReplyAt:
          typeof meta?.pendingReplyAt === 'string'
            ? meta.pendingReplyAt.trim() || null
            : null,
        strandedAutoResumeCount:
          typeof meta?.strandedAutoResumeCount === 'number' &&
          Number.isFinite(meta.strandedAutoResumeCount)
            ? meta.strandedAutoResumeCount
            : 0,
        strandedAutoResumeLastAttemptAt:
          typeof meta?.strandedAutoResumeLastAttemptAt === 'string'
            ? meta.strandedAutoResumeLastAttemptAt.trim() || null
            : null,
        recentStateTransitions: normalizeStateTransitionHistory(
          meta?.recentStateTransitions
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
