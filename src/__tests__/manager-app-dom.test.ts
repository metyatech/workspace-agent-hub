import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const managerHtml = readFileSync(
  join(__dirname, '..', '..', 'public', 'manager.html'),
  'utf-8'
);
const authStorageKey = 'workspace-agent-hub.test-manager-token';

function isRoute(url: string, suffix: string): boolean {
  return url === `./api${suffix}` || url.endsWith(`/api${suffix}`);
}

function waitForTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushAsync(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await waitForTick();
  }
}

function makeThreadView(
  id: string,
  title: string,
  overrides: Partial<Record<string, unknown>> = {}
) {
  return {
    id,
    title,
    status: 'review',
    messages: [
      {
        sender: 'ai',
        content: `${title} の返答`,
        at: '2026-03-21T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-03-21T00:00:00.000Z',
    uiState: 'ai-finished-awaiting-user-confirmation',
    previewText: `[ai] ${title} の返答`,
    lastSender: 'ai',
    hiddenByDefault: false,
    routingConfirmationNeeded: false,
    routingHint: null,
    queueDepth: 0,
    isWorking: false,
    ...overrides,
  };
}

function createManagerFetch(validToken: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers ?? {});
    const providedToken = headers.get('X-Workspace-Agent-Hub-Token');

    if (providedToken !== validToken) {
      return new Response(
        JSON.stringify({ error: 'Access code required', authRequired: true }),
        { status: 401 }
      );
    }

    if (isRoute(url, '/threads')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    if (isRoute(url, '/tasks')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    if (isRoute(url, '/manager/status')) {
      return new Response(
        JSON.stringify({
          running: false,
          configured: true,
          builtinBackend: true,
          detail: '未起動 — メッセージ送信で自動起動します',
        }),
        { status: 200 }
      );
    }

    return new Response('{}', { status: 200 });
  });
}

async function loadManagerApp(
  fetchMock: typeof fetch,
  options?: {
    authRequired?: boolean;
    url?: string;
    beforeImport?: (window: Window) => void;
  }
): Promise<Document> {
  const dom = new JSDOM(managerHtml, {
    url: options?.url ?? 'https://hub.example.test/manager/',
    pretendToBeVisual: true,
  });

  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  vi.stubGlobal('fetch', fetchMock);

  Object.defineProperty(dom.window, 'GUI_DIR', {
    value: 'D:\\ghws',
    configurable: true,
  });
  Object.defineProperty(dom.window, 'MANAGER_AUTH_REQUIRED', {
    value: options?.authRequired ?? true,
    configurable: true,
  });
  Object.defineProperty(dom.window, 'MANAGER_AUTH_STORAGE_KEY', {
    value: authStorageKey,
    configurable: true,
  });
  Object.defineProperty(dom.window, 'MANAGER_API_BASE', {
    value: './api',
    configurable: true,
  });

  Object.defineProperty(dom.window, 'setInterval', {
    value: vi.fn(() => 1),
    configurable: true,
  });
  Object.defineProperty(dom.window, 'clearInterval', {
    value: vi.fn(),
    configurable: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
  });

  options?.beforeImport?.(dom.window as unknown as Window);

  vi.resetModules();
  await import('../manager-app.js');
  await flushAsync();
  return dom.window.document;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('manager-app DOM auth state matrix', () => {
  it('shows the auth panel on a fresh protected load with no saved access code', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
    });

    expect(
      document
        .querySelector<HTMLDivElement>('#auth-panel')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(
      document.querySelector<HTMLElement>('#auth-context-title')!.textContent
    ).toContain('Manager は、あとで状況を見失わないための受信箱です');
    expect(
      document.querySelector<HTMLElement>('#auth-context-copy')!.textContent
    ).toContain('話題の分け方は AI');
    expect(
      document
        .querySelector<HTMLElement>('#manager-bar')!
        .classList.contains('auth-hidden')
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a fresh access code from the URL hash on first load', async () => {
    const fetchMock = createManagerFetch('fresh-hash-token');
    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      url: 'https://hub.example.test/manager/#accessCode=fresh-hash-token',
    });

    expect(window.localStorage.getItem(authStorageKey)).toBe(
      'fresh-hash-token'
    );
    expect(
      document
        .querySelector<HTMLDivElement>('#auth-panel')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(
      document.querySelector<HTMLSpanElement>('#manager-status-text')!
        .textContent
    ).toContain('未起動');
    expect(
      fetchMock.mock.calls.every(([input, init]) => {
        const url = String(input);
        if (
          !isRoute(url, '/threads') &&
          !isRoute(url, '/tasks') &&
          !isRoute(url, '/manager/status')
        ) {
          return true;
        }
        const headers = new Headers(init?.headers ?? {});
        return (
          headers.get('X-Workspace-Agent-Hub-Token') === 'fresh-hash-token'
        );
      })
    ).toBe(true);
  });

  it('reuses a valid stored access code without reopening the auth panel', async () => {
    const fetchMock = createManagerFetch('stored-valid-token');
    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'stored-valid-token');
      },
    });

    expect(window.localStorage.getItem(authStorageKey)).toBe(
      'stored-valid-token'
    );
    expect(
      document
        .querySelector<HTMLDivElement>('#auth-panel')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLButtonElement>('#manager-start-btn')!
        .classList.contains('hidden')
    ).toBe(false);
  });

  it('clears a stale stored access code and reopens auth when the server rejects it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: 'Access code required', authRequired: true }),
          { status: 401 }
        )
    ) as unknown as typeof fetch;

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'stale-token');
      },
    });

    expect(window.localStorage.getItem(authStorageKey)).toBe(null);
    expect(
      document
        .querySelector<HTMLDivElement>('#auth-panel')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(
      document.querySelector<HTMLElement>('#auth-error')!.textContent
    ).toContain('アクセスコードを入力してください');
    expect(
      document
        .querySelector<HTMLButtonElement>('#auth-clear-btn')!
        .classList.contains('hidden')
    ).toBe(true);
  });

  it('overrides a stale stored access code when a newer one is present in the URL hash', async () => {
    const fetchMock = createManagerFetch('fresh-token');
    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      url: 'https://hub.example.test/manager/#accessCode=fresh-token',
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'stale-token');
      },
    });

    expect(window.localStorage.getItem(authStorageKey)).toBe('fresh-token');
    expect(
      document
        .querySelector<HTMLDivElement>('#auth-panel')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(
      fetchMock.mock.calls.every(([input, init]) => {
        const url = String(input);
        if (
          !isRoute(url, '/threads') &&
          !isRoute(url, '/tasks') &&
          !isRoute(url, '/manager/status')
        ) {
          return true;
        }
        const headers = new Headers(init?.headers ?? {});
        return headers.get('X-Workspace-Agent-Hub-Token') === 'fresh-token';
      })
    ).toBe(true);
  });

  it('routes a global composer message and opens the routed topic', async () => {
    const validToken = 'manager-token';
    let threadsCalls = 0;
    const createdThread = makeThreadView('thread-1', 'AA を進める');
    const secondThread = makeThreadView('thread-2', 'BB を進める');

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers ?? {});
        const providedToken = headers.get('X-Workspace-Agent-Hub-Token');

        if (providedToken !== validToken) {
          return new Response(
            JSON.stringify({
              error: 'Access code required',
              authRequired: true,
            }),
            { status: 401 }
          );
        }

        if (
          isRoute(url, '/threads') &&
          (!init?.method || init.method === 'GET')
        ) {
          threadsCalls += 1;
          if (threadsCalls < 2) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          return new Response(JSON.stringify([createdThread, secondThread]), {
            status: 200,
          });
        }

        if (isRoute(url, '/tasks')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (isRoute(url, '/manager/status')) {
          return new Response(
            JSON.stringify({
              running: false,
              configured: true,
              builtinBackend: true,
              detail: '未起動 — メッセージ送信で自動起動します',
            }),
            { status: 200 }
          );
        }

        if (isRoute(url, '/manager/global-send')) {
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({
            content: 'AAして、BBして',
            contextThreadId: null,
          });
          return new Response(
            JSON.stringify({
              items: [
                {
                  threadId: 'thread-1',
                  title: 'AA を進める',
                  outcome: 'created-new',
                  reason: '新しい話題を作りました',
                },
                {
                  threadId: 'thread-2',
                  title: 'BB を進める',
                  outcome: 'created-new',
                  reason: '新しい話題を作りました',
                },
              ],
              routedCount: 2,
              ambiguousCount: 0,
              detail: '2件を処理しました',
            }),
            { status: 200 }
          );
        }

        return new Response('{}', { status: 200 });
      }
    ) as unknown as typeof fetch;

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    composer.value = 'AAして、BBして';
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();

    await flushAsync(6);

    expect(
      document.querySelector<HTMLElement>('#composerFeedback')!.textContent
    ).toContain('2件を処理しました');
    const feedbackButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '#composerFeedback .composer-chip'
      )
    );
    expect(feedbackButtons.map((button) => button.textContent)).toEqual([
      'AA を進める',
      'BB を進める',
    ]);
    expect(
      document.querySelector<HTMLElement>('#thread-detail')!.textContent
    ).toContain('AA を進める');
    expect(
      document.querySelector<HTMLElement>('#composerContext')!.textContent
    ).toContain('AA を進める');

    feedbackButtons[1]!.click();
    await flushAsync(2);

    expect(
      document.querySelector<HTMLElement>('#thread-detail')!.textContent
    ).toContain('BB を進める');
    expect(
      document.querySelector<HTMLElement>('#composerContext')!.textContent
    ).toContain('BB を進める');
  });

  it('keeps done topics hidden by default and shows them when toggled', async () => {
    const validToken = 'manager-token';
    const liveThread = makeThreadView('thread-live', '確認中の話題');
    const doneThread = makeThreadView('thread-done', '終わった話題', {
      status: 'resolved',
      uiState: 'done',
      hiddenByDefault: true,
    });

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers ?? {});
        const providedToken = headers.get('X-Workspace-Agent-Hub-Token');

        if (providedToken !== validToken) {
          return new Response(
            JSON.stringify({
              error: 'Access code required',
              authRequired: true,
            }),
            { status: 401 }
          );
        }

        if (isRoute(url, '/threads')) {
          return new Response(JSON.stringify([liveThread, doneThread]), {
            status: 200,
          });
        }

        if (isRoute(url, '/tasks')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (isRoute(url, '/manager/status')) {
          return new Response(
            JSON.stringify({
              running: true,
              configured: true,
              builtinBackend: true,
              detail: '待機中',
            }),
            { status: 200 }
          );
        }

        return new Response('{}', { status: 200 });
      }
    ) as unknown as typeof fetch;

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    const doneSection = document.querySelector<HTMLElement>('#sec-done')!;
    expect(doneSection.classList.contains('hidden')).toBe(true);

    document.querySelector<HTMLButtonElement>('#toggleDoneButton')!.click();
    await flushAsync();

    expect(doneSection.classList.contains('hidden')).toBe(false);
    expect(doneSection.textContent).toContain('終わった話題');
  });

  it('reserves bottom scroll space from the live composer dock height', async () => {
    const fetchMock = createManagerFetch('reserve-token');
    let resizeObserverCallback:
      | ((entries: ResizeObserverEntry[], observer: ResizeObserver) => void)
      | null = null;
    let composerHeight = 312;

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(
          callback: (
            entries: ResizeObserverEntry[],
            observer: ResizeObserver
          ) => void
        ) {
          resizeObserverCallback = callback;
        }

        observe(): void {}

        disconnect(): void {}

        unobserve(): void {}
      }
    );

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'reserve-token');
        const elementPrototype = (
          window as unknown as { HTMLElement: typeof HTMLElement }
        ).HTMLElement.prototype;
        Object.defineProperty(elementPrototype, 'getBoundingClientRect', {
          configurable: true,
          value: function getBoundingClientRect() {
            if ((this as HTMLElement).id === 'global-composer-dock') {
              return {
                width: 800,
                height: composerHeight,
                top: 0,
                left: 0,
                right: 800,
                bottom: composerHeight,
                x: 0,
                y: 0,
                toJSON() {
                  return this;
                },
              };
            }
            return {
              width: 0,
              height: 0,
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              x: 0,
              y: 0,
              toJSON() {
                return this;
              },
            };
          },
        });
      },
    });

    expect(
      document.documentElement.style.getPropertyValue('--composer-dock-reserve')
    ).toBe('312px');

    composerHeight = 268;
    (
      resizeObserverCallback as
        | ((entries: ResizeObserverEntry[], observer: ResizeObserver) => void)
        | null
    )?.([] as ResizeObserverEntry[], {} as ResizeObserver);

    expect(
      document.documentElement.style.getPropertyValue('--composer-dock-reserve')
    ).toBe('268px');
  });
});
