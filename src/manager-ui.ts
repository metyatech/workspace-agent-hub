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
  readQueue,
  readSession,
  sendToBuiltinManager,
  sendGlobalToBuiltinManager,
  startBuiltinManager,
} from './manager-backend.js';
import { readActiveTasks } from './manager-tasks.js';
import {
  deriveManagerThreadViews,
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
import {
  findManagedRepo,
  readManagedRepos,
  resolveNewRepoRoot,
  upsertManagedRepo,
  type ManagerRunMode,
  type ManagerTargetKind,
  type ManagedRepoConfig,
} from './manager-repos.js';

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

function normalizeRequestedRunMode(value: unknown): ManagerRunMode {
  return value === 'read-only' ? 'read-only' : 'write';
}

function normalizeTargetKind(value: unknown): ManagerTargetKind {
  return value === 'new-repo' ? 'new-repo' : 'existing-repo';
}

interface ManagerLiveSnapshot {
  kind: 'snapshot';
  emittedAt: string;
  threads: ReturnType<typeof deriveManagerThreadViews>;
  tasks: Awaited<ReturnType<typeof readActiveTasks>>;
  repos: ManagedRepoConfig[];
  status: Awaited<ReturnType<typeof getBuiltinManagerStatus>>;
}

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
  const [threads, session, queue, meta, tasks, repos, status] =
    await Promise.all([
      listThreads(workspaceRoot),
      readSession(workspaceRoot),
      readQueue(workspaceRoot),
      readManagerThreadMeta(workspaceRoot),
      readActiveTasks(workspaceRoot),
      readManagedRepos(workspaceRoot),
      getBuiltinManagerStatus(workspaceRoot),
    ]);

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
    repos,
    status,
  };
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
    const [threads, session, queue, meta] = await Promise.all([
      listThreads(input.workspaceRoot),
      readSession(input.workspaceRoot),
      readQueue(input.workspaceRoot),
      readManagerThreadMeta(input.workspaceRoot),
    ]);
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
    input.res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    activeSseConnections.add(input.res);

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

    enqueuePayload(await buildManagerLiveSnapshot(input.workspaceRoot));

    const unsubscribe = subscribeManagerUpdates(input.workspaceRoot, () => {
      void buildManagerLiveSnapshot(input.workspaceRoot)
        .then((snapshot) => {
          enqueuePayload(snapshot);
        })
        .catch(() => {
          /* ignore snapshot rebuild failures */
        });
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

  if (localPath === '/api/manager/status' && input.method === 'GET') {
    sendJson(input.res, await getBuiltinManagerStatus(input.workspaceRoot));
    return true;
  }

  if (localPath === '/api/manager/repos' && input.method === 'GET') {
    sendJson(input.res, await readManagedRepos(input.workspaceRoot));
    return true;
  }

  if (localPath === '/api/manager/repos' && input.method === 'POST') {
    const body = await parseBody(input.req);
    try {
      const repo = await upsertManagedRepo(input.workspaceRoot, {
        id: typeof body.id === 'string' ? body.id : null,
        label: typeof body.label === 'string' ? body.label : '',
        repoRoot: typeof body.repoRoot === 'string' ? body.repoRoot : '',
        defaultBranch:
          typeof body.defaultBranch === 'string' ? body.defaultBranch : null,
        verifyCommand:
          typeof body.verifyCommand === 'string' ? body.verifyCommand : null,
        supportedWorkerRuntimes: Array.isArray(body.supportedWorkerRuntimes)
          ? body.supportedWorkerRuntimes.filter(
              (entry): entry is ManagedRepoConfig['preferredWorkerRuntime'] =>
                entry === 'codex' ||
                entry === 'claude' ||
                entry === 'gemini' ||
                entry === 'copilot'
            )
          : null,
        preferredWorkerRuntime:
          body.preferredWorkerRuntime === 'codex' ||
          body.preferredWorkerRuntime === 'claude' ||
          body.preferredWorkerRuntime === 'gemini' ||
          body.preferredWorkerRuntime === 'copilot'
            ? body.preferredWorkerRuntime
            : null,
        mergeLaneEnabled:
          typeof body.mergeLaneEnabled === 'boolean'
            ? body.mergeLaneEnabled
            : null,
      });
      sendJson(input.res, repo, 201);
    } catch (error) {
      sendError(
        input.res,
        error instanceof Error ? error.message : 'Failed to save repo',
        400
      );
    }
    return true;
  }

  if (localPath === '/api/manager/runs' && input.method === 'POST') {
    const body = await parseBody(input.req);
    const targetKind = normalizeTargetKind(body.targetKind);
    const repoId = typeof body.repoId === 'string' ? body.repoId.trim() : '';
    const newRepoName =
      typeof body.newRepoName === 'string' ? body.newRepoName.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!title) {
      sendError(input.res, 'title is required');
      return true;
    }
    if (!content) {
      sendError(input.res, 'content is required');
      return true;
    }

    const runMode = normalizeRequestedRunMode(body.runMode);
    const createdThread = await createThread(input.workspaceRoot, title);
    await addMessage(
      input.workspaceRoot,
      createdThread.id,
      content,
      'user',
      'waiting'
    );
    if (targetKind === 'new-repo') {
      if (!newRepoName) {
        sendError(input.res, 'newRepoName is required');
        return true;
      }
      let newRepoRoot = '';
      try {
        newRepoRoot = resolveNewRepoRoot(input.workspaceRoot, newRepoName);
      } catch (error) {
        sendError(
          input.res,
          error instanceof Error ? error.message : 'Invalid newRepoName'
        );
        return true;
      }
      const baseBranch =
        typeof body.baseBranch === 'string' && body.baseBranch.trim()
          ? body.baseBranch.trim()
          : 'main';
      await updateManagerThreadMeta(
        input.workspaceRoot,
        createdThread.id,
        () => ({
          repoTargetKind: 'new-repo',
          managedRepoId: null,
          managedRepoLabel: newRepoName,
          managedRepoRoot: newRepoRoot,
          newRepoName,
          newRepoRoot,
          managedBaseBranch: baseBranch,
          managedVerifyCommand: 'repo-created-by-worker',
          requestedWorkerRuntime: 'codex',
          requestedRunMode: runMode,
        })
      );
      await sendToBuiltinManager(
        input.workspaceRoot,
        createdThread.id,
        content,
        {
          dispatchMode: 'direct-worker',
          writeScopes: runMode === 'write' ? [newRepoName] : [],
          targetRepoRoot: newRepoRoot,
          requestedRunMode: runMode,
          requestedWorkerRuntime: 'codex',
          targetKind: 'new-repo',
          newRepoName,
        }
      );
      sendJson(
        input.res,
        {
          queued: true,
          threadId: createdThread.id,
          detail: `「${newRepoName}」を ${input.workspaceRoot} に新規作成する作業をキューに追加しました`,
        },
        201
      );
      return true;
    }

    if (!repoId) {
      sendError(input.res, 'repoId is required');
      return true;
    }

    const repo = await findManagedRepo(input.workspaceRoot, repoId);
    if (!repo) {
      sendError(input.res, 'Managed repo not found', 404);
      return true;
    }
    const baseBranch =
      typeof body.baseBranch === 'string' && body.baseBranch.trim()
        ? body.baseBranch.trim()
        : repo.defaultBranch;
    await updateManagerThreadMeta(
      input.workspaceRoot,
      createdThread.id,
      () => ({
        repoTargetKind: 'existing-repo',
        managedRepoId: repo.id,
        managedRepoLabel: repo.label,
        managedRepoRoot: repo.repoRoot,
        newRepoName: null,
        newRepoRoot: null,
        managedBaseBranch: baseBranch,
        managedVerifyCommand: repo.verifyCommand,
        requestedWorkerRuntime: repo.preferredWorkerRuntime,
        requestedRunMode: runMode,
      })
    );
    await sendToBuiltinManager(input.workspaceRoot, createdThread.id, content, {
      dispatchMode: 'direct-worker',
      writeScopes: runMode === 'write' ? [repo.repoRoot] : [],
      targetRepoRoot: repo.repoRoot,
      requestedRunMode: runMode,
      requestedWorkerRuntime: repo.preferredWorkerRuntime,
      targetKind: 'existing-repo',
    });
    sendJson(
      input.res,
      {
        queued: true,
        threadId: createdThread.id,
        detail: `「${repo.label}」向けの作業をキューに追加しました`,
      },
      201
    );
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
    await sendToBuiltinManager(
      input.workspaceRoot,
      body.threadId,
      body.content
    );
    sendJson(input.res, {
      queued: true,
      detail: 'メッセージをマネージャーキューに追加しました',
    });
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
