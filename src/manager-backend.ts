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
 *  - One persisted worker-agent session per Manager work item, with the
 *    runtime/model chosen from live ranked worker candidates
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
import { readFile, writeFile, appendFile, readdir, unlink } from 'fs/promises';
import { existsSync, readdirSync, statSync, type Dirent } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from 'path';
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
  isThreadInBackoff,
  MANAGER_THREAD_META_FILE,
  reconcileManagerThreadMeta,
  stripManagerRuntimeStatePreservingContinuity,
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
import { withSerializedKeyLock } from './promise-lock.js';
import {
  prepareNewRepoWorkspace,
  removeWorktree,
  resolveTargetRepoRoot,
  cleanupOrphanedWorktrees,
  execGit,
  findGitRoot,
  runPostMergeDeliveryChain,
  validateWorktreeReadyForMerge,
} from './manager-worktree.js';
import {
  cleanupOrphanedManagerWorktrees,
  createManagerWorktree,
  deliverManagerWorktree,
  describeMwtError,
  dropManagerWorktree,
  isManagerManagedWorktreePath,
  isManagedWorktreeRepository,
  isMwtDeliverRemoteAdvanceError,
  isMwtSeedTrackedDirtyError,
  listMwtChangedFiles,
  maybeAutoInitializeManagerRepository,
  repairManagerWorktreeResidue,
  isMwtDeliverConflictError,
} from './manager-mwt.js';
import { snapshotBuild, resolvePackageRoot } from './build-archive.js';
import {
  findManagedRepoByRoot,
  readManagedRepos,
  type ManagerRunMode,
  type ManagerTargetKind,
  type ManagerWorkerRuntime,
  resolveNewRepoRoot,
  validateNewRepoName,
} from './manager-repos.js';
import {
  buildWorkerRuntimeLaunchSpec,
  describeWorkerRuntimeCliAvailability,
  parseGenericRuntimeOutput,
  parseGenericRuntimeProgressLine,
  workerRuntimeDefaults,
  workerRuntimeAssigneeLabel,
} from './manager-worker-runtime.js';
import { selectRankedWorkerModel } from './manager-worker-model-selection.js';
import {
  isWindowsBatchCommand,
  wrapWindowsBatchCommandForSpawn,
} from './windows-batch-spawn.js';

export const MANAGER_SESSION_FILE = '.workspace-agent-hub-manager.json';
export const MANAGER_QUEUE_FILE = '.workspace-agent-hub-manager-queue.jsonl';

/** Manager backend target: Codex GPT-5.4 at xhigh reasoning effort. */
export const MANAGER_MODEL = 'gpt-5.4';
export const MANAGER_REASONING_EFFORT = 'xhigh';

type ManagerRuntime = Extract<ManagerWorkerRuntime, 'opencode' | 'codex'>;

function resolveManagerRuntime(
  env: NodeJS.ProcessEnv = process.env
): ManagerRuntime {
  return env.WORKSPACE_AGENT_HUB_MANAGER_RUNTIME?.trim().toLowerCase() ===
    'codex'
    ? 'codex'
    : 'opencode';
}

function managerAssigneeLabel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveManagerRuntime(env) === 'codex'
    ? `Manager ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`
    : 'Manager OpenCode (Sisyphus)';
}

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

const MANAGER_TOPIC_SCOPE_GUARD =
  'Stay inside the current work item. Do not mention other work items, unrelated CI/build failures, or adjacent repository issues unless the latest user request explicitly asks for them or they are required evidence for this exact task.';

const MANAGER_WORKER_SYSTEM_PROMPT =
  'You are the built-in execution worker for Workspace Agent Hub. ' +
  'After the Manager routes a user request into a topic, you must actually do the work in this repository when possible: inspect files, modify code, run verification, and continue until you either reach a reviewable result or need user input. ' +
  'Do not stop at acknowledgement-only replies. ' +
  'Return concise user-facing progress/result text, but only after you have genuinely attempted the work. ' +
  'Implement and verify the task yourself, but in isolated Manager worktrees do not push, release, or publish; the Manager backend handles delivery after review. Commit only when the worktree is actually ready for Manager delivery. ' +
  `${MANAGER_TOPIC_SCOPE_GUARD} ` +
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
  'Treat the worker report as internal input only; your final reply must directly answer the latest user request in this work item. ' +
  'Do not frame the final reply as commentary on the worker unless the user explicitly asked for a review of the worker. ' +
  'Run the repo-standard verification needed for this task when necessary. ' +
  'If the work is acceptable, leave it in the correct state for the Manager backend to deliver through the appropriate commit/merge/push/release path for this repository target. ' +
  'The user sees your final reply only after the Manager backend finishes any required merge, push, release, or publish work, so describe the delivered end state rather than a future backend step. ' +
  'Keep the scope limited to this work item. Prefer the worker-reported changed files and declared write scopes when reviewing or staging changes, and do not include unrelated repository changes. ' +
  `${MANAGER_TOPIC_SCOPE_GUARD} ` +
  'When the user asks what happened when, use the exact message timestamps provided in this prompt plus repository evidence instead of guessing from relative timing. ' +
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
  targetKind?: ManagerTargetKind | null;
  repoId?: string | null;
  newRepoName?: string | null;
  workingDirectory?: string | null;
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
  /** Latest manager-runtime pause surfaced to the GUI. */
  lastPauseMessage: string | null;
  lastPauseAt: string | null;
  /** When a quota pause should be retried automatically. */
  lastPauseAutoResumeAt?: string | null;
  /** Active manager/worker assignments currently running for queued work items. */
  activeAssignments: ManagerActiveAssignment[];
  /** Canonical transient runtime state while a queued item is being started/resumed. */
  dispatchingThreadId?: string | null;
  dispatchingQueueEntryIds?: string[] | null;
  dispatchingAssigneeKind?: 'manager' | 'worker' | null;
  dispatchingAssigneeLabel?: string | null;
  dispatchingDetail?: string | null;
  dispatchingStartedAt?: string | null;
}

export interface ManagerActiveAssignment {
  id: string;
  threadId: string;
  queueEntryIds: string[];
  assigneeKind: 'manager' | 'worker';
  targetKind: ManagerTargetKind;
  newRepoName: string | null;
  workerRuntime: ManagerWorkerRuntime;
  workerModel: string | null;
  workerEffort: string | null;
  assigneeLabel: string;
  writeScopes: string[];
  pid: number | null;
  startedAt: string;
  lastProgressAt: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  targetRepoRoot: string | null;
  workingDirectory: string | null;
  pendingOnboardingCommit?: string | null;
}

export type ManagerHealth = 'ok' | 'error' | 'paused';
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

function codexTurnTimeoutMs(): number {
  return parseEnvDurationMs(
    'WORKSPACE_AGENT_HUB_CODEX_TURN_TIMEOUT_MS',
    60 * 60_000
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
  targetKind?: ManagerTargetKind | null;
  repoId?: string | null;
  newRepoName?: string | null;
  workingDirectory?: string | null;
  writeScopes?: string[];
  targetRepoRoot?: string | null;
  requestedRunMode?: ManagerRunMode | null;
  requestedWorkerRuntime?: ManagerWorkerRuntime | null;
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
    lastPauseMessage: null,
    lastPauseAt: null,
    lastPauseAutoResumeAt: null,
    activeAssignments: [],
    dispatchingThreadId: null,
    dispatchingQueueEntryIds: [],
    dispatchingAssigneeKind: null,
    dispatchingAssigneeLabel: null,
    dispatchingDetail: null,
    dispatchingStartedAt: null,
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

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function isPathWithin(baseDir: string, candidatePath: string): boolean {
  const normalizedBase = resolvePath(baseDir);
  const normalizedCandidate = resolvePath(candidatePath);
  const relPath = relative(normalizedBase, normalizedCandidate);
  return (
    relPath === '' ||
    (!!relPath && !relPath.startsWith('..') && !isAbsolute(relPath))
  );
}

function resolveAssignmentWorkingDirectory(input: {
  requestedWorkingDirectory: string | null;
  workerRoot: string;
  targetRepoRoot: string | null;
}):
  | {
      resolvedWorkingDirectory: string;
      error: null;
    }
  | {
      resolvedWorkingDirectory: null;
      error: string;
    } {
  const workerRoot = resolvePath(input.workerRoot);
  const requestedWorkingDirectory = normalizeOptionalText(
    input.requestedWorkingDirectory
  );
  if (!requestedWorkingDirectory) {
    return {
      resolvedWorkingDirectory: workerRoot,
      error: null,
    };
  }

  let resolvedWorkingDirectory: string;
  if (isAbsolute(requestedWorkingDirectory)) {
    const absoluteRequested = resolvePath(requestedWorkingDirectory);
    if (isPathWithin(workerRoot, absoluteRequested)) {
      resolvedWorkingDirectory = absoluteRequested;
    } else if (
      input.targetRepoRoot &&
      isPathWithin(input.targetRepoRoot, absoluteRequested)
    ) {
      resolvedWorkingDirectory = resolvePath(
        workerRoot,
        relative(resolvePath(input.targetRepoRoot), absoluteRequested)
      );
    } else {
      return {
        resolvedWorkingDirectory: null,
        error: `Manager requested workingDirectory "${requestedWorkingDirectory}", but it is outside the assigned repository rooted at "${workerRoot}".`,
      };
    }
  } else {
    resolvedWorkingDirectory = resolvePath(
      workerRoot,
      requestedWorkingDirectory
    );
  }

  if (!isPathWithin(workerRoot, resolvedWorkingDirectory)) {
    return {
      resolvedWorkingDirectory: null,
      error: `Manager requested workingDirectory "${requestedWorkingDirectory}", but it resolves outside the assigned repository rooted at "${workerRoot}".`,
    };
  }
  if (!existsSync(resolvedWorkingDirectory)) {
    return {
      resolvedWorkingDirectory: null,
      error: `Manager requested workingDirectory "${requestedWorkingDirectory}", but "${resolvedWorkingDirectory}" does not exist.`,
    };
  }

  try {
    if (!statSync(resolvedWorkingDirectory).isDirectory()) {
      return {
        resolvedWorkingDirectory: null,
        error: `Manager requested workingDirectory "${requestedWorkingDirectory}", but "${resolvedWorkingDirectory}" is not a directory.`,
      };
    }
  } catch (error) {
    return {
      resolvedWorkingDirectory: null,
      error:
        error instanceof Error
          ? `Manager requested workingDirectory "${requestedWorkingDirectory}", but it could not be checked: ${error.message}`
          : `Manager requested workingDirectory "${requestedWorkingDirectory}", but it could not be checked.`,
    };
  }

  return {
    resolvedWorkingDirectory,
    error: null,
  };
}

function normalizeTargetKind(value: unknown): ManagerTargetKind | null {
  return value === 'existing-repo' || value === 'new-repo' ? value : null;
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
  const workerRuntime =
    record['workerRuntime'] === 'opencode' ||
    record['workerRuntime'] === 'claude' ||
    record['workerRuntime'] === 'copilot' ||
    record['workerRuntime'] === 'gemini' ||
    record['workerRuntime'] === 'codex'
      ? record['workerRuntime']
      : 'codex';
  const workerModel =
    typeof record['workerModel'] === 'string' && record['workerModel'].trim()
      ? record['workerModel'].trim()
      : null;
  const workerEffort =
    typeof record['workerEffort'] === 'string' && record['workerEffort'].trim()
      ? record['workerEffort'].trim()
      : null;
  const assigneeLabel =
    typeof record['assigneeLabel'] === 'string' &&
    record['assigneeLabel'].trim()
      ? record['assigneeLabel'].trim()
      : assigneeKind === 'manager'
        ? `Manager ${MANAGER_MODEL} (${MANAGER_REASONING_EFFORT})`
        : workerRuntimeAssigneeLabel(
            workerRuntime,
            process.env,
            workerModel || workerEffort
              ? {
                  model: workerModel,
                  effort: workerEffort,
                }
              : null
          );
  const queueEntryIds = normalizeStringArray(record['queueEntryIds']);
  if (!id || !threadId || queueEntryIds.length === 0) {
    return null;
  }

  return {
    id,
    threadId,
    queueEntryIds,
    assigneeKind,
    targetKind: normalizeTargetKind(record['targetKind']) ?? 'existing-repo',
    newRepoName: normalizeOptionalText(record['newRepoName']),
    workingDirectory: normalizeOptionalText(record['workingDirectory']),
    workerRuntime,
    workerModel,
    workerEffort,
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
    pendingOnboardingCommit:
      typeof record['pendingOnboardingCommit'] === 'string' &&
      record['pendingOnboardingCommit']
        ? record['pendingOnboardingCommit']
        : null,
  } satisfies ManagerActiveAssignment;
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
            targetKind: 'existing-repo' as const,
            newRepoName: null,
            workingDirectory: null,
            workerRuntime: 'codex' as const,
            workerModel: null,
            workerEffort: null,
            assigneeLabel: workerRuntimeAssigneeLabel('codex'),
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
            pendingOnboardingCommit: null,
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
  const dispatchingThreadId = normalizeOptionalText(
    session.dispatchingThreadId
  );
  const dispatchingQueueEntryIds = normalizeStringArray(
    session.dispatchingQueueEntryIds
  );
  const dispatchingAssigneeKind =
    session.dispatchingAssigneeKind === 'manager' ||
    session.dispatchingAssigneeKind === 'worker'
      ? session.dispatchingAssigneeKind
      : null;
  const dispatchingAssigneeLabel = normalizeOptionalText(
    session.dispatchingAssigneeLabel
  );
  const dispatchingDetail = normalizeOptionalText(session.dispatchingDetail);
  const dispatchingStartedAt = normalizeOptionalText(
    session.dispatchingStartedAt
  );

  return {
    ...base,
    ...session,
    status,
    pid: firstAssignment?.pid ?? null,
    currentQueueId: firstAssignment?.queueEntryIds[0] ?? null,
    activeAssignments,
    dispatchingThreadId,
    dispatchingQueueEntryIds,
    dispatchingAssigneeKind,
    dispatchingAssigneeLabel,
    dispatchingDetail,
    dispatchingStartedAt,
    lastPauseAutoResumeAt: normalizeOptionalTimestamp(
      session.lastPauseAutoResumeAt
    ),
  };
}

// ── Per-workspace write serialisation ─────────────────────────────────────
// Serialises concurrent queue/session mutations to prevent partial-write races
// between append (enqueue) and rewrite (writeQueue/writeSession) operations.
// Uses a promise-chain per key so each workspace is independent.
const _writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withSerializedKeyLock(_writeLocks, key, fn);
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

async function setManagerRuntimePause(
  dir: string,
  message: string,
  autoResumeAt: string | null = null
): Promise<void> {
  const resolvedDir = resolvePath(dir);
  const normalizedAutoResumeAt = normalizeOptionalTimestamp(autoResumeAt);
  await updateSession(dir, (session) => ({
    ...session,
    lastPauseMessage: message,
    lastPauseAt: new Date().toISOString(),
    lastPauseAutoResumeAt: normalizedAutoResumeAt,
  }));
  if (normalizedAutoResumeAt) {
    scheduleManagerQuotaAutoResume(dir, resolvedDir, normalizedAutoResumeAt);
  } else {
    cancelManagerQuotaAutoResumeTimer(resolvedDir);
  }
}

async function clearManagerRuntimePause(dir: string): Promise<void> {
  cancelManagerQuotaAutoResumeTimer(resolvePath(dir));
  await updateSession(dir, (session) =>
    session.lastPauseMessage === null &&
    session.lastPauseAt === null &&
    !session.lastPauseAutoResumeAt
      ? session
      : {
          ...session,
          lastPauseMessage: null,
          lastPauseAt: null,
          lastPauseAutoResumeAt: null,
        }
  );
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
          return [
            normalizeQueueEntry(
              normalizeManagerQueueEntry(JSON.parse(line) as QueueEntry)
            ),
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function normalizeQueueEntry(entry: QueueEntry): QueueEntry {
  return {
    ...entry,
    targetKind: normalizeTargetKind(entry.targetKind),
    repoId: normalizeOptionalText(entry.repoId),
    newRepoName: normalizeOptionalText(entry.newRepoName),
    workingDirectory: normalizeOptionalText(entry.workingDirectory),
    writeScopes: normalizeWriteScopes(entry.writeScopes),
    targetRepoRoot:
      typeof entry.targetRepoRoot === 'string' && entry.targetRepoRoot.trim()
        ? resolvePath(entry.targetRepoRoot)
        : null,
    requestedRunMode:
      entry.requestedRunMode === 'read-only' ||
      entry.requestedRunMode === 'write'
        ? entry.requestedRunMode
        : null,
    requestedWorkerRuntime:
      entry.requestedWorkerRuntime === 'opencode' ||
      entry.requestedWorkerRuntime === 'codex' ||
      entry.requestedWorkerRuntime === 'claude' ||
      entry.requestedWorkerRuntime === 'gemini' ||
      entry.requestedWorkerRuntime === 'copilot'
        ? entry.requestedWorkerRuntime
        : null,
  };
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
    targetKind?: ManagerTargetKind | null;
    repoId?: string | null;
    newRepoName?: string | null;
    workingDirectory?: string | null;
    writeScopes?: string[];
    targetRepoRoot?: string | null;
    requestedRunMode?: ManagerRunMode | null;
    requestedWorkerRuntime?: ManagerWorkerRuntime | null;
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
    targetKind: normalizeTargetKind(options?.targetKind),
    repoId: normalizeOptionalText(options?.repoId),
    newRepoName: normalizeOptionalText(options?.newRepoName),
    workingDirectory: normalizeOptionalText(options?.workingDirectory),
    writeScopes: normalizeWriteScopes(options?.writeScopes),
    targetRepoRoot:
      typeof options?.targetRepoRoot === 'string' &&
      options.targetRepoRoot.trim()
        ? resolvePath(options.targetRepoRoot)
        : null,
    requestedRunMode:
      options?.requestedRunMode === 'read-only' ||
      options?.requestedRunMode === 'write'
        ? options.requestedRunMode
        : null,
    requestedWorkerRuntime:
      options?.requestedWorkerRuntime === 'opencode' ||
      options?.requestedWorkerRuntime === 'codex' ||
      options?.requestedWorkerRuntime === 'claude' ||
      options?.requestedWorkerRuntime === 'gemini' ||
      options?.requestedWorkerRuntime === 'copilot'
        ? options.requestedWorkerRuntime
        : null,
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

function scopeLocksOverlap(
  left: string[],
  right: string[],
  leftRepoRoot: string | null = null,
  rightRepoRoot: string | null = null
): boolean {
  if (left.length === 0 || right.length === 0) {
    return false;
  }

  const normalizedLeftRepoRoot =
    typeof leftRepoRoot === 'string' && leftRepoRoot.trim()
      ? resolvePath(leftRepoRoot).toLowerCase()
      : null;
  const normalizedRightRepoRoot =
    typeof rightRepoRoot === 'string' && rightRepoRoot.trim()
      ? resolvePath(rightRepoRoot).toLowerCase()
      : null;
  if (
    normalizedLeftRepoRoot &&
    normalizedRightRepoRoot &&
    normalizedLeftRepoRoot !== normalizedRightRepoRoot
  ) {
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

function clearDispatchingSessionState(session: ManagerSession): ManagerSession {
  if (
    !session.dispatchingThreadId &&
    (session.dispatchingQueueEntryIds?.length ?? 0) === 0 &&
    !session.dispatchingAssigneeKind &&
    !session.dispatchingAssigneeLabel &&
    !session.dispatchingDetail &&
    !session.dispatchingStartedAt
  ) {
    return session;
  }
  return {
    ...session,
    dispatchingThreadId: null,
    dispatchingQueueEntryIds: [],
    dispatchingAssigneeKind: null,
    dispatchingAssigneeLabel: null,
    dispatchingDetail: null,
    dispatchingStartedAt: null,
  };
}

async function reconcileActiveAssignments(
  dir: string
): Promise<ManagerSession> {
  const resolvedDir = resolvePath(dir);
  const droppedAssignments: ManagerActiveAssignment[] = [];
  let survivingAssignments: ManagerActiveAssignment[] = [];
  const nextSession = await updateSession(dir, async (session) => {
    if (session.activeAssignments.length === 0) {
      survivingAssignments = [];
      const clearedSession = !inFlight.has(resolvedDir)
        ? clearDispatchingSessionState(session)
        : session;
      // Clear any stale error from a previous assignment that has already
      // been cleaned up — the error is no longer relevant.
      if (clearedSession.lastErrorMessage !== null) {
        return {
          ...clearedSession,
          lastErrorMessage: null,
          lastErrorAt: null,
        };
      }
      return clearedSession;
    }

    const queue = await readQueue(dir);
    const queueById = new Map(queue.map((entry) => [entry.id, entry]));
    let mutated = false;
    droppedAssignments.length = 0;
    const dedupedAssignments = new Map<string, ManagerActiveAssignment>();

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

      const existingAssignment = dedupedAssignments.get(
        normalizedAssignment.id
      );
      if (existingAssignment) {
        mutated = true;
        const preferredAssignment = choosePreferredAssignment(
          existingAssignment,
          normalizedAssignment
        );
        const duplicateAssignment =
          preferredAssignment === existingAssignment
            ? normalizedAssignment
            : existingAssignment;
        dedupedAssignments.set(normalizedAssignment.id, preferredAssignment);
        droppedAssignments.push(duplicateAssignment);
        continue;
      }
      dedupedAssignments.set(normalizedAssignment.id, normalizedAssignment);
    }

    survivingAssignments = [];
    for (const assignment of dedupedAssignments.values()) {
      if (!inspectAssignmentReservation(assignment).active) {
        droppedAssignments.push(assignment);
        continue;
      }
      survivingAssignments.push(assignment);
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
  const preservedDroppedAssignmentIds = new Set<string>();
  const preservedWorktreePathsByRepo = new Map<string, string[]>();
  for (const assignment of droppedAssignments) {
    const preservePausedWorktree =
      !survivingThreadIds.has(assignment.threadId) &&
      assignment.assigneeKind === 'worker' &&
      !!assignment.worktreePath &&
      !!assignment.worktreeBranch &&
      !!assignment.targetRepoRoot;
    if (preservePausedWorktree) {
      await preservePausedWorktreeForThread(
        dir,
        assignment.threadId,
        assignment
      );
      preservedDroppedAssignmentIds.add(assignment.id);
      const preservedTargetRepoRoot = assignment.targetRepoRoot!;
      const preservedWorktreePath = assignment.worktreePath!;
      const repoKey = resolvePath(preservedTargetRepoRoot);
      preservedWorktreePathsByRepo.set(repoKey, [
        ...(preservedWorktreePathsByRepo.get(repoKey) ?? []),
        preservedWorktreePath,
      ]);
    } else {
      await cleanupWorktreeBestEffort({
        targetRepoRoot: assignment.targetRepoRoot ?? dir,
        worktreePath: assignment.worktreePath,
        branchName: assignment.worktreeBranch,
        context: `Dropped assignment cleanup for ${assignment.id}`,
      });
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
  const activeIds = [
    ...survivingAssignments.map((a) => a.id),
    ...preservedDroppedAssignmentIds,
  ];
  await cleanupOrphanedWorktrees(dir, activeIds).catch(() => {});
  const activeWorktreePathsByRepo = new Map<string, string[]>();
  for (const assignment of survivingAssignments) {
    if (!assignment.targetRepoRoot || !assignment.worktreePath) {
      continue;
    }
    const key = resolvePath(assignment.targetRepoRoot);
    const current = activeWorktreePathsByRepo.get(key) ?? [];
    current.push(assignment.worktreePath);
    activeWorktreePathsByRepo.set(key, current);
  }
  for (const [
    targetRepoRoot,
    preservedWorktreePaths,
  ] of preservedWorktreePathsByRepo) {
    const current = activeWorktreePathsByRepo.get(targetRepoRoot) ?? [];
    current.push(...preservedWorktreePaths);
    activeWorktreePathsByRepo.set(targetRepoRoot, current);
  }
  for (const assignment of droppedAssignments) {
    if (!assignment.targetRepoRoot) {
      continue;
    }
    const key = resolvePath(assignment.targetRepoRoot);
    if (!activeWorktreePathsByRepo.has(key)) {
      activeWorktreePathsByRepo.set(key, []);
    }
  }
  for (const [
    targetRepoRoot,
    activeWorktreePaths,
  ] of activeWorktreePathsByRepo) {
    await cleanupOrphanedManagerWorktrees({
      targetRepoRoot,
      activeWorktreePaths,
    }).catch(() => {});
  }

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
    '--skip-git-repo-check',
    '--json',
    '--model',
    MANAGER_MODEL,
    '-c',
    `model_reasoning_effort="${MANAGER_REASONING_EFFORT}"`,
    '-'
  );
  return args;
}

export function shouldUseWindowsBatchWrapperForCodexCommand(
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return isWindowsBatchCommand(command, platform);
}

export function buildCodexSpawnOptions(
  command: string,
  resolvedDir: string,
  platform: NodeJS.Platform = process.platform,
  windowsVerbatimArguments = false
): {
  cwd: string;
  shell: boolean;
  windowsHide: boolean;
  windowsVerbatimArguments: boolean;
  stdio: ['pipe', 'pipe', 'pipe'];
} {
  return {
    cwd: resolvedDir,
    shell: false,
    windowsHide: platform === 'win32',
    windowsVerbatimArguments,
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
  }
): {
  command: string;
  args: string[];
  spawnOptions: {
    cwd: string;
    shell: boolean;
    windowsHide: boolean;
    windowsVerbatimArguments: boolean;
    stdio: ['pipe', 'pipe', 'pipe'];
  };
} {
  const platform = options?.platform ?? process.platform;
  const wrappedCommand = wrapWindowsBatchCommandForSpawn(command, args, {
    platform,
    env: options?.env,
  });

  return {
    command: wrappedCommand.command,
    args: wrappedCommand.args,
    spawnOptions: buildCodexSpawnOptions(
      wrappedCommand.command,
      resolvedDir,
      platform,
      wrappedCommand.windowsVerbatimArguments
    ),
  };
}

function logCliLaunch(input: {
  label: string;
  spawnSpec: {
    command: string;
    args: string[];
    spawnOptions: {
      cwd: string;
      shell: boolean;
      windowsHide: boolean;
      windowsVerbatimArguments: boolean;
      stdio: ['pipe', 'pipe', 'pipe'];
    };
  };
}): void {
  console.error(
    `[manager-backend] launching ${input.label}: ${JSON.stringify({
      command: input.spawnSpec.command,
      args: input.spawnSpec.args,
      cwd: input.spawnSpec.spawnOptions.cwd,
      shell: input.spawnSpec.spawnOptions.shell,
      windowsHide: input.spawnSpec.spawnOptions.windowsHide,
      windowsVerbatimArguments:
        input.spawnSpec.spawnOptions.windowsVerbatimArguments,
    })}`
  );
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
  return formatThreadHistoryForPrompt(thread);
}

function formatThreadHistoryForPrompt(
  thread: Thread,
  options?: {
    maxMessages?: number;
    includeTimestamps?: boolean;
  }
): string {
  if (thread.messages.length === 0) {
    return 'No previous messages in this topic.';
  }

  const maxMessages = options?.maxMessages ?? 12;
  return thread.messages
    .slice(-maxMessages)
    .map((message) =>
      formatThreadMessageForPrompt(message, {
        includeTimestamp: options?.includeTimestamps ?? false,
      })
    )
    .join('\n\n');
}

function formatThreadMessageForPrompt(
  message: Thread['messages'][number],
  options?: { includeTimestamp?: boolean }
): string {
  const sender = message.sender === 'ai' ? 'AI' : 'User';
  const prefix = options?.includeTimestamp
    ? `[${message.at}] ${sender}`
    : sender;
  return `${prefix}:\n${buildManagerMessagePromptContent(message.content).text}`;
}

function findLatestAiMessage(
  thread: Thread
): Thread['messages'][number] | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.sender === 'ai') {
      return message;
    }
  }
  return null;
}

function trailingUserMessages(
  thread: Thread
): Array<Thread['messages'][number]> {
  const messages: Array<Thread['messages'][number]> = [];
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (!message || message.sender !== 'user') {
      break;
    }
    messages.push(message);
  }
  return messages.reverse();
}

function mergeThreadMessageContent(
  messages: Array<Thread['messages'][number]>
): string {
  return messages
    .map((message) => message.content)
    .filter((content) => typeof content === 'string' && content.trim())
    .join('\n\n');
}

async function readLatestThreadPromptSnapshot(input: {
  dir: string;
  threadId: string;
  fallbackThread: Thread;
  fallbackPromptContent: string;
  fallbackPromptAt: string | null;
}): Promise<{
  thread: Thread;
  promptThread: Thread;
  promptContent: string;
  latestUserMessageAt: string | null;
}> {
  let latestThread = input.fallbackThread;
  try {
    const currentThread = await getThread(input.dir, input.threadId);
    if (currentThread) {
      latestThread = currentThread;
    }
  } catch {
    /* thread may have been deleted; keep the original snapshot */
  }

  const trailingMessages = trailingUserMessages(latestThread);
  const latestThreadUserAt =
    trailingMessages.at(-1)?.at ?? lastUserMessage(latestThread)?.at ?? null;
  const latestThreadUserAtMs = parseMessageTimestamp(latestThreadUserAt);
  const fallbackPromptAtMs = parseMessageTimestamp(input.fallbackPromptAt);
  const useThreadPrompt =
    latestThreadUserAtMs !== null &&
    (fallbackPromptAtMs === null || latestThreadUserAtMs >= fallbackPromptAtMs);
  const promptContent = useThreadPrompt
    ? mergeThreadMessageContent(trailingMessages).trim() ||
      input.fallbackPromptContent
    : input.fallbackPromptContent;
  return {
    thread: latestThread,
    promptThread: stripTrailingUserMessagesFromThread(latestThread),
    promptContent,
    latestUserMessageAt: useThreadPrompt
      ? latestThreadUserAt
      : input.fallbackPromptAt,
  };
}

function hasUserMessageAfter(thread: Thread, sinceAt: string | null): boolean {
  const sinceMs = parseMessageTimestamp(sinceAt);
  if (sinceMs === null) {
    return false;
  }
  return thread.messages.some((message) => {
    if (message.sender !== 'user') {
      return false;
    }
    const messageAt = parseMessageTimestamp(message.at);
    return messageAt !== null && messageAt > sinceMs;
  });
}

function latestTimestampValue(
  values: Array<string | null | undefined>
): string | null {
  let latestValue: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const valueMs = parseMessageTimestamp(value);
    if (valueMs === null || valueMs < latestMs) {
      continue;
    }
    latestMs = valueMs;
    latestValue = value ?? null;
  }
  return latestValue;
}

function normalizeVerificationPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim()
    .toLowerCase();
}

function isVitestUnitTestPath(path: string): boolean {
  const normalized = normalizeVerificationPath(path);
  if (!normalized || normalized.startsWith('e2e/')) {
    return false;
  }
  return (
    normalized.startsWith('src/__tests__/') ||
    (normalized.startsWith('src/') &&
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized))
  );
}

function buildVerificationGuidance(input: {
  paths: readonly string[];
  managedVerifyCommand?: string | null;
}): string[] {
  const guidance: string[] = [];
  const managedVerifyCommand = input.managedVerifyCommand?.trim();
  if (managedVerifyCommand) {
    guidance.push(
      `Prefer the repo-standard verification command first: ${managedVerifyCommand}.`
    );
  }
  if (input.paths.some((path) => isVitestUnitTestPath(path))) {
    guidance.push(
      'Files under src/__tests__ are Vitest unit tests. For focused reruns use `npm run test:unit -- <file ...>`, and do not send those files to Playwright.'
    );
  }
  return guidance;
}

export function buildWorkerExecutionPrompt(input: {
  content: string;
  thread: Thread;
  resolvedDir: string;
  workingDirectory: string | null;
  worktreePath: string | null;
  targetRepoRoot: string | null;
  repoTargetKind?: ManagerTargetKind | null;
  newRepoName?: string | null;
  newRepoRoot?: string | null;
  managedRepoLabel?: string | null;
  managedRepoRoot?: string | null;
  managedBaseBranch?: string | null;
  managedVerifyCommand?: string | null;
  requestedRunMode?: ManagerRunMode | null;
  writeScopes: string[];
  isFirstTurn: boolean;
}): string {
  const promptContent = buildManagerMessagePromptContent(input.content).text;
  const workspace =
    input.workingDirectory ??
    input.worktreePath ??
    input.targetRepoRoot ??
    input.resolvedDir;
  const verificationGuidance = buildVerificationGuidance({
    paths: input.writeScopes,
    managedVerifyCommand: input.managedVerifyCommand,
  });
  if (!input.isFirstTurn) {
    return [
      `[Topic: ${input.thread.title}]`,
      MANAGER_WORKER_JSON_RULES,
      'You are continuing an existing topic. Treat the newest user request below as the main thing to answer in this turn.',
      'Do not merely restate your previous conclusion unless it directly answers the new request.',
      `targetKind: ${input.repoTargetKind ?? 'existing-repo'}`,
      input.workingDirectory
        ? `workingDirectory: ${input.workingDirectory}`
        : '',
      `declaredWriteScopes: ${input.writeScopes.join(', ') || '(read-only)'}`,
      ...(verificationGuidance.length > 0
        ? ['Verification guidance:', ...verificationGuidance]
        : []),
      'Latest user request:',
      promptContent,
    ].join('\n\n');
  }

  const worktreeNotice = input.worktreePath
    ? input.requestedRunMode === 'read-only'
      ? 'This is an isolated git worktree prepared for inspection. Do NOT modify files, commit, or push. Read the repository state and run read-only verification only.'
      : 'This is an isolated managed task worktree. Make your changes and run verification, but do NOT push from this worktree. Commit only when the branch is genuinely ready for Manager delivery. The Manager will handle the final deliver, push, seed sync, and any release/publish follow-through.'
    : input.repoTargetKind === 'new-repo'
      ? 'This task targets a brand-new repository directory under the workspace root. Create and initialize the repository there as needed. Because there is no existing main branch to merge into, you own the direct delivery flow inside that repo.'
      : '';
  const repoContext = [
    `Target kind: ${input.repoTargetKind ?? 'existing-repo'}`,
    input.managedRepoLabel ? `Target repo: ${input.managedRepoLabel}` : '',
    input.managedRepoRoot ? `Target repo root: ${input.managedRepoRoot}` : '',
    input.newRepoName ? `New repo name: ${input.newRepoName}` : '',
    input.newRepoRoot ? `New repo root: ${input.newRepoRoot}` : '',
    input.workingDirectory
      ? `Worker working directory: ${input.workingDirectory}`
      : '',
    input.managedBaseBranch
      ? `Repo branch hint: ${input.managedBaseBranch}`
      : '',
    input.managedVerifyCommand
      ? `Repo verification hint: ${input.managedVerifyCommand}`
      : '',
    `Requested run mode: ${input.requestedRunMode ?? 'write'}`,
    `declaredWriteScopes: ${input.writeScopes.join(', ') || '(read-only)'}`,
    input.requestedRunMode === 'read-only'
      ? 'This is a read-only task. Inspect, explain, and verify without changing repository files.'
      : '',
  ].filter(Boolean);

  return [
    MANAGER_WORKER_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${workspace}`,
    ...(worktreeNotice ? [worktreeNotice] : []),
    ...repoContext,
    ...(verificationGuidance.length > 0
      ? ['Verification guidance:', ...verificationGuidance]
      : []),
    `[Topic: ${input.thread.title}]`,
    'Topic history:',
    formatThreadHistory(input.thread),
    'New user request:',
    promptContent,
  ].join('\n\n');
}

export function buildManagerReviewPrompt(input: {
  thread: Thread;
  currentUserRequest: string;
  workerResult: ManagerWorkerResultPayload;
  resolvedDir: string;
  workingDirectory: string | null;
  worktreePath: string | null;
  writeScopes: string[];
  requestedRunMode?: ManagerRunMode | null;
  managedVerifyCommand?: string | null;
  structuralWarnings?: string[];
}): string {
  const workspace =
    input.workingDirectory ?? input.worktreePath ?? input.resolvedDir;
  const changedFiles =
    input.workerResult.changedFiles.length > 0
      ? input.workerResult.changedFiles.map((path) => `- ${path}`).join('\n')
      : '- Worker did not report changed files.';
  const verificationSummary =
    input.workerResult.verificationSummary ??
    'Worker did not report a verification summary.';
  const declaredWriteScopes =
    input.writeScopes.length > 0 ? input.writeScopes.join(', ') : '(read-only)';
  const verificationGuidance = buildVerificationGuidance({
    paths: [...input.writeScopes, ...input.workerResult.changedFiles],
    managedVerifyCommand: input.managedVerifyCommand,
  });
  const currentUserRequest = buildManagerMessagePromptContent(
    input.currentUserRequest
  ).text;
  const latestAiMessage = findLatestAiMessage(input.thread);
  const latestAiReply = latestAiMessage
    ? formatThreadMessageForPrompt(latestAiMessage, { includeTimestamp: true })
    : 'No previous AI reply exists in this work item before the latest user request.';

  const deliveryInstruction =
    input.worktreePath && input.requestedRunMode !== 'read-only'
      ? 'This review is running inside an isolated managed task worktree for an existing repository. Commit your verified changes in this temporary branch when needed, but do NOT push, release, or publish from this worktree. The Manager backend will rebase this task worktree onto the latest target branch, run the final deliver verification, push it, sync the seed checkout, and then run any required release/publish follow-through. Do not return status "review" unless the branch is left fully committed and ready for that backend delivery chain.'
      : 'If this review is for a direct-delivery target without an isolated worktree and the work is acceptable, you own the in-scope delivery chain yourself: commit, push, and continue through release or publish when it is required for completion.';

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
    'Most recent AI reply before the latest user request:',
    latestAiReply,
    'Recent same-topic history (timestamps included):',
    formatThreadHistoryForPrompt(input.thread, {
      maxMessages: 8,
      includeTimestamps: true,
    }),
    'Latest user request that the final reply must answer:',
    currentUserRequest,
    'Worker completion report:',
    `status: ${input.workerResult.status}`,
    `reply:\n${input.workerResult.reply}`,
    `changedFiles:\n${changedFiles}`,
    `verificationSummary:\n${verificationSummary}`,
    input.workingDirectory ? `workingDirectory: ${input.workingDirectory}` : '',
    `declaredWriteScopes: ${declaredWriteScopes}`,
    ...(verificationGuidance.length > 0
      ? ['Verification guidance:', ...verificationGuidance]
      : []),
    ...(structuralSection ? [structuralSection] : []),
  ].join('\n\n');
}

function buildWorkingDirectoryRecoveryPrompt(input: {
  thread: Thread;
  currentUserRequest: string;
  workerRoot: string;
  targetRepoRoot: string | null;
  worktreePath: string | null;
  workingDirectory: string | null;
  writeScopes: string[];
  error: string;
}): string {
  const currentUserRequest = buildManagerMessagePromptContent(
    input.currentUserRequest
  ).text;
  const declaredWriteScopes =
    input.writeScopes.length > 0 ? input.writeScopes.join(', ') : '(read-only)';

  return [
    MANAGER_ROUTER_SYSTEM_PROMPT,
    'A worker dispatch selected a workingDirectory that the backend could not use.',
    'Return only strict JSON with keys {"assignee","status","reply","workingDirectory"}.',
    'Use assignee "worker" when you can continue by correcting workingDirectory or by omitting it to use the worker root directly.',
    'Use assignee "manager" with status "needs-reply" and reply only when you genuinely need the user to clarify the correct folder.',
    'Do not change the repo target or write scopes in this recovery step.',
    'Do not repeat the same unusable workingDirectory.',
    `Workspace: ${input.workerRoot}`,
    `Worker root: ${input.workerRoot}`,
    input.targetRepoRoot ? `Target repo root: ${input.targetRepoRoot}` : '',
    input.worktreePath ? `Isolated worktree root: ${input.worktreePath}` : '',
    input.workingDirectory
      ? `Attempted workingDirectory: ${input.workingDirectory}`
      : 'Attempted workingDirectory: (worker root)',
    `declaredWriteScopes: ${declaredWriteScopes}`,
    'Error:',
    input.error,
    `[Work item: ${input.thread.title}]`,
    'Recent same-topic history (timestamps included):',
    formatThreadHistoryForPrompt(input.thread, {
      maxMessages: 8,
      includeTimestamps: true,
    }),
    'Latest user request:',
    currentUserRequest,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Recovery routing — Manager decides how to handle review failures
// ---------------------------------------------------------------------------

const MANAGER_RECOVERY_SYSTEM_PROMPT =
  'You are the Manager recovery router for Workspace Agent Hub. ' +
  'A review or delivery step for this work item failed to reach a clean final state. ' +
  'Analyse the failure context, the original request, and the current repository state to decide the best recovery action. ' +
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
  'The previous attempt hit a recoverable issue in review or deliver. ' +
  'Fix the specified issues in this workspace. Run verification after your fix. ' +
  `${MANAGER_TOPIC_SCOPE_GUARD} ` +
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
  workingDirectory: string | null;
  worktreePath: string | null;
}): string {
  const workspace =
    input.workingDirectory ?? input.worktreePath ?? input.resolvedDir;
  return [
    MANAGER_RECOVERY_SYSTEM_PROMPT,
    `Workspace: ${workspace}`,
    `[Work item: ${input.thread.title}]`,
    'Recent same-topic history (timestamps included):',
    formatThreadHistoryForPrompt(input.thread, {
      maxMessages: 8,
      includeTimestamps: true,
    }),
    'Error / review output:',
    input.errorContext,
  ].join('\n\n');
}

function buildManagerRecoveryFixPrompt(input: {
  instructions: string;
  thread: Thread;
  currentUserRequest: string;
  resolvedDir: string;
  workingDirectory: string | null;
  worktreePath: string | null;
  writeScopes: string[];
  managedVerifyCommand?: string | null;
}): string {
  const workspace =
    input.workingDirectory ?? input.worktreePath ?? input.resolvedDir;
  const worktreeNotice = input.worktreePath
    ? 'This recovery fix is running inside an isolated managed task worktree. Make your changes and run verification, but do NOT push from this worktree. Commit only when the branch is genuinely ready for Manager delivery.'
    : '';
  const declaredWriteScopes =
    input.writeScopes.length > 0 ? input.writeScopes.join(', ') : '(read-only)';
  const verificationGuidance = buildVerificationGuidance({
    paths: input.writeScopes,
    managedVerifyCommand: input.managedVerifyCommand,
  });
  const currentUserRequest = buildManagerMessagePromptContent(
    input.currentUserRequest
  ).text;
  return [
    MANAGER_RECOVERY_FIX_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${workspace}`,
    ...(worktreeNotice ? [worktreeNotice] : []),
    `[Work item: ${input.thread.title}]`,
    `declaredWriteScopes: ${declaredWriteScopes}`,
    ...(verificationGuidance.length > 0
      ? ['Verification guidance:', ...verificationGuidance]
      : []),
    'Recent same-topic history (timestamps included):',
    formatThreadHistoryForPrompt(input.thread, {
      maxMessages: 8,
      includeTimestamps: true,
    }),
    'Latest user request:',
    currentUserRequest,
    'Fix instructions:',
    input.instructions,
  ].join('\n\n');
}

function buildWorkerRetryPrompt(input: {
  instructions: string;
  thread: Thread;
  resolvedDir: string;
  workingDirectory: string | null;
  worktreePath: string | null;
  writeScopes: string[];
  managedVerifyCommand?: string | null;
}): string {
  const workspace =
    input.workingDirectory ?? input.worktreePath ?? input.resolvedDir;
  const worktreeNotice = input.worktreePath
    ? 'This is an isolated managed task worktree. Make your changes and run verification, but do NOT push from this worktree. Commit only when the branch is genuinely ready for Manager delivery. The Manager will handle the final deliver and push.'
    : '';
  const declaredWriteScopes =
    input.writeScopes.length > 0 ? input.writeScopes.join(', ') : '(read-only)';
  const verificationGuidance = buildVerificationGuidance({
    paths: input.writeScopes,
    managedVerifyCommand: input.managedVerifyCommand,
  });
  return [
    MANAGER_WORKER_SYSTEM_PROMPT,
    MANAGER_WORKER_JSON_RULES,
    `Workspace: ${workspace}`,
    ...(worktreeNotice ? [worktreeNotice] : []),
    `[Topic: ${input.thread.title}]`,
    `declaredWriteScopes: ${declaredWriteScopes}`,
    ...(verificationGuidance.length > 0
      ? ['Verification guidance:', ...verificationGuidance]
      : []),
    'Topic history:',
    formatThreadHistory(input.thread),
    'The previous attempt hit a recoverable issue. Please address the following:',
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
  repoTargetKind?: ManagerTargetKind | null;
  managedRepoLabel?: string | null;
  managedRepoRoot?: string | null;
  newRepoName?: string | null;
  newRepoRoot?: string | null;
  managedBaseBranch?: string | null;
  managedVerifyCommand?: string | null;
  requestedRunMode?: ManagerRunMode | null;
  inferredRepoLabel?: string | null;
  inferredRepoRoot?: string | null;
  inferredRepoScope?: string | null;
  managedRepos?: Array<{
    id: string;
    label: string;
    repoRoot: string;
    defaultBranch: string;
    verifyCommand: string;
    supportedWorkerRuntimes: ManagerWorkerRuntime[];
    preferredWorkerRuntime: ManagerWorkerRuntime | null;
  }>;
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
  const workspaceRepoSummary =
    input.managedRepos && input.managedRepos.length > 0
      ? input.managedRepos
          .map((repo) =>
            [
              `- repoRef: ${repo.id}`,
              `  label: ${repo.label}`,
              `  repoRoot: ${repo.repoRoot}`,
              `  defaultBranch: ${repo.defaultBranch}`,
              `  verifyCommand: ${repo.verifyCommand}`,
              `  supportedRuntimes: ${repo.supportedWorkerRuntimes.join(', ') || '(none)'}`,
              repo.preferredWorkerRuntime
                ? `  runtimeConstraint: ${repo.preferredWorkerRuntime}`
                : '  runtimeConstraint: none (live selection may choose any supported runtime)',
            ].join('\n')
          )
          .join('\n')
      : 'No existing workspace repos were discovered.';

  return [
    MANAGER_ROUTER_SYSTEM_PROMPT,
    'Return only strict JSON with keys {"assignee","status","reply","targetKind","repoId","newRepoName","workingDirectory","writeScopes","supersedesThreadIds","reason"}.',
    'Use assignee "manager" only when you can fully answer now without repository mutation, command execution, long investigation, or a separate worker agent.',
    'Use assignee "manager" for lightweight questions or clarifications you can answer immediately from the current work-item context and your own reasoning.',
    'Use assignee "worker" for anything that needs repository inspection, command execution, code changes, tests, substantial investigation, or a heavier question that should be delegated.',
    'When assignee is "manager", include status and reply.',
    'When assignee is "worker", workingDirectory is optional. Use it only when the worker should start in a more specific directory inside the selected repo or worktree. Omit it to use the repo root / worktree root.',
    'When assignee is "worker", include writeScopes as a short array of repo-relative write areas. Use an empty array only for truly read-only work.',
    'If the task modifies an existing repository, set targetKind to "existing-repo" and include repoId using one repoRef from the discovered workspace repo list below.',
    'If the user wants a brand-new repository, set targetKind to "new-repo" and include newRepoName. The repo will be created directly under the workspace root.',
    'For existing-repo mutation tasks, the worker target MUST resolve to one concrete repo. Never use "*" or the workspace root as a fallback.',
    'If it is unclear whether the user means an existing repo or a new repo, or which existing repo they mean, do not dispatch a worker. Reply as manager with status "needs-reply" and ask only for the missing clarification.',
    'Only include supersedesThreadIds when the new work item is a descendant whose result would completely invalidate an already-running descendant task listed below.',
    `Workspace: ${input.resolvedDir}`,
    input.repoTargetKind ? `Current target kind: ${input.repoTargetKind}` : '',
    input.managedRepoLabel ? `Current repo: ${input.managedRepoLabel}` : '',
    input.managedRepoRoot ? `Current repo root: ${input.managedRepoRoot}` : '',
    input.newRepoName ? `Current new repo name: ${input.newRepoName}` : '',
    input.newRepoRoot ? `Current new repo root: ${input.newRepoRoot}` : '',
    input.inferredRepoLabel
      ? `Likely repo from context: ${input.inferredRepoLabel}`
      : '',
    input.inferredRepoRoot
      ? `Likely repo root from context: ${input.inferredRepoRoot}`
      : '',
    input.inferredRepoScope
      ? `Likely repo-relative scope from context: ${input.inferredRepoScope}`
      : '',
    input.managedBaseBranch
      ? `Current repo branch hint: ${input.managedBaseBranch}`
      : '',
    input.managedVerifyCommand
      ? `Current repo verification hint: ${input.managedVerifyCommand}`
      : '',
    input.requestedRunMode
      ? `Requested run mode: ${input.requestedRunMode}`
      : '',
    `[Work item: ${input.thread.title}]`,
    'Recent work-item history:',
    formatThreadHistory(input.thread),
    'New queued user request:',
    promptContent,
    'Discovered workspace repos:',
    workspaceRepoSummary,
    'Running related worker agents:',
    activeAssignments,
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface InferredRepoContext {
  label: string;
  repoRoot: string;
  scope: string;
}

function repoWriteScopeForWorkspace(
  workspaceRoot: string,
  repoRoot: string
): string {
  const scope = relative(
    resolvePath(workspaceRoot),
    resolvePath(repoRoot)
  ).replace(/\\/g, '/');
  return !scope || scope.startsWith('..') ? resolvePath(repoRoot) : scope;
}

function isPrimaryGitCheckoutRoot(repoRoot: string): boolean {
  try {
    return statSync(join(resolvePath(repoRoot), '.git')).isDirectory();
  } catch {
    return false;
  }
}

function buildRepoTargetClarificationReply(
  reason: string
): ManagerDispatchPayload {
  const reply =
    reason === 'new-repo-name-required'
      ? '新しい repo を作る前提なら、repo 名が分かるように依頼内容をもう少し具体的にしてください。'
      : '既存 repo に振るべきか新規 repo を切るべきか判断できるよう、対象や成果物をもう少し具体的に書いてください。';
  return {
    assignee: 'manager',
    status: 'needs-reply',
    reply,
    reason,
    writeScopes: [],
  };
}

function inferRequestedRunModeFromContent(
  content: string
): ManagerRunMode | null {
  const text = buildManagerMessagePromptContent(content).text.trim();
  if (!text) {
    return null;
  }

  const explicitReadOnlyPatterns = [
    /ファイル変更.*しない/u,
    /変更.*しない/u,
    /編集.*しない/u,
    /コード.*触らない/u,
    /コミット.*しない/u,
    /push.*しない/i,
    /新しい作業.*しない/u,
    /読むだけ/u,
    /見るだけ/u,
    /read[- ]?only/i,
  ];
  if (explicitReadOnlyPatterns.some((pattern) => pattern.test(text))) {
    return 'read-only';
  }

  const writeIntentPatterns = [
    /修正/u,
    /直して/u,
    /実装/u,
    /追加/u,
    /削除/u,
    /変更/u,
    /更新/u,
    /作成/u,
    /作って/u,
    /進めて/u,
    /対応/u,
    /移行/u,
    /導入/u,
    /消して/u,
  ];
  if (writeIntentPatterns.some((pattern) => pattern.test(text))) {
    return 'write';
  }

  const readOnlyIntentPatterns = [
    /どうなって/u,
    /確認/u,
    /見て/u,
    /調べ/u,
    /原因/u,
    /なぜ/u,
    /教えて/u,
    /説明/u,
    /レビュー/u,
    /答えて/u,
    /最上位見出し/u,
    /何が/u,
    /どこ/u,
  ];
  if (
    readOnlyIntentPatterns.some((pattern) => pattern.test(text)) ||
    /[?？]$/.test(text)
  ) {
    return 'read-only';
  }

  return null;
}

function listWorkspaceRepoCandidates(
  resolvedDir: string
): InferredRepoContext[] {
  const workspaceRoot = resolvePath(resolvedDir);
  const candidates = new Map<string, InferredRepoContext>();
  try {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidateRoot = findGitRoot(join(workspaceRoot, entry.name));
      if (!candidateRoot || !isPrimaryGitCheckoutRoot(candidateRoot)) {
        continue;
      }
      const normalizedRoot = resolvePath(candidateRoot);
      const normalizedKey = normalizedRoot.toLowerCase();
      const scope = relative(workspaceRoot, normalizedRoot).replace(/\\/g, '/');
      if (!scope || scope.startsWith('..') || candidates.has(normalizedKey)) {
        continue;
      }
      candidates.set(normalizedKey, {
        label: basename(normalizedRoot),
        repoRoot: normalizedRoot,
        scope,
      });
    }
  } catch {
    return [];
  }
  return [...candidates.values()];
}

function inferRepoContextFromThread(input: {
  resolvedDir: string;
  thread: Thread;
  content: string;
}): InferredRepoContext | null {
  const contextText = [
    input.thread.title,
    input.content,
    ...input.thread.messages
      .slice(-6)
      .map((message) =>
        typeof message.content === 'string' ? message.content : ''
      ),
  ]
    .join('\n')
    .toLowerCase();
  const tokenMatches = new Map<string, InferredRepoContext>();
  const repoNameTokens = contextText.match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  for (const token of repoNameTokens) {
    const repoRoot = resolvePath(input.resolvedDir, token);
    if (!isPrimaryGitCheckoutRoot(repoRoot)) {
      continue;
    }
    tokenMatches.set(repoRoot.toLowerCase(), {
      label: basename(repoRoot),
      repoRoot,
      scope: relative(resolvePath(input.resolvedDir), repoRoot).replace(
        /\\/g,
        '/'
      ),
    });
  }
  if (tokenMatches.size === 1) {
    return [...tokenMatches.values()][0] ?? null;
  }

  const candidates = listWorkspaceRepoCandidates(input.resolvedDir);
  if (candidates.length === 0) {
    return null;
  }
  const matches = candidates.filter((candidate) =>
    contextText.includes(candidate.label.toLowerCase())
  );
  return matches.length === 1 ? matches[0]! : null;
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
      targetKind: normalizeTargetKind(parsed.targetKind),
      repoId: normalizeOptionalText(parsed.repoId),
      newRepoName: normalizeOptionalText(parsed.newRepoName),
      workingDirectory: normalizeOptionalText(parsed.workingDirectory),
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

function isImmediateManagerDispatchReply(
  dispatch: ManagerDispatchPayload
): dispatch is ManagerDispatchPayload & {
  assignee: 'manager';
  status: 'review' | 'needs-reply';
  reply: string;
} {
  return (
    dispatch.assignee === 'manager' &&
    typeof dispatch.reply === 'string' &&
    !!dispatch.reply.trim() &&
    (dispatch.status === 'review' || dispatch.status === 'needs-reply')
  );
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
        lower.includes('no rollout found') ||
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

function extractStructuredRuntimeErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      error?: { message?: unknown } | null;
    };
    const nested =
      typeof parsed.error?.message === 'string'
        ? parsed.error.message
        : typeof parsed.message === 'string'
          ? parsed.message
          : null;
    if (!nested?.trim()) {
      return null;
    }
    return extractStructuredRuntimeErrorMessage(nested) ?? nested.trim();
  } catch {
    return trimmed;
  }
}

function extractRuntimeFailureDetail(
  output: string,
  maxLength = 300
): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const structured = extractStructuredRuntimeErrorMessage(line);
    if (structured) {
      return structured.slice(0, maxLength);
    }
  }
  return null;
}

function formatRuntimeFailureSuffix(input: {
  stdout: string;
  stderr: string;
  maxLength?: number;
}): string {
  const detail =
    extractRuntimeFailureDetail(input.stderr, input.maxLength) ??
    extractRuntimeFailureDetail(input.stdout, input.maxLength);
  return detail ? `\n${detail}` : '';
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

async function runCliTurn(input: {
  spawnSpec: {
    command: string;
    args: string[];
    spawnOptions: {
      cwd: string;
      env?: NodeJS.ProcessEnv;
      shell: boolean;
      windowsVerbatimArguments: boolean;
      stdio: ['pipe', 'pipe', 'pipe'];
      windowsHide: boolean;
    };
  };
  prompt: string | null;
  sessionId: string | null;
  runtimeLabel: string;
  threadStartedText?: string;
  onSpawn?: (pid: number | null) => void | Promise<void>;
  onProgress?: (state: CodexProgressState) => void | Promise<void>;
  parseOutput: (stdout: string) => { text: string; sessionId: string | null };
  parseProgressLine: (
    line: string,
    threadStartedText: string
  ) => CodexProgressState;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  parsed: { text: string; sessionId: string | null };
}> {
  const proc = spawn(
    input.spawnSpec.command,
    input.spawnSpec.args,
    input.spawnSpec.spawnOptions
  );
  activeChildProcesses.add(proc);
  proc.on('close', () => {
    activeChildProcesses.delete(proc);
  });

  let stdout = '';
  let stderr = '';
  let pendingStdout = '';
  let pendingStderr = '';
  let latestProgressSessionId: string | null = input.sessionId;
  let sawStructuredReply = false;
  let progressChain = Promise.resolve();
  let quietNoticeTimeout: ReturnType<typeof setTimeout> | null = null;
  let turnTimeout: ReturnType<typeof setTimeout> | null = null;
  let structuredReplyTimeout: ReturnType<typeof setTimeout> | null = null;
  let forcedExitResult: { code: number | null; stderrSuffix: string } | null =
    null;
  const idleTimeoutMs = codexIdleTimeoutMs();
  const turnTimeoutMs = codexTurnTimeoutMs();
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
    if (quietNoticeTimeout !== null) {
      clearTimeout(quietNoticeTimeout);
      quietNoticeTimeout = null;
    }
    if (turnTimeout !== null) {
      clearTimeout(turnTimeout);
      turnTimeout = null;
    }
    if (structuredReplyTimeout !== null) {
      clearTimeout(structuredReplyTimeout);
      structuredReplyTimeout = null;
    }
  };

  const forceCompletion = async (
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

  const armQuietNoticeTimer = (): void => {
    if (quietNoticeTimeout !== null) {
      clearTimeout(quietNoticeTimeout);
      quietNoticeTimeout = null;
    }
    quietNoticeTimeout = setTimeout(() => {
      const quietNotice = `[Manager notice] ${input.runtimeLabel} has produced no output for ${Math.round(
        idleTimeoutMs / 1000
      )} seconds, but the process is still running. Continuing to wait.`;
      enqueueProgress({
        sessionId: latestProgressSessionId,
        latestText: quietNotice,
        liveEntries: [
          {
            at: new Date().toISOString(),
            text: quietNotice,
            kind: 'status',
          },
        ],
        structuredReply: null,
      });
      armQuietNoticeTimer();
    }, idleTimeoutMs);
  };

  const armTurnTimers = (): void => {
    armQuietNoticeTimer();
    if (structuredReplyTimeout !== null) {
      clearTimeout(structuredReplyTimeout);
      structuredReplyTimeout = null;
    }

    if (sawStructuredReply) {
      structuredReplyTimeout = setTimeout(() => {
        void forceCompletion(
          0,
          `[Manager notice] ${input.runtimeLabel} emitted a structured final reply but did not exit within ${Math.round(
            structuredReplyCloseGraceMs / 1000
          )} seconds. The process was terminated and the latest structured reply was adopted.`
        );
      }, structuredReplyCloseGraceMs);
    }
  };

  const armHardTurnTimeout = (): void => {
    if (turnTimeout !== null) {
      clearTimeout(turnTimeout);
    }
    turnTimeout = setTimeout(() => {
      void forceCompletion(
        124,
        `[Manager error] ${input.runtimeLabel} exceeded the total runtime limit of ${Math.round(
          turnTimeoutMs / 1000
        )} seconds and was terminated.`
      );
    }, turnTimeoutMs);
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
    const progress = input.parseProgressLine(
      line,
      input.threadStartedText ?? WORKER_LIVE_STARTED_TEXT
    );
    if (progress.sessionId) {
      latestProgressSessionId = progress.sessionId;
    }
    if (progress.structuredReply) {
      sawStructuredReply = true;
    }
    if (progress.latestText) {
      enqueueProgress({
        sessionId: latestProgressSessionId,
        latestText: progress.latestText,
        liveEntries: progress.liveEntries,
        structuredReply: progress.structuredReply,
      });
    }
    armTurnTimers();
  };

  const handleStderrLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
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
    armTurnTimers();
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
    armTurnTimers();
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

    armTurnTimers();
  });
  proc.stdin?.on('error', () => {
    /* ignore prompt pipe teardown races */
  });
  if (input.prompt !== null) {
    proc.stdin?.write(input.prompt);
  }
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
  armHardTurnTimeout();
  armTurnTimers();

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
    parsed: input.parseOutput(stdout),
  };
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
  const spawnSpec = buildCodexSpawnSpec(codexCommand, args, input.resolvedDir, {
    env: process.env,
  });
  logCliLaunch({ label: 'manager Codex', spawnSpec });
  return runCliTurn({
    spawnSpec,
    prompt: input.prompt,
    sessionId: input.sessionId,
    runtimeLabel: 'Codex',
    threadStartedText: input.threadStartedText,
    onSpawn: input.onSpawn,
    onProgress: input.onProgress,
    parseOutput: parseCodexOutput,
    parseProgressLine: parseCodexProgressLine,
  });
}

class ManagerCodexUsageLimitError extends Error {
  readonly combinedOutput: string;
  readonly autoResumeAt: string | null;

  constructor(
    message: string,
    combinedOutput: string,
    autoResumeAt: string | null
  ) {
    super(message);
    this.name = 'ManagerCodexUsageLimitError';
    this.combinedOutput = combinedOutput;
    this.autoResumeAt = autoResumeAt;
  }
}

function isCodexUsageLimitError(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) {
    return false;
  }
  return /usage limit|purchase more credits|upgrade to (?:plus|pro)|try again at/i.test(
    normalized
  );
}

function buildManagerCodexUsageLimitMessage(output: string): string {
  const detail =
    extractRuntimeFailureDetail(output, 280) ??
    'Manager Codex hit its usage limit.';
  return `[Manager paused] Manager Codex が usage limit に達したため停止しました。${detail}\n利用枠が戻る見込み時刻以降に自動再開します。すぐ試す場合は「再開」を押すか、メッセージ送信で再開してください。`;
}

function managerQuotaAutoResumeRetryMs(): number {
  return parseEnvDurationMs(
    'WORKSPACE_AGENT_HUB_MANAGER_QUOTA_AUTO_RESUME_RETRY_MS',
    10 * 60_000
  );
}

function parseCodexUsageLimitAutoResumeAt(
  output: string,
  now = new Date()
): string {
  const relativeMatch = output.match(
    /try again in\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i
  );
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1] ?? '', 10);
    const unit = (relativeMatch[2] ?? '').toLowerCase();
    if (Number.isFinite(amount) && amount > 0) {
      const multiplier = unit.startsWith('second')
        ? 1_000
        : unit.startsWith('minute')
          ? 60_000
          : 60 * 60_000;
      return new Date(now.getTime() + amount * multiplier).toISOString();
    }
  }

  const timeMatch = output.match(
    /try again at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i
  );
  if (timeMatch) {
    const rawHour = Number.parseInt(timeMatch[1] ?? '', 10);
    const minute = Number.parseInt(timeMatch[2] ?? '0', 10);
    const meridiem = (timeMatch[3] ?? '').toLowerCase().replace(/\./g, '');
    if (
      Number.isFinite(rawHour) &&
      Number.isFinite(minute) &&
      minute >= 0 &&
      minute < 60
    ) {
      let hour = rawHour;
      if (meridiem === 'pm' && hour < 12) {
        hour += 12;
      } else if (meridiem === 'am' && hour === 12) {
        hour = 0;
      }
      if (hour >= 0 && hour < 24) {
        const candidate = new Date(now);
        candidate.setHours(hour, minute, 0, 0);
        if (candidate.getTime() <= now.getTime() + 1_000) {
          candidate.setDate(candidate.getDate() + 1);
        }
        return candidate.toISOString();
      }
    }
  }

  return new Date(
    now.getTime() + managerQuotaAutoResumeRetryMs()
  ).toISOString();
}

async function runManagerRuntimeTurn(input: {
  dir: string;
  resolvedDir: string;
  prompt: string;
  sessionId: string | null;
  runMode: ManagerRunMode | null;
  threadStartedText?: string;
  imagePaths?: string[];
  onSpawn?: (pid: number | null) => void | Promise<void>;
  onProgress?: (state: CodexProgressState) => void | Promise<void>;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  parsed: { text: string; sessionId: string | null };
  runtime: ManagerRuntime;
}> {
  const managerRuntime = resolveManagerRuntime();
  if (managerRuntime === 'codex') {
    const codexResult = await runCodexTurn(input);
    const combinedOutput = `${codexResult.stdout}\n${codexResult.stderr}`;
    if (codexResult.code !== 0 && isCodexUsageLimitError(combinedOutput)) {
      throw new ManagerCodexUsageLimitError(
        buildManagerCodexUsageLimitMessage(combinedOutput),
        combinedOutput,
        parseCodexUsageLimitAutoResumeAt(combinedOutput)
      );
    }
    return {
      ...codexResult,
      runtime: 'codex',
    };
  }

  const opencodeResult = await runWorkerRuntimeTurn({
    ...input,
    runtime: 'opencode',
    model:
      process.env.WORKSPACE_AGENT_HUB_OPENCODE_MANAGER_MODEL?.trim() || null,
    effort:
      process.env.WORKSPACE_AGENT_HUB_OPENCODE_MANAGER_VARIANT?.trim() ||
      process.env.WORKSPACE_AGENT_HUB_OPENCODE_MANAGER_EFFORT?.trim() ||
      null,
  });
  return {
    ...opencodeResult,
    runtime: 'opencode',
  };
}

async function runWorkerRuntimeTurn(input: {
  runtime: ManagerWorkerRuntime;
  model: string | null;
  effort: string | null;
  dir: string;
  resolvedDir: string;
  prompt: string;
  sessionId: string | null;
  runMode: ManagerRunMode | null;
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
  const launchSpec = buildWorkerRuntimeLaunchSpec({
    runtime: input.runtime,
    model: input.model,
    effort: input.effort,
    prompt: input.prompt,
    sessionId: input.sessionId,
    resolvedDir: input.resolvedDir,
    runMode: input.runMode,
    imagePaths: input.imagePaths ?? [],
  });
  const parseProgressLine = (line: string, threadStartedText: string) => {
    if (launchSpec.runtime === 'codex') {
      return parseCodexProgressLine(line, threadStartedText);
    }
    const generic = parseGenericRuntimeProgressLine(line, threadStartedText);
    return {
      sessionId: generic.sessionId,
      latestText: generic.latestText,
      liveEntries: generic.liveEntries,
      structuredReply: generic.latestText
        ? parseManagerReplyPayload(generic.latestText)
        : null,
    };
  };
  logCliLaunch({
    label: launchSpec.displayLabel,
    spawnSpec: {
      command: launchSpec.command,
      args: launchSpec.args,
      spawnOptions: launchSpec.spawnOptions,
    },
  });

  return runCliTurn({
    spawnSpec: {
      command: launchSpec.command,
      args: launchSpec.args,
      spawnOptions: launchSpec.spawnOptions,
    },
    prompt: launchSpec.prompt,
    sessionId: launchSpec.sessionId,
    runtimeLabel: launchSpec.displayLabel,
    threadStartedText: input.threadStartedText,
    onSpawn: input.onSpawn,
    onProgress: input.onProgress,
    parseOutput:
      launchSpec.runtime === 'codex'
        ? parseCodexOutput
        : parseGenericRuntimeOutput,
    parseProgressLine,
  });
}

// Per-workspace in-flight guard (module-level singleton, safe for single server process).
const inFlight = new Set<string>();
const inFlightStartedAt = new Map<string, number>();
const rerunRequested = new Set<string>();
const rerunDepth = new Map<string, number>();
const recoveryRetryTimers = new Map<string, NodeJS.Timeout>();
const recoveryRetryAttempts = new Map<string, number>();
const quotaAutoResumeTimers = new Map<string, NodeJS.Timeout>();
const staleSeedRecoveryMonitors = new Map<string, NodeJS.Timeout>();
const MAX_RERUN_DEPTH = 5;
const MAX_INTERNAL_ERROR_RETRY_MS = 30_000;
const MAX_QUOTA_AUTO_RESUME_DELAY_MS = 2_147_483_647;
const STALE_QUEUE_RUNNER_MS = 2 * 60 * 1000;
const routingLocks = new Map<string, Promise<void>>();
const MAX_ROUTING_TOPIC_CANDIDATES = 40;

function managerInternalErrorRetryMs(): number {
  return parseEnvDurationMs(
    'WORKSPACE_AGENT_HUB_MANAGER_INTERNAL_ERROR_RETRY_MS',
    2_000
  );
}

function managerStaleSeedRecoveryIntervalMs(): number {
  return parseEnvDurationMs(
    'WORKSPACE_AGENT_HUB_MANAGER_STALE_SEED_RECOVERY_INTERVAL_MS',
    30_000
  );
}

function cancelRecoveryRetryTimer(resolvedDir: string): void {
  const timer = recoveryRetryTimers.get(resolvedDir);
  if (timer) {
    clearTimeout(timer);
    recoveryRetryTimers.delete(resolvedDir);
  }
}

function resetRecoveryRetryState(resolvedDir: string): void {
  cancelRecoveryRetryTimer(resolvedDir);
  recoveryRetryAttempts.delete(resolvedDir);
}

function cancelManagerQuotaAutoResumeTimer(resolvedDir: string): void {
  const timer = quotaAutoResumeTimers.get(resolvedDir);
  if (timer) {
    clearTimeout(timer);
    quotaAutoResumeTimers.delete(resolvedDir);
  }
}

async function runManagerQuotaAutoResume(
  dir: string,
  resolvedDir: string,
  expectedAutoResumeAt: string
): Promise<void> {
  try {
    const [session, queue] = await Promise.all([
      readSession(dir),
      readQueue(dir),
    ]);
    if (
      !session.lastPauseMessage ||
      session.lastPauseAutoResumeAt !== expectedAutoResumeAt ||
      !queue.some((entry) => !entry.processed)
    ) {
      cancelManagerQuotaAutoResumeTimer(resolvedDir);
      return;
    }

    const resumeAtMs = Date.parse(expectedAutoResumeAt);
    if (Number.isFinite(resumeAtMs) && resumeAtMs > Date.now()) {
      scheduleManagerQuotaAutoResume(dir, resolvedDir, expectedAutoResumeAt);
      return;
    }

    await clearManagerRuntimePause(dir);
    await reconcileActiveAssignments(dir);
    await recoverCanonicalThreadState(dir);
    startStaleSeedRecoveryMonitor(dir);
    void processNextQueued(dir, resolvedDir);
  } catch (error) {
    console.error('[manager-backend] quota auto-resume failed:', error);
    const nextAutoResumeAt = new Date(
      Date.now() + managerQuotaAutoResumeRetryMs()
    ).toISOString();
    await updateSession(dir, (session) =>
      session.lastPauseMessage
        ? {
            ...session,
            lastPauseAutoResumeAt: nextAutoResumeAt,
          }
        : session
    ).catch(() => {});
    scheduleManagerQuotaAutoResume(dir, resolvedDir, nextAutoResumeAt);
  }
}

function scheduleManagerQuotaAutoResume(
  dir: string,
  resolvedDir: string,
  autoResumeAt: string
): void {
  const resumeAtMs = Date.parse(autoResumeAt);
  if (!Number.isFinite(resumeAtMs)) {
    cancelManagerQuotaAutoResumeTimer(resolvedDir);
    return;
  }

  cancelManagerQuotaAutoResumeTimer(resolvedDir);
  const delayMs = Math.min(
    Math.max(0, resumeAtMs - Date.now()),
    MAX_QUOTA_AUTO_RESUME_DELAY_MS
  );
  const timer = setTimeout(() => {
    if (quotaAutoResumeTimers.get(resolvedDir) === timer) {
      quotaAutoResumeTimers.delete(resolvedDir);
    }
    void runManagerQuotaAutoResume(dir, resolvedDir, autoResumeAt);
  }, delayMs);
  timer.unref?.();
  quotaAutoResumeTimers.set(resolvedDir, timer);
}

function ensureManagerQuotaAutoResumeScheduled(
  dir: string,
  session: ManagerSession
): void {
  const autoResumeAt = normalizeOptionalTimestamp(
    session.lastPauseAutoResumeAt
  );
  if (!session.lastPauseMessage || !autoResumeAt) {
    return;
  }

  const resolvedDir = resolvePath(dir);
  if (Date.parse(autoResumeAt) <= Date.now()) {
    void runManagerQuotaAutoResume(dir, resolvedDir, autoResumeAt);
    return;
  }

  if (!quotaAutoResumeTimers.has(resolvedDir)) {
    scheduleManagerQuotaAutoResume(dir, resolvedDir, autoResumeAt);
  }
}

function clearProcessNextQueuedReservation(resolvedDir: string): void {
  inFlight.delete(resolvedDir);
  inFlightStartedAt.delete(resolvedDir);
  rerunRequested.delete(resolvedDir);
}

function pendingQueueEntries(
  queue: QueueEntry[],
  session: ManagerSession
): QueueEntry[] {
  const activeQueueIds = queueEntryIdSet(session.activeAssignments);
  const dispatchingQueueIds = new Set(session.dispatchingQueueEntryIds ?? []);
  return queue.filter(
    (entry) =>
      !entry.processed &&
      !activeQueueIds.has(entry.id) &&
      !dispatchingQueueIds.has(entry.id)
  );
}

async function markManagerSessionStartedForPendingQueue(
  dir: string,
  session: ManagerSession,
  queue: QueueEntry[]
): Promise<ManagerSession> {
  if (
    session.status !== 'not-started' ||
    pendingQueueEntries(queue, session).length === 0
  ) {
    return session;
  }

  return updateSession(dir, (currentSession) =>
    currentSession.status === 'not-started'
      ? {
          ...currentSession,
          status: 'idle',
          startedAt: currentSession.startedAt ?? new Date().toISOString(),
        }
      : currentSession
  );
}

async function recoverStaleProcessNextQueuedReservation(
  dir: string,
  resolvedDir: string
): Promise<boolean> {
  const startedAt = inFlightStartedAt.get(resolvedDir) ?? null;
  const session = await readSession(dir);
  if (
    session.activeAssignments.length > 0 ||
    session.pid !== null ||
    session.currentQueueId !== null
  ) {
    return false;
  }

  if (startedAt !== null && Date.now() - startedAt < STALE_QUEUE_RUNNER_MS) {
    return false;
  }

  console.warn(
    `[manager-backend] clearing stale queue-runner reservation for ${resolvedDir}; no persisted assignment or worker pid remains`
  );
  clearProcessNextQueuedReservation(resolvedDir);
  rerunDepth.delete(resolvedDir);
  resetRecoveryRetryState(resolvedDir);
  return true;
}

/**
 * Test-only helper: mark the queue runner as already in flight without having
 * to stall a real async turn.
 */
export function markProcessNextQueuedInFlightForTests(
  dir: string,
  startedAt = Date.now()
): void {
  const resolvedDir = resolvePath(dir);
  inFlight.add(resolvedDir);
  inFlightStartedAt.set(resolvedDir, startedAt);
}

/** Test-only helper: reset queue-runner in-memory state between tests. */
export function resetProcessNextQueuedStateForTests(): void {
  for (const timer of recoveryRetryTimers.values()) {
    clearTimeout(timer);
  }
  for (const timer of quotaAutoResumeTimers.values()) {
    clearTimeout(timer);
  }
  inFlight.clear();
  inFlightStartedAt.clear();
  rerunRequested.clear();
  rerunDepth.clear();
  recoveryRetryTimers.clear();
  recoveryRetryAttempts.clear();
  quotaAutoResumeTimers.clear();
}

async function runScheduledRecoveryRetry(
  dir: string,
  resolvedDir: string
): Promise<void> {
  try {
    const [session, queue] = await Promise.all([
      readSession(dir),
      readQueue(dir),
    ]);
    const hasPendingQueue = queue.some((entry) => !entry.processed);
    if (
      session.status === 'not-started' ||
      (!hasPendingQueue && session.activeAssignments.length === 0)
    ) {
      resetRecoveryRetryState(resolvedDir);
      return;
    }
    await processNextQueued(dir, resolvedDir);
  } catch (error) {
    console.error('[manager-backend] scheduled recovery retry failed:', error);
    scheduleRecoveryRetry(dir, resolvedDir);
  }
}

function scheduleRecoveryRetry(dir: string, resolvedDir: string): void {
  if (recoveryRetryTimers.has(resolvedDir)) {
    return;
  }

  const attempt = (recoveryRetryAttempts.get(resolvedDir) ?? 0) + 1;
  recoveryRetryAttempts.set(resolvedDir, attempt);
  const delayMs = Math.min(
    managerInternalErrorRetryMs() * Math.max(1, 2 ** (attempt - 1)),
    MAX_INTERNAL_ERROR_RETRY_MS
  );

  console.error(
    `[manager-backend] scheduling recovery retry ${attempt} for ${resolvedDir} in ${delayMs}ms`
  );

  const timer = setTimeout(() => {
    if (recoveryRetryTimers.get(resolvedDir) === timer) {
      recoveryRetryTimers.delete(resolvedDir);
    }
    void runScheduledRecoveryRetry(dir, resolvedDir);
  }, delayMs);
  timer.unref?.();
  recoveryRetryTimers.set(resolvedDir, timer);
}

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
    const stripped = stripManagerRuntimeStatePreservingContinuity(next);
    if (!stripped) {
      return null;
    }
    delete stripped.runtimeErrorMessage;
    return stripped;
  });
}

async function clearThreadRuntimeStatePreservingContinuity(
  dir: string,
  threadId: string
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, (current) => {
    const stripped = stripManagerRuntimeStatePreservingContinuity(current);
    if (!stripped) {
      return null;
    }
    return stripped;
  });
}

interface PausedWorktreeSnapshot {
  assignmentId: string;
  worktreePath: string;
  worktreeBranch: string;
  targetRepoRoot: string;
}

interface PausedWorktreeReuseDecision {
  hasSnapshot: boolean;
  reusable: boolean;
  reason: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  targetRepoRoot: string | null;
}

interface LatestStashEntry {
  commit: string;
  ref: string;
  summary: string;
}

export interface PreserveSeedRecoveryResult {
  preserved: boolean;
  repoRoot: string;
  repoLabel: string | null;
  changedFiles: string[];
  stashRef: string | null;
  stashSummary: string | null;
}

function clearSeedRecoveryStateFromMeta(
  meta: ManagerThreadMeta
): ManagerThreadMeta {
  const next = { ...meta };
  delete next.seedRecoveryPending;
  delete next.seedRecoveryRepoRoot;
  delete next.seedRecoveryRepoLabel;
  delete next.seedRecoveryChangedFiles;
  return next;
}

async function preservePausedWorktreeForThread(
  dir: string,
  threadId: string,
  assignment: ManagerActiveAssignment
): Promise<void> {
  if (
    !assignment.worktreePath ||
    !assignment.worktreeBranch ||
    !assignment.targetRepoRoot
  ) {
    return;
  }
  await updateManagerThreadMeta(dir, threadId, (current) => ({
    ...(current ?? {}),
    pausedAssignmentId: assignment.id,
    pausedWorktreePath: assignment.worktreePath,
    pausedWorktreeBranch: assignment.worktreeBranch,
    pausedTargetRepoRoot: assignment.targetRepoRoot,
  }));
}

async function clearPausedWorktreeForThread(
  dir: string,
  threadId: string
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, (current) => {
    if (!current) {
      return null;
    }
    const next = { ...current };
    delete next.pausedAssignmentId;
    delete next.pausedWorktreePath;
    delete next.pausedWorktreeBranch;
    delete next.pausedTargetRepoRoot;
    return next;
  });
}

async function evaluatePausedWorktreeReuse(input: {
  threadMeta: ManagerThreadMeta | null;
  targetRepoRoot: string;
}): Promise<PausedWorktreeReuseDecision> {
  const worktreePath =
    typeof input.threadMeta?.pausedWorktreePath === 'string' &&
    input.threadMeta.pausedWorktreePath.trim()
      ? input.threadMeta.pausedWorktreePath.trim()
      : null;
  const worktreeBranch =
    typeof input.threadMeta?.pausedWorktreeBranch === 'string' &&
    input.threadMeta.pausedWorktreeBranch.trim()
      ? input.threadMeta.pausedWorktreeBranch.trim()
      : null;
  const pausedTargetRepoRoot =
    typeof input.threadMeta?.pausedTargetRepoRoot === 'string' &&
    input.threadMeta.pausedTargetRepoRoot.trim()
      ? input.threadMeta.pausedTargetRepoRoot.trim()
      : null;

  if (!worktreePath && !worktreeBranch && !pausedTargetRepoRoot) {
    return {
      hasSnapshot: false,
      reusable: false,
      reason: null,
      worktreePath: null,
      worktreeBranch: null,
      targetRepoRoot: null,
    };
  }

  if (!worktreePath || !worktreeBranch || !pausedTargetRepoRoot) {
    return {
      hasSnapshot: true,
      reusable: false,
      reason:
        'saved paused worktree metadata is incomplete. assignment, path, branch, and target repo must all be present.',
      worktreePath,
      worktreeBranch,
      targetRepoRoot: pausedTargetRepoRoot,
    };
  }

  if (resolvePath(pausedTargetRepoRoot) !== resolvePath(input.targetRepoRoot)) {
    return {
      hasSnapshot: true,
      reusable: false,
      reason: `saved paused worktree targets ${pausedTargetRepoRoot}, but this retry resolved ${input.targetRepoRoot}.`,
      worktreePath,
      worktreeBranch,
      targetRepoRoot: pausedTargetRepoRoot,
    };
  }

  if (!existsSync(worktreePath)) {
    return {
      hasSnapshot: true,
      reusable: false,
      reason: `saved paused worktree path does not exist: ${worktreePath}`,
      worktreePath,
      worktreeBranch,
      targetRepoRoot: pausedTargetRepoRoot,
    };
  }

  const managerOwned = await isManagerManagedWorktreePath(worktreePath).catch(
    () => false
  );
  if (!managerOwned) {
    return {
      hasSnapshot: true,
      reusable: false,
      reason: `saved paused worktree is no longer recognized as a manager-owned mwt task worktree: ${worktreePath}`,
      worktreePath,
      worktreeBranch,
      targetRepoRoot: pausedTargetRepoRoot,
    };
  }

  return {
    hasSnapshot: true,
    reusable: true,
    reason: null,
    worktreePath,
    worktreeBranch,
    targetRepoRoot: pausedTargetRepoRoot,
  };
}

async function clearSeedRecoveryState(
  dir: string,
  threadId: string
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, (current) => {
    if (!current) {
      return null;
    }
    return clearSeedRecoveryStateFromMeta(current);
  });
}

/**
 * Re-examine every thread whose meta still carries `seedRecoveryPending`
 * and clear the flag when the target repo seed is in fact already clean.
 *
 * Background: when a user (or an out-of-band tool) removes the seed
 * worktree's tracked changes after the Manager stalled with a
 * seed_tracked_dirty error, the thread meta is NOT automatically
 * reconciled. This left stale "退避して続行" prompts visible to the user
 * and blocked Manager from starting the next assignee even though the
 * underlying obstacle was gone.
 *
 * This function checks the actual filesystem state for each pending
 * thread and, for those whose seed is now clean, clears the recovery
 * flags. When at least one thread was cleared the Manager queue runner
 * is kicked so a blocked task can resume automatically.
 */
async function reviewStaleSeedRecoveryForDir(dir: string): Promise<{
  cleared: number;
}> {
  const resolvedDir = resolvePath(dir);
  const meta = await readManagerThreadMeta(resolvedDir);
  let cleared = 0;
  for (const [threadId, threadMeta] of Object.entries(meta)) {
    if (!threadMeta?.seedRecoveryPending) continue;
    const repoRoot = threadMeta.seedRecoveryRepoRoot?.trim();
    if (!repoRoot) continue;
    let trackedChanges: string[];
    try {
      trackedChanges = await listTrackedSeedChanges(repoRoot);
    } catch (error) {
      console.warn(
        `[manager-backend] stale seed-recovery check skipped for thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (trackedChanges.length > 0) continue;
    await clearSeedRecoveryState(resolvedDir, threadId);
    cleared += 1;
    console.warn(
      `[manager-backend] auto-cleared stale seedRecoveryPending for thread ${threadId} (${repoRoot}): seed is now clean`
    );
  }
  if (cleared > 0) {
    void processNextQueued(dir, resolvedDir);
  }
  return { cleared };
}

function parseTrackedStatusPaths(stdout: string): string[] {
  return Array.from(
    new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .flatMap((line) => {
          if (!line || line.length < 4) {
            return [];
          }
          const pathText = line.slice(3).trim();
          if (!pathText) {
            return [];
          }
          const renamedPath = pathText.includes(' -> ')
            ? (pathText.split(' -> ').at(-1) ?? pathText)
            : pathText;
          return [renamedPath.trim()];
        })
        .filter(Boolean)
    )
  );
}

async function listTrackedSeedChanges(
  targetRepoRoot: string
): Promise<string[]> {
  const statusResult = await execGit(targetRepoRoot, [
    'status',
    '--porcelain',
    '--untracked-files=no',
  ]);
  if (statusResult.code !== 0) {
    throw new Error(
      statusResult.stderr ||
        statusResult.stdout ||
        'git status --porcelain --untracked-files=no failed'
    );
  }
  return parseTrackedStatusPaths(statusResult.stdout);
}

async function readLatestStashEntry(
  targetRepoRoot: string
): Promise<LatestStashEntry | null> {
  const result = await execGit(targetRepoRoot, [
    'stash',
    'list',
    '-1',
    '--format=%H%x09%gd%x09%gs',
  ]);
  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || 'git stash list -1 failed'
    );
  }
  const line = result.stdout.trim();
  if (!line) {
    return null;
  }
  const [commit = '', ref = '', summary = ''] = line.split('\t');
  if (!commit.trim() || !ref.trim()) {
    return null;
  }
  return {
    commit: commit.trim(),
    ref: ref.trim(),
    summary: summary.trim(),
  };
}

function buildSeedRecoveryStashMessage(threadId: string): string {
  return `workspace-agent-hub manager preserve ${threadId} ${new Date().toISOString()}`;
}

async function stashTrackedSeedChanges(input: {
  targetRepoRoot: string;
  threadId: string;
}): Promise<PreserveSeedRecoveryResult> {
  const repoRoot = resolvePath(input.targetRepoRoot);
  const changedFiles = await listTrackedSeedChanges(repoRoot);
  if (changedFiles.length === 0) {
    return {
      preserved: false,
      repoRoot,
      repoLabel: basename(repoRoot),
      changedFiles: [],
      stashRef: null,
      stashSummary: null,
    };
  }

  const stashMessage = buildSeedRecoveryStashMessage(input.threadId);
  const beforeStash = await readLatestStashEntry(repoRoot);
  const stashResult = await execGit(repoRoot, [
    'stash',
    'push',
    '--message',
    stashMessage,
  ]);
  if (stashResult.code !== 0) {
    throw new Error(
      stashResult.stderr || stashResult.stdout || 'git stash push failed'
    );
  }

  const remainingFiles = await listTrackedSeedChanges(repoRoot);
  if (remainingFiles.length > 0) {
    throw new Error(
      `git stash push did not clean the seed worktree. Remaining tracked files: ${remainingFiles.join(', ')}`
    );
  }

  const afterStash = await readLatestStashEntry(repoRoot);
  const createdNewStash = afterStash?.commit !== beforeStash?.commit;
  return {
    preserved: createdNewStash,
    repoRoot,
    repoLabel: basename(repoRoot),
    changedFiles,
    stashRef: createdNewStash ? (afterStash?.ref ?? null) : null,
    stashSummary: createdNewStash ? (afterStash?.summary ?? null) : null,
  };
}

function summarizeRecoveryFiles(files: string[], maxItems = 6): string | null {
  if (files.length === 0) {
    return null;
  }
  const visible = files.slice(0, maxItems).map((filePath) => `- ${filePath}`);
  const remaining = files.length - visible.length;
  if (remaining > 0) {
    visible.push(`- 他 ${remaining} 件`);
  }
  return visible.join('\n');
}

function buildSeedRecoveryPendingMessage(input: {
  repoLabel: string | null;
  changedFiles: string[];
  errorDetail: string;
}): string {
  const changedFilesSummary = summarizeRecoveryFiles(input.changedFiles);
  return [
    `[Manager] Worker 隔離環境の作成に失敗しました: ${input.errorDetail}`,
    '対象 repo の seed worktree に tracked changes があるため、この依頼を安全に開始できませんでした。',
    'Manager UI の「退避して続行」で tracked changes を stash に一時退避すると、この依頼をそのまま再開できます。',
    input.repoLabel ? `対象 repo: ${input.repoLabel}` : '',
    changedFilesSummary ? `tracked files:\n${changedFilesSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildSeedRecoveryResumeMessage(
  input: PreserveSeedRecoveryResult
): string {
  const changedFilesSummary = summarizeRecoveryFiles(input.changedFiles);
  if (!input.preserved) {
    return [
      '[Manager] seed worktree はすでに clean でした。この依頼を再開します。',
      input.repoLabel ? `対象 repo: ${input.repoLabel}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    '[Manager] seed の tracked changes を一時退避し、この依頼を再開します。',
    input.repoLabel ? `対象 repo: ${input.repoLabel}` : '',
    input.stashRef ? `stash: ${input.stashRef}` : '',
    changedFilesSummary
      ? `退避した tracked files:\n${changedFilesSummary}`
      : '',
    '帰宅後は stash 内容を確認し、必要なら別 branch / worktree に戻してください。',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildAutoMwtInitBlockedMessage(input: {
  detail: string;
  defaultBranch: string | null;
  remoteName: string | null;
  changedFiles: string[];
}): string {
  const changedFilesSummary = summarizeRecoveryFiles(input.changedFiles);
  const suggestedCommand =
    input.defaultBranch && input.remoteName
      ? `mwt init --base ${input.defaultBranch} --remote ${input.remoteName}`
      : input.defaultBranch
        ? `mwt init --base ${input.defaultBranch} --remote origin`
        : 'mwt init --base <branch> --remote origin';
  return [
    '[Manager] この既存リポジトリは managed-worktree-system (`mwt`) 初期化前のため、Manager の isolated write task を開始できませんでした。',
    '安全に自動初期化できる条件だけ試しましたが、この repo は条件を満たしていなかったため停止しました。',
    input.detail,
    changedFilesSummary ? `tracked files:\n${changedFilesSummary}` : '',
    `seed リポジトリで \`${suggestedCommand}\` を実行してから再開してください。`,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPausedWorktreeResumeBlockedMessage(input: {
  detail: string;
}): string {
  return [
    '[Manager] 保存されていた paused managed task worktree を再利用できませんでした。',
    input.detail,
    'paused worktree の情報は保持したまま停止しました。原因を直したら同じ thread に続きの依頼を送ってください。',
  ]
    .filter(Boolean)
    .join('\n');
}

function clearPendingReplyStateFromMeta(
  meta: ManagerThreadMeta
): ManagerThreadMeta {
  const next = { ...meta };
  delete next.pendingReplyStatus;
  delete next.pendingReplyContent;
  delete next.pendingReplyAt;
  delete next.runtimeErrorMessage;
  return next;
}

async function setThreadRuntimeErrorMessage(
  dir: string,
  threadId: string,
  message: string | null
): Promise<void> {
  await updateManagerThreadMeta(dir, threadId, (current) => {
    if (!current && !message) {
      return null;
    }
    const next: ManagerThreadMeta = { ...(current ?? {}) };
    if (message?.trim()) {
      next.runtimeErrorMessage = message.trim();
    } else {
      delete next.runtimeErrorMessage;
    }
    return next;
  });
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

async function writeAiMessageIfLatestDiffers(input: {
  dir: string;
  threadId: string;
  content: string;
  status: Extract<ThreadStatus, 'active' | 'review' | 'needs-reply'>;
}): Promise<'added' | 'duplicate'> {
  const currentThread = await getThread(input.dir, input.threadId).catch(
    () => null
  );
  const lastMessage = currentThread?.messages.at(-1) ?? null;
  if (lastMessage?.sender === 'ai' && lastMessage.content === input.content) {
    return 'duplicate';
  }

  await addMessage(
    input.dir,
    input.threadId,
    input.content,
    'ai',
    input.status
  );
  return 'added';
}

async function addAiMessageBestEffort(input: {
  dir: string;
  threadId: string;
  content: string;
  status: Extract<ThreadStatus, 'active' | 'review' | 'needs-reply'>;
}): Promise<boolean> {
  try {
    await writeAiMessageIfLatestDiffers(input);
    return true;
  } catch {
    return false;
  }
}

async function addAiMessageOrPersistPending(input: {
  dir: string;
  threadId: string;
  content: string;
  status: Extract<ThreadStatus, 'active' | 'review' | 'needs-reply'>;
}): Promise<boolean> {
  try {
    await writeAiMessageIfLatestDiffers(input);
    await updateManagerThreadMeta(input.dir, input.threadId, (current) =>
      current ? clearPendingReplyStateFromMeta(current) : current
    );
    return true;
  } catch {
    await updateManagerThreadMeta(input.dir, input.threadId, (current) => ({
      ...(current ?? {}),
      pendingReplyStatus: input.status,
      pendingReplyContent: input.content,
      pendingReplyAt: new Date().toISOString(),
    }));
    return false;
  }
}

interface RecoveredRuntimeReply extends ManagerReplyPayload {
  completedAtMs: number | null;
}

function resolveCodexSessionsRoot(): string {
  const explicitSessionsRoot =
    process.env.WORKSPACE_AGENT_HUB_CODEX_SESSIONS_DIR?.trim();
  if (explicitSessionsRoot) {
    return resolvePath(explicitSessionsRoot);
  }

  const explicitCodexHome = process.env.CODEX_HOME?.trim();
  return join(
    resolvePath(explicitCodexHome || join(homedir(), '.codex')),
    'sessions'
  );
}

function codexSessionIdIsSearchable(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    !sessionId.includes('/') &&
    !sessionId.includes('\\') &&
    !sessionId.includes('..')
  );
}

async function findCodexRolloutFileForSession(
  sessionId: string
): Promise<string | null> {
  const trimmedSessionId = sessionId.trim();
  if (!codexSessionIdIsSearchable(trimmedSessionId)) {
    return null;
  }

  const sessionsRoot = resolveCodexSessionsRoot();
  const suffix = `-${trimmedSessionId}.jsonl`;
  const pendingDirs: Array<{ path: string; depth: number }> = [
    { path: sessionsRoot, depth: 0 },
  ];
  let visitedDirs = 0;
  let visitedFiles = 0;
  const maxDirs = 512;
  const maxFiles = 4096;

  while (pendingDirs.length > 0) {
    if (visitedDirs >= maxDirs || visitedFiles >= maxFiles) {
      return null;
    }

    const current = pendingDirs.shift()!;
    visitedDirs += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(current.path, {
        withFileTypes: true,
        encoding: 'utf8',
      });
    } catch {
      continue;
    }

    const sortedEntries = [...entries].sort((left, right) =>
      right.name.localeCompare(left.name)
    );
    for (const entry of sortedEntries) {
      if (!entry.isFile()) {
        continue;
      }
      visitedFiles += 1;
      if (entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
        return join(current.path, entry.name);
      }
      if (visitedFiles >= maxFiles) {
        return null;
      }
    }

    if (current.depth >= 4) {
      continue;
    }
    for (const entry of sortedEntries) {
      if (entry.isDirectory()) {
        pendingDirs.push({
          path: join(current.path, entry.name),
          depth: current.depth + 1,
        });
      }
    }
  }

  return null;
}

function parseCodexTaskCompleteReplyLine(
  line: string
): RecoveredRuntimeReply | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }

  const event = record as {
    timestamp?: unknown;
    type?: unknown;
    payload?: {
      type?: unknown;
      last_agent_message?: unknown;
      completed_at?: unknown;
    };
  };
  if (event.type !== 'event_msg' || event.payload?.type !== 'task_complete') {
    return null;
  }

  const lastAgentMessage = event.payload.last_agent_message;
  if (typeof lastAgentMessage !== 'string' || !lastAgentMessage.trim()) {
    return null;
  }

  const parsedReply = parseManagerReplyPayload(lastAgentMessage);
  if (!parsedReply) {
    return null;
  }

  let completedAtMs: number | null = null;
  if (
    typeof event.payload.completed_at === 'number' &&
    Number.isFinite(event.payload.completed_at)
  ) {
    completedAtMs = event.payload.completed_at * 1000;
  } else if (typeof event.timestamp === 'string') {
    const timestampMs = new Date(event.timestamp).getTime();
    completedAtMs = Number.isNaN(timestampMs) ? null : timestampMs;
  }

  return { ...parsedReply, completedAtMs };
}

async function readCompletedCodexReplyFromRollout(
  sessionId: string
): Promise<RecoveredRuntimeReply | null> {
  const rolloutPath = await findCodexRolloutFileForSession(sessionId);
  if (!rolloutPath) {
    return null;
  }

  let content: string;
  try {
    content = await readFile(rolloutPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    const parsed = parseCodexTaskCompleteReplyLine(line);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function recoveredReplyIsForCurrentUserTurn(input: {
  thread: Thread;
  recoveredReply: RecoveredRuntimeReply;
}): boolean {
  if (input.recoveredReply.completedAtMs === null) {
    return true;
  }
  const latestUser = lastUserMessage(input.thread);
  if (!latestUser?.at) {
    return true;
  }
  const latestUserAtMs = new Date(latestUser.at).getTime();
  if (Number.isNaN(latestUserAtMs)) {
    return true;
  }
  return latestUserAtMs <= input.recoveredReply.completedAtMs;
}

async function recoverStalledCodexReplyFromRollout(input: {
  dir: string;
  thread: Thread;
  meta: ManagerThreadMeta | null;
}): Promise<boolean> {
  const workerSessionId = input.meta?.workerSessionId?.trim();
  const workerRuntime = input.meta?.workerSessionRuntime ?? null;
  if (
    !workerSessionId ||
    (workerRuntime !== null && workerRuntime !== 'codex') ||
    input.meta?.routingConfirmationNeeded ||
    input.meta?.seedRecoveryPending ||
    input.meta?.pausedWorktreePath
  ) {
    return false;
  }

  const recoveredReply =
    await readCompletedCodexReplyFromRollout(workerSessionId);
  if (
    !recoveredReply ||
    !recoveredReplyIsForCurrentUserTurn({
      thread: input.thread,
      recoveredReply,
    })
  ) {
    return false;
  }

  await addAiMessageOrPersistPending({
    dir: input.dir,
    threadId: input.thread.id,
    content: recoveredReply.reply,
    status: recoveredReply.status,
  });
  await updateQueueLocked(input.dir, (queue) =>
    queue.filter(
      (entry) => !(entry.threadId === input.thread.id && entry.processed)
    )
  );
  await clearThreadRuntimeStatePreservingContinuity(input.dir, input.thread.id);
  return true;
}

async function enqueueThreadRecoveryReplay(input: {
  dir: string;
  thread: Thread;
}): Promise<boolean> {
  const resolvedDir = resolvePath(input.dir);
  const lastUser = lastUserMessage(input.thread);
  if (!lastUser?.content?.trim()) {
    return false;
  }

  let shouldEnqueue = false;
  await clearThreadRoutingStatePreservingContinuity(
    resolvedDir,
    input.thread.id
  );
  await updateManagerThreadMeta(resolvedDir, input.thread.id, (current) => {
    const previousAttemptCount =
      current?.strandedAutoResumeLastUserAt === lastUser.at
        ? (current?.strandedAutoResumeCount ?? 0)
        : 0;
    shouldEnqueue = previousAttemptCount === 0;
    return {
      ...(current ?? {}),
      strandedAutoResumeCount: previousAttemptCount + 1,
      strandedAutoResumeLastUserAt: lastUser.at,
      strandedAutoResumeLastAttemptAt: new Date().toISOString(),
    };
  });
  if (!shouldEnqueue) {
    return false;
  }

  await enqueueMessage(resolvedDir, input.thread.id, lastUser.content, {
    dispatchMode: 'manager-evaluate',
    requestedRunMode: inferRequestedRunModeFromContent(lastUser.content),
  });
  return true;
}

async function recoverCanonicalThreadState(dir: string): Promise<{
  replayedReply: boolean;
  requeuedThread: boolean;
}> {
  const resolvedDir = resolvePath(dir);
  // First, reconcile any stale `seedRecoveryPending` flags against the
  // current seed filesystem state. If a user has already cleared the
  // seed outside the UI, we should not keep telling them "退避して続行"
  // and should let Manager resume immediately.
  try {
    await reviewStaleSeedRecoveryForDir(resolvedDir);
  } catch (error) {
    console.warn(
      `[manager-backend] reviewStaleSeedRecoveryForDir failed during recoverCanonicalThreadState: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const [threads, session, queue, rawMeta] = await Promise.all([
    listThreads(resolvedDir),
    readSession(resolvedDir),
    readQueue(resolvedDir),
    readManagerThreadMeta(resolvedDir),
  ]);
  const meta = await reconcileManagerThreadMeta({
    dir: resolvedDir,
    threads,
    session,
    queue,
    meta: rawMeta,
  });

  let replayedReply = false;
  let requeuedThread = false;
  const activeThreadIds = new Set(
    (session.activeAssignments ?? []).map((assignment) => assignment.threadId)
  );
  const pendingQueueDepth = new Map<string, number>();
  for (const entry of queue) {
    if (entry.processed) {
      continue;
    }
    pendingQueueDepth.set(
      entry.threadId,
      (pendingQueueDepth.get(entry.threadId) ?? 0) + 1
    );
  }

  for (const thread of threads) {
    const threadMeta = meta[thread.id] ?? null;
    if (threadMeta?.canonicalState !== 'stalled') {
      continue;
    }

    if (
      typeof threadMeta.pendingReplyContent === 'string' &&
      threadMeta.pendingReplyContent.trim() &&
      (threadMeta.pendingReplyStatus === 'active' ||
        threadMeta.pendingReplyStatus === 'review' ||
        threadMeta.pendingReplyStatus === 'needs-reply')
    ) {
      const delivered = await addAiMessageOrPersistPending({
        dir: resolvedDir,
        threadId: thread.id,
        content: threadMeta.pendingReplyContent,
        status: threadMeta.pendingReplyStatus,
      });
      replayedReply = replayedReply || delivered;
      continue;
    }

    const recoveredFromRollout = await recoverStalledCodexReplyFromRollout({
      dir: resolvedDir,
      thread,
      meta: threadMeta,
    });
    if (recoveredFromRollout) {
      replayedReply = true;
      continue;
    }

    const queueDepth = pendingQueueDepth.get(thread.id) ?? 0;
    const isWorking = activeThreadIds.has(thread.id);
    const lastUser = lastUserMessage(thread);
    const autoResumeAlreadyAttempted =
      Boolean(lastUser?.at) &&
      threadMeta?.strandedAutoResumeLastUserAt === lastUser?.at &&
      (threadMeta?.strandedAutoResumeCount ?? 0) > 0;

    if (
      thread.status === 'waiting' &&
      thread.messages.at(-1)?.sender === 'user' &&
      queueDepth === 0 &&
      !isWorking &&
      !threadMeta?.routingConfirmationNeeded &&
      !threadMeta?.seedRecoveryPending &&
      !autoResumeAlreadyAttempted
    ) {
      const enqueued = await enqueueThreadRecoveryReplay({
        dir: resolvedDir,
        thread,
      });
      requeuedThread = requeuedThread || enqueued;
    }
  }

  if (replayedReply || requeuedThread) {
    await reconcileManagerThreadMeta({
      dir: resolvedDir,
      threads: await listThreads(resolvedDir),
      session: await readSession(resolvedDir),
      queue: await readQueue(resolvedDir),
      meta: await readManagerThreadMeta(resolvedDir),
    });
  }

  return { replayedReply, requeuedThread };
}

export async function preserveSeedRecoveryAndContinue(input: {
  dir: string;
  threadId: string;
}): Promise<PreserveSeedRecoveryResult> {
  const resolvedDir = resolvePath(input.dir);
  const thread = await getThread(resolvedDir, input.threadId);
  if (!thread) {
    throw new Error('Thread not found');
  }

  const meta = await readManagerThreadMeta(resolvedDir);
  const threadMeta = meta[input.threadId] ?? null;
  const repoRoot = threadMeta?.seedRecoveryRepoRoot?.trim();
  if (!threadMeta?.seedRecoveryPending || !repoRoot) {
    throw new Error(
      'No pending seed recovery action is available for this thread.'
    );
  }

  const preserveResult = await stashTrackedSeedChanges({
    targetRepoRoot: repoRoot,
    threadId: input.threadId,
  });
  const repoLabel =
    threadMeta.seedRecoveryRepoLabel?.trim() ||
    threadMeta.managedRepoLabel?.trim() ||
    basename(preserveResult.repoRoot);
  const nextResult: PreserveSeedRecoveryResult = {
    ...preserveResult,
    repoLabel,
  };

  await clearSeedRecoveryState(resolvedDir, input.threadId);
  await setWorkerRuntimeState({
    dir: resolvedDir,
    threadId: input.threadId,
    assigneeKind: 'manager',
    assigneeLabel: defaultAssigneeLabel('manager'),
    workerAgentId: null,
    runtimeState: 'manager-recovery',
    runtimeDetail:
      'Manager が seed の tracked changes を退避し、再開を準備しています。',
    workerWriteScopes: threadMeta.workerWriteScopes ?? [],
    workerBlockedByThreadIds: [],
    supersededByThreadId: null,
    clearWorkerLiveLog: true,
  });
  await addAiMessageBestEffort({
    dir: resolvedDir,
    threadId: input.threadId,
    content: buildSeedRecoveryResumeMessage(nextResult),
    status: 'active',
  });
  void processNextQueued(input.dir, resolvedDir);
  return nextResult;
}

async function withRoutingLock<T>(
  resolvedDir: string,
  fn: () => Promise<T>
): Promise<T> {
  return withSerializedKeyLock(routingLocks, resolvedDir, fn);
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
  threadId: string,
  runtime: ManagerWorkerRuntime,
  model: string | null,
  effort: string | null
): Promise<string | null> {
  const meta = await readManagerThreadMeta(dir);
  const workerSessionId = meta[threadId]?.workerSessionId?.trim() || null;
  if (!workerSessionId) {
    return null;
  }
  const storedRuntime = meta[threadId]?.workerSessionRuntime ?? null;
  if (!storedRuntime) {
    const defaults = workerRuntimeDefaults(runtime);
    const matchesLegacyDefault =
      runtime === 'codex' &&
      (model ?? defaults.model) === defaults.model &&
      (effort ?? defaults.effort ?? null) === (defaults.effort ?? null);
    return matchesLegacyDefault ? workerSessionId : null;
  }
  if (storedRuntime !== runtime) {
    return null;
  }
  const defaults = workerRuntimeDefaults(runtime);
  const storedModel =
    meta[threadId]?.workerSessionModel?.trim() || defaults.model;
  const storedEffort =
    meta[threadId]?.workerSessionEffort?.trim() || defaults.effort || null;
  const expectedModel = model?.trim() || defaults.model;
  const expectedEffort = effort?.trim() || defaults.effort || null;
  return storedModel === expectedModel && storedEffort === expectedEffort
    ? workerSessionId
    : null;
}

async function writeWorkerSessionId(
  dir: string,
  threadId: string,
  runtime: ManagerWorkerRuntime,
  model: string | null,
  effort: string | null,
  workerSessionId: string | null
): Promise<void> {
  const defaults = workerRuntimeDefaults(runtime);
  await updateManagerThreadMeta(dir, threadId, (current) => ({
    ...(current ?? {}),
    workerSessionId,
    workerSessionRuntime: workerSessionId ? runtime : null,
    workerSessionModel: workerSessionId
      ? model?.trim() || defaults.model
      : null,
    workerSessionEffort: workerSessionId
      ? effort?.trim() || defaults.effort || null
      : null,
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

function resolveStoredWorkerAssigneeLabel(
  meta: ManagerThreadMeta | null | undefined
): string {
  if (typeof meta?.assigneeLabel === 'string' && meta.assigneeLabel.trim()) {
    return meta.assigneeLabel.trim();
  }
  if (
    meta?.workerSessionRuntime === 'opencode' ||
    meta?.workerSessionRuntime === 'codex' ||
    meta?.workerSessionRuntime === 'claude' ||
    meta?.workerSessionRuntime === 'gemini' ||
    meta?.workerSessionRuntime === 'copilot'
  ) {
    return workerRuntimeAssigneeLabel(meta.workerSessionRuntime, process.env, {
      model: meta.workerSessionModel ?? null,
      effort: meta.workerSessionEffort ?? null,
    });
  }
  return 'Worker';
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
    const clearRuntimeFootprint =
      input.clearWorkerLiveLog === true &&
      input.runtimeState === null &&
      input.runtimeDetail === null;
    return {
      ...(current ?? {}),
      workerSessionId:
        input.workerSessionId ?? current?.workerSessionId ?? null,
      workerLastStartedAt:
        current?.workerLastStartedAt ?? new Date().toISOString(),
      assigneeKind: clearRuntimeFootprint
        ? null
        : input.assigneeKind === undefined
          ? (current?.assigneeKind ?? 'worker')
          : input.assigneeKind,
      assigneeLabel: clearRuntimeFootprint
        ? null
        : input.assigneeLabel === undefined
          ? resolveStoredWorkerAssigneeLabel(current)
          : input.assigneeLabel,
      workerAgentId: clearRuntimeFootprint
        ? null
        : input.workerAgentId === undefined
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
      workerWriteScopes: clearRuntimeFootprint
        ? []
        : input.workerWriteScopes === undefined
          ? (current?.workerWriteScopes ?? [])
          : (input.workerWriteScopes ?? []),
      workerBlockedByThreadIds: clearRuntimeFootprint
        ? []
        : input.workerBlockedByThreadIds === undefined
          ? (current?.workerBlockedByThreadIds ?? [])
          : (input.workerBlockedByThreadIds ?? []),
      supersededByThreadId: clearRuntimeFootprint
        ? null
        : input.supersededByThreadId === undefined
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
          ? resolveStoredWorkerAssigneeLabel(current)
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

async function cleanupWorktreeBestEffort(input: {
  targetRepoRoot: string;
  worktreePath: string | null | undefined;
  branchName: string | null | undefined;
  context: string;
}): Promise<string | null> {
  if (!input.worktreePath || !input.branchName) {
    return null;
  }

  let usedPlainGitCleanup = false;
  try {
    if (await dropManagerWorktree({ worktreePath: input.worktreePath })) {
      return null;
    }
    usedPlainGitCleanup = true;
    await removeWorktree({
      targetRepoRoot: input.targetRepoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
    });
    const residueDetail = await repairManagerWorktreeResidue({
      targetRepoRoot: input.targetRepoRoot,
      worktreePath: input.worktreePath,
      branchName: input.branchName,
    }).catch((error) => describeMwtError(error));
    if (residueDetail) {
      console.error(`[manager-backend] ${input.context}: ${residueDetail}`);
      return residueDetail;
    }
    return null;
  } catch (error) {
    let detail = describeMwtError(error);
    if (usedPlainGitCleanup) {
      const residueDetail = await repairManagerWorktreeResidue({
        targetRepoRoot: input.targetRepoRoot,
        worktreePath: input.worktreePath,
        branchName: input.branchName,
      }).catch((repairError) => describeMwtError(repairError));
      if (residueDetail) {
        detail = `${detail}\n\n${residueDetail}`;
      }
    }
    console.error(`[manager-backend] ${input.context}: ${detail}`);
    return detail;
  }
}

async function listRebaseConflictFiles(
  taskWorktreePath: string
): Promise<string[]> {
  const result = await execGit(taskWorktreePath, [
    'diff',
    '--name-only',
    '--diff-filter=U',
  ]).catch(() => null);
  if (!result || result.code !== 0) {
    return [];
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveRebaseConflictAndContinue(input: {
  dir: string;
  taskWorktreePath: string;
  thread: Thread;
  currentUserRequest: string;
  managedVerifyCommand?: string | null;
}): Promise<{ success: boolean; detail: string }> {
  const MAX_ATTEMPTS = 5;
  let conflictFiles = await listRebaseConflictFiles(input.taskWorktreePath);
  if (conflictFiles.length === 0) {
    return {
      success: false,
      detail:
        'Rebase reported a conflict, but no conflicted files were listed.',
    };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const conflictDiff =
      (
        await execGit(input.taskWorktreePath, ['diff']).catch(() => null)
      )?.stdout.slice(0, 12_000) ?? '';
    const verificationHint = input.managedVerifyCommand?.trim()
      ? `Use the repo-standard verification command first: ${input.managedVerifyCommand.trim()}.`
      : 'Use the repository-standard verification command first.';
    const prompt = [
      MANAGER_RECOVERY_FIX_SYSTEM_PROMPT,
      MANAGER_WORKER_JSON_RULES,
      `Workspace: ${input.taskWorktreePath}`,
      '[Context]',
      'A managed task worktree hit a git rebase conflict during final Manager delivery.',
      `Attempt: ${attempt + 1}/${MAX_ATTEMPTS}`,
      '[Latest user request]',
      buildManagerMessagePromptContent(input.currentUserRequest).text,
      `[Work item: ${input.thread.title}]`,
      'Conflicted files:',
      conflictFiles.map((file) => `- ${file}`).join('\n'),
      'Conflict diff (may be truncated):',
      conflictDiff || '(no diff output)',
      'Instructions:',
      '1. Read each conflicted file and resolve the conflict markers.',
      '2. Run git add on every resolved conflicted file.',
      `3. ${verificationHint}`,
      '4. Do NOT run git commit, git push, or git rebase --continue yourself. The backend will continue the rebase after your fix.',
      '5. Return strict JSON with status "review" only when the worktree is ready for rebase continuation.',
    ].join('\n\n');

    const fixResult = await runManagerRuntimeTurn({
      dir: input.dir,
      resolvedDir: input.taskWorktreePath,
      prompt,
      sessionId: null,
      runMode: 'write',
    });
    if (fixResult.code !== 0) {
      await execGit(input.taskWorktreePath, ['rebase', '--abort']).catch(
        () => {}
      );
      return {
        success: false,
        detail: `Manager conflict-fix turn exited with code ${fixResult.code ?? '?'}.`,
      };
    }

    const diffCheck = await execGit(input.taskWorktreePath, [
      'diff',
      '--check',
    ]).catch(() => null);
    if (!diffCheck || diffCheck.code !== 0) {
      conflictFiles = await listRebaseConflictFiles(input.taskWorktreePath);
      continue;
    }

    const continueResult = await execGit(input.taskWorktreePath, [
      '-c',
      'core.editor=true',
      'rebase',
      '--continue',
    ]).catch(() => null);
    if (continueResult?.code === 0) {
      return { success: true, detail: 'rebase conflict resolved' };
    }

    conflictFiles = await listRebaseConflictFiles(input.taskWorktreePath);
    if (conflictFiles.length === 0) {
      await execGit(input.taskWorktreePath, ['rebase', '--abort']).catch(
        () => {}
      );
      return {
        success: false,
        detail:
          continueResult?.stderr ||
          continueResult?.stdout ||
          'git rebase --continue failed after conflict resolution.',
      };
    }
  }

  await execGit(input.taskWorktreePath, ['rebase', '--abort']).catch(() => {});
  return {
    success: false,
    detail: `Manager could not finish resolving the rebase conflict after ${MAX_ATTEMPTS} attempts.`,
  };
}

async function reserveAssignment(input: {
  dir: string;
  assignment: ManagerActiveAssignment;
  priorityStreak: number;
}): Promise<void> {
  await updateSession(input.dir, (session) => {
    const withoutSameAssignment = session.activeAssignments.filter(
      (assignment) => assignment.id !== input.assignment.id
    );
    return {
      ...clearDispatchingSessionState(session),
      activeAssignments: [...withoutSameAssignment, input.assignment],
      lastMessageAt: new Date().toISOString(),
      priorityStreak: input.priorityStreak,
      lastErrorMessage: null,
      lastErrorAt: null,
      lastPauseMessage: null,
      lastPauseAt: null,
      lastPauseAutoResumeAt: null,
    };
  });
}

async function setDispatchingAssignment(input: {
  dir: string;
  threadId: string;
  queueEntryIds: string[];
  assigneeKind: 'manager' | 'worker';
  assigneeLabel: string;
  detail: string;
}): Promise<void> {
  await updateSession(input.dir, (session) => ({
    ...session,
    dispatchingThreadId: input.threadId,
    dispatchingQueueEntryIds: [...input.queueEntryIds],
    dispatchingAssigneeKind: input.assigneeKind,
    dispatchingAssigneeLabel: input.assigneeLabel,
    dispatchingDetail: input.detail,
    dispatchingStartedAt: new Date().toISOString(),
    lastErrorMessage: null,
    lastErrorAt: null,
    lastPauseMessage: null,
    lastPauseAt: null,
    lastPauseAutoResumeAt: null,
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

function inspectAssignmentReservation(assignment: ManagerActiveAssignment): {
  latestObservedAt: number;
  active: boolean;
} {
  const latestObservedAt =
    parseMessageTimestamp(assignment.lastProgressAt) ??
    parseMessageTimestamp(assignment.startedAt) ??
    Number.NEGATIVE_INFINITY;
  const withinGraceWindow =
    Number.isFinite(latestObservedAt) &&
    Date.now() - latestObservedAt < MANAGER_RECONCILE_GRACE_MS;
  const active =
    assignment.pid === null
      ? withinGraceWindow
      : isPidAlive(assignment.pid) || withinGraceWindow;
  return {
    latestObservedAt,
    active,
  };
}

function choosePreferredAssignment(
  current: ManagerActiveAssignment,
  candidate: ManagerActiveAssignment
): ManagerActiveAssignment {
  const currentReservation = inspectAssignmentReservation(current);
  const candidateReservation = inspectAssignmentReservation(candidate);
  if (currentReservation.active !== candidateReservation.active) {
    return candidateReservation.active ? candidate : current;
  }
  if (
    candidateReservation.latestObservedAt !==
    currentReservation.latestObservedAt
  ) {
    return candidateReservation.latestObservedAt >
      currentReservation.latestObservedAt
      ? candidate
      : current;
  }

  const currentStartedAt =
    parseMessageTimestamp(current.startedAt) ?? Number.NEGATIVE_INFINITY;
  const candidateStartedAt =
    parseMessageTimestamp(candidate.startedAt) ?? Number.NEGATIVE_INFINITY;
  return candidateStartedAt >= currentStartedAt ? candidate : current;
}

function hasSupersedingAiReply(thread: Thread, entries: QueueEntry[]): boolean {
  if (entries.length === 0 || thread.messages.length === 0) {
    return false;
  }

  if (
    thread.status !== 'review' &&
    thread.status !== 'needs-reply' &&
    thread.status !== 'resolved'
  ) {
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

  const lastAiAt = parseMessageTimestamp(lastMessage.at);
  if (lastAiAt === null || lastAiAt < latestCreatedAt) {
    return false;
  }

  const latestUserBeforeReplyAt = Math.max(
    ...thread.messages
      .filter((message) => message.sender === 'user')
      .map((message) => parseMessageTimestamp(message.at))
      .filter((value): value is number => value !== null && value <= lastAiAt),
    Number.NEGATIVE_INFINITY
  );

  return Number.isFinite(latestUserBeforeReplyAt);
}

function shouldHoldQueuedThreadForUserRecovery(
  thread: Thread,
  meta: ManagerThreadMeta | null
): boolean {
  if (!meta || thread.messages.at(-1)?.sender === 'user') {
    return false;
  }

  return Boolean(
    meta.seedRecoveryPending ||
    meta.pausedWorktreePath ||
    meta.pausedWorktreeBranch ||
    meta.pausedTargetRepoRoot
  );
}

async function decideDispatchForBatch(input: {
  dir: string;
  resolvedDir: string;
  thread: Thread;
  threadMeta: ManagerThreadMeta | null;
  entries: QueueEntry[];
  relatedActiveAssignments: ManagerActiveAssignment[];
}): Promise<ManagerDispatchPayload> {
  const managedRepos = await readManagedRepos(input.resolvedDir);
  const threadTargetKind: ManagerTargetKind =
    input.threadMeta?.repoTargetKind === 'new-repo' ||
    input.threadMeta?.newRepoRoot
      ? 'new-repo'
      : 'existing-repo';
  const threadNewRepoName = normalizeOptionalText(
    input.threadMeta?.newRepoName
  );
  const threadNewRepoRoot = normalizeOptionalText(
    input.threadMeta?.newRepoRoot
  );
  const currentManagedRepo =
    (input.threadMeta?.managedRepoId
      ? managedRepos.find((repo) => repo.id === input.threadMeta?.managedRepoId)
      : null) ??
    (input.threadMeta?.managedRepoRoot
      ? await findManagedRepoByRoot(
          input.resolvedDir,
          input.threadMeta.managedRepoRoot
        )
      : null);
  const inferredRepo =
    threadTargetKind === 'existing-repo' &&
    (input.threadMeta?.managedRepoRoot === null ||
      input.threadMeta?.managedRepoRoot === undefined)
      ? inferRepoContextFromThread({
          resolvedDir: input.resolvedDir,
          thread: input.thread,
          content: mergeQueuedEntryContent(input.entries),
        })
      : null;
  const effectiveRequestedRunMode: ManagerRunMode | null =
    input.entries.find(
      (entry) =>
        entry.requestedRunMode === 'read-only' ||
        entry.requestedRunMode === 'write'
    )?.requestedRunMode ??
    input.threadMeta?.requestedRunMode ??
    null;
  const prompt = buildDispatchPrompt({
    content: mergeQueuedEntryContent(input.entries),
    thread: stripTrailingUserMessagesFromThread(input.thread),
    resolvedDir: input.resolvedDir,
    relatedActiveAssignments: input.relatedActiveAssignments,
    repoTargetKind: threadTargetKind,
    managedRepoLabel:
      currentManagedRepo?.label ?? input.threadMeta?.managedRepoLabel ?? null,
    managedRepoRoot:
      currentManagedRepo?.repoRoot ?? input.threadMeta?.managedRepoRoot ?? null,
    newRepoName: threadNewRepoName,
    newRepoRoot: threadNewRepoRoot,
    managedBaseBranch:
      currentManagedRepo?.defaultBranch ??
      input.threadMeta?.managedBaseBranch ??
      null,
    managedVerifyCommand:
      currentManagedRepo?.verifyCommand ??
      input.threadMeta?.managedVerifyCommand ??
      null,
    requestedRunMode: effectiveRequestedRunMode,
    inferredRepoLabel: inferredRepo?.label ?? null,
    inferredRepoRoot: inferredRepo?.repoRoot ?? null,
    inferredRepoScope: inferredRepo?.scope ?? null,
    managedRepos,
  });
  const runResult = await runManagerRuntimeTurn({
    dir: input.dir,
    resolvedDir: input.resolvedDir,
    prompt,
    sessionId: null,
    runMode: effectiveRequestedRunMode ?? 'read-only',
    imagePaths: queueEntriesImagePaths(input.entries),
  });
  if (runResult.code !== 0) {
    throw new Error(
      extractRuntimeFailureDetail(runResult.stderr, 500) ||
        extractRuntimeFailureDetail(runResult.stdout, 500) ||
        `codex CLI exited with code ${runResult.code ?? '?'}`
    );
  }

  const parsed = parseManagerDispatchPayload(runResult.parsed.text);
  const writeRequestedByThread = effectiveRequestedRunMode === 'write';
  const contextExistingRepoScopes = currentManagedRepo
    ? [
        repoWriteScopeForWorkspace(
          input.resolvedDir,
          currentManagedRepo.repoRoot
        ),
      ]
    : input.threadMeta?.managedRepoRoot
      ? [
          repoWriteScopeForWorkspace(
            input.resolvedDir,
            input.threadMeta.managedRepoRoot
          ),
        ]
      : inferredRepo
        ? [inferredRepo.scope]
        : [];
  const fallbackWriteScopes =
    threadTargetKind === 'new-repo'
      ? writeRequestedByThread && threadNewRepoName
        ? [threadNewRepoName]
        : []
      : contextExistingRepoScopes;
  if (!parsed) {
    if (writeRequestedByThread && fallbackWriteScopes.length === 0) {
      return buildRepoTargetClarificationReply('dispatch-fallback');
    }
    return {
      assignee: 'worker',
      targetKind: threadTargetKind,
      repoId: currentManagedRepo?.id ?? null,
      newRepoName: threadNewRepoName,
      writeScopes: fallbackWriteScopes,
      reason: 'dispatch-fallback',
    };
  }

  if (parsed.assignee !== 'worker') {
    return parsed;
  }

  const parsedTargetKind =
    parsed.targetKind ?? (parsed.repoId ? 'existing-repo' : threadTargetKind);
  const resolvedNewRepoName =
    parsedTargetKind === 'new-repo'
      ? (() => {
          const rawName = parsed.newRepoName ?? threadNewRepoName;
          if (!rawName) {
            return null;
          }
          try {
            return validateNewRepoName(rawName);
          } catch {
            return null;
          }
        })()
      : null;
  if (parsedTargetKind === 'new-repo') {
    if (!resolvedNewRepoName) {
      return buildRepoTargetClarificationReply('new-repo-name-required');
    }
    return {
      ...parsed,
      targetKind: 'new-repo',
      repoId: null,
      newRepoName: resolvedNewRepoName,
      writeScopes:
        (parsed.writeScopes?.length ?? 0) === 0 &&
        effectiveRequestedRunMode === 'read-only'
          ? []
          : [resolvedNewRepoName],
    };
  }

  if (
    (parsed.writeScopes?.length ?? 0) === 0 &&
    effectiveRequestedRunMode === 'read-only'
  ) {
    return {
      ...parsed,
      targetKind: 'existing-repo',
      repoId: parsed.repoId ?? currentManagedRepo?.id ?? null,
      newRepoName: null,
      writeScopes: [],
    };
  }

  const explicitExistingWriteScopes =
    parsed.writeScopes?.filter(
      (scope) => scope && scope !== UNIVERSAL_WRITE_SCOPE
    ) ?? [];
  const selectedManagedRepo =
    (parsed.repoId
      ? managedRepos.find((repo) => repo.id === parsed.repoId)
      : null) ?? currentManagedRepo;
  if (parsed.repoId && !selectedManagedRepo) {
    return buildRepoTargetClarificationReply('managed-repo-not-found');
  }
  if (selectedManagedRepo) {
    const managedRepoWriteScopes =
      explicitExistingWriteScopes.length > 0
        ? explicitExistingWriteScopes
        : (parsed.writeScopes?.length ?? 0) === 0 ||
            parsed.writeScopes?.includes(UNIVERSAL_WRITE_SCOPE)
          ? [
              repoWriteScopeForWorkspace(
                input.resolvedDir,
                selectedManagedRepo.repoRoot
              ),
            ]
          : (parsed.writeScopes ?? []);
    return {
      ...parsed,
      targetKind: 'existing-repo',
      repoId: selectedManagedRepo.id,
      newRepoName: null,
      writeScopes: managedRepoWriteScopes,
    };
  }

  if (!input.threadMeta?.managedRepoRoot && !inferredRepo) {
    if (explicitExistingWriteScopes.length > 0) {
      return {
        ...parsed,
        targetKind: 'existing-repo',
        repoId: null,
        newRepoName: null,
        writeScopes: explicitExistingWriteScopes,
      };
    }
    if (
      parsed.writeScopes?.includes(UNIVERSAL_WRITE_SCOPE) ||
      writeRequestedByThread
    ) {
      return buildRepoTargetClarificationReply(
        'concrete-existing-repo-required'
      );
    }
    return {
      ...parsed,
      targetKind: 'existing-repo',
      repoId: null,
      newRepoName: null,
      writeScopes: [],
    };
  }

  const resolvedExistingWriteScopes =
    explicitExistingWriteScopes.length > 0
      ? explicitExistingWriteScopes
      : (parsed.writeScopes?.length ?? 0) === 0 ||
          parsed.writeScopes?.includes(UNIVERSAL_WRITE_SCOPE)
        ? contextExistingRepoScopes
        : (parsed.writeScopes ?? []);
  if (resolvedExistingWriteScopes.length === 0) {
    return buildRepoTargetClarificationReply('concrete-existing-repo-required');
  }

  return {
    ...parsed,
    targetKind: 'existing-repo',
    repoId: null,
    newRepoName: null,
    writeScopes: resolvedExistingWriteScopes,
  };
}

function defaultAssigneeLabel(
  kind: 'manager' | 'worker',
  runtime: ManagerWorkerRuntime = 'codex',
  selection?: { model?: string | null; effort?: string | null } | null
): string {
  return kind === 'manager'
    ? managerAssigneeLabel()
    : workerRuntimeAssigneeLabel(runtime, process.env, selection);
}

function buildDispatchingDetail(input: {
  assigneeKind: 'manager' | 'worker';
}): string {
  return input.assigneeKind === 'manager'
    ? 'Manager がこの作業項目の応答開始を準備しています。'
    : '担当 worker agent の起動や再開を準備しています。';
}

function normalizeSupportedWorkerRuntimes(
  runtimes: readonly ManagerWorkerRuntime[] | null | undefined
): Array<Extract<ManagerWorkerRuntime, 'opencode' | 'codex' | 'claude'>> {
  const supported = new Set<
    Extract<ManagerWorkerRuntime, 'opencode' | 'codex' | 'claude'>
  >();
  for (const runtime of runtimes ?? []) {
    if (runtime === 'opencode' || runtime === 'codex' || runtime === 'claude') {
      supported.add(runtime);
    }
  }
  if (supported.size === 0) {
    supported.add('codex');
    supported.add('claude');
  }
  return [...supported];
}

function runtimeConstraintCandidates(input: {
  supportedRuntimes: readonly ManagerWorkerRuntime[] | null | undefined;
  preferredWorkerRuntime: ManagerWorkerRuntime | null | undefined;
}): Array<Extract<ManagerWorkerRuntime, 'opencode' | 'codex' | 'claude'>> {
  const supported = normalizeSupportedWorkerRuntimes(input.supportedRuntimes);
  if (
    input.preferredWorkerRuntime === 'opencode' ||
    input.preferredWorkerRuntime === 'codex' ||
    input.preferredWorkerRuntime === 'claude'
  ) {
    return [input.preferredWorkerRuntime];
  }
  return supported;
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
    await removeAssignment(input.dir, assignment.id);
    await cleanupWorktreeBestEffort({
      targetRepoRoot: assignment.targetRepoRoot ?? input.dir,
      worktreePath: assignment.worktreePath,
      branchName: assignment.worktreeBranch,
      context: `Superseded assignment cleanup for ${assignment.id}`,
    });
    await addAiMessageBestEffort({
      dir: input.dir,
      threadId: assignment.threadId,
      content: `この作業項目は、新しく派生した「${input.supersedingThreadTitle}」の内容で既存成果が置き換わると判断したため、途中の担当 worker を止めました。`,
      status: 'active',
    });
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
  const workerRepoRoot =
    assignment.worktreePath ?? assignment.targetRepoRoot ?? resolvedDir;
  const workerCwd = assignment.workingDirectory ?? workerRepoRoot;
  const targetRepoRoot = assignment.targetRepoRoot ?? resolvedDir;
  const promptContent = mergeQueuedEntryContent(entries);
  const promptThread = stripTrailingUserMessagesFromThread(thread);
  const promptContentAt = latestTimestampValue([
    ...entries.map((entry) => entry.createdAt),
    lastUserMessage(thread)?.at ?? null,
  ]);
  let latestReplyContextUserAt = promptContentAt;
  const workerRuntime = assignment.workerRuntime;
  const workerModel = assignment.workerModel;
  const workerEffort = assignment.workerEffort;
  const sessionRuntime: ManagerWorkerRuntime =
    assignment.assigneeKind === 'worker' ? workerRuntime : 'codex';
  const threadMeta =
    (await readManagerThreadMeta(resolvedDir))[thread.id] ?? null;
  const requestedRunMode: ManagerRunMode | null =
    entries.find(
      (entry) =>
        entry.requestedRunMode === 'read-only' ||
        entry.requestedRunMode === 'write'
    )?.requestedRunMode ??
    threadMeta?.requestedRunMode ??
    null;
  let workerSessionId = await readWorkerSessionId(
    resolvedDir,
    thread.id,
    sessionRuntime,
    workerModel,
    workerEffort
  );
  const imagePaths = queueEntriesImagePaths(entries);
  const readCurrentPromptSnapshot = async () =>
    readLatestThreadPromptSnapshot({
      dir: resolvedDir,
      threadId: thread.id,
      fallbackThread: thread,
      fallbackPromptContent: promptContent,
      fallbackPromptAt: promptContentAt,
    });
  const currentReplyWasSuperseded = async () => {
    const latestPromptSnapshot = await readCurrentPromptSnapshot();
    return hasUserMessageAfter(
      latestPromptSnapshot.thread,
      latestReplyContextUserAt
    );
  };
  const describeRecoveryDecisionFailure = (result: {
    code: number | null;
    stdout: string;
    stderr: string;
    parsed: { text: string; sessionId: string | null };
  }): string => {
    if (result.code !== 0) {
      return `Recovery decision turn exited with code ${result.code ?? '?'}.${formatRuntimeFailureSuffix(
        {
          stdout: result.stdout,
          stderr: result.stderr,
          maxLength: 500,
        }
      )}`;
    }

    const parseableDetail =
      extractRuntimeFailureDetail(result.parsed.text, 500) ??
      result.parsed.text.trim().slice(0, 500);
    return parseableDetail
      ? `Recovery decision reply could not be parsed as valid Manager JSON.\n${parseableDetail}`
      : 'Recovery decision reply could not be parsed as valid Manager JSON.';
  };

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

    const commonInput = {
      dir,
      resolvedDir: workerCwd,
      prompt: turn.prompt,
      sessionId: turn.sessionId,
      threadStartedText: turn.initialLiveOutput,
      imagePaths,
      onSpawn: async (pid: number | null) => {
        await patchAssignment(dir, assignment.id, (current) => ({
          ...current,
          pid,
          lastProgressAt: new Date().toISOString(),
        }));
        await touchManagerProgress(dir);
      },
      onProgress: async (progress: CodexProgressState) => {
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
    };

    return turn.assigneeKind === 'manager'
      ? runManagerRuntimeTurn({
          ...commonInput,
          runMode: requestedRunMode,
        })
      : runWorkerRuntimeTurn({
          ...commonInput,
          runtime: workerRuntime,
          model: workerModel,
          effort: workerEffort,
          runMode: requestedRunMode,
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
              workingDirectory: assignment.workingDirectory,
              worktreePath: assignment.worktreePath,
              targetRepoRoot: assignment.targetRepoRoot,
              repoTargetKind: assignment.targetKind,
              newRepoName: assignment.newRepoName,
              newRepoRoot: threadMeta?.newRepoRoot ?? null,
              managedRepoLabel: threadMeta?.managedRepoLabel ?? null,
              managedRepoRoot: threadMeta?.managedRepoRoot ?? null,
              managedBaseBranch: threadMeta?.managedBaseBranch ?? null,
              managedVerifyCommand: threadMeta?.managedVerifyCommand ?? null,
              requestedRunMode,
              writeScopes: assignment.writeScopes,
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
      await writeWorkerSessionId(
        resolvedDir,
        thread.id,
        workerRuntime,
        workerModel,
        workerEffort,
        null
      );
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
      await writeWorkerSessionId(
        resolvedDir,
        thread.id,
        workerRuntime,
        workerModel,
        workerEffort,
        nextWorkerSessionId
      );
      reviewStepAttempted = true;
      const structuralWarnings = await runStructuralChecks(
        workerRepoRoot,
        workerResult.changedFiles
      );
      const reviewPromptSnapshot = await readCurrentPromptSnapshot();
      latestReplyContextUserAt = reviewPromptSnapshot.latestUserMessageAt;
      finalResult = await runTurn({
        prompt: buildManagerReviewPrompt({
          thread: reviewPromptSnapshot.thread,
          currentUserRequest: reviewPromptSnapshot.promptContent,
          workerResult,
          resolvedDir,
          workingDirectory: assignment.workingDirectory,
          worktreePath: assignment.worktreePath,
          writeScopes: assignment.writeScopes,
          requestedRunMode,
          managedVerifyCommand: threadMeta?.managedVerifyCommand ?? null,
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
    if (
      approved &&
      reviewStepAttempted &&
      assignment.worktreePath &&
      assignment.worktreeBranch
    ) {
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
    // Recovery loop — Manager decides how to handle review/deliver failures
    // -----------------------------------------------------------------------

    const MAX_RECOVERY_ATTEMPTS = 10;
    const attemptAutomaticRecovery = async (input: {
      initialErrorContext: string;
      recoverySubject: string;
      preservePausedWorktreeOnFailure: boolean;
      resetQueueProcessedOnRestart: boolean;
    }): Promise<boolean> => {
      let recoveryErrorContext = input.initialErrorContext;

      for (
        let recoveryAttempt = 0;
        recoveryAttempt < MAX_RECOVERY_ATTEMPTS;
        recoveryAttempt++
      ) {
        const stillTrackedRecovery = (
          await readSession(dir)
        ).activeAssignments.some((current) => current.id === assignment.id);
        if (!stillTrackedRecovery) {
          return false;
        }

        const recoveryPromptSnapshot = await readCurrentPromptSnapshot();
        latestReplyContextUserAt = recoveryPromptSnapshot.latestUserMessageAt;
        const recoveryDecisionResult = await runTurn({
          prompt: buildManagerRecoveryPrompt({
            thread: recoveryPromptSnapshot.thread,
            errorContext: recoveryErrorContext,
            resolvedDir,
            workingDirectory: assignment.workingDirectory,
            worktreePath: assignment.worktreePath,
          }),
          sessionId: null,
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          runtimeState: 'manager-recovery',
          runtimeDetail: `Manager が${input.recoverySubject}を分析し回復方法を決定中（試行 ${recoveryAttempt + 1}/${MAX_RECOVERY_ATTEMPTS}）`,
          initialLiveOutput: `Manager が${input.recoverySubject}の回復方法を判断しています…`,
          clearLiveLog: false,
          preserveWorkerSessionId: true,
        });

        const decision = parseManagerRecoveryDecision(
          recoveryDecisionResult.parsed.text
        );

        if (!decision || decision.decision === 'escalate') {
          if (input.preservePausedWorktreeOnFailure) {
            await preservePausedWorktreeForThread(
              resolvedDir,
              thread.id,
              assignment
            );
          }
          const recoveryDecisionFailureDetail = !decision
            ? describeRecoveryDecisionFailure(recoveryDecisionResult)
            : null;
          const escalateMsg = decision?.reason
            ? `[Manager] 自動回復できませんでした。\n理由: ${decision.reason}\n\n元のエラー:\n${recoveryErrorContext}`
            : `[Manager] 自動回復判断に失敗しました。\n理由: ${recoveryDecisionFailureDetail ?? 'Recovery decision reply could not be parsed.'}\n\n元のエラー:\n${recoveryErrorContext}`;
          if (!(await currentReplyWasSuperseded())) {
            await addAiMessageBestEffort({
              dir: resolvedDir,
              threadId: thread.id,
              content: escalateMsg,
              status: 'needs-reply',
            });
          }
          await setThreadRuntimeErrorMessage(
            resolvedDir,
            thread.id,
            escalateMsg
          );
          await updateQueueLocked(dir, (queue) =>
            queue.filter(
              (entry) => !assignment.queueEntryIds.includes(entry.id)
            )
          );
          if (isSessionInvalidError(finalCombinedOutput)) {
            await writeWorkerSessionId(
              resolvedDir,
              thread.id,
              sessionRuntime,
              workerModel,
              workerEffort,
              null
            );
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
          if (!input.preservePausedWorktreeOnFailure) {
            await cleanupWorktreeBestEffort({
              targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
              worktreePath: assignment.worktreePath,
              branchName: assignment.worktreeBranch,
              context: `Escalated recovery cleanup for ${assignment.id}`,
            });
          }
          void processNextQueued(dir, resolvedDir);
          return false;
        }

        if (decision.decision === 'restart') {
          await addAiMessageBestEffort({
            dir: resolvedDir,
            threadId: thread.id,
            content: `[Manager] アプローチをリセットして最初からやり直します。\n理由: ${decision.reason}`,
            status: 'active',
          });
          if (input.resetQueueProcessedOnRestart) {
            await updateQueueLocked(dir, (queue) =>
              queue.map((entry) =>
                assignment.queueEntryIds.includes(entry.id)
                  ? { ...entry, processed: false }
                  : entry
              )
            );
          }
          await clearPausedWorktreeForThread(resolvedDir, thread.id);
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
          await cleanupWorktreeBestEffort({
            targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
            worktreePath: assignment.worktreePath,
            branchName: assignment.worktreeBranch,
            context: `Restart recovery cleanup for ${assignment.id}`,
          });
          await writeWorkerSessionId(
            resolvedDir,
            thread.id,
            sessionRuntime,
            workerModel,
            workerEffort,
            null
          );
          void processNextQueued(dir, resolvedDir);
          return false;
        }

        let fixResult;
        if (decision.decision === 'fix-self') {
          const recoveryFixPromptSnapshot = await readCurrentPromptSnapshot();
          latestReplyContextUserAt =
            recoveryFixPromptSnapshot.latestUserMessageAt;
          fixResult = await runTurn({
            prompt: buildManagerRecoveryFixPrompt({
              instructions: decision.instructions ?? recoveryErrorContext,
              thread: recoveryFixPromptSnapshot.thread,
              currentUserRequest: recoveryFixPromptSnapshot.promptContent,
              resolvedDir,
              workingDirectory: assignment.workingDirectory,
              worktreePath: assignment.worktreePath,
              writeScopes: assignment.writeScopes,
              managedVerifyCommand: threadMeta?.managedVerifyCommand ?? null,
            }),
            sessionId: null,
            assigneeKind: 'manager',
            assigneeLabel: defaultAssigneeLabel('manager'),
            runtimeState: 'manager-answering',
            runtimeDetail: 'Manager が回復修正を直接適用中…',
            initialLiveOutput: 'Manager が回復修正を適用しています…',
            clearLiveLog: false,
            preserveWorkerSessionId: true,
          });
        } else {
          const retryPromptSnapshot = await readCurrentPromptSnapshot();
          latestReplyContextUserAt = retryPromptSnapshot.latestUserMessageAt;
          const runRetryWorkerTurn = (sessionId: string | null) =>
            runTurn({
              prompt: buildWorkerRetryPrompt({
                instructions: decision.instructions ?? recoveryErrorContext,
                thread: retryPromptSnapshot.thread,
                resolvedDir,
                workingDirectory: assignment.workingDirectory,
                worktreePath: assignment.worktreePath,
                writeScopes: assignment.writeScopes,
                managedVerifyCommand: threadMeta?.managedVerifyCommand ?? null,
              }),
              sessionId,
              assigneeKind: 'worker',
              assigneeLabel: assignment.assigneeLabel,
              runtimeState: 'worker-running',
              runtimeDetail: 'Worker が回復修正を実行中…',
              initialLiveOutput: 'Worker が回復修正を進めています…',
              clearLiveLog: false,
              preserveWorkerSessionId: false,
            });
          fixResult = await runRetryWorkerTurn(workerSessionId);
          const fixCombinedOutput = `${fixResult.stdout}\n${fixResult.stderr}`;
          if (
            fixResult.code !== 0 &&
            workerSessionId &&
            isSessionInvalidError(fixCombinedOutput)
          ) {
            await writeWorkerSessionId(
              resolvedDir,
              thread.id,
              workerRuntime,
              workerModel,
              workerEffort,
              null
            );
            workerSessionId = null;
            fixResult = await runRetryWorkerTurn(null);
          }
        }

        const stillTrackedAfterFix = (
          await readSession(dir)
        ).activeAssignments.some((current) => current.id === assignment.id);
        if (!stillTrackedAfterFix) {
          return false;
        }

        const fixParsedReply = parseManagerReplyPayload(fixResult.parsed.text);
        if (fixResult.code !== 0 || !fixParsedReply) {
          recoveryErrorContext =
            `Recovery attempt ${recoveryAttempt + 1} (${decision.decision}) failed: ` +
            (fixResult.code !== 0
              ? `exited with code ${fixResult.code}.${formatRuntimeFailureSuffix(
                  {
                    stdout: fixResult.stdout,
                    stderr: fixResult.stderr,
                  }
                )}`
              : 'No parseable reply from fix attempt.');
          continue;
        }

        const fixWorkerResult = parseManagerWorkerResultPayload(
          fixResult.parsed.text
        ) ?? {
          status: fixParsedReply.status,
          reply: fixParsedReply.reply,
          changedFiles: [],
          verificationSummary: null,
        };
        if (decision.decision === 'retry-worker') {
          workerSessionId = fixResult.parsed.sessionId ?? workerSessionId;
          await writeWorkerSessionId(
            resolvedDir,
            thread.id,
            workerRuntime,
            workerModel,
            workerEffort,
            workerSessionId
          );
        }
        latestReportedChangedFiles = fixWorkerResult.changedFiles;
        const reStructuralWarnings = await runStructuralChecks(
          workerRepoRoot,
          fixWorkerResult.changedFiles
        );
        const reReviewPromptSnapshot = await readCurrentPromptSnapshot();
        latestReplyContextUserAt = reReviewPromptSnapshot.latestUserMessageAt;
        const reReviewResult = await runTurn({
          prompt: buildManagerReviewPrompt({
            thread: reReviewPromptSnapshot.thread,
            currentUserRequest: reReviewPromptSnapshot.promptContent,
            workerResult: fixWorkerResult,
            resolvedDir,
            workingDirectory: assignment.workingDirectory,
            worktreePath: assignment.worktreePath,
            writeScopes: assignment.writeScopes,
            requestedRunMode,
            managedVerifyCommand: threadMeta?.managedVerifyCommand ?? null,
            structuralWarnings: reStructuralWarnings,
          }),
          sessionId: null,
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          runtimeState: 'manager-answering',
          runtimeDetail: 'Manager が回復修正の結果をレビュー中…',
          initialLiveOutput: 'Manager が回復修正の結果を確認しています…',
          clearLiveLog: false,
          preserveWorkerSessionId: true,
        });

        const stillTrackedAfterReReview = (
          await readSession(dir)
        ).activeAssignments.some((current) => current.id === assignment.id);
        if (!stillTrackedAfterReReview) {
          return false;
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
          if (assignment.worktreePath && assignment.worktreeBranch) {
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
          currentParsedReply = reReviewParsed;
          currentFallbackReply = reReviewFallback;
          approved = true;
          return true;
        }

        if (reReviewParsed?.status === 'needs-reply') {
          recoveryErrorContext = `Re-review returned needs-reply:\n${reReviewParsed.reply}`;
        } else if (reReviewResult.code !== 0) {
          recoveryErrorContext = `Re-review exited with code ${reReviewResult.code}.${formatRuntimeFailureSuffix(
            {
              stdout: reReviewResult.stdout,
              stderr: reReviewResult.stderr,
            }
          )}`;
        } else {
          recoveryErrorContext =
            'Re-review reply could not be parsed as valid Manager JSON.';
        }
      }

      if (input.preservePausedWorktreeOnFailure) {
        await preservePausedWorktreeForThread(
          resolvedDir,
          thread.id,
          assignment
        );
      }
      const exhaustedMsg = `[Manager] ${MAX_RECOVERY_ATTEMPTS} 回の自動回復試行で解決できませんでした。ユーザーの確認が必要です。\n\n最終エラー:\n${recoveryErrorContext}`;
      if (!(await currentReplyWasSuperseded())) {
        await addAiMessageOrPersistPending({
          dir: resolvedDir,
          threadId: thread.id,
          content: exhaustedMsg,
          status: 'needs-reply',
        });
      }
      await setThreadRuntimeErrorMessage(resolvedDir, thread.id, exhaustedMsg);
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
      if (!input.preservePausedWorktreeOnFailure) {
        await cleanupWorktreeBestEffort({
          targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
          worktreePath: assignment.worktreePath,
          branchName: assignment.worktreeBranch,
          context: `Exhausted recovery cleanup for ${assignment.id}`,
        });
      }
      void recoverCanonicalThreadState(dir).catch(() => {});
      void processNextQueued(dir, resolvedDir);
      return false;
    };

    if (!approved && reviewStepAttempted) {
      let recoveryErrorContext: string;
      if (deliveryReadinessDetail) {
        recoveryErrorContext = `Delivery readiness check failed:\n${deliveryReadinessDetail}`;
      } else if (finalResult.code !== 0) {
        recoveryErrorContext = `Review exited with code ${finalResult.code ?? '?'}.${formatRuntimeFailureSuffix(
          {
            stdout: finalResult.stdout,
            stderr: finalResult.stderr,
            maxLength: 500,
          }
        )}`;
      } else if (currentParsedReply?.status === 'needs-reply') {
        recoveryErrorContext = `Review returned needs-reply:\n${currentParsedReply.reply}`;
      } else {
        recoveryErrorContext =
          'The review reply could not be parsed as valid Manager JSON.';
      }

      approved = await attemptAutomaticRecovery({
        initialErrorContext: recoveryErrorContext,
        recoverySubject: 'レビュー失敗',
        preservePausedWorktreeOnFailure: false,
        resetQueueProcessedOnRestart: false,
      });
      if (!approved) {
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Success path — merge, push, post reply, clean up
    // -----------------------------------------------------------------------

    if (approved) {
      const shouldDeliverWorktreeChanges =
        !!assignment.worktreePath &&
        !!assignment.worktreeBranch &&
        (deliveryAheadCommitCount > 0 ||
          !!assignment.pendingOnboardingCommit?.trim());

      if (
        assignment.worktreePath &&
        assignment.worktreeBranch &&
        !shouldDeliverWorktreeChanges
      ) {
        await appendWorkerLiveOutput({
          dir: resolvedDir,
          threadId: thread.id,
          text: 'リポジトリ変更がないため、deliver と push をスキップして返信を返します…',
          kind: 'status',
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          workerSessionId,
          workerAgentId: assignment.id,
          runtimeState: 'manager-answering',
          runtimeDetail: '変更なしのため delivery を省略中…',
          workerWriteScopes: assignment.writeScopes,
        });
        await cleanupWorktreeBestEffort({
          targetRepoRoot,
          worktreePath: assignment.worktreePath,
          branchName: assignment.worktreeBranch,
          context: `No-op delivery cleanup for ${assignment.id}`,
        });
      } else if (assignment.worktreePath && assignment.worktreeBranch) {
        await appendWorkerLiveOutput({
          dir: resolvedDir,
          threadId: thread.id,
          text: 'Worker の変更を最新 target branch へ deliver しています…',
          kind: 'status',
          assigneeKind: 'manager',
          assigneeLabel: defaultAssigneeLabel('manager'),
          workerSessionId,
          workerAgentId: assignment.id,
          runtimeState: 'manager-answering',
          runtimeDetail: 'managed task worktree を deliver 中…',
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

        const deliveryTargetBranch =
          threadMeta?.managedBaseBranch?.trim() || null;
        const MAX_DELIVER_REMOTE_ADVANCE_RETRIES = 3;
        let deliverRemoteAdvanceRetries = 0;
        while (true) {
          try {
            let deliverResult;
            try {
              deliverResult = await deliverManagerWorktree({
                worktreePath: assignment.worktreePath,
                targetBranch: deliveryTargetBranch,
              });
            } catch (deliveryError) {
              if (isMwtDeliverConflictError(deliveryError)) {
                const conflictFiles = await listRebaseConflictFiles(
                  assignment.worktreePath
                );
                await appendWorkerLiveOutput({
                  dir: resolvedDir,
                  threadId: thread.id,
                  text:
                    conflictFiles.length > 0
                      ? `rebase コンフリクト検出（${conflictFiles.length} ファイル）。Manager が task worktree 上で解消を試みます…`
                      : 'rebase コンフリクトを検出しました。Manager が task worktree 上で解消を試みます…',
                  kind: 'status',
                  assigneeKind: 'manager',
                  assigneeLabel: defaultAssigneeLabel('manager'),
                  workerSessionId,
                  workerAgentId: assignment.id,
                  runtimeState: 'manager-answering',
                  runtimeDetail: 'rebase コンフリクト解消中…',
                  workerWriteScopes: assignment.writeScopes,
                });
                const conflictPromptSnapshot =
                  await readCurrentPromptSnapshot();
                latestReplyContextUserAt =
                  conflictPromptSnapshot.latestUserMessageAt;
                const conflictResolution =
                  await resolveRebaseConflictAndContinue({
                    dir,
                    taskWorktreePath: assignment.worktreePath,
                    thread: conflictPromptSnapshot.thread,
                    currentUserRequest: conflictPromptSnapshot.promptContent,
                    managedVerifyCommand:
                      threadMeta?.managedVerifyCommand ?? null,
                  });
                if (!conflictResolution.success) {
                  throw new Error(
                    `managed worktree deliver conflict could not be resolved: ${conflictResolution.detail}`
                  );
                }
                deliverResult = await deliverManagerWorktree({
                  worktreePath: assignment.worktreePath,
                  targetBranch: deliveryTargetBranch,
                  resume: true,
                });
              } else if (
                isMwtDeliverRemoteAdvanceError(deliveryError) &&
                deliverRemoteAdvanceRetries < MAX_DELIVER_REMOTE_ADVANCE_RETRIES
              ) {
                deliverRemoteAdvanceRetries += 1;
                await appendWorkerLiveOutput({
                  dir: resolvedDir,
                  threadId: thread.id,
                  text: `target branch が deliver 中に進んだため、最新 ${deliveryTargetBranch ?? 'target branch'} へ追従して deliver を再試行します（${deliverRemoteAdvanceRetries}/${MAX_DELIVER_REMOTE_ADVANCE_RETRIES}）…`,
                  kind: 'status',
                  assigneeKind: 'manager',
                  assigneeLabel: defaultAssigneeLabel('manager'),
                  workerSessionId,
                  workerAgentId: assignment.id,
                  runtimeState: 'manager-answering',
                  runtimeDetail:
                    'target branch 先行を検出したため deliver を再試行中…',
                  workerWriteScopes: assignment.writeScopes,
                });
                continue;
              } else {
                throw deliveryError;
              }
            }

            await appendWorkerLiveOutput({
              dir: resolvedDir,
              threadId: thread.id,
              text: 'deliver 完了。必要な release / publish を続けて実行しています…',
              kind: 'status',
              assigneeKind: 'manager',
              assigneeLabel: defaultAssigneeLabel('manager'),
              workerSessionId,
              workerAgentId: assignment.id,
              runtimeState: 'manager-answering',
              runtimeDetail: 'release / publish の最終確認中…',
              workerWriteScopes: assignment.writeScopes,
            });

            const releaseResult = await runPostMergeDeliveryChain({
              targetRepoRoot,
            });
            if (!releaseResult.success) {
              await preservePausedWorktreeForThread(
                resolvedDir,
                thread.id,
                assignment
              );
              const errMsg = `[Manager] deliver と push は完了しましたが、release / publish の完了前に停止しました: ${releaseResult.detail}`;
              if (!(await currentReplyWasSuperseded())) {
                await addAiMessageOrPersistPending({
                  dir: resolvedDir,
                  threadId: thread.id,
                  content: errMsg,
                  status: 'needs-reply',
                });
              }
              await setThreadRuntimeErrorMessage(
                resolvedDir,
                thread.id,
                errMsg
              );
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
              void recoverCanonicalThreadState(dir).catch(() => {});
              void processNextQueued(dir, resolvedDir);
              return;
            }

            await cleanupWorktreeBestEffort({
              targetRepoRoot,
              worktreePath: assignment.worktreePath,
              branchName: assignment.worktreeBranch,
              context: `Post-deliver manager worktree cleanup for ${assignment.id}`,
            });
            deliveryReadinessDetail =
              deliveryReadinessDetail ??
              `Delivered ${deliverResult.worktreeId} to ${deliverResult.targetBranch}.`;
            break;
          } catch (deliveryError) {
            approved = await attemptAutomaticRecovery({
              initialErrorContext: `Deliver failed:\n${describeMwtError(deliveryError)}`,
              recoverySubject: 'deliver 失敗',
              preservePausedWorktreeOnFailure: true,
              resetQueueProcessedOnRestart: true,
            });
            if (!approved) {
              return;
            }
            await appendWorkerLiveOutput({
              dir: resolvedDir,
              threadId: thread.id,
              text: '回復修正が完了したため、deliver を再試行しています…',
              kind: 'status',
              assigneeKind: 'manager',
              assigneeLabel: defaultAssigneeLabel('manager'),
              workerSessionId,
              workerAgentId: assignment.id,
              runtimeState: 'manager-answering',
              runtimeDetail: 'deliver を再試行中…',
              workerWriteScopes: assignment.writeScopes,
            });
          }
        }
      }

      await updateQueueLocked(dir, (queue) =>
        queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
      );
      if (!(await currentReplyWasSuperseded())) {
        await addAiMessageOrPersistPending({
          dir: resolvedDir,
          threadId: thread.id,
          content: currentParsedReply?.reply ?? currentFallbackReply ?? '',
          status: currentParsedReply?.status ?? MANAGER_REPLY_STATUS,
        });
      }
      if (assignment.assigneeKind === 'manager') {
        workerSessionId = nextWorkerSessionId;
        await writeWorkerSessionId(
          resolvedDir,
          thread.id,
          'codex',
          null,
          null,
          nextWorkerSessionId
        );
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
      await clearThreadRuntimeStatePreservingContinuity(resolvedDir, thread.id);
      await removeAssignment(dir, assignment.id);
      void recoverCanonicalThreadState(dir).catch(() => {});
      void processNextQueued(dir, resolvedDir);
      return;
    }

    // -----------------------------------------------------------------------
    // Non-review failure (worker or manager turn failed before review)
    // -----------------------------------------------------------------------

    const errMsg =
      finalResult.code === 0
        ? `[Manager error] ${assignment.assigneeKind === 'worker' ? assignment.assigneeLabel : 'Manager Codex'} finished successfully but no usable assistant reply could be parsed from the runtime output.`
        : `[Manager error] ${assignment.assigneeKind === 'worker' ? assignment.assigneeLabel : 'Manager Codex'} exited with code ${finalResult.code ?? '?'}.${formatRuntimeFailureSuffix(
            {
              stdout: finalResult.stdout,
              stderr: finalResult.stderr,
            }
          )}`;
    await addAiMessageOrPersistPending({
      dir: resolvedDir,
      threadId: thread.id,
      content: errMsg,
      status: 'needs-reply',
    });
    await setThreadRuntimeErrorMessage(resolvedDir, thread.id, errMsg);
    await setManagerRuntimeError(dir, errMsg);
    await updateQueueLocked(dir, (queue) =>
      queue.filter((entry) => !assignment.queueEntryIds.includes(entry.id))
    );
    if (isSessionInvalidError(finalCombinedOutput)) {
      await writeWorkerSessionId(
        resolvedDir,
        thread.id,
        sessionRuntime,
        workerModel,
        workerEffort,
        null
      );
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
    await clearThreadRuntimeStatePreservingContinuity(resolvedDir, thread.id);
    await removeAssignment(dir, assignment.id);
    await cleanupWorktreeBestEffort({
      targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
      worktreePath: assignment.worktreePath,
      branchName: assignment.worktreeBranch,
      context: `Failed turn cleanup for ${assignment.id}`,
    });
    void recoverCanonicalThreadState(dir).catch(() => {});
    void processNextQueued(dir, resolvedDir);
  } catch (error) {
    const stillTracked = (await readSession(dir)).activeAssignments.some(
      (current) => current.id === assignment.id
    );
    if (!stillTracked) {
      return;
    }

    if (error instanceof ManagerCodexUsageLimitError) {
      await preservePausedWorktreeForThread(resolvedDir, thread.id, assignment);
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
      await clearThreadRuntimeStatePreservingContinuity(resolvedDir, thread.id);
      await removeAssignment(dir, assignment.id);
      await setManagerRuntimePause(dir, error.message, error.autoResumeAt);
      return;
    }

    const errMsg =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `[Manager error] ${assignment.assigneeKind === 'worker' ? assignment.assigneeLabel : 'Manager Codex'} CLI not found in PATH. Install the required runtime CLI to use the built-in manager backend.`
        : `[Manager error] Failed to start ${assignment.assigneeKind === 'worker' ? assignment.assigneeLabel : 'Manager Codex'}: ${error instanceof Error ? error.message : String(error)}`;
    await addAiMessageOrPersistPending({
      dir: resolvedDir,
      threadId: thread.id,
      content: errMsg,
      status: 'needs-reply',
    });
    await setThreadRuntimeErrorMessage(resolvedDir, thread.id, errMsg);
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
    await clearThreadRuntimeStatePreservingContinuity(resolvedDir, thread.id);
    await removeAssignment(dir, assignment.id);
    await cleanupWorktreeBestEffort({
      targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
      worktreePath: assignment.worktreePath,
      branchName: assignment.worktreeBranch,
      context: `Unhandled runQueuedAssignment failure cleanup for ${assignment.id}`,
    });
    void recoverCanonicalThreadState(dir).catch(() => {});
    void processNextQueued(dir, resolvedDir);
  }
}

export async function processNextQueued(
  dir: string,
  resolvedDir: string
): Promise<void> {
  if (inFlight.has(resolvedDir)) {
    const recovered = await recoverStaleProcessNextQueuedReservation(
      dir,
      resolvedDir
    );
    if (recovered) {
      // Continue below with a fresh reservation.
    } else {
      rerunRequested.add(resolvedDir);
      return;
    }
  }
  inFlight.add(resolvedDir);
  cancelRecoveryRetryTimer(resolvedDir);
  let hadInternalError = false;
  inFlightStartedAt.set(resolvedDir, Date.now());

  try {
    let session = await reconcileActiveAssignments(dir);
    if (session.lastPauseMessage) {
      ensureManagerQuotaAutoResumeScheduled(dir, session);
      return;
    }
    const queue = await readQueue(dir);
    session = await markManagerSessionStartedForPendingQueue(
      dir,
      session,
      queue
    );
    if (session.status === 'not-started') {
      return;
    }

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
    const managedRepos = await readManagedRepos(resolvedDir);
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    let activeWorkerAssignments = session.activeAssignments.filter(
      (assignment: ManagerActiveAssignment) =>
        assignment.assigneeKind === 'worker'
    ).length;
    let activeManagerAssignments = session.activeAssignments.filter(
      (assignment: ManagerActiveAssignment) =>
        assignment.assigneeKind === 'manager'
    ).length;
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

      const threadMeta = meta[next.threadId] ?? null;
      if (shouldHoldQueuedThreadForUserRecovery(thread, threadMeta)) {
        continue;
      }
      if (isThreadInBackoff(threadMeta)) {
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
            threadMeta,
            entries: nextEntries,
            relatedActiveAssignments,
          })
        : {
            assignee: 'worker' as const,
            targetKind:
              normalizeTargetKind(
                nextEntries.find(
                  (entry) =>
                    entry.targetKind === 'existing-repo' ||
                    entry.targetKind === 'new-repo'
                )?.targetKind
              ) ?? 'existing-repo',
            repoId:
              normalizeOptionalText(
                nextEntries.find(
                  (entry) =>
                    typeof entry.repoId === 'string' && entry.repoId.trim()
                )?.repoId
              ) ?? null,
            newRepoName:
              normalizeOptionalText(
                nextEntries.find(
                  (entry) =>
                    typeof entry.newRepoName === 'string' &&
                    entry.newRepoName.trim()
                )?.newRepoName
              ) ?? null,
            writeScopes: (() => {
              const queuedWriteScopes = nextEntries.flatMap(
                (entry) => entry.writeScopes ?? []
              );
              if (queuedWriteScopes.length > 0) {
                return queuedWriteScopes;
              }
              if (
                nextEntries.some(
                  (entry) => entry.requestedRunMode === 'read-only'
                )
              ) {
                return [];
              }
              return [UNIVERSAL_WRITE_SCOPE];
            })(),
            reason: 'direct-worker-default',
          };
      const assignmentTargetKind: ManagerTargetKind =
        dispatch.targetKind === 'new-repo' ||
        nextEntries.some((entry) => entry.targetKind === 'new-repo') ||
        threadMeta?.repoTargetKind === 'new-repo'
          ? 'new-repo'
          : 'existing-repo';
      const assignmentNewRepoName =
        assignmentTargetKind === 'new-repo'
          ? normalizeOptionalText(
              dispatch.newRepoName ??
                nextEntries.find(
                  (entry) =>
                    typeof entry.newRepoName === 'string' &&
                    entry.newRepoName.trim()
                )?.newRepoName ??
                threadMeta?.newRepoName
            )
          : null;
      const selectedManagedRepo =
        assignmentTargetKind === 'existing-repo'
          ? ((normalizeOptionalText(dispatch.repoId)
              ? (managedRepos.find(
                  (repo) => repo.id === normalizeOptionalText(dispatch.repoId)
                ) ?? null)
              : null) ??
            (threadMeta?.managedRepoId
              ? (managedRepos.find(
                  (repo) => repo.id === threadMeta.managedRepoId
                ) ?? null)
              : null) ??
            (threadMeta?.managedRepoRoot
              ? await findManagedRepoByRoot(
                  resolvedDir,
                  threadMeta.managedRepoRoot
                )
              : null))
          : null;
      const inferredRepoContext =
        assignmentTargetKind === 'existing-repo' &&
        (threadMeta?.managedRepoRoot === null ||
          threadMeta?.managedRepoRoot === undefined)
          ? inferRepoContextFromThread({
              resolvedDir,
              thread,
              content: mergeQueuedEntryContent(nextEntries),
            })
          : null;
      const resolvedManagedRepo =
        selectedManagedRepo ??
        (assignmentTargetKind === 'existing-repo' && inferredRepoContext
          ? await findManagedRepoByRoot(
              resolvedDir,
              inferredRepoContext.repoRoot
            )
          : null);

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
      }

      const assignmentWriteScopes =
        dispatch.assignee === 'worker'
          ? (() => {
              const normalized = normalizeWriteScopes(dispatch.writeScopes);
              if (
                assignmentTargetKind === 'new-repo' &&
                assignmentNewRepoName &&
                normalized.includes(UNIVERSAL_WRITE_SCOPE)
              ) {
                return [assignmentNewRepoName];
              }
              if (
                resolvedManagedRepo &&
                normalized.includes(UNIVERSAL_WRITE_SCOPE)
              ) {
                return [
                  repoWriteScopeForWorkspace(
                    resolvedDir,
                    resolvedManagedRepo.repoRoot
                  ),
                ];
              }
              if (
                inferredRepoContext &&
                normalized.includes(UNIVERSAL_WRITE_SCOPE)
              ) {
                return [inferredRepoContext.scope];
              }
              return normalized;
            })()
          : [];
      const assignmentTargetRepoRoot =
        nextEntries.find(
          (entry) =>
            typeof entry.targetRepoRoot === 'string' &&
            entry.targetRepoRoot.trim()
        )?.targetRepoRoot ??
        threadMeta?.newRepoRoot ??
        resolvedManagedRepo?.repoRoot ??
        threadMeta?.managedRepoRoot ??
        (assignmentNewRepoName
          ? resolveNewRepoRoot(resolvedDir, assignmentNewRepoName)
          : null) ??
        inferredRepoContext?.repoRoot ??
        null;
      const explicitRequestedWorkerRuntime: ManagerWorkerRuntime | null =
        nextEntries.find(
          (entry) =>
            entry.requestedWorkerRuntime === 'opencode' ||
            entry.requestedWorkerRuntime === 'codex' ||
            entry.requestedWorkerRuntime === 'claude' ||
            entry.requestedWorkerRuntime === 'gemini' ||
            entry.requestedWorkerRuntime === 'copilot'
        )?.requestedWorkerRuntime ?? null;
      const requestedRunMode: ManagerRunMode | null =
        nextEntries.find(
          (entry) =>
            entry.requestedRunMode === 'read-only' ||
            entry.requestedRunMode === 'write'
        )?.requestedRunMode ??
        threadMeta?.requestedRunMode ??
        null;
      if (isImmediateManagerDispatchReply(dispatch)) {
        const latestDispatchPromptSnapshot =
          await readLatestThreadPromptSnapshot({
            dir: resolvedDir,
            threadId: next.threadId,
            fallbackThread: thread,
            fallbackPromptContent: mergeQueuedEntryContent(nextEntries),
            fallbackPromptAt: latestTimestampValue(
              nextEntries.map((entry) => entry.createdAt)
            ),
          });
        if (
          !hasUserMessageAfter(
            latestDispatchPromptSnapshot.thread,
            lastUserMessage(thread)?.at ?? null
          )
        ) {
          await addAiMessageBestEffort({
            dir: resolvedDir,
            threadId: next.threadId,
            content: dispatch.reply,
            status: dispatch.status,
          });
        }
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
      const blockingAssignments =
        dispatch.assignee === 'worker'
          ? session.activeAssignments.filter(
              (assignment: ManagerActiveAssignment) =>
                assignment.assigneeKind === 'worker' &&
                scopeLocksOverlap(
                  assignmentWriteScopes,
                  assignment.writeScopes,
                  assignmentTargetRepoRoot,
                  assignment.targetRepoRoot
                )
            )
          : [];
      if (dispatch.assignee === 'worker' && blockingAssignments.length > 0) {
        await setWorkerRuntimeState({
          dir: resolvedDir,
          threadId: next.threadId,
          assigneeKind: 'worker',
          assigneeLabel: defaultAssigneeLabel(
            'worker',
            explicitRequestedWorkerRuntime ??
              resolvedManagedRepo?.preferredWorkerRuntime ??
              resolvedManagedRepo?.supportedWorkerRuntimes[0] ??
              'codex'
          ),
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

      await setDispatchingAssignment({
        dir,
        threadId: next.threadId,
        queueEntryIds: batchIds,
        assigneeKind: dispatch.assignee,
        assigneeLabel: defaultAssigneeLabel(
          dispatch.assignee,
          explicitRequestedWorkerRuntime ??
            resolvedManagedRepo?.preferredWorkerRuntime ??
            resolvedManagedRepo?.supportedWorkerRuntimes[0] ??
            'codex'
        ),
        detail: buildDispatchingDetail({
          assigneeKind: dispatch.assignee,
        }),
      });

      const automaticWorkerRuntimes = runtimeConstraintCandidates({
        supportedRuntimes: resolvedManagedRepo?.supportedWorkerRuntimes,
        preferredWorkerRuntime: resolvedManagedRepo?.preferredWorkerRuntime,
      });
      let selectedWorkerRuntime: ManagerWorkerRuntime =
        explicitRequestedWorkerRuntime ?? automaticWorkerRuntimes[0] ?? 'codex';
      let selectedWorkerModel: string | null = null;
      let selectedWorkerEffort: string | null = null;

      if (dispatch.assignee === 'worker') {
        if (explicitRequestedWorkerRuntime) {
          const availability = describeWorkerRuntimeCliAvailability(
            explicitRequestedWorkerRuntime
          );
          if (!availability.available) {
            const assigneeLabel = defaultAssigneeLabel(
              'worker',
              explicitRequestedWorkerRuntime
            );
            const errMsg = `[Manager error] ${assigneeLabel} CLI not found before worker start. ${availability.detail}\nInstall the required runtime CLI or resend with another worker runtime.`;
            await clearWorkerLiveOutput(
              resolvedDir,
              next.threadId,
              'worker',
              assigneeLabel,
              {
                workerAgentId: null,
                runtimeState: null,
                runtimeDetail: null,
                workerWriteScopes: assignmentWriteScopes,
                workerBlockedByThreadIds: [],
                supersededByThreadId: null,
              }
            );
            await addAiMessageBestEffort({
              dir: resolvedDir,
              threadId: next.threadId,
              content: errMsg,
              status: 'needs-reply',
            });
            await setThreadRuntimeErrorMessage(
              resolvedDir,
              next.threadId,
              errMsg
            );
            await setManagerRuntimeError(dir, errMsg);
            await updateQueueLocked(dir, (currentQueue) =>
              currentQueue.filter((entry) => !batchIds.includes(entry.id))
            );
            continue;
          }
          const defaults = workerRuntimeDefaults(
            explicitRequestedWorkerRuntime
          );
          selectedWorkerRuntime = explicitRequestedWorkerRuntime;
          selectedWorkerModel = defaults.model;
          selectedWorkerEffort = defaults.effort;
        } else {
          try {
            const liveSelection = await selectRankedWorkerModel({
              content: mergeQueuedEntryContent(nextEntries),
              writeScopes: assignmentWriteScopes,
              runMode: requestedRunMode,
              supportedRuntimes: automaticWorkerRuntimes,
            });
            selectedWorkerRuntime = liveSelection.selected.runtime;
            selectedWorkerModel = liveSelection.selected.model;
            selectedWorkerEffort = liveSelection.selected.effort;
          } catch (selectionErr) {
            const detail =
              selectionErr instanceof Error
                ? selectionErr.message
                : String(selectionErr);
            const quotaBlocked = /sufficient quota/i.test(detail);
            const assigneeLabel = defaultAssigneeLabel(
              'worker',
              automaticWorkerRuntimes[0] ?? 'codex'
            );
            const errMsg = quotaBlocked
              ? `[Manager error] Live worker model selection could not find any currently eligible worker with sufficient quota. ${detail}\nFree quota or retry later, then resend the request.`
              : `[Manager error] Live worker model selection failed before a worker could start. ${detail}\nFix the live benchmark or ai-quota path, then resend the request.`;
            console.warn(
              `[manager-backend] live worker selection failed for ${next.threadId}: ${detail}`
            );
            await clearWorkerLiveOutput(
              resolvedDir,
              next.threadId,
              'worker',
              assigneeLabel,
              {
                workerAgentId: null,
                runtimeState: null,
                runtimeDetail: null,
                workerWriteScopes: assignmentWriteScopes,
                workerBlockedByThreadIds: [],
                supersededByThreadId: null,
              }
            );
            await addAiMessageBestEffort({
              dir: resolvedDir,
              threadId: next.threadId,
              content: errMsg,
              status: 'needs-reply',
            });
            await setThreadRuntimeErrorMessage(
              resolvedDir,
              next.threadId,
              errMsg
            );
            if (!quotaBlocked) {
              await setManagerRuntimeError(dir, errMsg);
            }
            await updateQueueLocked(dir, (currentQueue) =>
              currentQueue.filter((entry) => !batchIds.includes(entry.id))
            );
            continue;
          }
        }
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
        targetKind: assignmentTargetKind,
        newRepoName: assignmentNewRepoName,
        workingDirectory: null,
        workerRuntime: selectedWorkerRuntime,
        workerModel: selectedWorkerModel,
        workerEffort: selectedWorkerEffort,
        assigneeLabel: defaultAssigneeLabel(
          dispatch.assignee,
          selectedWorkerRuntime,
          {
            model: selectedWorkerModel,
            effort: selectedWorkerEffort,
          }
        ),
        writeScopes: assignmentWriteScopes,
        pid: null,
        startedAt: new Date().toISOString(),
        lastProgressAt: null,
        worktreePath: null,
        worktreeBranch: null,
        targetRepoRoot: null,
        pendingOnboardingCommit: null,
      };

      // Create isolated worktree for worker assignments.
      if (dispatch.assignee === 'worker') {
        const requestedWorkingDirectory =
          dispatch.workingDirectory ??
          nextEntries.find(
            (entry) =>
              typeof entry.workingDirectory === 'string' &&
              entry.workingDirectory.trim()
          )?.workingDirectory ??
          null;
        const targetRepo =
          assignmentTargetRepoRoot ??
          resolveTargetRepoRoot(resolvedDir, assignmentWriteScopes);
        try {
          assignment.targetRepoRoot = targetRepo;
          if (assignmentTargetKind === 'new-repo') {
            await prepareNewRepoWorkspace({
              workspaceRoot: resolvedDir,
              targetRepoRoot: targetRepo,
            });
          } else {
            const pausedWorktreeReuse = await evaluatePausedWorktreeReuse({
              threadMeta,
              targetRepoRoot: targetRepo,
            });
            if (pausedWorktreeReuse.reusable) {
              assignment.worktreePath = pausedWorktreeReuse.worktreePath;
              assignment.worktreeBranch = pausedWorktreeReuse.worktreeBranch;
              assignment.targetRepoRoot = pausedWorktreeReuse.targetRepoRoot;
              await clearPausedWorktreeForThread(resolvedDir, thread.id);
            } else if (pausedWorktreeReuse.hasSnapshot) {
              const errMsg = buildPausedWorktreeResumeBlockedMessage({
                detail:
                  pausedWorktreeReuse.reason ??
                  'saved paused worktree metadata could not be validated.',
              });
              await addAiMessageBestEffort({
                dir: resolvedDir,
                threadId: thread.id,
                content: errMsg,
                status: 'needs-reply',
              });
              // Persist as runtime error for operational blocker (paused worktree)
              await setThreadRuntimeErrorMessage(
                resolvedDir,
                thread.id,
                errMsg
              );
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
            } else {
              const managedRepoReady =
                await isManagedWorktreeRepository(targetRepo);
              if (!managedRepoReady) {
                const autoInitResult =
                  await maybeAutoInitializeManagerRepository({
                    targetRepoRoot: targetRepo,
                    defaultBranch:
                      resolvedManagedRepo?.defaultBranch ??
                      threadMeta?.managedBaseBranch ??
                      null,
                  });
                if (autoInitResult.initialized) {
                  assignment.pendingOnboardingCommit =
                    autoInitResult.onboardingCommit?.trim() || null;
                  await addAiMessageBestEffort({
                    dir: resolvedDir,
                    threadId: thread.id,
                    content: `[Manager] この repo は managed-worktree-system (\`mwt\`) 未初期化だったため、安全に自動初期化してから続行します。\n\n${autoInitResult.detail}`,
                    status: 'active',
                  });
                } else {
                  const errMsg = buildAutoMwtInitBlockedMessage({
                    detail: autoInitResult.detail,
                    defaultBranch: autoInitResult.defaultBranch,
                    remoteName: autoInitResult.remoteName,
                    changedFiles: autoInitResult.changedFiles,
                  });
                  await addAiMessageBestEffort({
                    dir: resolvedDir,
                    threadId: thread.id,
                    content: errMsg,
                    status: 'needs-reply',
                  });
                  // Persist as runtime error for operational blocker (auto-mwt init)
                  await setThreadRuntimeErrorMessage(
                    resolvedDir,
                    thread.id,
                    errMsg
                  );
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

              const wt = await createManagerWorktree({
                targetRepoRoot: targetRepo,
                assignmentId: assignment.id,
              });
              assignment.worktreePath = wt.worktreePath;
              assignment.worktreeBranch = wt.branchName;
              assignment.targetRepoRoot = wt.targetRepoRoot;
              await clearSeedRecoveryState(resolvedDir, thread.id);
            }
          }

          const workerRoot =
            assignment.worktreePath ?? assignment.targetRepoRoot ?? targetRepo;
          const workingDirectoryResolution = resolveAssignmentWorkingDirectory({
            requestedWorkingDirectory,
            workerRoot,
            targetRepoRoot: assignment.targetRepoRoot ?? targetRepo,
          });
          if (!workingDirectoryResolution.error) {
            assignment.workingDirectory =
              workingDirectoryResolution.resolvedWorkingDirectory;
          } else {
            const recoveryResult = await runManagerRuntimeTurn({
              dir,
              resolvedDir: workerRoot,
              prompt: buildWorkingDirectoryRecoveryPrompt({
                thread: stripTrailingUserMessagesFromThread(thread),
                currentUserRequest: mergeQueuedEntryContent(nextEntries),
                workerRoot,
                targetRepoRoot: assignment.targetRepoRoot ?? targetRepo,
                worktreePath: assignment.worktreePath,
                workingDirectory: requestedWorkingDirectory,
                writeScopes: assignmentWriteScopes,
                error: workingDirectoryResolution.error,
              }),
              sessionId: null,
              runMode: requestedRunMode,
              imagePaths: queueEntriesImagePaths(nextEntries),
            });
            const recoveryPayload =
              recoveryResult.code === 0
                ? parseManagerDispatchPayload(recoveryResult.parsed.text)
                : null;

            if (
              recoveryPayload?.assignee === 'worker' ||
              (recoveryPayload?.assignee === 'manager' &&
                recoveryPayload.status === 'needs-reply' &&
                recoveryPayload.reply)
            ) {
              if (recoveryPayload.assignee === 'manager') {
                await addAiMessageOrPersistPending({
                  dir: resolvedDir,
                  threadId: thread.id,
                  content: recoveryPayload.reply!,
                  status: recoveryPayload.status ?? 'needs-reply',
                });
                await updateQueueLocked(dir, (queue) =>
                  queue.filter(
                    (entry) => !assignment.queueEntryIds.includes(entry.id)
                  )
                );
                if (assignment.worktreePath && assignment.worktreeBranch) {
                  await cleanupWorktreeBestEffort({
                    targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
                    worktreePath: assignment.worktreePath,
                    branchName: assignment.worktreeBranch,
                    context: `Working-directory recovery cleanup for ${assignment.id}`,
                  });
                }
                continue;
              }

              const recoveredWorkingDirectory =
                recoveryPayload.workingDirectory ?? null;
              const recoveredResolution = resolveAssignmentWorkingDirectory({
                requestedWorkingDirectory: recoveredWorkingDirectory,
                workerRoot,
                targetRepoRoot: assignment.targetRepoRoot ?? targetRepo,
              });
              if (!recoveredResolution.error) {
                assignment.workingDirectory =
                  recoveredResolution.resolvedWorkingDirectory;
              } else {
                const errMsg = `[Manager] Worker の workingDirectory を確定できませんでした。\n${recoveredResolution.error}`;
                await addAiMessageBestEffort({
                  dir: resolvedDir,
                  threadId: thread.id,
                  content: errMsg,
                  status: 'needs-reply',
                });
                await setThreadRuntimeErrorMessage(
                  resolvedDir,
                  thread.id,
                  errMsg
                );
                if (assignment.worktreePath && assignment.worktreeBranch) {
                  await cleanupWorktreeBestEffort({
                    targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
                    worktreePath: assignment.worktreePath,
                    branchName: assignment.worktreeBranch,
                    context: `Recovered working-directory rejection cleanup for ${assignment.id}`,
                  });
                }
                continue;
              }
            } else {
              const errMsg = `[Manager] Worker の workingDirectory を確定できませんでした。\n${workingDirectoryResolution.error}`;
              await addAiMessageBestEffort({
                dir: resolvedDir,
                threadId: thread.id,
                content: errMsg,
                status: 'needs-reply',
              });
              await setThreadRuntimeErrorMessage(
                resolvedDir,
                thread.id,
                errMsg
              );
              if (assignment.worktreePath && assignment.worktreeBranch) {
                await cleanupWorktreeBestEffort({
                  targetRepoRoot: assignment.targetRepoRoot ?? resolvedDir,
                  worktreePath: assignment.worktreePath,
                  branchName: assignment.worktreeBranch,
                  context: `Initial working-directory rejection cleanup for ${assignment.id}`,
                });
              }
              continue;
            }
          }
        } catch (wtErr) {
          if (wtErr instanceof ManagerCodexUsageLimitError) {
            await preservePausedWorktreeForThread(
              resolvedDir,
              thread.id,
              assignment
            );
            await clearWorkerLiveOutput(
              resolvedDir,
              thread.id,
              'worker',
              assignment.assigneeLabel,
              {
                workerAgentId: null,
                runtimeState: null,
                runtimeDetail: null,
                workerWriteScopes: assignmentWriteScopes,
                workerBlockedByThreadIds: [],
                supersededByThreadId: null,
              }
            );
            await setManagerRuntimePause(
              dir,
              wtErr.message,
              wtErr.autoResumeAt
            );
            return;
          }
          if (isMwtSeedTrackedDirtyError(wtErr)) {
            const repoLabel =
              resolvedManagedRepo?.label ??
              inferredRepoContext?.label ??
              threadMeta?.managedRepoLabel ??
              basename(targetRepo);
            const changedFiles = listMwtChangedFiles(wtErr);
            await updateManagerThreadMeta(
              resolvedDir,
              thread.id,
              (current) => ({
                ...(current ?? {}),
                seedRecoveryPending: true,
                seedRecoveryRepoRoot: targetRepo,
                seedRecoveryRepoLabel: repoLabel,
                seedRecoveryChangedFiles: changedFiles,
              })
            );
            await setWorkerRuntimeState({
              dir: resolvedDir,
              threadId: thread.id,
              assigneeKind: 'manager',
              assigneeLabel: defaultAssigneeLabel('manager'),
              workerAgentId: null,
              runtimeState: 'manager-recovery',
              runtimeDetail:
                '対象 repo の seed worktree に tracked changes があるため止まっています。下の「退避して続行」で一時退避すると再開できます。',
              workerWriteScopes: assignmentWriteScopes,
              workerBlockedByThreadIds: [],
              supersededByThreadId: null,
              clearWorkerLiveLog: true,
            });
            const seedErrMsg = buildSeedRecoveryPendingMessage({
              repoLabel,
              changedFiles,
              errorDetail: describeMwtError(wtErr),
            });
            await addAiMessageBestEffort({
              dir: resolvedDir,
              threadId: thread.id,
              content: seedErrMsg,
              status: 'needs-reply',
            });
            // Persist as runtime error for operational blocker (seed recovery)
            await setThreadRuntimeErrorMessage(
              resolvedDir,
              thread.id,
              seedErrMsg
            );
            continue;
          }
          const errorDetail = describeMwtError(wtErr);
          const errMsg = errorDetail.includes('\n')
            ? `[Manager] Worker 隔離環境の作成に失敗しました。\n${errorDetail}`
            : `[Manager] Worker 隔離環境の作成に失敗しました: ${errorDetail}`;
          await addAiMessageBestEffort({
            dir: resolvedDir,
            threadId: thread.id,
            content: errMsg,
            status: 'needs-reply',
          });
          await setThreadRuntimeErrorMessage(resolvedDir, thread.id, errMsg);
          continue;
        }
      }

      await updateManagerThreadMeta(resolvedDir, next.threadId, (current) =>
        clearSeedRecoveryStateFromMeta({
          ...(current ?? {}),
          managedRepoId:
            assignmentTargetKind === 'existing-repo'
              ? (resolvedManagedRepo?.id ?? current?.managedRepoId ?? null)
              : null,
          managedRepoLabel:
            assignmentTargetKind === 'new-repo'
              ? assignmentNewRepoName
              : (resolvedManagedRepo?.label ??
                inferredRepoContext?.label ??
                current?.managedRepoLabel ??
                null),
          managedRepoRoot:
            assignmentTargetKind === 'new-repo'
              ? (assignment.targetRepoRoot ?? null)
              : (resolvedManagedRepo?.repoRoot ??
                inferredRepoContext?.repoRoot ??
                current?.managedRepoRoot ??
                null),
          repoTargetKind: assignmentTargetKind,
          newRepoName:
            assignmentTargetKind === 'new-repo' ? assignmentNewRepoName : null,
          newRepoRoot:
            assignmentTargetKind === 'new-repo'
              ? (assignment.targetRepoRoot ?? null)
              : null,
          managedBaseBranch:
            assignmentTargetKind === 'new-repo'
              ? 'main'
              : (resolvedManagedRepo?.defaultBranch ??
                current?.managedBaseBranch ??
                null),
          managedVerifyCommand:
            assignmentTargetKind === 'existing-repo'
              ? (resolvedManagedRepo?.verifyCommand ??
                current?.managedVerifyCommand ??
                null)
              : null,
          requestedWorkerRuntime: explicitRequestedWorkerRuntime,
          requestedRunMode,
        })
      );

      await reserveAssignment({
        dir,
        assignment,
        priorityStreak,
      });
      for (const entryId of batchIds) {
        startedEntryIds.add(entryId);
      }
      if (dispatch.assignee === 'worker') {
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
    if (err instanceof ManagerCodexUsageLimitError) {
      await setManagerRuntimePause(dir, err.message, err.autoResumeAt);
      return;
    }
    hadInternalError = true;
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
    scheduleRecoveryRetry(dir, resolvedDir);
  } finally {
    await updateSession(dir, (session) =>
      clearDispatchingSessionState(session)
    );
    const shouldRerun = rerunRequested.has(resolvedDir);
    clearProcessNextQueuedReservation(resolvedDir);
    if (!hadInternalError) {
      recoveryRetryAttempts.delete(resolvedDir);
    }
    if (shouldRerun) {
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
    return runManagerRuntimeTurn({
      dir: input.dir,
      resolvedDir: input.resolvedDir,
      prompt: promptData.prompt,
      sessionId,
      runMode: 'read-only',
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
    await clearManagerRuntimePause(dir);

    let routed: Awaited<ReturnType<typeof routeFreeformMessage>>;
    try {
      routed = await routeFreeformMessage({
        dir,
        resolvedDir,
        content,
        contextThreadId: options?.contextThreadId ?? null,
      });
    } catch (error) {
      if (error instanceof ManagerCodexUsageLimitError) {
        await setManagerRuntimePause(dir, error.message, error.autoResumeAt);
        throw new Error(error.message);
      }
      throw error;
    }
    const { plan, routingSessionId } = routed;

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
          const requestedRunMode =
            inferRequestedRunModeFromContent(userMessage);
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
              requestedRunMode,
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
          const requestedRunMode =
            inferRequestedRunModeFromContent(userMessage);
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
            {
              dispatchMode: 'manager-evaluate',
              requestedRunMode,
            }
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

export async function sendThreadFollowUpToBuiltinManager(
  dir: string,
  threadId: string,
  content: string
): Promise<ManagerRoutingSummary> {
  const resolvedDir = resolvePath(dir);

  await ensureThreadReadyForUserMessage(resolvedDir, threadId);
  await clearThreadRoutingStatePreservingContinuity(resolvedDir, threadId);
  const currentMeta =
    (await readManagerThreadMeta(resolvedDir))[threadId] ?? null;
  if (
    typeof currentMeta?.pausedWorktreePath === 'string' &&
    currentMeta.pausedWorktreePath.trim() &&
    !existsSync(currentMeta.pausedWorktreePath.trim())
  ) {
    await clearPausedWorktreeForThread(resolvedDir, threadId);
  }
  await addMessage(resolvedDir, threadId, content, 'user', 'waiting');
  await sendToBuiltinManager(resolvedDir, threadId, content, {
    dispatchMode: 'manager-evaluate',
    requestedRunMode: inferRequestedRunModeFromContent(content),
  });

  const thread = await getThread(resolvedDir, threadId);
  return {
    items: [
      {
        threadId,
        title: thread?.title ?? threadId,
        outcome: 'attached-existing',
        reason: '開いている作業項目へそのまま追加しました。',
      },
    ],
    routedCount: 1,
    ambiguousCount: 0,
    detail: 'この会話に追加しました',
  };
}

// ── Eager reconciliation (called at server startup) ────────────────────────

async function cleanupStaleTempFiles(dir: string): Promise<void> {
  const resolvedDir = resolvePath(dir);
  const tmpPaths = [
    `${sessionFilePath(resolvedDir)}.tmp`,
    `${queueFilePath(resolvedDir)}.tmp`,
    join(resolvedDir, `${MANAGER_THREAD_META_FILE}.tmp`),
  ];
  await Promise.allSettled(tmpPaths.map((p) => unlink(p).catch(() => {})));
}

/**
 * Run assignment reconciliation immediately.  Intended to be called once at
 * server startup so that dead assignments left over from a previous crash are
 * cleaned up without waiting for the next queue tick.
 */
export async function eagerReconcile(dir: string): Promise<void> {
  await cleanupStaleTempFiles(dir);
  await reconcileActiveAssignments(dir);
  await recoverCanonicalThreadState(dir);
  startStaleSeedRecoveryMonitor(dir);
  await processNextQueued(dir, resolvePath(dir));
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
  const dispatchingQueueIds = new Set(session.dispatchingQueueEntryIds ?? []);
  const pending = queue.filter(
    (entry) =>
      !entry.processed &&
      !activeQueueIds.has(entry.id) &&
      !dispatchingQueueIds.has(entry.id)
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

  if (session.dispatchingThreadId) {
    const dispatchingThread = await getThread(dir, session.dispatchingThreadId);
    const dispatchingLabel =
      dispatchingThread?.title ?? session.dispatchingThreadId;
    return {
      running: true,
      configured: true,
      builtinBackend: true,
      health: 'ok',
      detail: dispatchingLabel
        ? `処理開始中 (${dispatchingLabel})`
        : '処理開始中',
      pendingCount: pending,
      currentQueueId: session.dispatchingQueueEntryIds?.[0] ?? null,
      currentThreadId: session.dispatchingThreadId,
      currentThreadTitle: dispatchingThread?.title ?? null,
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
    if (latestSession.lastPauseMessage) {
      ensureManagerQuotaAutoResumeScheduled(dir, latestSession);
      return {
        running: true,
        configured: true,
        builtinBackend: true,
        health: 'paused',
        detail: 'Manager Codex の利用上限で停止中です',
        pendingCount: pending,
        currentQueueId: null,
        currentThreadId: null,
        currentThreadTitle: null,
        errorMessage: latestSession.lastPauseMessage,
        errorAt: latestSession.lastPauseAt,
      };
    }
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
    void kickIdleQueuedManagerWork(dir, 'manager-status');
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

  if (session.lastPauseMessage) {
    ensureManagerQuotaAutoResumeScheduled(dir, session);
    return {
      running: true,
      configured: true,
      builtinBackend: true,
      health: 'paused',
      detail: 'Manager Codex の利用上限で停止中です',
      pendingCount: pending,
      currentQueueId: null,
      currentThreadId: null,
      currentThreadTitle: null,
      errorMessage: session.lastPauseMessage,
      errorAt: session.lastPauseAt,
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

export async function kickIdleQueuedManagerWork(
  dir: string,
  _reason = 'idle-queued-work'
): Promise<boolean> {
  const resolvedDir = resolvePath(dir);
  let session = await reconcileActiveAssignments(dir);
  const queue = await readQueue(dir);
  if (
    session.activeAssignments.length > 0 ||
    session.dispatchingThreadId ||
    (session.dispatchingQueueEntryIds?.length ?? 0) > 0 ||
    session.lastPauseMessage ||
    session.lastErrorMessage ||
    pendingQueueEntries(queue, session).length === 0
  ) {
    return false;
  }

  session = await markManagerSessionStartedForPendingQueue(dir, session, queue);
  if (session.status === 'not-started') {
    return false;
  }

  void processNextQueued(dir, resolvedDir);
  return true;
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
  await clearManagerRuntimePause(dir);
  await reconcileActiveAssignments(dir);
  await recoverCanonicalThreadState(dir);
  startStaleSeedRecoveryMonitor(dir);
  void processNextQueued(dir, resolvePath(dir));
  return { started: true, detail: 'ビルトインマネージャーを起動しました' };
}

/**
 * Periodically re-examines every managed dir whose threads carry a
 * stale `seedRecoveryPending` flag. Idempotent per dir: if a monitor
 * is already running we don't start a second one. Timers are unref'd
 * so they never block process exit.
 */
function startStaleSeedRecoveryMonitor(dir: string): void {
  const resolvedDir = resolvePath(dir);
  if (staleSeedRecoveryMonitors.has(resolvedDir)) {
    return;
  }
  const intervalMs = managerStaleSeedRecoveryIntervalMs();
  const timer = setInterval(() => {
    void (async () => {
      try {
        const result = await reviewStaleSeedRecoveryForDir(resolvedDir);
        if (result.cleared > 0) {
          await recoverCanonicalThreadState(dir);
        }
      } catch (error) {
        console.warn(
          `[manager-backend] periodic stale seed-recovery review failed for ${resolvedDir}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })();
  }, intervalMs);
  timer.unref?.();
  staleSeedRecoveryMonitors.set(resolvedDir, timer);
}

/** Test-only helper: stop every stale-seed-recovery monitor. */
export function resetStaleSeedRecoveryMonitorsForTests(): void {
  for (const timer of staleSeedRecoveryMonitors.values()) {
    clearInterval(timer);
  }
  staleSeedRecoveryMonitors.clear();
}

/**
 * Test-only helper: run a single stale-seed-recovery review pass
 * against `dir` without waiting for the periodic timer.
 */
export async function reviewStaleSeedRecoveryForTests(dir: string): Promise<{
  cleared: number;
}> {
  const result = await reviewStaleSeedRecoveryForDir(dir);
  if (result.cleared > 0) {
    await recoverCanonicalThreadState(dir);
  }
  return result;
}

export async function sendToBuiltinManager(
  dir: string,
  threadId: string,
  content: string,
  options?: {
    dispatchMode?: 'direct-worker' | 'manager-evaluate';
    targetKind?: ManagerTargetKind | null;
    repoId?: string | null;
    newRepoName?: string | null;
    workingDirectory?: string | null;
    writeScopes?: string[];
    targetRepoRoot?: string | null;
    requestedRunMode?: ManagerRunMode | null;
    requestedWorkerRuntime?: ManagerWorkerRuntime | null;
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
  await clearManagerRuntimePause(dir);
  await enqueueMessage(dir, threadId, content, options);
  void processNextQueued(dir, resolvePath(dir));
}
