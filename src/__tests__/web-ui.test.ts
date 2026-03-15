import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { buildWebUiLaunchInfo, createWebUiServer } from '../web-ui.js';
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
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toBe('tailscale status --json');
    expect(invocations[1]).toMatch(
      /^tailscale serve --bg --yes http:\/\/127\.0\.0\.1:\d+$/
    );
  });

  it('falls back to a direct tailnet URL when Tailscale Serve does not complete', async () => {
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
          throw new Error('Command timed out after 5000ms');
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
      serveFallbackReason: 'Command timed out after 5000ms',
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
