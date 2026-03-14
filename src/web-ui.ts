import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { toDataURL as toQrDataUrl } from 'qrcode';
import {
  PowerShellSessionBridge,
  type SessionBridge,
} from './session-bridge.js';
import {
  isWebUiAuthorized,
  resolveWebUiAuthConfig,
  type WebUiAuthConfig,
} from './web-auth.js';
import type { SessionType } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function sendError(res: ServerResponse, message: string, status = 400): void {
  sendJson(res, { error: message }, status);
}

function tryListen(
  server: Server,
  port: number,
  host: string,
  maxAttempts = 10
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('error', onError);
      if (error.code === 'EADDRINUSE' && maxAttempts > 1) {
        tryListen(server, port + 1, host, maxAttempts - 1).then(
          resolvePromise,
          reject
        );
      } else {
        reject(error);
      }
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      const actualPort =
        typeof address === 'object' && address ? address.port : port;
      resolvePromise(actualPort);
    });
  });
}

function openBrowser(url: string): void {
  let command = '';
  if (process.platform === 'win32') {
    command = `start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    command = `open "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      console.log(`Could not open browser automatically. Visit: ${url}`);
    }
  });
}

function injectIndexHtml(
  html: string,
  authConfig: Pick<WebUiAuthConfig, 'required' | 'storageKey'>,
  workspaceRoot: string,
  preferredConnectUrl: string | null
): string {
  return html
    .replace(
      '__WORKSPACE_AGENT_HUB_AUTH_REQUIRED__',
      authConfig.required ? 'true' : 'false'
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_AUTH_STORAGE_KEY__',
      JSON.stringify(authConfig.storageKey)
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_WORKSPACE_ROOT__',
      JSON.stringify(workspaceRoot)
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_PREFERRED_CONNECT_URL__',
      JSON.stringify(preferredConnectUrl)
    );
}

function normalizePublicUrl(publicUrl?: string): string | null {
  if (!publicUrl || !publicUrl.trim()) {
    return null;
  }
  const normalized = new URL(publicUrl.trim());
  normalized.hash = '';
  return normalized.toString().replace(/\/$/, '');
}

function getRequestOrigin(
  req: IncomingMessage,
  fallbackOrigin: string
): string {
  const forwardedProtoHeader = req.headers['x-forwarded-proto'];
  const forwardedProto = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : forwardedProtoHeader;
  const protocol =
    forwardedProto && forwardedProto.trim()
      ? forwardedProto.split(',')[0]!.trim()
      : 'http';
  const hostHeader = req.headers.host;
  return hostHeader && hostHeader.trim()
    ? `${protocol}://${hostHeader.trim()}`
    : fallbackOrigin;
}

export interface StartWebUiOptions {
  host?: string;
  port?: number;
  authToken?: string;
  publicUrl?: string;
  openBrowser?: boolean;
  bridge?: SessionBridge;
}

export async function createWebUiServer(
  options: StartWebUiOptions = {}
): Promise<{
  server: Server;
  port: number;
  host: string;
  authConfig: WebUiAuthConfig;
  bridge: SessionBridge;
}> {
  const bridge = options.bridge ?? new PowerShellSessionBridge();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3360;
  const fallbackOrigin = `http://${host}:${port}`;
  const authConfig = resolveWebUiAuthConfig(
    bridge.getWorkspaceRoot(),
    options.authToken
  );
  const preferredConnectUrl = normalizePublicUrl(options.publicUrl);

  const server = createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', `http://${host}:${port}`);
      const pathname = requestUrl.pathname;
      const method = req.method ?? 'GET';

      try {
        if (method === 'GET' && pathname === '/') {
          const html = readFileSync(getAssetPath('index.html'), 'utf-8');
          sendText(
            res,
            injectIndexHtml(
              html,
              authConfig,
              bridge.getWorkspaceRoot(),
              preferredConnectUrl
            ),
            200,
            'text/html; charset=utf-8'
          );
          return;
        }

        if (method === 'GET' && pathname === '/web-app.js') {
          sendText(
            res,
            readFileSync(getAssetPath('web-app.js'), 'utf-8'),
            200,
            'application/javascript; charset=utf-8'
          );
          return;
        }

        if (method === 'GET' && pathname === '/sw.js') {
          sendText(
            res,
            readFileSync(getAssetPath('sw.js'), 'utf-8'),
            200,
            'application/javascript; charset=utf-8'
          );
          return;
        }

        if (method === 'GET' && pathname === '/app.webmanifest') {
          sendText(
            res,
            readFileSync(getAssetPath('app.webmanifest'), 'utf-8'),
            200,
            'application/manifest+json; charset=utf-8'
          );
          return;
        }

        if (method === 'GET' && pathname === '/icon.svg') {
          sendText(
            res,
            readFileSync(getAssetPath('icon.svg'), 'utf-8'),
            200,
            'image/svg+xml; charset=utf-8'
          );
          return;
        }

        if (
          pathname.startsWith('/api/') &&
          !isWebUiAuthorized(req, authConfig)
        ) {
          sendUnauthorized(res);
          return;
        }

        if (method === 'GET' && pathname === '/api/pairing-qr') {
          const connectBaseUrl =
            preferredConnectUrl ?? getRequestOrigin(req, fallbackOrigin);
          const connectUrl =
            authConfig.required && authConfig.token
              ? `${connectBaseUrl}#accessCode=${encodeURIComponent(authConfig.token)}`
              : connectBaseUrl;
          const dataUrl = await toQrDataUrl(connectUrl, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 240,
          });
          sendJson(res, { connectUrl, dataUrl });
          return;
        }

        if (method === 'GET' && pathname === '/api/directories') {
          sendJson(res, await bridge.listSuggestedDirectories());
          return;
        }

        if (method === 'GET' && pathname === '/api/sessions') {
          const includeArchived =
            requestUrl.searchParams.get('includeArchived') !== 'false';
          sendJson(res, await bridge.listSessions(includeArchived));
          return;
        }

        if (method === 'POST' && pathname === '/api/sessions') {
          const body = await parseBody(req);
          const type = body.type;
          if (
            type !== 'codex' &&
            type !== 'claude' &&
            type !== 'gemini' &&
            type !== 'shell'
          ) {
            sendError(res, 'type is required');
            return;
          }

          const session = await bridge.startSession({
            type: type as SessionType,
            title: typeof body.title === 'string' ? body.title : '',
            workingDirectory:
              typeof body.workingDirectory === 'string'
                ? body.workingDirectory
                : '',
          });
          sendJson(res, session, 201);
          return;
        }

        const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (method === 'GET' && sessionMatch) {
          const sessions = await bridge.listSessions(true);
          const found = sessions.find(
            (session) => session.Name === decodeURIComponent(sessionMatch[1])
          );
          if (!found) {
            sendError(res, 'Session not found', 404);
            return;
          }
          sendJson(res, found);
          return;
        }

        const transcriptMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/output$/
        );
        if (method === 'GET' && transcriptMatch) {
          const lines = Number(requestUrl.searchParams.get('lines') ?? '400');
          sendJson(
            res,
            await bridge.readTranscript(
              decodeURIComponent(transcriptMatch[1]),
              lines
            )
          );
          return;
        }

        const inputMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/input$/);
        if (method === 'POST' && inputMatch) {
          const body = await parseBody(req);
          if (typeof body.text !== 'string') {
            sendError(res, 'text is required');
            return;
          }
          sendJson(
            res,
            await bridge.sendInput(
              decodeURIComponent(inputMatch[1]),
              body.text,
              body.submit !== false
            )
          );
          return;
        }

        const interruptMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/interrupt$/
        );
        if (method === 'POST' && interruptMatch) {
          sendJson(
            res,
            await bridge.interruptSession(decodeURIComponent(interruptMatch[1]))
          );
          return;
        }

        const renameMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/rename$/
        );
        if (method === 'POST' && renameMatch) {
          const body = await parseBody(req);
          if (typeof body.title !== 'string' || !body.title.trim()) {
            sendError(res, 'title is required');
            return;
          }
          sendJson(
            res,
            await bridge.renameSession(
              decodeURIComponent(renameMatch[1]),
              body.title
            )
          );
          return;
        }

        const archiveMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/archive$/
        );
        if (method === 'POST' && archiveMatch) {
          sendJson(
            res,
            await bridge.archiveSession(decodeURIComponent(archiveMatch[1]))
          );
          return;
        }

        const unarchiveMatch = pathname.match(
          /^\/api\/sessions\/([^/]+)\/unarchive$/
        );
        if (method === 'POST' && unarchiveMatch) {
          sendJson(
            res,
            await bridge.unarchiveSession(decodeURIComponent(unarchiveMatch[1]))
          );
          return;
        }

        const closeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
        if (method === 'POST' && closeMatch) {
          sendJson(
            res,
            await bridge.closeSession(decodeURIComponent(closeMatch[1]))
          );
          return;
        }

        const deleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (method === 'DELETE' && deleteMatch) {
          sendJson(
            res,
            await bridge.deleteSession(decodeURIComponent(deleteMatch[1]))
          );
          return;
        }

        sendError(res, 'Not found', 404);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendError(res, message, 500);
      }
    })();
  });

  const actualPort = await tryListen(server, port, host);
  return {
    server,
    port: actualPort,
    host,
    authConfig,
    bridge,
  };
}

export async function startWebUi(
  options: StartWebUiOptions = {}
): Promise<void> {
  const { server, port, host, authConfig } = await createWebUiServer(options);
  const url = `http://${host}:${port}`;
  const connectUrl = normalizePublicUrl(options.publicUrl) ?? url;
  const connectLink =
    authConfig.required && authConfig.token
      ? `${connectUrl}#accessCode=${encodeURIComponent(authConfig.token)}`
      : connectUrl;

  console.log(`Workspace Agent Hub web UI listening on ${url}`);
  console.log(`Preferred connect URL: ${connectUrl}`);
  if (authConfig.required && authConfig.token) {
    console.log(`Access code: ${authConfig.token}`);
    console.log(`One-tap pairing link: ${connectLink}`);
  }

  if (options.openBrowser !== false) {
    openBrowser(url);
  }

  await new Promise<void>((resolvePromise) => {
    server.on('close', () => resolvePromise());
  });
}
