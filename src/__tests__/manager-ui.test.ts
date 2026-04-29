import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { notifyManagerUpdateMock, runPreflightMock } = vi.hoisted(() => ({
  notifyManagerUpdateMock: vi.fn(),
  runPreflightMock: vi.fn(),
}));

vi.mock('../manager-live-updates.js', () => ({
  notifyManagerUpdate: notifyManagerUpdateMock,
  subscribeManagerUpdates: vi.fn(() => () => {}),
}));

vi.mock('../preflight.js', () => ({
  runPreflight: runPreflightMock,
}));

vi.mock('../manager-backend.js', () => ({
  acceptGlobalSendToBuiltinManager: vi.fn(),
  getBuiltinManagerStatus: vi.fn(),
  kickIdleQueuedManagerWork: vi.fn(),
  preserveSeedRecoveryAndContinue: vi.fn(),
  readQueue: vi.fn(async () => []),
  readSession: vi.fn(async () => ({
    status: 'idle',
    activeAssignments: [],
    dispatchingQueueEntryIds: null,
    dispatchingThreadId: null,
    lastErrorMessage: null,
    lastErrorAt: null,
  })),
  sendGlobalToBuiltinManager: vi.fn(),
  sendThreadFollowUpToBuiltinManager: vi.fn(),
  startBuiltinManager: vi.fn(),
}));

vi.mock('../manager-tasks.js', () => ({
  readActiveTasks: vi.fn(async () => []),
}));

vi.mock('../manager-thread-state.js', () => ({
  deriveManagerThreadViews: vi.fn(() => []),
  reconcileManagerThreadMeta: vi.fn(async () => ({})),
  readManagerThreadMeta: vi.fn(async () => ({})),
  updateManagerThreadMeta: vi.fn(),
}));

vi.mock('../build-archive.js', () => ({
  getGitInfo: vi.fn(),
  listBuilds: vi.fn(async () => []),
  resolvePackageRoot: vi.fn(() => 'D:/ghws/workspace-agent-hub'),
  restoreBuild: vi.fn(),
}));

vi.mock('../web-auth.js', () => ({
  isWebUiAuthorized: vi.fn(() => true),
}));

vi.mock('../sse-connections.js', () => ({
  activeSseConnections: new Set(),
}));

vi.mock('@metyatech/thread-inbox', () => ({
  addMessage: vi.fn(),
  createThread: vi.fn(),
  getThread: vi.fn(),
  listThreads: vi.fn(async () => []),
  purgeThreads: vi.fn(),
  reopenThread: vi.fn(),
  resolveThread: vi.fn(),
}));

import { acceptGlobalSendToBuiltinManager } from '../manager-backend.js';
import {
  __managerUiTestInternals,
  handleManagerUiRequest,
} from '../manager-ui.js';

function makeJsonRequest(body: unknown): EventEmitter {
  const req = new EventEmitter();
  queueMicrotask(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeJsonResponse(): {
  res: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  done: Promise<{ status: number; body: unknown }>;
} {
  let status = 200;
  let resolveDone: (value: {
    status: number;
    body: unknown;
  }) => void = () => {};
  const done = new Promise<{ status: number; body: unknown }>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    writeHead: vi.fn((nextStatus: number) => {
      status = nextStatus;
    }),
    end: vi.fn((payload: string) => {
      resolveDone({
        status,
        body: payload ? JSON.parse(payload) : null,
      });
    }),
  };
  return { res, done };
}

describe('manager-ui preflight refresh notifications', () => {
  async function flushAsyncTurns(times = 4): Promise<void> {
    for (let index = 0; index < times; index += 1) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    notifyManagerUpdateMock.mockReset();
    runPreflightMock.mockReset();
    __managerUiTestInternals.resetPreflightCacheForTests();
  });

  afterEach(() => {
    __managerUiTestInternals.resetPreflightCacheForTests();
  });

  it('notifies listeners once after a successful preflight refresh completes', async () => {
    runPreflightMock.mockResolvedValue({
      summary: {
        inScopeRepoCount: 1,
        invalidRepoCount: 0,
        approvalQueueCount: 0,
        runCount: 0,
        mergeLaneCount: 0,
        unavailableRuntimeCount: 0,
      },
      generatedAt: new Date().toISOString(),
    });

    __managerUiTestInternals.triggerPreflightRefresh('D:/ghws');
    await flushAsyncTurns();

    expect(notifyManagerUpdateMock).toHaveBeenCalledTimes(1);
    expect(notifyManagerUpdateMock).toHaveBeenCalledWith('D:\\ghws');
    const payload = __managerUiTestInternals.buildPreflightPayload(
      __managerUiTestInternals.getOrCreatePreflightCacheEntry('D:\\ghws')
    );
    expect(payload.freshness).toBe('fresh');
  });

  it('notifies listeners when preflight refresh fails so unavailable becomes visible', async () => {
    runPreflightMock.mockRejectedValue(new Error('Network timeout'));

    __managerUiTestInternals.triggerPreflightRefresh('D:/ghws');
    await flushAsyncTurns();

    expect(notifyManagerUpdateMock).toHaveBeenCalledTimes(1);
    const payload = __managerUiTestInternals.buildPreflightPayload(
      __managerUiTestInternals.getOrCreatePreflightCacheEntry('D:\\ghws')
    );
    expect(payload.freshness).toBe('unavailable');
    expect(payload.error).toBe('Network timeout');
  });

  it('routes global sends through the immediate async accept path', async () => {
    vi.mocked(acceptGlobalSendToBuiltinManager).mockResolvedValueOnce({
      items: [
        {
          threadId: 'thread-pending',
          title: '振り分け中: docs cleanup',
          outcome: 'routing-pending',
          reason: '依頼を受け付けました。Manager が振り分けています。',
        },
      ],
      routedCount: 0,
      ambiguousCount: 0,
      detail: '依頼を受け付けました。Manager が振り分けています。',
    });
    const { res, done } = makeJsonResponse();

    const handled = await handleManagerUiRequest({
      req: makeJsonRequest({
        content: 'docs cleanup',
        contextThreadId: 'thread-context',
      }) as never,
      res: res as never,
      pathname: '/manager/api/manager/global-send',
      method: 'POST',
      workspaceRoot: 'D:/ghws',
      authConfig: { required: false, token: null, storageKey: 'test-auth' },
    });

    expect(handled).toBe(true);
    expect(acceptGlobalSendToBuiltinManager).toHaveBeenCalledWith(
      'D:/ghws',
      'docs cleanup',
      { contextThreadId: 'thread-context' }
    );
    await expect(done).resolves.toMatchObject({
      status: 200,
      body: {
        items: [
          expect.objectContaining({
            threadId: 'thread-pending',
            outcome: 'routing-pending',
          }),
        ],
      },
    });
  });
});
