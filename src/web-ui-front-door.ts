import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

interface FrontDoorStateRecord {
  ListenUrl?: string | null;
  WorkspaceRoot?: string | null;
  PackageRoot?: string | null;
}

function filterProxyRequestHeaders(
  headers: IncomingHttpHeaders,
  target: URL
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }
    const normalized = key.toLowerCase();
    if (
      normalized === 'connection' ||
      normalized === 'content-length' ||
      normalized === 'host'
    ) {
      continue;
    }
    next[key] = Array.isArray(value) ? value : String(value);
  }
  next.host = target.host;
  return next;
}

function filterProxyResponseHeaders(
  headers: IncomingHttpHeaders
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }
    if (key.toLowerCase() === 'connection') {
      continue;
    }
    next[key] = Array.isArray(value) ? value : String(value);
  }
  return next;
}

async function readFrontDoorState(
  statePath: string
): Promise<FrontDoorStateRecord | null> {
  try {
    const raw = await readFile(statePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, '')) as FrontDoorStateRecord;
  } catch {
    return null;
  }
}

async function readFrontDoorUpstreamUrl(
  statePath: string
): Promise<string | null> {
  const state = await readFrontDoorState(statePath);
  const listenUrl = typeof state?.ListenUrl === 'string' ? state.ListenUrl : '';
  return listenUrl.trim() || null;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function proxyRequest(input: {
  statePath: string;
  req: IncomingMessage;
  res: ServerResponse;
}): Promise<void> {
  const upstreamUrl = await readFrontDoorUpstreamUrl(input.statePath);
  if (!upstreamUrl) {
    sendJson(input.res, 503, {
      error: 'Workspace Agent Hub front door has no upstream yet.',
    });
    return;
  }

  let target: URL;
  try {
    target = new URL(input.req.url ?? '/', upstreamUrl);
  } catch {
    sendJson(input.res, 502, {
      error: 'Workspace Agent Hub front door could not parse the upstream URL.',
    });
    return;
  }

  const proxyReq = httpRequest(target, {
    method: input.req.method ?? 'GET',
    headers: filterProxyRequestHeaders(input.req.headers, target),
  });

  proxyReq.on('response', (proxyRes) => {
    input.res.writeHead(
      proxyRes.statusCode ?? 502,
      filterProxyResponseHeaders(proxyRes.headers)
    );
    proxyRes.pipe(input.res);
  });

  proxyReq.on('error', (error) => {
    if (input.res.headersSent) {
      input.res.destroy(error);
      return;
    }
    sendJson(input.res, 502, {
      error: `Workspace Agent Hub front door could not reach the upstream: ${error.message}`,
    });
  });

  input.req.on('aborted', () => {
    proxyReq.destroy();
  });

  input.req.pipe(proxyReq);
}

export interface StartWebUiFrontDoorOptions {
  host?: string;
  port?: number;
  statePath: string;
}

export async function createWebUiFrontDoorServer(
  options: StartWebUiFrontDoorOptions
): Promise<{
  server: Server;
  port: number;
  host: string;
}> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const statePath = options.statePath;

  const server = createServer((req, res) => {
    void (async () => {
      const requestUrl = new URL(req.url ?? '/', `http://${host}:${port}`);
      if (
        req.method === 'GET' &&
        requestUrl.pathname === '/api/front-door/health'
      ) {
        const state = await readFrontDoorState(statePath);
        const upstreamUrl =
          typeof state?.ListenUrl === 'string' ? state.ListenUrl.trim() : '';
        sendJson(res, upstreamUrl ? 200 : 503, {
          ok: Boolean(upstreamUrl),
          upstreamUrl: upstreamUrl || null,
          workspaceRoot:
            typeof state?.WorkspaceRoot === 'string'
              ? state.WorkspaceRoot.trim() || null
              : null,
          packageRoot:
            typeof state?.PackageRoot === 'string'
              ? state.PackageRoot.trim() || null
              : null,
        });
        return;
      }

      await proxyRequest({ statePath, req, res });
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(res, 500, {
        error:
          error instanceof Error
            ? error.message
            : 'Workspace Agent Hub front door failed unexpectedly.',
      });
    });
  });

  const actualPort = await new Promise<number>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const address = server.address();
      resolvePromise(
        typeof address === 'object' && address ? address.port : port
      );
    });
  });

  return {
    server,
    port: actualPort,
    host,
  };
}

export async function startWebUiFrontDoor(
  options: StartWebUiFrontDoorOptions
): Promise<void> {
  const { port, host } = await createWebUiFrontDoorServer(options);
  console.log(
    JSON.stringify({
      listenUrl: `http://${host}:${port}`,
      statePath: options.statePath,
    })
  );
}
