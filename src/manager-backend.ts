/**
 * Built-in Manager backend for Workspace Agent Hub.
 *
 * Uses the Codex CLI directly (`codex exec ...`) for Manager routing and
 * per-work-item worker-agent execution.
 * Maintains per-workspace state in two workspace-local files (not committed):
 *
 *   .workspace-agent-hub-manager.json        — runtime state (idle/busy, legacy routing field, PID)
 *   .workspace-agent-hub-manager-queue.jsonl — persistent message queue
 *
 * Key design rules:
 *  - One stateless Codex routing turn per freeform inbox send
 *  - One Codex worker-agent session per Manager work item, persisted in thread meta
 *  - Manager-assigned replies and worker-agent tasks share one persistent queue
 *  - Worker-agent assignments can run in parallel when their repo-relative
 *    write scopes do not overlap
 *  - On server restart, a stale PID is detected and the queue resumes automatically
 *  - No external npm dependencies — only the `codex` CLI in PATH is required
 *  - Requires: Codex CLI (`npm install -g @openai/codex`)
 */

import { spawn } from 'child_process';
import { readFile, writeFile, appendFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, resolve as resolvePath } from 'path';
import {
  addMessage,
  createThread,
  getThread,
  listThreads,
  reopenThread,
  resolveThread,
  type Thread,
  type ThreadStatus,
} from '@metyatech/thread-inbox';
import {
  clearManagerThreadMeta,
  type ManagerWorkerLiveEntry,
  type ManagerWorkerRuntimeState,
  readManagerThreadMeta,
  updateManagerThreadMeta,
} from './manager-thread-state.js';
import { materializeManagerPromptImages } from './manager-message-files.js';
import {
  buildManagerMessagePromptContent,
  extractManagerMessagePlainText,
  parseManagerMessage,
  serializeManagerMessage,
  summarizeManagerMessage,
  type ManagerMessageAttachment,
} from './manager-message.js';
import {
  advanceManagerQueuePriorityStreak,
  buildQueueDispatchPlan,
  detectManagerQueuePriority,
  normalizeManagerQueueEntry,
  type ManagerQueuePriority,
} from './manager-queue-priority.js';
import { notifyManagerUpdate } from './manager-live-updates.js';

export const MANAGER_SESSION_FILE = '.workspace-agent-hub-manager.json';
export const MANAGER_QUEUE_FILE = '.workspace-agent-hub-manager-queue.jsonl';

/** Manager backend target: Codex GPT-5.4 at xhigh reasoning effort. */
export const MANAGER_MODEL = 'gpt-5.4';
export const MANAGER_REASONING_EFFORT = 'xhigh';

/**
 * Status applied to successful manager replies when the reply is plain text
 * rather than explicit manager JSON. This is a rare fallback path; keep it in
 * the review bucket so we do not hide a complete result indefinitely when the
 * model fails to emit the expected JSON envelope.
 */
export const MANAGER_REPLY_STATUS = 'review' as const;

/**
 * System context embedded in each stateless routing turn.
 */
const MANAGER_ROUTER_SYSTEM_PROMPT =
  'You are a manager AI assistant for this software workspace. ' +
  'Help coordinate work across multiple threads. ' +
  'Judge each incoming user message on its own against the currently open topics instead of relying on older router-chat memory. ' +
  'Default to a new topic for each new user turn unless the message is directly answering a blocking question already asked inside an existing topic. ' +
  'Route requests into the right topic, ask for clarification only when routing is truly ambiguous, and keep stored user wording as close to the original as possible.';

const MANAGER_REPLY_JSON_RULES =
  'Return only strict JSON with keys {"status","reply"}. ' +
  'Use status "review" only when the answer or work result is actually ready for the user to review. ' +
  'Use status "needs-reply" only when you truly need user input before you can continue. ' +
  'Prefer "review" or "needs-reply"; do not use "active" unless you cannot finish this turn yet still want the topic left explicitly in progress. ' +
  'Do not wrap JSON in markdown fences.';

const MANAGER_WORKER_SYSTEM_PROMPT =
  'You are the built-in execution worker for Workspace Agent Hub. ' +
  'After the Manager routes a user request into a topic, you must actually do the work in this repository when possible: inspect files, modify code, run verification, and continue until you either reach a reviewable result or need user input. ' +
  'Do not stop at acknowledgement-only replies. ' +
  'Return concise user-facing progress/result text, but only after you have genuinely attempted the work. ' +
  'Write user-facing replies in plain, natural Japanese that reads like a capable coworker, not a tool log. ' +
  'Avoid internal AI/platform/process jargon unless the user explicitly asked for it or it is necessary to unblock them. ' +
  'Prefer ordinary task language, complete sentences, and direct explanations of what changed or what is still needed. ' +
  'If a technical term is unavoidable, explain it briefly in everyday Japanese. ' +
  'Use normal Markdown formatting only when it genuinely makes the reply easier to read.';

const MANAGER_WORKER_JSON_RULES =
  'Return only strict JSON with keys {"status","reply"}. ' +
  'Use status "review" when you completed the actionable work you can do now and the user can review the result. ' +
  'Use status "needs-reply" only when a real blocker or missing user decision prevents further progress. ' +
  'Do not use "active" for mere acknowledgements; keep working until you can return "review" or "needs-reply". ' +
  'Do not wrap JSON in markdown fences.';

const MANAGER_ROUTING_JSON_RULES =
  'Return only strict JSON in the form {"actions":[...]}. ' +
  'Each action must have kind "attach-existing", "create-new", "routing-confirmation", or "resolve-existing". ' +
  'For "attach-existing" and "resolve-existing", include topicRef and content. ' +
  'For "create-new", include title and content. ' +
  'Treat contextThreadId only as a hint; create a new topic unless the current message clearly belongs to that existing topic. ' +
  'Default granularity is one user turn per topic. When the message is a follow-up or additional instruction about an existing topic, prefer a fresh topic with standalone context instead of attach-existing. Reserve attach-existing for direct answers to an outstanding blocking question or routing-confirmation request that already exists inside that topic. ' +
  'Do not attach to an existing topic just because it is broadly similar or was discussed recently; attach only when the current message clearly reads as a continuation of that exact topic. ' +
  'For every action, include originalText as the exact copied user wording for just that part whenever possible; do not paraphrase originalText. ' +
  'For "routing-confirmation", include title, content, question, and reason. ' +
  'Use topicRef exactly as shown in Existing open topics, and never mention topicRef, threadId, or any other internal ID in user-facing titles, reasons, questions, or stored content. ' +
  'content is the user message text that will be stored in that target topic. For "create-new" and "routing-confirmation", content must stand on its own inside that topic: keep it as close to the original wording as possible, but add the smallest missing context needed so the topic still makes sense when read alone. If the original wording already stands alone, make content match originalText. ' +
  'Split confident intents immediately and leave only the ambiguous parts for confirmation. ' +
  'Do not wrap JSON in markdown fences.';

export interface ManagerReplyPayload {
  status: Extract<ThreadStatus, 'active' | 'review' | 'needs-reply'>;
  reply: string;
}

export interface ManagerDispatchPayload {
  assignee: 'manager' | 'worker';
  status?: Extract<ThreadStatus, 'active' | 'review' | 'needs-reply'>;
  reply?: string;
  writeScopes?: string[];
  supersedesThreadIds?: string[];
  reason?: string;
}

export interface ManagerRoutingAction {
  kind:
    | 'attach-existing'
    | 'create-new'
    | 'routing-confirmation'
    | 'resolve-existing';
  topicRef?: string;
  threadId?: string;
  title?: string;
  originalText?: string;
  content: string;
  reason?: string;
  question?: string;
}

export interface ManagerRoutingPlan {
  actions: ManagerRoutingAction[];
}

export interface ManagerRoutingSummaryItem {
  threadId: string;
  title: string;
  outcome:
    | 'attached-existing'
    | 'created-new'
    | 'routing-confirmation'
    | 'resolved-existing';
  reason: string;
}

export interface ManagerRoutingSummary {
  items: ManagerRoutingSummaryItem[];
  routedCount: number;
  ambiguousCount: number;
  detail: string;
}

export interface ManagerSession {
  workspaceKey: string;
  /** idle: ready to process; busy: currently running; not-started: never initialised */
  status: 'idle' | 'busy' | 'not-started';
  /** Legacy workspace-level worker continuity; new execution turns use per-thread meta. */
  sessionId: string | null;
  /** Legacy field kept for on-disk compatibility; routing now runs statelessly per send. */
  routingSessionId: string | null;
  /** PID of the currently running codex process, or null */
  pid: number | null;
  /** Queue entry ID currently being processed */
  currentQueueId: string | null;
  startedAt: string | null;
  lastMessageAt: string | null;
  /** Prevents normal backlog from starving when priority items keep arriving. */
  priorityStreak: number;
  /** Last time the current worker made observable progress (spawn/progress event). */
  lastProgressAt: string | null;
  /** Latest manager-runtime error surfaced to the GUI. */
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
  /** Active manager/worker assignments currently running for queued work items. */
  activeAssignments: ManagerActiveAssignment[];
}

export interface ManagerActiveAssignment {
  id: string;
  threadId: string;
  queueEntryIds: string[];
  assigneeKind: 'manager' | 'worker';
  assigneeLabel: string;
  writeScopes: string[];
  pid: number | null;
  startedAt: string;
  lastProgressAt: string | null;
}

export type ManagerHealth = 'ok' | 'stalled' | 'error';

const MANAGER_STALLED_PROGRESS_THRESHOLD_MS = 3 * 60 * 1000;
const MANAGER_RECONCILE_GRACE_MS = 15 * 1000;
const MAX_PARALLEL_WORKER_AGENTS = 3;
const MAX_PARALLEL_MANAGER_ASSIGNMENTS = 1;
const UNIVERSAL_WRITE_SCOPE = '*';

export interface QueueEntry {
  id: string;
  threadId: string;
  content: string;
  attachments?: QueueEntryAttachment[];
  dispatchMode?: 'direct-worker' | 'manager-evaluate';
  createdAt: string;
  processed: boolean;
  priority: ManagerQueuePriority;
}

export interface QueueEntryAttachment {
  id: string;
  name: string;
  mimeType: string;
  path: string;
}

interface CodexProgressState {
  sessionId: string | null;
  latestText: string | null;
  liveEntries: ManagerWorkerLiveEntry[];
}

/** Derive a stable 16-char hex key from an absolute workspace path. */
export function workspaceKey(dir: string): string {
  return createHash('sha256')
    .update(resolvePath(dir))
    .digest('hex')
    .slice(0, 16);
}

export function sessionFilePath(dir: string): string {
  return join(resolvePath(dir), MANAGER_SESSION_FILE);
}

export function queueFilePath(dir: string): string {
  return join(resolvePath(dir), MANAGER_QUEUE_FILE);
}

function makeDefaultSession(dir: string): ManagerSession {
  return {
    workspaceKey: workspaceKey(dir),
    status: 'not-started',
    sessionId: null,
    routingSessionId: null,
    pid: null,
    currentQueueId: null,
    startedAt: null,
    lastMessageAt: null,
    priorityStreak: 0,
    lastProgressAt: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    activeAssignments: [],
  };
}

function normalizeStringArray(value: unknown): string[] {
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

function normalizeWriteScope(scope: string): string {
  const normalized = scope
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim();
  if (!normalized) {
    return '';
  }
  return normalized === UNIVERSAL_WRITE_SCOPE
    ? UNIVERSAL_WRITE_SCOPE
    : normalized.replace(/\/+$/, '');
}

function normalizeWriteScopes(value: unknown): string[] {
  const scopes = normalizeStringArray(value)
    .map((entry) => normalizeWriteScope(entry))
    .filter(Boolean);
  return Array.from(new Set(scopes));
}

function normalizeActiveAssignment(
  value: unknown
): ManagerActiveAssignment | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
  const threadId =
    typeof record['threadId'] === 'string' ? record['threadId'].trim() : '';
  const assigneeKind =
    record['assigneeKind'] === 'manager' || record['assigneeKind'] === 'worker'
      ? record['assigneeKind']
      : 'worker';
  const assigneeLabel =
    typeof record['assigneeLabel'] === 'string' &&
    record['assigneeLabel'].trim()
      ? record['assigneeLabel'].trim()
      : assigneeKind === 'manager'
        ? `Manager ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`
        : `Worker agent ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`;
  const queueEntryIds = normalizeStringArray(record['queueEntryIds']);
  if (!id || !threadId || queueEntryIds.length === 0) {
    return null;
  }

  return {
    id,
    threadId,
    queueEntryIds,
    assigneeKind,
    assigneeLabel,
    writeScopes: normalizeWriteScopes(record['writeScopes']),
    pid:
      typeof record['pid'] === 'number' && Number.isFinite(record['pid'])
        ? record['pid']
        : null,
    startedAt:
      typeof record['startedAt'] === 'string' && record['startedAt'].trim()
        ? record['startedAt']
        : new Date().toISOString(),
    lastProgressAt:
      typeof record['lastProgressAt'] === 'string' && record['lastProgressAt']
        ? record['lastProgressAt']
        : null,
  };
}

function normalizeManagerSession(
  dir: string,
  session: Partial<ManagerSession>
): ManagerSession {
  const base = makeDefaultSession(dir);
  const hasExplicitAssignments = Object.prototype.hasOwnProperty.call(
    session,
    'activeAssignments'
  );
  const explicitAssignments = Array.isArray(session.activeAssignments)
    ? session.activeAssignments
        .map((entry) => normalizeActiveAssignment(entry))
        .filter((entry): entry is ManagerActiveAssignment => entry !== null)
    : [];
  const synthesizedLegacyAssignment =
    !hasExplicitAssignments &&
    explicitAssignments.length === 0 &&
    session.status === 'busy' &&
    typeof session.currentQueueId === 'string' &&
    session.currentQueueId.trim()
      ? [
          {
            id: `legacy_${session.currentQueueId.trim()}`,
            threadId: 'unknown',
            queueEntryIds: [session.currentQueueId.trim()],
            assigneeKind: 'worker' as const,
            assigneeLabel: `Worker agent ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`,
            writeScopes: [],
            pid:
              typeof session.pid === 'number' && Number.isFinite(session.pid)
                ? session.pid
                : null,
            startedAt:
              typeof session.startedAt === 'string' && session.startedAt.trim()
                ? session.startedAt
                : new Date().toISOString(),
            lastProgressAt:
              typeof session.lastProgressAt === 'string' &&
              session.lastProgressAt.trim()
                ? session.lastProgressAt
                : null,
          },
        ]
      : [];
  const activeAssignments =
    explicitAssignments.length > 0
      ? explicitAssignments
      : synthesizedLegacyAssignment;
  const status =
    session.status === 'not-started'
      ? 'not-started'
      : activeAssignments.length > 0
        ? 'busy'
        : 'idle';
  const firstAssignment = activeAssignments[0] ?? null;

  return {
    ...base,
    ...session,
    status,
    pid: firstAssignment?.pid ?? null,
    currentQueueId: firstAssignment?.queueEntryIds[0] ?? null,
    activeAssignments,
  };
}

// ── Per-workspace write serialisation ─────────────────────────────────────
// Serialises concurrent queue/session mutations to prevent partial-write races
// between append (enqueue) and rewrite (writeQueue/writeSession) operations.
// Uses a promise-chain per key so each workspace is independent.
const _writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(key) ?? Promise.resolve();
  let done!: () => void;
  const gate = new Promise<void>((resolve) => {
    done = resolve;
  });
  _writeLocks.set(key, gate);
  // Wait for any in-flight operation on this key to finish before running fn.
  await prev;
  try {
    return await fn();
  } finally {
    done();
    // Remove map entry only if no newer waiter has replaced it.
    if (_writeLocks.get(key) === gate) _writeLocks.delete(key);
  }
}

/**
 * Crash-resistant file write: write content to a temp file then rename atomically.
 * Prevents a crash mid-write from leaving a partial/empty file.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content, 'utf-8');
  await rename(tmp, filePath);
}

export async function readSession(dir: string): Promise<ManagerSession> {
  const filePath = sessionFilePath(dir);
  if (!existsSync(filePath)) return makeDefaultSession(dir);
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<ManagerSession>;
    return normalizeManagerSession(dir, parsed);
  } catch {
    return makeDefaultSession(dir);
  }
}

export async function writeSession(
  dir: string,
  session: ManagerSession
): Promise<void> {
  const filePath = sessionFilePath(dir);
  const key = `session:${resolvePath(dir)}`;
  const normalized = normalizeManagerSession(dir, session);
  await withWriteLock(key, () =>
    atomicWrite(filePath, JSON.stringify(normalized, null, 2))
  );
  notifyManagerUpdate(dir);
}

async function touchManagerProgress(dir: string): Promise<void> {
  const session = await readSession(dir);
  await writeSession(dir, {
    ...session,
    lastProgressAt: new Date().toISOString(),
  });
}

async function setManagerRuntimeError(
  dir: string,
  message: string
): Promise<void> {
  const session = await readSession(dir);
  await writeSession(dir, {
    ...session,
    lastErrorMessage: message,
    lastErrorAt: new Date().toISOString(),
  });
}

export async function readQueue(dir: string): Promise<QueueEntry[]> {
  const filePath = queueFilePath(dir);
  if (!existsSync(filePath)) return [];
  try {
    const content = await readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [normalizeManagerQueueEntry(JSON.parse(line) as QueueEntry)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function writeQueue(
  dir: string,
  entries: QueueEntry[]
): Promise<void> {
  const filePath = queueFilePath(dir);
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  const key = `queue:${resolvePath(dir)}`;
  await withWriteLock(key, () =>
    atomicWrite(filePath, content ? content + '\n' : '')
  );
  notifyManagerUpdate(dir);
}

/** Append one message to the queue file and return its generated ID. */
export async function enqueueMessage(
  dir: string,
  threadId: string,
  content: string,
  options?: {
    dispatchMode?: 'direct-worker' | 'manager-evaluate';
  }
): Promise<string> {
  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const attachments = await materializeManagerPromptImages({
    workspaceKey: workspaceKey(dir),
    message: content,
  });
  const entry: QueueEntry = {
    id,
    threadId,
    content,
    attachments,
    dispatchMode: options?.dispatchMode ?? 'direct-worker',
    createdAt: new Date().toISOString(),
    processed: false,
    priority: detectManagerQueuePriority(content),
  };
  // Serialise via the queue lock so concurrent enqueue + writeQueue cannot interleave
  // and cause a full rewrite to overwrite an in-flight append.
  const key = `queue:${resolvePath(dir)}`;
  await withWriteLock(key, () =>
    appendFile(queueFilePath(dir), JSON.stringify(entry) + '\n', 'utf-8')
  );
  notifyManagerUpdate(dir);
  return id;
}

/**
 * Read-modify-write the queue file within a single lock acquisition.
 * Use this for all in-place queue mutations (e.g. removing a processed entry)
 * so they cannot race with concurrent enqueue appends.
 */
async function updateQueueLocked(
  dir: string,
  fn: (entries: QueueEntry[]) => QueueEntry[]
): Promise<void> {
  const key = `queue:${resolvePath(dir)}`;
  await withWriteLock(key, async () => {
    const entries = await readQueue(dir);
    const updated = fn(entries);
    const content = updated.map((e) => JSON.stringify(e)).join('\n');
    await atomicWrite(queueFilePath(dir), content ? content + '\n' : '');
  });
  notifyManagerUpdate(dir);
}

function queueEntryImagePaths(entry: QueueEntry | null): string[] {
  return entry?.attachments?.map((attachment) => attachment.path) ?? [];
}

function queueEntriesImagePaths(entries: QueueEntry[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const path of queueEntryImagePaths(entry)) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

function queueEntryIdSet(assignments: ManagerActiveAssignment[]): Set<string> {
  const ids = new Set<string>();
  for (const assignment of assignments) {
    for (const entryId of assignment.queueEntryIds) {
      ids.add(entryId);
    }
  }
  return ids;
}

function scopeLocksOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const leftScopes = left.map((entry) => normalizeWriteScope(entry));
  const rightScopes = right.map((entry) => normalizeWriteScope(entry));
  for (const a of leftScopes) {
    for (const b of rightScopes) {
      if (
        !a ||
        !b ||
        a === UNIVERSAL_WRITE_SCOPE ||
        b === UNIVERSAL_WRITE_SCOPE
      ) {
        return true;
      }

      const leftPrefix = `${a}/`;
      const rightPrefix = `${b}/`;
      if (a === b || a.startsWith(rightPrefix) || b.startsWith(leftPrefix)) {
        return true;
      }
    }
  }

  return false;
}

function buildThreadChildrenIndex(
  meta: Awaited<ReturnType<typeof readManagerThreadMeta>>
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [threadId, entry] of Object.entries(meta)) {
    const parents = normalizeStringArray(entry?.derivedFromThreadIds);
    for (const parentId of parents) {
      index.set(parentId, [...(index.get(parentId) ?? []), threadId]);
    }
  }
  return index;
}

function collectDescendantThreadIds(
  rootThreadIds: string[],
  childrenIndex: Map<string, string[]>
): Set<string> {
  const descendants = new Set<string>();
  const queue = [...rootThreadIds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    for (const childId of childrenIndex.get(current) ?? []) {
      if (descendants.has(childId)) {
        continue;
      }
      descendants.add(childId);
      queue.push(childId);
    }
  }
  return descendants;
}

function updateSessionAssignment(
  session: ManagerSession,
  assignmentId: string,
  updater: (current: ManagerActiveAssignment) => ManagerActiveAssignment | null
): ManagerSession {
  return {
    ...session,
    activeAssignments: session.activeAssignments.flatMap((assignment) => {
      if (assignment.id !== assignmentId) {
        return [assignment];
      }
      const next = updater(assignment);
      return next ? [next] : [];
    }),
  };
}

function replaceSessionAssignments(
  session: ManagerSession,
  activeAssignments: ManagerActiveAssignment[]
): ManagerSession {
  return {
    ...session,
    activeAssignments,
  };
}

async function reconcileActiveAssignments(
  dir: string
): Promise<ManagerSession> {
  const session = await readSession(dir);
  if (session.activeAssignments.length === 0) {
    return session;
  }

  const queue = await readQueue(dir);
  const queueById = new Map(queue.map((entry) => [entry.id, entry]));
  const survivingAssignments: ManagerActiveAssignment[] = [];
  const droppedAssignments: ManagerActiveAssignment[] = [];
  let mutated = false;
  for (const assignment of session.activeAssignments) {
    const resolvedThreadId =
      assignment.threadId && assignment.threadId !== 'unknown'
        ? assignment.threadId
        : (assignment.queueEntryIds
            .map((entryId) => queueById.get(entryId)?.threadId ?? null)
            .find((threadId): threadId is string => Boolean(threadId)) ??
          assignment.threadId);
    const normalizedAssignment =
      resolvedThreadId !== assignment.threadId
        ? { ...assignment, threadId: resolvedThreadId }
        : assignment;
    if (normalizedAssignment !== assignment) {
      mutated = true;
    }

    const latestObservedAt =
      parseMessageTimestamp(normalizedAssignment.lastProgressAt) ??
      parseMessageTimestamp(normalizedAssignment.startedAt) ??
      Number.NEGATIVE_INFINITY;
    const withinGraceWindow =
      Number.isFinite(latestObservedAt) &&
      Date.now() - latestObservedAt < MANAGER_RECONCILE_GRACE_MS;
    if (
      normalizedAssignment.pid !== null &&
      !isPidAlive(normalizedAssignment.pid) &&
      !withinGraceWindow
    ) {
      droppedAssignments.push(normalizedAssignment);
      continue;
    }
    survivingAssignments.push(normalizedAssignment);
  }

  if (droppedAssignments.length === 0 && !mutated) {
    return session;
  }

  const survivingThreadIds = new Set(
    survivingAssignments.map((assignment) => assignment.threadId)
  );
  for (const assignment of droppedAssignments) {
    if (survivingThreadIds.has(assignment.threadId)) {
      continue;
    }
    await clearWorkerLiveOutput(
      dir,
      assignment.threadId,
      null,
      assignment.assigneeLabel,
      {
        workerAgentId: assignment.id,
        runtimeState: null,
        runtimeDetail: null,
        workerWriteScopes: assignment.writeScopes,
        workerBlockedByThreadIds: [],
        supersededByThreadId: null,
      }
    );
  }

  const nextSession = replaceSessionAssignments(session, survivingAssignments);
  await writeSession(dir, nextSession);
  return readSession(dir);
}

function mergeQueuedEntryContent(entries: QueueEntry[]): string {
  if (entries.length <= 1) {
    return entries[0]?.content ?? '';
  }

  const contentParts: string[] = [];
  const attachments: ManagerMessageAttachment[] = [];
  for (const entry of entries) {
    const parsed = parseManagerMessage(entry.content);
    const markdown = parsed.markdown.trim();
    if (markdown) {
      contentParts.push(markdown);
    }
    attachments.push(...parsed.attachments);
  }

  return serializeManagerMessage({
    content: contentParts.join('\n\n'),
    attachments,
  });
}

function stripTrailingUserMessagesFromThread(thread: Thread): Thread {
  if (thread.messages.length === 0) {
    return thread;
  }

  let endIndex = thread.messages.length;
  while (endIndex > 0) {
    const message = thread.messages[endIndex - 1];
    if (!message || message.sender !== 'user') {
      break;
    }
    endIndex -= 1;
  }

  if (endIndex === thread.messages.length) {
    return thread;
  }

  return {
    ...thread,
    messages: thread.messages.slice(0, endIndex),
  };
}

/** Check whether a process with the given PID is still alive (zero-signal probe). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns the codex command used for spawning. */
export function resolveCodexCommand(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): string {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;

  const override = (
    env.WORKSPACE_AGENT_HUB_CODEX_PATH ??
    env.AGENT_CODEX_PATH ??
    env.CODEX_PATH ??
    ''
  ).trim();
  if (override) {
    return override;
  }

  if (platform === 'win32') {
    const roamingAppData =
      env.APPDATA?.trim() ||
      (env.USERPROFILE?.trim()
        ? join(env.USERPROFILE.trim(), 'AppData', 'Roaming')
        : '');
    if (roamingAppData) {
      const codexCmd = join(roamingAppData, 'npm', 'codex.cmd');
      if (exists(codexCmd)) {
        return codexCmd;
      }
    }
    return 'codex.cmd';
  }

  return 'codex';
}

/**
 * Build the CLI args for invoking Codex in non-interactive JSON mode.
 * First turn uses `codex exec`; follow-up turns use `codex exec resume <sessionId>`.
 */
export function buildCodexArgs(
  _prompt: string,
  sessionId: string | null,
  imagePaths: string[] = []
): string[] {
  const args: string[] = sessionId ? ['exec', 'resume', sessionId] : ['exec'];

  for (const imagePath of imagePaths) {
    args.push('--image', imagePath);
  }

  args.push(
    '--json',
    '--model',
    MANAGER_MODEL,
    '-c',
    `model_reasoning_effort="${MANAGER_REASONING_EFFORT}"`,
    '-'
  );
  return args;
}

export function shouldUseShellForCodexCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command.trim());
}

export function buildCodexSpawnOptions(
  command: string,
  resolvedDir: string,
  platform: NodeJS.Platform = process.platform
): {
  cwd: string;
  shell: boolean;
  windowsHide: boolean;
  stdio: ['pipe', 'pipe', 'pipe'];
} {
  return {
    cwd: resolvedDir,
    shell: shouldUseShellForCodexCommand(command, platform),
    windowsHide: platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

export function buildCodexSpawnSpec(
  command: string,
  args: string[],
  resolvedDir: string,
  options?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
  }
): {
  command: string;
  args: string[];
  spawnOptions: {
    cwd: string;
    shell: boolean;
    windowsHide: boolean;
    stdio: ['pipe', 'pipe', 'pipe'];
  };
} {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const exists = options?.exists ?? existsSync;

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command.trim())) {
    const commandDir = dirname(command);
    const nodeShimPath = join(commandDir, 'node.exe');
    const nodeBinary = exists(nodeShimPath) ? nodeShimPath : 'node';
    const scriptPath = join(
      commandDir,
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    );
    if (exists(scriptPath)) {
      return {
        command: nodeBinary,
        args: [scriptPath, ...args],
        spawnOptions: buildCodexSpawnOptions(nodeBinary, resolvedDir, platform),
      };
    }
  }

  return {
    command,
    args,
    spawnOptions: buildCodexSpawnOptions(command, resolvedDir, platform),
  };
}

/**
 * Build the prompt for codex.
 * First turn: include system context + workspace path.
 * Subsequent turns: just the message (codex retains context via exec resume).
 */
export function buildManagerReplyPrompt(
  content: string,
  threadId: string,
  resolvedDir: string,
  isFirstTurn: boolean
): string {
  if (!isFirstTurn) {
    return `[Topic: ${threadId}]\n${MANAGER_REPLY_JSON_RULES}\n\n${content}`;
  }
  return `${MANAGER_ROUTER_SYSTEM_PROMPT}\n${MANAGER_REPLY_JSON_RULES}\n\nWorkspace: ${resolvedDir}\n\n[Topic: ${threadId}]\n${content}`;
}

function formatThreadHistory(thread: Thread): string {
  if (thread.messages.length === 0) {
    return 'No previous messages in this topic.';
  }

  return thread.messages
    .slice(-12)
    .map((message) => {
      const sender = message.sender === 'ai' ? 'AI' : 'User';
      return `${sender}:\n${buildManagerMessagePromptContent(message.content).text}`;
    })
    .join('\n\n');
}

export function buildWorkerExecutionPrompt(input: {
  content: string;
  thread: Thread;
  resolvedDir: string;
  isFirstTurn: boolean;
}): string {
  const promptContent = buildManagerMessagePromptContent(input.content).text;
  if (!input.isFirstTurn) {
    return [
      `[Topic: ${input.thread.title}]`,
      MANAGER_WORKER_JSON_RULES,
      promptContent,
    ].join('\n\n');
  }

  return [
    MANAGER_WORKER_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${input.resolvedDir}`,
    `[Topic: ${input.thread.title}]`,
    'Topic history:',
    formatThreadHistory(input.thread),
    'New user request:',
    promptContent,
  ].join('\n\n');
}

function buildDispatchPrompt(input: {
  content: string;
  thread: Thread;
  resolvedDir: string;
  relatedActiveAssignments: ManagerActiveAssignment[];
}): string {
  const promptContent = buildManagerMessagePromptContent(input.content).text;
  const activeAssignments =
    input.relatedActiveAssignments.length === 0
      ? 'No running related worker agents.'
      : input.relatedActiveAssignments
          .map((assignment) =>
            [
              `- threadId: ${assignment.threadId}`,
              `  assignee: ${assignment.assigneeLabel}`,
              `  writeScopes: ${assignment.writeScopes.join(', ') || '(read-only)'}`,
            ].join('\n')
          )
          .join('\n');

  return [
    MANAGER_ROUTER_SYSTEM_PROMPT,
    'Return only strict JSON with keys {"assignee","status","reply","writeScopes","supersedesThreadIds","reason"}.',
    'Use assignee "manager" only when you can fully answer now without repository mutation, command execution, long investigation, or a separate worker agent.',
    'Use assignee "manager" for lightweight questions or clarifications you can answer immediately from the current work-item context and your own reasoning.',
    'Use assignee "worker" for anything that needs repository inspection, command execution, code changes, tests, substantial investigation, or a heavier question that should be delegated.',
    'When assignee is "manager", include status and reply.',
    'When assignee is "worker", include writeScopes as a short array of repo-relative write areas. Use an empty array only for truly read-only work.',
    'Only include supersedesThreadIds when the new work item is a descendant whose result would completely invalidate an already-running descendant task listed below.',
    `Workspace: ${input.resolvedDir}`,
    `[Work item: ${input.thread.title}]`,
    'Recent work-item history:',
    formatThreadHistory(input.thread),
    'New queued user request:',
    promptContent,
    'Running related worker agents:',
    activeAssignments,
  ].join('\n\n');
}

function parseManagerDispatchPayload(
  raw: string
): ManagerDispatchPayload | null {
  try {
    const normalized = stripMarkdownCodeFence(raw);
    const parsed = JSON.parse(normalized) as Partial<ManagerDispatchPayload>;
    if (parsed.assignee !== 'manager' && parsed.assignee !== 'worker') {
      return null;
    }
    if (parsed.assignee === 'manager') {
      if (
        (parsed.status !== 'active' &&
          parsed.status !== 'review' &&
          parsed.status !== 'needs-reply') ||
        typeof parsed.reply !== 'string' ||
        !parsed.reply.trim()
      ) {
        return null;
      }
    }
    return {
      assignee: parsed.assignee,
      status: parsed.status,
      reply: typeof parsed.reply === 'string' ? parsed.reply.trim() : undefined,
      writeScopes: normalizeWriteScopes(parsed.writeScopes),
      supersedesThreadIds: normalizeStringArray(parsed.supersedesThreadIds),
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : undefined,
    };
  } catch {
    return null;
  }
}

function buildRoutingPrompt(input: {
  content: string;
  resolvedDir: string;
  threads: Thread[];
  contextThreadId?: string | null;
  isFirstTurn: boolean;
}): {
  prompt: string;
  threadIdByTopicRef: Map<string, string>;
} {
  const topicRefs = input.threads.slice(0, 40).map((thread, index) => ({
    thread,
    topicRef: `topic-${index + 1}`,
  }));
  const threadIdByTopicRef = new Map(
    topicRefs.map((entry) => [entry.topicRef, entry.thread.id])
  );
  const threadSummary =
    topicRefs.length === 0
      ? 'No existing open topics.'
      : topicRefs
          .map((entry) => {
            const thread = entry.thread;
            const last = thread.messages.at(-1);
            const preview = last
              ? `${last.sender}: ${summarizeManagerMessage(last.content, 140)}`
              : 'no messages yet';
            return [
              `- topicRef: ${entry.topicRef}`,
              `  title: ${thread.title}`,
              `  status: ${thread.status}`,
              `  updatedAt: ${thread.updatedAt}`,
              `  preview: ${preview}`,
            ].join('\n');
          })
          .join('\n');

  const contextThread =
    input.contextThreadId === undefined || input.contextThreadId === null
      ? null
      : (topicRefs.find((entry) => entry.thread.id === input.contextThreadId)
          ?.thread ?? null);
  const contextBlock = contextThread
    ? `Current open topic mention hint: @${contextThread.title}. If you decide this really belongs to that topic, use its topicRef from the Existing open topics list. Treat this like a user mention hint, not a forced destination.`
    : input.contextThreadId
      ? 'There is a currently open topic, but its metadata was unavailable. Treat that only as a weak continuation hint and never mention internal IDs.'
      : 'No current open topic mention hint.';

  const body = [
    'Route the following freeform manager message into workspace topics.',
    MANAGER_ROUTING_JSON_RULES,
    `Workspace: ${input.resolvedDir}`,
    contextBlock,
    'Existing open topics:',
    threadSummary,
    'User message:',
    buildManagerMessagePromptContent(input.content).text,
  ].join('\n\n');

  const prompt = input.isFirstTurn
    ? `${MANAGER_ROUTER_SYSTEM_PROMPT}\n${body}`
    : body;
  return {
    prompt,
    threadIdByTopicRef,
  };
}

function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() ?? trimmed;
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFragments(entry));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const directText = collectTextFragments(record['text']);
  if (directText.length > 0) {
    return directText;
  }

  const messageText = collectTextFragments(record['message']);
  if (messageText.length > 0) {
    return messageText;
  }

  const contentText = collectTextFragments(record['content']);
  if (contentText.length > 0) {
    return contentText;
  }

  const partsText = collectTextFragments(record['parts']);
  if (partsText.length > 0) {
    return partsText;
  }

  return [];
}

export function isSessionInvalidError(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    (lower.includes('resume') &&
      (lower.includes('not found') ||
        lower.includes('invalid') ||
        lower.includes('expired'))) ||
    ((lower.includes('thread') || lower.includes('session')) &&
      (lower.includes('not found') ||
        lower.includes('does not exist') ||
        lower.includes('no such')))
  );
}

/**
 * Parse `codex exec --json` output.
 * Returns the final text reply and the Codex thread ID used for continuation.
 */
export function parseCodexOutput(stdout: string): {
  text: string;
  sessionId: string | null;
} {
  let sessionId: string | null = null;
  let latestText = '';
  const lines = stdout.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (
        obj['type'] === 'thread.started' &&
        typeof obj['thread_id'] === 'string'
      ) {
        sessionId = obj['thread_id'] as string;
        continue;
      }
      if (obj['type'] !== 'item.completed') {
        continue;
      }
      const item = obj['item'];
      if (!item || typeof item !== 'object') {
        continue;
      }
      const typedItem = item as Record<string, unknown>;
      const itemType = typedItem['type'];
      if (
        itemType === 'agent_message' ||
        itemType === 'assistant_message' ||
        itemType === 'message'
      ) {
        const fragments = collectTextFragments(typedItem);
        if (fragments.length > 0) {
          latestText = fragments.join('\n').trim();
        }
      }
    } catch {
      // Not JSON — skip
    }
  }
  return { text: latestText, sessionId };
}

function parseCodexProgressLine(line: string): CodexProgressState {
  const trimmed = line.trim();
  if (!trimmed) {
    return { sessionId: null, latestText: null, liveEntries: [] };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      parsed['type'] === 'thread.started' &&
      typeof parsed['thread_id'] === 'string'
    ) {
      const latestText =
        'AI が担当 worker を起動しました。内容を整理しています…';
      return {
        sessionId: parsed['thread_id'] as string,
        latestText,
        liveEntries: [
          {
            at: new Date().toISOString(),
            text: latestText,
            kind: 'status',
          },
        ],
      };
    }

    if (parsed['type'] !== 'item.completed') {
      return { sessionId: null, latestText: null, liveEntries: [] };
    }

    const item = parsed['item'];
    if (!item || typeof item !== 'object') {
      return { sessionId: null, latestText: null, liveEntries: [] };
    }

    const typedItem = item as Record<string, unknown>;
    const itemType = typedItem['type'];
    if (
      itemType === 'agent_message' ||
      itemType === 'assistant_message' ||
      itemType === 'message'
    ) {
      const fragments = collectTextFragments(typedItem);
      const combined =
        fragments.length > 0 ? fragments.join('\n').trim() : null;
      const parsedReply = combined ? parseManagerReplyPayload(combined) : null;
      const latestText = parsedReply?.reply ?? combined;
      return {
        sessionId: null,
        latestText,
        liveEntries:
          latestText === null
            ? []
            : [
                {
                  at: new Date().toISOString(),
                  text: latestText,
                  kind: 'output',
                },
              ],
      };
    }

    const genericText = 'AI が作業を進めています…';
    return {
      sessionId: null,
      latestText: genericText,
      liveEntries: [
        {
          at: new Date().toISOString(),
          text: genericText,
          kind: 'status',
        },
      ],
    };
  } catch {
    return { sessionId: null, latestText: null, liveEntries: [] };
  }
}

export function parseManagerReplyPayload(
  text: string
): ManagerReplyPayload | null {
  const normalized = stripMarkdownCodeFence(text);
  try {
    const parsed = JSON.parse(normalized) as Partial<ManagerReplyPayload>;
    const status =
      parsed.status === 'active' ||
      parsed.status === 'needs-reply' ||
      parsed.status === 'review'
        ? parsed.status
        : null;
    const reply =
      typeof parsed.reply === 'string' ? parsed.reply.trim() : undefined;
    if (!status || !reply) {
      return null;
    }
    return { status, reply };
  } catch {
    return null;
  }
}

export function parseManagerRoutingPlan(
  text: string
): ManagerRoutingPlan | null {
  const normalized = stripMarkdownCodeFence(text);
  try {
    const parsed = JSON.parse(normalized) as Partial<ManagerRoutingPlan>;
    if (!Array.isArray(parsed.actions)) {
      return null;
    }
    const actions = parsed.actions.flatMap((value) => {
      if (!value || typeof value !== 'object') {
        return [];
      }
      const action = value as Partial<ManagerRoutingAction>;
      const kind = action.kind;
      const content =
        typeof action.content === 'string' ? action.content.trim() : '';
      if (
        kind !== 'attach-existing' &&
        kind !== 'create-new' &&
        kind !== 'routing-confirmation' &&
        kind !== 'resolve-existing'
      ) {
        return [];
      }
      if (!content) {
        return [];
      }
      return [
        {
          kind,
          topicRef:
            typeof action.topicRef === 'string'
              ? action.topicRef.trim()
              : undefined,
          threadId:
            typeof action.threadId === 'string'
              ? action.threadId.trim()
              : undefined,
          title:
            typeof action.title === 'string' ? action.title.trim() : undefined,
          originalText:
            typeof action.originalText === 'string'
              ? action.originalText.trim()
              : undefined,
          content,
          reason:
            typeof action.reason === 'string'
              ? action.reason.trim()
              : undefined,
          question:
            typeof action.question === 'string'
              ? action.question.trim()
              : undefined,
        } satisfies ManagerRoutingAction,
      ];
    });

    if (actions.length === 0) {
      return null;
    }
    return { actions };
  } catch {
    return null;
  }
}

function normalizeForRoutingMatch(text: string): string {
  return parseManagerMessage(text).markdown.replace(/\s+/g, ' ').trim();
}

export function pickThreadUserMessage(
  fullInput: string,
  action: ManagerRoutingAction,
  totalActions: number
): string {
  const parsedFull = parseManagerMessage(fullInput);
  const normalizedFull = normalizeForRoutingMatch(fullInput);
  const originalText = action.originalText?.trim();
  let selectedContent = '';
  const shouldPreferStandaloneContent =
    action.kind === 'create-new' || action.kind === 'routing-confirmation';
  const content = action.content.trim();
  if (
    !shouldPreferStandaloneContent &&
    originalText &&
    normalizedFull.includes(normalizeForRoutingMatch(originalText))
  ) {
    selectedContent = originalText;
  } else if (shouldPreferStandaloneContent && content) {
    selectedContent = content;
  } else {
    if (content && normalizedFull.includes(normalizeForRoutingMatch(content))) {
      selectedContent = content;
    } else if (totalActions === 1) {
      selectedContent = parsedFull.markdown.trim();
    } else {
      selectedContent = content;
    }
  }

  return serializeManagerMessage({
    content: selectedContent,
    attachments: parsedFull.attachments,
  });
}

function shortenThreadLabel(text: string, maxLength = 28): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function makeDerivedThreadTitle(parentTitle: string, content: string): string {
  const base = makeFallbackThreadTitle(content);
  const parentLabel = shortenThreadLabel(parentTitle);
  if (!base) {
    return `「${parentLabel}」から派生`;
  }
  if (base.includes(parentLabel)) {
    return base;
  }
  const suffix = `（「${parentLabel}」から派生）`;
  const maxBaseLength = Math.max(12, 72 - suffix.length);
  const clippedBase =
    base.length > maxBaseLength
      ? `${base.slice(0, Math.max(0, maxBaseLength - 1)).trimEnd()}…`
      : base;
  return `${clippedBase}${suffix}`;
}

function buildDerivedThreadUserMessage(input: {
  fullInput: string;
  action: ManagerRoutingAction;
  totalActions: number;
  parentThread: Thread;
}): string {
  const baseMessage = pickThreadUserMessage(
    input.fullInput,
    input.action,
    input.totalActions
  );
  const parsed = parseManagerMessage(baseMessage);
  const markdown = parsed.markdown.trim();
  const parentTitle = input.parentThread.title.trim();

  if (
    markdown.includes('派生元作業項目:') ||
    (parentTitle && markdown.includes(parentTitle))
  ) {
    return baseMessage;
  }

  const parentSummary = summarizeManagerMessage(
    input.parentThread.messages.at(-1)?.content ?? input.parentThread.title,
    160
  );

  return serializeManagerMessage({
    content: [
      `派生元作業項目: 「${parentTitle}」`,
      `直前の要点: ${parentSummary}`,
      '',
      markdown,
    ].join('\n'),
    attachments: parsed.attachments,
  });
}

async function shouldKeepUserMessageInSameTopic(input: {
  dir: string;
  resolvedDir: string;
  threadId: string;
}): Promise<{
  keepSameTopic: boolean;
  thread: Thread | null;
}> {
  const [thread, meta] = await Promise.all([
    getThread(input.dir, input.threadId),
    readManagerThreadMeta(input.resolvedDir),
  ]);
  const threadMeta = meta[input.threadId] ?? null;
  return {
    keepSameTopic:
      Boolean(threadMeta?.routingConfirmationNeeded) ||
      thread?.status === 'needs-reply',
    thread,
  };
}

async function runCodexTurn(input: {
  dir: string;
  resolvedDir: string;
  prompt: string;
  sessionId: string | null;
  imagePaths?: string[];
  onSpawn?: (pid: number | null) => void | Promise<void>;
  onProgress?: (state: CodexProgressState) => void | Promise<void>;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  parsed: { text: string; sessionId: string | null };
}> {
  const codexCommand = resolveCodexCommand();
  const args = buildCodexArgs(
    input.prompt,
    input.sessionId,
    input.imagePaths ?? []
  );
  const spawnSpec = buildCodexSpawnSpec(codexCommand, args, input.resolvedDir);
  const proc = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.spawnOptions);
  await input.onSpawn?.(proc.pid ?? null);

  let stdout = '';
  let stderr = '';
  let pendingStdout = '';
  let latestProgressText: string | null = null;
  let latestProgressSessionId: string | null = input.sessionId;
  let progressChain = Promise.resolve();

  const enqueueProgress = (state: CodexProgressState): void => {
    progressChain = progressChain
      .then(async () => {
        await input.onProgress?.(state);
      })
      .catch(() => {
        /* ignore progress callback failures */
      });
  };

  const handleProgressLine = (line: string): void => {
    const progress = parseCodexProgressLine(line);
    if (progress.sessionId) {
      latestProgressSessionId = progress.sessionId;
    }
    if (progress.latestText) {
      latestProgressText = progress.latestText;
      enqueueProgress({
        sessionId: latestProgressSessionId,
        latestText: latestProgressText,
        liveEntries: progress.liveEntries,
      });
    }
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stdout += text;
    pendingStdout += text;

    const lines = pendingStdout.split(/\r?\n/);
    pendingStdout = lines.pop() ?? '';

    for (const line of lines) {
      handleProgressLine(line);
    }

    const pendingTrimmed = pendingStdout.trim();
    if (!pendingTrimmed) {
      return;
    }
    try {
      JSON.parse(pendingTrimmed);
      handleProgressLine(pendingTrimmed);
      pendingStdout = '';
    } catch {
      /* keep waiting for the rest of the line */
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (!latestProgressText) {
      latestProgressText = 'AI が作業を進めています…';
      enqueueProgress({
        sessionId: latestProgressSessionId,
        latestText: latestProgressText,
        liveEntries: [
          {
            at: new Date().toISOString(),
            text: latestProgressText,
            kind: 'status',
          },
        ],
      });
    }
  });
  proc.stdin?.on('error', () => {
    /* ignore prompt pipe teardown races */
  });
  proc.stdin?.write(input.prompt);
  proc.stdin?.end();

  const exitCode = await new Promise<number | null>(
    (resolvePromise, reject) => {
      proc.on('error', (error) => {
        reject(error);
      });
      proc.on('close', (code) => {
        resolvePromise(code);
      });
    }
  );

  if (pendingStdout.trim()) {
    handleProgressLine(pendingStdout);
  }

  await progressChain;

  return {
    code: exitCode,
    stdout,
    stderr,
    parsed: parseCodexOutput(stdout),
  };
}

// Per-workspace in-flight guard (module-level singleton, safe for single server process).
const inFlight = new Set<string>();
const rerunRequested = new Set<string>();
const routingLocks = new Map<string, Promise<void>>();

function makeFallbackThreadTitle(content: string): string {
  const normalized = extractManagerMessagePlainText(content);
  if (!normalized) {
    return '新しい話題';
  }
  return normalized.slice(0, 48);
}

async function withRoutingLock<T>(
  resolvedDir: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = routingLocks.get(resolvedDir) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  routingLocks.set(resolvedDir, gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (routingLocks.get(resolvedDir) === gate) {
      routingLocks.delete(resolvedDir);
    }
  }
}

async function ensureThreadReadyForUserMessage(
  dir: string,
  threadId: string
): Promise<void> {
  const threads = await listThreads(dir);
  const found = threads.find((thread) => thread.id === threadId);
  if (found?.status === 'resolved') {
    await reopenThread(dir, threadId);
  }
}

async function readWorkerSessionId(
  dir: string,
  threadId: string
): Promise<string | null> {
  const meta = await readManagerThreadMeta(dir);
  return meta[threadId]?.workerSessionId?.trim() || null;
}

async function writeWorkerSessionId(
  dir: string,
  threadId: string,
  workerSessionId: string | null
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, (current) => ({
    ...(current ?? {}),
    workerSessionId,
    workerLastStartedAt: new Date().toISOString(),
  }));
}

const MAX_WORKER_LIVE_LOG_ENTRIES = 120;
const MAX_WORKER_LIVE_LOG_CHARS = 24_000;

function normalizeWorkerLiveLogValue(
  value: ManagerWorkerLiveEntry[] | null | undefined
): ManagerWorkerLiveEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry?.text?.trim() || !entry?.at?.trim()) {
      return [];
    }
    return [
      {
        at: entry.at.trim(),
        text: entry.text.trim(),
        kind:
          entry.kind === 'status' ||
          entry.kind === 'output' ||
          entry.kind === 'error'
            ? entry.kind
            : 'output',
      } satisfies ManagerWorkerLiveEntry,
    ];
  });
}

function pruneWorkerLiveLog(
  entries: ManagerWorkerLiveEntry[]
): ManagerWorkerLiveEntry[] {
  const next = [...entries];
  let totalChars = next.reduce((sum, entry) => sum + entry.text.length, 0);
  while (
    next.length > MAX_WORKER_LIVE_LOG_ENTRIES ||
    totalChars > MAX_WORKER_LIVE_LOG_CHARS
  ) {
    const removed = next.shift();
    totalChars -= removed?.text.length ?? 0;
  }
  return next;
}

function latestWorkerLiveState(entries: ManagerWorkerLiveEntry[]): {
  workerLiveOutput: string | null;
  workerLiveAt: string | null;
} {
  const latest = entries[entries.length - 1] ?? null;
  return {
    workerLiveOutput: latest?.text ?? null,
    workerLiveAt: latest?.at ?? null,
  };
}

async function setWorkerRuntimeState(input: {
  dir: string;
  threadId: string;
  assigneeKind?: 'manager' | 'worker' | null;
  assigneeLabel?: string | null;
  workerSessionId?: string | null;
  workerAgentId?: string | null;
  runtimeState?: ManagerWorkerRuntimeState | null;
  runtimeDetail?: string | null;
  workerWriteScopes?: string[] | null;
  workerBlockedByThreadIds?: string[] | null;
  supersededByThreadId?: string | null;
  clearWorkerLiveLog?: boolean;
}): Promise<void> {
  await updateManagerThreadMeta(input.dir, input.threadId, (current) => {
    const currentLog = input.clearWorkerLiveLog
      ? []
      : normalizeWorkerLiveLogValue(current?.workerLiveLog);
    return {
      ...(current ?? {}),
      workerSessionId:
        input.workerSessionId ?? current?.workerSessionId ?? null,
      workerLastStartedAt:
        current?.workerLastStartedAt ?? new Date().toISOString(),
      assigneeKind:
        input.assigneeKind === undefined
          ? (current?.assigneeKind ?? 'worker')
          : input.assigneeKind,
      assigneeLabel:
        input.assigneeLabel === undefined
          ? (current?.assigneeLabel ??
            `Worker agent ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`)
          : input.assigneeLabel,
      workerAgentId:
        input.workerAgentId === undefined
          ? (current?.workerAgentId ?? null)
          : input.workerAgentId,
      workerRuntimeState:
        input.runtimeState === undefined
          ? (current?.workerRuntimeState ?? null)
          : input.runtimeState,
      workerRuntimeDetail:
        input.runtimeDetail === undefined
          ? (current?.workerRuntimeDetail ?? null)
          : input.runtimeDetail,
      workerWriteScopes:
        input.workerWriteScopes === undefined
          ? (current?.workerWriteScopes ?? [])
          : (input.workerWriteScopes ?? []),
      workerBlockedByThreadIds:
        input.workerBlockedByThreadIds === undefined
          ? (current?.workerBlockedByThreadIds ?? [])
          : (input.workerBlockedByThreadIds ?? []),
      supersededByThreadId:
        input.supersededByThreadId === undefined
          ? (current?.supersededByThreadId ?? null)
          : input.supersededByThreadId,
      workerLiveLog: currentLog.length > 0 ? currentLog : null,
      ...latestWorkerLiveState(currentLog),
    };
  });
}

async function appendWorkerLiveOutput(input: {
  dir: string;
  threadId: string;
  text: string;
  kind?: ManagerWorkerLiveEntry['kind'];
  assigneeKind?: 'manager' | 'worker' | null;
  assigneeLabel?: string | null;
  workerSessionId?: string | null;
  workerAgentId?: string | null;
  runtimeState?: ManagerWorkerRuntimeState | null;
  runtimeDetail?: string | null;
  workerWriteScopes?: string[] | null;
  workerBlockedByThreadIds?: string[] | null;
  supersededByThreadId?: string | null;
}): Promise<void> {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return;
  }
  await updateManagerThreadMeta(input.dir, input.threadId, (current) => {
    const currentLog = normalizeWorkerLiveLogValue(current?.workerLiveLog);
    const latest = currentLog[currentLog.length - 1] ?? null;
    const timestamp = new Date().toISOString();
    const nextLog =
      latest?.text === trimmed && latest.kind === (input.kind ?? 'output')
        ? currentLog.map((entry, index) =>
            index === currentLog.length - 1
              ? { ...entry, at: timestamp }
              : entry
          )
        : pruneWorkerLiveLog([
            ...currentLog,
            {
              at: timestamp,
              text: trimmed,
              kind: input.kind ?? 'output',
            } satisfies ManagerWorkerLiveEntry,
          ]);
    return {
      ...(current ?? {}),
      workerSessionId:
        input.workerSessionId ?? current?.workerSessionId ?? null,
      workerLastStartedAt:
        current?.workerLastStartedAt ?? new Date().toISOString(),
      assigneeKind:
        input.assigneeKind === undefined
          ? (current?.assigneeKind ?? 'worker')
          : input.assigneeKind,
      assigneeLabel:
        input.assigneeLabel === undefined
          ? (current?.assigneeLabel ??
            `Worker agent ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`)
          : input.assigneeLabel,
      workerAgentId:
        input.workerAgentId === undefined
          ? (current?.workerAgentId ?? null)
          : input.workerAgentId,
      workerRuntimeState:
        input.runtimeState === undefined
          ? (current?.workerRuntimeState ?? null)
          : input.runtimeState,
      workerRuntimeDetail:
        input.runtimeDetail === undefined
          ? (current?.workerRuntimeDetail ?? null)
          : input.runtimeDetail,
      workerWriteScopes:
        input.workerWriteScopes === undefined
          ? (current?.workerWriteScopes ?? [])
          : (input.workerWriteScopes ?? []),
      workerBlockedByThreadIds:
        input.workerBlockedByThreadIds === undefined
          ? (current?.workerBlockedByThreadIds ?? [])
          : (input.workerBlockedByThreadIds ?? []),
      supersededByThreadId:
        input.supersededByThreadId === undefined
          ? (current?.supersededByThreadId ?? null)
          : input.supersededByThreadId,
      workerLiveLog: nextLog,
      ...latestWorkerLiveState(nextLog),
    };
  });
}

async function clearWorkerLiveOutput(
  dir: string,
  threadId: string,
  assigneeKind: 'manager' | 'worker' | null = null,
  assigneeLabel: string | null = null,
  options?: {
    workerAgentId?: string | null;
    runtimeState?: ManagerWorkerRuntimeState | null;
    runtimeDetail?: string | null;
    workerWriteScopes?: string[] | null;
    workerBlockedByThreadIds?: string[] | null;
    supersededByThreadId?: string | null;
  }
): Promise<void> {
  await setWorkerRuntimeState({
    dir,
    threadId,
    assigneeKind,
    assigneeLabel,
    workerAgentId: options?.workerAgentId,
    runtimeState: options?.runtimeState,
    runtimeDetail: options?.runtimeDetail,
    workerWriteScopes: options?.workerWriteScopes,
    workerBlockedByThreadIds: options?.workerBlockedByThreadIds,
    supersededByThreadId: options?.supersededByThreadId,
    clearWorkerLiveLog: true,
  });
}

async function reserveAssignment(input: {
  dir: string;
  assignment: ManagerActiveAssignment;
  priorityStreak: number;
}): Promise<void> {
  const session = await readSession(input.dir);
  await writeSession(input.dir, {
    ...session,
    activeAssignments: [...session.activeAssignments, input.assignment],
    lastMessageAt: new Date().toISOString(),
    priorityStreak: input.priorityStreak,
    lastErrorMessage: null,
    lastErrorAt: null,
  });
}

async function removeAssignment(
  dir: string,
  assignmentId: string
): Promise<ManagerSession> {
  const session = await readSession(dir);
  const nextSession = updateSessionAssignment(
    session,
    assignmentId,
    () => null
  );
  await writeSession(dir, nextSession);
  return readSession(dir);
}

async function patchAssignment(
  dir: string,
  assignmentId: string,
  updater: (current: ManagerActiveAssignment) => ManagerActiveAssignment | null
): Promise<ManagerSession> {
  const session = await readSession(dir);
  const nextSession = updateSessionAssignment(session, assignmentId, updater);
  await writeSession(dir, nextSession);
  return readSession(dir);
}

function parseMessageTimestamp(
  value: string | null | undefined
): number | null {
  if (!value?.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function hasSupersedingAiReply(thread: Thread, entries: QueueEntry[]): boolean {
  if (entries.length === 0 || thread.messages.length === 0) {
    return false;
  }

  const latestCreatedAt = Math.max(
    ...entries
      .map((entry) => parseMessageTimestamp(entry.createdAt))
      .filter((value): value is number => value !== null)
  );
  if (!Number.isFinite(latestCreatedAt)) {
    return false;
  }

  const lastMessage = thread.messages.at(-1);
  if (lastMessage?.sender !== 'ai') {
    return false;
  }

  const latestUserAfterQueuedAt = Math.max(
    ...thread.messages
      .filter((message) => message.sender === 'user')
      .map((message) => parseMessageTimestamp(message.at))
      .filter(
        (value): value is number => value !== null && value > latestCreatedAt
      ),
    Number.NEGATIVE_INFINITY
  );
  if (!Number.isFinite(latestUserAfterQueuedAt)) {
    return false;
  }

  const lastAiAt = parseMessageTimestamp(lastMessage.at);
  return lastAiAt !== null && lastAiAt > latestUserAfterQueuedAt;
}

async function decideDispatchForBatch(input: {
  dir: string;
  resolvedDir: string;
  thread: Thread;
  entries: QueueEntry[];
  relatedActiveAssignments: ManagerActiveAssignment[];
}): Promise<ManagerDispatchPayload> {
  const prompt = buildDispatchPrompt({
    content: mergeQueuedEntryContent(input.entries),
    thread: stripTrailingUserMessagesFromThread(input.thread),
    resolvedDir: input.resolvedDir,
    relatedActiveAssignments: input.relatedActiveAssignments,
  });
  const runResult = await runCodexTurn({
    dir: input.dir,
    resolvedDir: input.resolvedDir,
    prompt,
    sessionId: null,
    imagePaths: queueEntriesImagePaths(input.entries),
  });
  if (runResult.code !== 0) {
    throw new Error(
      runResult.stderr.trim() ||
        runResult.stdout.trim() ||
        `codex CLI exited with code ${runResult.code ?? '?'}`
    );
  }

  const parsed = parseManagerDispatchPayload(runResult.parsed.text);
  if (!parsed) {
    return {
      assignee: 'worker',
      writeScopes: [UNIVERSAL_WRITE_SCOPE],
      reason: 'dispatch-fallback',
    };
  }

  if (parsed.assignee === 'worker' && (parsed.writeScopes?.length ?? 0) === 0) {
    return {
      ...parsed,
      writeScopes: [UNIVERSAL_WRITE_SCOPE],
    };
  }

  return parsed;
}

function defaultAssigneeLabel(kind: 'manager' | 'worker'): string {
  return kind === 'manager'
    ? `Manager ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`
    : `Worker agent ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`;
}

function blockingScopeDetail(input: {
  blockingAssignments: ManagerActiveAssignment[];
  threadById: Map<string, Thread>;
}): string {
  const labels = input.blockingAssignments.map((assignment) => {
    const thread = input.threadById.get(assignment.threadId);
    return thread?.title ?? assignment.threadId;
  });
  const list =
    labels.length <= 2
      ? labels.join('、')
      : `${labels.slice(0, 2).join('、')} ほか${labels.length - 2}件`;
  return list
    ? `別の worker agent と書き込み範囲が重なるため待機しています (${list})。`
    : '別の worker agent と書き込み範囲が重なるため待機しています。';
}

async function stopSupersededAssignments(input: {
  dir: string;
  supersedingThreadId: string;
  supersedingThreadTitle: string;
  supersededAssignments: ManagerActiveAssignment[];
}): Promise<void> {
  for (const assignment of input.supersededAssignments) {
    if (assignment.pid !== null) {
      try {
        process.kill(assignment.pid);
      } catch {
        /* ignore already-exited processes */
      }
    }

    await updateQueueLocked(input.dir, (queue) =>
      queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
    );
    await removeAssignment(input.dir, assignment.id);
    await clearWorkerLiveOutput(
      input.dir,
      assignment.threadId,
      assignment.assigneeKind,
      assignment.assigneeLabel,
      {
        workerAgentId: assignment.id,
        runtimeState: 'cancelled-as-superseded',
        runtimeDetail: `「${input.supersedingThreadTitle}」の新しい派生作業で全面的に置き換わるため、この worker agent を停止しました。`,
        workerWriteScopes: assignment.writeScopes,
        supersededByThreadId: input.supersedingThreadId,
      }
    );
    try {
      await addMessage(
        input.dir,
        assignment.threadId,
        `この作業項目は、新しく派生した「${input.supersedingThreadTitle}」の内容で既存成果が置き換わると判断したため、途中の担当 worker を止めました。`,
        'ai',
        'active'
      );
    } catch {
      /* thread may have been deleted */
    }
  }
}

/**
 * Run one reserved manager/worker assignment to completion in the background.
 */
async function runQueuedAssignment(input: {
  dir: string;
  resolvedDir: string;
  assignment: ManagerActiveAssignment;
  thread: Thread;
  entries: QueueEntry[];
}): Promise<void> {
  const { dir, resolvedDir, assignment, thread, entries } = input;
  const promptContent = mergeQueuedEntryContent(entries);
  const promptThread = stripTrailingUserMessagesFromThread(thread);
  let workerSessionId = await readWorkerSessionId(resolvedDir, thread.id);
  const runtimeState: ManagerWorkerRuntimeState =
    assignment.assigneeKind === 'manager'
      ? 'manager-answering'
      : 'worker-running';
  const runtimeDetail =
    assignment.assigneeKind === 'manager'
      ? 'Manager がこの作業項目を直接処理しています。'
      : '担当 worker agent がこの作業項目を実行中です。';
  let lastLiveOutput =
    assignment.assigneeKind === 'manager'
      ? 'AI が内容を整理して返答を準備しています…'
      : 'AI が担当 worker を起動しました。内容を整理しています…';

  await setWorkerRuntimeState({
    dir: resolvedDir,
    threadId: thread.id,
    assigneeKind: assignment.assigneeKind,
    assigneeLabel: assignment.assigneeLabel,
    workerSessionId,
    workerAgentId: assignment.id,
    runtimeState,
    runtimeDetail,
    workerWriteScopes: assignment.writeScopes,
    workerBlockedByThreadIds: [],
    supersededByThreadId: null,
    clearWorkerLiveLog: true,
  });
  await appendWorkerLiveOutput({
    dir: resolvedDir,
    threadId: thread.id,
    text: lastLiveOutput,
    kind: 'status',
    assigneeKind: assignment.assigneeKind,
    assigneeLabel: assignment.assigneeLabel,
    workerSessionId,
    workerAgentId: assignment.id,
    runtimeState,
    runtimeDetail,
    workerWriteScopes: assignment.writeScopes,
  });

  const runTurn = async (
    currentSessionId: string | null,
    isFirstTurn: boolean
  ) =>
    runCodexTurn({
      dir,
      resolvedDir,
      prompt:
        assignment.assigneeKind === 'manager'
          ? buildManagerReplyPrompt(
              promptContent,
              thread.title,
              resolvedDir,
              isFirstTurn
            )
          : buildWorkerExecutionPrompt({
              content: promptContent,
              thread: promptThread,
              resolvedDir,
              isFirstTurn,
            }),
      sessionId: currentSessionId,
      imagePaths: queueEntriesImagePaths(entries),
      onSpawn: async (pid) => {
        await patchAssignment(dir, assignment.id, (current) => ({
          ...current,
          pid,
          lastProgressAt: new Date().toISOString(),
        }));
        await touchManagerProgress(dir);
      },
      onProgress: async (progress) => {
        const nextText =
          progress.latestText?.trim() || 'AI が作業を進めています…';
        const progressEntries =
          progress.liveEntries.length > 0
            ? progress.liveEntries
            : [
                {
                  at: new Date().toISOString(),
                  text: nextText,
                  kind: 'output' as const,
                },
              ];
        const latestProgressEntry =
          progressEntries[progressEntries.length - 1] ?? null;
        if (latestProgressEntry?.text === lastLiveOutput) {
          return;
        }
        lastLiveOutput = latestProgressEntry?.text ?? nextText;
        for (const entry of progressEntries) {
          await appendWorkerLiveOutput({
            dir: resolvedDir,
            threadId: thread.id,
            text: entry.text,
            kind: entry.kind,
            assigneeKind: assignment.assigneeKind,
            assigneeLabel: assignment.assigneeLabel,
            workerSessionId: progress.sessionId ?? currentSessionId,
            workerAgentId: assignment.id,
            runtimeState,
            runtimeDetail,
            workerWriteScopes: assignment.writeScopes,
          });
        }
        await patchAssignment(dir, assignment.id, (current) => ({
          ...current,
          lastProgressAt: new Date().toISOString(),
        }));
        await touchManagerProgress(dir);
      },
    });

  try {
    let runResult = await runTurn(workerSessionId, workerSessionId === null);
    const firstCombinedOutput = `${runResult.stdout}\n${runResult.stderr}`;
    if (
      assignment.assigneeKind === 'worker' &&
      runResult.code !== 0 &&
      workerSessionId &&
      isSessionInvalidError(firstCombinedOutput)
    ) {
      await writeWorkerSessionId(resolvedDir, thread.id, null);
      workerSessionId = null;
      runResult = await runTurn(null, true);
    }

    const stillTracked = (await readSession(dir)).activeAssignments.some(
      (current) => current.id === assignment.id
    );
    if (!stillTracked) {
      return;
    }

    const combinedOutput = `${runResult.stdout}\n${runResult.stderr}`;
    const parsedReply = parseManagerReplyPayload(runResult.parsed.text);
    const fallbackReply =
      runResult.code === 0 && runResult.parsed.text
        ? runResult.parsed.text
        : null;

    if (runResult.code === 0 && (parsedReply || fallbackReply)) {
      await updateQueueLocked(dir, (queue) =>
        queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
      );
      try {
        await addMessage(
          resolvedDir,
          thread.id,
          parsedReply?.reply ?? fallbackReply ?? '',
          'ai',
          parsedReply?.status ?? MANAGER_REPLY_STATUS
        );
      } catch {
        /* thread may have been deleted */
      }
      await writeWorkerSessionId(
        resolvedDir,
        thread.id,
        runResult.parsed.sessionId ?? workerSessionId
      );
      await clearWorkerLiveOutput(
        resolvedDir,
        thread.id,
        assignment.assigneeKind,
        assignment.assigneeLabel,
        {
          workerAgentId: assignment.id,
          runtimeState: null,
          runtimeDetail: null,
          workerWriteScopes: assignment.writeScopes,
          workerBlockedByThreadIds: [],
          supersededByThreadId: null,
        }
      );
      await removeAssignment(dir, assignment.id);
      void processNextQueued(dir, resolvedDir);
      return;
    }

    const errMsg =
      runResult.code === 0
        ? '[Manager error] codex finished successfully but no usable assistant reply could be parsed from the JSON output.'
        : `[Manager error] codex CLI exited with code ${runResult.code ?? '?'}.${runResult.stderr ? `\n${runResult.stderr.slice(0, 300)}` : ''}`;
    try {
      await addMessage(resolvedDir, thread.id, errMsg, 'ai', 'needs-reply');
    } catch {
      /* thread may have been deleted */
    }
    await setManagerRuntimeError(dir, errMsg);
    await updateQueueLocked(dir, (queue) =>
      queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
    );
    if (isSessionInvalidError(combinedOutput)) {
      await writeWorkerSessionId(resolvedDir, thread.id, null);
    }
    await clearWorkerLiveOutput(
      resolvedDir,
      thread.id,
      assignment.assigneeKind,
      assignment.assigneeLabel,
      {
        workerAgentId: assignment.id,
        runtimeState: null,
        runtimeDetail: null,
        workerWriteScopes: assignment.writeScopes,
        workerBlockedByThreadIds: [],
        supersededByThreadId: null,
      }
    );
    await removeAssignment(dir, assignment.id);
    void processNextQueued(dir, resolvedDir);
  } catch (error) {
    const stillTracked = (await readSession(dir)).activeAssignments.some(
      (current) => current.id === assignment.id
    );
    if (!stillTracked) {
      return;
    }

    const errMsg =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? '[Manager error] `codex` CLI not found in PATH. Install Codex CLI to use the built-in manager backend.'
        : `[Manager error] Failed to start codex: ${error instanceof Error ? error.message : String(error)}`;
    try {
      await addMessage(resolvedDir, thread.id, errMsg, 'ai', 'needs-reply');
    } catch {
      /* thread may have been deleted */
    }
    await setManagerRuntimeError(dir, errMsg);
    await updateQueueLocked(dir, (queue) =>
      queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
    );
    await clearWorkerLiveOutput(
      resolvedDir,
      thread.id,
      assignment.assigneeKind,
      assignment.assigneeLabel,
      {
        workerAgentId: assignment.id,
        runtimeState: null,
        runtimeDetail: null,
        workerWriteScopes: assignment.writeScopes,
        workerBlockedByThreadIds: [],
        supersededByThreadId: null,
      }
    );
    await removeAssignment(dir, assignment.id);
    void processNextQueued(dir, resolvedDir);
  }
}

export async function processNextQueued(
  dir: string,
  resolvedDir: string
): Promise<void> {
  if (inFlight.has(resolvedDir)) {
    rerunRequested.add(resolvedDir);
    return;
  }
  inFlight.add(resolvedDir);

  try {
    let session = await reconcileActiveAssignments(dir);
    if (session.status === 'not-started') {
      return;
    }

    const queue = await readQueue(dir);
    const activeQueueIds = queueEntryIdSet(session.activeAssignments);
    const dispatchPlan = buildQueueDispatchPlan(
      queue.filter(
        (entry: QueueEntry) => !entry.processed && !activeQueueIds.has(entry.id)
      ),
      session
    );
    if (dispatchPlan.length === 0) {
      return;
    }

    const meta = await readManagerThreadMeta(resolvedDir);
    const childrenIndex = buildThreadChildrenIndex(meta);
    const threads = await listThreads(resolvedDir);
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    let activeWorkerAssignments = session.activeAssignments.filter(
      (assignment: ManagerActiveAssignment) =>
        assignment.assigneeKind === 'worker'
    ).length;
    let activeManagerAssignments = session.activeAssignments.filter(
      (assignment: ManagerActiveAssignment) =>
        assignment.assigneeKind === 'manager'
    ).length;
    let reservedWorkerScopes = session.activeAssignments
      .filter(
        (assignment: ManagerActiveAssignment) =>
          assignment.assigneeKind === 'worker'
      )
      .flatMap((assignment: ManagerActiveAssignment) => assignment.writeScopes);
    let priorityStreak = session.priorityStreak;
    const startedEntryIds = new Set<string>();

    for (const batch of dispatchPlan) {
      const nextEntries = batch.entries;
      const next = nextEntries[0];
      if (!next) {
        continue;
      }
      const batchIds = nextEntries.map((entry) => entry.id);
      const thread =
        threadById.get(next.threadId) ??
        (await getThread(resolvedDir, next.threadId));
      if (!thread) {
        await updateQueueLocked(dir, (currentQueue) =>
          currentQueue.filter((entry) => !batchIds.includes(entry.id))
        );
        continue;
      }

      if (hasSupersedingAiReply(thread, nextEntries)) {
        await updateQueueLocked(dir, (currentQueue) =>
          currentQueue.filter((entry) => !batchIds.includes(entry.id))
        );
        await clearWorkerLiveOutput(resolvedDir, next.threadId, null, null, {
          runtimeState: null,
          runtimeDetail: null,
          workerWriteScopes: [],
          workerBlockedByThreadIds: [],
          supersededByThreadId: null,
        });
        continue;
      }

      const parentLineage = normalizeStringArray(
        meta[next.threadId]?.derivedFromThreadIds
      );
      const relatedDescendants = collectDescendantThreadIds(
        parentLineage,
        childrenIndex
      );
      const relatedActiveAssignments = session.activeAssignments.filter(
        (assignment: ManagerActiveAssignment) =>
          assignment.threadId !== next.threadId &&
          relatedDescendants.has(assignment.threadId)
      );
      const dispatch = nextEntries.some(
        (entry) => entry.dispatchMode === 'manager-evaluate'
      )
        ? await decideDispatchForBatch({
            dir,
            resolvedDir,
            thread,
            entries: nextEntries,
            relatedActiveAssignments,
          })
        : {
            assignee: 'worker' as const,
            writeScopes: [UNIVERSAL_WRITE_SCOPE],
            reason: 'direct-worker-default',
          };

      const supersededAssignments = session.activeAssignments.filter(
        (assignment: ManagerActiveAssignment) =>
          dispatch.supersedesThreadIds?.includes(assignment.threadId) ?? false
      );
      if (supersededAssignments.length > 0) {
        await stopSupersededAssignments({
          dir: resolvedDir,
          supersedingThreadId: thread.id,
          supersedingThreadTitle: thread.title,
          supersededAssignments,
        });
        session = await readSession(dir);
        activeWorkerAssignments = session.activeAssignments.filter(
          (assignment: ManagerActiveAssignment) =>
            assignment.assigneeKind === 'worker'
        ).length;
        activeManagerAssignments = session.activeAssignments.filter(
          (assignment: ManagerActiveAssignment) =>
            assignment.assigneeKind === 'manager'
        ).length;
        reservedWorkerScopes = session.activeAssignments
          .filter(
            (assignment: ManagerActiveAssignment) =>
              assignment.assigneeKind === 'worker'
          )
          .flatMap(
            (assignment: ManagerActiveAssignment) => assignment.writeScopes
          );
      }

      const assignmentWriteScopes =
        dispatch.assignee === 'worker'
          ? normalizeWriteScopes(dispatch.writeScopes)
          : [];
      if (
        dispatch.assignee === 'manager' &&
        activeManagerAssignments >= MAX_PARALLEL_MANAGER_ASSIGNMENTS
      ) {
        continue;
      }
      if (
        dispatch.assignee === 'worker' &&
        activeWorkerAssignments >= MAX_PARALLEL_WORKER_AGENTS
      ) {
        continue;
      }
      if (
        dispatch.assignee === 'worker' &&
        scopeLocksOverlap(assignmentWriteScopes, reservedWorkerScopes)
      ) {
        const blockingAssignments = session.activeAssignments.filter(
          (assignment: ManagerActiveAssignment) =>
            assignment.assigneeKind === 'worker' &&
            scopeLocksOverlap(assignmentWriteScopes, assignment.writeScopes)
        );
        await setWorkerRuntimeState({
          dir: resolvedDir,
          threadId: next.threadId,
          assigneeKind: 'worker',
          assigneeLabel: defaultAssigneeLabel('worker'),
          workerAgentId: null,
          runtimeState: 'blocked-by-scope',
          runtimeDetail: blockingScopeDetail({
            blockingAssignments,
            threadById,
          }),
          workerWriteScopes: assignmentWriteScopes,
          workerBlockedByThreadIds: blockingAssignments.map(
            (assignment) => assignment.threadId
          ),
          supersededByThreadId: null,
          clearWorkerLiveLog: true,
        });
        continue;
      }

      const remainingQueue = queue.filter(
        (entry: QueueEntry) =>
          !entry.processed &&
          !activeQueueIds.has(entry.id) &&
          !startedEntryIds.has(entry.id) &&
          !batchIds.includes(entry.id)
      );
      priorityStreak = advanceManagerQueuePriorityStreak(
        priorityStreak,
        batch.priority,
        remainingQueue
      );

      const assignment: ManagerActiveAssignment = {
        id: `assign_${next.id}`,
        threadId: next.threadId,
        queueEntryIds: batchIds,
        assigneeKind: dispatch.assignee,
        assigneeLabel: defaultAssigneeLabel(dispatch.assignee),
        writeScopes: assignmentWriteScopes,
        pid: null,
        startedAt: new Date().toISOString(),
        lastProgressAt: null,
      };

      await reserveAssignment({
        dir,
        assignment,
        priorityStreak,
      });
      for (const entryId of batchIds) {
        startedEntryIds.add(entryId);
      }
      if (dispatch.assignee === 'worker') {
        reservedWorkerScopes = [
          ...reservedWorkerScopes,
          ...assignmentWriteScopes,
        ];
        activeWorkerAssignments += 1;
      } else {
        activeManagerAssignments += 1;
      }
      session = await readSession(dir);
      void runQueuedAssignment({
        dir,
        resolvedDir,
        assignment,
        thread,
        entries: nextEntries,
      });
    }
  } catch (err) {
    console.error('[manager-backend] processNextQueued error:', err);
    try {
      await setManagerRuntimeError(
        dir,
        err instanceof Error
          ? `Manager backend internal error: ${err.message}`
          : `Manager backend internal error: ${String(err)}`
      );
    } catch {
      /* workspace may have been torn down during tests/process shutdown */
    }
  } finally {
    inFlight.delete(resolvedDir);
    if (rerunRequested.has(resolvedDir)) {
      rerunRequested.delete(resolvedDir);
      void processNextQueued(dir, resolvedDir);
    }
  }
}

async function routeFreeformMessage(input: {
  dir: string;
  resolvedDir: string;
  content: string;
  contextThreadId?: string | null;
}): Promise<{
  plan: ManagerRoutingPlan;
}> {
  const openThreads = (await listThreads(input.dir)).filter(
    (thread) => thread.status !== 'resolved'
  );
  const { prompt, threadIdByTopicRef } = buildRoutingPrompt({
    content: input.content,
    resolvedDir: input.resolvedDir,
    threads: openThreads,
    contextThreadId: input.contextThreadId,
    isFirstTurn: true,
  });
  const promptImages = await materializeManagerPromptImages({
    workspaceKey: workspaceKey(input.dir),
    message: input.content,
  });
  const runResult = await runCodexTurn({
    dir: input.dir,
    resolvedDir: input.resolvedDir,
    prompt,
    sessionId: null,
    imagePaths: promptImages.map((image) => image.path),
  });

  if (runResult.code !== 0) {
    throw new Error(
      runResult.stderr.trim() ||
        runResult.stdout.trim() ||
        `codex CLI exited with code ${runResult.code ?? '?'}`
    );
  }

  const parsedPlan = parseManagerRoutingPlan(runResult.parsed.text);
  if (!parsedPlan) {
    return {
      plan: {
        actions: [
          {
            kind: 'create-new',
            title: makeFallbackThreadTitle(input.content),
            content: input.content,
            reason:
              '自動振り分けを解釈できなかったため、新しい話題として受け付けました。',
          },
        ],
      },
    };
  }

  const resolvedActions = parsedPlan.actions.flatMap((action) => {
    if (
      action.kind !== 'attach-existing' &&
      action.kind !== 'resolve-existing'
    ) {
      return [action];
    }
    const threadId =
      action.threadId ??
      (action.topicRef
        ? (threadIdByTopicRef.get(action.topicRef) ?? null)
        : null);
    if (!threadId) {
      return [];
    }
    return [{ ...action, threadId }];
  });

  if (resolvedActions.length === 0) {
    return {
      plan: {
        actions: [
          {
            kind: 'create-new',
            title: makeFallbackThreadTitle(input.content),
            content: input.content,
            reason:
              '既存の作業項目参照を解決できなかったため、新しい作業項目として受け付けました。',
          },
        ],
      },
    };
  }

  return {
    plan: {
      actions: resolvedActions,
    },
  };
}

export async function sendGlobalToBuiltinManager(
  dir: string,
  content: string,
  options?: {
    contextThreadId?: string | null;
  }
): Promise<ManagerRoutingSummary> {
  const resolvedDir = resolvePath(dir);

  return withRoutingLock(resolvedDir, async () => {
    const session = await readSession(dir);
    if (session.status === 'not-started') {
      await writeSession(dir, {
        ...session,
        status: 'idle',
        startedAt: session.startedAt ?? new Date().toISOString(),
      });
    }

    const { plan } = await routeFreeformMessage({
      dir,
      resolvedDir,
      content,
      contextThreadId: options?.contextThreadId ?? null,
    });

    const refreshedSession = await readSession(dir);
    await writeSession(dir, {
      ...refreshedSession,
      routingSessionId: null,
      lastMessageAt: new Date().toISOString(),
    });

    const items: ManagerRoutingSummaryItem[] = [];
    let routedCount = 0;
    let ambiguousCount = 0;
    const contextParentThread =
      options?.contextThreadId &&
      plan.actions.some((action) => action.kind === 'create-new')
        ? await getThread(dir, options.contextThreadId)
        : null;

    for (const action of plan.actions) {
      switch (action.kind) {
        case 'attach-existing': {
          if (!action.threadId) {
            break;
          }
          const { keepSameTopic, thread: parentThread } =
            await shouldKeepUserMessageInSameTopic({
              dir,
              resolvedDir,
              threadId: action.threadId,
            });
          if (!keepSameTopic && parentThread) {
            const derivedUserMessage = buildDerivedThreadUserMessage({
              fullInput: content,
              action,
              totalActions: plan.actions.length,
              parentThread,
            });
            const createdThread = await createThread(
              resolvedDir,
              makeDerivedThreadTitle(parentThread.title, action.content)
            );
            await addMessage(
              resolvedDir,
              createdThread.id,
              derivedUserMessage,
              'user',
              'waiting'
            );
            await updateManagerThreadMeta(
              resolvedDir,
              createdThread.id,
              () => ({
                derivedFromThreadIds: [parentThread.id],
                routingHint: `派生元: 「${parentThread.title}」から分けた task です。`,
              })
            );
            await sendToBuiltinManager(
              resolvedDir,
              createdThread.id,
              derivedUserMessage,
              { dispatchMode: 'manager-evaluate' }
            );
            items.push({
              threadId: createdThread.id,
              title: createdThread.title,
              outcome: 'created-new',
              reason: `「${parentThread.title}」から派生した新しい話題として分け、そのまま実行に回しました。`,
            });
            routedCount += 1;
            break;
          }

          const userMessage = pickThreadUserMessage(
            content,
            action,
            plan.actions.length
          );
          await ensureThreadReadyForUserMessage(dir, action.threadId);
          await clearManagerThreadMeta(resolvedDir, action.threadId);
          await addMessage(
            resolvedDir,
            action.threadId,
            userMessage,
            'user',
            'waiting'
          );
          await sendToBuiltinManager(
            resolvedDir,
            action.threadId,
            userMessage,
            {
              dispatchMode: 'manager-evaluate',
            }
          );
          items.push({
            threadId: action.threadId,
            title: parentThread?.title ?? action.threadId,
            outcome: 'attached-existing',
            reason:
              action.reason ??
              'この話題で待っていた確認への返答として扱い、そのまま実行に回しました。',
          });
          routedCount += 1;
          break;
        }

        case 'create-new': {
          const derivedParentThread =
            contextParentThread && contextParentThread.status !== 'resolved'
              ? contextParentThread
              : null;
          const userMessage = derivedParentThread
            ? buildDerivedThreadUserMessage({
                fullInput: content,
                action,
                totalActions: plan.actions.length,
                parentThread: derivedParentThread,
              })
            : pickThreadUserMessage(content, action, plan.actions.length);
          const createdThread = await createThread(
            resolvedDir,
            derivedParentThread
              ? makeDerivedThreadTitle(
                  derivedParentThread.title,
                  action.title?.trim() || action.content
                )
              : action.title?.trim() || makeFallbackThreadTitle(action.content)
          );
          await addMessage(
            resolvedDir,
            createdThread.id,
            userMessage,
            'user',
            'waiting'
          );
          if (derivedParentThread) {
            await updateManagerThreadMeta(
              resolvedDir,
              createdThread.id,
              () => ({
                derivedFromThreadIds: [derivedParentThread.id],
                routingHint: `派生元: 「${derivedParentThread.title}」から分けた task です。`,
              })
            );
          } else {
            await clearManagerThreadMeta(resolvedDir, createdThread.id);
          }
          await sendToBuiltinManager(
            resolvedDir,
            createdThread.id,
            userMessage,
            { dispatchMode: 'manager-evaluate' }
          );
          items.push({
            threadId: createdThread.id,
            title: createdThread.title,
            outcome: 'created-new',
            reason: derivedParentThread
              ? `「${derivedParentThread.title}」から派生した新しい話題として分け、そのまま実行に回しました。`
              : (action.reason ??
                '新しい話題を作って、そのまま実行に回しました。'),
          });
          routedCount += 1;
          break;
        }

        case 'routing-confirmation': {
          const userMessage = pickThreadUserMessage(
            content,
            action,
            plan.actions.length
          );
          const confirmationThread = await createThread(
            resolvedDir,
            action.title?.trim() || makeFallbackThreadTitle(action.content)
          );
          await addMessage(
            resolvedDir,
            confirmationThread.id,
            userMessage,
            'user',
            'active'
          );
          await addMessage(
            resolvedDir,
            confirmationThread.id,
            action.question?.trim() ||
              'どの話題として扱うべきか確認したいです。',
            'ai',
            'needs-reply'
          );
          await updateManagerThreadMeta(
            resolvedDir,
            confirmationThread.id,
            () => ({
              routingConfirmationNeeded: true,
              routingHint:
                action.reason ??
                'この部分だけ話題の振り分けに確認が必要でした。',
              lastRoutingAt: new Date().toISOString(),
            })
          );
          items.push({
            threadId: confirmationThread.id,
            title: confirmationThread.title,
            outcome: 'routing-confirmation',
            reason: action.reason ?? 'この部分だけ振り分け確認が必要でした。',
          });
          ambiguousCount += 1;
          break;
        }

        case 'resolve-existing': {
          if (!action.threadId) {
            break;
          }
          const userMessage = pickThreadUserMessage(
            content,
            action,
            plan.actions.length
          );
          await ensureThreadReadyForUserMessage(dir, action.threadId);
          await addMessage(
            resolvedDir,
            action.threadId,
            userMessage,
            'user',
            'active'
          );
          await clearManagerThreadMeta(resolvedDir, action.threadId);
          await resolveThread(resolvedDir, action.threadId);
          const resolvedThread = await getThread(dir, action.threadId);
          items.push({
            threadId: action.threadId,
            title: resolvedThread?.title ?? action.threadId,
            outcome: 'resolved-existing',
            reason: action.reason ?? 'この話題は完了として閉じました。',
          });
          routedCount += 1;
          break;
        }
      }
    }

    const detailParts: string[] = [];
    if (routedCount > 0) {
      detailParts.push(`${routedCount}件を実行キューに回しました`);
    }
    if (ambiguousCount > 0) {
      detailParts.push(`${ambiguousCount}件は確認待ちにしました`);
    }
    if (detailParts.length === 0) {
      detailParts.push('送信内容を受け付けました');
    }

    return {
      items,
      routedCount,
      ambiguousCount,
      detail: detailParts.join(' / '),
    };
  });
}

// ── Public API (consumed by manager-adapter.ts) ────────────────────────────

export async function getBuiltinManagerStatus(dir: string): Promise<{
  running: boolean;
  configured: boolean;
  builtinBackend: boolean;
  health: ManagerHealth;
  detail: string;
  pendingCount: number;
  currentQueueId: string | null;
  currentThreadId: string | null;
  currentThreadTitle: string | null;
  errorMessage: string | null;
  errorAt: string | null;
}> {
  let session = await reconcileActiveAssignments(dir);
  const queue = await readQueue(dir);
  const activeQueueIds = queueEntryIdSet(session.activeAssignments);
  const pending = queue.filter(
    (entry) => !entry.processed && !activeQueueIds.has(entry.id)
  ).length;
  const currentAssignment = session.activeAssignments[0] ?? null;
  const currentThread =
    currentAssignment === null
      ? null
      : await getThread(dir, currentAssignment.threadId);

  if (session.activeAssignments.length > 0) {
    const latestProgressAt = Math.max(
      ...session.activeAssignments
        .map(
          (assignment: ManagerActiveAssignment) =>
            parseMessageTimestamp(assignment.lastProgressAt) ??
            parseMessageTimestamp(assignment.startedAt) ??
            Number.NEGATIVE_INFINITY
        )
        .filter(Number.isFinite),
      Number.NEGATIVE_INFINITY
    );
    const stalled =
      Number.isFinite(latestProgressAt) &&
      Date.now() - latestProgressAt >= MANAGER_STALLED_PROGRESS_THRESHOLD_MS;
    return {
      running: true,
      configured: true,
      builtinBackend: true,
      health: stalled ? 'stalled' : 'ok',
      detail: stalled
        ? currentThread
          ? `AI backend の進捗が止まっている可能性があります (${currentThread.title})`
          : 'AI backend の進捗が止まっている可能性があります'
        : session.activeAssignments.length === 1
          ? currentThread
            ? `処理中 (${currentThread.title})`
            : '処理中'
          : `処理中 (${session.activeAssignments.length}件)`,
      pendingCount: pending,
      currentQueueId: currentAssignment?.queueEntryIds[0] ?? null,
      currentThreadId: currentAssignment?.threadId ?? null,
      currentThreadTitle: currentThread?.title ?? null,
      errorMessage: stalled
        ? '最後に進捗が見えてから長く止まっています。worker がハングしている可能性があります。'
        : null,
      errorAt: stalled
        ? (session.lastProgressAt ?? session.lastMessageAt)
        : null,
    };
  }

  if (pending > 0) {
    let latestSession = await readSession(dir);
    if (latestSession.status === 'not-started') {
      await writeSession(dir, {
        ...latestSession,
        status: 'idle',
        startedAt: latestSession.startedAt ?? new Date().toISOString(),
      });
      latestSession = await readSession(dir);
    }
    void processNextQueued(dir, resolvePath(dir));
    if (latestSession.lastErrorMessage) {
      return {
        running: true,
        configured: true,
        builtinBackend: true,
        health: 'error',
        detail: 'AI backend で問題が起きています',
        pendingCount: pending,
        currentQueueId: null,
        currentThreadId: null,
        currentThreadTitle: null,
        errorMessage: latestSession.lastErrorMessage,
        errorAt: latestSession.lastErrorAt,
      };
    }
  }

  if (session.status === 'not-started' && pending === 0) {
    return {
      running: false,
      configured: true,
      builtinBackend: true,
      health: 'ok',
      detail: '未起動 — メッセージ送信で自動起動します',
      pendingCount: 0,
      currentQueueId: null,
      currentThreadId: null,
      currentThreadTitle: null,
      errorMessage: null,
      errorAt: null,
    };
  }

  if (session.lastErrorMessage) {
    return {
      running: true,
      configured: true,
      builtinBackend: true,
      health: 'error',
      detail: 'AI backend で問題が起きています',
      pendingCount: pending,
      currentQueueId: null,
      currentThreadId: null,
      currentThreadTitle: null,
      errorMessage: session.lastErrorMessage,
      errorAt: session.lastErrorAt,
    };
  }

  return {
    running: true,
    configured: true,
    builtinBackend: true,
    health: 'ok',
    detail: pending > 0 ? `待機中 (キュー: ${pending}件)` : '待機中',
    pendingCount: pending,
    currentQueueId: null,
    currentThreadId: null,
    currentThreadTitle: null,
    errorMessage: null,
    errorAt: null,
  };
}

export async function startBuiltinManager(
  dir: string
): Promise<{ started: boolean; detail: string }> {
  const session = await readSession(dir);
  if (session.status === 'not-started') {
    await writeSession(dir, {
      ...session,
      status: 'idle',
      startedAt: new Date().toISOString(),
    });
  }
  void processNextQueued(dir, resolvePath(dir));
  return { started: true, detail: 'ビルトインマネージャーを起動しました' };
}

export async function sendToBuiltinManager(
  dir: string,
  threadId: string,
  content: string,
  options?: {
    dispatchMode?: 'direct-worker' | 'manager-evaluate';
  }
): Promise<void> {
  const session = await readSession(dir);
  if (session.status === 'not-started') {
    await writeSession(dir, {
      ...session,
      status: 'idle',
      startedAt: new Date().toISOString(),
    });
  }
  await enqueueMessage(dir, threadId, content, options);
  void processNextQueued(dir, resolvePath(dir));
}
