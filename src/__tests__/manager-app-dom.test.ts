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
    ).toContain('Manager は複数の依頼と返事を整理する画面');
    expect(
      document.querySelector<HTMLElement>('#auth-context-copy')!.textContent
    ).toContain('同じ受信箱と同じ進行状況');
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
    ).toContain('まだ始まっていません');
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

  it('keeps a newly created topic visible while the manager thread list catches up', async () => {
    const validToken = 'manager-token';
    let threadsCalls = 0;
    const createdThread = {
      id: 'thread-1',
      title: '新しい topic',
      status: 'waiting',
      messages: [] as Array<{ sender: 'ai' | 'user'; content: string }>,
      updatedAt: '2026-03-20T10:00:00.000Z',
    };

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
          if (threadsCalls <= 2) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          return new Response(
            JSON.stringify([
              {
                ...createdThread,
                messages: [{ sender: 'user', content: createdThread.title }],
              },
            ]),
            { status: 200 }
          );
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

        if (isRoute(url, '/threads') && init?.method === 'POST') {
          return new Response(JSON.stringify(createdThread), { status: 200 });
        }

        if (isRoute(url, `/threads/${createdThread.id}/messages`)) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        if (isRoute(url, '/manager/send')) {
          return new Response(JSON.stringify({ accepted: true }), {
            status: 200,
          });
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

    document
      .querySelector<HTMLButtonElement>('[data-action="new-thread"]')!
      .click();
    await flushAsync();

    const titleInput =
      document.querySelector<HTMLInputElement>('#new-thread-title')!;
    titleInput.value = createdThread.title;
    document
      .querySelector<HTMLButtonElement>(
        '[data-action="create-thread-manager"]'
      )!
      .click();

    await flushAsync(8);

    expect(threadsCalls).toBeGreaterThanOrEqual(2);
    expect(
      document.querySelector<HTMLDivElement>('.thread-row .thread-title')!
        .textContent
    ).toContain(createdThread.title);
    expect(
      document.querySelector<HTMLElement>('[data-pending-note]')!.textContent
    ).toContain('返信待ち');
  });
});
