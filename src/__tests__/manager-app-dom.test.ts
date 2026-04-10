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
const feedbackStorageKey = 'workspace-agent-hub.manager-feedback:D:\\ghws';
const sortStorageKey = 'workspace-agent-hub.manager-sort:D:\\ghws';

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
    managedRepoId: null,
    managedRepoLabel: null,
    managedRepoRoot: null,
    repoTargetKind: null,
    newRepoName: null,
    newRepoRoot: null,
    managedBaseBranch: null,
    managedVerifyCommand: null,
    requestedWorkerRuntime: null,
    requestedRunMode: null,
    queueDepth: 0,
    isWorking: false,
    assigneeKind: null,
    assigneeLabel: null,
    workerAgentId: null,
    workerRuntimeState: null,
    workerRuntimeDetail: null,
    workerWriteScopes: [],
    workerBlockedByThreadIds: [],
    supersededByThreadId: null,
    workerLiveLog: [],
    workerLiveOutput: null,
    workerLiveAt: null,
    ...overrides,
  };
}

type ThreadViewFixture = ReturnType<typeof makeThreadView>;

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

    if (isRoute(url, '/manager/repos')) {
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
          repos: [],
          status: {
            running: false,
            configured: true,
            builtinBackend: true,
            detail: '未起動 — メッセージ送信で自動起動します',
          },
        },
      ]);
    }

    if (isRoute(url, '/builds')) {
      return new Response(JSON.stringify({ builds: [], currentHash: '' }), {
        status: 200,
      });
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
  repos?: Array<{
    id: string;
    label: string;
    repoRoot: string;
    defaultBranch: string;
    verifyCommand: string;
    supportedWorkerRuntimes: string[];
    preferredWorkerRuntime: string | null;
    mergeLaneEnabled: boolean;
  }>;
  status?: {
    running: boolean;
    configured: boolean;
    builtinBackend: boolean;
    health?: 'ok' | 'error';
    detail: string;
    pendingCount?: number;
    currentQueueId?: string | null;
    currentThreadId?: string | null;
    currentThreadTitle?: string | null;
    errorMessage?: string | null;
    errorAt?: string | null;
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

    if (isRoute(url, '/manager/repos')) {
      return new Response(JSON.stringify(input.repos ?? []), { status: 200 });
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
          repos: input.repos ?? [],
          status: input.status ?? {
            running: false,
            configured: true,
            builtinBackend: true,
            detail: '未起動 — メッセージ送信で自動起動します',
          },
        },
      ]);
    }

    if (isRoute(url, '/builds')) {
      return new Response(JSON.stringify({ builds: [], currentHash: '' }), {
        status: 200,
      });
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
  const previousWindow = globalThis.window as
    | (Window & {
        __workspaceAgentHubManagerApp__?: { dispose?: () => void };
      })
    | undefined;
  previousWindow?.__workspaceAgentHubManagerApp__?.dispose?.();

  const dom = new JSDOM(managerHtml, {
    url: options?.url ?? 'https://hub.example.test/manager/',
    pretendToBeVisual: true,
  });

  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('localStorage', dom.window.localStorage);
  const managerFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (isRoute(url, '/live')) {
        const direct = await fetchMock(input, init);
        const directContentType = direct.headers.get('content-type') ?? '';
        if (
          direct.ok &&
          direct.body &&
          directContentType.includes('application/x-ndjson')
        ) {
          return direct;
        }

        const headers = new Headers(init?.headers ?? {});
        const [threadsRes, tasksRes, statusRes] = await Promise.all([
          fetchMock('./api/threads', { headers }),
          fetchMock('./api/tasks', { headers }),
          fetchMock('./api/manager/status', { headers }),
        ]);
        if (threadsRes.ok && tasksRes.ok && statusRes.ok) {
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: (await threadsRes.json()) as ThreadViewFixture[],
              tasks: (await tasksRes.json()) as unknown[],
              status: (await statusRes.json()) as Record<string, unknown>,
            },
          ]);
        }
        return direct;
      }
      return fetchMock(input, init);
    }
  ) as unknown as typeof fetch;
  vi.stubGlobal('fetch', managerFetch);

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

function textList(document: Document, selector: string): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .map((element) => element.textContent?.trim() ?? '')
    .filter(Boolean);
}

function visibleComposerShellChildIds(document: Document): string[] {
  const shell = document.querySelector<HTMLElement>('.composer-shell');
  if (!shell) {
    return [];
  }
  return Array.from(shell.children)
    .filter((element) => !(element as HTMLElement).classList.contains('hidden'))
    .map((element) => (element as HTMLElement).id)
    .filter(Boolean);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  const activeWindow = globalThis.window as
    | (Window & {
        __workspaceAgentHubManagerApp__?: { dispose?: () => void };
      })
    | undefined;
  activeWindow?.__workspaceAgentHubManagerApp__?.dispose?.();
  vi.unstubAllGlobals();
});

describe('manager-app DOM auth state matrix', () => {
  it('describes mobile and desktop image insertion paths in the composer', () => {
    const document = new JSDOM(managerHtml).window.document;
    const pickerButton = document.querySelector<HTMLButtonElement>(
      '#composerImagePickerButton'
    );

    expect(managerHtml).toContain(
      'スマホは画像アイコン、PC はドラッグ&ドロップか Ctrl /'
    );
    expect(pickerButton).not.toBeNull();
    expect(pickerButton?.getAttribute('aria-label')).toBe('画像を選ぶ');
    expect(pickerButton?.getAttribute('title')).toBe('画像を選ぶ');
    expect(pickerButton?.textContent?.trim()).toBe('');
    expect(pickerButton?.querySelector('svg')).not.toBeNull();
    expect(managerHtml).toContain('id="composerImagePickerInput"');
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

  it('keeps the open work-item composer compact and removes duplicate thread chrome', () => {
    expect(managerHtml).toMatch(
      /\.composer-dock-thread-mode \.composer-card-top\s+\{\s+display: none;/
    );
    expect(managerHtml).toMatch(
      /\.composer-dock-thread-mode \.composer-tools,\s+\.composer-dock-thread-mode \.composer-actions \.composer-hint\s+\{\s+display: none;/
    );
    expect(managerHtml).toMatch(
      /\.composer-dock-thread-mode \.composer-textarea\s+\{\s+min-height: 44px;\s+max-height: 112px;/
    );
    expect(managerHtml).not.toContain('id="thread-screen-subtitle"');
  });

  it('keeps the send target beside the send button without extra SEND or Markdown copy', () => {
    expect(managerHtml).not.toContain('>Send<');
    expect(managerHtml).not.toContain('AI の返答は Markdown 表示です。');
    expect(managerHtml).not.toContain(
      'まず一覧を見て、書くときだけ送信欄を開けます。'
    );
    expect(managerHtml).not.toContain('composer-rail');
    expect(managerHtml).not.toContain('composerStatusText');
    expect(managerHtml).toContain(
      'id="composerHint" class="composer-hint hidden"'
    );
    expect(managerHtml).toMatch(
      /<div class="composer-actions">\s*<div id="composerTargetBar"[\s\S]*?<button id="globalComposerSendButton"/
    );
    expect(managerHtml).toMatch(
      /\.composer-actions #globalComposerSendButton\s+\{\s+min-width: 84px;/
    );
  });

  it('keeps Manager task creation on the normal composer instead of a separate new-task surface', () => {
    expect(managerHtml).not.toContain('id="newTaskOpenButton"');
    expect(managerHtml).not.toContain('id="newTaskSheetBackdrop"');
    expect(managerHtml).not.toContain('id="managedRepoForm"');
    expect(managerHtml).toContain('下の送信欄に依頼や質問を送るだけで');
    expect(managerHtml).toMatch(/Manager\s+が既存の作業項目への追記/);
  });

  it('moves routed and recently sent items into a separate processing lane', () => {
    expect(managerHtml).toContain('id="routingFeedbackLane"');
    expect(managerHtml).toContain('id="routingFeedbackList"');
    expect(managerHtml).toContain('id="routingFeedbackSummary"');
    expect(managerHtml).toContain('id="routingFeedbackToggleButton"');
    expect(managerHtml).toContain('id="routingFeedbackClearButton"');
    expect(managerHtml).not.toContain('id="composerFeedback"');
    expect(managerHtml).toMatch(
      /<main id="manager-main"[\s\S]*id="routingFeedbackLane"[\s\S]*id="manager-inbox-screen"/
    );
    expect(managerHtml).not.toContain('直前の送信');
  });

  it('keeps always-visible manager chrome minimal', () => {
    expect(managerHtml).not.toContain('id="dir-label"');
    expect(managerHtml).not.toContain('↻ 更新');
    expect(managerHtml).toContain('残っている作業メモ');
  });

  it('keeps first-use routing detail behind an optional disclosure instead of showing it all the time', async () => {
    expect(managerHtml).toContain('id="getting-started-details"');
    expect(managerHtml).toContain('どう整理されるかを見る');
    expect(managerHtml).toMatch(
      /<details id="getting-started-details" class="intro-details">[\s\S]*既存の作業項目への追記、新しい作業項目、\s*確認が必要なもの/
    );

    const validToken = 'getting-started-details-token';
    const document = await loadManagerApp(createManagerFetch(validToken), {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    expect(
      document
        .querySelector<HTMLElement>('#getting-started')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(
      document.querySelector<HTMLDetailsElement>('#getting-started-details')!
        .open
    ).toBe(false);
  });

  it('hides default composer help when the screen already makes the action obvious', async () => {
    const validToken = 'default-composer-hint-token';
    const document = await loadManagerApp(createManagerFetch(validToken), {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
      },
    });

    const hint = document.querySelector<HTMLElement>('#composerHint')!;
    expect(hint.textContent).toBe('');
    expect(hint.classList.contains('hidden')).toBe(true);
  });

  it('does not render a managed repo registration form or call its API', async () => {
    const validToken = 'managed-repo-runtime-token';
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
              emittedAt: '2026-03-27T00:00:00.000Z',
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
        if (isRoute(url, '/builds')) {
          return new Response(JSON.stringify({ builds: [], currentHash: '' }), {
            status: 200,
          });
        }
        return new Response('{}', { status: 200 });
      }
    );

    const document = await loadManagerApp(
      fetchMock as unknown as typeof fetch,
      {
        authRequired: true,
        beforeImport: (window) => {
          window.localStorage.setItem(authStorageKey, validToken);
        },
      }
    );

    expect(
      document.querySelector<HTMLFormElement>('#managedRepoForm')
    ).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        isRoute(String(input), '/manager/repos')
      )
    ).toBe(false);
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
          !isRoute(url, '/manager/repos') &&
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
    await flushAsync(4);

    expect(document.defaultView?.localStorage.getItem(authStorageKey)).toBe(
      'fresh-token'
    );
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
          !isRoute(url, '/manager/repos') &&
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

    Array.from(document.querySelectorAll<HTMLElement>('.thread-row'))
      .find((row) => row.textContent?.includes('今見ている task'))
      ?.click();
    await flushAsync(3);

    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信先: この会話');
    expect(
      document.querySelector<HTMLButtonElement>('#composerTargetClearButton')!
        .textContent
    ).toContain('別件にする');

    document
      .querySelector<HTMLButtonElement>('#composerTargetClearButton')!
      .click();
    await flushAsync(2);

    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    composer.value = 'AAして、BBして';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();

    await flushAsync(6);

    const feedbackLane = document.querySelector<HTMLElement>(
      '#routingFeedbackLane'
    )!;
    const feedbackList = document.querySelector<HTMLElement>(
      '#routingFeedbackList'
    )!;
    const feedbackToggleButton = document.querySelector<HTMLButtonElement>(
      '#routingFeedbackToggleButton'
    )!;
    expect(feedbackLane.textContent).toContain('送信状況');
    expect(feedbackLane.textContent).toContain('送信済み 1件');
    expect(feedbackList.classList.contains('hidden')).toBe(true);
    expect(
      document
        .querySelector<HTMLElement>('#composerPanel')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(composer.value).toBe('');
    feedbackToggleButton.click();
    await flushAsync(2);
    expect(feedbackList.classList.contains('hidden')).toBe(false);
    expect(feedbackLane.textContent).toContain('2件を処理しました');
    const feedbackButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '#routingFeedbackLane .composer-chip'
      )
    ).filter((button) => button.textContent !== '削除');
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
    ).toContain('送信先: 全体（別件）');

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
    ).toContain('送信先: この会話');
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

  it('marks a thread done immediately and disables repeated completion presses until the server responds', async () => {
    const validToken = 'resolve-optimistic-token';
    const thread = makeThreadView('thread-resolve', '完了確認');
    let threadFetchCount = 0;
    let resolveCallCount = 0;
    let settleResolve!: (response: Response) => void;

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
          threadFetchCount += 1;
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

        if (isRoute(url, '/live')) {
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: [thread],
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
        }

        if (isRoute(url, '/threads/thread-resolve/resolve')) {
          resolveCallCount += 1;
          return await new Promise<Response>((resolve) => {
            settleResolve = resolve;
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const firstButton = document.querySelector<HTMLButtonElement>(
      '#thread-detail .detail-actions button'
    )!;
    firstButton.click();
    await flushAsync(2);

    const pendingButton = document.querySelector<HTMLButtonElement>(
      '#thread-detail .detail-actions button'
    )!;
    expect(pendingButton.disabled).toBe(true);
    expect(pendingButton.textContent).toBe('完了にしています…');
    expect(
      document.querySelector<HTMLElement>('#thread-detail')!.textContent
    ).toContain('この作業項目は完了として閉じています。');
    expect(
      document.querySelector<HTMLElement>('#activity-counts')!.textContent
    ).toContain('完了 1');

    pendingButton.click();
    await flushAsync(2);

    expect(resolveCallCount).toBe(1);
    expect(threadFetchCount).toBe(0);

    settleResolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await flushAsync(6);

    const settledButton = document.querySelector<HTMLButtonElement>(
      '#thread-detail .detail-actions button'
    )!;
    expect(settledButton.disabled).toBe(false);
    expect(settledButton.textContent).toBe('もう一度開く');
    expect(resolveCallCount).toBe(1);
    expect(threadFetchCount).toBe(0);
  });

  it('restores the original thread state when optimistic completion fails', async () => {
    const validToken = 'resolve-rollback-token';
    const thread = makeThreadView('thread-rollback', '失敗確認');
    let settleResolve!: (response: Response) => void;

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

        if (isRoute(url, '/live')) {
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: [thread],
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
        }

        if (isRoute(url, '/threads/thread-rollback/resolve')) {
          return await new Promise<Response>((resolve) => {
            settleResolve = resolve;
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

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    document
      .querySelector<HTMLButtonElement>(
        '#thread-detail .detail-actions button'
      )!
      .click();
    await flushAsync(2);

    expect(
      document.querySelector<HTMLElement>('#thread-detail')!.textContent
    ).toContain('この作業項目は完了として閉じています。');

    settleResolve(
      new Response(JSON.stringify({ error: 'resolve failed' }), {
        status: 500,
      })
    );
    await flushAsync(6);

    const restoredButton = document.querySelector<HTMLButtonElement>(
      '#thread-detail .detail-actions button'
    )!;
    expect(restoredButton.disabled).toBe(false);
    expect(restoredButton.textContent).toBe('この件は完了');
    expect(
      document.querySelector<HTMLElement>('#thread-detail')!.textContent
    ).toContain('AI の中では一区切りついています。');
  });

  it('does not render the removed read-first section', async () => {
    const validToken = 'removed-read-first-section-token';
    const fetchMock = createManagerFetchWithData({
      validToken,
      threads: [
        makeThreadView('thread-reply', '返事が必要', {
          uiState: 'user-reply-needed',
          previewText: '[ai] 返答してください',
          lastSender: 'ai',
        }),
      ],
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

    expect(document.querySelector('#priority-lane')).toBeNull();
    expect(
      textList(document, '#body-user-reply-needed .thread-row [data-row-title]')
    ).toEqual(['返事が必要']);
  });

  it('hides empty sections and reopens them when items arrive', async () => {
    const validToken = 'auto-reopen-empty-sections-token';
    let threads: Array<ReturnType<typeof makeThreadView>> = [];

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
          return new Response(JSON.stringify(threads), { status: 200 });
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

        if (isRoute(url, '/live')) {
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads,
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
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

    const replySection = document.querySelector<HTMLElement>(
      '#sec-user-reply-needed'
    )!;
    const replyBody = document.querySelector<HTMLElement>(
      '#body-user-reply-needed'
    )!;
    expect(replySection.classList.contains('hidden')).toBe(true);
    expect(replyBody.style.display).toBe('none');
    expect(
      document.querySelector<HTMLElement>('#chevron-user-reply-needed')
        ?.textContent
    ).toBe('▼');

    threads = [
      makeThreadView('thread-reply', 'あとから来た返信待ち', {
        uiState: 'user-reply-needed',
        status: 'needs-reply',
        previewText: '[ai] 返答してください',
        lastSender: 'ai',
      }),
    ];

    document
      .querySelector<HTMLButtonElement>('[data-action="refresh"]')!
      .click();
    await flushAsync(6);

    expect(replySection.classList.contains('hidden')).toBe(false);
    expect(replyBody.style.display).toBe('');
    expect(
      document.querySelector<HTMLElement>('#chevron-user-reply-needed')
        ?.textContent
    ).toBe('▲');
    expect(
      textList(document, '#body-user-reply-needed .thread-row [data-row-title]')
    ).toEqual(['あとから来た返信待ち']);
  });

  it('tells the user there is nothing to do when only queued or working items remain', async () => {
    const validToken = 'background-only-token';
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

    expect(
      document.querySelector<HTMLElement>('#activity-primary')!.textContent
    ).toContain('AI の順番待ちがあります');
    expect(
      document
        .querySelector<HTMLElement>('#sec-routing-confirmation-needed')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLElement>('#sec-user-reply-needed')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLElement>(
          '#sec-ai-finished-awaiting-user-confirmation'
        )!
        .classList.contains('hidden')
    ).toBe(true);
    const chips = Array.from(
      document.querySelectorAll<HTMLElement>('.activity-chip')
    ).map((element) => element.textContent ?? '');
    expect(chips).toContain('AI の順番待ち 1');
  });

  it('defaults human-facing lists to oldest-first and AI lists to newest-first', async () => {
    const validToken = 'section-sort-defaults-token';
    const threads = [
      makeThreadView('human-new', '新しい返信待ち', {
        status: 'needs-reply',
        uiState: 'user-reply-needed',
        previewText: '[ai] 新しい返信待ち',
        lastSender: 'ai',
        updatedAt: '2026-03-21T01:00:00.000Z',
      }),
      makeThreadView('ai-old', '古いAI作業', {
        status: 'active',
        uiState: 'ai-working',
        previewText: '[user] 古いAI作業',
        lastSender: 'user',
        isWorking: true,
        updatedAt: '2026-03-21T00:30:00.000Z',
      }),
      makeThreadView('ai-new', '新しいAI作業', {
        status: 'active',
        uiState: 'ai-working',
        previewText: '[user] 新しいAI作業',
        lastSender: 'user',
        isWorking: true,
        updatedAt: '2026-03-21T02:00:00.000Z',
      }),
      makeThreadView('human-old', '古い返信待ち', {
        status: 'needs-reply',
        uiState: 'user-reply-needed',
        previewText: '[ai] 古い返信待ち',
        lastSender: 'ai',
        updatedAt: '2026-03-21T00:00:00.000Z',
      }),
    ];

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads,
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

    expect(
      textList(document, '#body-user-reply-needed .thread-row [data-row-title]')
    ).toEqual(['古い返信待ち', '新しい返信待ち']);
    expect(
      textList(document, '#body-ai-working .thread-row [data-row-title]')
    ).toEqual(['新しいAI作業', '古いAI作業']);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-sort-control="ai-working"]'
      )?.textContent
    ).toContain('上: 新しい');
  });

  it('lets the user flip section sort order and keeps the choice after reload', async () => {
    const validToken = 'section-sort-toggle-token';
    const threads = [
      makeThreadView('reply-new', '新しい確認', {
        status: 'needs-reply',
        uiState: 'user-reply-needed',
        previewText: '[ai] 新しい確認',
        lastSender: 'ai',
        updatedAt: '2026-03-21T01:00:00.000Z',
      }),
      makeThreadView('reply-old', '古い確認', {
        status: 'needs-reply',
        uiState: 'user-reply-needed',
        previewText: '[ai] 古い確認',
        lastSender: 'ai',
        updatedAt: '2026-03-21T00:00:00.000Z',
      }),
    ];

    const fetchMock = createManagerFetchWithData({
      validToken,
      threads,
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

    expect(
      textList(document, '#body-user-reply-needed .thread-row [data-row-title]')
    ).toEqual(['古い確認', '新しい確認']);

    document
      .querySelector<HTMLButtonElement>(
        '[data-sort-control="user-reply-needed"]'
      )!
      .click();
    await flushAsync(2);

    expect(
      textList(document, '#body-user-reply-needed .thread-row [data-row-title]')
    ).toEqual(['新しい確認', '古い確認']);

    const storedSortOrder = window.localStorage.getItem(sortStorageKey);
    expect(storedSortOrder).toContain('"user-reply-needed":"newest-first"');

    const reloadedDocument = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
        if (storedSortOrder) {
          window.localStorage.setItem(sortStorageKey, storedSortOrder);
        }
      },
    });

    expect(
      textList(
        reloadedDocument,
        '#body-user-reply-needed .thread-row [data-row-title]'
      )
    ).toEqual(['新しい確認', '古い確認']);
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

  it('places the completion action right below the latest chat area in conversation view', async () => {
    const validToken = 'complete-action-below-latest-chat-token';
    const thread = makeThreadView('thread-complete-action', '完了位置の確認', {
      messages: [
        {
          sender: 'user',
          content: '先に読むメッセージ',
          at: '2026-03-21T00:00:00.000Z',
        },
        {
          sender: 'ai',
          content: '最後に読んで判断するメッセージ',
          at: '2026-03-21T00:01:00.000Z',
        },
      ],
      previewText: '[ai] 最後に読んで判断するメッセージ',
      lastSender: 'ai',
      updatedAt: '2026-03-21T00:01:00.000Z',
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

    const detail = document.querySelector<HTMLElement>('#thread-detail')!;
    const msgArea = detail.querySelector<HTMLElement>('.msg-area')!;
    const actions = detail.querySelector<HTMLElement>('.detail-actions')!;
    const button = actions.querySelector<HTMLButtonElement>('button')!;
    const bubbles = Array.from(
      msgArea.querySelectorAll<HTMLElement>('.bubble-content')
    ).map((element) => element.textContent?.trim());

    expect(bubbles.at(-1)).toBe('最後に読んで判断するメッセージ');
    expect(actions.previousElementSibling).toBe(msgArea);
    expect(button.textContent).toBe('この件は完了');
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

  it('sends directly to the open topic and can still switch back to global routing', async () => {
    const validToken = 'target-send-token';
    const thread = makeThreadView('thread-target', '特定 task');
    const seenDirectBodies: Array<{
      threadId: string;
      content: string;
    }> = [];
    const seenGlobalBodies: Array<{
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

        if (isRoute(url, '/manager/send')) {
          seenDirectBodies.push(JSON.parse(String(init?.body)));
          return new Response(
            JSON.stringify({
              queued: true,
              items: [
                {
                  threadId: 'thread-target',
                  title: '特定 task',
                  outcome: 'attached-existing',
                  reason: 'この会話に追加しました',
                },
              ],
              routedCount: 1,
              ambiguousCount: 0,
              detail: 'この会話に追加しました',
            }),
            { status: 200 }
          );
        }

        if (isRoute(url, '/manager/global-send')) {
          seenGlobalBodies.push(JSON.parse(String(init?.body)));
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
      document
        .querySelector<HTMLElement>('#global-composer-dock')!
        .classList.contains('composer-dock-thread-mode')
    ).toBe(true);
    expect(
      document.querySelector<HTMLElement>('#composerHint')!.textContent
    ).toBe('');
    expect(
      document
        .querySelector<HTMLElement>('#composerHint')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信先: この会話');
    expect(
      document.querySelector<HTMLButtonElement>('#composerTargetClearButton')!
        .textContent
    ).toContain('別件にする');
    expect(
      document
        .querySelector<HTMLElement>('#composerPanel')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(visibleComposerShellChildIds(document)).toEqual(['composerPanel']);

    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    composer.value = 'この task を続けて';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();
    await flushAsync(6);

    expect(seenDirectBodies[0]).toEqual({
      threadId: 'thread-target',
      content: 'この task を続けて',
    });
    expect(seenGlobalBodies).toEqual([]);
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
    ).toContain('送信先: 全体（別件）');
    expect(
      document.querySelector<HTMLButtonElement>('#composerTargetClearButton')!
        .textContent
    ).toContain('この会話に戻す');

    composer.value = 'これは別件です';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();
    await flushAsync(6);

    expect(seenGlobalBodies[0]).toEqual({
      content: 'これは別件です',
      contextThreadId: null,
    });
    expect(seenDirectBodies).toHaveLength(1);
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
    ).toContain('送信先: この会話');
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

    expect(
      document
        .querySelector<HTMLElement>('#global-composer-dock')!
        .classList.contains('composer-dock-thread-mode')
    ).toBe(true);
    expect(
      document.querySelector<HTMLElement>('#composerHint')!.textContent
    ).toContain('この会話の続きはここへ追加指示として直接送れます');
    expect(
      document.querySelector<HTMLElement>('#composerTargetPill')!.textContent
    ).toContain('送信先: この会話（追加指示）');
    expect(
      document.querySelector<HTMLElement>('#composerContext')!.textContent
    ).toBe('');
    expect(
      document
        .querySelector<HTMLElement>('#composerContext')!
        .classList.contains('hidden')
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>('#composerTargetClearButton')!
        .textContent
    ).toContain('別件にする');
    expect(
      document.querySelector<HTMLButtonElement>('#globalComposerSendButton')!
        .textContent
    ).toBe('追加指示を送る');
  });

  it('moves sent drafts into a separate feedback lane immediately so the composer can keep sending while routing continues', async () => {
    const validToken = 'separate-feedback-token';
    const resolveSends: Array<(response: Response) => void> = [];

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
            resolveSends.push(resolve);
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
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await flushAsync(2);

    const feedback = document.querySelector<HTMLElement>(
      '#routingFeedbackLane'
    )!;
    const feedbackList = document.querySelector<HTMLElement>(
      '#routingFeedbackList'
    )!;
    const feedbackToggleButton = document.querySelector<HTMLButtonElement>(
      '#routingFeedbackToggleButton'
    )!;

    expect(composer.value).toBe('');
    expect(sendButton.disabled).toBe(true);
    expect(sendButton.textContent).toBe('送る');
    expect(feedback.classList.contains('hidden')).toBe(false);
    expect(feedback.textContent).toContain('送信状況');
    expect(feedback.textContent).toContain('送信中 1件');
    expect(feedbackList.classList.contains('hidden')).toBe(true);
    expect(feedbackToggleButton.textContent).toBe('開く');
    expect(feedback.textContent).not.toContain('通知を確認したいです');

    composer.value = '次に送りたい内容です';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await flushAsync(2);

    expect(resolveSends).toHaveLength(2);
    expect(composer.value).toBe('');
    expect(sendButton.disabled).toBe(true);
    expect(sendButton.textContent).toBe('送る');
    expect(feedback.textContent).toContain('送信中 2件');
    expect(feedback.textContent).not.toContain('通知を確認したいです');
    expect(feedback.textContent).not.toContain('次に送りたい内容です');

    resolveSends[0]!(
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
    resolveSends[1]!(
      new Response(
        JSON.stringify({
          items: [
            {
              threadId: 'thread-2',
              title: '別の task',
              outcome: 'created-new',
              reason: '新しい task を作りました',
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

    expect(sendButton.disabled).toBe(true);
    expect(sendButton.textContent).toBe('送る');
    expect(composer.value).toBe('');
    expect(feedback.textContent).toContain('送信状況');
    expect(feedback.textContent).toContain('送信済み 2件');
    expect(feedbackList.classList.contains('hidden')).toBe(true);

    feedbackToggleButton.click();
    await flushAsync(2);

    expect(feedbackToggleButton.textContent).toBe('閉じる');
    expect(feedbackList.classList.contains('hidden')).toBe(false);
    expect(feedback.textContent).toContain('送信済み');
    expect(feedback.textContent).toContain('1件を実行キューに回しました');
    expect(feedback.textContent).toContain('通知を確認したいです');
    expect(feedback.textContent).toContain('次に送りたい内容です');
  });

  it('disables the global composer send button until the draft has non-empty content', async () => {
    const fetchMock = createManagerFetch('empty-send-token');

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'empty-send-token');
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

    expect(sendButton.disabled).toBe(true);

    composer.value = '   ';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flushAsync(1);
    expect(sendButton.disabled).toBe(true);

    composer.value = '進めてください';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    await flushAsync(1);
    expect(sendButton.disabled).toBe(false);

    sendButton.click();
    await flushAsync(4);
    expect(sendButton.disabled).toBe(true);
  });

  it('automatically retries a failed send with the original target and does not restore it to the composer', async () => {
    const validToken = 'auto-retry-failed-send-token';
    const targetThread = makeThreadView('thread-target', '続きの task', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 続きをお願いします',
    });
    const requestBodies: string[] = [];
    let sendAttemptCount = 0;

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
          return new Response(JSON.stringify([targetThread]), { status: 200 });
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
          requestBodies.push(String(init?.body ?? ''));
          sendAttemptCount += 1;
          if (sendAttemptCount === 1) {
            return new Response(JSON.stringify({ error: 'send failed' }), {
              status: 500,
            });
          }
          return new Response(
            JSON.stringify({
              items: [
                {
                  threadId: 'thread-target',
                  title: '続きの task',
                  outcome: 'attached-existing',
                  reason: '既存 task に追記しました',
                },
              ],
              routedCount: 1,
              ambiguousCount: 0,
              detail: '既存 task に追記しました',
            }),
            { status: 200 }
          );
        }

        if (isRoute(url, '/live')) {
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: [targetThread],
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
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
    (
      window as Window & {
        __workspaceAgentHubManagerApp__?: {
          focusComposerForThread: (threadId: string | null) => void;
        };
      }
    ).__workspaceAgentHubManagerApp__?.focusComposerForThread('thread-target');
    await flushAsync(2);

    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    composer.value = '失敗する送信です';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();
    await flushAsync(10);

    expect(composer.value).toBe('');
    expect(sendAttemptCount).toBe(2);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0] ?? '{}')).toMatchObject({
      content: '失敗する送信です',
      contextThreadId: 'thread-target',
    });
    expect(
      document.querySelector<HTMLElement>('#routingFeedbackLane')!.textContent
    ).toContain('送信済み 1件');

    document
      .querySelector<HTMLButtonElement>('#routingFeedbackToggleButton')!
      .click();
    await flushAsync(2);

    const restoreButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '#routingFeedbackLane .composer-chip'
      )
    ).filter((button) => button.textContent === '送信欄に戻す');
    expect(restoreButtons).toHaveLength(0);
    expect(
      document.querySelector<HTMLElement>('#routingFeedbackLane')!.textContent
    ).toContain('既存 task に追記しました');
  });

  it('resumes stored auto-retries after a reload', async () => {
    const validToken = 'retry-on-reload-token';
    const targetThread = makeThreadView(
      'thread-reload-target',
      '再送待ち task'
    );
    const storedFeedback = JSON.stringify({
      entries: [
        {
          id: 'composer-feedback-stored',
          content: serializeManagerMessage({
            content: '再読込後も送ってほしい内容です',
          }),
          targetLabel: '送信先: @再送待ち task',
          status: 'retrying',
          detail: '送信エラーのため自動再送します。',
          items: [],
          request: {
            route: 'global',
            content: '再読込後も送ってほしい内容です',
            contextThreadId: 'thread-reload-target',
          },
          attemptCount: 1,
          nextRetryAt: '2026-03-20T23:59:59.000Z',
        },
      ],
    });
    const requestBodies: string[] = [];
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
          return new Response(JSON.stringify([targetThread]), { status: 200 });
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
          requestBodies.push(String(init?.body ?? ''));
          return new Response(
            JSON.stringify({
              items: [
                {
                  threadId: 'thread-reload-target',
                  title: '再送待ち task',
                  outcome: 'attached-existing',
                  reason: '再送に成功しました',
                },
              ],
              routedCount: 1,
              ambiguousCount: 0,
              detail: '再送に成功しました',
            }),
            { status: 200 }
          );
        }

        if (isRoute(url, '/live')) {
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: [targetThread],
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
        }

        return new Response('{}', { status: 200 });
      }
    ) as unknown as typeof fetch;

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, validToken);
        window.localStorage.setItem(feedbackStorageKey, storedFeedback);
      },
    });
    await flushAsync(8);

    expect(requestBodies).toHaveLength(1);
    expect(JSON.parse(requestBodies[0] ?? '{}')).toMatchObject({
      content: '再読込後も送ってほしい内容です',
      contextThreadId: 'thread-reload-target',
    });
    expect(
      document.querySelector<HTMLElement>('#routingFeedbackLane')!.textContent
    ).toContain('送信済み 1件');
    document
      .querySelector<HTMLButtonElement>('#routingFeedbackToggleButton')!
      .click();
    await flushAsync(2);
    expect(
      document.querySelector<HTMLElement>('#routingFeedbackLane')!.textContent
    ).toContain('再送に成功しました');
  });

  it('keeps the send status lane after a reload and only shows details when opened', async () => {
    const validToken = 'persist-feedback-token';
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
          return new Response(
            JSON.stringify({
              items: [
                {
                  threadId: 'thread-1',
                  title: '残したい task',
                  outcome: 'created-new',
                  reason: '新しい task を作りました',
                },
              ],
              routedCount: 1,
              ambiguousCount: 0,
              detail: '1件を実行キューに回しました',
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
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
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
    composer.value = '消えずに残したい送信';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    document
      .querySelector<HTMLButtonElement>('#globalComposerSendButton')!
      .click();
    await flushAsync(6);

    const storedFeedback = window.localStorage.getItem(feedbackStorageKey);
    expect(storedFeedback).not.toBe(null);
    expect(storedFeedback).toContain('消えずに残したい送信');

    const reloadedDocument = await loadManagerApp(
      createManagerFetch(validToken),
      {
        authRequired: true,
        beforeImport: (window) => {
          window.localStorage.setItem(authStorageKey, validToken);
          if (storedFeedback) {
            window.localStorage.setItem(feedbackStorageKey, storedFeedback);
          }
        },
      }
    );

    const feedbackLane = reloadedDocument.querySelector<HTMLElement>(
      '#routingFeedbackLane'
    )!;
    const feedbackList = reloadedDocument.querySelector<HTMLElement>(
      '#routingFeedbackList'
    )!;

    expect(feedbackLane.classList.contains('hidden')).toBe(false);
    expect(feedbackLane.textContent).toContain('送信状況');
    expect(feedbackLane.textContent).toContain('送信済み 1件');
    expect(feedbackList.classList.contains('hidden')).toBe(true);
    expect(feedbackLane.textContent).not.toContain('消えずに残したい送信');

    reloadedDocument
      .querySelector<HTMLButtonElement>('#routingFeedbackToggleButton')!
      .click();
    await flushAsync(2);

    expect(feedbackList.classList.contains('hidden')).toBe(false);
    expect(feedbackLane.textContent).toContain('消えずに残したい送信');
    expect(feedbackLane.textContent).toContain('1件を実行キューに回しました');
  });

  it('lets the user delete individual entries and clear the whole send status lane', async () => {
    const validToken = 'delete-feedback-token';
    let sendCount = 0;

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
          sendCount += 1;
          return new Response(
            JSON.stringify({
              items: [
                {
                  threadId: `thread-${sendCount}`,
                  title: `task-${sendCount}`,
                  outcome: 'created-new',
                  reason: '新しい task を作りました',
                },
              ],
              routedCount: 1,
              ambiguousCount: 0,
              detail: `${sendCount}件目を実行キューに回しました`,
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
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
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

    composer.value = '最初の送信';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await flushAsync(6);

    composer.value = '次の送信';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await flushAsync(6);

    const feedbackLane = document.querySelector<HTMLElement>(
      '#routingFeedbackLane'
    )!;
    const feedbackList = document.querySelector<HTMLElement>(
      '#routingFeedbackList'
    )!;

    expect(feedbackLane.textContent).toContain('送信済み 2件');

    document
      .querySelector<HTMLButtonElement>('#routingFeedbackToggleButton')!
      .click();
    await flushAsync(2);

    expect(feedbackList.classList.contains('hidden')).toBe(false);

    const firstCard = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#routingFeedbackList .composer-feedback-entry'
      )
    ).find((card) => card.textContent?.includes('最初の送信'));
    const deleteButton = Array.from(
      firstCard!.querySelectorAll<HTMLButtonElement>('button.composer-chip')
    ).find((button) => button.textContent === '削除');
    deleteButton!.click();
    await flushAsync(2);

    expect(feedbackLane.textContent).toContain('送信済み 1件');
    expect(feedbackLane.textContent).not.toContain('最初の送信');
    expect(window.localStorage.getItem(feedbackStorageKey) ?? '').not.toContain(
      '最初の送信'
    );

    document
      .querySelector<HTMLButtonElement>('#routingFeedbackClearButton')!
      .click();
    await flushAsync(2);

    expect(feedbackLane.classList.contains('hidden')).toBe(true);
    expect(window.localStorage.getItem(feedbackStorageKey)).toBe(null);
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
    expect(toggle.classList.contains('hidden')).toBe(false);
    expect(visibleComposerShellChildIds(document)).toEqual([
      'composerToggleButton',
    ]);

    toggle.click();
    await flushAsync(2);

    expect(panel.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.classList.contains('hidden')).toBe(true);
    expect(
      document
        .querySelector<HTMLButtonElement>('#composerCloseButton')!
        .classList.contains('hidden')
    ).toBe(false);
    expect(visibleComposerShellChildIds(document)).toEqual(['composerPanel']);

    document.querySelector<HTMLButtonElement>('#composerCloseButton')!.click();
    await flushAsync(2);

    expect(panel.classList.contains('hidden')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.classList.contains('hidden')).toBe(false);
    expect(visibleComposerShellChildIds(document)).toEqual([
      'composerToggleButton',
    ]);
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

  it('inserts images chosen from the picker at the remembered cursor position', async () => {
    const fetchMock = createManagerFetch('composer-picker-token');

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'composer-picker-token');
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

    const pickerButton = document.querySelector<HTMLButtonElement>(
      '#composerImagePickerButton'
    )!;
    pickerButton.dispatchEvent(
      new window.MouseEvent('mousedown', { bubbles: true })
    );

    const pickerInput = document.querySelector<HTMLInputElement>(
      '#composerImagePickerInput'
    )!;
    const file = new window.File([Uint8Array.from([4, 5, 6])], 'mobile.png', {
      type: 'image/png',
    });
    Object.defineProperty(pickerInput, 'files', {
      configurable: true,
      value: [file],
    });
    pickerInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flushAsync(8);

    expect(textarea.value).toContain(
      '前の説明\n\n![mobile.png](attachment://img-'
    );
    expect(textarea.value).toContain(')\n\n後ろの説明');
    expect(
      document.querySelector<HTMLElement>('#composerAttachmentList')!
        .textContent
    ).toContain('mobile.png');
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

    const applyComposerDockRect = (): void => {
      const composerDock = document.getElementById(
        'global-composer-dock'
      ) as HTMLElement | null;
      expect(composerDock).not.toBeNull();
      Object.defineProperty(
        composerDock as HTMLElement,
        'getBoundingClientRect',
        {
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
        }
      );
    };
    applyComposerDockRect();

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
    expect([116, 312]).toContain(initialReservePx);

    composerHeight = 268;
    applyComposerDockRect();
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
    expect([116, 268]).toContain(updatedReservePx);
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
    let liveSnapshotCount = 0;
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

        if (isRoute(url, '/live')) {
          liveSnapshotCount += 1;
          const messages =
            liveSnapshotCount >= 3
              ? [...baseMessages, appendedMessage]
              : baseMessages;
          const thread = makeThreadView('thread-1', '長文トピック', {
            messages,
            previewText: `[ai] ${messages[messages.length - 1]?.content ?? ''}`,
          });
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: [thread],
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '待機中',
              },
            },
          ]);
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
    expect(secondMsgArea.scrollTop).toBe(180);
    expect(secondMsgArea.textContent).toContain('new-bottom-message');
  });

  it('keeps the live worker log pinned to the bottom when it grows while the user is already at the bottom', async () => {
    const validToken = 'live-bottom-token';
    let liveSnapshotCount = 0;
    const baseMessages = Array.from({ length: 4 }, (_, index) => ({
      sender: (index % 2 === 0 ? 'user' : 'ai') as 'user' | 'ai',
      content: `message-${index}`,
      at: `2026-03-21T00:00:0${index}.000Z`,
    }));

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

        if (isRoute(url, '/live')) {
          liveSnapshotCount += 1;
          const workerLiveLog =
            liveSnapshotCount >= 3
              ? [
                  {
                    at: '2026-03-21T00:01:00.000Z',
                    text: 'Worker を起動しました。まだ進捗メッセージは届いていません。',
                    kind: 'status' as const,
                  },
                  {
                    at: '2026-03-21T00:01:10.000Z',
                    text: '2行目の live 出力が追加されました。',
                    kind: 'output' as const,
                  },
                ]
              : [
                  {
                    at: '2026-03-21T00:01:00.000Z',
                    text: 'Worker を起動しました。まだ進捗メッセージは届いていません。',
                    kind: 'status' as const,
                  },
                ];
          const thread = makeThreadView('thread-live-grow', '進捗ログ', {
            status: 'active',
            uiState: 'ai-working',
            isWorking: true,
            lastSender: 'user',
            messages: baseMessages,
            workerAgentId: 'assign_live_grow',
            workerRuntimeState: 'worker-running',
            workerLiveLog,
            workerLiveOutput: workerLiveLog[workerLiveLog.length - 1]?.text,
            workerLiveAt: workerLiveLog[workerLiveLog.length - 1]?.at,
          });
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: [thread],
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail: '処理中 (進捗ログ)',
                currentThreadId: 'thread-live-grow',
                currentThreadTitle: '進捗ログ',
              },
            },
          ]);
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
              detail: '処理中 (進捗ログ)',
              currentThreadId: 'thread-live-grow',
              currentThreadTitle: '進捗ログ',
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
        Object.defineProperty(domWindow.HTMLElement.prototype, 'offsetHeight', {
          configurable: true,
          get() {
            const element = this as HTMLElement;
            if (element.classList.contains('bubble-live')) {
              return element.textContent?.includes('2行目の live 出力')
                ? 160
                : 100;
            }
            if (element.classList.contains('bubble')) {
              return 100;
            }
            if (element.classList.contains('msg-area')) {
              return 300;
            }
            return 0;
          },
        });
        Object.defineProperty(domWindow.HTMLElement.prototype, 'clientHeight', {
          configurable: true,
          get() {
            const element = this as HTMLElement;
            if (element.classList.contains('msg-area')) {
              return 300;
            }
            return 0;
          },
        });
        Object.defineProperty(domWindow.HTMLElement.prototype, 'offsetTop', {
          configurable: true,
          get() {
            const element = this as HTMLElement;
            const parent = element.parentElement;
            if (
              element.classList.contains('bubble') &&
              parent?.classList.contains('msg-area')
            ) {
              return Array.from(parent.children)
                .slice(0, Array.from(parent.children).indexOf(element))
                .reduce(
                  (sum, child) => sum + (child as HTMLElement).offsetHeight,
                  0
                );
            }
            return 0;
          },
        });
        Object.defineProperty(domWindow.HTMLElement.prototype, 'scrollHeight', {
          configurable: true,
          get() {
            const element = this as HTMLElement;
            if (element.classList.contains('msg-area')) {
              return Array.from(element.children).reduce(
                (sum, child) => sum + (child as HTMLElement).offsetHeight,
                0
              );
            }
            return 0;
          },
        });
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const firstMsgArea = document.querySelector<HTMLElement>('.msg-area')!;
    firstMsgArea.scrollTop = 200;

    document
      .querySelector<HTMLButtonElement>('[data-action="refresh"]')!
      .click();
    await flushAsync(6);

    const secondMsgArea = document.querySelector<HTMLElement>('.msg-area')!;
    expect(secondMsgArea.scrollTop).toBe(secondMsgArea.scrollHeight);
    expect(secondMsgArea.textContent).toContain(
      '2行目の live 出力が追加されました。'
    );
  });

  it('keeps the open task inline and shows its new state when it moves between buckets', async () => {
    const validToken = 'movement-token';
    let liveSnapshotCount = 0;

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

        if (isRoute(url, '/live')) {
          liveSnapshotCount += 1;
          const thread =
            liveSnapshotCount >= 3
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
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-21T00:00:00.000Z',
              threads: [thread],
              tasks: [],
              status: {
                running: true,
                configured: true,
                builtinBackend: true,
                detail:
                  liveSnapshotCount >= 3 ? '待機中' : '処理中 (移動する task)',
                currentThreadId: liveSnapshotCount >= 3 ? null : 'thread-move',
                currentThreadTitle:
                  liveSnapshotCount >= 3 ? null : '移動する task',
                pendingCount: liveSnapshotCount >= 3 ? 0 : 1,
              },
            },
          ]);
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
                liveSnapshotCount >= 3 ? '待機中' : '処理中 (移動する task)',
              currentThreadId: liveSnapshotCount >= 3 ? null : 'thread-move',
              currentThreadTitle:
                liveSnapshotCount >= 3 ? null : '移動する task',
              pendingCount: liveSnapshotCount >= 3 ? 0 : 1,
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

  it('surfaces the latest meaningful live activity in the summary and ai-working row', async () => {
    const workingThread = makeThreadView(
      'thread-live-summary',
      'リアルタイム進捗',
      {
        status: 'active',
        uiState: 'ai-working',
        isWorking: true,
        lastSender: 'user',
        previewText: '[user] 進めてください',
        assigneeKind: 'worker',
        assigneeLabel: 'Codex gpt-5.4 (xhigh)',
        workerAgentId: 'assign_live_summary',
        workerRuntimeState: 'worker-running',
        workerRuntimeDetail: '担当 worker agent がこの作業項目を実行中です。',
        workerLiveLog: [
          {
            at: '2026-03-23T07:59:30.000Z',
            text: 'Worker を起動しました。まだ進捗メッセージは届いていません。',
            kind: 'status',
          },
          {
            at: '2026-03-23T08:00:00.000Z',
            text: 'いま `src/manager-backend.ts` を見ています。',
            kind: 'output',
          },
          {
            at: '2026-03-23T08:00:15.000Z',
            text: '進捗イベントを受信しましたが、まだ説明文は届いていません。',
            kind: 'status',
          },
        ],
        workerLiveOutput:
          '進捗イベントを受信しましたが、まだ説明文は届いていません。',
        workerLiveAt: '2026-03-23T08:00:15.000Z',
        messages: [
          {
            sender: 'user',
            content: '進めてください',
            at: '2026-03-23T07:59:00.000Z',
          },
        ],
      }
    );

    const fetchMock = createManagerFetchWithData({
      validToken: 'activity-live-token',
      threads: [workingThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (リアルタイム進捗)',
        currentThreadId: 'thread-live-summary',
        currentThreadTitle: 'リアルタイム進捗',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'activity-live-token');
      },
    });

    expect(
      document.querySelector<HTMLElement>('#activity-detail')!.textContent
    ).toContain(
      'Worker が「いま src/manager-backend.ts を見ています。」を進めています'
    );
    expect(
      document.querySelector<HTMLElement>('#manager-status-text')!.textContent
    ).toContain('Worker: いま src/manager-backend.ts を見ています。');

    const row = document.querySelector<HTMLElement>('.thread-row')!;
    expect(
      row.querySelector<HTMLElement>('[data-row-preview]')?.textContent
    ).toContain('Worker: いま src/manager-backend.ts を見ています。');
    expect(
      row.querySelector<HTMLElement>('[data-row-activity]')?.textContent
    ).toContain('Worker / Worker agent 実行中 / 最終更新');
    expect(
      row.querySelector<HTMLElement>('[data-row-preview]')?.textContent
    ).not.toContain(
      '進捗イベントを受信しましたが、まだ説明文は届いていません。'
    );
  });

  it('keeps normal busy copy when the backend is still running without a factual error', async () => {
    const fetchMock = createManagerFetchWithData({
      validToken: 'stalled-status-token',
      threads: [
        makeThreadView('queued-thread', '順番待ちの task', {
          status: 'waiting',
          uiState: 'queued',
          previewText: '[user] まだ着手していません',
          lastSender: 'user',
          queueDepth: 1,
        }),
      ],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        health: 'ok',
        detail: '処理中 (順番待ちの task)',
        pendingCount: 1,
        currentQueueId: 'q_stalled',
        currentThreadId: 'queued-thread',
        currentThreadTitle: '順番待ちの task',
        errorMessage: null,
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'stalled-status-token');
      },
    });

    expect(
      document.querySelector<HTMLElement>('#manager-status-text')!.textContent
    ).toContain('AI が「順番待ちの task」を処理中です');
    expect(
      document.querySelector<HTMLElement>('#activity-primary')!.textContent
    ).toContain('AI が「順番待ちの task」を進めています');
    expect(
      document.querySelector<HTMLElement>('#activity-detail')!.textContent
    ).toContain('残り 1 件を順番に進めます');
    expect(
      document.querySelector<HTMLElement>('#activity-primary')!.textContent
    ).not.toContain('AI の順番待ちがあります');
    expect(
      document.querySelector<HTMLElement>('#manager-status-text')!.textContent
    ).not.toContain('止まっている可能性があります');
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

  it('keeps the live stream running in no-auth mode and applies pushed snapshots', async () => {
    const waitingThread = makeThreadView('thread-no-auth', '無認証ライブ確認', {
      status: 'waiting',
      uiState: 'queued',
      lastSender: 'user',
      previewText: '[user] 状態を確認してください',
      queueDepth: 1,
    });
    const workingThread = makeThreadView('thread-no-auth', '無認証ライブ確認', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 状態を確認してください',
      assigneeKind: 'worker',
      assigneeLabel: 'Codex',
      workerAgentId: 'assign_no_auth',
      workerRuntimeState: 'worker-running',
      workerRuntimeDetail: 'README を確認中です。',
    });
    const waitingStatus = {
      running: true,
      configured: true,
      builtinBackend: true,
      detail: '待機中 (キュー: 1件)',
      pendingCount: 1,
      currentQueueId: null,
      currentThreadId: null,
      currentThreadTitle: null,
    };
    const workingStatus = {
      running: true,
      configured: true,
      builtinBackend: true,
      detail: '処理中 (無認証ライブ確認)',
      pendingCount: 0,
      currentQueueId: 'q_no_auth',
      currentThreadId: 'thread-no-auth',
      currentThreadTitle: '無認証ライブ確認',
    };
    const encoder = new TextEncoder();
    let liveRequestCount = 0;
    const liveStreamControl: {
      push?: (payload: unknown) => void;
      close?: () => void;
    } = {};

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers ?? {});
        if (headers.get('X-Workspace-Agent-Hub-Token')) {
          return new Response(
            JSON.stringify({
              error: 'unexpected token for no-auth mode',
            }),
            { status: 400 }
          );
        }

        if (isRoute(url, '/live')) {
          liveRequestCount += 1;
          if (liveRequestCount === 1) {
            return makeNdjsonResponse([
              {
                kind: 'snapshot',
                emittedAt: '2026-03-30T02:00:00.000Z',
                threads: [waitingThread],
                tasks: [],
                status: waitingStatus,
              },
            ]);
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                liveStreamControl.push = (payload: unknown) => {
                  controller.enqueue(
                    encoder.encode(JSON.stringify(payload) + '\n')
                  );
                };
                liveStreamControl.close = () => {
                  controller.close();
                };
              },
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
              },
            }
          );
        }

        if (isRoute(url, '/threads')) {
          return new Response(JSON.stringify([waitingThread]), { status: 200 });
        }

        if (isRoute(url, '/tasks')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (isRoute(url, '/manager/status')) {
          return new Response(JSON.stringify(waitingStatus), { status: 200 });
        }

        return new Response('{}', { status: 200 });
      }
    ) as unknown as typeof fetch;

    const document = await loadManagerApp(fetchMock, {
      authRequired: false,
    });

    await flushAsync(6);
    expect(liveRequestCount).toBeGreaterThanOrEqual(2);
    expect(typeof liveStreamControl.push).toBe('function');

    liveStreamControl.push!({
      kind: 'snapshot',
      emittedAt: '2026-03-30T02:00:05.000Z',
      threads: [workingThread],
      tasks: [],
      status: workingStatus,
    });
    await flushAsync(6);

    expect(
      document.querySelector<HTMLElement>('#manager-status-text')!.textContent
    ).toContain('AI が「無認証ライブ確認」を処理中です');
    const diagnostics = (
      window as Window & {
        __workspaceAgentHubManagerDiagnostics?: () => Record<string, unknown>;
      }
    ).__workspaceAgentHubManagerDiagnostics?.();
    expect(diagnostics?.['liveStreamConnected']).toBe(true);
    expect(diagnostics?.['authTokenPresent']).toBe(false);
    liveStreamControl.close?.();
  });

  it('does not let an older refresh snapshot overwrite a newer live snapshot', async () => {
    const validToken = 'live-order-token';
    const encoder = new TextEncoder();
    const queuedThread = makeThreadView('thread-readme', 'README 調査', {
      status: 'waiting',
      uiState: 'queued',
      lastSender: 'user',
      previewText: '[user] README を確認してください',
      queueDepth: 1,
    });
    const workingThread = makeThreadView('thread-readme', 'README 調査', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] README を確認してください',
      assigneeKind: 'worker',
      assigneeLabel: 'Codex',
      workerAgentId: 'assign_readme',
      workerRuntimeState: 'worker-running',
      workerRuntimeDetail: 'README を確認中です。',
    });

    let liveRequestCount = 0;
    const liveStreamControl: {
      push?: (payload: unknown) => void;
      close?: () => void;
    } = {};
    let resolveRefreshSnapshot: ((response: Response) => void) | null = null;

    const queuedStatus = {
      running: true,
      configured: true,
      builtinBackend: true,
      detail: '待機中 (キュー: 1件)',
      pendingCount: 1,
      currentQueueId: null,
      currentThreadId: null,
      currentThreadTitle: null,
    };
    const workingStatus = {
      running: true,
      configured: true,
      builtinBackend: true,
      detail: '処理中 (README 調査)',
      pendingCount: 0,
      currentQueueId: 'q_readme',
      currentThreadId: 'thread-readme',
      currentThreadTitle: 'README 調査',
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

        if (isRoute(url, '/manager/global-send')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  threadId: 'thread-readme',
                  title: 'README 調査',
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

        if (isRoute(url, '/live')) {
          liveRequestCount += 1;
          if (liveRequestCount === 1) {
            return makeNdjsonResponse([
              {
                kind: 'snapshot',
                emittedAt: '2026-03-30T01:00:00.000Z',
                threads: [queuedThread],
                tasks: [],
                status: queuedStatus,
              },
            ]);
          }
          if (liveRequestCount === 2) {
            return new Response(
              new ReadableStream({
                start(controller) {
                  liveStreamControl.push = (payload: unknown) => {
                    controller.enqueue(
                      encoder.encode(JSON.stringify(payload) + '\n')
                    );
                  };
                  liveStreamControl.close = () => {
                    controller.close();
                  };
                },
              }),
              {
                status: 200,
                headers: {
                  'Content-Type': 'application/x-ndjson; charset=utf-8',
                },
              }
            );
          }
          if (liveRequestCount === 3) {
            return await new Promise<Response>((resolve) => {
              resolveRefreshSnapshot = resolve;
            });
          }
          return makeNdjsonResponse([
            {
              kind: 'snapshot',
              emittedAt: '2026-03-30T01:00:05.000Z',
              threads: [workingThread],
              tasks: [],
              status: workingStatus,
            },
          ]);
        }

        if (isRoute(url, '/threads')) {
          return new Response(JSON.stringify([queuedThread]), { status: 200 });
        }

        if (isRoute(url, '/tasks')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (isRoute(url, '/manager/status')) {
          return new Response(JSON.stringify(queuedStatus), { status: 200 });
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

    await flushAsync(6);
    expect(typeof liveStreamControl.push).toBe('function');

    document.querySelector<HTMLButtonElement>('#composerToggleButton')!.click();
    await flushAsync(2);
    const composer = document.querySelector<HTMLTextAreaElement>(
      '#globalComposerInput'
    )!;
    const sendButton = document.querySelector<HTMLButtonElement>(
      '#globalComposerSendButton'
    )!;
    composer.value = 'README の最上位見出しだけ答えてください';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    sendButton.click();
    await flushAsync(6);

    expect(liveRequestCount).toBeGreaterThanOrEqual(3);
    expect(resolveRefreshSnapshot).not.toBeNull();

    liveStreamControl.push!({
      kind: 'snapshot',
      emittedAt: '2026-03-30T01:00:05.000Z',
      threads: [workingThread],
      tasks: [],
      status: workingStatus,
    });
    await flushAsync(4);

    resolveRefreshSnapshot!(
      makeNdjsonResponse([
        {
          kind: 'snapshot',
          emittedAt: '2026-03-30T01:00:01.000Z',
          threads: [queuedThread],
          tasks: [],
          status: queuedStatus,
        },
      ])
    );
    await flushAsync(8);

    expect(
      document.querySelector<HTMLElement>('#manager-status-text')!.textContent
    ).toContain('AI が「README 調査」を処理中です');
    expect(
      document.querySelector<HTMLElement>('#activity-primary')!.textContent
    ).toContain('AI が「README 調査」を進めています');
    liveStreamControl.close?.();
  });

  it('refreshes the open work-item after the screen becomes visible again', async () => {
    const initialThread = makeThreadView('thread-resume', '送信中の task', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 進めてください',
      updatedAt: '2026-03-23T09:00:00.000Z',
      assigneeKind: 'worker',
      assigneeLabel: 'Codex gpt-5.4 (xhigh)',
      workerAgentId: 'assign_resume',
      workerRuntimeState: 'worker-running',
      workerRuntimeDetail: '担当 worker agent がこの作業項目を実行中です。',
      messages: [
        {
          sender: 'user',
          content: '進めてください',
          at: '2026-03-23T09:00:00.000Z',
        },
      ],
    });
    const resumedThread = makeThreadView('thread-resume', '送信中の task', {
      status: 'review',
      uiState: 'ai-finished-awaiting-user-confirmation',
      isWorking: false,
      lastSender: 'ai',
      previewText: '[ai] 完了しました',
      updatedAt: '2026-03-23T09:05:00.000Z',
      messages: [
        {
          sender: 'user',
          content: '進めてください',
          at: '2026-03-23T09:00:00.000Z',
        },
        {
          sender: 'ai',
          content: '完了しました。',
          at: '2026-03-23T09:05:00.000Z',
        },
      ],
    });
    const responseState: Parameters<typeof createManagerFetchWithData>[0] = {
      validToken: 'resume-refresh-token',
      threads: [initialThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (送信中の task)',
        currentThreadId: 'thread-resume',
        currentThreadTitle: '送信中の task',
      },
    };
    const fetchMock = createManagerFetchWithData(responseState);

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'resume-refresh-token');
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const detail = document.querySelector<HTMLElement>('#thread-detail')!;
    expect(detail.textContent).toContain('AI作業中');
    expect(detail.textContent).not.toContain('完了しました。');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(
      new window.Event('visibilitychange', { bubbles: false })
    );
    await flushAsync(2);

    responseState.threads = [resumedThread];
    responseState.status = {
      running: true,
      configured: true,
      builtinBackend: true,
      detail: '待機中',
      currentThreadId: null,
      currentThreadTitle: null,
    };

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(
      new window.Event('visibilitychange', { bubbles: false })
    );
    await flushAsync(6);

    expect(detail.textContent).toContain('あなたの確認待ち');
    expect(detail.textContent).toContain('完了しました。');
    expect(
      fetchMock.mock.calls.filter(([input]) => isRoute(String(input), '/live'))
        .length
    ).toBeGreaterThanOrEqual(2);
  });

  it('still refreshes after visibility resume when a recent focus refresh already ran', async () => {
    const initialThread = makeThreadView('thread-race', '競合する復帰 task', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 進めてください',
      updatedAt: '2026-03-23T09:00:00.000Z',
      assigneeKind: 'worker',
      assigneeLabel: 'Codex gpt-5.4 (xhigh)',
      workerAgentId: 'assign_race',
      workerRuntimeState: 'worker-running',
      workerRuntimeDetail: '担当 worker agent がこの作業項目を実行中です。',
      messages: [
        {
          sender: 'user',
          content: '進めてください',
          at: '2026-03-23T09:00:00.000Z',
        },
      ],
    });
    const resumedThread = makeThreadView('thread-race', '競合する復帰 task', {
      status: 'review',
      uiState: 'ai-finished-awaiting-user-confirmation',
      isWorking: false,
      lastSender: 'ai',
      previewText: '[ai] 完了しました',
      updatedAt: '2026-03-23T09:05:00.000Z',
      messages: [
        {
          sender: 'user',
          content: '進めてください',
          at: '2026-03-23T09:00:00.000Z',
        },
        {
          sender: 'ai',
          content: '完了しました。',
          at: '2026-03-23T09:05:00.000Z',
        },
      ],
    });
    const responseState: Parameters<typeof createManagerFetchWithData>[0] = {
      validToken: 'resume-race-token',
      threads: [initialThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (競合する復帰 task)',
        currentThreadId: 'thread-race',
        currentThreadTitle: '競合する復帰 task',
      },
    };
    const fetchMock = createManagerFetchWithData(responseState);

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'resume-race-token');
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const detail = document.querySelector<HTMLElement>('#thread-detail')!;
    expect(detail.textContent).toContain('AI作業中');

    const initialLiveCalls = fetchMock.mock.calls.filter(([input]) =>
      isRoute(String(input), '/live')
    ).length;
    window.dispatchEvent(new window.Event('focus'));
    await flushAsync(4);

    const focusLiveCalls = fetchMock.mock.calls.filter(([input]) =>
      isRoute(String(input), '/live')
    ).length;
    expect(focusLiveCalls).toBeGreaterThan(initialLiveCalls);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(
      new window.Event('visibilitychange', { bubbles: false })
    );
    await flushAsync(2);

    responseState.threads = [resumedThread];
    responseState.status = {
      running: true,
      configured: true,
      builtinBackend: true,
      detail: '待機中',
      currentThreadId: null,
      currentThreadTitle: null,
    };

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(
      new window.Event('visibilitychange', { bubbles: false })
    );
    await flushAsync(6);

    expect(detail.textContent).toContain('あなたの確認待ち');
    expect(detail.textContent).toContain('完了しました。');
    expect(
      fetchMock.mock.calls.filter(([input]) => isRoute(String(input), '/live'))
        .length
    ).toBeGreaterThan(focusLiveCalls);
  });

  it('refreshes the open work-item after a persisted pageshow restore', async () => {
    const initialThread = makeThreadView('thread-pageshow', '復帰待ちの task', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 続きを進めてください',
      updatedAt: '2026-03-23T10:00:00.000Z',
      messages: [
        {
          sender: 'user',
          content: '続きを進めてください',
          at: '2026-03-23T10:00:00.000Z',
        },
      ],
    });
    const resumedThread = makeThreadView('thread-pageshow', '復帰待ちの task', {
      status: 'review',
      uiState: 'ai-finished-awaiting-user-confirmation',
      isWorking: false,
      lastSender: 'ai',
      previewText: '[ai] 反映しました',
      updatedAt: '2026-03-23T10:03:00.000Z',
      messages: [
        {
          sender: 'user',
          content: '続きを進めてください',
          at: '2026-03-23T10:00:00.000Z',
        },
        {
          sender: 'ai',
          content: '反映しました。',
          at: '2026-03-23T10:03:00.000Z',
        },
      ],
    });
    const responseState: Parameters<typeof createManagerFetchWithData>[0] = {
      validToken: 'pageshow-refresh-token',
      threads: [initialThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (復帰待ちの task)',
        currentThreadId: 'thread-pageshow',
        currentThreadTitle: '復帰待ちの task',
      },
    };
    const fetchMock = createManagerFetchWithData(responseState);

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'pageshow-refresh-token');
      },
    });

    document.querySelector<HTMLElement>('.thread-row')!.click();
    await flushAsync(3);

    const detail = document.querySelector<HTMLElement>('#thread-detail')!;
    expect(detail.textContent).toContain('AI作業中');
    expect(detail.textContent).not.toContain('反映しました。');

    responseState.threads = [resumedThread];
    responseState.status = {
      running: true,
      configured: true,
      builtinBackend: true,
      detail: '待機中',
      currentThreadId: null,
      currentThreadTitle: null,
    };

    const pageShow = new window.PageTransitionEvent('pageshow', {
      persisted: true,
    });
    window.dispatchEvent(pageShow);
    await flushAsync(6);

    expect(detail.textContent).toContain('あなたの確認待ち');
    expect(detail.textContent).toContain('反映しました。');
    expect(
      fetchMock.mock.calls.filter(([input]) => isRoute(String(input), '/live'))
        .length
    ).toBeGreaterThanOrEqual(2);
  });

  it('exposes manager diagnostics for stale-state investigations', async () => {
    const fetchMock = createManagerFetchWithData({
      validToken: 'diagnostics-token',
      threads: [],
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
        window.localStorage.setItem(authStorageKey, 'diagnostics-token');
      },
    });

    const diagnosticsBefore = (
      window as Window & {
        __workspaceAgentHubManagerDiagnostics?: () => {
          authTokenPresent: boolean;
          lastLiveEventKind: string | null;
          recentEvents: Array<{ event: string }>;
        };
      }
    ).__workspaceAgentHubManagerDiagnostics?.();
    expect(diagnosticsBefore?.authTokenPresent).toBe(true);
    expect(diagnosticsBefore?.lastLiveEventKind).toBe('snapshot');
    expect(
      diagnosticsBefore?.recentEvents.some(
        (entry) => entry.event === 'live:start'
      )
    ).toBe(true);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(
      new window.Event('visibilitychange', { bubbles: false })
    );
    await flushAsync(2);

    const diagnosticsAfter = (
      window as Window & {
        __workspaceAgentHubManagerDiagnostics?: () => {
          liveStreamConnected: boolean;
          resumeRefreshPending: boolean;
          recentEvents: Array<{ event: string }>;
        };
      }
    ).__workspaceAgentHubManagerDiagnostics?.();
    expect(diagnosticsAfter?.liveStreamConnected).toBe(false);
    expect(diagnosticsAfter?.resumeRefreshPending).toBe(true);
    expect(
      diagnosticsAfter?.recentEvents.some(
        (entry) => entry.event === 'visibility:hidden'
      )
    ).toBe(true);
  });

  it('renders the in-flight worker output in a dedicated live activity panel and the latest AI bubble in detail view', async () => {
    const workingThread = makeThreadView('thread-live', 'リアルタイム出力', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 実装してください',
      assigneeKind: 'worker',
      assigneeLabel: 'Codex gpt-5.4 (xhigh)',
      workerAgentId: 'assign_thread-live',
      workerRuntimeState: 'worker-running',
      workerRuntimeDetail: '担当 worker agent がこの作業項目を実行中です。',
      workerWriteScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      workerLiveLog: [
        {
          at: '2026-03-23T07:59:30.000Z',
          text: 'Worker を起動しました。まだ進捗メッセージは届いていません。',
          kind: 'status',
        },
        {
          at: '2026-03-23T08:00:00.000Z',
          text: 'いま `src/manager-backend.ts` を見ています。',
          kind: 'output',
        },
      ],
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
    expect(detail.textContent).toContain('実行状態: Worker agent 実行中');
    expect(
      detail.querySelector<HTMLElement>('[data-live-activity-panel]')
        ?.textContent
    ).toContain('いまの活動');
    expect(
      detail.querySelector<HTMLElement>('[data-live-activity-panel]')
        ?.textContent
    ).toContain('Worker');
    expect(
      detail.querySelector<HTMLElement>('[data-live-activity-panel]')
        ?.textContent
    ).toContain('いま src/manager-backend.ts を見ています。');
    expect(detail.textContent).toContain(
      'Worker を起動しました。まだ進捗メッセージは届いていません。'
    );
    expect(detail.textContent).toContain(
      'いま src/manager-backend.ts を見ています。'
    );
    expect(detail.textContent).not.toContain('担当 worker:');
    expect(detail.textContent).not.toContain('書き込み範囲:');
    expect(
      detail.querySelector<HTMLElement>('.bubble-live .bubble-sender')
        ?.textContent
    ).toContain('Worker');
    expect(
      detail.querySelector<HTMLElement>('.bubble-live .bubble-ts')?.textContent
    ).toContain('確定前');
  });

  it('uses readable recovery activity instead of raw structured JSON in ai-working views', async () => {
    const recoveryThread = makeThreadView('thread-recovery', '回復判断', {
      status: 'active',
      uiState: 'ai-working',
      isWorking: true,
      lastSender: 'user',
      previewText: '[user] 状況を見てください',
      assigneeKind: 'manager',
      assigneeLabel: 'Manager gpt-5.4 (xhigh)',
      workerAgentId: 'assign_recovery',
      workerRuntimeState: 'manager-recovery',
      workerRuntimeDetail:
        'Manager がレビュー結果を分析し回復方法を決定中です。',
      workerLiveLog: [
        {
          at: '2026-03-23T08:09:45.000Z',
          text: 'Manager が worker の成果を確認しています。',
          kind: 'status',
        },
        {
          at: '2026-03-23T08:09:55.000Z',
          text: '差分を再確認しています。',
          kind: 'output',
        },
        {
          at: '2026-03-23T08:10:00.000Z',
          text: '`npm run verify` は通っています。',
          kind: 'output',
        },
        {
          at: '2026-03-23T08:10:20.000Z',
          text: '影響範囲を再点検しています。',
          kind: 'status',
        },
        {
          at: '2026-03-23T08:10:30.000Z',
          text: '{"decision":"fix-self","reason":"verify は通っており方向性は正しいです。"}',
          kind: 'output',
        },
        {
          at: '2026-03-23T08:10:45.000Z',
          text: '進捗イベントを受信しましたが、まだ説明文は届いていません。',
          kind: 'status',
        },
      ],
      workerLiveOutput:
        '進捗イベントを受信しましたが、まだ説明文は届いていません。',
      workerLiveAt: '2026-03-23T08:10:45.000Z',
      messages: [
        {
          sender: 'user',
          content: '状況を見てください',
          at: '2026-03-23T08:09:00.000Z',
        },
      ],
    });

    const fetchMock = createManagerFetchWithData({
      validToken: 'recovery-live-token',
      threads: [recoveryThread],
      status: {
        running: true,
        configured: true,
        builtinBackend: true,
        detail: '処理中 (回復判断)',
        currentThreadId: 'thread-recovery',
        currentThreadTitle: '回復判断',
      },
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'recovery-live-token');
      },
    });

    const row = document.querySelector<HTMLElement>('.thread-row')!;
    expect(
      row.querySelector<HTMLElement>('[data-row-preview]')?.textContent
    ).toContain('Manager: 回復判断: 今の修正をそのまま継続');
    expect(
      row.querySelector<HTMLElement>('[data-row-activity]')?.textContent
    ).toContain('Manager / Manager が回復対応中 / 最終更新');
    expect(
      row.querySelector<HTMLElement>('[data-row-preview]')?.textContent
    ).not.toContain('"decision":"fix-self"');

    row.click();
    await flushAsync(3);

    const livePanel = document.querySelector<HTMLElement>(
      '[data-live-activity-panel]'
    )!;
    expect(livePanel.textContent).toContain(
      'Manager がレビュー結果を分析し回復方法を決定中です。'
    );
    expect(livePanel.textContent).toContain(
      'Manager が worker の成果を確認しています。'
    );
    expect(livePanel.textContent).toContain('npm run verify は通っています。');
    expect(livePanel.textContent).toContain(
      '進捗イベントを受信しましたが、まだ説明文は届いていません。'
    );
    expect(livePanel.textContent).toContain('回復判断: 今の修正をそのまま継続');
    expect(livePanel.textContent).not.toContain('"decision":"fix-self"');
  });

  it('shows superseded work items in their own visible bucket with the cancel reason', async () => {
    const supersededThread = makeThreadView('thread-superseded', '古い作業', {
      status: 'active',
      uiState: 'cancelled-as-superseded',
      assigneeKind: 'worker',
      assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
      workerAgentId: 'assign_superseded',
      workerRuntimeState: 'cancelled-as-superseded',
      workerRuntimeDetail:
        '「新しい作業」で全面的に置き換わるため、この worker agent を停止しました。',
      supersededByThreadId: 'thread-new',
      messages: [
        {
          sender: 'ai',
          content:
            'この作業項目は、新しく派生した「新しい作業」の内容で既存成果が置き換わると判断したため、途中の担当 worker を止めました。',
          at: '2026-03-23T08:00:00.000Z',
        },
      ],
    });
    const newThread = makeThreadView('thread-new', '新しい作業');

    const fetchMock = createManagerFetchWithData({
      validToken: 'superseded-token',
      threads: [supersededThread, newThread],
    });

    const document = await loadManagerApp(fetchMock, {
      authRequired: true,
      beforeImport: (window) => {
        window.localStorage.setItem(authStorageKey, 'superseded-token');
      },
    });

    expect(
      document.querySelector('#sec-cancelled-as-superseded')
    ).not.toBeNull();
    expect(
      document.querySelector('#body-cancelled-as-superseded')!.textContent
    ).toContain('古い作業');

    document
      .querySelector<HTMLElement>('#body-cancelled-as-superseded .thread-row')!
      .click();
    await flushAsync(3);

    expect(
      document.querySelector<HTMLElement>('#thread-detail')!.textContent
    ).toContain('置き換わるため、この worker agent を停止しました');
  });
});
