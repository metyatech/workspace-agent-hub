import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { serializeManagerMessage } from '../manager-message.js';

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
    derivedFromThreadIds: [],
    derivedChildThreadIds: [],
    queueDepth: 0,
    isWorking: false,
    assigneeKind: null,
    assigneeLabel: null,
    workerLiveOutput: null,
    workerLiveAt: null,
    ...overrides,
  };
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

    if (isRoute(url, '/live')) {
      return makeNdjsonResponse([
        {
          kind: 'snapshot',
          emittedAt: '2026-03-21T00:00:00.000Z',
          threads: [],
          tasks: [],
          status: {
            running: false,
            configured: true,
            builtinBackend: true,
            detail: '未起動 — メッセージ送信で自動起動します',
          },
        },
      ]);
    }

    return new Response('{}', { status: 200 });
  });
}

function makeImageTransfer(file: File) {
  return {
    items: [
      {
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
      },
    ],
    files: [file],
    dropEffect: 'none',
  };
}

function createManagerFetchWithData(input: {
  validToken: string;
  threads: Array<ReturnType<typeof makeThreadView>>;
  tasks?: unknown[];
  status?: {
    running: boolean;
    configured: boolean;
    builtinBackend: boolean;
    detail: string;
    pendingCount?: number;
    currentQueueId?: string | null;
    currentThreadId?: string | null;
    currentThreadTitle?: string | null;
  };
}) {
  return vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    const headers = new Headers(init?.headers ?? {});
    const providedToken = headers.get('X-Workspace-Agent-Hub-Token');

    if (providedToken !== input.validToken) {
      return new Response(
        JSON.stringify({ error: 'Access code required', authRequired: true }),
        { status: 401 }
      );
    }

    if (isRoute(url, '/threads')) {
      return new Response(JSON.stringify(input.threads), { status: 200 });
    }

    if (isRoute(url, '/tasks')) {
      return new Response(JSON.stringify(input.tasks ?? []), { status: 200 });
    }

    if (isRoute(url, '/manager/status')) {
      return new Response(
        JSON.stringify(
          input.status ?? {
            running: false,
            configured: true,
            builtinBackend: true,
            detail: '未起動 — メッセージ送信で自動起動します',
          }
        ),
        { status: 200 }
      );
    }

    if (isRoute(url, '/live')) {
      return makeNdjsonResponse([
        {
          kind: 'snapshot',
          emittedAt: '2026-03-21T00:00:00.000Z',
          threads: input.threads,
          tasks: input.tasks ?? [],
          status: input.status ?? {
            running: false,
            configured: true,
            builtinBackend: true,
            detail: '未起動 — メッセージ送信で自動起動します',
          },
        },
      ]);
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
    value: vi.fn(dom.window.setInterval.bind(dom.window)),
    configurable: true,
  });
  Object.defineProperty(dom.window, 'clearInterval', {
    value: vi.fn(dom.window.clearInterval.bind(dom.window)),
    configurable: true,
  });
  Object.defineProperty(dom.window, 'setTimeout', {
    value: vi.fn(dom.window.setTimeout.bind(dom.window)),
    configurable: true,
  });
  Object.defineProperty(dom.window, 'clearTimeout', {
    value: vi.fn(dom.window.clearTimeout.bind(dom.window)),
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
  it('describes drag-drop and clipboard image insertion instead of an add-image button', () => {
    expect(managerHtml).toContain(
      '画像はここへドラッグ&ドロップするか、Ctrl / Cmd + V で'
    );
    expect(managerHtml).not.toContain('composerInsertImageButton');
    expect(managerHtml).not.toContain('composerImageInput');
  });

  it('keeps markdown reply spacing compact in the manager stylesheet', () => {
    expect(managerHtml).toMatch(
      /\.bubble-content \{\s+font-size: 0\.8rem;\s+color: #163123;\s+white-space: normal;/
    );
    expect(managerHtml).toMatch(
      /\.bubble-content p\s+\{\s+margin: 0 0 0\.54em;/
    );
    expect(managerHtml).toMatch(
      /\.bubble-content ul,\s+\.bubble-content ol\s+\{\s+margin: 0 0 0\.68em;\s+padding-left: 1\.25em;/
    );
    expect(managerHtml).toMatch(
      /\.bubble-content li \+ li\s+\{\s+margin-top: 0\.12em;/
    );
    expect(managerHtml).toMatch(
      /\.bubble-content blockquote\s+\{\s+margin: 0 0 0\.68em;/
    );
    expect(managerHtml).not.toContain('送信プレビュー');
  });

  it('keeps always-visible manager chrome minimal', () => {
    expect(managerHtml).not.toContain('id="dir-label"');
    expect(managerHtml).not.toContain('↻ 更新');
    expect(managerHtml).toContain('残っている作業メモ');
  });

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
    ).toContain('どの task にするかは AI');
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

  it('lets the user clear the current topic target and send globally without leaving the open conversation screen', async () => {
    const validToken = 'manager-token';
    let threadsCalls = 0;
    const browsingThread = makeThreadView('thread-browse', '今見ている task', {
      previewText: '[ai] いま確認中です',
    });
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
            return new Response(JSON.stringify([browsingThread]), {
              status: 200,
            });
          }
          return new Response(
            JSON.stringify([browsingThread, createdThread, secondThread]),
            {
              status: 200,
            }
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

    expect(
      document
        .querySelector<HTMLElement>('#composerPanel')!
        .classList.contains('hidden')
    ).toBe(true);

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('今見ている task');

    document
      .querySelector<HTMLButtonElement>('#composerTargetClearButton')!
      .click();
    await flushAsync(2);

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
    expect(
      document.querySelector<HTMLElement>('#composerStatusText')!.textContent
    ).toBe('');
    expect(
      document
        .querySelector<HTMLElement>('#composerPanel')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(composer.value).toBe('');
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
    ).toContain('今見ている task');
    expect(
      document.querySelector<HTMLElement>(
        '.thread-row.selected [data-row-title]'
      )!.textContent
    ).toContain('今見ている task');
    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信先: 全体');

    feedbackButtons[1]!.click();
    await flushAsync(2);

    expect(
      document.querySelector<HTMLElement>('#thread-detail')!.textContent
    ).toContain('BB を進める');
    expect(
      document.querySelector<HTMLElement>(
        '.thread-row.selected [data-row-title]'
      )!.textContent
    ).toContain('BB を進める');
    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信ヒント: @BB を進める');
  });

  it('opens the selected thread in its own conversation screen', async () => {
    const validToken = 'focus-panel-token';
    const thread = makeThreadView('thread-inline', '現在の task');

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
          return new Response(JSON.stringify([thread]), { status: 200 });
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const row = document.querySelector<HTMLElement>('.thread-row.selected')!;
    const threadScreen = document.querySelector<HTMLElement>('#thread-screen')!;
    const detail = document.querySelector<HTMLElement>('#thread-detail')!;
    expect(detail.classList.contains('hidden')).toBe(false);
    expect(threadScreen.classList.contains('hidden')).toBe(false);
    expect(
      document
        .querySelector<HTMLElement>('#manager-inbox-screen')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(detail.closest<HTMLElement>('#thread-screen')).toBe(threadScreen);
    expect(
      document.querySelector<HTMLElement>('[data-row-toggle]')?.textContent
    ).toContain('表示中');
    expect(row.textContent).toContain('現在の task');
  });

  it('keeps AI execution-waiting items out of the read-first lane', async () => {
    const validToken = 'priority-lane-filter-token';
    const actionableThread = makeThreadView('thread-reply', '返事が必要', {
      uiState: 'user-reply-needed',
      previewText: '[ai] 返答してください',
      lastSender: 'ai',
    });
    const queuedThread = makeThreadView('thread-queued', '順番待ちの task', {
      uiState: 'queued',
      previewText: '[user] 実行待ちです',
      lastSender: 'user',
    });
    const workingThread = makeThreadView('thread-working', '作業中の task', {
      uiState: 'ai-working',
      previewText: '[user] 実行中です',
      lastSender: 'user',
      isWorking: true,
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [queuedThread, actionableThread, workingThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    const priorityItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#priority-lane-list .focus-list-item'
      )
    ).map((element) => element.textContent ?? '');

    expect(priorityItems).toHaveLength(1);
    expect(priorityItems[0]).toContain('返事が必要');
    expect(priorityItems[0]).not.toContain('順番待ちの task');
    expect(priorityItems[0]).not.toContain('作業中の task');
  });

  it('tells the user there is nothing to do when only queued or working items remain', async () => {
    const validToken = 'priority-lane-background-only-token';
    const queuedThread = makeThreadView('thread-queued', '順番待ちの task', {
      uiState: 'queued',
      previewText: '[user] 実行待ちです',
      lastSender: 'user',
    });
    const workingThread = makeThreadView('thread-working', '作業中の task', {
      uiState: 'ai-working',
      previewText: '[ai] 作業を続けています',
      lastSender: 'ai',
      isWorking: true,
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [queuedThread, workingThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
        pendingCount: 1,
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    const priorityItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#priority-lane-list .focus-list-item'
      )
    );

    expect(priorityItems).toHaveLength(0);
    expect(
      document.querySelector<HTMLElement>('#priority-lane-copy')!.textContent
    ).toContain('いま自分が返すものはありません');
    expect(
      document.querySelector<HTMLElement>('#priority-lane-list .focus-empty')!
        .textContent
    ).toContain('いま優先して読む作業項目はありません');
    expect(
      document.querySelector<HTMLElement>('#activity-primary')!.textContent
    ).toContain('AI の順番待ちがあります');
    const chips = Array.from(
      document.querySelectorAll<HTMLElement>('.activity-chip')
    ).map((element) => element.textContent ?? '');
    expect(chips).toContain('AI の順番待ち 1');
  });

  it('does not scroll away when the target thread row is already visible', async () => {
    const validToken = 'priority-lane-focus-token';
    const thread = makeThreadView('thread-priority-visible', '優先 task', {
      uiState: 'user-reply-needed',
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
          return new Response(JSON.stringify([thread]), { status: 200 });
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

    const row = document.querySelector<HTMLElement>('.thread-row')!;
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 24,
      top: 24,
      left: 0,
      right: 900,
      bottom: 260,
      width: 900,
      height: 236,
      toJSON: () => ({}),
    });

    const scrollSpy = document.defaultView!.HTMLElement.prototype
      .scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    scrollSpy.mockClear();

    document.querySelector<HTMLElement>('.focus-list-item')!.click();
    await flushAsync(3);

    expect(
      document.querySelector<HTMLElement>(
        '.thread-row.selected [data-row-title]'
      )!.textContent
    ).toContain('優先 task');
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('shows the latest detail message at the bottom like a chat screen', async () => {
    const validToken = 'latest-bottom-token';
    const thread = makeThreadView('thread-latest-bottom', '最新下部の確認', {
      messages: [
        {
          sender: 'user',
          content: 'oldest-message',
          at: '2026-03-21T00:00:00.000Z',
        },
        {
          sender: 'ai',
          content: 'middle-message',
          at: '2026-03-21T00:01:00.000Z',
        },
        {
          sender: 'user',
          content: 'newest-message',
          at: '2026-03-21T00:02:00.000Z',
        },
      ],
      previewText: '[user] newest-message',
      lastSender: 'user',
      updatedAt: '2026-03-21T00:02:00.000Z',
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
          return new Response(JSON.stringify([thread]), { status: 200 });
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const contents = Array.from(
      document.querySelectorAll<HTMLElement>('.msg-area .bubble-content')
    ).map((element) => element.textContent?.trim());
    const sides = Array.from(
      document.querySelectorAll<HTMLElement>('.msg-area .bubble')
    ).map((element) => element.dataset.chatSide);

    expect(contents).toEqual([
      'oldest-message',
      'middle-message',
      'newest-message',
    ]);
    expect(sides).toEqual(['right', 'left', 'right']);
  });

  it('opens a topic with the message area scrolled to the latest message even when layout settles one tick later', async () => {
    const validToken = 'delayed-bottom-scroll-token';
    const thread = makeThreadView('thread-delayed-bottom', '下端スクロール', {
      messages: [
        {
          sender: 'user',
          content: '一つ前のメッセージ',
          at: '2026-03-21T00:00:00.000Z',
        },
        {
          sender: 'ai',
          content: '一番下のメッセージ',
          at: '2026-03-21T00:01:00.000Z',
        },
      ],
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [thread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
        const reads = new WeakMap<object, number>();
        const elementPrototype = (
          window as unknown as { HTMLElement: typeof HTMLElement }
        ).HTMLElement.prototype;
        Object.defineProperty(elementPrototype, 'scrollHeight', {
          configurable: true,
          get(this: HTMLElement) {
            if (!this.classList.contains('msg-area')) {
              return 0;
            }
            const nextRead = (reads.get(this) ?? 0) + 1;
            reads.set(this, nextRead);
            return nextRead === 1 ? 0 : 640;
          },
        });
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(6);

    expect(document.querySelector<HTMLElement>('.msg-area')!.scrollTop).toBe(
      640
    );
  });

  it('returns from a topic screen to the inbox when browser history goes back', async () => {
    const validToken = 'history-back-to-inbox-token';
    const thread = makeThreadView('thread-history', '履歴確認');

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [thread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(4);

    expect(document.defaultView!.history.state).toMatchObject({
      kind: 'workspace-agent-hub-manager',
      screen: 'thread',
      threadId: 'thread-history',
    });
    expect(
      document
        .querySelector<HTMLElement>('#manager-inbox-screen')!
        .classList.contains('hidden')
    ).toBe(true);

    document.defaultView!.history.back();
    await flushAsync(6);

    expect(document.defaultView!.history.state).toMatchObject({
      kind: 'workspace-agent-hub-manager',
      screen: 'inbox',
    });
    expect(
      document
        .querySelector<HTMLElement>('#manager-inbox-screen')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(
      document
        .querySelector<HTMLElement>('#thread-screen')!
        .classList.contains('hidden')
    ).toBe(true);
  });

  it('renders markdown replies and inline user images in the detail bubbles', async () => {
    const validToken = 'rich-message-token';
    const thread = makeThreadView('thread-rich', '装飾付き task', {
      messages: [
        {
          sender: 'user',
          content: serializeManagerMessage({
            content:
              '画像つきの報告です\n\n![capture](attachment://img-1)\n\n続きも見てください',
            attachments: [
              {
                id: 'img-1',
                name: 'capture.png',
                mimeType: 'image/png',
                dataUrl: 'data:image/png;base64,AAAA',
              },
            ],
          }),
          at: '2026-03-21T00:00:00.000Z',
        },
        {
          sender: 'ai',
          content: '# 見出し\n\n- 箇条書き\n- `code` 付き',
          at: '2026-03-21T00:01:00.000Z',
        },
      ],
      previewText: '[ai] 見出し',
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [thread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const aiBubble = document.querySelector<HTMLElement>(
      '.msg-area .bubble[data-sender="ai"] .bubble-content'
    )!;
    const userBubble = document.querySelector<HTMLElement>(
      '.msg-area .bubble[data-sender="user"] .bubble-content'
    )!;

    expect(aiBubble.querySelector('h1')?.textContent).toBe('見出し');
    expect(
      Array.from(aiBubble.querySelectorAll('li')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['箇条書き', 'code 付き']);
    expect(userBubble.querySelector('img')).not.toBeNull();
    expect(userBubble.textContent).toContain('画像つきの報告です');
    expect(userBubble.textContent).toContain('続きも見てください');
  });

  it('renders ANSI-colored CLI diffs inside markdown code blocks without exposing raw escapes', async () => {
    const validToken = 'ansi-diff-token';
    const thread = makeThreadView('thread-ansi', '差分つき task', {
      messages: [
        {
          sender: 'ai',
          content:
            '```diff\n\u001b[31m-old line\u001b[39m\n\u001b[32m+new line\u001b[39m\n```',
          at: '2026-03-21T00:03:00.000Z',
        },
      ],
      previewText: '[ai] diff',
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [thread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const ansiSegments = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.msg-area .bubble[data-sender="ai"] .bubble-content pre .ansi-segment'
      )
    );
    const bubbleText =
      document.querySelector<HTMLElement>(
        '.msg-area .bubble[data-sender="ai"] .bubble-content'
      )?.textContent ?? '';

    expect(ansiSegments.map((element) => element.textContent)).toEqual([
      '-old line',
      '+new line',
    ]);
    expect(ansiSegments.every((element) => element.style.color !== '')).toBe(
      true
    );
    expect(bubbleText).not.toContain('\u001b[');
  });

  it('keeps authored line breaks via markdown br tags without pre-wrap block gaps', async () => {
    const validToken = 'markdown-break-token';
    const thread = makeThreadView('thread-breaks', '改行つき task', {
      messages: [
        {
          sender: 'ai',
          content: '1行目\n2行目\n\n- 箇条書きA\n- 箇条書きB',
          at: '2026-03-21T00:02:00.000Z',
        },
      ],
      previewText: '[ai] 1行目',
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [thread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const aiBubble = document.querySelector<HTMLElement>(
      '.msg-area .bubble[data-sender="ai"] .bubble-content'
    )!;

    expect(aiBubble.querySelector('br')).not.toBeNull();
    expect(
      Array.from(aiBubble.querySelectorAll('li')).map((element) =>
        element.textContent?.trim()
      )
    ).toEqual(['箇条書きA', '箇条書きB']);
  });

  it('replaces visible raw topic IDs in AI copy with the corresponding topic title', async () => {
    const validToken = 'thread-id-humanize-token';
    const referencedThread = makeThreadView('_bX_UpQR', '支払いUIの修正', {
      previewText: '[user] ここを直してください',
      lastSender: 'user',
    });
    const sourceThread = makeThreadView('thread-source', '通知の整理', {
      messages: [
        {
          sender: 'ai',
          content: 'まず _bX_UpQR を確認してください。',
          at: '2026-03-21T00:04:00.000Z',
        },
      ],
      previewText: '[ai] まず _bX_UpQR を確認してください。',
      routingHint: 'threadId: _bX_UpQR を先に見れば進められます。',
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [sourceThread, referencedThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    const sourceRow = Array.from(
      document.querySelectorAll<HTMLElement>('.thread-row')
    ).find((element) => element.textContent?.includes('通知の整理'));
    expect(sourceRow?.textContent).toContain('支払いUIの修正');
    expect(sourceRow?.textContent).not.toContain('_bX_UpQR');

    sourceRow?.click();
    await flushAsync(3);

    const aiBubble = document.querySelector<HTMLElement>(
      '.msg-area .bubble[data-sender="ai"] .bubble-content'
    )!;
    expect(aiBubble.textContent).toContain('支払いUIの修正');
    expect(aiBubble.textContent).not.toContain('_bX_UpQR');
  });

  it('opens a topic screen with that topic preselected and can return to global routing', async () => {
    const validToken = 'target-send-token';
    const thread = makeThreadView('thread-target', '特定 task');
    const seenBodies: Array<{
      content: string;
      contextThreadId: string | null;
    }> = [];

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
          return new Response(JSON.stringify([thread]), { status: 200 });
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

        if (isRoute(url, '/manager/global-send')) {
          seenBodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              items: [
                {
                  threadId: 'thread-target',
                  title: '特定 task',
                  outcome: 'attached-existing',
                  reason: '既存 task に追記しました',
                },
              ],
              routedCount: 1,
              ambiguousCount: 0,
              detail: '1件を処理しました',
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信ヒント: @特定 task');
    expect(
      document
        .querySelector<HTMLElement>('#composerPanel')!
        .classList.contains('hidden')
    ).toBe(false);

    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    composer.value = 'この task を続けて';
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();
    await flushAsync(6);

    expect(seenBodies[0]).toEqual({
      content: 'この task を続けて',
      contextThreadId: 'thread-target',
    });
    expect(
      document
        .querySelector<HTMLElement>('#composerPanel')!
        .classList.contains('hidden')
    ).toBe(false);

    document
      .querySelector<HTMLButtonElement>('#composerTargetClearButton')!
      .click();
    await flushAsync(2);

    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信先: 全体');
  });

  it('explains queued follow-up behavior when targeting an AI-working topic', async () => {
    const validToken = 'working-target-token';
    const thread = makeThreadView('thread-working', '進行中の task', {
      status: 'active',
      uiState: 'ai-working',
      queueDepth: 2,
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 続きの確認です',
      messages: [
        {
          sender: 'user',
          content: 'この task を進めて',
          at: '2026-03-21T00:00:00.000Z',
        },
      ],
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [thread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (進行中の task)',
        currentQueueId: 'queue-working',
        currentThreadId: 'thread-working',
        currentThreadTitle: '進行中の task',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const actionButton = document.querySelector<HTMLButtonElement>(
      '#thread-detail .detail-actions .btn-secondary'
    )!;
    expect(actionButton.textContent).toBe(
      'この会話をメンションして追加指示を送る'
    );

    actionButton.click();
    await flushAsync(2);

    expect(
      document.querySelector<HTMLElement>('#composerLabel')!.textContent
    ).toBe('この会話をメンションして追加指示を送る');
    expect(
      document.querySelector<HTMLElement>('#composerHint')!.textContent
    ).toContain('メンション付きのヒントとして全体へ送り');
    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信ヒント: @進行中の task');
    expect(
      document.querySelector<HTMLElement>('#composerContext')!.textContent
    ).toContain('メンション付きヒントとして全体へ送り');
    expect(
      document.querySelector<HTMLButtonElement>('#globalComposerSendButton')!
        .textContent
    ).toBe('追加指示を送る');
  });

  it('moves a sent draft into a separate feedback lane immediately so the composer can hold the next draft', async () => {
    const validToken = 'separate-feedback-token';
    let resolveSend: ((response: Response) => void) | null = null;

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
          return new Response(
            JSON.stringify([makeThreadView('thread-1', '通知確認')]),
            {
              status: 200,
            }
          );
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

        if (isRoute(url, '/manager/global-send')) {
          return await new Promise<Response>((resolve) => {
            resolveSend = resolve;
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

    document.querySelector<HTMLButtonElement>('#composerToggleButton')!.click();
    await flushAsync(2);

    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    const sendButton = document.querySelector<HTMLButtonElement>(
      '#globalComposerSendButton'
    )!;
    composer.value = '通知を確認したいです';
    sendButton.click();
    await flushAsync(2);

    const statusText = document.querySelector<HTMLElement>(
      '#composerStatusText'
    )!;
    const feedback = document.querySelector<HTMLElement>('#composerFeedback')!;

    expect(composer.value).toBe('');
    expect(sendButton.disabled).toBe(true);
    expect(statusText.textContent).toContain('前の送信を処理中です');
    expect(feedback.classList.contains('hidden')).toBe(false);
    expect(feedback.textContent).toContain('送信中');
    expect(feedback.textContent).toContain('通知を確認したいです');

    composer.value = '次に送りたい内容です';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(resolveSend).not.toBeNull();
    resolveSend!(
      new Response(
        JSON.stringify({
          items: [
            {
              threadId: 'thread-1',
              title: '通知確認',
              outcome: 'attached-existing',
              reason: '既存 task に追記しました',
            },
          ],
          routedCount: 1,
          ambiguousCount: 0,
          detail: '1件を実行キューに回しました',
        }),
        { status: 200 }
      )
    );
    await flushAsync(6);

    expect(sendButton.disabled).toBe(false);
    expect(composer.value).toBe('次に送りたい内容です');
    expect(statusText.textContent).toBe('');
    expect(feedback.textContent).toContain('送信済み');
    expect(feedback.textContent).toContain('1件を実行キューに回しました');
  });

  it('lets the user restore a failed send from the separate feedback lane', async () => {
    const validToken = 'restore-failed-send-token';

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
          return new Response(JSON.stringify([]), { status: 200 });
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

        if (isRoute(url, '/manager/global-send')) {
          return new Response(JSON.stringify({ error: 'send failed' }), {
            status: 500,
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

    document.querySelector<HTMLButtonElement>('#composerToggleButton')!.click();
    await flushAsync(2);

    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    composer.value = '失敗する送信です';
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();
    await flushAsync(6);

    expect(composer.value).toBe('');
    expect(
      document.querySelector<HTMLElement>('#composerFeedback')!.textContent
    ).toContain('送信失敗');

    const restoreButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '#composerFeedback .composer-chip'
      )
    ).find((button) => button.textContent === '送信欄に戻す');
    restoreButton!.click();
    await flushAsync(2);

    expect(composer.value).toBe('失敗する送信です');
  });

  it('keeps the composer compact until the user opens it', async () => {
    const fetchMock = createManagerFetch('compact-composer-token');

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'compact-composer-token');
      },
    });

    const panel = document.querySelector<HTMLElement>('#composerPanel')!;
    const toggle = document.querySelector<HTMLButtonElement>(
      '#composerToggleButton'
    )!;

    expect(panel.classList.contains('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    await flushAsync(2);

    expect(panel.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    document.querySelector<HTMLButtonElement>('#composerCloseButton')!.click();
    await flushAsync(2);

    expect(panel.classList.contains('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('uses real line breaks in the composer placeholder instead of literal \\n text', async () => {
    const fetchMock = createManagerFetch('placeholder-token');

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'placeholder-token');
      },
    });

    const textarea = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;

    expect(textarea.placeholder).toContain('\n\n');
    expect(textarea.placeholder).not.toContain('\\n');
  });

  it('pastes clipboard images into the composer at the cursor without a separate preview pane', async () => {
    const fetchMock = createManagerFetch('composer-paste-token');

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'composer-paste-token');
      },
    });

    document.querySelector<HTMLButtonElement>('#composerToggleButton')!.click();
    await flushAsync(2);

    const textarea = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    textarea.value = '前の説明後ろの説明';
    textarea.setSelectionRange('前の説明'.length, '前の説明'.length);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

    const file = new window.File([Uint8Array.from([1, 2, 3])], 'capture.png', {
      type: 'image/png',
    });
    const pasteEvent = new window.Event('paste', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      configurable: true,
      value: makeImageTransfer(file),
    });
    textarea.dispatchEvent(pasteEvent);
    await flushAsync(8);

    expect(textarea.value).toContain(
      '前の説明\n\n![capture.png](attachment://img-'
    );
    expect(textarea.value).toContain(')\n\n後ろの説明');
    expect(
      document.querySelector<HTMLElement>('#composerAttachmentList')!
        .textContent
    ).toContain('capture.png');
    expect(document.querySelector('#composerPreviewWrap')).toBeNull();
  });

  it('drops images into the composer at the current cursor position', async () => {
    const fetchMock = createManagerFetch('composer-drop-token');

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'composer-drop-token');
      },
    });

    document.querySelector<HTMLButtonElement>('#composerToggleButton')!.click();
    await flushAsync(2);

    const textarea = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    textarea.value = '前の説明\n\n後ろの説明';
    textarea.setSelectionRange('前の説明\n\n'.length, '前の説明\n\n'.length);
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

    const file = new window.File([Uint8Array.from([1, 2, 3])], 'drop.png', {
      type: 'image/png',
    });
    const transfer = makeImageTransfer(file);
    const dragEnterEvent = new window.Event('dragenter', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dragEnterEvent, 'dataTransfer', {
      configurable: true,
      value: transfer,
    });
    textarea.dispatchEvent(dragEnterEvent);
    expect(textarea.classList.contains('composer-textarea-drop-active')).toBe(
      true
    );

    const dropEvent = new window.Event('drop', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dropEvent, 'dataTransfer', {
      configurable: true,
      value: transfer,
    });
    textarea.dispatchEvent(dropEvent);
    await flushAsync(8);

    expect(textarea.value).toContain(
      '前の説明\n\n![drop.png](attachment://img-'
    );
    expect(textarea.value).toContain(')\n\n後ろの説明');
    expect(textarea.classList.contains('composer-textarea-drop-active')).toBe(
      false
    );
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
      },
    });

    const composerDock = document.getElementById(
      'global-composer-dock'
    ) as HTMLElement;
    Object.defineProperty(composerDock, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
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
      }),
    });

    for (let turn = 0; turn < 6 && !resizeObserverCallback; turn += 1) {
      await flushAsync();
    }
    expect(resizeObserverCallback).not.toBeNull();

    (
      resizeObserverCallback as
        | ((entries: ResizeObserverEntry[], observer: ResizeObserver) => void)
        | null
    )?.([] as ResizeObserverEntry[], {} as ResizeObserver);
    await flushAsync(2);
    const initialReservePx = Number.parseInt(
      document.documentElement.style.getPropertyValue(
        '--composer-dock-reserve'
      ),
      10
    );
    expect(initialReservePx).toBeGreaterThanOrEqual(116);

    composerHeight = 268;
    (
      resizeObserverCallback as
        | ((entries: ResizeObserverEntry[], observer: ResizeObserver) => void)
        | null
    )?.([] as ResizeObserverEntry[], {} as ResizeObserver);

    await flushAsync(2);
    const updatedReservePx = Number.parseInt(
      document.documentElement.style.getPropertyValue(
        '--composer-dock-reserve'
      ),
      10
    );
    expect(updatedReservePx).toBeGreaterThanOrEqual(116);
    expect(updatedReservePx).toBeLessThanOrEqual(initialReservePx);
  });

  it('keeps the opened detail scroll position on refresh when the thread content is unchanged', async () => {
    const validToken = 'detail-scroll-token';
    const thread = makeThreadView('thread-scroll', '長い詳細の話題', {
      messages: Array.from({ length: 18 }, (_, index) => ({
        sender: index % 2 === 0 ? 'user' : 'ai',
        content: `message-${index}`,
        at: `2026-03-21T00:${String(index).padStart(2, '0')}:00.000Z`,
      })),
      updatedAt: '2026-03-21T01:00:00.000Z',
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
          return new Response(JSON.stringify([thread]), { status: 200 });
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const firstMsgArea = document.querySelector<HTMLElement>('.msg-area')!;
    firstMsgArea.scrollTop = 180;

    document
      .querySelector<HTMLButtonElement>('[data-action="refresh"]')!
      .click();
    await flushAsync(6);

    const secondMsgArea = document.querySelector<HTMLElement>('.msg-area')!;
    expect(secondMsgArea).toBe(firstMsgArea);
    expect(secondMsgArea.scrollTop).toBe(180);
  });

  it('keeps the same reading position when refresh appends newer messages below it', async () => {
    const validToken = 'good-token';
    let threadsRequestCount = 0;
    const baseMessages = Array.from({ length: 8 }, (_, index) => ({
      sender: (index % 2 === 0 ? 'user' : 'ai') as 'user' | 'ai',
      content: `message-${index}`,
      at: `2026-03-21T00:00:0${index}.000Z`,
    }));
    const appendedMessage = {
      sender: 'ai' as const,
      content: 'new-bottom-message',
      at: '2026-03-21T00:00:09.000Z',
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

        if (isRoute(url, '/threads')) {
          threadsRequestCount += 1;
          const messages =
            threadsRequestCount >= 2
              ? [...baseMessages, appendedMessage]
              : baseMessages;
          const thread = makeThreadView('thread-1', '長文トピック', {
            messages,
            previewText: `[ai] ${messages[messages.length - 1]?.content ?? ''}`,
          });
          return new Response(JSON.stringify([thread]), { status: 200 });
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
        const domWindow = window as Window & typeof globalThis;
        window.localStorage.setItem(authStorageKey, validToken);
        Object.defineProperty(domWindow.HTMLElement.prototype, 'offsetTop', {
          configurable: true,
          get() {
            const element = this as HTMLElement;
            const parent = element.parentElement;
            if (
              element.classList.contains('bubble') &&
              parent?.classList.contains('msg-area')
            ) {
              return Array.from(parent.children).indexOf(element) * 100;
            }
            return 0;
          },
        });
        Object.defineProperty(domWindow.HTMLElement.prototype, 'offsetHeight', {
          configurable: true,
          get() {
            const element = this as HTMLElement;
            if (element.classList.contains('bubble')) {
              return 100;
            }
            if (element.classList.contains('msg-area')) {
              return 300;
            }
            return 0;
          },
        });
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const firstMsgArea = document.querySelector<HTMLElement>('.msg-area')!;
    firstMsgArea.scrollTop = 180;

    document
      .querySelector<HTMLButtonElement>('[data-action="refresh"]')!
      .click();
    await flushAsync(6);

    const secondMsgArea = document.querySelector<HTMLElement>('.msg-area')!;
    expect(secondMsgArea).not.toBe(firstMsgArea);
    expect(secondMsgArea.scrollTop).toBe(180);
  });

  it('keeps the open task inline and shows its new state when it moves between buckets', async () => {
    const validToken = 'movement-token';
    let threadsRequestCount = 0;

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
          threadsRequestCount += 1;
          const thread =
            threadsRequestCount >= 2
              ? makeThreadView('thread-move', '移動する task', {
                  status: 'review',
                  uiState: 'ai-finished-awaiting-user-confirmation',
                  previewText: '[ai] 確認してください',
                  lastSender: 'ai',
                })
              : makeThreadView('thread-move', '移動する task', {
                  status: 'active',
                  uiState: 'ai-working',
                  previewText: '[user] 進行中',
                  lastSender: 'user',
                  isWorking: true,
                  queueDepth: 1,
                });
          return new Response(JSON.stringify([thread]), { status: 200 });
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
              detail:
                threadsRequestCount >= 2 ? '待機中' : '処理中 (移動する task)',
              currentThreadId: threadsRequestCount >= 2 ? null : 'thread-move',
              currentThreadTitle:
                threadsRequestCount >= 2 ? null : '移動する task',
              pendingCount: threadsRequestCount >= 2 ? 0 : 1,
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    document
      .querySelector<HTMLButtonElement>('[data-action="refresh"]')!
      .click();
    await flushAsync(6);

    expect(
      document.querySelector<HTMLElement>('#thread-detail .detail-title')!
        .textContent
    ).toContain('移動する task');
    expect(
      document.querySelector<HTMLElement>('#thread-detail .state-badge')!
        .textContent
    ).toContain('あなたの確認待ち');
    expect(
      document.querySelector<HTMLElement>('#thread-detail .focus-move')!
        .textContent
    ).toContain('AI作業中');
    expect(
      document.querySelector<HTMLElement>('#thread-detail .focus-move')!
        .textContent
    ).toContain('あなたの確認待ち');
  });

  it('automatically reveals the done section when the current task moves to done', async () => {
    const validToken = 'done-move-token';
    let threadsRequestCount = 0;

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
          threadsRequestCount += 1;
          const thread =
            threadsRequestCount >= 2
              ? makeThreadView('thread-done-move', '完了へ移る task', {
                  status: 'resolved',
                  uiState: 'done',
                  hiddenByDefault: true,
                })
              : makeThreadView('thread-done-move', '完了へ移る task', {
                  status: 'review',
                  uiState: 'ai-finished-awaiting-user-confirmation',
                });
          return new Response(JSON.stringify([thread]), { status: 200 });
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    document
      .querySelector<HTMLButtonElement>('[data-action="refresh"]')!
      .click();
    await flushAsync(6);

    expect(
      document
        .querySelector<HTMLElement>('#sec-done')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(
      document.querySelector<HTMLElement>('#thread-detail .state-badge')!
        .textContent
    ).toContain('完了');
  });

  it('shows related work items with open/done counts and lets the user open them from the detail view', async () => {
    const validToken = 'related-work-items-token';
    const parentThread = makeThreadView('thread-parent', '親作業', {
      status: 'active',
      uiState: 'queued',
      previewText: '[user] 親作業です',
      lastSender: 'user',
      derivedChildThreadIds: ['thread-child-open', 'thread-child-done'],
    });
    const openChildThread = makeThreadView(
      'thread-child-open',
      '未完了の派生',
      {
        status: 'active',
        uiState: 'queued',
        previewText: '[user] まだ続きがあります',
        lastSender: 'user',
        derivedFromThreadIds: ['thread-parent'],
      }
    );
    const doneChildThread = makeThreadView('thread-child-done', '完了の派生', {
      status: 'resolved',
      uiState: 'done',
      hiddenByDefault: true,
      previewText: '[ai] 完了しています',
      lastSender: 'ai',
      derivedFromThreadIds: ['thread-parent'],
    });

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [parentThread, openChildThread, doneChildThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '待機中',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    const parentRow = Array.from(
      document.querySelectorAll<HTMLElement>('.thread-row')
    ).find((row) => row.textContent?.includes('親作業'))!;
    expect(
      parentRow.querySelector<HTMLElement>('[data-row-note]')?.textContent
    ).toContain('未完了 1 / 完了 1');

    parentRow.click();
    await flushAsync(3);

    const detail = document.querySelector<HTMLElement>('#thread-detail')!;
    expect(detail.textContent).toContain('関連 work item');
    expect(detail.textContent).toContain('派生先 (未完了 1 / 完了 1)');
    expect(detail.textContent).toContain('未完了の派生');
    expect(detail.textContent).toContain('完了の派生');

    const relatedButton = Array.from(
      detail.querySelectorAll<HTMLButtonElement>('.detail-related-item')
    ).find((button) => button.textContent?.includes('未完了の派生'))!;
    relatedButton.click();
    await flushAsync(3);

    expect(
      document.querySelector<HTMLElement>('#thread-detail .detail-title')!
        .textContent
    ).toContain('未完了の派生');
  });
});

describe('manager-app activity summary', () => {
  it('shows a clear busy summary and state counts when work is in progress', async () => {
    const fetchMock = createManagerFetchWithData({
      validToken: 'activity-token',
      threads: [
        makeThreadView('reply-needed', '返信待ち', {
          status: 'needs-reply',
          uiState: 'user-reply-needed',
          previewText: '[ai] 返信をください',
          lastSender: 'ai',
        }),
        makeThreadView('review-ready', '確認待ち', {
          status: 'review',
          uiState: 'ai-finished-awaiting-user-confirmation',
          previewText: '[ai] 確認してください',
          lastSender: 'ai',
        }),
      ],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (PID 1234)',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'activity-token');
      },
    });

    expect(
      document.querySelector<HTMLElement>('#activity-primary')!.textContent
    ).toContain('AI が作業や振り分けを進めています');
    expect(
      document.querySelector<HTMLElement>('#activity-detail')!.textContent
    ).toContain('いまの作業項目を実行中です');

    const chips = Array.from(
      document.querySelectorAll<HTMLElement>('.activity-chip')
    ).map((element) => element.textContent ?? '');

    expect(chips).toContain('返信待ち 1');
    expect(chips).toContain('AIから返答 1');
    expect(chips).toContain('AI の順番待ち 0');
    expect(chips).toContain('AI作業中 0');
  });
});

describe('manager-app live updates', () => {
  it('uses the live snapshot stream instead of interval polling', async () => {
    const fetchMock = createManagerFetchWithData({
      validToken: 'live-stream-token',
      threads: [],
    });

    await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'live-stream-token');
      },
    });

    expect(
      window.setInterval as unknown as ReturnType<typeof vi.fn>
    ).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some(([input]) => isRoute(String(input), '/live'))
    ).toBe(true);
  });

  it('renders the in-flight worker output as the latest AI bubble in detail view', async () => {
    const workingThread = makeThreadView('thread-live', 'リアルタイム出力', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 実装してください',
      assigneeKind: 'worker',
      assigneeLabel: 'Codex gpt-5.4 (xhigh)',
      workerLiveOutput: 'いま `src/manager-backend.ts` を見ています。',
      workerLiveAt: '2026-03-23T08:00:00.000Z',
      messages: [
        {
          sender: 'user',
          content: '実装してください',
          at: '2026-03-23T07:59:00.000Z',
        },
      ],
    });

    const fetchMock = createManagerFetchWithData({
      validToken: 'live-output-token',
      threads: [workingThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (リアルタイム出力)',
        currentThreadId: 'thread-live',
        currentThreadTitle: 'リアルタイム出力',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'live-output-token');
      },
    });

    const row = document.querySelector<HTMLElement>('.thread-row')!;
    row.click();
    await flushAsync(3);

    const detail = document.querySelector<HTMLElement>('#thread-detail')!;
    expect(detail.textContent).toContain('担当: Codex gpt-5.4 (xhigh)');
    expect(detail.textContent).toContain(
      'いま src/manager-backend.ts を見ています。'
    );
    expect(
      detail.querySelector<HTMLElement>('.bubble-live .bubble-sender')
        ?.textContent
    ).toContain('AI');
  });
});
