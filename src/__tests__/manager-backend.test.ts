import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  spawnMock,
  addMessageMock,
  createThreadMock,
  getThreadMock,
  listThreadsMock,
  reopenThreadMock,
  resolveThreadMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  addMessageMock: vi.fn(),
  createThreadMock: vi.fn(),
  getThreadMock: vi.fn(),
  listThreadsMock: vi.fn(),
  reopenThreadMock: vi.fn(),
  resolveThreadMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@metyatech/thread-inbox', () => ({
  addMessage: addMessageMock,
  createThread: createThreadMock,
  getThread: getThreadMock,
  listThreads: listThreadsMock,
  reopenThread: reopenThreadMock,
  resolveThread: resolveThreadMock,
}));

vi.mock('../build-archive.js', () => ({
  snapshotBuild: vi.fn().mockResolvedValue({
    commitHash: 'abc1234',
    commitHashFull: 'abc1234567890',
    commitMessage: 'mock snapshot',
    commitDate: new Date().toISOString(),
    archivedAt: new Date().toISOString(),
    version: '0.0.0',
    distPath: '/mock/dist',
  }),
  resolvePackageRoot: vi.fn().mockReturnValue('/mock/package-root'),
}));

vi.mock('../manager-worktree.js', () => ({
  createWorkerWorktree: vi.fn().mockResolvedValue({
    worktreePath: '',
    branchName: '',
    targetRepoRoot: '',
  }),
  mergeWorktreeToMain: vi.fn().mockResolvedValue({
    success: true,
    conflicted: false,
    conflictFiles: [],
    detail: 'mock merge',
  }),
  resolveConflictAndVerify: vi.fn().mockResolvedValue({
    success: true,
    conflicted: false,
    conflictFiles: [],
    detail: 'mock conflict resolution',
  }),
  pushWithRetry: vi
    .fn()
    .mockResolvedValue({ success: true, detail: 'mock push' }),
  validateWorktreeReadyForMerge: vi.fn().mockResolvedValue({
    ready: true,
    detail: 'mock delivery ready',
    aheadCommitCount: 1,
  }),
  runPostMergeDeliveryChain: vi.fn().mockResolvedValue({
    success: true,
    detail: 'mock delivery chain',
    performed: [],
  }),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  resolveTargetRepoRoot: vi
    .fn()
    .mockImplementation((resolvedDir: string) => resolvedDir),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(undefined),
  execGit: vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
}));

import {
  buildCodexSpawnOptions,
  buildCodexSpawnSpec,
  buildCodexArgs,
  buildManagerReviewPrompt,
  buildManagerReplyPrompt,
  buildWorkerExecutionPrompt,
  getBuiltinManagerStatus,
  isSessionInvalidError,
  MANAGER_MODEL,
  MANAGER_REASONING_EFFORT,
  parseManagerReplyPayload,
  parseManagerWorkerResultPayload,
  parseManagerRoutingPlan,
  parseCodexProgressLine,
  parseCodexOutput,
  pickThreadUserMessage,
  processNextQueued,
  readQueue,
  readSession,
  resolveCodexCommand,
  sendGlobalToBuiltinManager,
  sendToBuiltinManager,
  shouldUseShellForCodexCommand,
  updateSession,
  writeSession,
  writeQueue,
} from '../manager-backend.js';
import {
  parseManagerMessage,
  serializeManagerMessage,
} from '../manager-message.js';
import {
  readManagerThreadMeta,
  writeManagerThreadMeta,
} from '../manager-thread-state.js';
import {
  createWorkerWorktree,
  mergeWorktreeToMain,
  pushWithRetry,
  runPostMergeDeliveryChain,
  validateWorktreeReadyForMerge,
} from '../manager-worktree.js';

interface FakeProc extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
}

function makeProc(pid: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  return proc;
}

function completeCodexTurn(
  proc: FakeProc,
  input: {
    sessionId: string;
    text: string;
    code?: number;
  }
): void {
  proc.stdout.emit(
    'data',
    Buffer.from(
      [
        JSON.stringify({
          type: 'thread.started',
          thread_id: input.sessionId,
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: input.text,
          },
        }),
      ].join('\n')
    )
  );
  proc.emit('close', input.code ?? 0);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition.');
}

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'workspace-agent-hub-manager-'));
  spawnMock.mockReset();
  addMessageMock.mockReset();
  createThreadMock.mockReset();
  getThreadMock.mockReset();
  listThreadsMock.mockReset();
  reopenThreadMock.mockReset();
  resolveThreadMock.mockReset();
  addMessageMock.mockResolvedValue(undefined);
  createThreadMock.mockResolvedValue(undefined);
  getThreadMock.mockImplementation(async (_dir: string, threadId: string) => ({
    id: threadId,
    title: `Thread ${threadId}`,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [
      {
        sender: 'user',
        content: `Existing context for ${threadId}`,
        at: new Date().toISOString(),
      },
    ],
  }));
  listThreadsMock.mockResolvedValue([]);
  reopenThreadMock.mockResolvedValue(undefined);
  resolveThreadMock.mockResolvedValue(undefined);
  vi.mocked(createWorkerWorktree).mockReset();
  vi.mocked(createWorkerWorktree).mockResolvedValue({
    worktreePath: '',
    branchName: '',
    targetRepoRoot: '',
  });
  vi.mocked(mergeWorktreeToMain).mockReset();
  vi.mocked(mergeWorktreeToMain).mockResolvedValue({
    success: true,
    conflicted: false,
    conflictFiles: [],
    detail: 'mock merge',
  });
  vi.mocked(pushWithRetry).mockReset();
  vi.mocked(pushWithRetry).mockResolvedValue({
    success: true,
    detail: 'mock push',
  });
  vi.mocked(validateWorktreeReadyForMerge).mockReset();
  vi.mocked(validateWorktreeReadyForMerge).mockResolvedValue({
    ready: true,
    detail: 'mock delivery ready',
    aheadCommitCount: 1,
  });
  vi.mocked(runPostMergeDeliveryChain).mockReset();
  vi.mocked(runPostMergeDeliveryChain).mockResolvedValue({
    success: true,
    detail: 'mock delivery chain',
    performed: [],
  });
});

afterEach(async () => {
  delete process.env.WORKSPACE_AGENT_HUB_CODEX_IDLE_TIMEOUT_MS;
  delete process.env.WORKSPACE_AGENT_HUB_CODEX_STRUCTURED_REPLY_CLOSE_GRACE_MS;
  await rm(tempDir, { recursive: true, force: true });
});

describe('manager backend codex integration', () => {
  it('resolves the codex command for Windows and builds exec args for first and resumed turns', () => {
    expect(
      resolveCodexCommand({
        platform: 'win32',
        env: {
          APPDATA: 'C:\\Users\\Origin\\AppData\\Roaming',
        } as NodeJS.ProcessEnv,
        exists: (targetPath) => targetPath.endsWith('codex.cmd'),
      })
    ).toBe('C:\\Users\\Origin\\AppData\\Roaming\\npm\\codex.cmd');
    expect(
      resolveCodexCommand({
        platform: 'linux',
        env: {} as NodeJS.ProcessEnv,
        exists: () => false,
      })
    ).toBe('codex');

    expect(buildCodexArgs('hello', null)).toEqual([
      'exec',
      '--json',
      '--model',
      MANAGER_MODEL,
      '-c',
      `model_reasoning_effort="${MANAGER_REASONING_EFFORT}"`,
      '-',
    ]);

    expect(buildCodexArgs('hello', null, ['C:\\temp\\capture.png'])).toEqual([
      'exec',
      '--image',
      'C:\\temp\\capture.png',
      '--json',
      '--model',
      MANAGER_MODEL,
      '-c',
      `model_reasoning_effort="${MANAGER_REASONING_EFFORT}"`,
      '-',
    ]);

    expect(buildCodexArgs('follow-up', 'thread-123')).toEqual([
      'exec',
      'resume',
      'thread-123',
      '--json',
      '--model',
      MANAGER_MODEL,
      '-c',
      `model_reasoning_effort="${MANAGER_REASONING_EFFORT}"`,
      '-',
    ]);

    expect(
      shouldUseShellForCodexCommand(
        'C:\\Users\\Origin\\AppData\\Roaming\\npm\\codex.cmd',
        'win32'
      )
    ).toBe(true);
    expect(shouldUseShellForCodexCommand('/usr/bin/codex', 'linux')).toBe(
      false
    );
  });

  it('builds router and worker prompts that preserve system context only on first turn', () => {
    const first = buildManagerReplyPrompt(
      'Fix this',
      'thread-a',
      'D:\\ghws',
      true
    );
    const follow = buildManagerReplyPrompt(
      'Next',
      'thread-a',
      'D:\\ghws',
      false
    );
    const workerFirst = buildWorkerExecutionPrompt({
      content: 'Implement the task',
      resolvedDir: 'D:\\ghws',
      worktreePath: null,
      isFirstTurn: true,
      thread: {
        id: 'thread-a',
        title: 'Implement task',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: 'Please implement the task.',
            at: new Date().toISOString(),
          },
        ],
      },
    });
    const reviewPrompt = buildManagerReviewPrompt({
      resolvedDir: 'D:\\ghws',
      worktreePath: 'C:\\temp\\wah-wt-review',
      writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      thread: {
        id: 'thread-a',
        title: 'Implement task',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: 'Please implement the task.',
            at: new Date().toISOString(),
          },
        ],
      },
      workerResult: {
        status: 'review',
        reply: '作業を反映しました。',
        changedFiles: ['src/manager-backend.ts'],
        verificationSummary: 'npm run verify PASS',
      },
    });

    expect(first).toContain('You are a manager AI assistant');
    expect(first).toContain('Workspace: D:\\ghws');
    expect(first).toContain('[Topic: thread-a]');
    expect(follow).toContain('[Topic: thread-a]');
    expect(follow).toContain('Return only strict JSON');
    expect(follow).toContain('Next');
    expect(workerFirst).toContain('built-in execution worker');
    expect(workerFirst).toContain('plain, natural Japanese');
    expect(workerFirst).toContain('Avoid internal AI/platform/process jargon');
    expect(workerFirst).toContain('[Topic: Implement task]');
    expect(workerFirst).toContain('Please implement the task.');
    expect(reviewPrompt).toContain('built-in manager reviewer');
    expect(reviewPrompt).toContain('commit, push');
    expect(reviewPrompt).toContain('release or publish path as well');
    expect(reviewPrompt).toContain('Do not return status "review"');
    expect(reviewPrompt).toContain('src/manager-backend.ts');
    expect(reviewPrompt).toContain('npm run verify PASS');
  });

  it('parses manager reply and routing JSON payloads', () => {
    expect(
      parseManagerReplyPayload('{"status":"active","reply":"着手しました"}')
    ).toEqual({
      status: 'active',
      reply: '着手しました',
    });

    expect(
      parseManagerReplyPayload('{"status":"review","reply":"確認してください"}')
    ).toEqual({
      status: 'review',
      reply: '確認してください',
    });
    expect(
      parseManagerWorkerResultPayload(
        '{"status":"review","reply":"確認してください","changedFiles":["src/a.ts"],"verificationSummary":"npm run verify PASS"}'
      )
    ).toEqual({
      status: 'review',
      reply: '確認してください',
      changedFiles: ['src/a.ts'],
      verificationSummary: 'npm run verify PASS',
    });

    expect(
      parseManagerRoutingPlan(
        JSON.stringify({
          actions: [
            {
              kind: 'attach-existing',
              topicRef: 'topic-1',
              originalText: 'CCの件ってどうなってる？',
              content: 'CC の件どうなってる？',
              reason: '既存の CC に続けます',
            },
            {
              kind: 'create-new',
              title: 'AA を進める',
              originalText: 'AAして',
              content: 'AA して',
            },
          ],
        })
      )
    ).toEqual({
      actions: [
        {
          kind: 'attach-existing',
          topicRef: 'topic-1',
          originalText: 'CCの件ってどうなってる？',
          content: 'CC の件どうなってる？',
          reason: '既存の CC に続けます',
        },
        {
          kind: 'create-new',
          title: 'AA を進める',
          originalText: 'AAして',
          content: 'AA して',
        },
      ],
    });
  });

  it('keeps verbatim follow-up text on existing topics but prefers standalone stored text for new topics', () => {
    expect(
      pickThreadUserMessage(
        'AAして、BBして。あとCCの件ってどうなってる？',
        {
          kind: 'attach-existing',
          threadId: 'thread-cc',
          originalText: 'CCの件ってどうなってる？',
          content: 'CC の件どうなってる？',
        },
        3
      )
    ).toBe('CCの件ってどうなってる？');

    expect(
      pickThreadUserMessage(
        'これについては新しいタスクとして分けてほしい',
        {
          kind: 'create-new',
          title: 'Manager の依頼ごとトピック分離',
          originalText: 'これについては新しいタスクとして分けてほしい',
          content:
            'Manager の依頼ごとトピック分離の件として、この依頼は新しいタスクとして分けてほしい。',
        },
        1
      )
    ).toBe(
      'Manager の依頼ごとトピック分離の件として、この依頼は新しいタスクとして分けてほしい。'
    );
  });

  it('preserves rich image metadata when a routed excerpt references an inline attachment', () => {
    const fullInput = serializeManagerMessage({
      content:
        '状況です\n\n![capture](attachment://img-1)\n\nこのエラーを見てください',
      attachments: [
        {
          id: 'img-1',
          name: 'capture.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AAAA',
        },
      ],
    });

    const routed = pickThreadUserMessage(
      fullInput,
      {
        kind: 'create-new',
        title: 'エラー確認',
        originalText:
          '![capture](attachment://img-1)\n\nこのエラーを見てください',
        content:
          '![capture](attachment://img-1)\n\nWorkspace Agent Hub の Manager で出たこのエラーを見てください',
      },
      2
    );

    expect(parseManagerMessage(routed)).toEqual({
      markdown:
        '![capture](attachment://img-1)\n\nWorkspace Agent Hub の Manager で出たこのエラーを見てください',
      attachments: [
        {
          id: 'img-1',
          name: 'capture.png',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,AAAA',
        },
      ],
    });
  });

  it('parses codex JSON output and extracts thread continuity id + final reply', () => {
    const parsed = parseCodexOutput(
      [
        '[2026-03-20T00:00:00][INFO] prelude',
        '{"type":"thread.started","thread_id":"thread-xyz"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"First answer"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Final answer"}}',
      ].join('\n')
    );

    expect(parsed).toEqual({
      sessionId: 'thread-xyz',
      text: 'Final answer',
    });
  });

  it('parses nested assistant message content and detects stale-session errors', () => {
    const parsed = parseCodexOutput(
      [
        '{"type":"thread.started","thread_id":"thread-nested"}',
        '{"type":"item.completed","item":{"type":"assistant_message","content":[{"text":"Line one"},{"parts":[{"text":"Line two"}]}]}}',
      ].join('\n')
    );

    expect(parsed).toEqual({
      sessionId: 'thread-nested',
      text: 'Line one\nLine two',
    });
    expect(
      isSessionInvalidError('resume failed: session not found for thread-abc')
    ).toBe(true);
  });

  it('reuses one routing session across global sends while keeping topic context current', async () => {
    const routingProcOne = makeProc(8601);
    const dispatchProcOne = makeProc(8602);
    const workerProcOne = makeProc(8603);
    const reviewProcOne = makeProc(8607);
    const routingProcTwo = makeProc(8604);
    const dispatchProcTwo = makeProc(8605);
    const workerProcTwo = makeProc(8606);
    const reviewProcTwo = makeProc(8608);
    spawnMock
      .mockReturnValueOnce(routingProcOne)
      .mockReturnValueOnce(dispatchProcOne)
      .mockReturnValueOnce(workerProcOne)
      .mockReturnValueOnce(reviewProcOne)
      .mockReturnValueOnce(routingProcTwo)
      .mockReturnValueOnce(dispatchProcTwo)
      .mockReturnValueOnce(workerProcTwo)
      .mockReturnValueOnce(reviewProcTwo);

    listThreadsMock.mockResolvedValue([]);
    createThreadMock
      .mockResolvedValueOnce({
        id: 'thread-new-1',
        title: 'Task one',
      })
      .mockResolvedValueOnce({
        id: 'thread-new-2',
        title: 'Task two',
      });

    const firstSend = sendGlobalToBuiltinManager(tempDir, 'first new task');
    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('resume');

    completeCodexTurn(routingProcOne, {
      sessionId: 'routing-thread-1',
      text: JSON.stringify({
        actions: [
          {
            kind: 'create-new',
            title: 'Task one',
            content: 'Task one as a standalone topic request',
          },
        ],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(dispatchProcOne, {
      sessionId: 'dispatch-thread-1',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(workerProcOne, {
      sessionId: 'worker-thread-1',
      text: '{"status":"review","reply":"done one"}',
    });
    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(reviewProcOne, {
      sessionId: 'manager-review-thread-1',
      text: '{"status":"review","reply":"done one"}',
    });
    await firstSend;

    const secondSend = sendGlobalToBuiltinManager(tempDir, 'second new task');
    await waitFor(() => spawnMock.mock.calls.length === 5);
    expect(spawnMock.mock.calls[4]?.[1]).toEqual(
      expect.arrayContaining(['exec', 'resume', 'routing-thread-1'])
    );

    completeCodexTurn(routingProcTwo, {
      sessionId: 'routing-thread-1',
      text: JSON.stringify({
        actions: [
          {
            kind: 'create-new',
            title: 'Task two',
            content: 'Task two as a standalone topic request',
          },
        ],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 6);
    completeCodexTurn(dispatchProcTwo, {
      sessionId: 'dispatch-thread-2',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 7);
    completeCodexTurn(workerProcTwo, {
      sessionId: 'worker-thread-2',
      text: '{"status":"review","reply":"done two"}',
    });
    await waitFor(() => spawnMock.mock.calls.length === 8);
    completeCodexTurn(reviewProcTwo, {
      sessionId: 'manager-review-thread-2',
      text: '{"status":"review","reply":"done two"}',
    });
    await secondSend;

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });

    const session = await readSession(tempDir);
    expect(session.routingSessionId).toBe('routing-thread-1');
  });

  it('retries routing once with a fresh session after an invalid stored routing session', async () => {
    const failingRoutingProc = makeProc(8609);
    const recoveredRoutingProc = makeProc(8610);
    const dispatchProc = makeProc(8611);
    const workerProc = makeProc(8612);
    const reviewProc = makeProc(8613);
    spawnMock
      .mockReturnValueOnce(failingRoutingProc)
      .mockReturnValueOnce(recoveredRoutingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);

    await writeSession(tempDir, {
      ...(await readSession(tempDir)),
      status: 'idle',
      routingSessionId: 'routing-thread-stale',
    });
    listThreadsMock.mockResolvedValue([]);
    createThreadMock.mockResolvedValueOnce({
      id: 'thread-recovered',
      title: 'Recovered task',
    });

    const sendPromise = sendGlobalToBuiltinManager(tempDir, 'recover routing');
    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['exec', 'resume', 'routing-thread-stale'])
    );

    failingRoutingProc.stderr.emit(
      'data',
      Buffer.from('resume failed: session not found for routing-thread-stale')
    );
    failingRoutingProc.emit('close', 1);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(spawnMock.mock.calls[1]?.[1]).not.toContain('resume');

    completeCodexTurn(recoveredRoutingProc, {
      sessionId: 'routing-thread-recovered',
      text: JSON.stringify({
        actions: [
          {
            kind: 'create-new',
            title: 'Recovered task',
            content: 'recover routing as a standalone topic request',
          },
        ],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-thread-recovered',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(workerProc, {
      sessionId: 'worker-thread-recovered',
      text: '{"status":"review","reply":"recovered route done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 5);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-recovered',
      text: '{"status":"review","reply":"recovered route done"}',
    });

    await sendPromise;
    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });

    const session = await readSession(tempDir);
    expect(session.routingSessionId).toBe('routing-thread-recovered');
  });

  it('passes the open topic as a mention-style routing hint instead of forcing the destination', async () => {
    const routingProc = makeProc(8611);
    const dispatchProc = makeProc(8612);
    const workerProc = makeProc(8613);
    const reviewProc = makeProc(8614);
    spawnMock
      .mockReturnValueOnce(routingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);

    listThreadsMock.mockResolvedValue([
      {
        id: 'thread-target',
        title: '特定 task',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: '既存の topic',
            at: new Date().toISOString(),
          },
        ],
      },
    ]);
    createThreadMock.mockResolvedValueOnce({
      id: 'thread-new',
      title: '別タスク',
    });
    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title:
          threadId === 'thread-target' ? '特定 task' : `Thread ${threadId}`,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content:
              threadId === 'thread-target'
                ? '既存の topic'
                : `Existing context for ${threadId}`,
            at: new Date().toISOString(),
          },
        ],
      })
    );

    const sendPromise = sendGlobalToBuiltinManager(tempDir, 'これは別件です', {
      contextThreadId: 'thread-target',
    });
    await waitFor(() => spawnMock.mock.calls.length === 1);

    expect(routingProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('Current open topic mention hint: @特定 task.')
    );
    expect(routingProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining(
        'Treat this like a user mention hint, not a forced destination.'
      )
    );
    expect(routingProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('- topicRef: topic-1')
    );
    expect(routingProc.stdin.write).not.toHaveBeenCalledWith(
      expect.stringContaining('thread-target')
    );

    completeCodexTurn(routingProc, {
      sessionId: 'routing-thread-hint',
      text: JSON.stringify({
        actions: [
          {
            kind: 'create-new',
            title: '別タスク',
            content: 'これは別件です',
          },
        ],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-thread-hint',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(workerProc, {
      sessionId: 'worker-thread-hint',
      text: '{"status":"review","reply":"別タスクとして処理しました"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-hint',
      text: '{"status":"review","reply":"別タスクとして処理しました"}',
    });

    await sendPromise;
    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(createThreadMock).toHaveBeenCalledWith(
      tempDir,
      '別タスク（「特定 task」から派生）'
    );
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-new');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      '派生元作業項目: 「特定 task」'
    );
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('これは別件です');
  });

  it('keeps ordinary follow-ups on the same topic, preserves worker continuity, and reopens resolved topics', async () => {
    const routingProc = makeProc(8621);
    const dispatchProc = makeProc(8622);
    const workerProc = makeProc(8623);
    const reviewProc = makeProc(8626);
    spawnMock
      .mockReturnValueOnce(routingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);

    listThreadsMock.mockResolvedValue([
      {
        id: '_bX_UpQR',
        title: '支払いUIの修正',
        status: 'resolved',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: '既存の topic',
            at: new Date().toISOString(),
          },
        ],
      },
    ]);
    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title:
          threadId === '_bX_UpQR' ? '支払いUIの修正' : `Thread ${threadId}`,
        status: threadId === '_bX_UpQR' ? 'resolved' : 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: `Existing context for ${threadId}`,
            at: new Date().toISOString(),
          },
        ],
      })
    );
    await writeManagerThreadMeta(tempDir, {
      _bX_UpQR: {
        workerSessionId: 'codex-thread-existing',
        workerLastStartedAt: '2026-03-26T00:00:00.000Z',
        routingConfirmationNeeded: true,
        routingHint: '古い routing hint',
        assigneeKind: 'worker',
        assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
        workerRuntimeState: 'worker-running',
        workerRuntimeDetail: '前回の続き',
        workerWriteScopes: ['workspace-agent-hub/src/manager-backend.ts'],
        workerLiveLog: [
          {
            at: '2026-03-26T00:00:01.000Z',
            text: 'stale output',
            kind: 'output',
          },
        ],
        workerLiveOutput: 'stale output',
        workerLiveAt: '2026-03-26T00:00:01.000Z',
      },
    });

    const sendPromise = sendGlobalToBuiltinManager(
      tempDir,
      '昨日の支払いUIの件、続きどうなってる？'
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    expect(routingProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('Recent topics:')
    );
    expect(routingProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('status: resolved')
    );
    expect(routingProc.stdin.write).not.toHaveBeenCalledWith(
      expect.stringContaining('_bX_UpQR')
    );

    completeCodexTurn(routingProc, {
      sessionId: 'routing-topic-ref',
      text: JSON.stringify({
        actions: [
          {
            kind: 'attach-existing',
            topicRef: 'topic-1',
            content: '昨日の支払いUIの件、続きどうなってる？',
            reason: '同じ支払いUIの修正 topic の続きです',
          },
        ],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-topic-ref',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    const workerArgs = spawnMock.mock.calls[2]?.[1] as string[];
    expect(workerArgs).toEqual(
      expect.arrayContaining(['exec', 'resume', 'codex-thread-existing'])
    );
    completeCodexTurn(workerProc, {
      sessionId: 'codex-thread-existing',
      text: '{"status":"review","reply":"対応しました"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-topic-ref',
      text: '{"status":"review","reply":"対応しました"}',
    });

    const summary = await sendPromise;
    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(reopenThreadMock).toHaveBeenCalledWith(tempDir, '_bX_UpQR');
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('_bX_UpQR');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe(
      '昨日の支払いUIの件、続きどうなってる？'
    );
    expect(summary.items[0]).toMatchObject({
      threadId: '_bX_UpQR',
      title: '支払いUIの修正',
      outcome: 'attached-existing',
    });
    const meta = await readManagerThreadMeta(tempDir);
    expect(meta['_bX_UpQR']?.workerSessionId).toBe('codex-thread-existing');
    expect(meta['_bX_UpQR']?.routingConfirmationNeeded).toBeUndefined();
    expect(meta['_bX_UpQR']?.workerLiveOutput).toBeNull();
  });

  it('keeps direct replies to needs-reply topics in the same topic instead of splitting them', async () => {
    const routingProc = makeProc(8623);
    const dispatchProc = makeProc(8624);
    const workerProc = makeProc(8625);
    const reviewProc = makeProc(8627);
    spawnMock
      .mockReturnValueOnce(routingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);

    listThreadsMock.mockResolvedValue([
      {
        id: 'thread-needs-reply',
        title: '確認待ちの task',
        status: 'needs-reply',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'ai',
            content: '確認したい点があります',
            at: new Date().toISOString(),
          },
        ],
      },
    ]);
    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title:
          threadId === 'thread-needs-reply'
            ? '確認待ちの task'
            : `Thread ${threadId}`,
        status: threadId === 'thread-needs-reply' ? 'needs-reply' : 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'ai',
            content: '確認したい点があります',
            at: new Date().toISOString(),
          },
        ],
      })
    );

    const sendPromise = sendGlobalToBuiltinManager(tempDir, '補足するとAです');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(routingProc, {
      sessionId: 'routing-needs-reply',
      text: JSON.stringify({
        actions: [
          {
            kind: 'attach-existing',
            topicRef: 'topic-1',
            content: '補足するとAです',
            reason: 'この確認への直接回答です',
          },
        ],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-needs-reply',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(workerProc, {
      sessionId: 'worker-needs-reply',
      text: '{"status":"review","reply":"確認を受けて更新しました"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-needs-reply',
      text: '{"status":"review","reply":"確認を受けて更新しました"}',
    });

    const summary = await sendPromise;
    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(createThreadMock).not.toHaveBeenCalled();
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-needs-reply');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('補足するとAです');
    expect(summary.items[0]).toMatchObject({
      threadId: 'thread-needs-reply',
      outcome: 'attached-existing',
    });
  });

  it('starts processing immediately when a manager message arrives while idle', async () => {
    const workerProc = makeProc(6101);
    const reviewProc = makeProc(6102);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    await sendToBuiltinManager(tempDir, 'thread-idle', 'idle message');
    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(workerProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('idle message')
    );
    expect(workerProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('[Topic: Thread thread-idle]')
    );
    expect(workerProc.stdin.end).toHaveBeenCalledTimes(1);

    workerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-idle"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"idle reply"}}',
        ].join('\n')
      )
    );
    workerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-idle',
      text: '{"status":"review","reply":"idle reply"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-idle');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('idle reply');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
  });

  it('runs a manager review turn after a worker finishes and posts the reviewed reply', async () => {
    const workerProc = makeProc(6121);
    const reviewProc = makeProc(6122);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    await sendToBuiltinManager(tempDir, 'thread-review', 'implement this');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(workerProc, {
      sessionId: 'worker-session-review',
      text: JSON.stringify({
        status: 'review',
        reply: 'worker done',
        changedFiles: ['src/manager-backend.ts'],
        verificationSummary: 'npm run verify PASS',
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(reviewProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('built-in manager reviewer')
    );
    expect(reviewProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('src/manager-backend.ts')
    );
    expect(reviewProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('npm run verify PASS')
    );
    expect(reviewProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('commit, push')
    );

    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-session',
      text: '{"status":"review","reply":"manager reviewed and delivered"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        queue.length === 0 &&
        session.status === 'idle' &&
        meta['thread-review']?.workerSessionId === 'worker-session-review'
      );
    });

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-review');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe(
      'manager reviewed and delivered'
    );
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
  });

  it('coalesces consecutive queued user messages on the same topic into one worker turn', async () => {
    const workerProc = makeProc(6151);
    const reviewProc = makeProc(6152);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title: `Thread ${threadId}`,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: `Existing context for ${threadId}`,
            at: new Date().toISOString(),
          },
          {
            sender: 'user',
            content: 'first pending message',
            at: new Date().toISOString(),
          },
          {
            sender: 'user',
            content: 'second pending message',
            at: new Date().toISOString(),
          },
        ],
      })
    );

    await writeQueue(tempDir, [
      {
        id: 'q_batch_1',
        threadId: 'thread-batch',
        content: 'first pending message',
        createdAt: new Date().toISOString(),
        processed: false,
        priority: 'normal',
      },
      {
        id: 'q_batch_2',
        threadId: 'thread-batch',
        content: 'second pending message',
        createdAt: new Date().toISOString(),
        processed: false,
        priority: 'normal',
      },
    ]);

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.running).toBe(true);
    await waitFor(() => spawnMock.mock.calls.length === 1);

    const prompt = String(workerProc.stdin.write.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('first pending message');
    expect(prompt).toContain('second pending message');
    expect(prompt.split('first pending message').length - 1).toBe(1);
    expect(prompt.split('second pending message').length - 1).toBe(1);

    completeCodexTurn(workerProc, {
      sessionId: 'codex-thread-batch',
      text: '{"status":"review","reply":"single batched reply"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-batch',
      text: '{"status":"review","reply":"single batched reply"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-batch');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('single batched reply');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
  });

  it('drops a stale queued entry when the thread already has a newer AI reply', async () => {
    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title: `Thread ${threadId}`,
        status: 'review',
        createdAt: '2026-03-23T04:00:00.000Z',
        updatedAt: '2026-03-23T07:34:03.799Z',
        messages: [
          {
            sender: 'user',
            content: 'old request',
            at: '2026-03-23T04:20:57.737Z',
          },
          {
            sender: 'user',
            content: 'newer duplicate request',
            at: '2026-03-23T07:34:03.704Z',
          },
          {
            sender: 'ai',
            content: 'already handled elsewhere',
            at: '2026-03-23T07:34:03.799Z',
          },
        ],
      })
    );

    await writeQueue(tempDir, [
      {
        id: 'q_stale',
        threadId: 'thread-stale',
        content: 'old request',
        createdAt: '2026-03-23T04:20:57.738Z',
        processed: false,
        priority: 'normal',
      },
    ]);

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.running).toBe(true);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  it('keeps the manager status busy while the current worker is still assigned even after a long quiet stretch', async () => {
    await writeQueue(tempDir, [
      {
        id: 'q_stalled',
        threadId: 'thread-stalled',
        content: 'stalled request',
        createdAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
        processed: false,
        priority: 'normal',
      },
    ]);

    const session = await readSession(tempDir);
    await writeSession(tempDir, {
      ...session,
      status: 'busy',
      pid: process.pid,
      currentQueueId: 'q_stalled',
      lastMessageAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      lastProgressAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      activeAssignments: [
        {
          id: 'assign-stalled',
          threadId: 'thread-stalled',
          queueEntryIds: ['q_stalled'],
          assigneeKind: 'worker',
          assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
          writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
          pid: process.pid,
          startedAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          lastProgressAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
          worktreePath: null,
          worktreeBranch: null,
          targetRepoRoot: null,
        },
      ],
    });

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.health).toBe('ok');
    expect(status.currentThreadId).toBe('thread-stalled');
    expect(status.currentThreadTitle).toBe('Thread thread-stalled');
    expect(status.detail).toBe('処理中 (Thread thread-stalled)');
    expect(status.errorMessage).toBeNull();
    expect(status.errorAt).toBeNull();
  });

  it('serializes concurrent session mutations so one assignment update does not drop another', async () => {
    const session = await readSession(tempDir);
    await writeSession(tempDir, {
      ...session,
      status: 'busy',
      activeAssignments: [
        {
          id: 'assign-a',
          threadId: 'thread-a',
          queueEntryIds: ['q_a'],
          assigneeKind: 'worker',
          assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
          writeScopes: ['workspace-agent-hub/src/a.ts'],
          pid: 7001,
          startedAt: '2026-03-25T10:00:00.000Z',
          lastProgressAt: '2026-03-25T10:00:01.000Z',
          worktreePath: null,
          worktreeBranch: null,
          targetRepoRoot: null,
        },
        {
          id: 'assign-b',
          threadId: 'thread-b',
          queueEntryIds: ['q_b'],
          assigneeKind: 'worker',
          assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
          writeScopes: ['workspace-agent-hub/src/b.ts'],
          pid: 7002,
          startedAt: '2026-03-25T10:00:00.000Z',
          lastProgressAt: '2026-03-25T10:00:02.000Z',
          worktreePath: null,
          worktreeBranch: null,
          targetRepoRoot: null,
        },
      ],
    });

    let allowFirstUpdate!: () => void;
    let firstUpdateEntered!: () => void;
    const firstUpdateReady = new Promise<void>((resolve) => {
      firstUpdateEntered = resolve;
    });
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      allowFirstUpdate = resolve;
    });

    const firstMutation = updateSession(tempDir, async (currentSession) => {
      firstUpdateEntered();
      await firstUpdateBlocked;
      return {
        ...currentSession,
        activeAssignments: currentSession.activeAssignments.map((assignment) =>
          assignment.id === 'assign-a'
            ? {
                ...assignment,
                lastProgressAt: '2026-03-25T10:05:00.000Z',
              }
            : assignment
        ),
      };
    });

    await firstUpdateReady;

    const secondMutation = updateSession(tempDir, async (currentSession) => {
      expect(
        currentSession.activeAssignments.find(
          (assignment) => assignment.id === 'assign-a'
        )?.lastProgressAt
      ).toBe('2026-03-25T10:05:00.000Z');
      return {
        ...currentSession,
        activeAssignments: currentSession.activeAssignments.filter(
          (assignment) => assignment.id !== 'assign-b'
        ),
      };
    });

    allowFirstUpdate();
    await Promise.all([firstMutation, secondMutation]);

    const latestSession = await readSession(tempDir);
    expect(latestSession.activeAssignments).toHaveLength(1);
    expect(latestSession.activeAssignments[0]?.id).toBe('assign-a');
    expect(latestSession.activeAssignments[0]?.lastProgressAt).toBe(
      '2026-03-25T10:05:00.000Z'
    );
  });

  it('reclaims a stale reserved assignment with no pid or progress and redispatches its queued work', async () => {
    const recoveredWorkerProc = makeProc(7051);
    const recoveredReviewProc = makeProc(7052);
    spawnMock
      .mockReturnValueOnce(recoveredWorkerProc)
      .mockReturnValueOnce(recoveredReviewProc);

    await writeQueue(tempDir, [
      {
        id: 'q_orphaned',
        threadId: 'thread-orphaned',
        content: 'recover this queued task',
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        processed: false,
        priority: 'normal',
      },
    ]);

    const session = await readSession(tempDir);
    await writeSession(tempDir, {
      ...session,
      status: 'busy',
      currentQueueId: 'q_orphaned',
      activeAssignments: [
        {
          id: 'assign-orphaned',
          threadId: 'thread-orphaned',
          queueEntryIds: ['q_orphaned'],
          assigneeKind: 'worker',
          assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
          writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
          pid: null,
          startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          lastProgressAt: null,
          worktreePath: null,
          worktreeBranch: null,
          targetRepoRoot: null,
        },
      ],
    });

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.detail).toBe('待機中 (キュー: 1件)');
    expect(status.currentThreadId).toBeNull();

    await waitFor(() => spawnMock.mock.calls.length === 1);
    const recoveredArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(recoveredArgs).toContain('exec');
    expect(recoveredArgs).not.toContain('resume');

    completeCodexTurn(recoveredWorkerProc, {
      sessionId: 'worker-thread-orphaned',
      text: '{"status":"review","reply":"recovered assignment"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(recoveredReviewProc, {
      sessionId: 'manager-review-orphaned',
      text: '{"status":"review","reply":"recovered assignment"}',
    });

    await waitFor(async () => {
      const latestSession = await readSession(tempDir);
      const queue = await readQueue(tempDir);
      return queue.length === 0 && latestSession.status === 'idle';
    });

    expect(
      addMessageMock.mock.calls.some(
        (call) =>
          call[1] === 'thread-orphaned' &&
          call[2] === 'recovered assignment' &&
          call[4] === 'review'
      )
    ).toBe(true);
  });

  it('clears stale error from manager status when idle with no active assignments', async () => {
    const session = await readSession(tempDir);
    await writeSession(tempDir, {
      ...session,
      status: 'idle',
      lastErrorMessage: '前の担当 worker が途中で停止しました。',
      lastErrorAt: '2026-03-23T08:00:00.000Z',
    });

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.health).toBe('ok');
    expect(status.errorMessage).toBeNull();
    expect(status.errorAt).toBeNull();
  });

  it('rewrites the Windows codex.cmd shim to a direct node + codex.js spawn', () => {
    expect(
      buildCodexSpawnSpec(
        'C:\\Users\\Origin\\AppData\\Roaming\\npm\\codex.cmd',
        ['exec', '--json', '-'],
        'D:\\ghws',
        {
          platform: 'win32',
          exists: (candidatePath) =>
            candidatePath.endsWith('node.exe') ||
            candidatePath.endsWith(
              'node_modules\\@openai\\codex\\bin\\codex.js'
            ),
        }
      )
    ).toEqual({
      command: 'C:\\Users\\Origin\\AppData\\Roaming\\npm\\node.exe',
      args: [
        'C:\\Users\\Origin\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
        'exec',
        '--json',
        '-',
      ],
      spawnOptions: {
        cwd: 'D:\\ghws',
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });

    expect(
      buildCodexSpawnOptions(
        'C:\\Users\\Origin\\AppData\\Roaming\\npm\\codex.cmd',
        'D:\\ghws',
        'win32'
      )
    ).toEqual({
      cwd: 'D:\\ghws',
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('resumes a stuck pending queue when manager status is polled', async () => {
    const workerProc = makeProc(9101);
    const reviewProc = makeProc(9102);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    const stuckQueuePath = join(
      tempDir,
      '.workspace-agent-hub-manager-queue.jsonl'
    );
    await writeFile(
      stuckQueuePath,
      `${JSON.stringify({
        id: 'q_stuck',
        threadId: 'thread-stuck',
        content: 'resume me',
        createdAt: new Date().toISOString(),
        processed: false,
      })}\n`,
      'utf-8'
    );

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.running).toBe(true);

    await waitFor(() => spawnMock.mock.calls.length === 1);
    workerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-stuck"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"recovered reply"}}',
        ].join('\n')
      )
    );
    workerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-stuck',
      text: '{"status":"review","reply":"recovered reply"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });
  });

  it('keeps one in-flight codex turn and serializes queued messages without leaking worker continuity across different topics', async () => {
    const firstWorkerProc = makeProc(7001);
    const firstReviewProc = makeProc(7002);
    const secondWorkerProc = makeProc(7003);
    const secondReviewProc = makeProc(7004);
    spawnMock
      .mockReturnValueOnce(firstWorkerProc)
      .mockReturnValueOnce(firstReviewProc)
      .mockReturnValueOnce(secondWorkerProc)
      .mockReturnValueOnce(secondReviewProc);

    await sendToBuiltinManager(tempDir, 'thread-one', 'first message');
    await sendToBuiltinManager(tempDir, 'thread-two', 'second message');

    await waitFor(() => spawnMock.mock.calls.length === 1);
    const firstArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(firstArgs).toContain('exec');
    expect(firstArgs).not.toContain('resume');

    firstWorkerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstWorkerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(firstReviewProc, {
      sessionId: 'manager-review-thread-1',
      text: '{"status":"review","reply":"reply one"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    const secondArgs = spawnMock.mock.calls[2]?.[1] as string[];
    expect(secondArgs).toContain('exec');
    expect(secondArgs).not.toContain('resume');

    secondWorkerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-2"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply two"}}',
        ].join('\n')
      )
    );
    secondWorkerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(secondReviewProc, {
      sessionId: 'manager-review-thread-2',
      text: '{"status":"review","reply":"reply two"}',
    });

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const queue = await readQueue(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        session.status === 'idle' &&
        session.currentQueueId === null &&
        meta['thread-one']?.workerSessionId === 'codex-thread-1' &&
        meta['thread-two']?.workerSessionId === 'codex-thread-2' &&
        queue.length === 0
      );
    });

    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-one');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('reply one');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
    expect(addMessageMock.mock.calls[1]?.[1]).toBe('thread-two');
    expect(addMessageMock.mock.calls[1]?.[2]).toBe('reply two');
    expect(addMessageMock.mock.calls[1]?.[4]).toBe('review');
  }, 10000);

  it('stores live worker output in thread meta while a worker turn is running', async () => {
    const workerProc = makeProc(7050);
    const reviewProc = makeProc(7051);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    await sendToBuiltinManager(tempDir, 'thread-live', 'live message');

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        session.status === 'busy' &&
        meta['thread-live']?.workerRuntimeState === 'worker-running' &&
        meta['thread-live']?.workerAgentId?.startsWith('assign_q_') === true &&
        meta['thread-live']?.workerLiveOutput ===
          'AI が担当 worker を起動しました。内容を整理しています…'
      );
    });

    workerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-live"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"いま live 出力を流しています"}}',
        ].join('\n')
      )
    );

    await waitFor(async () => {
      const meta = await readManagerThreadMeta(tempDir);
      return (
        (meta['thread-live']?.workerLiveLog?.length ?? 0) >= 2 &&
        meta['thread-live']?.workerLiveOutput === 'いま live 出力を流しています'
      );
    });

    workerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-live',
      text: '{"status":"review","reply":"いま live 出力を流しています"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        queue.length === 0 &&
        session.status === 'idle' &&
        meta['thread-live']?.workerRuntimeState === null &&
        meta['thread-live']?.workerLiveOutput === null &&
        meta['thread-live']?.assigneeLabel?.includes('Worker agent gpt-5.4') ===
          true
      );
    });
  });

  it('uses the turn-specific live label when a review session starts', () => {
    const progress = parseCodexProgressLine(
      '{"type":"thread.started","thread_id":"manager-review-thread"}',
      'Manager が worker の成果を確認しています…'
    );

    expect(progress.sessionId).toBe('manager-review-thread');
    expect(progress.latestText).toBe(
      'Manager が worker の成果を確認しています…'
    );
    expect(progress.liveEntries).toHaveLength(1);
    expect(progress.liveEntries[0]?.kind).toBe('status');
    expect(progress.liveEntries[0]?.text).toBe(
      'Manager が worker の成果を確認しています…'
    );
  });

  it('marks a queued work item as scope-blocked until the conflicting worker finishes', async () => {
    const firstWorkerProc = makeProc(7060);
    const firstReviewProc = makeProc(7061);
    const secondWorkerProc = makeProc(7062);
    const secondReviewProc = makeProc(7063);
    spawnMock
      .mockReturnValueOnce(firstWorkerProc)
      .mockReturnValueOnce(firstReviewProc)
      .mockReturnValueOnce(secondWorkerProc)
      .mockReturnValueOnce(secondReviewProc);

    await sendToBuiltinManager(tempDir, 'thread-running', 'first message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    await sendToBuiltinManager(tempDir, 'thread-blocked', 'second message');

    await waitFor(async () => {
      const meta = await readManagerThreadMeta(tempDir);
      return meta['thread-blocked']?.workerRuntimeState === 'blocked-by-scope';
    });

    let meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-blocked']?.workerRuntimeDetail).toContain(
      '書き込み範囲が重なるため待機'
    );
    expect(meta['thread-blocked']?.workerBlockedByThreadIds).toContain(
      'thread-running'
    );
    expect(meta['thread-blocked']?.workerWriteScopes).toEqual(['*']);

    completeCodexTurn(firstWorkerProc, {
      sessionId: 'codex-thread-first',
      text: '{"status":"review","reply":"first done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-blocked']?.workerRuntimeState).toBe('blocked-by-scope');

    completeCodexTurn(firstReviewProc, {
      sessionId: 'manager-review-thread-first',
      text: '{"status":"review","reply":"first done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    await waitFor(async () => {
      const latestMeta = await readManagerThreadMeta(tempDir);
      return (
        latestMeta['thread-blocked']?.workerRuntimeState === 'worker-running'
      );
    });

    meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-blocked']?.workerBlockedByThreadIds ?? []).toEqual([]);

    completeCodexTurn(secondWorkerProc, {
      sessionId: 'codex-thread-second',
      text: '{"status":"review","reply":"second done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(secondReviewProc, {
      sessionId: 'manager-review-thread-second',
      text: '{"status":"review","reply":"second done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });
  });

  it('records a cancelled-as-superseded runtime state when Manager preempts an older descendant worker', async () => {
    const dispatchProc = makeProc(7070);
    const newWorkerProc = makeProc(7071);
    const reviewProc = makeProc(7072);
    spawnMock
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(newWorkerProc)
      .mockReturnValueOnce(reviewProc);

    listThreadsMock.mockResolvedValue([
      {
        id: 'thread-old',
        title: '古い派生作業',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: 'old descendant',
            at: new Date().toISOString(),
          },
        ],
      },
      {
        id: 'thread-new',
        title: '新しい派生作業',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: 'new descendant',
            at: new Date().toISOString(),
          },
        ],
      },
    ]);
    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title:
          threadId === 'thread-old'
            ? '古い派生作業'
            : threadId === 'thread-new'
              ? '新しい派生作業'
              : `Thread ${threadId}`,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: `Existing context for ${threadId}`,
            at: new Date().toISOString(),
          },
        ],
      })
    );

    const session = await readSession(tempDir);
    await writeSession(tempDir, {
      ...session,
      status: 'busy',
      activeAssignments: [
        {
          id: 'assign-old',
          threadId: 'thread-old',
          queueEntryIds: ['q_old'],
          assigneeKind: 'worker',
          assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
          writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
          pid: null,
          startedAt: new Date().toISOString(),
          lastProgressAt: new Date().toISOString(),
          worktreePath: null,
          worktreeBranch: null,
          targetRepoRoot: null,
        },
      ],
    });
    await writeManagerThreadMeta(tempDir, {
      'thread-old': {
        derivedFromThreadIds: ['thread-root'],
        assigneeKind: 'worker',
        assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
      },
      'thread-new': {
        derivedFromThreadIds: ['thread-root'],
      },
    });
    await writeQueue(tempDir, [
      {
        id: 'q_new',
        threadId: 'thread-new',
        content: 'replace the old descendant',
        dispatchMode: 'manager-evaluate',
        createdAt: new Date().toISOString(),
        processed: false,
        priority: 'normal',
      },
    ]);

    const processPromise = processNextQueued(tempDir, tempDir);
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-thread-supersede',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
        supersedesThreadIds: ['thread-old'],
        reason: 'new descendant fully replaces old output',
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    await processPromise;

    let meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-old']?.workerRuntimeState).toBe(
      'cancelled-as-superseded'
    );
    expect(meta['thread-old']?.supersededByThreadId).toBe('thread-new');
    expect(meta['thread-old']?.workerRuntimeDetail).toContain('新しい派生作業');
    expect(
      addMessageMock.mock.calls.some((call) => call[1] === 'thread-old')
    ).toBe(true);

    completeCodexTurn(newWorkerProc, {
      sessionId: 'worker-thread-new',
      text: '{"status":"review","reply":"new descendant done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-new',
      text: '{"status":"review","reply":"new descendant done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const latestSession = await readSession(tempDir);
      return queue.length === 0 && latestSession.status === 'idle';
    });
  });

  it('dispatches a queued question ahead of older normal backlog after the current turn completes', async () => {
    const currentWorkerProc = makeProc(7101);
    const currentReviewProc = makeProc(7102);
    const questionWorkerProc = makeProc(7103);
    const questionReviewProc = makeProc(7104);
    const normalWorkerProc = makeProc(7105);
    const normalReviewProc = makeProc(7106);
    spawnMock
      .mockReturnValueOnce(currentWorkerProc)
      .mockReturnValueOnce(currentReviewProc)
      .mockReturnValueOnce(questionWorkerProc)
      .mockReturnValueOnce(questionReviewProc)
      .mockReturnValueOnce(normalWorkerProc)
      .mockReturnValueOnce(normalReviewProc);

    await sendToBuiltinManager(
      tempDir,
      'thread-current',
      'AA を進めてください'
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    await sendToBuiltinManager(
      tempDir,
      'thread-normal-backlog',
      'BB を実装してください'
    );
    await sendToBuiltinManager(
      tempDir,
      'thread-question',
      'CC はどうなっていますか？'
    );

    completeCodexTurn(currentWorkerProc, {
      sessionId: 'codex-thread-current',
      text: '{"status":"review","reply":"current done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(currentReviewProc, {
      sessionId: 'manager-review-current',
      text: '{"status":"review","reply":"current done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    const secondPrompt = String(
      questionWorkerProc.stdin.write.mock.calls[0]?.[0] ?? ''
    );
    expect(secondPrompt).toContain('[Topic: Thread thread-question]');
    expect(secondPrompt).toContain('CC はどうなっていますか？');

    completeCodexTurn(questionWorkerProc, {
      sessionId: 'codex-thread-question',
      text: '{"status":"review","reply":"question done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(questionReviewProc, {
      sessionId: 'manager-review-question',
      text: '{"status":"review","reply":"question done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 5);
    const thirdPrompt = String(
      normalWorkerProc.stdin.write.mock.calls[0]?.[0] ?? ''
    );
    expect(thirdPrompt).toContain('[Topic: Thread thread-normal-backlog]');
    expect(thirdPrompt).toContain('BB を実装してください');

    completeCodexTurn(normalWorkerProc, {
      sessionId: 'codex-thread-normal',
      text: '{"status":"review","reply":"normal done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 6);
    completeCodexTurn(normalReviewProc, {
      sessionId: 'manager-review-normal',
      text: '{"status":"review","reply":"normal done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(addMessageMock).toHaveBeenCalledTimes(3);
    expect(addMessageMock.mock.calls[1]?.[1]).toBe('thread-question');
    expect(addMessageMock.mock.calls[2]?.[1]).toBe('thread-normal-backlog');
  });

  it('reuses the saved worker continuity for follow-up messages on the same topic', async () => {
    const firstWorkerProc = makeProc(7201);
    const firstReviewProc = makeProc(7202);
    const secondWorkerProc = makeProc(7203);
    const secondReviewProc = makeProc(7204);
    spawnMock
      .mockReturnValueOnce(firstWorkerProc)
      .mockReturnValueOnce(firstReviewProc)
      .mockReturnValueOnce(secondWorkerProc)
      .mockReturnValueOnce(secondReviewProc);

    await sendToBuiltinManager(tempDir, 'thread-follow-up', 'first message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    firstWorkerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-follow-up"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstWorkerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(firstReviewProc, {
      sessionId: 'manager-review-follow-up-1',
      text: '{"status":"review","reply":"reply one"}',
    });

    await waitFor(async () => {
      const meta = await readManagerThreadMeta(tempDir);
      return (
        meta['thread-follow-up']?.workerSessionId === 'codex-thread-follow-up'
      );
    });

    await sendToBuiltinManager(tempDir, 'thread-follow-up', 'second message');
    await waitFor(() => spawnMock.mock.calls.length === 3);

    const secondArgs = spawnMock.mock.calls[2]?.[1] as string[];
    expect(secondArgs).toEqual(
      expect.arrayContaining(['exec', 'resume', 'codex-thread-follow-up'])
    );

    completeCodexTurn(secondWorkerProc, {
      sessionId: 'codex-thread-follow-up',
      text: '{"status":"review","reply":"reply two"}',
    });
    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(secondReviewProc, {
      sessionId: 'manager-review-follow-up-2',
      text: '{"status":"review","reply":"reply two"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });
  });

  it('retries once with a fresh worker session after an invalid resume failure', async () => {
    const firstWorkerProc = makeProc(8101);
    const firstReviewProc = makeProc(8102);
    const failingProc = makeProc(8103);
    const recoveryProc = makeProc(8104);
    const secondReviewProc = makeProc(8105);
    spawnMock
      .mockReturnValueOnce(firstWorkerProc)
      .mockReturnValueOnce(firstReviewProc)
      .mockReturnValueOnce(failingProc)
      .mockReturnValueOnce(recoveryProc)
      .mockReturnValueOnce(secondReviewProc);

    await sendToBuiltinManager(tempDir, 'thread-one', 'first message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    firstWorkerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-stale"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstWorkerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(firstReviewProc, {
      sessionId: 'manager-review-thread-one-initial',
      text: '{"status":"review","reply":"reply one"}',
    });

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        session.status === 'idle' &&
        meta['thread-one']?.workerSessionId === 'codex-thread-stale'
      );
    });

    await sendToBuiltinManager(tempDir, 'thread-one', 'follow-up');
    await waitFor(() => spawnMock.mock.calls.length === 3);
    failingProc.stderr.emit(
      'data',
      Buffer.from('resume failed: session not found for codex-thread-stale')
    );
    failingProc.emit('close', 1);

    await waitFor(() => spawnMock.mock.calls.length === 4);
    const retryArgs = spawnMock.mock.calls[3]?.[1] as string[];
    expect(retryArgs).toContain('exec');
    expect(retryArgs).not.toContain('resume');

    recoveryProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-recovered"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"recovered reply"}}',
        ].join('\n')
      )
    );
    recoveryProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 5);
    completeCodexTurn(secondReviewProc, {
      sessionId: 'manager-review-thread-one-retry',
      text: '{"status":"review","reply":"recovered reply"}',
    });

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        session.status === 'idle' &&
        meta['thread-one']?.workerSessionId === 'codex-thread-recovered'
      );
    });

    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock.mock.calls[1]?.[2]).toContain('recovered reply');
  });

  it('reports a parse error instead of silently dropping a successful turn with no usable reply', async () => {
    const proc = makeProc(8201);
    spawnMock.mockReturnValueOnce(proc);

    await sendToBuiltinManager(tempDir, 'thread-parse', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    proc.stdout.emit(
      'data',
      Buffer.from('{"type":"thread.started","thread_id":"codex-thread-parse"}')
    );
    proc.emit('close', 0);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-parse');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      'no usable assistant reply could be parsed'
    );
  });

  it('does not mark a worker task complete when push fails after merge', async () => {
    const workerProc = makeProc(8401);
    const reviewProc = makeProc(8402);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-wt-assign_thread-push-fail',
      branchName: 'wah-worker-assign_thread-push-fail',
      targetRepoRoot: tempDir,
    });
    vi.mocked(pushWithRetry).mockResolvedValueOnce({
      success: false,
      detail: 'remote rejected',
    });

    await sendToBuiltinManager(tempDir, 'thread-push-fail', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(workerProc, {
      sessionId: 'codex-thread-push-fail',
      text: '{"status":"review","reply":"worker done","changedFiles":["src/manager-backend.ts"],"verificationSummary":"npm run verify PASS"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-push-fail',
      text: '{"status":"review","reply":"review done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(vi.mocked(validateWorktreeReadyForMerge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergeWorktreeToMain)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushWithRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPostMergeDeliveryChain)).not.toHaveBeenCalled();
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-push-fail');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('needs-reply');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('push');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('remote rejected');
  });

  it('runs the post-merge delivery chain before posting a successful review result', async () => {
    const workerProc = makeProc(8501);
    const reviewProc = makeProc(8502);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-wt-assign_thread-release',
      branchName: 'wah-worker-assign_thread-release',
      targetRepoRoot: tempDir,
    });

    await sendToBuiltinManager(tempDir, 'thread-release', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(workerProc, {
      sessionId: 'codex-thread-release',
      text: '{"status":"review","reply":"worker done","changedFiles":["src/manager-backend.ts"],"verificationSummary":"npm run verify PASS"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-release',
      text: '{"status":"review","reply":"review done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(vi.mocked(validateWorktreeReadyForMerge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushWithRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPostMergeDeliveryChain)).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-release');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('review done');
  });

  it('adopts the latest structured review reply when Codex stalls before close', async () => {
    process.env.WORKSPACE_AGENT_HUB_CODEX_STRUCTURED_REPLY_CLOSE_GRACE_MS =
      '50';
    process.env.WORKSPACE_AGENT_HUB_CODEX_IDLE_TIMEOUT_MS = '5000';

    const workerProc = makeProc(8601);
    const reviewProc = makeProc(8602);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-wt-assign_thread-stalled-review',
      branchName: 'wah-worker-assign_thread-stalled-review',
      targetRepoRoot: tempDir,
    });

    await sendToBuiltinManager(tempDir, 'thread-stalled-review', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(workerProc, {
      sessionId: 'codex-thread-stalled-review-worker',
      text: '{"status":"review","reply":"worker done","changedFiles":["src/manager-backend.ts"],"verificationSummary":"npm run verify PASS"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    reviewProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-stalled-review-manager"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"status\\":\\"review\\",\\"reply\\":\\"review done after stall\\"}"}}',
        ].join('\n')
      )
    );

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(vi.mocked(mergeWorktreeToMain)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushWithRetry)).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-stalled-review');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      'review done after stall'
    );
  });

  it('consumes the queue entry even if writing a successful reply back to thread storage fails', async () => {
    const workerProc = makeProc(8301);
    const reviewProc = makeProc(8302);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);
    addMessageMock.mockRejectedValueOnce(new Error('thread write failed'));

    await sendToBuiltinManager(tempDir, 'thread-write-fail', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    workerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-write-fail"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply that cannot be stored"}}',
        ].join('\n')
      )
    );
    workerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-write-fail',
      text: '{"status":"review","reply":"reply that cannot be stored"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
  });
});
