/**
 * Built-in Manager backend for Workspace Agent Hub.
 *
 * Uses the Codex CLI directly (`codex exec ...`) for Manager routing and
 * per-work-item worker-agent execution.
 * Maintains per-workspace state in two workspace-local files (not committed):
 *
 *   .workspace-agent-hub-manager.json        — runtime state (idle/busy, routing continuity, PID)
 *   .workspace-agent-hub-manager-queue.jsonl — persistent message queue
 *
 * Key design rules:
 *  - One persistent Codex routing session per workspace inbox
 *  - One Codex worker-agent session per Manager work item, persisted in thread meta
 *  - Manager-assigned replies and worker-agent tasks share one persistent queue
 *  - Worker-agent assignments can run in parallel when their repo-relative
 *    write scopes do not overlap
 *  - On server restart, a stale PID is detected and the queue resumes automatically
 *  - No external npm dependencies — only the `codex` CLI in PATH is required
 *  - Requires: Codex CLI (`npm install -g @openai/codex`)
 */

import {
  spawn,
  type ChildProcess,
  execFile as execFileCb,
} from 'child_process';
import { readFile, writeFile, appendFile } from 'fs/promises';
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
  type ManagerThreadMeta,
  type ManagerWorkerLiveEntry,
  type ManagerWorkerRuntimeState,
  readManagerThreadMeta,
  updateManagerThreadMeta,
} from './manager-thread-state.js';
import { writeFileAtomically } from './atomic-file.js';
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
import {
  createWorkerWorktree,
  mergeWorktreeToMain,
  pushWithRetry,
  removeWorktree,
  resolveConflictAndVerify,
  resolveTargetRepoRoot,
  cleanupOrphanedWorktrees,
  execGit,
  runPostMergeDeliveryChain,
  validateWorktreeReadyForMerge,
} from './manager-worktree.js';
import { snapshotBuild, resolvePackageRoot } from './build-archive.js';

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

const WORKER_LIVE_STARTED_TEXT =
  'Worker を起動しました。まだ進捗メッセージは届いていません。';
const MANAGER_LIVE_PREPARING_TEXT =
  'Manager が返答を準備しています。まだ本文は確定していません。';
const GENERIC_LIVE_PROGRESS_TEXT =
  '進捗イベントを受信しましたが、まだ説明文は届いていません。';

/**
 * System context embedded in the first routing turn.
 */
const MANAGER_ROUTER_SYSTEM_PROMPT =
  'You are a manager AI assistant for this software workspace. ' +
  'Help coordinate work across multiple threads. ' +
  'Keep using the same routing conversation across global sends so you can understand follow-up references like earlier XX/YY while still grounding each decision in the latest topic list. ' +
  'Prefer attach-existing when the user is clearly continuing, checking on, refining, or answering an existing topic, and create-new only when the message is genuinely separate or the user explicitly wants a split topic. ' +
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
  'Implement and verify the task yourself, but normally leave commit, push, release, and publish actions for the Manager review step after your work finishes. ' +
  'Write user-facing replies in plain, natural Japanese that reads like a capable coworker, not a tool log. ' +
  'Avoid internal AI/platform/process jargon unless the user explicitly asked for it or it is necessary to unblock them. ' +
  'Prefer ordinary task language, complete sentences, and direct explanations of what changed or what is still needed. ' +
  'If a technical term is unavoidable, explain it briefly in everyday Japanese. ' +
  'Use normal Markdown formatting only when it genuinely makes the reply easier to read.';

const MANAGER_WORKER_JSON_RULES =
  'Return only strict JSON with required keys {"status","reply"} and optional keys {"changedFiles","verificationSummary"}. ' +
  'Use status "review" when you completed the actionable work you can do now and the user can review the result. ' +
  'Use status "needs-reply" only when a real blocker or missing user decision prevents further progress. ' +
  'Do not use "active" for mere acknowledgements; keep working until you can return "review" or "needs-reply". ' +
  'When you changed repository files, include changedFiles as the repo-relative paths you actually modified for this task. ' +
  'When you ran verification, include verificationSummary as a short plain-text summary of the commands and outcomes. ' +
  'Do not wrap JSON in markdown fences.';

const MANAGER_REVIEW_SYSTEM_PROMPT =
  'You are the built-in manager reviewer for Workspace Agent Hub. ' +
  'A worker has already executed one work item in this repository. ' +
  'Review that work yourself against the original request and the current repository state. ' +
  'Run the repo-standard verification needed for this task when necessary. ' +
  'If the work is acceptable, own the in-scope delivery chain yourself: commit, push, and if this repository or package normally requires release or publish for completion and it applies to this task, continue through that release or publish path as well. ' +
  'Keep the scope limited to this work item. Prefer the worker-reported changed files and declared write scopes when reviewing or staging changes, and do not include unrelated repository changes. ' +
  'If review fails or you still need human input, do not commit, push, release, or publish. ' +
  'Write the user-facing reply in plain, natural Japanese. ' +
  'Do not wrap JSON in markdown fences.';

const MANAGER_ROUTING_JSON_RULES =
  'Return only strict JSON in the form {"actions":[...]}. ' +
  'Each action must have kind "attach-existing", "create-new", "routing-confirmation", or "resolve-existing". ' +
  'For "attach-existing" and "resolve-existing", include topicRef and content. ' +
  'For "create-new", include title and content. ' +
  'Treat contextThreadId only as a hint; create a new topic unless the current message clearly belongs to that existing topic. ' +
  'Default granularity is one user goal per topic. When the message clearly continues, checks on, refines, or answers an existing topic, prefer attach-existing and keep it in that same topic. Create a new topic only when the message is clearly separate or the user explicitly asks to split it out. Resolved topics can still be valid attach-existing targets when the user is clearly returning to that earlier topic. ' +
  'Do not attach to an existing topic just because it is broadly similar or was discussed recently; attach only when the current message clearly reads as a continuation of that exact topic. ' +
  'For every action, include originalText as the exact copied user wording for just that part whenever possible; do not paraphrase originalText. ' +
  'For "routing-confirmation", include title, content, question, and reason. ' +
  'Use topicRef exactly as shown in Recent topics, and never mention topicRef, threadId, or any other internal ID in user-facing titles, reasons, questions, or stored content. ' +
  'content is the user message text that will be stored in that target topic. For "create-new" and "routing-confirmation", content must stand on its own inside that topic: keep it as close to the original wording as possible, but add the smallest missing context needed so the topic still makes sense when read alone. If the original wording already stands alone, make content match originalText. ' +
  'Split confident intents immediately and leave only the ambiguous parts for confirmation. ' +
  'Do not wrap JSON in markdown fences.';

export interface ManagerReplyPayload {
  status: Extract<ThreadStatus, 'active' | 'review' | 'needs-reply'>;
  reply: string;
}

export interface ManagerWorkerResultPayload extends ManagerReplyPayload {
  changedFiles: string[];
  verificationSummary: string | null;
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
  /** Persisted routing continuity for workspace-level global sends. */
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
  worktreePath: string | null;
  worktreeBranch: string | null;
  targetRepoRoot: string | null;
}

export type ManagerHealth = 'ok' | 'error';
const MANAGER_RECONCILE_GRACE_MS = 15 * 1000;
const MAX_PARALLEL_WORKER_AGENTS = 3;
const MAX_PARALLEL_MANAGER_ASSIGNMENTS = 1;
const UNIVERSAL_WRITE_SCOPE = '*';

// ---------------------------------------------------------------------------
// Child process tracking — for graceful shutdown
// ---------------------------------------------------------------------------

const activeChildProcesses = new Set<ChildProcess>();

function killProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (process.platform === 'win32') {
      const kill = execFileCb(
        'taskkill',
        ['/F', '/T', '/PID', String(pid)],
        { windowsHide: true },
        () => resolvePromise()
      );
      kill.on('error', () => resolvePromise());
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
      resolvePromise();
    }
  });
}

export async function killAllActiveChildProcesses(): Promise<void> {
  const pids = [...activeChildProcesses]
    .map((proc) => proc.pid)
    .filter((pid): pid is number => pid != null);

  if (pids.length === 0) {
    return;
  }

  await Promise.allSettled(pids.map((pid) => killProcessTree(pid)));

  // Wait up to 5 seconds for processes to exit
  const deadline = Date.now() + 5000;
  while (activeChildProcesses.size > 0 && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  // Force kill any survivors
  for (const proc of activeChildProcesses) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
  activeChildProcesses.clear();
}

function parseEnvDurationMs(name: string, fallbackMs: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallbackMs;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }
  return parsed;
}

function codexIdleTimeoutMs(): number {
  return parseEnvDurationMs(
    'WORKSPACE_AGENT_HUB_CODEX_IDLE_TIMEOUT_MS',
    10 * 60_000
  );
}

function codexStructuredReplyCloseGraceMs(): number {
  return parseEnvDurationMs(
    'WORKSPACE_AGENT_HUB_CODEX_STRUCTURED_REPLY_CLOSE_GRACE_MS',
    30_000
  );
}

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
  structuredReply: ManagerReplyPayload | null;
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
    worktreePath:
      typeof record['worktreePath'] === 'string' && record['worktreePath']
        ? record['worktreePath']
        : null,
    worktreeBranch:
      typeof record['worktreeBranch'] === 'string' && record['worktreeBranch']
        ? record['worktreeBranch']
        : null,
    targetRepoRoot:
      typeof record['targetRepoRoot'] === 'string' && record['targetRepoRoot']
        ? record['targetRepoRoot']
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
            worktreePath: null,
            worktreeBranch: null,
            targetRepoRoot: null,
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
  await writeFileAtomically(filePath, content);
}

async function readSessionFile(dir: string): Promise<ManagerSession> {
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

export async function readSession(dir: string): Promise<ManagerSession> {
  return readSessionFile(dir);
}

export async function updateSession(
  dir: string,
  updater: (session: ManagerSession) => ManagerSession | Promise<ManagerSession>
): Promise<ManagerSession> {
  const filePath = sessionFilePath(dir);
  const key = `session:${resolvePath(dir)}`;
  let nextSession: ManagerSession | null = null;
  let changed = false;
  await withWriteLock(key, async () => {
    const currentSession = await readSessionFile(dir);
    nextSession = normalizeManagerSession(dir, await updater(currentSession));
    changed = JSON.stringify(nextSession) !== JSON.stringify(currentSession);
    if (!changed) {
      return;
    }
    await atomicWrite(filePath, JSON.stringify(nextSession, null, 2));
  });
  if (changed) {
    notifyManagerUpdate(dir);
  }
  return nextSession ?? readSessionFile(dir);
}

export async function writeSession(
  dir: string,
  session: ManagerSession
): Promise<void> {
  await updateSession(dir, () => session);
}

async function touchManagerProgress(dir: string): Promise<void> {
  await updateSession(dir, (session) => ({
    ...session,
    lastProgressAt: new Date().toISOString(),
  }));
}

async function setManagerRuntimeError(
  dir: string,
  message: string
): Promise<void> {
  await updateSession(dir, (session) => ({
    ...session,
    lastErrorMessage: message,
    lastErrorAt: new Date().toISOString(),
  }));
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
  const droppedAssignments: ManagerActiveAssignment[] = [];
  let survivingAssignments: ManagerActiveAssignment[] = [];
  const nextSession = await updateSession(dir, async (session) => {
    if (session.activeAssignments.length === 0) {
      survivingAssignments = [];
      // Clear any stale error from a previous assignment that has already
      // been cleaned up — the error is no longer relevant.
      if (session.lastErrorMessage !== null) {
        return { ...session, lastErrorMessage: null, lastErrorAt: null };
      }
      return session;
    }

    const queue = await readQueue(dir);
    const queueById = new Map(queue.map((entry) => [entry.id, entry]));
    let mutated = false;
    survivingAssignments = [];
    droppedAssignments.length = 0;

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
      const lostProcessReservation =
        normalizedAssignment.pid === null && !withinGraceWindow;
      if (
        lostProcessReservation ||
        (normalizedAssignment.pid !== null &&
          !isPidAlive(normalizedAssignment.pid) &&
          !withinGraceWindow)
      ) {
        droppedAssignments.push(normalizedAssignment);
        continue;
      }
      survivingAssignments.push(normalizedAssignment);
    }

    if (droppedAssignments.length === 0 && !mutated) {
      return session;
    }

    const replaced = replaceSessionAssignments(session, survivingAssignments);
    // When all assignments are gone after reconciliation, clear any stale
    // error so the UI reflects the current (idle) state instead of a past
    // failure from an assignment that no longer exists.
    if (
      replaced.activeAssignments.length === 0 &&
      replaced.lastErrorMessage !== null
    ) {
      return { ...replaced, lastErrorMessage: null, lastErrorAt: null };
    }
    return replaced;
  });

  if (droppedAssignments.length === 0) {
    return nextSession;
  }

  const survivingThreadIds = new Set(
    survivingAssignments.map((assignment) => assignment.threadId)
  );
  for (const assignment of droppedAssignments) {
    // Clean up worktree for dropped assignment.
    if (assignment.worktreePath && assignment.worktreeBranch) {
      await removeWorktree({
        targetRepoRoot: assignment.targetRepoRoot ?? dir,
        worktreePath: assignment.worktreePath,
        branchName: assignment.worktreeBranch,
      }).catch(() => {});
    }
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

  // Clean up orphaned worktrees whose assignment IDs are no longer active.
  const activeIds = survivingAssignments.map((a) => a.id);
  await cleanupOrphanedWorktrees(dir, activeIds).catch(() => {});

  return nextSession;
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
  worktreePath: string | null;
  isFirstTurn: boolean;
}): string {
  const promptContent = buildManagerMessagePromptContent(input.content).text;
  const workspace = input.worktreePath ?? input.resolvedDir;
  if (!input.isFirstTurn) {
    return [
      `[Topic: ${input.thread.title}]`,
      MANAGER_WORKER_JSON_RULES,
      promptContent,
    ].join('\n\n');
  }

  const worktreeNotice = input.worktreePath
    ? 'This is an isolated git worktree. Make your changes and run verification, but do NOT commit or push. The Manager will handle the commit, merge, and push.'
    : '';

  return [
    MANAGER_WORKER_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${workspace}`,
    ...(worktreeNotice ? [worktreeNotice] : []),
    `[Topic: ${input.thread.title}]`,
    'Topic history:',
    formatThreadHistory(input.thread),
    'New user request:',
    promptContent,
  ].join('\n\n');
}

export function buildManagerReviewPrompt(input: {
  thread: Thread;
  workerResult: ManagerWorkerResultPayload;
  resolvedDir: string;
  worktreePath: string | null;
  writeScopes: string[];
  structuralWarnings?: string[];
}): string {
  const workspace = input.worktreePath ?? input.resolvedDir;
  const changedFiles =
    input.workerResult.changedFiles.length > 0
      ? input.workerResult.changedFiles.map((path) => `- ${path}`).join('\n')
      : '- Worker did not report changed files.';
  const verificationSummary =
    input.workerResult.verificationSummary ??
    'Worker did not report a verification summary.';
  const declaredWriteScopes =
    input.writeScopes.length > 0 ? input.writeScopes.join(', ') : '(read-only)';

  const deliveryInstruction = input.worktreePath
    ? 'Commit your verified changes in this worktree branch. If this repository normally requires release or publish for completion, prepare that release metadata in this branch now (for example version/changelog updates) so the Manager backend can finish the post-merge delivery chain. Do NOT push, release, or publish yourself. Do not return status "review" unless the branch is left fully committed and ready for the Manager backend to merge to the main branch, push, and run any required release/publish follow-through.'
    : '';

  const structuralSection =
    input.structuralWarnings && input.structuralWarnings.length > 0
      ? `STRUCTURAL REVIEW WARNINGS (must address before approving):\n${input.structuralWarnings.map((w) => `⚠ ${w}`).join('\n')}`
      : '';

  return [
    MANAGER_REVIEW_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${workspace}`,
    ...(deliveryInstruction ? [deliveryInstruction] : []),
    `[Work item: ${input.thread.title}]`,
    'Recent work-item history:',
    formatThreadHistory(input.thread),
    'Worker completion report:',
    `status: ${input.workerResult.status}`,
    `reply:\n${input.workerResult.reply}`,
    `changedFiles:\n${changedFiles}`,
    `verificationSummary:\n${verificationSummary}`,
    `declaredWriteScopes: ${declaredWriteScopes}`,
    ...(structuralSection ? [structuralSection] : []),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Recovery routing — Manager decides how to handle review failures
// ---------------------------------------------------------------------------

const MANAGER_RECOVERY_SYSTEM_PROMPT =
  'You are the Manager recovery router for Workspace Agent Hub. ' +
  'The review step for this work item did not approve the result. ' +
  'Analyse the error context, the original request, and the current repository state to decide the best recovery action. ' +
  'Return strict JSON: {"decision":"fix-self"|"retry-worker"|"restart"|"escalate","reason":"...","instructions":"..."}. ' +
  'decision meanings: ' +
  'fix-self — the issue is quick to fix (a few lines, a config tweak, a missed file); you will fix it yourself in the next turn. ' +
  'retry-worker — the issue needs more work but the current approach is on the right track; a worker should continue or redo the fix. ' +
  'restart — the approach is fundamentally wrong; clean up and start fresh from scratch. ' +
  'escalate — this genuinely needs human input or cannot be resolved automatically. ' +
  'instructions: describe what exactly needs to be fixed (for fix-self and retry-worker). ' +
  'Prefer fix-self for trivial issues, retry-worker for moderate issues, restart only when the direction is wrong, and escalate only as a last resort. ' +
  'Do not wrap JSON in markdown fences.';

const MANAGER_RECOVERY_FIX_SYSTEM_PROMPT =
  'You are the Manager for Workspace Agent Hub. ' +
  "The review found issues with the worker's output. " +
  'Fix the specified issues in this workspace. Run verification after your fix. ' +
  'Write the user-facing reply in plain, natural Japanese. ' +
  'Do not wrap JSON in markdown fences.';

export interface ManagerRecoveryDecision {
  decision: 'fix-self' | 'retry-worker' | 'restart' | 'escalate';
  reason: string;
  instructions: string | null;
}

export function parseManagerRecoveryDecision(
  text: string
): ManagerRecoveryDecision | null {
  const normalized = stripMarkdownCodeFence(text);
  try {
    const parsed = JSON.parse(normalized) as Partial<ManagerRecoveryDecision>;
    const decision = parsed.decision;
    if (
      decision !== 'fix-self' &&
      decision !== 'retry-worker' &&
      decision !== 'restart' &&
      decision !== 'escalate'
    ) {
      return null;
    }
    return {
      decision,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      instructions:
        typeof parsed.instructions === 'string' && parsed.instructions.trim()
          ? parsed.instructions.trim()
          : null,
    };
  } catch {
    return null;
  }
}

export function buildManagerRecoveryPrompt(input: {
  thread: Thread;
  errorContext: string;
  resolvedDir: string;
  worktreePath: string | null;
}): string {
  const workspace = input.worktreePath ?? input.resolvedDir;
  return [
    MANAGER_RECOVERY_SYSTEM_PROMPT,
    `Workspace: ${workspace}`,
    `[Work item: ${input.thread.title}]`,
    'Recent work-item history:',
    formatThreadHistory(input.thread),
    'Error / review output:',
    input.errorContext,
  ].join('\n\n');
}

function buildManagerRecoveryFixPrompt(input: {
  instructions: string;
  thread: Thread;
  resolvedDir: string;
  worktreePath: string | null;
  writeScopes: string[];
}): string {
  const workspace = input.worktreePath ?? input.resolvedDir;
  const declaredWriteScopes =
    input.writeScopes.length > 0 ? input.writeScopes.join(', ') : '(read-only)';
  return [
    MANAGER_RECOVERY_FIX_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${workspace}`,
    `[Work item: ${input.thread.title}]`,
    `declaredWriteScopes: ${declaredWriteScopes}`,
    'Fix instructions:',
    input.instructions,
  ].join('\n\n');
}

function buildWorkerRetryPrompt(input: {
  instructions: string;
  thread: Thread;
  resolvedDir: string;
  worktreePath: string | null;
}): string {
  const workspace = input.worktreePath ?? input.resolvedDir;
  const worktreeNotice = input.worktreePath
    ? 'This is an isolated git worktree. Make your changes and run verification, but do NOT commit or push. The Manager will handle the commit, merge, and push.'
    : '';
  return [
    MANAGER_WORKER_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${workspace}`,
    ...(worktreeNotice ? [worktreeNotice] : []),
    `[Topic: ${input.thread.title}]`,
    'Topic history:',
    formatThreadHistory(input.thread),
    'Previous attempt had issues found during review. Please address the following:',
    input.instructions,
  ].join('\n\n');
}

/**
 * Run lightweight structural checks on changed files to detect common
 * quality regressions (skipped tests, verification script changes, etc.).
 */
export async function runStructuralChecks(
  cwd: string,
  changedFiles: string[]
): Promise<string[]> {
  const warnings: string[] = [];
  if (changedFiles.length === 0) {
    return warnings;
  }

  // Check for .skip / .todo in test files.
  const testFiles = changedFiles.filter(
    (f) =>
      f.includes('.test.') || f.includes('.spec.') || f.includes('__tests__')
  );
  if (testFiles.length > 0) {
    const diffResult = await execGit(cwd, ['diff', 'HEAD', '--', ...testFiles]);
    const addedLines = diffResult.stdout
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'));
    const skipCount = addedLines.filter((line) =>
      /\.(skip|todo)\s*\(/.test(line)
    ).length;
    if (skipCount > 0) {
      warnings.push(
        `${skipCount} new .skip() or .todo() call(s) added to test files. Ensure tests are not being weakened.`
      );
    }
  }

  // Check for verification/hook script changes.
  const sensitiveFiles = changedFiles.filter(
    (f) =>
      f.includes('verify.ps1') ||
      f.includes('pre-commit') ||
      f.includes('.githooks/')
  );
  if (sensitiveFiles.length > 0) {
    warnings.push(
      `Verification/hook scripts modified: ${sensitiveFiles.join(', ')}. Review changes carefully.`
    );
  }

  // Check for excessive mock overrides.
  const diffAll = await execGit(cwd, ['diff', 'HEAD']);
  const mockLines = diffAll.stdout
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('+') &&
        !line.startsWith('+++') &&
        /jest\.mock|vi\.mock|\.mockImplementation|\.mockReturnValue/.test(line)
    );
  if (mockLines.length > 10) {
    warnings.push(
      `${mockLines.length} new mock override lines detected. Excessive mocking may mask real failures.`
    );
  }

  return warnings;
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
  const topicRefs = input.threads.map((thread, index) => ({
    thread,
    topicRef: `topic-${index + 1}`,
  }));
  const threadIdByTopicRef = new Map(
    topicRefs.map((entry) => [entry.topicRef, entry.thread.id])
  );
  const threadSummary =
    topicRefs.length === 0
      ? 'No recent topics.'
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
    ? `Current open topic mention hint: @${contextThread.title}. If you decide this really belongs to that topic, use its topicRef from the Recent topics list. Treat this like a user mention hint, not a forced destination.`
    : input.contextThreadId
      ? 'There is a currently open topic, but its metadata was unavailable. Treat that only as a weak continuation hint and never mention internal IDs.'
      : 'No current open topic mention hint.';

  const body = [
    'Route the following freeform manager message into workspace topics.',
    MANAGER_ROUTING_JSON_RULES,
    `Workspace: ${input.resolvedDir}`,
    contextBlock,
    'Recent topics:',
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

export function parseCodexProgressLine(
  line: string,
  threadStartedText = WORKER_LIVE_STARTED_TEXT
): CodexProgressState {
  const trimmed = line.trim();
  if (!trimmed) {
    return {
      sessionId: null,
      latestText: null,
      liveEntries: [],
      structuredReply: null,
    };
  }

  const singleLiveEntry = (
    text: string,
    kind: ManagerWorkerLiveEntry['kind']
  ): CodexProgressState => ({
    sessionId: null,
    latestText: text,
    liveEntries: [
      {
        at: new Date().toISOString(),
        text,
        kind,
      },
    ],
    structuredReply: kind === 'output' ? parseManagerReplyPayload(text) : null,
  });

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (
      parsed['type'] === 'thread.started' &&
      typeof parsed['thread_id'] === 'string'
    ) {
      return {
        sessionId: parsed['thread_id'] as string,
        latestText: threadStartedText,
        liveEntries: [
          {
            at: new Date().toISOString(),
            text: threadStartedText,
            kind: 'status',
          },
        ],
        structuredReply: null,
      };
    }

    if (parsed['type'] !== 'item.completed') {
      return {
        sessionId: null,
        latestText: null,
        liveEntries: [],
        structuredReply: null,
      };
    }

    const item = parsed['item'];
    if (!item || typeof item !== 'object') {
      return {
        sessionId: null,
        latestText: null,
        liveEntries: [],
        structuredReply: null,
      };
    }

    const typedItem = item as Record<string, unknown>;
    const fragments = collectTextFragments(typedItem);
    const combined = fragments.length > 0 ? fragments.join('\n').trim() : null;
    if (combined) {
      const parsedReply = parseManagerReplyPayload(combined);
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
        structuredReply: parsedReply,
      };
    }

    const genericText = GENERIC_LIVE_PROGRESS_TEXT;
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
      structuredReply: null,
    };
  } catch {
    return singleLiveEntry(trimmed, 'output');
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

export function parseManagerWorkerResultPayload(
  text: string
): ManagerWorkerResultPayload | null {
  const reply = parseManagerReplyPayload(text);
  if (!reply) {
    return null;
  }

  try {
    const normalized = stripMarkdownCodeFence(text);
    const parsed = JSON.parse(
      normalized
    ) as Partial<ManagerWorkerResultPayload>;
    return {
      ...reply,
      changedFiles: normalizeStringArray(parsed.changedFiles),
      verificationSummary:
        typeof parsed.verificationSummary === 'string' &&
        parsed.verificationSummary.trim()
          ? parsed.verificationSummary.trim()
          : null,
    };
  } catch {
    return {
      ...reply,
      changedFiles: [],
      verificationSummary: null,
    };
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

async function runCodexTurn(input: {
  dir: string;
  resolvedDir: string;
  prompt: string;
  sessionId: string | null;
  threadStartedText?: string;
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
  if (spawnSpec.command !== codexCommand) {
    console.error(
      `[manager-backend] codex shim rewritten: ${codexCommand} → ${spawnSpec.command} (shell: ${spawnSpec.spawnOptions.shell})`
    );
  }
  const proc = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.spawnOptions);
  activeChildProcesses.add(proc);
  proc.on('close', () => {
    activeChildProcesses.delete(proc);
  });

  let stdout = '';
  let stderr = '';
  let pendingStdout = '';
  let pendingStderr = '';
  let latestProgressText: string | null = null;
  let latestProgressSessionId: string | null = input.sessionId;
  let sawStructuredReply = false;
  let progressChain = Promise.resolve();
  let idleTimeout: ReturnType<typeof setTimeout> | null = null;
  let structuredReplyTimeout: ReturnType<typeof setTimeout> | null = null;
  let forcedExitResult: { code: number | null; stderrSuffix: string } | null =
    null;
  const idleTimeoutMs = codexIdleTimeoutMs();
  const structuredReplyCloseGraceMs = codexStructuredReplyCloseGraceMs();

  let resolveExitCode!: (code: number | null) => void;
  let rejectExitCode!: (error: unknown) => void;
  const exitCodePromise = new Promise<number | null>(
    (resolvePromise, reject) => {
      resolveExitCode = resolvePromise;
      rejectExitCode = reject;
    }
  );

  const clearStallTimers = (): void => {
    if (idleTimeout !== null) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }
    if (structuredReplyTimeout !== null) {
      clearTimeout(structuredReplyTimeout);
      structuredReplyTimeout = null;
    }
  };

  const forceCodexCompletion = async (
    code: number | null,
    stderrSuffix: string
  ): Promise<void> => {
    if (forcedExitResult) {
      return;
    }
    forcedExitResult = { code, stderrSuffix };
    clearStallTimers();
    if (proc.pid != null) {
      await killProcessTree(proc.pid).catch(() => {});
    }
    activeChildProcesses.delete(proc);
    resolveExitCode(code);
  };

  const armStallTimers = (): void => {
    clearStallTimers();
    idleTimeout = setTimeout(() => {
      void forceCodexCompletion(
        124,
        `[Manager error] Codex produced no progress for ${Math.round(
          idleTimeoutMs / 1000
        )} seconds and was terminated as stalled.`
      );
    }, idleTimeoutMs);

    if (sawStructuredReply) {
      structuredReplyTimeout = setTimeout(() => {
        void forceCodexCompletion(
          0,
          `[Manager notice] Codex emitted a structured final reply but did not exit within ${Math.round(
            structuredReplyCloseGraceMs / 1000
          )} seconds. The process was terminated and the latest structured reply was adopted.`
        );
      }, structuredReplyCloseGraceMs);
    }
  };

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
    const progress = parseCodexProgressLine(line, input.threadStartedText);
    if (progress.sessionId) {
      latestProgressSessionId = progress.sessionId;
    }
    if (progress.structuredReply) {
      sawStructuredReply = true;
    }
    if (progress.latestText) {
      latestProgressText = progress.latestText;
      enqueueProgress({
        sessionId: latestProgressSessionId,
        latestText: latestProgressText,
        liveEntries: progress.liveEntries,
        structuredReply: progress.structuredReply,
      });
    }
    armStallTimers();
  };

  const handleStderrLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    latestProgressText = trimmed;
    enqueueProgress({
      sessionId: latestProgressSessionId,
      latestText: trimmed,
      liveEntries: [
        {
          at: new Date().toISOString(),
          text: trimmed,
          kind: 'error',
        },
      ],
      structuredReply: null,
    });
    armStallTimers();
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
    armStallTimers();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    pendingStderr += text;

    const lines = pendingStderr.split(/\r?\n/);
    pendingStderr = lines.pop() ?? '';

    for (const line of lines) {
      handleStderrLine(line);
    }

    armStallTimers();
  });
  proc.stdin?.on('error', () => {
    /* ignore prompt pipe teardown races */
  });
  proc.stdin?.write(input.prompt);
  proc.stdin?.end();

  proc.on('error', (error) => {
    clearStallTimers();
    rejectExitCode(error);
  });
  proc.on('close', (code) => {
    clearStallTimers();
    resolveExitCode(code);
  });

  await input.onSpawn?.(proc.pid ?? null);

  armStallTimers();

  const exitCode = await exitCodePromise;

  if (pendingStdout.trim()) {
    handleProgressLine(pendingStdout);
  }
  if (pendingStderr.trim()) {
    handleStderrLine(pendingStderr);
  }

  await progressChain;
  clearStallTimers();

  const finalForcedExitResult = forcedExitResult as {
    code: number | null;
    stderrSuffix: string;
  } | null;
  if (finalForcedExitResult !== null) {
    stderr = `${stderr}\n${finalForcedExitResult.stderrSuffix}`.trim();
  }

  return {
    code: finalForcedExitResult?.code ?? exitCode,
    stdout,
    stderr,
    parsed: parseCodexOutput(stdout),
  };
}

// Per-workspace in-flight guard (module-level singleton, safe for single server process).
const inFlight = new Set<string>();
const rerunRequested = new Set<string>();
const rerunDepth = new Map<string, number>();
const MAX_RERUN_DEPTH = 5;
const routingLocks = new Map<string, Promise<void>>();
const MAX_ROUTING_TOPIC_CANDIDATES = 40;

function makeFallbackThreadTitle(content: string): string {
  const normalized = extractManagerMessagePlainText(content);
  if (!normalized) {
    return '新しい話題';
  }
  return normalized.slice(0, 48);
}

function threadUpdatedAtMs(thread: Thread): number {
  const updatedAt = new Date(thread.updatedAt).getTime();
  return Number.isNaN(updatedAt) ? 0 : updatedAt;
}

function pickRoutingCandidateThreads(
  threads: Thread[],
  contextThreadId?: string | null
): Thread[] {
  const sorted = [...threads].sort((left, right) => {
    const updatedDiff = threadUpdatedAtMs(right) - threadUpdatedAtMs(left);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    if (left.status === right.status) {
      return 0;
    }
    return left.status === 'resolved' ? 1 : -1;
  });

  if (!contextThreadId) {
    return sorted.slice(0, MAX_ROUTING_TOPIC_CANDIDATES);
  }

  const contextThread = sorted.find((thread) => thread.id === contextThreadId);
  const withoutContext = sorted.filter(
    (thread) => thread.id !== contextThreadId
  );
  return (
    contextThread ? [contextThread, ...withoutContext] : withoutContext
  ).slice(0, MAX_ROUTING_TOPIC_CANDIDATES);
}

function managerThreadMetaHasContent(meta: ManagerThreadMeta): boolean {
  return Object.values(meta).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== null && value !== undefined && value !== '';
  });
}

async function clearThreadRoutingStatePreservingContinuity(
  dir: string,
  threadId: string
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, (current) => {
    if (!current) {
      return null;
    }

    const next: ManagerThreadMeta = { ...current };
    delete next.routingConfirmationNeeded;
    delete next.routingHint;
    delete next.lastRoutingAt;
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
  });
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
  await updateSession(input.dir, (session) => ({
    ...session,
    activeAssignments: [...session.activeAssignments, input.assignment],
    lastMessageAt: new Date().toISOString(),
    priorityStreak: input.priorityStreak,
    lastErrorMessage: null,
    lastErrorAt: null,
  }));
}

async function removeAssignment(
  dir: string,
  assignmentId: string
): Promise<ManagerSession> {
  return updateSession(dir, (session) => {
    const updated = updateSessionAssignment(session, assignmentId, () => null);
    // When the last assignment is removed, clear any stale error so the UI
    // does not keep showing a past error for an assignment that no longer exists.
    if (
      updated.activeAssignments.length === 0 &&
      updated.lastErrorMessage !== null
    ) {
      return { ...updated, lastErrorMessage: null, lastErrorAt: null };
    }
    return updated;
  });
}

async function patchAssignment(
  dir: string,
  assignmentId: string,
  updater: (current: ManagerActiveAssignment) => ManagerActiveAssignment | null
): Promise<ManagerSession> {
  return updateSession(dir, (session) =>
    updateSessionAssignment(session, assignmentId, updater)
  );
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
    if (assignment.worktreePath && assignment.worktreeBranch) {
      await removeWorktree({
        targetRepoRoot: assignment.targetRepoRoot ?? input.dir,
        worktreePath: assignment.worktreePath,
        branchName: assignment.worktreeBranch,
      }).catch(() => {});
    }
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
  const workerCwd = assignment.worktreePath ?? resolvedDir;
  const targetRepoRoot = assignment.targetRepoRoot ?? resolvedDir;
  const promptContent = mergeQueuedEntryContent(entries);
  const promptThread = stripTrailingUserMessagesFromThread(thread);
  let workerSessionId = await readWorkerSessionId(resolvedDir, thread.id);
  const imagePaths = queueEntriesImagePaths(entries);

  const runTurn = async (turn: {
    prompt: string;
    sessionId: string | null;
    assigneeKind: 'manager' | 'worker';
    assigneeLabel: string;
    runtimeState: ManagerWorkerRuntimeState;
    runtimeDetail: string;
    initialLiveOutput: string;
    clearLiveLog: boolean;
    preserveWorkerSessionId: boolean;
  }) => {
    let lastLiveOutput = turn.initialLiveOutput;

    await setWorkerRuntimeState({
      dir: resolvedDir,
      threadId: thread.id,
      assigneeKind: turn.assigneeKind,
      assigneeLabel: turn.assigneeLabel,
      workerSessionId,
      workerAgentId: assignment.id,
      runtimeState: turn.runtimeState,
      runtimeDetail: turn.runtimeDetail,
      workerWriteScopes: assignment.writeScopes,
      workerBlockedByThreadIds: [],
      supersededByThreadId: null,
      clearWorkerLiveLog: turn.clearLiveLog,
    });
    await appendWorkerLiveOutput({
      dir: resolvedDir,
      threadId: thread.id,
      text: turn.initialLiveOutput,
      kind: 'status',
      assigneeKind: turn.assigneeKind,
      assigneeLabel: turn.assigneeLabel,
      workerSessionId,
      workerAgentId: assignment.id,
      runtimeState: turn.runtimeState,
      runtimeDetail: turn.runtimeDetail,
      workerWriteScopes: assignment.writeScopes,
    });

    return runCodexTurn({
      dir,
      resolvedDir: workerCwd,
      prompt: turn.prompt,
      sessionId: turn.sessionId,
      threadStartedText: turn.initialLiveOutput,
      imagePaths,
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
          progress.latestText?.trim() || GENERIC_LIVE_PROGRESS_TEXT;
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
            assigneeKind: turn.assigneeKind,
            assigneeLabel: turn.assigneeLabel,
            workerSessionId: turn.preserveWorkerSessionId
              ? workerSessionId
              : (progress.sessionId ?? turn.sessionId ?? workerSessionId),
            workerAgentId: assignment.id,
            runtimeState: turn.runtimeState,
            runtimeDetail: turn.runtimeDetail,
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
  };

  const runPrimaryTurn = async (
    currentSessionId: string | null,
    isFirstTurn: boolean
  ) =>
    runTurn({
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
              worktreePath: assignment.worktreePath,
              isFirstTurn,
            }),
      sessionId: currentSessionId,
      assigneeKind: assignment.assigneeKind,
      assigneeLabel: assignment.assigneeLabel,
      runtimeState:
        assignment.assigneeKind === 'manager'
          ? 'manager-answering'
          : 'worker-running',
      runtimeDetail:
        assignment.assigneeKind === 'manager'
          ? 'Manager がこの作業項目を直接処理しています。'
          : '担当 worker agent がこの作業項目を実行中です。',
      initialLiveOutput:
        assignment.assigneeKind === 'manager'
          ? MANAGER_LIVE_PREPARING_TEXT
          : WORKER_LIVE_STARTED_TEXT,
      clearLiveLog: true,
      preserveWorkerSessionId: false,
    });

  try {
    let primaryResult = await runPrimaryTurn(
      workerSessionId,
      workerSessionId === null
    );
    const firstCombinedOutput = `${primaryResult.stdout}\n${primaryResult.stderr}`;
    if (
      assignment.assigneeKind === 'worker' &&
      primaryResult.code !== 0 &&
      workerSessionId &&
      isSessionInvalidError(firstCombinedOutput)
    ) {
      await writeWorkerSessionId(resolvedDir, thread.id, null);
      workerSessionId = null;
      primaryResult = await runPrimaryTurn(null, true);
    }

    const stillTracked = (await readSession(dir)).activeAssignments.some(
      (current) => current.id === assignment.id
    );
    if (!stillTracked) {
      return;
    }

    const nextWorkerSessionId =
      primaryResult.parsed.sessionId ?? workerSessionId;
    let finalResult = primaryResult;
    let finalCombinedOutput = `${primaryResult.stdout}\n${primaryResult.stderr}`;
    let finalParsedReply = parseManagerReplyPayload(primaryResult.parsed.text);
    let finalFallbackReply =
      primaryResult.code === 0 && primaryResult.parsed.text
        ? primaryResult.parsed.text
        : null;
    let reviewStepAttempted = false;
    let latestReportedChangedFiles: string[] = [];
    let deliveryReadinessDetail: string | null = null;
    let deliveryAheadCommitCount = 0;

    if (
      assignment.assigneeKind === 'worker' &&
      primaryResult.code === 0 &&
      (finalParsedReply || finalFallbackReply)
    ) {
      const workerResult = parseManagerWorkerResultPayload(
        primaryResult.parsed.text
      ) ?? {
        status: finalParsedReply?.status ?? MANAGER_REPLY_STATUS,
        reply: finalParsedReply?.reply ?? finalFallbackReply ?? '',
        changedFiles: [],
        verificationSummary: null,
      };
      latestReportedChangedFiles = workerResult.changedFiles;
      workerSessionId = nextWorkerSessionId;
      await writeWorkerSessionId(resolvedDir, thread.id, nextWorkerSessionId);
      reviewStepAttempted = true;
      const structuralWarnings = await runStructuralChecks(
        workerCwd,
        workerResult.changedFiles
      );
      finalResult = await runTurn({
        prompt: buildManagerReviewPrompt({
          thread: promptThread,
          workerResult,
          resolvedDir,
          worktreePath: assignment.worktreePath,
          writeScopes: assignment.writeScopes,
          structuralWarnings,
        }),
        sessionId: null,
        assigneeKind: 'manager',
        assigneeLabel: defaultAssigneeLabel('manager'),
        runtimeState: 'manager-answering',
        runtimeDetail:
          'Manager が worker の成果をレビューし、必要な反映と引き渡しを進めています。',
        initialLiveOutput: 'Manager が worker の成果を確認しています…',
        clearLiveLog: false,
        preserveWorkerSessionId: true,
      });

      const stillTrackedAfterReview = (
        await readSession(dir)
      ).activeAssignments.some((current) => current.id === assignment.id);
      if (!stillTrackedAfterReview) {
        return;
      }

      finalCombinedOutput = `${finalResult.stdout}\n${finalResult.stderr}`;
      finalParsedReply = parseManagerReplyPayload(finalResult.parsed.text);
      finalFallbackReply =
        finalResult.code === 0 && finalResult.parsed.text
          ? finalResult.parsed.text
          : null;
    }

    // -----------------------------------------------------------------------
    // Determine if the result is approved
    // -----------------------------------------------------------------------

    let currentParsedReply = finalParsedReply;
    let currentFallbackReply = finalFallbackReply;
    const isResultApproved = (
      code: number | null,
      parsed: ManagerReplyPayload | null,
      fallback: string | null,
      reviewed: boolean
    ): boolean =>
      code === 0 &&
      (parsed !== null || fallback !== null) &&
      (!reviewed || parsed?.status === 'review' || (!parsed && !!fallback));

    let approved = isResultApproved(
      finalResult.code,
      currentParsedReply,
      currentFallbackReply,
      reviewStepAttempted
    );
    if (approved && reviewStepAttempted && assignment.worktreePath) {
      const readiness = await validateWorktreeReadyForMerge({
        targetRepoRoot,
        worktreePath: assignment.worktreePath,
        reportedChangedFiles: latestReportedChangedFiles,
      });
      deliveryReadinessDetail = readiness.detail;
      deliveryAheadCommitCount = readiness.aheadCommitCount;
      approved = readiness.ready;
    }

    // -----------------------------------------------------------------------
    // Recovery loop — Manager decides how to handle review failures
    // -----------------------------------------------------------------------

    if (!approved && reviewStepAttempted) {
      let recoveryErrorContext: string;
      if (deliveryReadinessDetail) {
        recoveryErrorContext = `Delivery readiness check failed:\n${deliveryReadinessDetail}`;
      } else if (finalResult.code !== 0) {
        recoveryErrorContext = `Review exited with code ${finalResult.code ?? '?'}.${finalResult.stderr ? `\n${finalResult.stderr.slice(0, 500)}` : ''}`;
      } else if (currentParsedReply?.status === 'needs-reply') {
        recoveryErrorContext = `Review returned needs-reply:\n${currentParsedReply.reply}`;
      } else {
        recoveryErrorContext =
          'The review reply could not be parsed as valid Manager JSON.';
      }

      const MAX_RECOVERY_ATTEMPTS = 10;
      for (
        let recoveryAttempt = 0;
        recoveryAttempt < MAX_RECOVERY_ATTEMPTS;
        recoveryAttempt++
      ) {
        const stillTrackedRecovery = (
          await readSession(dir)
        ).activeAssignments.some((current) => current.id === assignment.id);
        if (!stillTrackedRecovery) {
          return;
        }

        // --- Recovery decision turn ---
        const recoveryDecisionResult = await runTurn({
          prompt: buildManagerRecoveryPrompt({
            thread: promptThread,
            errorContext: recoveryErrorContext,
            resolvedDir,
            worktreePath: assignment.worktreePath,
          }),
          sessionId: null,
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          runtimeState: 'manager-recovery',
          runtimeDetail: `Manager がレビュー結果を分析し回復方法を決定中（試行 ${recoveryAttempt + 1}/${MAX_RECOVERY_ATTEMPTS}）`,
          initialLiveOutput:
            'Manager がレビュー結果の回復方法を判断しています…',
          clearLiveLog: false,
          preserveWorkerSessionId: true,
        });

        const decision = parseManagerRecoveryDecision(
          recoveryDecisionResult.parsed.text
        );

        // --- Escalate: cannot recover automatically ---
        if (!decision || decision.decision === 'escalate') {
          const escalateMsg = decision?.reason
            ? `[Manager] 自動回復できませんでした。\n理由: ${decision.reason}\n\n元のエラー:\n${recoveryErrorContext}`
            : `[Manager] 回復判断を解釈できませんでした。\n\n元のエラー:\n${recoveryErrorContext}`;
          try {
            await addMessage(
              resolvedDir,
              thread.id,
              escalateMsg,
              'ai',
              'needs-reply'
            );
          } catch {
            /* thread may have been deleted */
          }
          await updateQueueLocked(dir, (queue) =>
            queue.filter(
              (entry) => !assignment.queueEntryIds.includes(entry.id)
            )
          );
          if (isSessionInvalidError(finalCombinedOutput)) {
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
          if (assignment.worktreePath && assignment.worktreeBranch) {
            await removeWorktree({
              targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
              worktreePath: assignment.worktreePath,
              branchName: assignment.worktreeBranch,
            }).catch(() => {});
          }
          void processNextQueued(dir, resolvedDir);
          return;
        }

        // --- Restart: clean up and re-queue from scratch ---
        if (decision.decision === 'restart') {
          try {
            await addMessage(
              resolvedDir,
              thread.id,
              `[Manager] アプローチをリセットして最初からやり直します。\n理由: ${decision.reason}`,
              'ai',
              'active'
            );
          } catch {
            /* thread may have been deleted */
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
          if (assignment.worktreePath && assignment.worktreeBranch) {
            await removeWorktree({
              targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
              worktreePath: assignment.worktreePath,
              branchName: assignment.worktreeBranch,
            }).catch(() => {});
          }
          // Queue entries are NOT removed — they will be re-dispatched
          await writeWorkerSessionId(resolvedDir, thread.id, null);
          void processNextQueued(dir, resolvedDir);
          return;
        }

        // --- fix-self or retry-worker: execute fix then re-review ---
        let fixResult;
        if (decision.decision === 'fix-self') {
          fixResult = await runTurn({
            prompt: buildManagerRecoveryFixPrompt({
              instructions: decision.instructions ?? recoveryErrorContext,
              thread: promptThread,
              resolvedDir,
              worktreePath: assignment.worktreePath,
              writeScopes: assignment.writeScopes,
            }),
            sessionId: null,
            assigneeKind: 'manager',
            assigneeLabel: defaultAssigneeLabel('manager'),
            runtimeState: 'manager-answering',
            runtimeDetail: 'Manager がレビューで発見した問題を直接修正中…',
            initialLiveOutput: 'Manager が問題を修正しています…',
            clearLiveLog: false,
            preserveWorkerSessionId: true,
          });
        } else {
          // retry-worker
          fixResult = await runTurn({
            prompt: buildWorkerRetryPrompt({
              instructions: decision.instructions ?? recoveryErrorContext,
              thread: promptThread,
              resolvedDir,
              worktreePath: assignment.worktreePath,
            }),
            sessionId: null,
            assigneeKind: 'worker',
            assigneeLabel: assignment.assigneeLabel,
            runtimeState: 'worker-running',
            runtimeDetail: 'Worker がレビュー指摘の修正を実行中…',
            initialLiveOutput: 'Worker がレビュー指摘を修正しています…',
            clearLiveLog: false,
            preserveWorkerSessionId: false,
          });
        }

        const stillTrackedAfterFix = (
          await readSession(dir)
        ).activeAssignments.some((current) => current.id === assignment.id);
        if (!stillTrackedAfterFix) {
          return;
        }

        // Parse fix result — if fix itself produced no usable output, loop
        const fixParsedReply = parseManagerReplyPayload(fixResult.parsed.text);
        if (fixResult.code !== 0 || !fixParsedReply) {
          recoveryErrorContext =
            `Recovery attempt ${recoveryAttempt + 1} (${decision.decision}) failed: ` +
            (fixResult.code !== 0
              ? `exited with code ${fixResult.code}.${fixResult.stderr ? `\n${fixResult.stderr.slice(0, 300)}` : ''}`
              : 'No parseable reply from fix attempt.');
          continue;
        }

        // Re-review the fix
        const fixWorkerResult = parseManagerWorkerResultPayload(
          fixResult.parsed.text
        ) ?? {
          status: fixParsedReply.status,
          reply: fixParsedReply.reply,
          changedFiles: [],
          verificationSummary: null,
        };
        latestReportedChangedFiles = fixWorkerResult.changedFiles;
        const reStructuralWarnings = await runStructuralChecks(
          workerCwd,
          fixWorkerResult.changedFiles
        );
        const reReviewResult = await runTurn({
          prompt: buildManagerReviewPrompt({
            thread: promptThread,
            workerResult: fixWorkerResult,
            resolvedDir,
            worktreePath: assignment.worktreePath,
            writeScopes: assignment.writeScopes,
            structuralWarnings: reStructuralWarnings,
          }),
          sessionId: null,
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          runtimeState: 'manager-answering',
          runtimeDetail: 'Manager が修正結果をレビュー中…',
          initialLiveOutput: 'Manager が修正結果を確認しています…',
          clearLiveLog: false,
          preserveWorkerSessionId: true,
        });

        const stillTrackedAfterReReview = (
          await readSession(dir)
        ).activeAssignments.some((current) => current.id === assignment.id);
        if (!stillTrackedAfterReReview) {
          return;
        }

        const reReviewParsed = parseManagerReplyPayload(
          reReviewResult.parsed.text
        );
        const reReviewFallback =
          reReviewResult.code === 0 && reReviewResult.parsed.text
            ? reReviewResult.parsed.text
            : null;

        if (
          isResultApproved(
            reReviewResult.code,
            reReviewParsed,
            reReviewFallback,
            true
          )
        ) {
          if (assignment.worktreePath) {
            const readiness = await validateWorktreeReadyForMerge({
              targetRepoRoot,
              worktreePath: assignment.worktreePath,
              reportedChangedFiles: latestReportedChangedFiles,
            });
            deliveryReadinessDetail = readiness.detail;
            deliveryAheadCommitCount = readiness.aheadCommitCount;
            if (!readiness.ready) {
              recoveryErrorContext = `Delivery readiness check failed:\n${readiness.detail}`;
              continue;
            }
          } else {
            deliveryReadinessDetail = null;
            deliveryAheadCommitCount = 0;
          }
          // Recovery succeeded — update reply for the success path
          currentParsedReply = reReviewParsed;
          currentFallbackReply = reReviewFallback;
          approved = true;
          break;
        }

        // Not approved yet — update error context and loop
        if (reReviewParsed?.status === 'needs-reply') {
          recoveryErrorContext = `Re-review returned needs-reply:\n${reReviewParsed.reply}`;
        } else if (reReviewResult.code !== 0) {
          recoveryErrorContext = `Re-review exited with code ${reReviewResult.code}.${reReviewResult.stderr ? `\n${reReviewResult.stderr.slice(0, 300)}` : ''}`;
        } else {
          recoveryErrorContext =
            'Re-review reply could not be parsed as valid Manager JSON.';
        }
      }

      // Exhausted all recovery attempts — escalate
      if (!approved) {
        const exhaustedMsg = `[Manager] ${MAX_RECOVERY_ATTEMPTS} 回の回復試行で解決できませんでした。ユーザーの確認が必要です。\n\n最終エラー:\n${recoveryErrorContext}`;
        try {
          await addMessage(
            resolvedDir,
            thread.id,
            exhaustedMsg,
            'ai',
            'needs-reply'
          );
        } catch {
          /* thread may have been deleted */
        }
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
        if (assignment.worktreePath && assignment.worktreeBranch) {
          await removeWorktree({
            targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
            worktreePath: assignment.worktreePath,
            branchName: assignment.worktreeBranch,
          }).catch(() => {});
        }
        void processNextQueued(dir, resolvedDir);
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Success path — merge, push, post reply, clean up
    // -----------------------------------------------------------------------

    if (approved) {
      if (assignment.worktreePath && assignment.worktreeBranch) {
        await appendWorkerLiveOutput({
          dir: resolvedDir,
          threadId: thread.id,
          text: 'Worker の変更をメインブランチにマージしています…',
          kind: 'status',
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          workerSessionId,
          workerAgentId: assignment.id,
          runtimeState: 'manager-answering',
          runtimeDetail: 'メインブランチへマージ中…',
          workerWriteScopes: assignment.writeScopes,
        });

        // Snapshot the current build before merge so we can rollback if needed.
        try {
          await snapshotBuild(resolvePackageRoot());
        } catch (snapshotErr) {
          console.error(
            '[manager-backend] Pre-merge build snapshot failed:',
            snapshotErr instanceof Error ? snapshotErr.message : snapshotErr
          );
        }

        // Mark queue entries as processed before merge for crash safety.
        // If the process crashes after merge but before cleanup, these entries
        // won't be re-dispatched on restart.
        await updateQueueLocked(dir, (queue) =>
          queue.map((entry) =>
            assignment.queueEntryIds.includes(entry.id)
              ? { ...entry, processed: true }
              : entry
          )
        );

        let mergeResult = await mergeWorktreeToMain({
          targetRepoRoot,
          branchName: assignment.worktreeBranch,
        });

        if (!mergeResult.success && mergeResult.conflicted) {
          await appendWorkerLiveOutput({
            dir: resolvedDir,
            threadId: thread.id,
            text: `コンフリクト検出（${mergeResult.conflictFiles.length} ファイル）。Manager が解消中…`,
            kind: 'status',
            assigneeKind: 'manager',
            assigneeLabel: defaultAssigneeLabel('manager'),
            workerSessionId,
            workerAgentId: assignment.id,
            runtimeState: 'manager-answering',
            runtimeDetail: 'マージコンフリクト解消中…',
            workerWriteScopes: assignment.writeScopes,
          });
          mergeResult = await resolveConflictAndVerify({
            targetRepoRoot,
            conflictFiles: mergeResult.conflictFiles,
            runCodexTurnFn: async (prompt, cwd) => {
              const result = await runCodexTurn({
                dir,
                resolvedDir: cwd,
                prompt,
                sessionId: null,
              });
              return { code: result.code, stderr: result.stderr };
            },
          });
        }

        if (!mergeResult.success) {
          const errMsg = `[Manager] マージに失敗しました: ${mergeResult.detail}`;
          try {
            await addMessage(
              resolvedDir,
              thread.id,
              errMsg,
              'ai',
              'needs-reply'
            );
          } catch {
            /* thread may have been deleted */
          }
          await removeWorktree({
            targetRepoRoot,
            worktreePath: assignment.worktreePath,
            branchName: assignment.worktreeBranch,
          }).catch(() => {});
          await removeAssignment(dir, assignment.id);
          void processNextQueued(dir, resolvedDir);
          return;
        }

        // Push after successful merge.
        await appendWorkerLiveOutput({
          dir: resolvedDir,
          threadId: thread.id,
          text: 'マージ完了。リモートへ push しています…',
          kind: 'status',
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          workerSessionId,
          workerAgentId: assignment.id,
          runtimeState: 'manager-answering',
          runtimeDetail: 'リモートへ push 中…',
          workerWriteScopes: assignment.writeScopes,
        });
        const pushResult = await pushWithRetry({ targetRepoRoot });
        const pushFailureDetail = pushResult.success ? null : pushResult.detail;

        // Clean up worktree.
        await removeWorktree({
          targetRepoRoot,
          worktreePath: assignment.worktreePath,
          branchName: assignment.worktreeBranch,
        }).catch(() => {});

        if (pushFailureDetail) {
          const errMsg = `[Manager] コミットは反映されましたが、リモートへの push に失敗しました: ${pushFailureDetail}`;
          try {
            await addMessage(
              resolvedDir,
              thread.id,
              errMsg,
              'ai',
              'needs-reply'
            );
          } catch {
            /* thread may have been deleted */
          }
          await updateQueueLocked(dir, (queue) =>
            queue.filter(
              (entry) => !assignment.queueEntryIds.includes(entry.id)
            )
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

        if (deliveryAheadCommitCount > 0) {
          await appendWorkerLiveOutput({
            dir: resolvedDir,
            threadId: thread.id,
            text: 'push 完了。必要な release / publish を続けて実行しています…',
            kind: 'status',
            assigneeKind: 'manager',
            assigneeLabel: defaultAssigneeLabel('manager'),
            workerSessionId,
            workerAgentId: assignment.id,
            runtimeState: 'manager-answering',
            runtimeDetail: 'release / publish の最終確認中…',
            workerWriteScopes: assignment.writeScopes,
          });
          const deliveryResult = await runPostMergeDeliveryChain({
            targetRepoRoot,
          });
          if (!deliveryResult.success) {
            const errMsg = `[Manager] コミットと push は完了しましたが、release / publish の完了前に停止しました: ${deliveryResult.detail}`;
            try {
              await addMessage(
                resolvedDir,
                thread.id,
                errMsg,
                'ai',
                'needs-reply'
              );
            } catch {
              /* thread may have been deleted */
            }
            await updateQueueLocked(dir, (queue) =>
              queue.filter(
                (entry) => !assignment.queueEntryIds.includes(entry.id)
              )
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
        }
      }

      await updateQueueLocked(dir, (queue) =>
        queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
      );
      try {
        await addMessage(
          resolvedDir,
          thread.id,
          currentParsedReply?.reply ?? currentFallbackReply ?? '',
          'ai',
          currentParsedReply?.status ?? MANAGER_REPLY_STATUS
        );
      } catch {
        /* thread may have been deleted */
      }
      if (assignment.assigneeKind === 'manager') {
        workerSessionId = nextWorkerSessionId;
        await writeWorkerSessionId(resolvedDir, thread.id, nextWorkerSessionId);
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
      return;
    }

    // -----------------------------------------------------------------------
    // Non-review failure (worker or manager turn failed before review)
    // -----------------------------------------------------------------------

    const errMsg =
      finalResult.code === 0
        ? '[Manager error] codex finished successfully but no usable assistant reply could be parsed from the JSON output.'
        : `[Manager error] codex CLI exited with code ${finalResult.code ?? '?'}.${finalResult.stderr ? `\n${finalResult.stderr.slice(0, 300)}` : ''}`;
    try {
      await addMessage(resolvedDir, thread.id, errMsg, 'ai', 'needs-reply');
    } catch {
      /* thread may have been deleted */
    }
    await setManagerRuntimeError(dir, errMsg);
    await updateQueueLocked(dir, (queue) =>
      queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
    );
    if (isSessionInvalidError(finalCombinedOutput)) {
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
    if (assignment.worktreePath && assignment.worktreeBranch) {
      await removeWorktree({
        targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
        worktreePath: assignment.worktreePath,
        branchName: assignment.worktreeBranch,
      }).catch(() => {});
    }
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
    if (assignment.worktreePath && assignment.worktreeBranch) {
      await removeWorktree({
        targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
        worktreePath: assignment.worktreePath,
        branchName: assignment.worktreeBranch,
      }).catch(() => {});
    }
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
        worktreePath: null,
        worktreeBranch: null,
        targetRepoRoot: null,
      };

      // Create isolated worktree for worker assignments.
      if (dispatch.assignee === 'worker') {
        const targetRepo = resolveTargetRepoRoot(
          resolvedDir,
          assignmentWriteScopes
        );
        try {
          const wt = await createWorkerWorktree({
            targetRepoRoot: targetRepo,
            assignmentId: assignment.id,
          });
          assignment.worktreePath = wt.worktreePath;
          assignment.worktreeBranch = wt.branchName;
          assignment.targetRepoRoot = wt.targetRepoRoot;
        } catch (wtErr) {
          const errMsg = `[Manager] Worker 隔離環境の作成に失敗しました: ${wtErr instanceof Error ? wtErr.message : String(wtErr)}`;
          try {
            await addMessage(
              resolvedDir,
              thread.id,
              errMsg,
              'ai',
              'needs-reply'
            );
          } catch {
            /* thread may have been deleted */
          }
          continue;
        }
      }

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
      const depth = (rerunDepth.get(resolvedDir) ?? 0) + 1;
      if (depth > MAX_RERUN_DEPTH) {
        rerunDepth.delete(resolvedDir);
        console.error(
          `[manager-backend] processNextQueued rerun depth exceeded (${MAX_RERUN_DEPTH}) for ${resolvedDir}; breaking loop`
        );
      } else {
        rerunDepth.set(resolvedDir, depth);
        void processNextQueued(dir, resolvedDir);
      }
    } else {
      rerunDepth.delete(resolvedDir);
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
  routingSessionId: string | null;
}> {
  const allThreads = await listThreads(input.dir);
  const routingThreads = pickRoutingCandidateThreads(
    allThreads,
    input.contextThreadId
  );
  const session = await readSession(input.dir);
  let routingSessionId = session.routingSessionId?.trim() || null;
  const promptImages = await materializeManagerPromptImages({
    workspaceKey: workspaceKey(input.dir),
    message: input.content,
  });
  let threadIdByTopicRef = new Map<string, string>();
  const runRoutingTurn = async (sessionId: string | null) => {
    const promptData = buildRoutingPrompt({
      content: input.content,
      resolvedDir: input.resolvedDir,
      threads: routingThreads,
      contextThreadId: input.contextThreadId,
      isFirstTurn: sessionId === null,
    });
    threadIdByTopicRef = promptData.threadIdByTopicRef;
    return runCodexTurn({
      dir: input.dir,
      resolvedDir: input.resolvedDir,
      prompt: promptData.prompt,
      sessionId,
      imagePaths: promptImages.map((image) => image.path),
    });
  };
  let runResult = await runRoutingTurn(routingSessionId);
  let combinedOutput = `${runResult.stdout}\n${runResult.stderr}`;

  if (
    runResult.code !== 0 &&
    routingSessionId &&
    isSessionInvalidError(combinedOutput)
  ) {
    routingSessionId = null;
    runResult = await runRoutingTurn(null);
    combinedOutput = `${runResult.stdout}\n${runResult.stderr}`;
  }

  if (runResult.code !== 0) {
    throw new Error(
      runResult.stderr.trim() ||
        runResult.stdout.trim() ||
        `codex CLI exited with code ${runResult.code ?? '?'}`
    );
  }

  const nextRoutingSessionId = runResult.parsed.sessionId ?? routingSessionId;
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
      routingSessionId: nextRoutingSessionId,
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
      routingSessionId: nextRoutingSessionId,
    };
  }

  return {
    plan: {
      actions: resolvedActions,
    },
    routingSessionId: nextRoutingSessionId,
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
      await updateSession(dir, (currentSession) => ({
        ...currentSession,
        status: 'idle',
        startedAt: currentSession.startedAt ?? new Date().toISOString(),
      }));
    }

    const { plan, routingSessionId } = await routeFreeformMessage({
      dir,
      resolvedDir,
      content,
      contextThreadId: options?.contextThreadId ?? null,
    });

    await updateSession(dir, (session) => ({
      ...session,
      routingSessionId,
      lastMessageAt: new Date().toISOString(),
    }));

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
          const userMessage = pickThreadUserMessage(
            content,
            action,
            plan.actions.length
          );
          await ensureThreadReadyForUserMessage(dir, action.threadId);
          await clearThreadRoutingStatePreservingContinuity(
            resolvedDir,
            action.threadId
          );
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
          const attachedThread = await getThread(dir, action.threadId);
          items.push({
            threadId: action.threadId,
            title: attachedThread?.title ?? action.threadId,
            outcome: 'attached-existing',
            reason:
              action.reason ??
              'この話題の続きとして扱い、そのまま実行に回しました。',
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

// ── Eager reconciliation (called at server startup) ────────────────────────

/**
 * Run assignment reconciliation immediately.  Intended to be called once at
 * server startup so that dead assignments left over from a previous crash are
 * cleaned up without waiting for the next queue tick.
 */
export async function eagerReconcile(dir: string): Promise<void> {
  await reconcileActiveAssignments(dir);
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
    return {
      running: true,
      configured: true,
      builtinBackend: true,
      health: 'ok',
      detail:
        session.activeAssignments.length === 1
          ? currentThread
            ? `処理中 (${currentThread.title})`
            : '処理中'
          : `処理中 (${session.activeAssignments.length}件)`,
      pendingCount: pending,
      currentQueueId: currentAssignment?.queueEntryIds[0] ?? null,
      currentThreadId: currentAssignment?.threadId ?? null,
      currentThreadTitle: currentThread?.title ?? null,
      errorMessage: null,
      errorAt: null,
    };
  }

  if (pending > 0) {
    let latestSession = await readSession(dir);
    if (latestSession.status === 'not-started') {
      latestSession = await updateSession(dir, (currentSession) => ({
        ...currentSession,
        status: 'idle',
        startedAt: currentSession.startedAt ?? new Date().toISOString(),
      }));
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
    await updateSession(dir, (currentSession) => ({
      ...currentSession,
      status: 'idle',
      startedAt: new Date().toISOString(),
    }));
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
    await updateSession(dir, (currentSession) => ({
      ...currentSession,
      status: 'idle',
      startedAt: new Date().toISOString(),
    }));
  }
  await enqueueMessage(dir, threadId, content, options);
  void processNextQueued(dir, resolvePath(dir));
}
