/**
 * Built-in Manager backend for Workspace Agent Hub.
 *
 * Uses the Claude CLI directly (`claude -p ...`) to handle manager conversations.
 * Maintains per-workspace state in two workspace-local files (not committed):
 *
 *   .workspace-agent-hub-manager.json        — session state (idle/busy, session ID, PID)
 *   .workspace-agent-hub-manager-queue.jsonl — persistent message queue
 *
 * Key design rules:
 *  - One Claude conversation session per workspace, resumed via --resume <sessionId>
 *  - Messages are processed serially; concurrent arrivals are queued and flushed in order
 *  - On server restart, a stale PID is detected and the queue resumes automatically
 *  - No external npm dependencies — only the `claude` CLI in PATH is required
 *  - Requires: Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
 */

import { spawn } from 'child_process';
import { readFile, writeFile, appendFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve as resolvePath } from 'path';
import { addMessage } from '@metyatech/thread-inbox';

export const MANAGER_SESSION_FILE = '.workspace-agent-hub-manager.json';
export const MANAGER_QUEUE_FILE = '.workspace-agent-hub-manager-queue.jsonl';

/** Default model per workspace rules: Claude Sonnet 4.6, medium effort. */
export const MANAGER_MODEL = 'claude-sonnet-4-6';

/**
 * Status applied to successful manager replies.
 * Must be 'active' so replies land in the 返事が来ています bucket (status=active + last sender=ai).
 * Error replies stay 'needs-reply' to indicate user action is required.
 */
export const MANAGER_REPLY_STATUS = 'active' as const;

/**
 * System context embedded in the first message of a new session.
 * Follow-up messages use --resume and omit this prefix.
 */
const MANAGER_SYSTEM_PROMPT =
  'You are a manager AI assistant for this software workspace. ' +
  'Help coordinate work across multiple threads. ' +
  'When given a thread message, provide a brief, actionable response (2-4 sentences). ' +
  'Keep context across messages; reference prior discussion when relevant.';

export interface ManagerSession {
  workspaceKey: string;
  /** idle: ready to process; busy: currently running; not-started: never initialised */
  status: 'idle' | 'busy' | 'not-started';
  /** Claude session ID used with --resume for conversation continuity */
  sessionId: string | null;
  /** PID of the currently running claude process, or null */
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

/**
 * Returns the claude command name used for spawning.
 *
 * Always returns `'claude'` — Node.js spawn with shell: false (the default) resolves
 * executables via OS PATHEXT/PATH on all platforms, so whether the installation is a
 * plain `claude.exe` or a wrapper, `'claude'` is found correctly.
 *
 * Using `shell: false` (no concatenation) is critical: with `shell: true` the args
 * array is joined into a single command string and the shell (cmd.exe on Windows)
 * splits on whitespace, causing prompts like "Final runtime check." to be received
 * by Claude as just "Final".  With `shell: false` each array element is passed as
 * a distinct quoted token, preserving full prompt content.
 */
export function resolveClaudeCommand(): string {
  return 'claude';
}

/**
 * Build the CLI args for invoking `claude -p`.
 *
 * --verbose is required when combining --print (-p) with --output-format stream-json;
 * omitting it produces: "Error: When using --print, --output-format=stream-json requires --verbose"
 */
export function buildClaudeArgs(
  prompt: string,
  sessionId: string | null
): string[] {
  const args: string[] = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    MANAGER_MODEL,
  ];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  return args;
}

/**
 * Build the prompt for claude.
 * First turn: include system context + workspace path.
 * Subsequent turns: just the message (claude retains context via --resume).
 */
export function buildClaudePrompt(
  content: string,
  threadId: string,
  resolvedDir: string,
  isFirstTurn: boolean
): string {
  if (!isFirstTurn) {
    return `[Thread: ${threadId}]\n${content}`;
  }
  return `${MANAGER_SYSTEM_PROMPT}\n\nWorkspace: ${resolvedDir}\n\n[Thread: ${threadId}]\n${content}`;
}

/**
 * Parse claude --output-format stream-json output.
 * Returns the final text reply and the session ID (for future --resume calls).
 */
export function parseClaudeOutput(stdout: string): {
  text: string;
  sessionId: string | null;
} {
  let sessionId: string | null = null;
  const lines = stdout.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj['type'] === 'result' && typeof obj['result'] === 'string') {
        const sid = obj['session_id'];
        if (typeof sid === 'string') sessionId = sid;
        return { text: (obj['result'] as string).trim(), sessionId };
      }
      if (obj['type'] === 'system' && typeof obj['session_id'] === 'string') {
        sessionId = obj['session_id'] as string;
      }
    } catch {
      // Not JSON — skip
    }
  }

  // Fallback: collect non-JSON lines as plain text
  const textLines = lines.filter((l) => {
    try {
      JSON.parse(l);
      return false;
    } catch {
      return true;
    }
  });
  return { text: textLines.join('\n').trim(), sessionId };
}

/**
 * Returns true when stderr output indicates the Claude session ID is no longer
 * valid, so the next attempt should start a fresh session instead of retrying
 * --resume with the stale ID.
 */
export function isSessionInvalidError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    (s.includes('session') &&
      (s.includes('not found') ||
        s.includes('invalid') ||
        s.includes('expired') ||
        s.includes('does not exist'))) ||
    s.includes('no such session') ||
    (s.includes('--resume') && s.includes('error'))
  );
}

// Per-workspace in-flight guard (module-level singleton, safe for single server process).
const inFlight = new Set<string>();

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

  inFlight.add(resolvedDir);

  // Mark session as busy before spawning
  const freshSession = await readSession(dir);
  await writeSession(dir, {
    ...freshSession,
    status: 'busy',
    currentQueueId: next.id,
    lastMessageAt: new Date().toISOString(),
  });

  const isFirstTurn = freshSession.sessionId === null;
  const prompt = buildClaudePrompt(
    next.content,
    next.threadId,
    resolvedDir,
    isFirstTurn
  );

  const args = buildClaudeArgs(prompt, freshSession.sessionId);

  // Always spawn `claude` with shell: false so Node passes each argv element
  // separately instead of concatenating them through a shell command string.
  // This preserves full prompt content with spaces/newlines on Windows too.
  const proc = spawn(resolveClaudeCommand(), args, {
    cwd: resolvedDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Persist PID so recovery works after a server crash
  if (proc.pid) {
    const withPid = await readSession(dir);
    await writeSession(dir, { ...withPid, pid: proc.pid });
  }

  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const finish = async (code: number | null): Promise<void> => {
    inFlight.delete(resolvedDir);
    try {
      // Remove the processed entry from the queue (compaction).
      // This keeps the queue file bounded — only unprocessed entries are retained.
      await updateQueueLocked(dir, (q) => q.filter((e) => e.id !== next.id));

      const currentSession = await readSession(dir);

      if (code === 0 && stdout.trim()) {
        const { text, sessionId: newSessionId } = parseClaudeOutput(stdout);
        if (text) {
          await addMessage(
            resolvedDir,
            next.threadId,
            text,
            'ai',
            MANAGER_REPLY_STATUS
          );
        }
        await writeSession(dir, {
          ...currentSession,
          status: 'idle',
          sessionId: newSessionId ?? currentSession.sessionId,
          pid: null,
          currentQueueId: null,
        });
      } else {
        const errDetail = stderr ? `\n${stderr.slice(0, 300)}` : '';
        const errMsg = `[Manager error] claude CLI exited with code ${code ?? '?'}.${errDetail}`;
        try {
          await addMessage(
            resolvedDir,
            next.threadId,
            errMsg,
            'ai',
            'needs-reply'
          );
        } catch {
          /* thread may have been deleted */
        }
        // Reset sessionId if the error looks like an invalid/expired session so the
        // next attempt starts a fresh conversation instead of retrying --resume.
        const resetSession = isSessionInvalidError(stderr);
        await writeSession(dir, {
          ...currentSession,
          status: 'idle',
          pid: null,
          currentQueueId: null,
          ...(resetSession ? { sessionId: null } : {}),
        });
      }
    } catch (err) {
      console.error('[manager-backend] finish handler error:', err);
      inFlight.delete(resolvedDir);
      try {
        const s = await readSession(dir);
        await writeSession(dir, {
          ...s,
          status: 'idle',
          pid: null,
          currentQueueId: null,
        });
      } catch {
        /* ignore */
      }
    }
    // Tail-call to flush remaining queue entries
    void processNextQueued(dir, resolvedDir);
  };

  proc.on('close', (code) => {
    void finish(code);
  });

  proc.on('error', async (err: NodeJS.ErrnoException) => {
    inFlight.delete(resolvedDir);
    console.error('[manager-backend] spawn error:', err.message);

    // Remove entry from queue to prevent infinite retry on permanent spawn errors.
    await updateQueueLocked(dir, (q) => q.filter((e) => e.id !== next.id));

    const notFoundMsg =
      err.code === 'ENOENT'
        ? '[Manager error] `claude` CLI not found in PATH. Install Claude Code to use the built-in manager backend.'
        : `[Manager error] Failed to start claude: ${err.message}`;
    try {
      await addMessage(
        resolvedDir,
        next.threadId,
        notFoundMsg,
        'ai',
        'needs-reply'
      );
    } catch {
      /* ignore */
    }

    const s = await readSession(dir);
    await writeSession(dir, {
      ...s,
      status: 'idle',
      pid: null,
      currentQueueId: null,
    });
    void processNextQueued(dir, resolvedDir);
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

  if (session.status === 'not-started') {
    return {
      running: false,
      configured: true,
      builtinBackend: true,
      detail: '未起動 — メッセージ送信で自動起動します',
    };
  }

  const queue = await readQueue(dir);
  const pending = queue.filter((e) => !e.processed).length;
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
