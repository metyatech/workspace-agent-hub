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

import {
  buildCodexSpawnOptions,
  buildCodexSpawnSpec,
  buildCodexArgs,
  buildManagerReplyPrompt,
  buildWorkerExecutionPrompt,
  getBuiltinManagerStatus,
  isSessionInvalidError,
  MANAGER_MODEL,
  MANAGER_REASONING_EFFORT,
  parseManagerReplyPayload,
  parseManagerRoutingPlan,
  parseCodexOutput,
  pickThreadUserMessage,
  processNextQueued,
  readQueue,
  readSession,
  resolveCodexCommand,
  sendGlobalToBuiltinManager,
  sendToBuiltinManager,
  shouldUseShellForCodexCommand,
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
});

afterEach(async () => {
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

  it('routes each global send with a fresh routing turn instead of resuming older router context', async () => {
    const routingProcOne = makeProc(8601);
    const dispatchProcOne = makeProc(8602);
    const workerProcOne = makeProc(8603);
    const routingProcTwo = makeProc(8604);
    const dispatchProcTwo = makeProc(8605);
    const workerProcTwo = makeProc(8606);
    spawnMock
      .mockReturnValueOnce(routingProcOne)
      .mockReturnValueOnce(dispatchProcOne)
      .mockReturnValueOnce(workerProcOne)
      .mockReturnValueOnce(routingProcTwo)
      .mockReturnValueOnce(dispatchProcTwo)
      .mockReturnValueOnce(workerProcTwo);

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
    await firstSend;

    const secondSend = sendGlobalToBuiltinManager(tempDir, 'second new task');
    await waitFor(() => spawnMock.mock.calls.length === 4);
    expect(spawnMock.mock.calls[3]?.[1]).not.toContain('resume');

    completeCodexTurn(routingProcTwo, {
      sessionId: 'routing-thread-2',
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

    await waitFor(() => spawnMock.mock.calls.length === 5);
    completeCodexTurn(dispatchProcTwo, {
      sessionId: 'dispatch-thread-2',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 6);
    completeCodexTurn(workerProcTwo, {
      sessionId: 'worker-thread-2',
      text: '{"status":"review","reply":"done two"}',
    });
    await secondSend;

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });

    const session = await readSession(tempDir);
    expect(session.routingSessionId).toBeNull();
  });

  it('passes the open topic as a mention-style routing hint instead of forcing the destination', async () => {
    const routingProc = makeProc(8611);
    const dispatchProc = makeProc(8612);
    const workerProc = makeProc(8613);
    spawnMock
      .mockReturnValueOnce(routingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc);

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

  it('turns ordinary follow-ups to existing topics into new derived topics', async () => {
    const routingProc = makeProc(8621);
    const dispatchProc = makeProc(8622);
    const workerProc = makeProc(8623);
    spawnMock
      .mockReturnValueOnce(routingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc);

    listThreadsMock.mockResolvedValue([
      {
        id: '_bX_UpQR',
        title: '支払いUIの修正',
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
      id: 'thread-derived',
      title: '続きをお願いします（「支払いUIの修正」から派生）',
    });
    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title:
          threadId === '_bX_UpQR' ? '支払いUIの修正' : `Thread ${threadId}`,
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

    const sendPromise = sendGlobalToBuiltinManager(
      tempDir,
      '続きをお願いします'
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    expect(routingProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('- topicRef: topic-1')
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
            content: '続きをお願いします',
            reason: '既存 topic の続きです',
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
    completeCodexTurn(workerProc, {
      sessionId: 'worker-topic-ref',
      text: '{"status":"review","reply":"対応しました"}',
    });

    const summary = await sendPromise;
    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(createThreadMock).toHaveBeenCalledWith(
      tempDir,
      '続きをお願いします（「支払いUIの修正」から派生）'
    );
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-derived');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      '派生元作業項目: 「支払いUIの修正」'
    );
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('続きをお願いします');
    expect(summary.items[0]).toMatchObject({
      threadId: 'thread-derived',
      title: '続きをお願いします（「支払いUIの修正」から派生）',
      outcome: 'created-new',
    });
  });

  it('keeps direct replies to needs-reply topics in the same topic instead of splitting them', async () => {
    const routingProc = makeProc(8623);
    const dispatchProc = makeProc(8624);
    const workerProc = makeProc(8625);
    spawnMock
      .mockReturnValueOnce(routingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc);

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
    const proc = makeProc(6101);
    spawnMock.mockReturnValueOnce(proc);

    await sendToBuiltinManager(tempDir, 'thread-idle', 'idle message');
    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('idle message')
    );
    expect(proc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('[Topic: Thread thread-idle]')
    );
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);

    proc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-idle"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"idle reply"}}',
        ].join('\n')
      )
    );
    proc.emit('close', 0);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-idle');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('idle reply');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
  });

  it('coalesces consecutive queued user messages on the same topic into one worker turn', async () => {
    const proc = makeProc(6151);
    spawnMock.mockReturnValueOnce(proc);

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

    const prompt = String(proc.stdin.write.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('first pending message');
    expect(prompt).toContain('second pending message');
    expect(prompt.split('first pending message').length - 1).toBe(1);
    expect(prompt.split('second pending message').length - 1).toBe(1);

    completeCodexTurn(proc, {
      sessionId: 'codex-thread-batch',
      text: '{"status":"review","reply":"single batched reply"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
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

  it('marks the manager status as stalled when the current worker shows no progress for too long', async () => {
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
        },
      ],
    });

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.health).toBe('stalled');
    expect(status.currentThreadId).toBe('thread-stalled');
    expect(status.currentThreadTitle).toBe('Thread thread-stalled');
    expect(status.detail).toContain('止まっている可能性があります');
    expect(status.errorMessage).toContain(
      '最後に進捗が見えてから長く止まっています'
    );
  });

  it('surfaces the last backend error in manager status instead of showing normal waiting', async () => {
    const session = await readSession(tempDir);
    await writeSession(tempDir, {
      ...session,
      status: 'idle',
      lastErrorMessage: '前の担当 worker が途中で停止しました。',
      lastErrorAt: '2026-03-23T08:00:00.000Z',
    });

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.health).toBe('error');
    expect(status.detail).toBe('AI backend で問題が起きています');
    expect(status.errorMessage).toBe('前の担当 worker が途中で停止しました。');
    expect(status.errorAt).toBe('2026-03-23T08:00:00.000Z');
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
    const proc = makeProc(9101);
    spawnMock.mockReturnValueOnce(proc);

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
    proc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-stuck"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"recovered reply"}}',
        ].join('\n')
      )
    );
    proc.emit('close', 0);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });
  });

  it('keeps one in-flight codex turn and serializes queued messages without leaking worker continuity across different topics', async () => {
    const firstProc = makeProc(7001);
    const secondProc = makeProc(7002);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    await sendToBuiltinManager(tempDir, 'thread-one', 'first message');
    await sendToBuiltinManager(tempDir, 'thread-two', 'second message');

    await waitFor(() => spawnMock.mock.calls.length === 1);
    const firstArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(firstArgs).toContain('exec');
    expect(firstArgs).not.toContain('resume');

    firstProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    const secondArgs = spawnMock.mock.calls[1]?.[1] as string[];
    expect(secondArgs).toContain('exec');
    expect(secondArgs).not.toContain('resume');

    secondProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-2"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply two"}}',
        ].join('\n')
      )
    );
    secondProc.emit('close', 0);

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
  });

  it('stores live worker output in thread meta while a worker turn is running', async () => {
    const proc = makeProc(7050);
    spawnMock.mockReturnValueOnce(proc);

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

    proc.stdout.emit(
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

    proc.emit('close', 0);

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

  it('marks a queued work item as scope-blocked until the conflicting worker finishes', async () => {
    const firstProc = makeProc(7060);
    const secondProc = makeProc(7061);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

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

    completeCodexTurn(firstProc, {
      sessionId: 'codex-thread-first',
      text: '{"status":"review","reply":"first done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    await waitFor(async () => {
      const latestMeta = await readManagerThreadMeta(tempDir);
      return (
        latestMeta['thread-blocked']?.workerRuntimeState === 'worker-running'
      );
    });

    meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-blocked']?.workerBlockedByThreadIds ?? []).toEqual([]);

    completeCodexTurn(secondProc, {
      sessionId: 'codex-thread-second',
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
    spawnMock
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(newWorkerProc);

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

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const latestSession = await readSession(tempDir);
      return queue.length === 0 && latestSession.status === 'idle';
    });
  });

  it('dispatches a queued question ahead of older normal backlog after the current turn completes', async () => {
    const firstProc = makeProc(7101);
    const secondProc = makeProc(7102);
    const thirdProc = makeProc(7103);
    spawnMock
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc)
      .mockReturnValueOnce(thirdProc);

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

    completeCodexTurn(firstProc, {
      sessionId: 'codex-thread-current',
      text: '{"status":"review","reply":"current done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    const secondPrompt = String(
      secondProc.stdin.write.mock.calls[0]?.[0] ?? ''
    );
    expect(secondPrompt).toContain('[Topic: Thread thread-question]');
    expect(secondPrompt).toContain('CC はどうなっていますか？');

    completeCodexTurn(secondProc, {
      sessionId: 'codex-thread-question',
      text: '{"status":"review","reply":"question done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    const thirdPrompt = String(thirdProc.stdin.write.mock.calls[0]?.[0] ?? '');
    expect(thirdPrompt).toContain('[Topic: Thread thread-normal-backlog]');
    expect(thirdPrompt).toContain('BB を実装してください');

    completeCodexTurn(thirdProc, {
      sessionId: 'codex-thread-normal',
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
    const firstProc = makeProc(7201);
    const secondProc = makeProc(7202);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    await sendToBuiltinManager(tempDir, 'thread-follow-up', 'first message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    firstProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-follow-up"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstProc.emit('close', 0);

    await waitFor(async () => {
      const meta = await readManagerThreadMeta(tempDir);
      return (
        meta['thread-follow-up']?.workerSessionId === 'codex-thread-follow-up'
      );
    });

    await sendToBuiltinManager(tempDir, 'thread-follow-up', 'second message');
    await waitFor(() => spawnMock.mock.calls.length === 2);

    const secondArgs = spawnMock.mock.calls[1]?.[1] as string[];
    expect(secondArgs).toEqual(
      expect.arrayContaining(['exec', 'resume', 'codex-thread-follow-up'])
    );
  });

  it('retries once with a fresh worker session after an invalid resume failure', async () => {
    const firstProc = makeProc(8101);
    const failingProc = makeProc(8102);
    const recoveryProc = makeProc(8103);
    spawnMock
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(failingProc)
      .mockReturnValueOnce(recoveryProc);

    await sendToBuiltinManager(tempDir, 'thread-one', 'first message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    firstProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-stale"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstProc.emit('close', 0);

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        session.status === 'idle' &&
        meta['thread-one']?.workerSessionId === 'codex-thread-stale'
      );
    });

    await sendToBuiltinManager(tempDir, 'thread-one', 'follow-up');
    await waitFor(() => spawnMock.mock.calls.length === 2);
    failingProc.stderr.emit(
      'data',
      Buffer.from('resume failed: session not found for codex-thread-stale')
    );
    failingProc.emit('close', 1);

    await waitFor(() => spawnMock.mock.calls.length === 3);
    const retryArgs = spawnMock.mock.calls[2]?.[1] as string[];
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

  it('consumes the queue entry even if writing a successful reply back to thread storage fails', async () => {
    const proc = makeProc(8301);
    spawnMock.mockReturnValueOnce(proc);
    addMessageMock.mockRejectedValueOnce(new Error('thread write failed'));

    await sendToBuiltinManager(tempDir, 'thread-write-fail', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    proc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-write-fail"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply that cannot be stored"}}',
        ].join('\n')
      )
    );
    proc.emit('close', 0);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
  });
});
