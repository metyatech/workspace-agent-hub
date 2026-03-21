/**
 * Built-in Manager backend for Workspace Agent Hub.
 *
 * Uses the Codex CLI directly (`codex exec ...`) to handle manager conversations.
 * Maintains per-workspace state in two workspace-local files (not committed):
 *
 *   .workspace-agent-hub-manager.json        — session state (idle/busy, session ID, PID)
 *   .workspace-agent-hub-manager-queue.jsonl — persistent message queue
 *
 * Key design rules:
 *  - One Codex thread per workspace, resumed via `codex exec resume <sessionId>`
 *  - Messages are processed serially; concurrent arrivals are queued and flushed in order
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
  updateManagerThreadMeta,
} from './manager-thread-state.js';

export const MANAGER_SESSION_FILE = '.workspace-agent-hub-manager.json';
export const MANAGER_QUEUE_FILE = '.workspace-agent-hub-manager-queue.jsonl';

/** Manager backend target: Codex GPT-5.4 at xhigh reasoning effort. */
export const MANAGER_MODEL = 'gpt-5.4';
export const MANAGER_REASONING_EFFORT = 'xhigh';

/**
 * Status applied to successful manager replies.
 * Must be 'active' so replies land in the 返事が来ています bucket (status=active + last sender=ai).
 * Error replies stay 'needs-reply' to indicate user action is required.
 */
export const MANAGER_REPLY_STATUS = 'review' as const;

/**
 * System context embedded in the first message of a new session.
 * Follow-up messages use --resume and omit this prefix.
 */
const MANAGER_SYSTEM_PROMPT =
  'You are a manager AI assistant for this software workspace. ' +
  'Help coordinate work across multiple threads. ' +
  'When given a thread message, provide a brief, actionable response (2-4 sentences). ' +
  'Keep context across messages; reference prior discussion when relevant.';

const MANAGER_REPLY_JSON_RULES =
  'Return only strict JSON with keys {"status","reply"}. ' +
  'Use status "review" when you believe the answer or work result is ready for the user to review. ' +
  'Use status "needs-reply" only when you truly need user input before you can continue. ' +
  'Do not wrap JSON in markdown fences.';

const MANAGER_ROUTING_JSON_RULES =
  'Return only strict JSON in the form {"actions":[...]}. ' +
  'Each action must have kind "attach-existing", "create-new", "routing-confirmation", or "resolve-existing". ' +
  'For "attach-existing" and "resolve-existing", include threadId and content. ' +
  'For "create-new", include title and content. ' +
  'For "routing-confirmation", include title, content, question, and reason. ' +
  'Split confident intents immediately and leave only the ambiguous parts for confirmation. ' +
  'Do not wrap JSON in markdown fences.';

export interface ManagerReplyPayload {
  status: Extract<ThreadStatus, 'review' | 'needs-reply'>;
  reply: string;
}

export interface ManagerRoutingAction {
  kind:
    | 'attach-existing'
    | 'create-new'
    | 'routing-confirmation'
    | 'resolve-existing';
  threadId?: string;
  title?: string;
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
  /** Codex thread ID used with `codex exec resume` for conversation continuity */
  sessionId: string | null;
  /** Separate Codex thread ID for freeform global routing decisions. */
  routingSessionId: string | null;
  /** PID of the currently running codex process, or null */
  pid: number | null;
  /** Queue entry ID currently being processed */
  currentQueueId: string | null;
  startedAt: string | null;
  lastMessageAt: string | null;
}

export interface QueueEntry {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
  processed: boolean;
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
    return { ...makeDefaultSession(dir), ...parsed };
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
  await withWriteLock(key, () =>
    atomicWrite(filePath, JSON.stringify(session, null, 2))
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
          return [JSON.parse(line) as QueueEntry];
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
}

/** Append one message to the queue file and return its generated ID. */
export async function enqueueMessage(
  dir: string,
  threadId: string,
  content: string
): Promise<string> {
  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entry: QueueEntry = {
    id,
    threadId,
    content,
    createdAt: new Date().toISOString(),
    processed: false,
  };
  // Serialise via the queue lock so concurrent enqueue + writeQueue cannot interleave
  // and cause a full rewrite to overwrite an in-flight append.
  const key = `queue:${resolvePath(dir)}`;
  await withWriteLock(key, () =>
    appendFile(queueFilePath(dir), JSON.stringify(entry) + '\n', 'utf-8')
  );
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
  sessionId: string | null
): string[] {
  const args: string[] = sessionId ? ['exec', 'resume', sessionId] : ['exec'];

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
export function buildCodexPrompt(
  content: string,
  threadId: string,
  resolvedDir: string,
  isFirstTurn: boolean
): string {
  if (!isFirstTurn) {
    return `[Thread: ${threadId}]\n${MANAGER_REPLY_JSON_RULES}\n\n${content}`;
  }
  return `${MANAGER_SYSTEM_PROMPT}\n${MANAGER_REPLY_JSON_RULES}\n\nWorkspace: ${resolvedDir}\n\n[Thread: ${threadId}]\n${content}`;
}

function buildRoutingPrompt(input: {
  content: string;
  resolvedDir: string;
  threads: Thread[];
  contextThreadId?: string | null;
  isFirstTurn: boolean;
}): string {
  const threadSummary =
    input.threads.length === 0
      ? 'No existing open topics.'
      : input.threads
          .slice(0, 40)
          .map((thread) => {
            const last = thread.messages.at(-1);
            const preview = last
              ? `${last.sender}: ${last.content.replace(/\s+/g, ' ').slice(0, 140)}`
              : 'no messages yet';
            return [
              `- id: ${thread.id}`,
              `  title: ${thread.title}`,
              `  status: ${thread.status}`,
              `  updatedAt: ${thread.updatedAt}`,
              `  preview: ${preview}`,
            ].join('\n');
          })
          .join('\n');

  const contextBlock = input.contextThreadId
    ? `Current open thread preferred context: ${input.contextThreadId}`
    : 'No current open thread context.';

  const body = [
    'Route the following freeform manager message into workspace topics.',
    MANAGER_ROUTING_JSON_RULES,
    `Workspace: ${input.resolvedDir}`,
    contextBlock,
    'Existing open topics:',
    threadSummary,
    'User message:',
    input.content,
  ].join('\n\n');

  if (!input.isFirstTurn) {
    return body;
  }

  return `${MANAGER_SYSTEM_PROMPT}\n${body}`;
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

export function parseManagerReplyPayload(
  text: string
): ManagerReplyPayload | null {
  const normalized = stripMarkdownCodeFence(text);
  try {
    const parsed = JSON.parse(normalized) as Partial<ManagerReplyPayload>;
    const status =
      parsed.status === 'needs-reply' || parsed.status === 'review'
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
          threadId:
            typeof action.threadId === 'string'
              ? action.threadId.trim()
              : undefined,
          title:
            typeof action.title === 'string' ? action.title.trim() : undefined,
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

async function runCodexTurn(input: {
  dir: string;
  resolvedDir: string;
  prompt: string;
  sessionId: string | null;
  onSpawn?: (pid: number | null) => void | Promise<void>;
}): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  parsed: { text: string; sessionId: string | null };
}> {
  const codexCommand = resolveCodexCommand();
  const args = buildCodexArgs(input.prompt, input.sessionId);
  const spawnSpec = buildCodexSpawnSpec(codexCommand, args, input.resolvedDir);
  const proc = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.spawnOptions);
  await input.onSpawn?.(proc.pid ?? null);

  let stdout = '';
  let stderr = '';

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
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

  return {
    code: exitCode,
    stdout,
    stderr,
    parsed: parseCodexOutput(stdout),
  };
}

// Per-workspace in-flight guard (module-level singleton, safe for single server process).
const inFlight = new Set<string>();
const routingLocks = new Map<string, Promise<void>>();

function makeFallbackThreadTitle(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
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

/**
 * Process the next unprocessed queue entry for the given workspace.
 * No-op if already in flight or nothing is queued.
 * Safe to call concurrently — the in-flight guard prevents duplicate spawns.
 */
export async function processNextQueued(
  dir: string,
  resolvedDir: string
): Promise<void> {
  if (inFlight.has(resolvedDir)) return;
  inFlight.add(resolvedDir);
  let shouldContinue = false;

  try {
    const session = await readSession(dir);

    // Recovery: PID died without cleanup → reset to idle so queue can resume
    if (
      session.status === 'busy' &&
      session.pid !== null &&
      !isPidAlive(session.pid)
    ) {
      await writeSession(dir, {
        ...session,
        status: 'idle',
        pid: null,
        currentQueueId: null,
      });
    } else if (session.status === 'busy') {
      return; // Genuinely still running
    }

    const queue = await readQueue(dir);
    const next = queue.find((e) => !e.processed);
    if (!next) return;

    // Mark session as busy before spawning
    const freshSession = await readSession(dir);
    await writeSession(dir, {
      ...freshSession,
      status: 'busy',
      currentQueueId: next.id,
      lastMessageAt: new Date().toISOString(),
    });

    const isFirstTurn = freshSession.sessionId === null;
    const prompt = buildCodexPrompt(
      next.content,
      next.threadId,
      resolvedDir,
      isFirstTurn
    );

    let runResult: {
      code: number | null;
      stdout: string;
      stderr: string;
      parsed: { text: string; sessionId: string | null };
    } | null = null;

    try {
      runResult = await runCodexTurn({
        dir,
        resolvedDir,
        prompt,
        sessionId: freshSession.sessionId,
        onSpawn: async (pid) => {
          const withPid = await readSession(dir);
          await writeSession(dir, { ...withPid, pid });
        },
      });
    } catch (error) {
      console.error(
        '[manager-backend] spawn error:',
        error instanceof Error ? error.message : String(error)
      );

      await updateQueueLocked(dir, (q) =>
        q.filter((entry) => entry.id !== next.id)
      );

      const notFoundMsg =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? '[Manager error] `codex` CLI not found in PATH. Install Codex CLI to use the built-in manager backend.'
          : `[Manager error] Failed to start codex: ${error instanceof Error ? error.message : String(error)}`;
      try {
        await addMessage(
          resolvedDir,
          next.threadId,
          notFoundMsg,
          'ai',
          'needs-reply'
        );
      } catch {
        /* thread may have been deleted */
      }

      const current = await readSession(dir);
      await writeSession(dir, {
        ...current,
        status: 'idle',
        pid: null,
        currentQueueId: null,
      });
      return;
    }

    const currentSession = await readSession(dir);
    const combinedOutput = `${runResult.stdout}\n${runResult.stderr}`;
    const parsedReply = parseManagerReplyPayload(runResult.parsed.text);

    if (runResult.code === 0 && parsedReply) {
      await updateQueueLocked(dir, (q) =>
        q.filter((entry) => entry.id !== next.id)
      );
      try {
        await clearManagerThreadMeta(resolvedDir, next.threadId);
        await addMessage(
          resolvedDir,
          next.threadId,
          parsedReply.reply,
          'ai',
          parsedReply.status
        );
      } catch {
        /* thread may have been deleted */
      }
      await writeSession(dir, {
        ...currentSession,
        status: 'idle',
        sessionId: runResult.parsed.sessionId ?? currentSession.sessionId,
        pid: null,
        currentQueueId: null,
      });
      shouldContinue = true;
      return;
    }

    if (runResult.code === 0 && runResult.parsed.text) {
      await updateQueueLocked(dir, (q) =>
        q.filter((entry) => entry.id !== next.id)
      );
      try {
        await clearManagerThreadMeta(resolvedDir, next.threadId);
        await addMessage(
          resolvedDir,
          next.threadId,
          runResult.parsed.text,
          'ai',
          MANAGER_REPLY_STATUS
        );
      } catch {
        /* thread may have been deleted */
      }
      await writeSession(dir, {
        ...currentSession,
        status: 'idle',
        sessionId: runResult.parsed.sessionId ?? currentSession.sessionId,
        pid: null,
        currentQueueId: null,
      });
      shouldContinue = true;
      return;
    }

    const errMsg =
      runResult.code === 0
        ? '[Manager error] codex finished successfully but no usable assistant reply could be parsed from the JSON output.'
        : `[Manager error] codex CLI exited with code ${runResult.code ?? '?'}.${runResult.stderr ? `\n${runResult.stderr.slice(0, 300)}` : ''}`;

    try {
      await addMessage(resolvedDir, next.threadId, errMsg, 'ai', 'needs-reply');
    } catch {
      /* thread may have been deleted */
    }
    await updateQueueLocked(dir, (q) =>
      q.filter((entry) => entry.id !== next.id)
    );
    await writeSession(dir, {
      ...currentSession,
      status: 'idle',
      sessionId: isSessionInvalidError(combinedOutput)
        ? null
        : (runResult.parsed.sessionId ?? currentSession.sessionId),
      pid: null,
      currentQueueId: null,
    });
    shouldContinue = true;
  } catch (err) {
    console.error('[manager-backend] processNextQueued error:', err);
  } finally {
    inFlight.delete(resolvedDir);
    if (shouldContinue) {
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
  routingSessionId: string | null;
}> {
  const openThreads = (await listThreads(input.dir)).filter(
    (thread) => thread.status !== 'resolved'
  );
  const session = await readSession(input.dir);
  const prompt = buildRoutingPrompt({
    content: input.content,
    resolvedDir: input.resolvedDir,
    threads: openThreads,
    contextThreadId: input.contextThreadId,
    isFirstTurn: session.routingSessionId === null,
  });
  const runResult = await runCodexTurn({
    dir: input.dir,
    resolvedDir: input.resolvedDir,
    prompt,
    sessionId: session.routingSessionId,
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
      routingSessionId: runResult.parsed.sessionId ?? session.routingSessionId,
    };
  }

  return {
    plan: parsedPlan,
    routingSessionId: runResult.parsed.sessionId ?? session.routingSessionId,
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

    const { plan, routingSessionId } = await routeFreeformMessage({
      dir,
      resolvedDir,
      content,
      contextThreadId: options?.contextThreadId ?? null,
    });

    const refreshedSession = await readSession(dir);
    await writeSession(dir, {
      ...refreshedSession,
      routingSessionId,
      lastMessageAt: new Date().toISOString(),
    });

    const items: ManagerRoutingSummaryItem[] = [];
    let routedCount = 0;
    let ambiguousCount = 0;

    for (const action of plan.actions) {
      switch (action.kind) {
        case 'attach-existing': {
          if (!action.threadId) {
            break;
          }
          await ensureThreadReadyForUserMessage(dir, action.threadId);
          await clearManagerThreadMeta(resolvedDir, action.threadId);
          await addMessage(
            resolvedDir,
            action.threadId,
            action.content,
            'user',
            'waiting'
          );
          await sendToBuiltinManager(
            resolvedDir,
            action.threadId,
            action.content
          );
          const existingThread = await getThread(dir, action.threadId);
          items.push({
            threadId: action.threadId,
            title: existingThread?.title ?? action.threadId,
            outcome: 'attached-existing',
            reason: action.reason ?? '既存の話題の続きとして扱いました。',
          });
          routedCount += 1;
          break;
        }

        case 'create-new': {
          const createdThread = await createThread(
            resolvedDir,
            action.title?.trim() || makeFallbackThreadTitle(action.content)
          );
          await addMessage(
            resolvedDir,
            createdThread.id,
            action.content,
            'user',
            'waiting'
          );
          await clearManagerThreadMeta(resolvedDir, createdThread.id);
          await sendToBuiltinManager(
            resolvedDir,
            createdThread.id,
            action.content
          );
          items.push({
            threadId: createdThread.id,
            title: createdThread.title,
            outcome: 'created-new',
            reason: action.reason ?? '新しい話題を作って受け付けました。',
          });
          routedCount += 1;
          break;
        }

        case 'routing-confirmation': {
          const confirmationThread = await createThread(
            resolvedDir,
            action.title?.trim() || makeFallbackThreadTitle(action.content)
          );
          await addMessage(
            resolvedDir,
            confirmationThread.id,
            action.content,
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
          await ensureThreadReadyForUserMessage(dir, action.threadId);
          await addMessage(
            resolvedDir,
            action.threadId,
            action.content,
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
      detailParts.push(`${routedCount}件を処理しました`);
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
  detail: string;
}> {
  const session = await readSession(dir);
  const queue = await readQueue(dir);
  const pending = queue.filter((e) => !e.processed).length;

  if (session.status === 'busy') {
    const alive = session.pid !== null && isPidAlive(session.pid);
    if (alive) {
      return {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: `処理中 (PID ${session.pid})`,
      };
    }
    // Stale PID — reset
    await writeSession(dir, {
      ...session,
      status: 'idle',
      pid: null,
      currentQueueId: null,
    });
  }

  if (pending > 0) {
    const latestSession = await readSession(dir);
    if (latestSession.status === 'not-started') {
      await writeSession(dir, {
        ...latestSession,
        status: 'idle',
        startedAt: latestSession.startedAt ?? new Date().toISOString(),
      });
    }
    void processNextQueued(dir, resolvePath(dir));
  }

  if (session.status === 'not-started' && pending === 0) {
    return {
      running: false,
      configured: true,
      builtinBackend: true,
      detail: '未起動 — メッセージ送信で自動起動します',
    };
  }

  return {
    running: true,
    configured: true,
    builtinBackend: true,
    detail: pending > 0 ? `待機中 (キュー: ${pending}件)` : '待機中',
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
  content: string
): Promise<void> {
  const session = await readSession(dir);
  if (session.status === 'not-started') {
    await writeSession(dir, {
      ...session,
      status: 'idle',
      startedAt: new Date().toISOString(),
    });
  }
  await enqueueMessage(dir, threadId, content);
  void processNextQueued(dir, resolvePath(dir));
}
