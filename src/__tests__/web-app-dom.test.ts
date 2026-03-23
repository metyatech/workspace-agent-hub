import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const baseHtml = `
<!doctype html>
<html>
  <body>
    <div class="shell">
    <div id="sessionsList"></div>
    <button id="refreshSessionsButton"></button>
    <select id="sessionTypeSelect"><option value="shell">shell</option></select>
    <span id="sessionTypeHint">迷ったら Codex です。普通のターミナルだけ開きたいときは Shell を選びます。</span>
    <input id="sessionTitleInput" />
    <input id="workingDirectoryInput" />
    <datalist id="workingDirectorySuggestions"></datalist>
    <button id="startSessionButton">start</button>
    <div id="lastSessionCard" hidden>
      <span id="lastSessionTitle"></span>
      <div id="lastSessionMeta"></div>
      <button id="openLastSessionButton">open last</button>
    </div>
    <button id="showArchivedButton">toggle</button>
    <input id="sessionSearchInput" />
    <button id="favoriteSessionsOnlyButton">favorites</button>
    <span id="sessionsListHint"></span>
    <span id="selectedSessionState"></span>
    <div id="selectedSessionSummary"></div>
    <div id="selectedSessionControls">
      <div id="promptComposerShell"></div>
      <span id="sessionPromptLead"></span>
      <span id="sessionPromptHint"></span>
    </div>
    <pre id="sessionTranscript"></pre>
    <textarea id="sessionPromptInput"></textarea>
    <button id="sendPromptButton">send</button>
    <button id="sendRawButton">send raw</button>
    <button id="renameSessionButton">rename</button>
    <button id="archiveSessionButton">archive</button>
    <button id="interruptSessionButton">interrupt</button>
    <button id="closeSessionButton">close</button>
    <button id="deleteSessionButton">delete</button>
    <span id="connectionHint"></span>
    <div id="connectivityBanner"></div>
    <p id="installHint"></p>
    <button id="installAppButton">install</button>
    <span id="installStatus"></span>
    <p id="notificationHint"></p>
    <button id="enableNotificationsButton">notify</button>
    <span id="notificationStatus"></span>
    <button id="lockDeviceButton">lock</button>
    <div id="deviceLockHint">ロックすると、このブラウザに保存したアクセスコードとキャッシュを消します。</div>
    <p id="pairingHint"></p>
    <input id="pairingUrlInput" />
    <button id="sharePairingButton">share</button>
    <button id="copyPairingLinkButton">copy link</button>
    <button id="copyManualUrlButton">copy url</button>
    <input id="pairingCodeInput" />
    <button id="copyPairingCodeButton">copy code</button>
    <img id="pairingQrImage" />
    <span id="pairingQrStatus"></span>
    <div id="secureLaunchShell">
      <input id="secureLaunchCommandInput" />
      <button id="openSecureLaunchSetupButton">open secure launch setup</button>
      <button id="copySecureLaunchCommandButton">copy secure launch</button>
      <span id="secureLaunchStatus"></span>
    </div>
    <div id="toast"></div>
    </div>
    <div id="authOverlay"></div>
    <input id="authTokenInput" />
    <button id="authSubmitButton">auth</button>
    <button id="openManagerButton">open manager</button>
    <span id="managerStatus"></span>
  </body>
</html>
`;

function waitForTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeNdjsonResponse(payloads: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const payload of payloads) {
        controller.enqueue(encoder.encode(JSON.stringify(payload) + '\n'));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
    },
  });
}

async function loadApp(
  fetchMock: typeof fetch,
  authRequired = false,
  options?: {
    beforeImport?: (window: Window) => void;
    secureContext?: boolean;
    url?: string;
    livePayloads?: unknown[];
    preferredConnectUrl?: string | null;
    preferredConnectUrlSource?:
      | 'listen-url'
      | 'public-url'
      | 'tailscale-direct'
      | 'tailscale-serve';
    tailscaleDirectUrl?: string | null;
    tailscaleSecureUrl?: string | null;
    tailscaleServeCommand?: string | null;
    tailscaleServeFallbackReason?: string | null;
    tailscaleServeSetupUrl?: string | null;
  }
): Promise<Document> {
  const dom = new JSDOM(baseHtml, {
    url: options?.url ?? 'http://127.0.0.1:3360/',
    pretendToBeVisual: true,
  });
  const wrappedFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pairing-qr')) {
        return new Response(
          JSON.stringify({
            connectUrl:
              'https://hub.example.test/connect#accessCode=pairing-token',
            dataUrl: 'data:image/png;base64,PAIRING',
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/live') && options?.livePayloads) {
        return makeNdjsonResponse(options.livePayloads);
      }
      return fetchMock(input, init);
    }
  ) as unknown as typeof fetch;

  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('fetch', wrappedFetch);

  Object.defineProperty(dom.window, 'WORKSPACE_AGENT_HUB_CONFIG', {
    value: {
      authRequired,
      authStorageKey: 'workspace-agent-hub.test-token',
      workspaceRoot: 'D:\\ghws',
      preferredConnectUrl: options?.preferredConnectUrl ?? null,
      preferredConnectUrlSource:
        options?.preferredConnectUrlSource ??
        (options?.preferredConnectUrl ? 'public-url' : 'listen-url'),
      tailscaleDirectUrl: options?.tailscaleDirectUrl ?? null,
      tailscaleSecureUrl: options?.tailscaleSecureUrl ?? null,
      tailscaleServeCommand: options?.tailscaleServeCommand ?? null,
      tailscaleServeFallbackReason:
        options?.tailscaleServeFallbackReason ?? null,
      tailscaleServeSetupUrl: options?.tailscaleServeSetupUrl ?? null,
    },
    configurable: true,
  });

  Object.defineProperty(dom.window.navigator, 'onLine', {
    value: true,
    configurable: true,
  });

  Object.defineProperty(dom.window, 'isSecureContext', {
    value: options?.secureContext ?? false,
    configurable: true,
  });

  Object.defineProperty(dom.window, 'matchMedia', {
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
    configurable: true,
  });

  Object.defineProperty(dom.window.navigator, 'serviceWorker', {
    value: {
      register: vi.fn().mockResolvedValue(undefined),
    },
    configurable: true,
  });

  Object.defineProperty(dom.window, 'setInterval', {
    value: vi.fn(dom.window.setInterval.bind(dom.window)),
    configurable: true,
  });

  class MockNotification {
    static permission: NotificationPermission = 'default';
    static requestPermission = vi
      .fn<() => Promise<NotificationPermission>>()
      .mockImplementation(async () => {
        MockNotification.permission = 'granted';
        return 'granted';
      });

    title: string;
    options?: NotificationOptions;
    onclick: (() => void) | null = null;

    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.options = options;
    }

    close(): void {
      /* noop */
    }
  }

  Object.defineProperty(dom.window, 'Notification', {
    value: MockNotification,
    configurable: true,
  });

  options?.beforeImport?.(dom.window as unknown as Window);

  vi.resetModules();
  await import('../web-app.js');
  await waitForTick();
  return dom.window.document;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  window.dispatchEvent(new window.Event('beforeunload'));
  vi.unstubAllGlobals();
});

describe('web-app DOM', () => {
  it('keeps the prompt area visible and disabled until a session is selected', async () => {
    const fetchMockImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const fetchMock = fetchMockImpl as unknown as typeof fetch;

    const document = await loadApp(fetchMock);
    expect(
      document.querySelector<HTMLSpanElement>('#selectedSessionState')!
        .textContent
    ).toContain('左で session を選ぶ');
    expect(
      document.querySelector<HTMLTextAreaElement>('#sessionPromptInput')!
        .disabled
    ).toBe(true);
    expect(
      document.querySelector<HTMLSpanElement>('#sessionPromptHint')!.textContent
    ).toContain('先に左の一覧');
    expect(
      document.querySelector<HTMLButtonElement>('#sendPromptButton')!.disabled
    ).toBe(true);
    expect(
      document.querySelector<HTMLSpanElement>('#sessionTypeHint')!.textContent
    ).toContain('迷ったら Codex');
    expect(
      document.querySelector<HTMLDivElement>('#deviceLockHint')!.textContent
    ).toContain('アクセスコードとキャッシュを消します');
  });

  it('renders fetched sessions and selects one on click', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(
          JSON.stringify([{ label: 'Workspace root', path: 'D:\\ghws' }]),
          { status: 200 }
        );
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(
          JSON.stringify([
            {
              Name: 'shell-demo',
              Type: 'shell',
              DisplayName: 'demo',
              Distro: 'Ubuntu',
              CreatedUnix: 1,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 2,
              LastActivityLocal: '2026-03-14 00:00:02',
              Title: 'Demo Session',
              WorkingDirectoryWindows: 'D:\\ghws',
              PreviewText: 'preview',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 2,
              DisplayTitle: 'Demo Session',
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/api/sessions/shell-demo/output')) {
        return new Response(
          JSON.stringify({
            SessionName: 'shell-demo',
            WorkingDirectoryWsl: '/mnt/d/ghws',
            Transcript: 'echo demo',
            CapturedAtUtc: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock);
    expect(document.querySelectorAll('.session-card')).toHaveLength(1);
    expect(
      document.querySelector<HTMLInputElement>('#workingDirectoryInput')!.value
    ).toBe('D:\\ghws');

    document.querySelector<HTMLDivElement>('.session-card')!.click();
    await waitForTick();

    expect(
      document.querySelector<HTMLSpanElement>('#selectedSessionState')!
        .textContent
    ).toContain('SHELL');
    expect(
      document.querySelector<HTMLPreElement>('#sessionTranscript')!.textContent
    ).toContain('echo demo');
    expect(
      document.querySelector<HTMLTextAreaElement>('#sessionPromptInput')!
        .disabled
    ).toBe(false);
  });

  it('focuses the prompt composer after starting a new session', async () => {
    const createdSession = {
      Name: 'shell-new',
      Type: 'shell',
      DisplayName: 'new',
      Distro: 'Ubuntu',
      CreatedUnix: 3,
      CreatedLocal: '2026-03-16 18:00:00',
      AttachedClients: 0,
      WindowCount: 1,
      LastActivityUnix: 3,
      LastActivityLocal: '2026-03-16 18:00:00',
      Title: 'テスト',
      WorkingDirectoryWindows: 'D:\\ghws',
      PreviewText: '',
      Archived: false,
      ClosedUtc: '',
      IsLive: true,
      State: 'Running',
      SortUnix: 3,
      DisplayTitle: 'テスト',
    };
    let sessionWasCreated = false;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/directories')) {
          return new Response(
            JSON.stringify([{ label: 'Workspace root', path: 'D:\\ghws' }]),
            { status: 200 }
          );
        }
        if (url.includes('/api/sessions?includeArchived=true')) {
          return new Response(
            JSON.stringify(sessionWasCreated ? [createdSession] : []),
            { status: 200 }
          );
        }
        if (url.endsWith('/api/sessions') && init?.method === 'POST') {
          sessionWasCreated = true;
          return new Response(JSON.stringify(createdSession), { status: 201 });
        }
        if (url.includes('/api/sessions/shell-new/output')) {
          return new Response(
            JSON.stringify({
              SessionName: 'shell-new',
              WorkingDirectoryWsl: '/mnt/d/ghws',
              Transcript: '',
              CapturedAtUtc: new Date().toISOString(),
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }
    ) as unknown as typeof fetch;

    const document = await loadApp(fetchMock);
    document.querySelector<HTMLInputElement>('#sessionTitleInput')!.value =
      'テスト';
    document.querySelector<HTMLButtonElement>('#startSessionButton')!.click();
    await waitForTick();
    await waitForTick();

    expect(
      document.querySelector<HTMLTextAreaElement>('#sessionPromptInput')!
        .disabled
    ).toBe(false);
    expect(document.activeElement?.id).toBe('sessionPromptInput');
    expect(
      document.querySelector<HTMLInputElement>('#sessionTitleInput')!.value
    ).toBe('');
    expect(
      document
        .querySelector<HTMLDivElement>('#promptComposerShell')!
        .classList.contains('attention')
    ).toBe(true);
  });

  it('navigates to the native manager page directly without a preflight ensure request', async () => {
    const fetchMockImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const fetchMock = fetchMockImpl as unknown as typeof fetch;

    const assignMock = vi.fn();
    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'manager-token'
        );
        (
          window as Window & {
            __WORKSPACE_AGENT_HUB_NAVIGATE__?: (nextUrl: string) => void;
          }
        ).__WORKSPACE_AGENT_HUB_NAVIGATE__ = assignMock;
      },
    });

    document.querySelector<HTMLButtonElement>('#openManagerButton')!.click();
    await waitForTick();

    expect(assignMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3360/manager/#accessCode=manager-token'
    );
    expect(
      fetchMockImpl.mock.calls.some(([input]) =>
        String(input).includes('/api/manager-gui/ensure')
      )
    ).toBe(false);
    expect(
      document.querySelector<HTMLSpanElement>('#managerStatus')!.textContent
    ).toContain('移動');
  });

  it('filters sessions by search text and keeps favorite sessions first', async () => {
    const fetchMockImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(
          JSON.stringify([
            {
              Name: 'shell-alpha',
              Type: 'shell',
              DisplayName: 'alpha',
              Distro: 'Ubuntu',
              CreatedUnix: 1,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 20,
              LastActivityLocal: '2026-03-14 00:00:20',
              Title: 'Alpha Session',
              WorkingDirectoryWindows: 'D:\\ghws\\alpha',
              PreviewText: 'preview alpha',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 20,
              DisplayTitle: 'Alpha Session',
            },
            {
              Name: 'codex-beta',
              Type: 'codex',
              DisplayName: 'beta',
              Distro: 'Ubuntu',
              CreatedUnix: 2,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 30,
              LastActivityLocal: '2026-03-14 00:00:30',
              Title: 'Beta Bugfix',
              WorkingDirectoryWindows: 'D:\\ghws\\workspace-agent-hub',
              PreviewText: 'bugfix follow-up',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 30,
              DisplayTitle: 'Beta Bugfix',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    });
    const fetchMock = fetchMockImpl as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.favorite-sessions',
          JSON.stringify(['shell-alpha'])
        );
      },
    });

    const titlesBefore = [
      ...document.querySelectorAll('.session-card .session-title'),
    ].map((element) => element.textContent);
    expect(titlesBefore).toEqual(['Alpha Session', 'Beta Bugfix']);

    const searchInput = document.querySelector<HTMLInputElement>(
      '#sessionSearchInput'
    )!;
    searchInput.value = 'bugfix';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForTick();

    const titlesAfterSearch = [
      ...document.querySelectorAll('.session-card .session-title'),
    ].map((element) => element.textContent);
    expect(titlesAfterSearch).toEqual(['Beta Bugfix']);
    expect(
      document.querySelector<HTMLSpanElement>('#sessionsListHint')!.textContent
    ).toContain('絞り込んでいます');
  });

  it('stores favorite toggles locally and can show only favorites', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(
          JSON.stringify([
            {
              Name: 'shell-alpha',
              Type: 'shell',
              DisplayName: 'alpha',
              Distro: 'Ubuntu',
              CreatedUnix: 1,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 10,
              LastActivityLocal: '2026-03-14 00:00:10',
              Title: 'Alpha Session',
              WorkingDirectoryWindows: 'D:\\ghws\\alpha',
              PreviewText: 'preview alpha',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 10,
              DisplayTitle: 'Alpha Session',
            },
            {
              Name: 'shell-beta',
              Type: 'shell',
              DisplayName: 'beta',
              Distro: 'Ubuntu',
              CreatedUnix: 2,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 9,
              LastActivityLocal: '2026-03-14 00:00:09',
              Title: 'Beta Session',
              WorkingDirectoryWindows: 'D:\\ghws\\beta',
              PreviewText: 'preview beta',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 9,
              DisplayTitle: 'Beta Session',
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock);
    const favoriteButtons = [
      ...document.querySelectorAll<HTMLButtonElement>('.favorite-button'),
    ];
    favoriteButtons[1]!.click();
    await waitForTick();

    expect(
      window.localStorage.getItem(
        'workspace-agent-hub.test-token.favorite-sessions'
      )
    ).toContain('shell-beta');

    document
      .querySelector<HTMLButtonElement>('#favoriteSessionsOnlyButton')!
      .click();
    await waitForTick();

    const titlesAfterFavoriteFilter = [
      ...document.querySelectorAll('.session-card .session-title'),
    ].map((element) => element.textContent);
    expect(titlesAfterFavoriteFilter).toEqual(['Beta Session']);
    expect(
      document.querySelector<HTMLSpanElement>('#sessionsListHint')!.textContent
    ).toContain('固定');
  });

  it('restores the remembered session and its saved prompt draft on reload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(
          JSON.stringify([
            {
              Name: 'codex-followup',
              Type: 'codex',
              DisplayName: 'followup',
              Distro: 'Ubuntu',
              CreatedUnix: 1,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 50,
              LastActivityLocal: '2026-03-14 00:00:50',
              Title: 'Follow-up',
              WorkingDirectoryWindows: 'D:\\ghws\\workspace-agent-hub',
              PreviewText: 'need one more change',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 50,
              DisplayTitle: 'Follow-up',
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/api/sessions/codex-followup/output')) {
        return new Response(
          JSON.stringify({
            SessionName: 'codex-followup',
            WorkingDirectoryWsl: '/mnt/d/ghws/workspace-agent-hub',
            Transcript: 'codex output',
            CapturedAtUtc: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.last-session-name',
          'codex-followup'
        );
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.session-drafts',
          JSON.stringify({ 'codex-followup': '続きの指示をあとで送る' })
        );
      },
    });

    expect(
      document.querySelector<HTMLSpanElement>('#selectedSessionState')!
        .textContent
    ).toContain('CODEX');
    expect(
      document.querySelector<HTMLTextAreaElement>('#sessionPromptInput')!.value
    ).toBe('続きの指示をあとで送る');
    expect(
      document.querySelector<HTMLDivElement>('#lastSessionCard')!.hidden
    ).toBe(false);
    expect(
      document.querySelector<HTMLDivElement>('#selectedSessionSummary')!
        .textContent
    ).toContain('下書きあり');

    const searchInput = document.querySelector<HTMLInputElement>(
      '#sessionSearchInput'
    )!;
    searchInput.value = 'missing';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForTick();

    document
      .querySelector<HTMLButtonElement>('#openLastSessionButton')!
      .click();
    await waitForTick();

    expect(searchInput.value).toBe('');
    expect(
      document.querySelector<HTMLSpanElement>('#selectedSessionState')!
        .textContent
    ).toContain('CODEX');
  });

  it('persists prompt drafts locally and surfaces unseen output badges', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(
          JSON.stringify([
            {
              Name: 'shell-alpha',
              Type: 'shell',
              DisplayName: 'alpha',
              Distro: 'Ubuntu',
              CreatedUnix: 1,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 15,
              LastActivityLocal: '2026-03-14 00:00:15',
              Title: 'Alpha Session',
              WorkingDirectoryWindows: 'D:\\ghws\\alpha',
              PreviewText: 'preview alpha',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 15,
              DisplayTitle: 'Alpha Session',
            },
            {
              Name: 'shell-beta',
              Type: 'shell',
              DisplayName: 'beta',
              Distro: 'Ubuntu',
              CreatedUnix: 2,
              CreatedLocal: '2026-03-14 00:00:00',
              AttachedClients: 0,
              WindowCount: 1,
              LastActivityUnix: 25,
              LastActivityLocal: '2026-03-14 00:00:25',
              Title: 'Beta Session',
              WorkingDirectoryWindows: 'D:\\ghws\\beta',
              PreviewText: 'preview beta',
              Archived: false,
              ClosedUtc: '',
              IsLive: true,
              State: 'Running',
              SortUnix: 25,
              DisplayTitle: 'Beta Session',
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('/api/sessions/shell-alpha/output')) {
        return new Response(
          JSON.stringify({
            SessionName: 'shell-alpha',
            WorkingDirectoryWsl: '/mnt/d/ghws/alpha',
            Transcript: 'alpha output',
            CapturedAtUtc: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/sessions/shell-beta/output')) {
        return new Response(
          JSON.stringify({
            SessionName: 'shell-beta',
            WorkingDirectoryWsl: '/mnt/d/ghws/beta',
            Transcript: 'beta output',
            CapturedAtUtc: new Date().toISOString(),
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.session-seen-activity',
          JSON.stringify({ 'shell-alpha': 15, 'shell-beta': 10 })
        );
      },
    });

    expect(
      [...document.querySelectorAll('.badge')].some(
        (element) => element.textContent === '新しい出力'
      )
    ).toBe(true);

    document.querySelector<HTMLDivElement>('.session-card')!.click();
    await waitForTick();

    const promptInput = document.querySelector<HTMLTextAreaElement>(
      '#sessionPromptInput'
    )!;
    promptInput.value = 'あとで送りたいメモ';
    promptInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await waitForTick();

    expect(
      window.localStorage.getItem(
        'workspace-agent-hub.test-token.session-drafts'
      )
    ).toContain('あとで送りたいメモ');

    const selectedCard = document.querySelector<HTMLDivElement>(
      '.session-card.selected'
    )!;
    expect(selectedCard.textContent).toContain('下書きあり');
    expect(selectedCard.textContent).not.toContain('新しい出力');
  });

  it('shows the auth overlay when auth is required and no token is saved', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Access code required' }), {
          status: 401,
        })
    ) as unknown as typeof fetch;
    const document = await loadApp(fetchMock, true);
    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(true);
    expect(document.documentElement.classList.contains('auth-locked')).toBe(
      true
    );
    expect(document.body.classList.contains('auth-locked')).toBe(true);
    expect(
      document
        .querySelector<HTMLDivElement>('.shell')!
        .getAttribute('aria-hidden')
    ).toBe('true');
  });

  it('renders cached sessions and offline state when refresh fails', async () => {
    const cachedSessions = [
      {
        Name: 'shell-offline',
        Type: 'shell',
        DisplayName: 'offline',
        Distro: 'Ubuntu',
        CreatedUnix: 1,
        CreatedLocal: '2026-03-14 00:00:00',
        AttachedClients: 0,
        WindowCount: 1,
        LastActivityUnix: 2,
        LastActivityLocal: '2026-03-14 00:00:02',
        Title: 'Offline Session',
        WorkingDirectoryWindows: 'D:\\ghws\\workspace-agent-hub',
        PreviewText: 'cached preview',
        Archived: false,
        ClosedUtc: '',
        IsLive: true,
        State: 'Running',
        SortUnix: 2,
        DisplayTitle: 'Offline Session',
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        throw new TypeError('Network down');
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        throw new TypeError('Network down');
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.sessions',
          JSON.stringify(cachedSessions)
        );
      },
    });

    expect(document.querySelectorAll('.session-card')).toHaveLength(1);
    expect(
      document.querySelector<HTMLSpanElement>('#connectionHint')!.textContent
    ).toContain('オフライン');
    expect(
      document.querySelector<HTMLDivElement>('#connectivityBanner')!.textContent
    ).toContain('最後に保存した');
  });

  it('enables the install button after beforeinstallprompt', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, { secureContext: true });
    const installButton =
      document.querySelector<HTMLButtonElement>('#installAppButton')!;
    expect(installButton.hidden).toBe(true);

    const prompt = vi.fn().mockResolvedValue(undefined);
    const installEvent = new window.Event('beforeinstallprompt') as Event & {
      prompt(): Promise<void>;
      userChoice: Promise<{
        outcome: 'accepted' | 'dismissed';
        platform: string;
      }>;
    };
    Object.defineProperty(installEvent, 'prompt', {
      value: prompt,
      configurable: true,
    });
    Object.defineProperty(installEvent, 'userChoice', {
      value: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
      configurable: true,
    });

    window.dispatchEvent(installEvent);
    await waitForTick();

    expect(installButton.hidden).toBe(false);
    installButton.click();
    await waitForTick();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('enables browser notifications after opt-in', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, { secureContext: true });
    document
      .querySelector<HTMLButtonElement>('#enableNotificationsButton')!
      .click();
    await waitForTick();

    expect(
      document.querySelector<HTMLSpanElement>('#notificationStatus')!
        .textContent
    ).toContain('有効');
  });

  it('locks the current device by clearing the stored token and reopening auth', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const confirmMock = vi.fn(() => true);
    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'cached-token'
        );
      },
      secureContext: true,
    });

    Object.defineProperty(window, 'confirm', {
      value: confirmMock,
      configurable: true,
    });

    document.querySelector<HTMLButtonElement>('#lockDeviceButton')!.click();
    await waitForTick();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('workspace-agent-hub.test-token')).toBe(
      null
    );
    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(true);
  });

  it('builds a one-tap pairing link from the preferred connect URL', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'pairing-token'
        );
      },
      preferredConnectUrl: 'https://hub.example.test/connect',
      secureContext: true,
    });

    expect(
      document.querySelector<HTMLInputElement>('#pairingUrlInput')!.value
    ).toContain('https://hub.example.test/connect#accessCode=pairing-token');
    expect(
      document.querySelector<HTMLInputElement>('#pairingCodeInput')!.value
    ).toBe('pairing-token');
    expect(
      document.querySelector<HTMLButtonElement>('#sharePairingButton')!
        .textContent
    ).toContain('共有文をコピー');
    expect(
      document.querySelector<HTMLParagraphElement>('#pairingHint')!.textContent
    ).toContain('まずこの QR');
    expect(
      document.querySelector<HTMLSpanElement>('#pairingQrStatus')!.textContent
    ).toContain('まずこれを読み取ってください');
  });

  it('surfaces a Tailscale direct URL and HTTPS upgrade command when available', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'pairing-token'
        );
      },
      preferredConnectUrl: 'http://desktop.tail5a2d2d.ts.net:3360',
      preferredConnectUrlSource: 'tailscale-direct',
      tailscaleDirectUrl: 'http://desktop.tail5a2d2d.ts.net:3360',
      tailscaleSecureUrl: 'https://desktop.tail5a2d2d.ts.net',
      tailscaleServeCommand: 'tailscale serve --bg --yes http://127.0.0.1:3360',
    });

    expect(
      document.querySelector<HTMLInputElement>('#pairingUrlInput')!.value
    ).toContain(
      'http://desktop.tail5a2d2d.ts.net:3360#accessCode=pairing-token'
    );
    expect(
      document.querySelector<HTMLParagraphElement>('#pairingHint')!.textContent
    ).toContain('まずこの QR');
    expect(
      document.querySelector<HTMLSpanElement>('#pairingQrStatus')!.textContent
    ).toContain('まずこれを読み取ってください');
    expect(
      document.querySelector<HTMLDivElement>('#secureLaunchShell')!.hidden
    ).toBe(false);
    expect(
      document.querySelector<HTMLInputElement>('#secureLaunchCommandInput')!
        .value
    ).toBe('tailscale serve --bg --yes http://127.0.0.1:3360');
    expect(
      document.querySelector<HTMLSpanElement>('#secureLaunchStatus')!
        .textContent
    ).toContain('https://desktop.tail5a2d2d.ts.net');
  });

  it('surfaces a one-time Tailscale Serve approval step when the tailnet has not enabled Serve yet', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'pairing-token'
        );
      },
      preferredConnectUrl: 'http://desktop.tail5a2d2d.ts.net:3360',
      preferredConnectUrlSource: 'tailscale-direct',
      tailscaleDirectUrl: 'http://desktop.tail5a2d2d.ts.net:3360',
      tailscaleSecureUrl: 'https://desktop.tail5a2d2d.ts.net',
      tailscaleServeCommand: 'tailscale serve --bg --yes http://127.0.0.1:3360',
      tailscaleServeSetupUrl: 'https://login.tailscale.com/admin/dns',
    });

    expect(
      document.querySelector<HTMLButtonElement>('#openSecureLaunchSetupButton')!
        .hidden
    ).toBe(false);
    expect(
      document.querySelector<HTMLSpanElement>('#secureLaunchStatus')!
        .textContent
    ).toContain(
      'DNS 設定ページで HTTPS Certificates を 1 回だけ有効にしてください'
    );
  });

  it('keeps the direct smartphone path when HTTPS tailnet probing reports 502', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'pairing-token'
        );
      },
      preferredConnectUrl: 'http://desktop.tail5a2d2d.ts.net:3360',
      preferredConnectUrlSource: 'tailscale-direct',
      tailscaleDirectUrl: 'http://desktop.tail5a2d2d.ts.net:3360',
      tailscaleSecureUrl: 'https://desktop.tail5a2d2d.ts.net',
      tailscaleServeCommand: 'tailscale serve --bg --yes http://127.0.0.1:3360',
      tailscaleServeFallbackReason:
        'Tailscale HTTPS endpoint is not reachable yet (HTTP 502).',
    });

    expect(
      document.querySelector<HTMLInputElement>('#pairingUrlInput')!.value
    ).toContain(
      'http://desktop.tail5a2d2d.ts.net:3360#accessCode=pairing-token'
    );
    expect(
      document.querySelector<HTMLSpanElement>('#pairingQrStatus')!.textContent
    ).toContain('まずこれを読み取ってください');
    expect(
      document.querySelector<HTMLSpanElement>('#secureLaunchStatus')!
        .textContent
    ).toContain('まだ使えません');
    expect(
      document.querySelector<HTMLSpanElement>('#secureLaunchStatus')!
        .textContent
    ).toContain('HTTP 502');
  });

  it('does not render a smartphone QR when the pairing URL only targets the local PC', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'pairing-token'
        );
      },
      preferredConnectUrl: null,
      url: 'http://127.0.0.1:3360/',
    });

    expect(
      document.querySelector<HTMLImageElement>('#pairingQrImage')!.hidden
    ).toBe(true);
    expect(
      document.querySelector<HTMLSpanElement>('#pairingQrStatus')!.textContent
    ).toContain('スマホ用 QR をまだ出せません');
    expect(
      document.querySelector<HTMLParagraphElement>('#pairingHint')!.textContent
    ).toContain('-PhoneReady');
  });

  it('accepts an access code from the pairing link hash on first load', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      secureContext: true,
      url: 'https://hub.example.test/#accessCode=hash-token',
      preferredConnectUrl: 'https://hub.example.test',
      preferredConnectUrlSource: 'public-url',
    });

    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(false);
    expect(document.documentElement.classList.contains('auth-locked')).toBe(
      false
    );
    expect(document.body.classList.contains('auth-locked')).toBe(false);
    expect(window.localStorage.getItem('workspace-agent-hub.test-token')).toBe(
      'hash-token'
    );
    expect(
      document.querySelector<HTMLImageElement>('#pairingQrImage')!.hidden
    ).toBe(false);
    expect(
      document.querySelector<HTMLSpanElement>('#pairingQrStatus')!.textContent
    ).toContain('まずこれを読み取ってください');
  });

  it('accepts an access code when the hash is added after the app is already open', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/api/pairing-qr')) {
        return new Response(
          JSON.stringify({
            connectUrl: 'https://hub.example.test/#accessCode=late-token',
            dataUrl: 'data:image/png;base64,late-qr',
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      secureContext: true,
      url: 'https://hub.example.test/',
      preferredConnectUrl: 'https://hub.example.test',
      preferredConnectUrlSource: 'public-url',
    });

    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(true);
    expect(
      document.querySelector<HTMLImageElement>('#pairingQrImage')!.hidden
    ).toBe(true);

    window.location.hash = '#accessCode=late-token';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    await waitForTick();
    await waitForTick();

    expect(window.localStorage.getItem('workspace-agent-hub.test-token')).toBe(
      'late-token'
    );
    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(false);
    expect(
      document.querySelector<HTMLImageElement>('#pairingQrImage')!.hidden
    ).toBe(false);
    expect(
      document.querySelector<HTMLSpanElement>('#pairingQrStatus')!.textContent
    ).toContain('まずこれを読み取ってください');
  });

  it('overrides a stale localStorage token when a newer access code is present in the URL hash', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        // Simulate a stale token from a previous server run stored in localStorage.
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'stale-old-token'
        );
      },
      secureContext: true,
      url: 'http://127.0.0.1:3360/#accessCode=fresh-new-token',
      preferredConnectUrl: 'https://desktop.tail5a2d2d.ts.net',
      preferredConnectUrlSource: 'tailscale-serve',
    });

    // The new token from the hash must replace the stale token.
    expect(window.localStorage.getItem('workspace-agent-hub.test-token')).toBe(
      'fresh-new-token'
    );
    // Auth overlay must not be shown — the hash token is sufficient.
    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(false);
    expect(document.documentElement.classList.contains('auth-locked')).toBe(
      false
    );
    expect(document.body.classList.contains('auth-locked')).toBe(false);
    // The QR must be visible with the new token.
    expect(
      document.querySelector<HTMLImageElement>('#pairingQrImage')!.hidden
    ).toBe(false);
    expect(
      document.querySelector<HTMLSpanElement>('#pairingQrStatus')!.textContent
    ).toContain('まずこれを読み取ってください');
  });

  it('shows the auth overlay when a stale localStorage token is rejected by the server (no hash)', async () => {
    // Stale-state path: token present in localStorage but no new hash in the URL.
    // The server (restarted) returns 401 for all requests → auth overlay must appear.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Access code required' }), {
          status: 401,
        })
    ) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        // A token from a previous server run sits in localStorage; no fresh hash is present.
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'stale-old-token'
        );
      },
      preferredConnectUrl: 'https://hub.example.test/connect',
      secureContext: true,
      // No url override → no #accessCode= hash.
    });

    // The stale token must not be treated as valid; overlay must be visible.
    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(true);
    expect(document.documentElement.classList.contains('auth-locked')).toBe(
      true
    );
    expect(document.body.classList.contains('auth-locked')).toBe(true);
    expect(
      document
        .querySelector<HTMLDivElement>('.shell')!
        .getAttribute('aria-hidden')
    ).toBe('true');
    // The QR must stay hidden because the token could not be validated.
    expect(
      document.querySelector<HTMLImageElement>('#pairingQrImage')!.hidden
    ).toBe(true);
  });

  it('uses the browser share API for pairing details when available', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const shareMock = vi.fn().mockResolvedValue(undefined);
    const document = await loadApp(fetchMock, true, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token',
          'pairing-token'
        );
        Object.defineProperty(window.navigator, 'share', {
          value: shareMock,
          configurable: true,
        });
      },
      preferredConnectUrl: 'https://hub.example.test/connect',
      secureContext: true,
    });

    document.querySelector<HTMLButtonElement>('#sharePairingButton')!.click();
    await waitForTick();

    expect(shareMock).toHaveBeenCalledWith({
      title: 'Workspace Agent Hub',
      text: [
        'Workspace Agent Hub',
        '接続先: https://hub.example.test/connect#accessCode=pairing-token',
        'アクセスコード: pairing-token',
      ].join('\n'),
      url: 'https://hub.example.test/connect#accessCode=pairing-token',
    });
  });

  it('keeps the selected summary unarchived even if the next list poll is stale', async () => {
    let listResponses = 0;
    let unarchiveRequests = 0;
    const archivedSession = {
      Name: 'shell-demo',
      Type: 'shell',
      DisplayName: 'demo',
      Distro: 'Ubuntu',
      CreatedUnix: 1,
      CreatedLocal: '2026-03-14 00:00:00',
      AttachedClients: 0,
      WindowCount: 1,
      LastActivityUnix: 2,
      LastActivityLocal: '2026-03-14 00:00:02',
      Title: 'Demo Session',
      WorkingDirectoryWindows: 'D:\\ghws',
      PreviewText: 'preview',
      Archived: true,
      ClosedUtc: '',
      IsLive: true,
      State: 'Running',
      SortUnix: 2,
      DisplayTitle: 'Demo Session',
    };
    const unarchivedSession = {
      ...archivedSession,
      Archived: false,
    };

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/directories')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes('/api/sessions?includeArchived=true')) {
          listResponses += 1;
          return new Response(JSON.stringify([archivedSession]), {
            status: 200,
          });
        }
        if (
          url.includes('/api/sessions/shell-demo/unarchive') &&
          init?.method === 'POST'
        ) {
          unarchiveRequests += 1;
          return new Response(JSON.stringify(unarchivedSession), {
            status: 200,
          });
        }
        if (url.includes('/api/sessions/shell-demo/output')) {
          return new Response(
            JSON.stringify({
              SessionName: 'shell-demo',
              WorkingDirectoryWsl: '/mnt/d/ghws',
              Transcript: 'echo demo',
              CapturedAtUtc: new Date().toISOString(),
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }
    ) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.last-session-name',
          'shell-demo'
        );
      },
    });

    document
      .querySelector<HTMLButtonElement>('#openLastSessionButton')!
      .click();
    await waitForTick();

    expect(
      document.querySelector<HTMLDivElement>('#selectedSessionSummary')!
        .textContent
    ).toContain('一覧では非表示');

    document.querySelector<HTMLButtonElement>('#archiveSessionButton')!.click();
    await waitForTick();
    await waitForTick();

    expect(unarchiveRequests).toBe(1);
  });

  it('keeps the selected summary visible when the session is hidden from the list', async () => {
    let isArchived = false;
    let archiveRequests = 0;
    const baseSession = {
      Name: 'shell-demo',
      Type: 'shell',
      DisplayName: 'demo',
      Distro: 'Ubuntu',
      CreatedUnix: 1,
      CreatedLocal: '2026-03-14 00:00:00',
      AttachedClients: 0,
      WindowCount: 1,
      LastActivityUnix: 2,
      LastActivityLocal: '2026-03-14 00:00:02',
      Title: 'Demo Session',
      WorkingDirectoryWindows: 'D:\\ghws',
      PreviewText: 'preview',
      Archived: false,
      ClosedUtc: '',
      IsLive: true,
      State: 'Running',
      SortUnix: 2,
      DisplayTitle: 'Demo Session',
    };

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/directories')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes('/api/sessions?includeArchived=true')) {
          return new Response(
            JSON.stringify([
              {
                ...baseSession,
                Archived: isArchived,
              },
            ]),
            {
              status: 200,
            }
          );
        }
        if (
          url.includes('/api/sessions/shell-demo/archive') &&
          init?.method === 'POST'
        ) {
          archiveRequests += 1;
          isArchived = true;
          return new Response(
            JSON.stringify({
              ...baseSession,
              Archived: true,
            }),
            {
              status: 200,
            }
          );
        }
        if (url.includes('/api/sessions/shell-demo/output')) {
          return new Response(
            JSON.stringify({
              SessionName: 'shell-demo',
              WorkingDirectoryWsl: '/mnt/d/ghws',
              Transcript: 'echo demo',
              CapturedAtUtc: new Date().toISOString(),
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      }
    ) as unknown as typeof fetch;

    const document = await loadApp(fetchMock);

    document.querySelector<HTMLDivElement>('.session-card')!.click();
    await waitForTick();

    document.querySelector<HTMLButtonElement>('#archiveSessionButton')!.click();
    await waitForTick();
    await waitForTick();

    expect(archiveRequests).toBe(1);
    expect(
      document.querySelector<HTMLDivElement>('#selectedSessionSummary')!
        .textContent
    ).toContain('一覧では非表示');
    expect(
      document.querySelector<HTMLSpanElement>('#selectedSessionState')!
        .textContent
    ).toContain('SHELL');
    expect(document.querySelectorAll('.session-card')).toHaveLength(0);
    expect(
      document.querySelector<HTMLDivElement>('#sessionsList')!.textContent
    ).toContain('まだ session がありません');
  });

  it('does not poll output for a remembered stopped session and shows cached transcript', async () => {
    let outputPolled = false;
    const stoppedSession = {
      Name: 'codex-stopped',
      Type: 'codex',
      DisplayName: 'codex-stopped',
      Distro: 'Ubuntu',
      CreatedUnix: 1,
      CreatedLocal: '2026-03-16 08:35:57',
      AttachedClients: 0,
      WindowCount: 1,
      LastActivityUnix: 2,
      LastActivityLocal: '2026-03-16 08:36:10',
      Title: '停止済み session',
      WorkingDirectoryWindows: 'D:\\ghws',
      PreviewText: 'preview',
      Archived: false,
      ClosedUtc: '2026-03-16T00:36:10.000Z',
      IsLive: false,
      State: 'Saved',
      SortUnix: 2,
      DisplayTitle: '停止済み session',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([stoppedSession]), { status: 200 });
      }
      if (url.includes('/api/sessions/codex-stopped/output')) {
        outputPolled = true;
        throw new Error('stopped session should not poll live output');
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.last-session-name',
          'codex-stopped'
        );
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.transcript.codex-stopped',
          JSON.stringify('cached transcript from previous run')
        );
      },
    });

    await waitForTick();

    expect(outputPolled).toBe(false);
    expect(
      document.querySelector<HTMLSpanElement>('#selectedSessionState')!
        .textContent
    ).toContain('停止済み');
    expect(
      document.querySelector<HTMLPreElement>('#sessionTranscript')!.textContent
    ).toContain('cached transcript from previous run');
    expect(
      document.querySelector<HTMLButtonElement>('#sendPromptButton')!.disabled
    ).toBe(true);
  });

  it('marks the selected session stopped when Hub live snapshots report the tmux session missing', async () => {
    let liveRequests = 0;
    const liveSession = {
      Name: 'codex-live',
      Type: 'codex',
      DisplayName: 'codex-live',
      Distro: 'Ubuntu',
      CreatedUnix: 1,
      CreatedLocal: '2026-03-16 08:35:57',
      AttachedClients: 0,
      WindowCount: 1,
      LastActivityUnix: 2,
      LastActivityLocal: '2026-03-16 08:36:10',
      Title: '動作中 session',
      WorkingDirectoryWindows: 'D:\\ghws',
      PreviewText: 'preview',
      Archived: false,
      ClosedUtc: '',
      IsLive: true,
      State: 'Running',
      SortUnix: 2,
      DisplayTitle: '動作中 session',
    };
    const stoppedSession = {
      ...liveSession,
      IsLive: false,
      State: 'Saved',
      ClosedUtc: '2026-03-16T00:36:12.000Z',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([liveSession]), { status: 200 });
      }
      if (url.includes('/api/live')) {
        liveRequests += 1;
        return makeNdjsonResponse([
          {
            kind: 'snapshot',
            emittedAt: '2026-03-16T00:36:11.000Z',
            sessions: [liveSession],
            selectedSessionName: 'codex-live',
            selectedTranscript: null,
            selectedSessionMissing: true,
          },
          {
            kind: 'snapshot',
            emittedAt: '2026-03-16T00:36:12.000Z',
            sessions: [stoppedSession],
            selectedSessionName: 'codex-live',
            selectedTranscript: null,
            selectedSessionMissing: false,
          },
        ]);
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.last-session-name',
          'codex-live'
        );
      },
    });

    await waitForTick();
    await waitForTick();
    await waitForTick();

    expect(
      document.querySelector<HTMLSpanElement>('#selectedSessionState')!
        .textContent
    ).toContain('停止済み');
    expect(
      document.querySelector<HTMLButtonElement>('#sendPromptButton')!.disabled
    ).toBe(true);
    expect(liveRequests).toBeGreaterThanOrEqual(1);
    expect(
      document.querySelector<HTMLPreElement>('#sessionTranscript')!.textContent
    ).toContain('停止済み');
  });

  it('uses the Hub live snapshot stream instead of interval polling', async () => {
    const liveSession = {
      Name: 'shell-live',
      Type: 'shell',
      DisplayName: 'shell-live',
      Distro: 'Ubuntu',
      CreatedUnix: 1,
      CreatedLocal: '2026-03-16 08:35:57',
      AttachedClients: 0,
      WindowCount: 1,
      LastActivityUnix: 2,
      LastActivityLocal: '2026-03-16 08:36:10',
      Title: 'ライブ session',
      WorkingDirectoryWindows: 'D:\\ghws',
      PreviewText: 'preview',
      Archived: false,
      ClosedUtc: '',
      IsLive: true,
      State: 'Running',
      SortUnix: 2,
      DisplayTitle: 'ライブ session',
    };
    const fetchMockImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/directories')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/api/sessions?includeArchived=true')) {
        return new Response(JSON.stringify([liveSession]), { status: 200 });
      }
      if (url.includes('/api/sessions/shell-live/output')) {
        return new Response(
          JSON.stringify({
            SessionName: 'shell-live',
            WorkingDirectoryWsl: '/mnt/d/ghws',
            Transcript: 'initial output',
            CapturedAtUtc: '2026-03-16T00:36:10.000Z',
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/live')) {
        return makeNdjsonResponse([
          {
            kind: 'snapshot',
            emittedAt: '2026-03-16T00:36:11.000Z',
            sessions: [liveSession],
            selectedSessionName: 'shell-live',
            selectedTranscript: {
              SessionName: 'shell-live',
              WorkingDirectoryWsl: '/mnt/d/ghws',
              Transcript: 'live stream output',
              CapturedAtUtc: '2026-03-16T00:36:11.000Z',
            },
            selectedSessionMissing: false,
          },
        ]);
      }
      return new Response('{}', { status: 200 });
    });
    const fetchMock = fetchMockImpl as unknown as typeof fetch;

    const document = await loadApp(fetchMock, false, {
      beforeImport: (window) => {
        window.localStorage.setItem(
          'workspace-agent-hub.test-token.last-session-name',
          'shell-live'
        );
      },
    });

    await waitForTick();
    await waitForTick();

    expect(
      window.setInterval as unknown as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
    expect(
      fetchMockImpl.mock.calls.some(([input]) =>
        String(input).includes('/api/live')
      )
    ).toBe(true);
    expect(
      document.querySelector<HTMLPreElement>('#sessionTranscript')!.textContent
    ).toContain('live stream output');
  });
});
