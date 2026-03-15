import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { resolve as resolvePath } from 'node:path';
import {
  buildBrowserOpenCommand,
  buildManagerUiUrl,
  CommandExecutionError,
  buildBrowserOpenUrl,
  buildWebUiLaunchInfo,
  createWebUiServer,
  extractTailscaleServeSetupUrl,
  probeManagerGuiInstance,
  rewriteManagerGuiHtmlForHub,
  runCommand,
} from '../web-ui.js';
import type { SessionBridge } from '../session-bridge.js';
import type {
  DirectorySuggestion,
  SessionMutationResult,
  SessionRecord,
  SessionTranscript,
  SessionType,
} from '../types.js';

function makeSession(
  name: string,
  overrides: Partial<SessionRecord> = {}
): SessionRecord {
  return {
    Name: name,
    Type: 'shell',
    DisplayName: name,
    Distro: 'Ubuntu',
    CreatedUnix: 1,
    CreatedLocal: '2026-03-14 00:00:00',
    AttachedClients: 0,
    WindowCount: 1,
    LastActivityUnix: 1,
    LastActivityLocal: '2026-03-14 00:00:00',
    Title: '',
    WorkingDirectoryWindows: 'D:\\ghws',
    PreviewText: 'preview',
    Archived: false,
    ClosedUtc: '',
    IsLive: true,
    State: 'Running',
    SortUnix: 1,
    DisplayTitle: name,
    ...overrides,
  };
}

class FakeBridge implements SessionBridge {
  sessions: SessionRecord[] = [
    makeSession('shell-existing', { DisplayTitle: 'Existing Session' }),
  ];
  transcripts = new Map<string, SessionTranscript>([
    [
      'shell-existing',
      {
        SessionName: 'shell-existing',
        WorkingDirectoryWsl: '/mnt/d/ghws',
        Transcript: 'hello from transcript',
        CapturedAtUtc: new Date().toISOString(),
      },
    ],
  ]);

  getWorkspaceRoot(): string {
    return 'D:\\ghws';
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.sessions;
  }

  async startSession(input: {
    type: SessionType;
    title?: string;
    workingDirectory?: string;
  }): Promise<SessionRecord> {
    const created = makeSession(`${input.type}-new`, {
      Type: input.type,
      DisplayTitle: input.title || 'New Session',
      Title: input.title || '',
      WorkingDirectoryWindows: input.workingDirectory || 'D:\\ghws',
    });
    this.sessions = [created, ...this.sessions];
    return created;
  }

  async renameSession(
    sessionName: string,
    title: string
  ): Promise<SessionRecord | SessionMutationResult> {
    const session = this.sessions.find((item) => item.Name === sessionName);
    if (!session) {
      return { SessionName: sessionName, Action: 'rename' };
    }
    session.DisplayTitle = title;
    session.Title = title;
    return session;
  }

  async archiveSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    const session = this.sessions.find((item) => item.Name === sessionName);
    if (!session) {
      return { SessionName: sessionName, Action: 'archive' };
    }
    session.Archived = true;
    return session;
  }

  async unarchiveSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    const session = this.sessions.find((item) => item.Name === sessionName);
    if (!session) {
      return { SessionName: sessionName, Action: 'unarchive' };
    }
    session.Archived = false;
    return session;
  }

  async closeSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    const session = this.sessions.find((item) => item.Name === sessionName);
    if (!session) {
      return { SessionName: sessionName, Action: 'close' };
    }
    session.IsLive = false;
    session.State = 'Closed';
    return session;
  }

  async deleteSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    this.sessions = this.sessions.filter((item) => item.Name !== sessionName);
    return { SessionName: sessionName, Deleted: true };
  }

  async readTranscript(sessionName: string): Promise<SessionTranscript> {
    return (
      this.transcripts.get(sessionName) ?? {
        SessionName: sessionName,
        WorkingDirectoryWsl: '/mnt/d/ghws',
        Transcript: '',
        CapturedAtUtc: new Date().toISOString(),
      }
    );
  }

  async sendInput(
    sessionName: string,
    text: string,
    submit: boolean
  ): Promise<SessionMutationResult> {
    this.transcripts.set(sessionName, {
      SessionName: sessionName,
      WorkingDirectoryWsl: '/mnt/d/ghws',
      Transcript: text,
      CapturedAtUtc: new Date().toISOString(),
    });
    return { SessionName: sessionName, Submitted: submit };
  }

  async interruptSession(sessionName: string): Promise<SessionMutationResult> {
    return { SessionName: sessionName, Interrupted: true };
  }

  async listSuggestedDirectories(): Promise<DirectorySuggestion[]> {
    return [
      { label: 'Workspace root', path: 'D:\\ghws' },
      { label: 'workspace-agent-hub', path: 'D:\\ghws\\workspace-agent-hub' },
    ];
  }
}

let activeServer: Server | null = null;

async function startMockManagerGuiServer(input?: {
  workspaceRoot?: string;
  authToken?: string | null;
  running?: boolean;
}): Promise<Server> {
  const workspaceRoot = resolvePath(input?.workspaceRoot ?? 'D:\\ghws');
  const authToken = input?.authToken ?? null;
  const running = input?.running ?? true;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="ja">
  <head><title>マネージャー</title></head>
  <body>
    <script>
      window.GUI_DIR = ${JSON.stringify(workspaceRoot)};
      window.MANAGER_AUTH_REQUIRED = ${authToken ? 'true' : 'false'};
      window.MANAGER_AUTH_STORAGE_KEY = ${JSON.stringify(`thread-inbox.manager-token:${workspaceRoot}`)};
    </script>
    <script type="module" src="/manager-app.js"></script>
  </body>
</html>`);
      return;
    }

    if (pathname === '/manager-app.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
      });
      res.end('console.log("manager-app");');
      return;
    }

    if (pathname === '/api/manager/status') {
      const provided = req.headers['x-thread-inbox-token'];
      if (authToken && provided !== authToken) {
        res.writeHead(401, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(
          JSON.stringify({ error: 'Access code required', authRequired: true })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          running,
          configured: true,
          builtinBackend: true,
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;
  }
});

describe('web UI server', () => {
  it('builds machine-readable launch metadata for automation clients', () => {
    expect(
      buildWebUiLaunchInfo({
        host: '127.0.0.1',
        port: 3360,
        authConfig: {
          required: true,
          token: 'secret-token',
          storageKey: 'workspace-agent-hub.token:D:\\ghws',
        },
        connectInfo: {
          preferredConnectUrl: 'https://hub.example.test/connect',
          source: 'public-url',
          tailscale: null,
        },
      })
    ).toEqual({
      listenUrl: 'http://127.0.0.1:3360',
      preferredConnectUrl: 'https://hub.example.test/connect',
      preferredConnectUrlSource: 'public-url',
      authRequired: true,
      accessCode: 'secret-token',
      oneTapPairingLink:
        'https://hub.example.test/connect#accessCode=secret-token',
      tailscale: null,
    });
  });

  it('builds a browser-open URL that preloads the access code on the local page', () => {
    expect(
      buildBrowserOpenUrl({
        host: '0.0.0.0',
        port: 3360,
        authConfig: {
          required: true,
          token: 'secret-token',
        },
      })
    ).toBe('http://127.0.0.1:3360/#accessCode=secret-token');
  });

  it('keeps the browser-open URL plain when auth is disabled', () => {
    expect(
      buildBrowserOpenUrl({
        host: '127.0.0.1',
        port: 3360,
        authConfig: {
          required: false,
          token: null,
        },
      })
    ).toBe('http://127.0.0.1:3360/');
  });

  it('builds a hidden Windows browser launch command instead of shell exec', () => {
    expect(buildBrowserOpenCommand('http://127.0.0.1:3360/', 'win32')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '', 'http://127.0.0.1:3360/'],
      windowsHide: true,
    });
  });

  it('extracts a Tailscale Serve approval URL from command output', () => {
    expect(
      extractTailscaleServeSetupUrl(`
Serve is not enabled on your tailnet.
To enable, visit:

         https://login.tailscale.com/f/serve?node=n2tFH92z1n11CNTRL
`)
    ).toBe('https://login.tailscale.com/f/serve?node=n2tFH92z1n11CNTRL');
  });

  it('captures partial stdout when a command times out', async () => {
    await expect(
      runCommand(
        process.execPath,
        [
          '-e',
          "process.stdout.write('Serve is not enabled on your tailnet.\\nTo enable, visit:\\nhttps://login.tailscale.com/f/serve?node=n2tFH92z1n11CNTRL\\n'); setInterval(() => {}, 1000);",
        ],
        { timeoutMs: 200 }
      )
    ).rejects.toMatchObject({
      timedOut: true,
      stdout: expect.stringContaining(
        'https://login.tailscale.com/f/serve?node=n2tFH92z1n11CNTRL'
      ),
    } satisfies Partial<CommandExecutionError>);
  });

  it('requires an access code for API requests when auth is enabled', async () => {
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(response.status).toBe(401);
  });

  it('serves sessions and allows starting a new one with a valid access code', async () => {
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = { 'X-Workspace-Agent-Hub-Token': 'secret-token' };
    const listResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers,
    });
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as SessionRecord[];
    expect(listed[0].Name).toBe('shell-existing');

    const startResponse = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'shell',
        title: 'From Test',
        workingDirectory: 'D:\\ghws',
      }),
    });

    expect(startResponse.status).toBe(201);
    const started = (await startResponse.json()) as SessionRecord;
    expect(started.DisplayTitle).toBe('From Test');

    const transcriptResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent('shell-existing')}/output`,
      { headers }
    );
    const transcript = (await transcriptResponse.json()) as SessionTranscript;
    expect(transcript.Transcript).toContain('hello from transcript');
  });

  it('injects the preferred connect URL into the browser bootstrap config', async () => {
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      publicUrl: 'https://hub.example.test/connect',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/`);
    const html = await response.text();
    expect(html).toContain(
      'preferredConnectUrl: "https://hub.example.test/connect"'
    );
    expect(html).toMatch(/preferredConnectUrlSource:\s*"public-url"/);
  });

  it('derives a Tailscale direct URL when the server is reachable over the tailnet', async () => {
    const { server, connectInfo } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '0.0.0.0',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
      commandRunner: async (command, args) => {
        if (command === 'tailscale' && args.join(' ') === 'status --json') {
          return JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'desktop.tail5a2d2d.ts.net.' },
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    });
    activeServer = server;

    const preferredUrl = new URL(connectInfo.preferredConnectUrl);
    expect(connectInfo.source).toBe('tailscale-direct');
    expect(preferredUrl.hostname).toBe('desktop.tail5a2d2d.ts.net');
    expect(connectInfo.tailscale).toEqual({
      dnsName: 'desktop.tail5a2d2d.ts.net',
      directConnectUrl: connectInfo.preferredConnectUrl,
      secureConnectUrl: 'https://desktop.tail5a2d2d.ts.net',
      serveCommand: `tailscale serve --bg --yes http://127.0.0.1:${preferredUrl.port}`,
      serveEnabled: false,
      serveFallbackReason: null,
      serveSetupUrl: null,
    });
  });

  it('can enable Tailscale Serve and prefer the resulting HTTPS URL', async () => {
    const invocations: string[] = [];
    const { server, connectInfo } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      tailscaleServe: true,
      openBrowser: false,
      commandRunner: async (command, args) => {
        invocations.push(`${command} ${args.join(' ')}`);
        if (command === 'tailscale' && args.join(' ') === 'status --json') {
          return JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'desktop.tail5a2d2d.ts.net.' },
          });
        }
        if (
          command === 'tailscale' &&
          args.join(' ').startsWith('serve --bg --yes http://127.0.0.1:')
        ) {
          return '';
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    });
    activeServer = server;

    expect(connectInfo.preferredConnectUrl).toBe(
      'https://desktop.tail5a2d2d.ts.net'
    );
    expect(connectInfo.source).toBe('tailscale-serve');
    expect(connectInfo.tailscale).toEqual({
      dnsName: 'desktop.tail5a2d2d.ts.net',
      directConnectUrl: null,
      secureConnectUrl: 'https://desktop.tail5a2d2d.ts.net',
      serveCommand: expect.stringMatching(
        /^tailscale serve --bg --yes http:\/\/127\.0\.0\.1:\d+$/
      ),
      serveEnabled: true,
      serveFallbackReason: null,
      serveSetupUrl: null,
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toBe('tailscale status --json');
    expect(invocations[1]).toMatch(
      /^tailscale serve --bg --yes http:\/\/127\.0\.0\.1:\d+$/
    );
  });

  it('falls back to a direct tailnet URL and surfaces approval when Tailscale Serve is not enabled yet', async () => {
    const invocations: string[] = [];
    const { server, connectInfo } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '0.0.0.0',
      port: 0,
      authToken: 'secret-token',
      tailscaleServe: true,
      openBrowser: false,
      commandRunner: async (command, args) => {
        invocations.push(`${command} ${args.join(' ')}`);
        if (command === 'tailscale' && args.join(' ') === 'status --json') {
          return JSON.stringify({
            BackendState: 'Running',
            Self: { DNSName: 'desktop.tail5a2d2d.ts.net.' },
          });
        }
        if (
          command === 'tailscale' &&
          args.join(' ').startsWith('serve --bg --yes http://127.0.0.1:')
        ) {
          throw new CommandExecutionError({
            message: 'Command timed out after 5000ms',
            stdout: `Serve is not enabled on your tailnet.
To enable, visit:

         https://login.tailscale.com/f/serve?node=n2tFH92z1n11CNTRL
`,
            timedOut: true,
          });
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    });
    activeServer = server;

    const preferredUrl = new URL(connectInfo.preferredConnectUrl);
    expect(connectInfo.source).toBe('tailscale-direct');
    expect(preferredUrl.hostname).toBe('desktop.tail5a2d2d.ts.net');
    expect(connectInfo.tailscale).toEqual({
      dnsName: 'desktop.tail5a2d2d.ts.net',
      directConnectUrl: connectInfo.preferredConnectUrl,
      secureConnectUrl: 'https://desktop.tail5a2d2d.ts.net',
      serveCommand: `tailscale serve --bg --yes http://127.0.0.1:${preferredUrl.port}`,
      serveEnabled: false,
      serveFallbackReason:
        'Tailscale Serve needs one-time approval from the tailnet DNS settings.',
      serveSetupUrl: 'https://login.tailscale.com/admin/dns',
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toBe('tailscale status --json');
    expect(invocations[1]).toMatch(
      /^tailscale serve --bg --yes http:\/\/127\.0\.0\.1:\d+$/
    );
  });

  it('returns an authenticated pairing QR payload for the preferred connect URL', async () => {
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      publicUrl: 'https://hub.example.test/connect',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/api/pairing-qr`, {
      headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      connectUrl: string;
      dataUrl: string;
    };
    expect(payload.connectUrl).toBe(
      'https://hub.example.test/connect#accessCode=secret-token'
    );
    expect(payload.dataUrl).toMatch(/^data:image\/png;base64,/);
  });
});

describe('buildManagerUiUrl', () => {
  it('builds a same-origin manager path under the preferred connect URL', () => {
    const url = buildManagerUiUrl({
      connectInfo: {
        preferredConnectUrl: 'https://hub.example.test/connect',
        source: 'public-url',
        tailscale: null,
      },
      authConfig: {
        required: true,
        token: 'secret-token',
      },
    });
    expect(url).toBe(
      'https://hub.example.test/connect/manager/#accessCode=secret-token'
    );
  });

  it('keeps a local listen URL on the hub origin instead of synthesizing TLS on the manager port', () => {
    const url = buildManagerUiUrl({
      connectInfo: {
        preferredConnectUrl: 'http://127.0.0.1:3360',
        source: 'listen-url',
        tailscale: null,
      },
      authConfig: {
        required: false,
        token: null,
      },
    });
    expect(url).toBe('http://127.0.0.1:3360/manager/');
  });
});

describe('rewriteManagerGuiHtmlForHub', () => {
  it('rewrites the manager HTML to use the hub proxy path and the hub storage key', () => {
    const rewritten = rewriteManagerGuiHtmlForHub(
      `<!doctype html><html><body>
<script>
window.MANAGER_AUTH_REQUIRED = true;
window.MANAGER_AUTH_STORAGE_KEY = "thread-inbox.manager-token:D:\\\\ghws";
</script>
<script type="module" src="/manager-app.js"></script>
</body></html>`,
      {
        storageKey: 'workspace-agent-hub.test-token',
      }
    );

    expect(rewritten).toContain('src="/manager/manager-app.js"');
    expect(rewritten).toContain('window.fetch = function (input, init)');
    expect(rewritten).toContain('workspace-agent-hub.test-token');
  });
});

describe('probeManagerGuiInstance', () => {
  let mockGuiServer: Server | null = null;

  afterEach(async () => {
    if (mockGuiServer) {
      await new Promise<void>((r) => mockGuiServer!.close(() => r()));
      mockGuiServer = null;
    }
  });

  it('accepts only a matching manager-gui instance for the current workspace and auth token', async () => {
    mockGuiServer = await startMockManagerGuiServer({
      workspaceRoot: 'D:\\ghws',
      authToken: 'secret-token',
    });
    const address = mockGuiServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    await expect(
      probeManagerGuiInstance({
        host: '127.0.0.1',
        port,
        workspaceRoot: 'D:\\ghws',
        authRequired: true,
        authToken: 'secret-token',
      })
    ).resolves.toEqual({
      state: 'ready',
      reason: 'Manager GUI is already running for this workspace.',
    });
  });

  it('rejects an unrelated HTTP server on the manager port', async () => {
    const unrelatedServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not a manager');
    });
    await new Promise<void>((resolve) =>
      unrelatedServer.listen(0, '127.0.0.1', resolve)
    );
    mockGuiServer = unrelatedServer;
    const address = unrelatedServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const result = await probeManagerGuiInstance({
      host: '127.0.0.1',
      port,
      workspaceRoot: 'D:\\ghws',
      authRequired: true,
      authToken: 'secret-token',
    });
    expect(result.state).toBe('conflict');
    expect(result.reason).toContain('different service or workspace');
  });

  it('rejects a manager-gui instance that does not accept the current hub token', async () => {
    mockGuiServer = await startMockManagerGuiServer({
      workspaceRoot: 'D:\\ghws',
      authToken: 'other-token',
    });
    const address = mockGuiServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const result = await probeManagerGuiInstance({
      host: '127.0.0.1',
      port,
      workspaceRoot: 'D:\\ghws',
      authRequired: true,
      authToken: 'secret-token',
    });
    expect(result.state).toBe('conflict');
    expect(result.reason).toContain('access code');
  });
});

describe('Manager GUI ensure endpoint', () => {
  let mockGuiServer: Server | null = null;

  afterEach(async () => {
    if (mockGuiServer) {
      await new Promise<void>((r) => mockGuiServer!.close(() => r()));
      mockGuiServer = null;
    }
  });

  it('returns a hub-relative manager URL and alreadyRunning=true when the matching manager server is already up', async () => {
    mockGuiServer = await startMockManagerGuiServer({
      workspaceRoot: 'D:\\ghws',
      authToken: 'secret-token',
    });
    const guiAddress = mockGuiServer.address();
    const guiPort =
      typeof guiAddress === 'object' && guiAddress ? guiAddress.port : 3335;

    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
      managerGuiPort: guiPort,
    });
    activeServer = server;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/manager-gui/ensure`,
      {
        method: 'POST',
        headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
      }
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      url: string;
      alreadyRunning: boolean;
    };
    expect(payload).toEqual({
      url: `http://127.0.0.1:${port}/manager/#accessCode=secret-token`,
      alreadyRunning: true,
    });
  });

  it('fails safely when the configured manager port is occupied by a different service', async () => {
    const unrelatedServer = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not a manager');
    });
    await new Promise<void>((resolve) =>
      unrelatedServer.listen(0, '127.0.0.1', resolve)
    );
    mockGuiServer = unrelatedServer;
    const guiAddress = unrelatedServer.address();
    const guiPort =
      typeof guiAddress === 'object' && guiAddress ? guiAddress.port : 3335;

    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
      managerGuiPort: guiPort,
    });
    activeServer = server;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/manager-gui/ensure`,
      {
        method: 'POST',
        headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
      }
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('different service or workspace'),
    });
  });

  it('proxies the manager page and API through the hub origin', async () => {
    mockGuiServer = await startMockManagerGuiServer({
      workspaceRoot: 'D:\\ghws',
      authToken: 'secret-token',
    });
    const guiAddress = mockGuiServer.address();
    const guiPort =
      typeof guiAddress === 'object' && guiAddress ? guiAddress.port : 3335;

    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
      managerGuiPort: guiPort,
    });
    activeServer = server;

    const pageResponse = await fetch(`http://127.0.0.1:${port}/manager/`);
    expect(pageResponse.status).toBe(200);
    const pageHtml = await pageResponse.text();
    expect(pageHtml).toContain('src="/manager/manager-app.js"');
    expect(pageHtml).toContain(
      'window.MANAGER_AUTH_STORAGE_KEY = "workspace-agent-hub.token:D:\\\\ghws";'
    );

    const unauthorizedApiResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`
    );
    expect(unauthorizedApiResponse.status).toBe(401);

    const authorizedApiResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      {
        headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
      }
    );
    expect(authorizedApiResponse.status).toBe(200);
    await expect(authorizedApiResponse.json()).resolves.toMatchObject({
      running: true,
      configured: true,
      builtinBackend: true,
    });
  });

  it('requires auth before attempting to start the Manager GUI', async () => {
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(
      `http://127.0.0.1:${port}/api/manager-gui/ensure`,
      { method: 'POST' }
    );
    expect(response.status).toBe(401);
  });
});
