import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildBrowserOpenCommand,
  CommandExecutionError,
  buildBrowserOpenUrl,
  buildWebUiLaunchInfo,
  createWebUiServer,
  extractTailscaleServeSetupUrl,
  runCommand,
} from '../web-ui.js';
import * as managerBackend from '../manager-backend.js';
import { execGit } from '../manager-worktree.js';
import { writeManagerThreadMeta } from '../manager-thread-state.js';
import * as managerThreadState from '../manager-thread-state.js';
import type { SessionBridge } from '../session-bridge.js';
import type {
  DirectorySuggestion,
  HubLiveUpdateWatchConfig,
  SessionMutationResult,
  SessionRecord,
  SessionTranscript,
  SessionType,
} from '../types.js';
import {
  removeTempDirWithRetries,
  WINDOWS_SLOW_TEST_TIMEOUT_MS,
} from './temp-dir-test-helpers.js';

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
  constructor(
    private readonly workspaceRoot = 'D:\\ghws',
    private readonly liveWatchConfig: HubLiveUpdateWatchConfig | null = null
  ) {}

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
    return this.workspaceRoot;
  }

  getHubLiveUpdateWatchConfig(): HubLiveUpdateWatchConfig | null {
    return this.liveWatchConfig;
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
      WorkingDirectoryWindows: input.workingDirectory || this.workspaceRoot,
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
      { label: 'Workspace root', path: this.workspaceRoot },
      {
        label: 'workspace-agent-hub',
        path: join(this.workspaceRoot, 'workspace-agent-hub'),
      },
    ];
  }
}

let activeServer: Server | null = null;
const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'workspace-agent-hub-test-'));
  tempDirs.push(dir);
  return dir;
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  const init = await execGit(repoRoot, ['init']);
  expect(init.code).toBe(0);
  await writeFile(join(repoRoot, 'README.md'), '# repo\n', 'utf8');
}

async function readNdjsonObjects(
  response: Response,
  maxObjects: number
): Promise<unknown[]> {
  const objects: unknown[] = [];
  const reader = response.body?.getReader();
  if (!reader) {
    return objects;
  }
  const decoder = new TextDecoder();
  let buffer = '';

  while (objects.length < maxObjects) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      objects.push(JSON.parse(trimmed));
      if (objects.length >= maxObjects) {
        await reader.cancel();
        break;
      }
    }
  }

  return objects;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = null;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removeTempDirWithRetries(dir);
  }
});

describe('web UI server', () => {
  it('builds machine-readable launch metadata for automation clients', () => {
    expect(
      buildWebUiLaunchInfo({
        host: '127.0.0.1',
        port: 3360,
        workspaceRoot: 'D:\\ghws',
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
      workspaceRoot: 'D:\\ghws',
      preferredConnectUrl: 'https://hub.example.test/connect',
      preferredConnectUrlSource: 'public-url',
      authRequired: true,
      accessCode: 'secret-token',
      oneTapPairingLink:
        'https://hub.example.test/connect#accessCode=secret-token',
      tailscale: null,
    });
  });

  it('builds machine-readable launch metadata without an access code when auth is disabled', () => {
    expect(
      buildWebUiLaunchInfo({
        host: '127.0.0.1',
        port: 3360,
        workspaceRoot: 'D:\\ghws',
        authConfig: {
          required: false,
          token: null,
          storageKey: 'workspace-agent-hub.token:D:\\ghws',
        },
        connectInfo: {
          preferredConnectUrl: 'https://desktop.tail5a2d2d.ts.net',
          source: 'tailscale-serve',
          tailscale: null,
        },
      })
    ).toEqual({
      listenUrl: 'http://127.0.0.1:3360',
      workspaceRoot: 'D:\\ghws',
      preferredConnectUrl: 'https://desktop.tail5a2d2d.ts.net',
      preferredConnectUrlSource: 'tailscale-serve',
      authRequired: false,
      accessCode: null,
      oneTapPairingLink: 'https://desktop.tail5a2d2d.ts.net',
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
        { timeoutMs: 1000 }
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

  it('serves sessions without an access code when auth is disabled', async () => {
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(),
      host: '127.0.0.1',
      port: 0,
      authToken: 'none',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(response.status).toBe(200);
    const listed = (await response.json()) as SessionRecord[];
    expect(listed[0]?.Name).toBe('shell-existing');
  });

  it('streams Hub live snapshots for sessions and selected transcript updates', async () => {
    const bridge = new FakeBridge();
    const { server, port } = await createWebUiServer({
      bridge,
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = { 'X-Workspace-Agent-Hub-Token': 'secret-token' };
    const liveResponse = await fetch(
      `http://127.0.0.1:${port}/api/live?includeArchived=true&selectedSession=shell-existing&lines=500`,
      { headers }
    );

    expect(liveResponse.status).toBe(200);
    expect(liveResponse.headers.get('content-type')).toContain(
      'application/x-ndjson'
    );

    const [snapshot] = (await readNdjsonObjects(liveResponse, 1)) as Array<{
      kind: string;
      sessions: SessionRecord[];
      selectedSessionName: string | null;
      selectedTranscript: SessionTranscript | null;
    }>;

    expect(snapshot.kind).toBe('snapshot');
    expect(snapshot.sessions[0]?.Name).toBe('shell-existing');
    expect(snapshot.selectedSessionName).toBe('shell-existing');
    expect(snapshot.selectedTranscript?.Transcript).toContain(
      'hello from transcript'
    );
  });

  it('pushes a new Hub snapshot when the authoritative session-live files change', async () => {
    const handoffRoot = await createTempWorkspace();
    const sessionLiveDirPath = join(handoffRoot, 'session-live');
    const sessionCatalogPath = join(handoffRoot, 'session-catalog.json');
    await mkdir(sessionLiveDirPath, { recursive: true });
    await writeFile(sessionCatalogPath, '[]', 'utf8');
    await writeFile(join(sessionLiveDirPath, 'shell-existing.log'), '', 'utf8');

    const bridge = new FakeBridge('D:\\ghws', {
      watchRootPath: handoffRoot,
      sessionCatalogPath,
      sessionLiveDirPath,
    });
    const { server, port } = await createWebUiServer({
      bridge,
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = { 'X-Workspace-Agent-Hub-Token': 'secret-token' };
    const liveResponse = await fetch(
      `http://127.0.0.1:${port}/api/live?includeArchived=true&selectedSession=shell-existing&lines=500`,
      { headers }
    );

    expect(liveResponse.status).toBe(200);
    const reader = liveResponse.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buffer = '';
    const snapshots: Array<{
      kind: string;
      selectedTranscript: SessionTranscript | null;
    }> = [];

    async function readSnapshot(): Promise<{
      kind: string;
      selectedTranscript: SessionTranscript | null;
    }> {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) {
          throw new Error(
            'Live stream closed before the next snapshot arrived.'
          );
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const parsed = JSON.parse(trimmed) as {
            kind: string;
            selectedTranscript: SessionTranscript | null;
          };
          if (parsed.kind !== 'snapshot') {
            continue;
          }
          snapshots.push(parsed);
          return parsed;
        }
      }
    }

    const initialSnapshot = await readSnapshot();
    expect(initialSnapshot.selectedTranscript?.Transcript).toContain(
      'hello from transcript'
    );

    bridge.transcripts.set('shell-existing', {
      SessionName: 'shell-existing',
      WorkingDirectoryWsl: '/mnt/d/ghws',
      Transcript: 'updated from authoritative event source',
      CapturedAtUtc: new Date().toISOString(),
    });
    await appendFile(
      join(sessionLiveDirPath, 'shell-existing.log'),
      'updated\n',
      'utf8'
    );

    const updatedSnapshot = await readSnapshot();
    expect(updatedSnapshot.selectedTranscript?.Transcript).toContain(
      'updated from authoritative event source'
    );

    await reader!.cancel();
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
      connectUrlProbe: async () => ({
        reachable: true,
        detail: null,
      }),
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

  it('falls back to the direct tailnet URL when HTTPS probing reports 502 after serve setup', async () => {
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
          return '';
        }
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
      connectUrlProbe: async () => ({
        reachable: false,
        detail: 'HTTP 502',
      }),
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
        'Tailscale HTTPS endpoint is not reachable yet (HTTP 502).',
      serveSetupUrl: 'https://login.tailscale.com/admin/dns',
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

describe('native manager page', () => {
  it('serves manager.html at /manager/ with injected config', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/manager/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('マネージャー');
    expect(html).toContain('MANAGER_AUTH_REQUIRED');
    expect(html).toContain('<base href="/manager/" />');
    expect(html).toContain(
      '<link rel="icon" href="/icon.svg" type="image/svg+xml" />'
    );
  });

  it('also serves manager page at /manager without trailing slash', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(`http://127.0.0.1:${port}/manager`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('マネージャー');
    expect(html).toContain('<base href="/manager/" />');
  });

  it('requires auth for /manager/api/ routes and can start the built-in manager', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const unauthResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`
    );
    expect(unauthResponse.status).toBe(401);

    const authResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      { headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' } }
    );
    expect(authResponse.status).toBe(200);
    await expect(authResponse.json()).resolves.toMatchObject({
      running: false,
      configured: true,
      builtinBackend: true,
    });

    const startResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/start`,
      {
        method: 'POST',
        headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
      }
    );
    expect(startResponse.status).toBe(200);

    const afterStartResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      { headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' } }
    );
    expect(afterStartResponse.status).toBe(200);
    await expect(afterStartResponse.json()).resolves.toMatchObject({
      running: true,
      configured: true,
      builtinBackend: true,
    });
  });

  it('serves manager status from the latest published live snapshot', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = { 'X-Workspace-Agent-Hub-Token': 'secret-token' };
    const liveResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/live`,
      { headers }
    );
    expect(liveResponse.status).toBe(200);

    const reader = liveResponse.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buffer = '';

    async function readSnapshot(): Promise<{
      kind: string;
      status: {
        running: boolean;
        detail: string;
        pendingCount: number;
      };
    }> {
      while (true) {
        const { done, value } = await reader!.read();
        if (done) {
          throw new Error(
            'Manager live stream closed before the next snapshot arrived.'
          );
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const parsed = JSON.parse(trimmed) as {
            kind: string;
            status: {
              running: boolean;
              detail: string;
              pendingCount: number;
            };
          };
          if (parsed.kind !== 'snapshot') {
            continue;
          }
          return parsed;
        }
      }
    }

    const initialSnapshot = await readSnapshot();
    expect(initialSnapshot.status.pendingCount).toBe(0);
    expect(initialSnapshot.status.running).toBe(false);

    await writeFile(
      join(workspaceRoot, '.workspace-agent-hub-manager-queue.jsonl'),
      `${JSON.stringify({
        id: 'q_pending',
        threadId: 'thread-pending',
        content: 'pending work',
        createdAt: new Date().toISOString(),
        processed: false,
      })}\n`,
      'utf8'
    );

    const unpublishedStatusResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      { headers }
    );
    expect(unpublishedStatusResponse.status).toBe(200);
    await expect(unpublishedStatusResponse.json()).resolves.toMatchObject(
      initialSnapshot.status
    );

    const updatedSnapshot = await readSnapshot();
    expect(updatedSnapshot.status.running).toBe(true);
    expect(updatedSnapshot.status.pendingCount).toBe(1);
    expect(updatedSnapshot.status.detail).toContain('キュー: 1件');

    const refreshedStatusResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      { headers }
    );
    expect(refreshedStatusResponse.status).toBe(200);
    await expect(refreshedStatusResponse.json()).resolves.toMatchObject(
      updatedSnapshot.status
    );

    await reader?.cancel();
  });

  it('returns an explicit error instead of hanging when the initial manager live snapshot cannot be built', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    vi.spyOn(
      managerThreadState,
      'reconcileManagerThreadMeta'
    ).mockRejectedValue(new Error('snapshot bootstrap failed'));

    const response = await fetch(`http://127.0.0.1:${port}/manager/api/live`, {
      headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Failed to build manager live snapshot'),
    });
  });

  it('keeps manager status and live bootstrap responsive even if builtin status reconciliation stalls', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    vi.spyOn(managerBackend, 'getBuiltinManagerStatus').mockImplementation(
      () => new Promise(() => {})
    );

    const headers = { 'X-Workspace-Agent-Hub-Token': 'secret-token' };

    const statusResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      {
        headers,
        signal: AbortSignal.timeout(2000),
      }
    );
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      running: false,
      configured: true,
      builtinBackend: true,
    });

    const liveResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/live`,
      {
        headers,
        signal: AbortSignal.timeout(2000),
      }
    );
    expect(liveResponse.status).toBe(200);
    await expect(readNdjsonObjects(liveResponse, 1)).resolves.toEqual([
      expect.objectContaining({
        kind: 'snapshot',
        status: expect.objectContaining({
          running: false,
          configured: true,
          builtinBackend: true,
        }),
      }),
    ]);
  });

  it('kicks idle queued manager work from status polling even when only a stale lastErrorMessage remains', async () => {
    const workspaceRoot = await createTempWorkspace();
    await managerBackend.writeSession(workspaceRoot, {
      workspaceKey: 'workspace-key',
      status: 'idle',
      sessionId: null,
      routingSessionId: null,
      pid: null,
      currentQueueId: null,
      startedAt: '2026-04-18T00:00:00.000Z',
      lastMessageAt: '2026-04-18T00:00:00.000Z',
      priorityStreak: 0,
      lastProgressAt: null,
      lastErrorMessage: 'stale worker error',
      lastErrorAt: '2026-04-18T00:00:01.000Z',
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
    });
    await managerBackend.writeQueue(workspaceRoot, [
      {
        id: 'q_pending',
        threadId: 'thread-pending',
        content: 'resume pending task',
        attachments: [],
        dispatchMode: 'manager-evaluate',
        targetKind: null,
        repoId: null,
        newRepoName: null,
        workingDirectory: null,
        writeScopes: [],
        targetRepoRoot: null,
        requestedRunMode: null,
        requestedWorkerRuntime: null,
        createdAt: '2026-04-18T00:00:02.000Z',
        processed: false,
        priority: 'normal',
      },
    ]);
    const kickSpy = vi
      .spyOn(managerBackend, 'kickIdleQueuedManagerWork')
      .mockResolvedValue(true);

    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      { headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' } }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      health: 'ok',
      pendingCount: 1,
      errorMessage: null,
    });
    expect(kickSpy).toHaveBeenCalledWith(workspaceRoot, 'direct-status');
  });

  it('does not kick idle queued manager work while the manager is paused', async () => {
    const workspaceRoot = await createTempWorkspace();
    await managerBackend.writeSession(workspaceRoot, {
      workspaceKey: 'workspace-key',
      status: 'idle',
      sessionId: null,
      routingSessionId: null,
      pid: null,
      currentQueueId: null,
      startedAt: '2026-04-18T00:00:00.000Z',
      lastMessageAt: '2026-04-18T00:00:00.000Z',
      priorityStreak: 0,
      lastProgressAt: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      lastPauseMessage: 'Codex usage limit',
      lastPauseAt: '2026-04-18T00:00:01.000Z',
      lastPauseAutoResumeAt: null,
      activeAssignments: [],
      dispatchingThreadId: null,
      dispatchingQueueEntryIds: [],
      dispatchingAssigneeKind: null,
      dispatchingAssigneeLabel: null,
      dispatchingDetail: null,
      dispatchingStartedAt: null,
    });
    await managerBackend.writeQueue(workspaceRoot, [
      {
        id: 'q_pending',
        threadId: 'thread-pending',
        content: 'resume pending task',
        attachments: [],
        dispatchMode: 'manager-evaluate',
        targetKind: null,
        repoId: null,
        newRepoName: null,
        workingDirectory: null,
        writeScopes: [],
        targetRepoRoot: null,
        requestedRunMode: null,
        requestedWorkerRuntime: null,
        createdAt: '2026-04-18T00:00:02.000Z',
        processed: false,
        priority: 'normal',
      },
    ]);
    const kickSpy = vi
      .spyOn(managerBackend, 'kickIdleQueuedManagerWork')
      .mockResolvedValue(true);

    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const response = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/status`,
      { headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' } }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      health: 'paused',
      pendingCount: 1,
      errorMessage: 'Codex usage limit',
    });
    expect(kickSpy).not.toHaveBeenCalled();
  });

  it('creates and lists threads through the native manager API', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = {
      'X-Workspace-Agent-Hub-Token': 'secret-token',
      'Content-Type': 'application/json',
    };

    const createRes = await fetch(
      `http://127.0.0.1:${port}/manager/api/threads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Test thread' }),
      }
    );
    expect(createRes.status).toBe(201);
    const thread = (await createRes.json()) as {
      id: string;
      title: string;
      status: string;
    };
    expect(thread.title).toBe('Test thread');
    expect(thread.status).toBe('active');
    expect(typeof thread.id).toBe('string');

    const listRes = await fetch(
      `http://127.0.0.1:${port}/manager/api/threads`,
      { headers }
    );
    expect(listRes.status).toBe(200);
    const threads = (await listRes.json()) as { id: string }[];
    expect(threads.some((t) => t.id === thread.id)).toBe(true);
  });

  it('preserves dirty seed changes including untracked files through the native manager API', async () => {
    const workspaceRoot = await createTempWorkspace();
    const repoRoot = join(workspaceRoot, 'repo-managed');
    await initGitRepo(repoRoot);
    expect(
      (await execGit(repoRoot, ['config', 'user.email', 'test@example.com']))
        .code
    ).toBe(0);
    expect(
      (await execGit(repoRoot, ['config', 'user.name', 'Test User'])).code
    ).toBe(0);
    expect((await execGit(repoRoot, ['add', 'README.md'])).code).toBe(0);
    expect(
      (await execGit(repoRoot, ['commit', '-m', 'initial commit'])).code
    ).toBe(0);
    await writeFile(join(repoRoot, 'README.md'), '# repo\nchanged\n', 'utf8');
    await writeFile(join(repoRoot, 'notes.txt'), 'scratch\n', 'utf8');

    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = {
      'X-Workspace-Agent-Hub-Token': 'secret-token',
      'Content-Type': 'application/json',
    };
    const createRes = await fetch(
      `http://127.0.0.1:${port}/manager/api/threads`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Dirty seed recovery' }),
      }
    );
    expect(createRes.status).toBe(201);
    const thread = (await createRes.json()) as { id: string };

    await writeManagerThreadMeta(workspaceRoot, {
      [thread.id]: {
        managerOwned: true,
        seedRecoveryPending: true,
        seedRecoveryRepoRoot: repoRoot,
        seedRecoveryRepoLabel: 'repo-managed',
        seedRecoveryChangedFiles: ['README.md', 'notes.txt'],
      },
    });

    const preserveResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/threads/${thread.id}/preserve-and-continue`,
      {
        method: 'POST',
        headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
      }
    );
    expect(preserveResponse.status).toBe(200);
    await expect(preserveResponse.json()).resolves.toMatchObject({
      preserved: true,
      repoRoot,
      repoLabel: 'repo-managed',
      changedFiles: ['README.md', 'notes.txt'],
    });

    const statusResult = await execGit(repoRoot, ['status', '--porcelain']);
    expect(statusResult.code).toBe(0);
    expect(statusResult.stdout.trim()).toBe('');

    const stashListResult = await execGit(repoRoot, [
      'stash',
      'list',
      '-1',
      '--format=%gs',
    ]);
    expect(stashListResult.code).toBe(0);
    expect(stashListResult.stdout).toContain(
      `workspace-agent-hub manager preserve ${thread.id}`
    );
  }, 30000);

  it('returns tasks from the native manager API', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const res = await fetch(`http://127.0.0.1:${port}/manager/api/tasks`, {
      headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
    });
    expect(res.status).toBe(200);
    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);
  });

  it('does not expose a user-facing managed repo registration API', async () => {
    const workspaceRoot = await createTempWorkspace();
    const repoRoot = join(workspaceRoot, 'repo-managed');
    await initGitRepo(repoRoot);

    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = {
      'X-Workspace-Agent-Hub-Token': 'secret-token',
      'Content-Type': 'application/json',
    };
    const saveResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/repos`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          label: 'Managed Repo',
          repoRoot,
          defaultBranch: 'main',
          verifyCommand: 'npm run verify',
        }),
      }
    );
    expect(saveResponse.status).toBe(404);

    const listResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/repos`,
      {
        headers: { 'X-Workspace-Agent-Hub-Token': 'secret-token' },
      }
    );
    expect(listResponse.status).toBe(404);
  });

  it('does not expose the removed new-task creation API', async () => {
    const workspaceRoot = await createTempWorkspace();
    const { server, port } = await createWebUiServer({
      bridge: new FakeBridge(workspaceRoot),
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret-token',
      openBrowser: false,
    });
    activeServer = server;

    const headers = {
      'X-Workspace-Agent-Hub-Token': 'secret-token',
      'Content-Type': 'application/json',
    };
    const createResponse = await fetch(
      `http://127.0.0.1:${port}/manager/api/manager/runs`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Workspace Agent Broker を作る',
          content: '新しい repo を作成してください',
          runMode: 'write',
        }),
      }
    );
    expect(createResponse.status).toBe(404);
  });
});
