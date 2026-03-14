import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const baseHtml = `
<!doctype html>
<html>
  <body>
    <div id="sessionsList"></div>
    <button id="refreshSessionsButton"></button>
    <select id="sessionTypeSelect"><option value="shell">shell</option></select>
    <input id="sessionTitleInput" />
    <input id="workingDirectoryInput" />
    <datalist id="workingDirectorySuggestions"></datalist>
    <button id="startSessionButton">start</button>
    <button id="showArchivedButton">toggle</button>
    <span id="selectedSessionState"></span>
    <div id="selectedSessionSummary"></div>
    <div id="selectedSessionControls" style="display:none"></div>
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
    <p id="pairingHint"></p>
    <input id="pairingUrlInput" />
    <button id="sharePairingButton">share</button>
    <button id="copyPairingLinkButton">copy link</button>
    <button id="copyManualUrlButton">copy url</button>
    <input id="pairingCodeInput" />
    <button id="copyPairingCodeButton">copy code</button>
    <img id="pairingQrImage" />
    <span id="pairingQrStatus"></span>
    <div id="toast"></div>
    <div id="authOverlay"></div>
    <input id="authTokenInput" />
    <button id="authSubmitButton">auth</button>
  </body>
</html>
`;

function waitForTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadApp(
  fetchMock: typeof fetch,
  authRequired = false,
  options?: {
    beforeImport?: (window: Window) => void;
    secureContext?: boolean;
    url?: string;
    preferredConnectUrl?: string | null;
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
    });

    expect(
      document
        .querySelector<HTMLDivElement>('#authOverlay')!
        .classList.contains('visible')
    ).toBe(false);
    expect(window.localStorage.getItem('workspace-agent-hub.test-token')).toBe(
      'hash-token'
    );
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
});
