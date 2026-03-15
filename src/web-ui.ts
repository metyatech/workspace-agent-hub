import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
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
import type {
  PreferredConnectUrlSource,
  SessionType,
  TailscaleConnectInfo,
} from './types.js';

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

export interface BrowserOpenCommand {
  command: string;
  args: string[];
  windowsHide: boolean;
}

export function buildBrowserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform
): BrowserOpenCommand {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', url],
      windowsHide: true,
    };
  }

  if (platform === 'darwin') {
    return {
      command: 'open',
      args: [url],
      windowsHide: false,
    };
  }

  return {
    command: 'xdg-open',
    args: [url],
    windowsHide: false,
  };
}

function openBrowser(url: string): void {
  const launch = buildBrowserOpenCommand(url);
  execFile(
    launch.command,
    launch.args,
    { windowsHide: launch.windowsHide },
    (error) => {
      if (error) {
        console.log(`Could not open browser automatically. Visit: ${url}`);
      }
    }
  );
}

function injectIndexHtml(
  html: string,
  authConfig: Pick<WebUiAuthConfig, 'required' | 'storageKey'>,
  workspaceRoot: string,
  connectInfo: ResolvedConnectInfo
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
      JSON.stringify(connectInfo.preferredConnectUrl)
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_PREFERRED_CONNECT_URL_SOURCE__',
      JSON.stringify(connectInfo.source)
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_TAILSCALE_DIRECT_URL__',
      JSON.stringify(connectInfo.tailscale?.directConnectUrl ?? null)
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_TAILSCALE_SECURE_URL__',
      JSON.stringify(connectInfo.tailscale?.secureConnectUrl ?? null)
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_TAILSCALE_SERVE_COMMAND__',
      JSON.stringify(connectInfo.tailscale?.serveCommand ?? null)
    )
    .replace(
      '__WORKSPACE_AGENT_HUB_TAILSCALE_SERVE_SETUP_URL__',
      JSON.stringify(connectInfo.tailscale?.serveSetupUrl ?? null)
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

export type CommandRunner = (
  command: string,
  args: string[],
  options?: {
    timeoutMs?: number;
  }
) => Promise<string>;

export interface ResolvedConnectInfo {
  preferredConnectUrl: string;
  source: PreferredConnectUrlSource;
  tailscale: TailscaleConnectInfo | null;
}

interface TailscaleStatusPayload {
  BackendState?: string;
  Self?: {
    DNSName?: string;
  };
}

export class CommandExecutionError extends Error {
  stdout: string;
  stderr: string;
  timedOut: boolean;

  constructor(input: {
    message: string;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
  }) {
    super(input.message);
    this.name = 'CommandExecutionError';
    this.stdout = input.stdout ?? '';
    this.stderr = input.stderr ?? '';
    this.timedOut = input.timedOut ?? false;
  }
}

const TAILSCALE_ADMIN_DNS_URL = 'https://login.tailscale.com/admin/dns';

export function extractTailscaleServeSetupUrl(text: string): string | null {
  const match = text.match(
    /https:\/\/login\.tailscale\.com\/f\/serve\?node=[^\s]+/i
  );
  return match?.[0] ?? null;
}

export function runCommand(
  command: string,
  args: string[],
  options?: {
    timeoutMs?: number;
  }
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const child = execFile(
      command,
      args,
      { windowsHide: true },
      (error, stdout, stderr) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (error) {
          reject(
            new CommandExecutionError({
              message:
                stderr.trim() ||
                stdout.trim() ||
                error.message ||
                String(error),
              stdout: stdoutBuffer || stdout.toString(),
              stderr: stderrBuffer || stderr.toString(),
            })
          );
          return;
        }
        resolvePromise(stdoutBuffer || stdout.toString());
      }
    );

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    timeoutHandle =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) {
              return;
            }
            settled = true;
            child.kill();
            reject(
              new CommandExecutionError({
                message: `Command timed out after ${options.timeoutMs}ms`,
                stdout: stdoutBuffer,
                stderr: stderrBuffer,
                timedOut: true,
              })
            );
          }, options.timeoutMs)
        : null;
  });
}

function isLocalOnlyHost(host: string): boolean {
  return /^(127\.0\.0\.1|localhost|::1)$/i.test(host.trim());
}

function isWildcardHost(host: string): boolean {
  return /^(0\.0\.0\.0|::)$/i.test(host.trim());
}

function trimTrailingDot(value: string): string {
  return value.replace(/\.+$/, '');
}

function buildTailscaleServeCommand(port: number): string {
  return `tailscale serve --bg --yes http://127.0.0.1:${port}`;
}

async function detectTailscaleConnectInfo(input: {
  host: string;
  port: number;
  enableServe: boolean;
  commandRunner: CommandRunner;
}): Promise<TailscaleConnectInfo | null> {
  let payload: TailscaleStatusPayload;
  try {
    payload = JSON.parse(
      await input.commandRunner('tailscale', ['status', '--json'], {
        timeoutMs: 3000,
      })
    ) as TailscaleStatusPayload;
  } catch {
    return null;
  }

  if (payload.BackendState !== 'Running' || !payload.Self?.DNSName) {
    return null;
  }

  const dnsName = trimTrailingDot(payload.Self.DNSName);
  const serveCommand = buildTailscaleServeCommand(input.port);
  const secureConnectUrl = `https://${dnsName}`;
  const directConnectUrl = isLocalOnlyHost(input.host)
    ? null
    : `http://${dnsName}:${input.port}`;
  let serveEnabled = false;
  let serveFallbackReason: string | null = null;
  let serveSetupUrl: string | null = null;

  if (input.enableServe) {
    try {
      await input.commandRunner(
        'tailscale',
        ['serve', '--bg', '--yes', `http://127.0.0.1:${input.port}`],
        { timeoutMs: 5000 }
      );
      serveEnabled = true;
    } catch (error) {
      const diagnosticText =
        error instanceof CommandExecutionError
          ? `${error.stdout}\n${error.stderr}\n${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      serveSetupUrl = extractTailscaleServeSetupUrl(diagnosticText)
        ? TAILSCALE_ADMIN_DNS_URL
        : null;
      serveFallbackReason = serveSetupUrl
        ? 'Tailscale Serve needs one-time approval from the tailnet DNS settings.'
        : error instanceof Error
          ? error.message
          : String(error);
    }
  }

  return {
    dnsName,
    directConnectUrl,
    secureConnectUrl,
    serveCommand,
    serveEnabled,
    serveFallbackReason,
    serveSetupUrl,
  };
}

async function resolveConnectInfo(input: {
  host: string;
  port: number;
  publicUrl?: string;
  tailscaleServe?: boolean;
  commandRunner?: CommandRunner;
}): Promise<ResolvedConnectInfo> {
  const listenOriginHost = isWildcardHost(input.host)
    ? '127.0.0.1'
    : input.host;
  const listenUrl = `http://${listenOriginHost}:${input.port}`;
  const explicitPublicUrl = normalizePublicUrl(input.publicUrl);
  const tailscale = await detectTailscaleConnectInfo({
    host: input.host,
    port: input.port,
    enableServe: Boolean(input.tailscaleServe) && !explicitPublicUrl,
    commandRunner: input.commandRunner ?? runCommand,
  });

  if (explicitPublicUrl) {
    return {
      preferredConnectUrl: explicitPublicUrl,
      source: 'public-url',
      tailscale,
    };
  }

  if (tailscale?.serveEnabled) {
    return {
      preferredConnectUrl: tailscale.secureConnectUrl,
      source: 'tailscale-serve',
      tailscale,
    };
  }

  if (tailscale?.directConnectUrl) {
    return {
      preferredConnectUrl: tailscale.directConnectUrl,
      source: 'tailscale-direct',
      tailscale,
    };
  }

  return {
    preferredConnectUrl: listenUrl,
    source: 'listen-url',
    tailscale,
  };
}

export interface StartWebUiOptions {
  host?: string;
  port?: number;
  authToken?: string;
  publicUrl?: string;
  tailscaleServe?: boolean;
  jsonOutput?: boolean;
  openBrowser?: boolean;
  bridge?: SessionBridge;
  commandRunner?: CommandRunner;
}

export interface WebUiLaunchInfo {
  listenUrl: string;
  preferredConnectUrl: string;
  preferredConnectUrlSource: PreferredConnectUrlSource;
  authRequired: boolean;
  accessCode: string | null;
  oneTapPairingLink: string;
  tailscale: TailscaleConnectInfo | null;
}

export function buildWebUiLaunchInfo(input: {
  host: string;
  port: number;
  authConfig: WebUiAuthConfig;
  connectInfo: ResolvedConnectInfo;
}): WebUiLaunchInfo {
  const listenUrl = `http://${input.host}:${input.port}`;
  const preferredConnectUrl = input.connectInfo.preferredConnectUrl;
  const oneTapPairingLink =
    input.authConfig.required && input.authConfig.token
      ? `${preferredConnectUrl}#accessCode=${encodeURIComponent(input.authConfig.token)}`
      : preferredConnectUrl;
  return {
    listenUrl,
    preferredConnectUrl,
    preferredConnectUrlSource: input.connectInfo.source,
    authRequired: input.authConfig.required,
    accessCode: input.authConfig.token,
    oneTapPairingLink,
    tailscale: input.connectInfo.tailscale,
  };
}

export function buildBrowserOpenUrl(input: {
  host: string;
  port: number;
  authConfig: Pick<WebUiAuthConfig, 'required' | 'token'>;
}): string {
  const browserHost = isWildcardHost(input.host) ? '127.0.0.1' : input.host;
  const browserUrl = new URL(`http://${browserHost}:${input.port}`);
  if (input.authConfig.required && input.authConfig.token) {
    browserUrl.hash = `accessCode=${encodeURIComponent(input.authConfig.token)}`;
  }
  return browserUrl.toString();
}

export async function createWebUiServer(
  options: StartWebUiOptions = {}
): Promise<{
  server: Server;
  port: number;
  host: string;
  authConfig: WebUiAuthConfig;
  bridge: SessionBridge;
  connectInfo: ResolvedConnectInfo;
}> {
  const bridge = options.bridge ?? new PowerShellSessionBridge();
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 3360;
  const authConfig = resolveWebUiAuthConfig(
    bridge.getWorkspaceRoot(),
    options.authToken
  );
  let connectInfo: ResolvedConnectInfo = {
    preferredConnectUrl: `http://${host}:${port}`,
    source: 'listen-url',
    tailscale: null,
  };

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
              connectInfo
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
            connectInfo.preferredConnectUrl ||
            getRequestOrigin(req, `http://${host}:${port}`);
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
  connectInfo = await resolveConnectInfo({
    host,
    port: actualPort,
    publicUrl: options.publicUrl,
    tailscaleServe: options.tailscaleServe,
    commandRunner: options.commandRunner,
  });
  return {
    server,
    port: actualPort,
    host,
    authConfig,
    bridge,
    connectInfo,
  };
}

export async function startWebUi(
  options: StartWebUiOptions = {}
): Promise<void> {
  const { server, port, host, authConfig, connectInfo } =
    await createWebUiServer(options);
  const launchInfo = buildWebUiLaunchInfo({
    host,
    port,
    authConfig,
    connectInfo,
  });

  if (options.jsonOutput) {
    console.log(JSON.stringify(launchInfo));
  } else {
    console.log(
      `Workspace Agent Hub web UI listening on ${launchInfo.listenUrl}`
    );
    console.log(
      `Preferred connect URL (${launchInfo.preferredConnectUrlSource}): ${launchInfo.preferredConnectUrl}`
    );
    console.log(
      'Phone onboarding: scan the QR on the opened PC page first. Copy/share the link only if scanning is not available.'
    );
    if (launchInfo.authRequired && launchInfo.accessCode) {
      console.log(`Access code: ${launchInfo.accessCode}`);
      console.log(`One-tap pairing link: ${launchInfo.oneTapPairingLink}`);
    }
    if (launchInfo.tailscale?.directConnectUrl) {
      console.log(
        `Tailscale direct URL: ${launchInfo.tailscale.directConnectUrl}`
      );
    }
    if (
      launchInfo.tailscale?.secureConnectUrl &&
      launchInfo.preferredConnectUrlSource !== 'public-url'
    ) {
      console.log(
        `Tailscale secure URL: ${launchInfo.tailscale.secureConnectUrl}`
      );
    }
    if (
      launchInfo.tailscale?.serveCommand &&
      launchInfo.preferredConnectUrlSource !== 'tailscale-serve'
    ) {
      console.log(
        `To enable installable HTTPS on the tailnet: ${launchInfo.tailscale.serveCommand}`
      );
    }
    if (launchInfo.tailscale?.serveSetupUrl) {
      console.log(
        `Open the Tailscale DNS settings once in your browser: ${launchInfo.tailscale.serveSetupUrl}`
      );
      console.log(
        'Enable HTTPS Certificates there, then run the same -PhoneReady command again to get the HTTPS tailnet URL.'
      );
    }
    if (
      options.tailscaleServe &&
      !options.publicUrl &&
      launchInfo.tailscale?.serveCommand &&
      launchInfo.preferredConnectUrlSource !== 'tailscale-serve'
    ) {
      console.log(
        launchInfo.tailscale?.serveSetupUrl
          ? 'Automatic Tailscale Serve setup is waiting for one-time DNS/HTTPS approval in the tailnet. Continuing with the available connect URL instead.'
          : 'Automatic Tailscale Serve setup did not complete. Continuing with the available connect URL instead.'
      );
    }
  }

  if (options.openBrowser !== false) {
    const localBrowserUrl = buildBrowserOpenUrl({
      host,
      port,
      authConfig,
    });
    openBrowser(localBrowserUrl);
  }

  await new Promise<void>((resolvePromise) => {
    server.on('close', () => resolvePromise());
  });
}
