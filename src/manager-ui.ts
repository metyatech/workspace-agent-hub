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
} from './manager-thread-state.js';
import { isWebUiAuthorized, type WebUiAuthConfig } from './web-auth.js';

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
  }
): string {
  return html
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

  if (localPath === '/api/tasks' && input.method === 'GET') {
    sendJson(input.res, await readActiveTasks(input.workspaceRoot));
    return true;
  }

  if (localPath === '/api/threads/purge' && input.method === 'POST') {
    const purged = await purgeThreads(input.workspaceRoot);
    sendJson(input.res, { count: purged.length, ids: purged.map((t) => t.id) });
    return true;
  }

  if (localPath === '/api/threads' && input.method === 'POST') {
    const body = await parseBody(input.req);
    if (typeof body.title !== 'string' || !body.title.trim()) {
      sendError(input.res, 'title is required');
      return true;
    }
    sendJson(
      input.res,
      await createThread(input.workspaceRoot, body.title.trim()),
      201
    );
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
    sendJson(
      input.res,
      await addMessage(
        input.workspaceRoot,
        messageMatch[1],
        body.content,
        sender,
        status
      )
    );
    return true;
  }

  const resolveMatch = localPath.match(/^\/api\/threads\/([^/]+)\/resolve$/);
  if (resolveMatch && input.method === 'PUT') {
    sendJson(
      input.res,
      await resolveThread(input.workspaceRoot, resolveMatch[1])
    );
    return true;
  }

  const reopenMatch = localPath.match(/^\/api\/threads\/([^/]+)\/reopen$/);
  if (reopenMatch && input.method === 'PUT') {
    sendJson(
      input.res,
      await reopenThread(input.workspaceRoot, reopenMatch[1])
    );
    return true;
  }

  if (localPath === '/api/manager/status' && input.method === 'GET') {
    sendJson(input.res, await getBuiltinManagerStatus(input.workspaceRoot));
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

  sendError(input.res, 'Not found', 404);
  return true;
}
