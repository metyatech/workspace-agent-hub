import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addMessage,
  createThread,
  getThread,
  listThreads,
  purgeThreads,
  reopenThread,
  resolveThread,
  type ThreadStatus,
} from '@metyatech/thread-inbox';
import {
  getBuiltinManagerStatus,
  preserveSeedRecoveryAndContinue,
  readQueue,
  readSession,
  sendGlobalToBuiltinManager,
  sendThreadFollowUpToBuiltinManager,
  startBuiltinManager,
} from './manager-backend.js';
import { readActiveTasks } from './manager-tasks.js';
import {
  deriveManagerThreadViews,
  reconcileManagerThreadMeta,
  readManagerThreadMeta,
  updateManagerThreadMeta,
} from './manager-thread-state.js';
import {
  notifyManagerUpdate,
  subscribeManagerUpdates,
} from './manager-live-updates.js';
import { isWebUiAuthorized, type WebUiAuthConfig } from './web-auth.js';
import { activeSseConnections } from './sse-connections.js';
import {
  getGitInfo,
  listBuilds,
  resolvePackageRoot,
  restoreBuild,
} from './build-archive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const markedPackageJsonPath = require.resolve('marked/package.json');
const markedBrowserModulePath = join(
  dirname(markedPackageJsonPath),
  'lib',
  'marked.esm.js'
);

const VALID_THREAD_STATUSES = new Set<ThreadStatus>([
  'waiting',
  'needs-reply',
  'review',
  'active',
  'resolved',
]);

function getAssetCandidates(fileName: string, baseDir = __dirname): string[] {
  return [
    join(baseDir, 'public', fileName),
    join(baseDir, '..', 'public', fileName),
    join(baseDir, '..', 'dist', 'public', fileName),
  ];
}

function getAssetPath(fileName: string): string {
  for (const candidate of getAssetCandidates(fileName)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not find ${fileName}.`);
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolvePromise(
          body ? (JSON.parse(body) as Record<string, unknown>) : {}
        );
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendText(
  res: ServerResponse,
  text: string,
  status = 200,
  contentType = 'text/plain; charset=utf-8'
): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(text);
}

function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

interface ManagerLiveSnapshot {
  kind: 'snapshot';
  emittedAt: string;
  threads: ReturnType<typeof deriveManagerThreadViews>;
  tasks: Awaited<ReturnType<typeof readActiveTasks>>;
  status: Awaited<ReturnType<typeof getBuiltinManagerStatus>>;
}

interface ManagerLiveSnapshotCacheEntry {
  snapshot: ManagerLiveSnapshot | null;
  refreshPromise: Promise<ManagerLiveSnapshot> | null;
  subscriberCount: number;
}

const managerLiveSnapshotCache = new Map<
  string,
  ManagerLiveSnapshotCacheEntry
>();

function sendUnauthorized(res: ServerResponse): void {
  sendJson(
    res,
    {
      error: 'Access code required',
      authRequired: true,
    },
    401
  );
}

function injectManagerHtml(
  html: string,
  input: {
    workspaceRoot: string;
    authConfig: Pick<WebUiAuthConfig, 'required' | 'storageKey'>;
    documentBasePath: string;
  }
): string {
  return html
    .replace('__MANAGER_DOCUMENT_BASE__', input.documentBasePath)
    .replace('__GUI_DIR__', JSON.stringify(resolvePath(input.workspaceRoot)))
    .replace(
      '__MANAGER_AUTH_REQUIRED__',
      input.authConfig.required ? 'true' : 'false'
    )
    .replace(
      '__MANAGER_AUTH_STORAGE_KEY__',
      JSON.stringify(input.authConfig.storageKey)
    );
}

function normalizeManagerPath(pathname: string): string {
  if (pathname === '/manager' || pathname === '/manager/') {
    return '/';
  }
  const suffix = pathname.slice('/manager'.length);
  return suffix.startsWith('/') ? suffix : `/${suffix}`;
}

async function buildManagerLiveSnapshot(
  workspaceRoot: string
): Promise<ManagerLiveSnapshot> {
  const [threads, session, queue, rawMeta, tasks] = await Promise.all([
    listThreads(workspaceRoot),
    readSession(workspaceRoot),
    readQueue(workspaceRoot),
    readManagerThreadMeta(workspaceRoot),
    readActiveTasks(workspaceRoot),
  ]);
  const meta = await reconcileManagerThreadMeta({
    dir: workspaceRoot,
    threads,
    session,
    queue,
    meta: rawMeta,
  });
  const status = deriveManagerStatusSnapshot({
    threads,
    session,
    queue,
  });

  return {
    kind: 'snapshot',
    emittedAt: new Date().toISOString(),
    threads: deriveManagerThreadViews({
      threads,
      session,
      queue,
      meta,
    }),
    tasks,
    status,
  };
}

function deriveManagerStatusSnapshot(input: {
  threads: Awaited<ReturnType<typeof listThreads>>;
  session: Awaited<ReturnType<typeof readSession>>;
  queue: Awaited<ReturnType<typeof readQueue>>;
}): Awaited<ReturnType<typeof getBuiltinManagerStatus>> {
  const activeQueueIds = new Set(
    input.session.activeAssignments.flatMap(
      (assignment) => assignment.queueEntryIds
    )
  );
  const dispatchingQueueIds = new Set(
    input.session.dispatchingQueueEntryIds ?? []
  );
  const pending = input.queue.filter(
    (entry) =>
      !entry.processed &&
      !activeQueueIds.has(entry.id) &&
      !dispatchingQueueIds.has(entry.id)
  ).length;
  const currentAssignment = input.session.activeAssignments[0] ?? null;
  const currentThread =
    currentAssignment === null
      ? null
      : (input.threads.find(
          (thread) => thread.id === currentAssignment.threadId
        ) ?? null);

  if (input.session.activeAssignments.length > 0) {
    return {
      running: true,
      configured: true,
      builtinBackend: true,
      health: 'ok',
      detail:
        input.session.activeAssignments.length === 1
          ? currentThread
            ? `処理中 (${currentThread.title})`
            : '処理中'
          : `処理中 (${input.session.activeAssignments.length}件)`,
      pendingCount: pending,
      currentQueueId: currentAssignment?.queueEntryIds[0] ?? null,
      currentThreadId: currentAssignment?.threadId ?? null,
      currentThreadTitle: currentThread?.title ?? null,
      errorMessage: null,
      errorAt: null,
    };
  }

  if (input.session.dispatchingThreadId) {
    const dispatchingThread =
      input.threads.find(
        (thread) => thread.id === input.session.dispatchingThreadId
      ) ?? null;
    const dispatchingLabel =
      dispatchingThread?.title ?? input.session.dispatchingThreadId;
    return {
      running: true,
      configured: true,
      builtinBackend: true,
      health: 'ok',
      detail: dispatchingLabel
        ? `処理開始中 (${dispatchingLabel})`
        : '処理開始中',
      pendingCount: pending,
      currentQueueId: input.session.dispatchingQueueEntryIds?.[0] ?? null,
      currentThreadId: input.session.dispatchingThreadId,
      currentThreadTitle: dispatchingThread?.title ?? null,
      errorMessage: null,
      errorAt: null,
    };
  }

  if (pending > 0) {
    if (input.session.lastPauseMessage) {
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
        errorMessage: input.session.lastPauseMessage,
        errorAt: input.session.lastPauseAt,
      };
    }
    if (input.session.lastErrorMessage) {
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
        errorMessage: input.session.lastErrorMessage,
        errorAt: input.session.lastErrorAt,
      };
    }
  }

  if (input.session.status === 'not-started' && pending === 0) {
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

  if (input.session.lastPauseMessage) {
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
      errorMessage: input.session.lastPauseMessage,
      errorAt: input.session.lastPauseAt,
    };
  }

  if (input.session.lastErrorMessage) {
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
      errorMessage: input.session.lastErrorMessage,
      errorAt: input.session.lastErrorAt,
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

async function readDirectManagerStatus(
  workspaceRoot: string
): Promise<ManagerLiveSnapshot['status']> {
  const [threads, session, queue] = await Promise.all([
    listThreads(workspaceRoot),
    readSession(workspaceRoot),
    readQueue(workspaceRoot),
  ]);
  return deriveManagerStatusSnapshot({
    threads,
    session,
    queue,
  });
}

function getOrCreateManagerLiveSnapshotCacheEntry(
  workspaceRoot: string
): ManagerLiveSnapshotCacheEntry {
  const key = resolvePath(workspaceRoot);
  const existing = managerLiveSnapshotCache.get(key);
  if (existing) {
    return existing;
  }
  const created: ManagerLiveSnapshotCacheEntry = {
    snapshot: null,
    refreshPromise: null,
    subscriberCount: 0,
  };
  managerLiveSnapshotCache.set(key, created);
  return created;
}

async function refreshManagerLiveSnapshot(
  workspaceRoot: string
): Promise<ManagerLiveSnapshot> {
  const resolvedRoot = resolvePath(workspaceRoot);
  const cacheEntry = getOrCreateManagerLiveSnapshotCacheEntry(resolvedRoot);
  if (cacheEntry.refreshPromise) {
    return cacheEntry.refreshPromise;
  }

  const refreshPromise = buildManagerLiveSnapshot(resolvedRoot)
    .then((snapshot) => {
      cacheEntry.snapshot = snapshot;
      return snapshot;
    })
    .finally(() => {
      if (cacheEntry.refreshPromise === refreshPromise) {
        cacheEntry.refreshPromise = null;
      }
    });
  cacheEntry.refreshPromise = refreshPromise;
  return refreshPromise;
}

async function readManagerLiveSnapshot(
  workspaceRoot: string
): Promise<ManagerLiveSnapshot> {
  const cacheEntry = getOrCreateManagerLiveSnapshotCacheEntry(workspaceRoot);
  if (cacheEntry.snapshot && cacheEntry.subscriberCount > 0) {
    return cacheEntry.snapshot;
  }
  return refreshManagerLiveSnapshot(workspaceRoot);
}

async function readInitialManagerLiveSnapshot(
  workspaceRoot: string
): Promise<ManagerLiveSnapshot> {
  const cacheEntry = getOrCreateManagerLiveSnapshotCacheEntry(workspaceRoot);
  try {
    return await refreshManagerLiveSnapshot(workspaceRoot);
  } catch (error) {
    if (cacheEntry.snapshot) {
      return cacheEntry.snapshot;
    }
    throw error;
  }
}

export function isManagerUiPath(pathname: string): boolean {
  return pathname === '/manager' || pathname.startsWith('/manager/');
}

export async function handleManagerUiRequest(input: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  method: string;
  workspaceRoot: string;
  authConfig: WebUiAuthConfig;
}): Promise<boolean> {
  if (!isManagerUiPath(input.pathname)) {
    return false;
  }

  const localPath = normalizeManagerPath(input.pathname);

  if (
    localPath.startsWith('/api/') &&
    !isWebUiAuthorized(input.req, input.authConfig)
  ) {
    sendUnauthorized(input.res);
    return true;
  }

  if (localPath === '/' && input.method === 'GET') {
    const html = readFileSync(getAssetPath('manager.html'), 'utf-8');
    sendText(
      input.res,
      injectManagerHtml(html, {
        workspaceRoot: input.workspaceRoot,
        authConfig: input.authConfig,
        documentBasePath: '/manager/',
      }),
      200,
      'text/html; charset=utf-8'
    );
    return true;
  }

  if (localPath === '/manager-app.js' && input.method === 'GET') {
    sendText(
      input.res,
      readFileSync(getAssetPath('manager-app.js'), 'utf-8'),
      200,
      'application/javascript; charset=utf-8'
    );
    return true;
  }

  if (localPath === '/vendor/marked.js' && input.method === 'GET') {
    sendText(
      input.res,
      readFileSync(markedBrowserModulePath, 'utf-8'),
      200,
      'application/javascript; charset=utf-8'
    );
    return true;
  }

  if (localPath === '/api/threads' && input.method === 'GET') {
    const [threads, session, queue, rawMeta] = await Promise.all([
      listThreads(input.workspaceRoot),
      readSession(input.workspaceRoot),
      readQueue(input.workspaceRoot),
      readManagerThreadMeta(input.workspaceRoot),
    ]);
    const meta = await reconcileManagerThreadMeta({
      dir: input.workspaceRoot,
      threads,
      session,
      queue,
      meta: rawMeta,
    });
    sendJson(
      input.res,
      deriveManagerThreadViews({
        threads,
        session,
        queue,
        meta,
      })
    );
    return true;
  }

  if (localPath === '/api/live' && input.method === 'GET') {
    let initialSnapshot: ManagerLiveSnapshot;
    try {
      initialSnapshot = await readInitialManagerLiveSnapshot(
        input.workspaceRoot
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? `Failed to build manager live snapshot: ${error.message}`
          : 'Failed to build manager live snapshot';
      sendError(input.res, message, 500);
      return true;
    }

    const snapshotCacheEntry = getOrCreateManagerLiveSnapshotCacheEntry(
      input.workspaceRoot
    );
    snapshotCacheEntry.subscriberCount += 1;
    input.res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    activeSseConnections.add(input.res);
    input.res.write(JSON.stringify(initialSnapshot) + '\n');

    let closed = false;
    let writeChain = Promise.resolve();

    const enqueuePayload = (payload: unknown): void => {
      writeChain = writeChain
        .then(async () => {
          if (closed || input.res.writableEnded) {
            return;
          }
          input.res.write(JSON.stringify(payload) + '\n');
        })
        .catch(() => {
          /* ignore stream write failures */
        });
    };

    const enqueueSnapshot = (): void => {
      writeChain = writeChain
        .then(async () => {
          if (closed || input.res.writableEnded) {
            return;
          }
          const snapshot = await refreshManagerLiveSnapshot(
            input.workspaceRoot
          );
          if (closed || input.res.writableEnded) {
            return;
          }
          input.res.write(JSON.stringify(snapshot) + '\n');
        })
        .catch(() => {
          /* ignore snapshot rebuild failures */
        });
    };

    const unsubscribe = subscribeManagerUpdates(input.workspaceRoot, () => {
      enqueueSnapshot();
    });

    const heartbeat = setInterval(() => {
      enqueuePayload({
        kind: 'ping',
        emittedAt: new Date().toISOString(),
      });
    }, 20000);

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      snapshotCacheEntry.subscriberCount = Math.max(
        0,
        snapshotCacheEntry.subscriberCount - 1
      );
      activeSseConnections.delete(input.res);
      clearInterval(heartbeat);
      unsubscribe();
      if (!input.res.writableEnded) {
        input.res.end();
      }
    };

    input.req.on('close', cleanup);
    input.req.on('error', cleanup);
    input.res.on('close', cleanup);
    input.res.on('error', cleanup);
    return true;
  }

  if (localPath === '/api/tasks' && input.method === 'GET') {
    sendJson(input.res, await readActiveTasks(input.workspaceRoot));
    return true;
  }

  if (localPath === '/api/threads/purge' && input.method === 'POST') {
    const purged = await purgeThreads(input.workspaceRoot);
    notifyManagerUpdate(input.workspaceRoot);
    sendJson(input.res, { count: purged.length, ids: purged.map((t) => t.id) });
    return true;
  }

  if (localPath === '/api/threads' && input.method === 'POST') {
    const body = await parseBody(input.req);
    if (typeof body.title !== 'string' || !body.title.trim()) {
      sendError(input.res, 'title is required');
      return true;
    }
    const createdThread = await createThread(
      input.workspaceRoot,
      body.title.trim()
    );
    await updateManagerThreadMeta(
      input.workspaceRoot,
      createdThread.id,
      (current) => ({
        ...(current ?? {}),
        managerOwned: true,
      })
    );
    notifyManagerUpdate(input.workspaceRoot);
    sendJson(input.res, createdThread, 201);
    return true;
  }

  const threadIdMatch = localPath.match(/^\/api\/threads\/([^/]+)$/);
  if (threadIdMatch && input.method === 'GET') {
    const thread = await getThread(input.workspaceRoot, threadIdMatch[1]);
    if (!thread) {
      sendError(input.res, 'Thread not found', 404);
      return true;
    }
    sendJson(input.res, thread);
    return true;
  }

  const messageMatch = localPath.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (messageMatch && input.method === 'POST') {
    const body = await parseBody(input.req);
    if (typeof body.content !== 'string' || !body.content.trim()) {
      sendError(input.res, 'content is required');
      return true;
    }
    const sender =
      body.from === 'ai' || body.from === 'user' ? body.from : 'user';
    const status =
      typeof body.status === 'string' &&
      VALID_THREAD_STATUSES.has(body.status as ThreadStatus)
        ? (body.status as ThreadStatus)
        : undefined;
    const message = await addMessage(
      input.workspaceRoot,
      messageMatch[1],
      body.content,
      sender,
      status
    );
    notifyManagerUpdate(input.workspaceRoot);
    sendJson(input.res, message);
    return true;
  }

  const resolveMatch = localPath.match(/^\/api\/threads\/([^/]+)\/resolve$/);
  if (resolveMatch && input.method === 'PUT') {
    const resolvedThread = await resolveThread(
      input.workspaceRoot,
      resolveMatch[1]
    );
    notifyManagerUpdate(input.workspaceRoot);
    sendJson(input.res, resolvedThread);
    return true;
  }

  const reopenMatch = localPath.match(/^\/api\/threads\/([^/]+)\/reopen$/);
  if (reopenMatch && input.method === 'PUT') {
    const reopenedThread = await reopenThread(
      input.workspaceRoot,
      reopenMatch[1]
    );
    notifyManagerUpdate(input.workspaceRoot);
    sendJson(input.res, reopenedThread);
    return true;
  }

  const preserveMatch = localPath.match(
    /^\/api\/threads\/([^/]+)\/preserve-and-continue$/
  );
  if (preserveMatch && input.method === 'POST') {
    try {
      const result = await preserveSeedRecoveryAndContinue({
        dir: input.workspaceRoot,
        threadId: preserveMatch[1],
      });
      notifyManagerUpdate(input.workspaceRoot);
      sendJson(input.res, result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to preserve seed state';
      const status = message === 'Thread not found' ? 404 : 400;
      sendError(input.res, message, status);
    }
    return true;
  }

  if (localPath === '/api/manager/status' && input.method === 'GET') {
    const snapshotCacheEntry = getOrCreateManagerLiveSnapshotCacheEntry(
      input.workspaceRoot
    );
    if (snapshotCacheEntry.snapshot && snapshotCacheEntry.subscriberCount > 0) {
      sendJson(input.res, snapshotCacheEntry.snapshot.status);
      return true;
    }
    sendJson(input.res, await readDirectManagerStatus(input.workspaceRoot));
    return true;
  }

  if (localPath === '/api/manager/start' && input.method === 'POST') {
    const result = await startBuiltinManager(input.workspaceRoot);
    sendJson(input.res, result, result.started ? 200 : 503);
    return true;
  }

  if (localPath === '/api/manager/send' && input.method === 'POST') {
    const body = await parseBody(input.req);
    if (typeof body.threadId !== 'string' || !body.threadId) {
      sendError(input.res, 'threadId is required');
      return true;
    }
    if (typeof body.content !== 'string' || !body.content.trim()) {
      sendError(input.res, 'content is required');
      return true;
    }
    const thread = await getThread(input.workspaceRoot, body.threadId);
    if (!thread) {
      sendError(input.res, 'Thread not found', 404);
      return true;
    }
    sendJson(
      input.res,
      await sendThreadFollowUpToBuiltinManager(
        input.workspaceRoot,
        body.threadId,
        body.content
      )
    );
    return true;
  }

  if (localPath === '/api/manager/global-send' && input.method === 'POST') {
    const body = await parseBody(input.req);
    if (typeof body.content !== 'string' || !body.content.trim()) {
      sendError(input.res, 'content is required');
      return true;
    }
    sendJson(
      input.res,
      await sendGlobalToBuiltinManager(input.workspaceRoot, body.content, {
        contextThreadId:
          typeof body.contextThreadId === 'string' &&
          body.contextThreadId.trim()
            ? body.contextThreadId.trim()
            : null,
      })
    );
    return true;
  }

  if (localPath === '/api/builds' && input.method === 'GET') {
    const builds = await listBuilds();
    let currentHash = '';
    try {
      currentHash = (await getGitInfo(resolvePackageRoot())).hashFull;
    } catch {
      /* ignore */
    }
    sendJson(input.res, { builds, currentHash });
    return true;
  }

  if (localPath === '/api/builds/rollback' && input.method === 'POST') {
    const body = await parseBody(input.req);
    const commitHash =
      typeof body.commitHash === 'string' ? body.commitHash.trim() : '';
    if (!commitHash) {
      sendError(input.res, 'commitHash is required');
      return true;
    }

    const packageRoot = resolvePackageRoot();
    const restored = await restoreBuild(commitHash, packageRoot);
    if (!restored) {
      sendError(input.res, `No archived build matching "${commitHash}"`, 404);
      return true;
    }

    sendJson(input.res, {
      success: true,
      commitHash: restored.commitHash,
      commitMessage: restored.commitMessage,
    });

    // Trigger restart after responding
    setImmediate(() => {
      process.exit(0);
    });
    return true;
  }

  sendError(input.res, 'Not found', 404);
  return true;
}
