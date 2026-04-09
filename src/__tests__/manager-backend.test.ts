import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  spawnMock,
  execFileMock,
  fetchMock,
  addMessageMock,
  createThreadMock,
  getThreadMock,
  listThreadsMock,
  reopenThreadMock,
  resolveThreadMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  fetchMock: vi.fn(),
  addMessageMock: vi.fn(),
  createThreadMock: vi.fn(),
  getThreadMock: vi.fn(),
  listThreadsMock: vi.fn(),
  reopenThreadMock: vi.fn(),
  resolveThreadMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

vi.stubGlobal('fetch', fetchMock);

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
  createIntegrationWorktree: vi.fn().mockResolvedValue({
    worktreePath: 'C:\\temp\\wah-merge-default',
    branchName: 'wah-merge-default',
    targetRepoRoot: '',
    remoteName: 'origin',
    remoteBranch: 'main',
  }),
  createWorkerWorktree: vi.fn().mockResolvedValue({
    worktreePath: '',
    branchName: '',
    targetRepoRoot: '',
  }),
  prepareNewRepoWorkspace: vi.fn().mockResolvedValue(undefined),
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
  findGitRoot: vi
    .fn()
    .mockImplementation((candidate: string) =>
      existsSync(join(candidate, '.git')) ? candidate : null
    ),
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
  markProcessNextQueuedInFlightForTests,
  parseManagerReplyPayload,
  parseManagerWorkerResultPayload,
  parseManagerRoutingPlan,
  parseCodexProgressLine,
  parseCodexOutput,
  pickThreadUserMessage,
  processNextQueued,
  readQueue,
  readSession,
  resetProcessNextQueuedStateForTests,
  resolveCodexCommand,
  sendGlobalToBuiltinManager,
  startBuiltinManager,
  sendToBuiltinManager,
  shouldUseWindowsBatchWrapperForCodexCommand,
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
  createIntegrationWorktree,
  createWorkerWorktree,
  mergeWorktreeToMain,
  prepareNewRepoWorkspace,
  pushWithRetry,
  removeWorktree,
  resolveTargetRepoRoot,
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

function completeGenericRuntimeTurn(
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
          type: 'init',
          session_id: input.sessionId,
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          response: input.text,
        }),
      ].join('\n')
    )
  );
  proc.emit('close', input.code ?? 0);
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 10000
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

function spawnedCommandLine(callIndex: number): string {
  const args = (spawnMock.mock.calls[callIndex]?.[1] ?? []) as string[];
  return args[3] ?? args.join(' ');
}

function queueSpawnResults(...procs: unknown[]): void {
  for (const proc of procs) {
    spawnMock.mockReturnValueOnce(proc);
  }
}

function isAiQuotaCommand(command: string): boolean {
  return /ai-quota(?:\.cmd)?$/i.test(command.trim());
}

function isAiQuotaInvocation(command: string, args: string[]): boolean {
  return (
    isAiQuotaCommand(command) ||
    args.some((arg) => /ai-quota(?:\.cmd)?/i.test(arg))
  );
}

function mockScaleLeaderboardPage(
  entries: Array<{ model: string; score: number }>
): string {
  const payload = JSON.stringify(
    entries.map((entry, index) => ({
      model: entry.model,
      version: '',
      rank: index + 1,
      score: entry.score,
      createdAt: '2026-04-09T00:00:00.000Z',
    }))
  ).replace(/"/g, '\\"');
  return `<script>self.__next_f.push([1,"1b:[\\"$\\",\\"div\\",null,{\\"children\\":[\\"$\\",\\"$L1d\\",null,{\\"entries\\":${payload},\\"benchmarkName\\":\\"mock\\"}]}"])</script>`;
}

const defaultScalePages = {
  'https://labs.scale.com/leaderboard/sweatlas-qna': mockScaleLeaderboardPage([
    { model: 'Gpt 5.4 xHigh (Codex)', score: 40.8 },
    { model: 'Opus 4.6 (Claude Code)', score: 33.3 },
  ]),
  'https://labs.scale.com/leaderboard/sweatlas-tw': mockScaleLeaderboardPage([
    { model: 'Gpt-5.4-xHigh (Codex CLI)', score: 44.36 },
    { model: 'Opus-4.6 (Claude Code)', score: 36.67 },
  ]),
  'https://labs.scale.com/leaderboard/swe_bench_pro_public':
    mockScaleLeaderboardPage([
      { model: 'gpt-5.4-pro (xHigh)*', score: 59.1 },
      { model: 'claude-opus-4-6 (thinking)*', score: 51.9 },
    ]),
  'https://labs.scale.com/leaderboard/swe_bench_pro_private':
    mockScaleLeaderboardPage([
      { model: 'claude-opus-4-6 (thinking)', score: 47.1 },
      { model: 'gpt-5.4-pro (xHigh)', score: 43.4 },
    ]),
};

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'workspace-agent-hub-manager-'));
  resetProcessNextQueuedStateForTests();
  spawnMock.mockReset();
  execFileMock.mockReset();
  fetchMock.mockReset();
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
  execFileMock.mockImplementation(
    (
      command: string,
      args: string[],
      _options: object,
      callback?: (error: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      const proc = new EventEmitter();
      process.nextTick(() => {
        if (isAiQuotaInvocation(command, args)) {
          callback?.(
            null,
            JSON.stringify({
              claude: {
                status: 'ok',
                display: '5h: 1% used, 7d: 10% used',
                data: {
                  five_hour: { utilization: 1 },
                  seven_day: { utilization: 10 },
                },
              },
              codex: {
                status: 'ok',
                display: '5h: 11% used, 7d: 26% used',
                data: {
                  primary: { used_percent: 11 },
                  secondary: { used_percent: 26 },
                },
              },
            }),
            ''
          );
          return;
        }
        callback?.(null, '', '');
      });
      return proc;
    }
  );
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    const body = defaultScalePages[url as keyof typeof defaultScalePages];
    if (!body) {
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      text: async () => body,
    };
  });
  vi.mocked(createWorkerWorktree).mockReset();
  vi.mocked(createWorkerWorktree).mockResolvedValue({
    worktreePath: '',
    branchName: '',
    targetRepoRoot: '',
  });
  vi.mocked(createIntegrationWorktree).mockReset();
  vi.mocked(createIntegrationWorktree).mockResolvedValue({
    worktreePath: 'C:\\temp\\wah-merge-default',
    branchName: 'wah-merge-default',
    targetRepoRoot: tempDir,
    remoteName: 'origin',
    remoteBranch: 'main',
  });
  vi.mocked(prepareNewRepoWorkspace).mockReset();
  vi.mocked(prepareNewRepoWorkspace).mockResolvedValue(undefined);
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
  vi.mocked(resolveTargetRepoRoot).mockReset();
  vi.mocked(resolveTargetRepoRoot).mockImplementation(
    (resolvedDir: string) => resolvedDir
  );
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
  resetProcessNextQueuedStateForTests();
  delete process.env.WORKSPACE_AGENT_HUB_CODEX_IDLE_TIMEOUT_MS;
  delete process.env.WORKSPACE_AGENT_HUB_CODEX_TURN_TIMEOUT_MS;
  delete process.env.WORKSPACE_AGENT_HUB_CODEX_STRUCTURED_REPLY_CLOSE_GRACE_MS;
  delete process.env.WORKSPACE_AGENT_HUB_MANAGER_INTERNAL_ERROR_RETRY_MS;
  await rm(tempDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
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
      shouldUseWindowsBatchWrapperForCodexCommand(
        'C:\\Users\\Origin\\AppData\\Roaming\\npm\\codex.cmd',
        'win32'
      )
    ).toBe(true);
    expect(
      shouldUseWindowsBatchWrapperForCodexCommand('/usr/bin/codex', 'linux')
    ).toBe(false);
  });

  it('builds router and worker prompts that preserve system context only on first turn', () => {
    const firstUserAt = '2026-04-09T05:20:00.000Z';
    const firstAiAt = '2026-04-09T05:25:00.000Z';
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
      workingDirectory: 'D:\\ghws\\workspace-agent-hub\\packages\\manager',
      worktreePath: null,
      targetRepoRoot: null,
      writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
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
            at: firstUserAt,
          },
        ],
      },
    });
    const workerFollowUp = buildWorkerExecutionPrompt({
      content: 'Please answer the follow-up question directly.',
      resolvedDir: 'D:\\ghws',
      workingDirectory: 'D:\\ghws\\workspace-agent-hub\\packages\\manager',
      worktreePath: null,
      targetRepoRoot: null,
      writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      isFirstTurn: false,
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
            at: firstUserAt,
          },
          {
            sender: 'ai',
            content: 'Initial answer.',
            at: firstAiAt,
          },
        ],
      },
    });
    const reviewPrompt = buildManagerReviewPrompt({
      resolvedDir: 'D:\\ghws',
      workingDirectory: 'C:\\temp\\wah-wt-review\\packages\\manager',
      worktreePath: 'C:\\temp\\wah-wt-review',
      writeScopes: ['workspace-agent-hub/src/manager-backend.ts'],
      currentUserRequest: 'Please answer the follow-up question directly.',
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
            at: firstUserAt,
          },
          {
            sender: 'ai',
            content: 'I checked the branch state.',
            at: firstAiAt,
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
    expect(workerFirst).toContain(
      'Do not mention other work items, unrelated CI/build failures'
    );
    expect(workerFirst).toContain(
      'Workspace: D:\\ghws\\workspace-agent-hub\\packages\\manager'
    );
    expect(workerFirst).toContain(
      'Worker working directory: D:\\ghws\\workspace-agent-hub\\packages\\manager'
    );
    expect(workerFirst).toContain('[Topic: Implement task]');
    expect(workerFirst).toContain('Please implement the task.');
    expect(workerFollowUp).toContain('You are continuing an existing topic.');
    expect(workerFollowUp).toContain(
      'workingDirectory: D:\\ghws\\workspace-agent-hub\\packages\\manager'
    );
    expect(workerFollowUp).toContain('Latest user request:');
    expect(workerFollowUp).toContain(
      'Please answer the follow-up question directly.'
    );
    expect(reviewPrompt).toContain('built-in manager reviewer');
    expect(reviewPrompt).toContain(
      'Treat the worker report as internal input only'
    );
    expect(reviewPrompt).toContain(
      'Workspace: C:\\temp\\wah-wt-review\\packages\\manager'
    );
    expect(reviewPrompt).toContain(
      'workingDirectory: C:\\temp\\wah-wt-review\\packages\\manager'
    );
    expect(reviewPrompt).toContain(
      'Commit your verified changes in this temporary branch when needed'
    );
    expect(reviewPrompt).toContain(
      'do NOT push, release, or publish from this worktree'
    );
    expect(reviewPrompt).toContain(
      'The Manager backend will merge to the integration worktree'
    );
    expect(reviewPrompt).toContain('Do not return status "review"');
    expect(reviewPrompt).toContain(
      'The user sees your final reply only after the Manager backend finishes any required merge'
    );
    expect(reviewPrompt).toContain(
      'Do not mention other work items, unrelated CI/build failures'
    );
    expect(reviewPrompt).toContain(
      'Most recent AI reply before the latest user request:'
    );
    expect(reviewPrompt).toContain(`[${firstAiAt}] AI:`);
    expect(reviewPrompt).toContain('I checked the branch state.');
    expect(reviewPrompt).toContain(
      'Recent same-topic history (timestamps included):'
    );
    expect(reviewPrompt).toContain(`[${firstUserAt}] User:`);
    expect(reviewPrompt).toContain(
      'Latest user request that the final reply must answer:'
    );
    expect(reviewPrompt).toContain(
      'Please answer the follow-up question directly.'
    );
    expect(reviewPrompt).toContain('src/manager-backend.ts');
    expect(reviewPrompt).toContain('npm run verify PASS');
  });

  it('adds unit-test verification guidance when src/__tests__ files are in scope', () => {
    const thread = {
      id: 'thread-tests',
      title: 'Unit test follow-up',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          sender: 'user' as const,
          content: 'この Vitest を直して',
          at: '2026-04-09T05:20:00.000Z',
        },
      ],
    };
    const writeScope = 'src/__tests__/manager-worker-model-selection.test.ts';
    const workerPrompt = buildWorkerExecutionPrompt({
      content: 'この Vitest を直して',
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      workingDirectory: 'D:\\ghws\\workspace-agent-hub',
      worktreePath: null,
      targetRepoRoot: null,
      managedVerifyCommand: 'npm run verify',
      writeScopes: [writeScope],
      isFirstTurn: true,
      thread,
    });
    const reviewPrompt = buildManagerReviewPrompt({
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      workingDirectory: 'D:\\ghws\\workspace-agent-hub',
      worktreePath: null,
      writeScopes: [writeScope],
      currentUserRequest: 'この Vitest を直して',
      managedVerifyCommand: 'npm run verify',
      thread,
      workerResult: {
        status: 'review',
        reply: '修正しました。',
        changedFiles: [writeScope],
        verificationSummary:
          'npm run test:unit -- src/__tests__/manager-worker-model-selection.test.ts PASS',
      },
    });

    expect(workerPrompt).toContain('Verification guidance:');
    expect(workerPrompt).toContain(
      'Prefer the repo-standard verification command first: npm run verify.'
    );
    expect(workerPrompt).toContain('npm run test:unit -- <file ...>');
    expect(workerPrompt).toContain('do not send those files to Playwright');

    expect(reviewPrompt).toContain('Verification guidance:');
    expect(reviewPrompt).toContain(
      'Prefer the repo-standard verification command first: npm run verify.'
    );
    expect(reviewPrompt).toContain('npm run test:unit -- <file ...>');
    expect(reviewPrompt).toContain('do not send those files to Playwright');
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
    expect(spawnedCommandLine(4)).toContain(
      '"exec" "resume" "routing-thread-1"'
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
    expect(spawnedCommandLine(0)).toContain(
      '"exec" "resume" "routing-thread-stale"'
    );

    failingRoutingProc.stderr.emit(
      'data',
      Buffer.from('resume failed: session not found for routing-thread-stale')
    );
    failingRoutingProc.emit('close', 1);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(spawnedCommandLine(1)).not.toContain('"resume"');

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
        workerSessionRuntime: 'codex',
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
    expect(spawnedCommandLine(2)).toContain(
      '"exec" "resume" "codex-thread-existing"'
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
    expect(meta['_bX_UpQR']?.workerLiveOutput).toBeUndefined();
  });

  it('launches the requested Claude worker runtime and only reuses the matching stored session', async () => {
    const claudeWorkerProc = makeProc(9101);
    const managerReviewProc = makeProc(9102);
    spawnMock
      .mockReturnValueOnce(claudeWorkerProc)
      .mockReturnValueOnce(managerReviewProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: join(tempDir, 'worktrees', 'claude-runtime'),
      branchName: 'agent/claude-runtime',
      targetRepoRoot: tempDir,
    });
    await writeManagerThreadMeta(tempDir, {
      'thread-claude-runtime': {
        workerSessionId: 'claude-session-existing',
        workerSessionRuntime: 'claude',
        workerLastStartedAt: '2026-03-26T00:00:00.000Z',
      },
    });

    await sendToBuiltinManager(
      tempDir,
      'thread-claude-runtime',
      'Claude worker で続きを実行してください',
      {
        dispatchMode: 'direct-worker',
        requestedRunMode: 'read-only',
        requestedWorkerRuntime: 'claude',
        targetRepoRoot: tempDir,
      }
    );

    await waitFor(() => spawnMock.mock.calls.length === 1);
    const workerCommand = String(spawnMock.mock.calls[0]?.[0] ?? '');
    const workerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(workerCommand.toLowerCase()).toContain('claude');
    expect(workerArgs).toEqual(
      expect.arrayContaining([
        '--print',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'plan',
        '--resume',
        'claude-session-existing',
      ])
    );
    completeGenericRuntimeTurn(claudeWorkerProc, {
      sessionId: 'claude-session-existing',
      text: '{"status":"review","reply":"Claude worker finished"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(managerReviewProc, {
      sessionId: 'manager-review-claude',
      text: '{"status":"review","reply":"Claude worker finished"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    const meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-claude-runtime']?.workerSessionId).toBe(
      'claude-session-existing'
    );
    expect(meta['thread-claude-runtime']?.workerSessionRuntime).toBe('claude');
  });

  it('falls back to the next live-ranked runtime when the top runtime does not have enough quota', async () => {
    const claudeWorkerProc = makeProc(9111);
    const managerReviewProc = makeProc(9112);
    queueSpawnResults(claudeWorkerProc, managerReviewProc);
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: object,
        callback?: (
          error: Error | null,
          stdout?: string,
          stderr?: string
        ) => void
      ) => {
        const proc = new EventEmitter();
        process.nextTick(() => {
          if (isAiQuotaInvocation(command, args)) {
            callback?.(
              null,
              JSON.stringify({
                claude: {
                  status: 'ok',
                  display: '5h: 1% used, 7d: 10% used',
                  data: {
                    five_hour: { utilization: 1 },
                    seven_day: { utilization: 10 },
                  },
                },
                codex: {
                  status: 'ok',
                  display: '5h: 97% used, 7d: 95% used',
                  data: {
                    primary: { used_percent: 97 },
                    secondary: { used_percent: 95 },
                  },
                },
              }),
              ''
            );
            return;
          }
          callback?.(null, '', '');
        });
        return proc;
      }
    );

    await sendToBuiltinManager(
      tempDir,
      'thread-live-quota-fallback',
      'README を見て要点だけ教えてください'
    );

    await waitFor(() => spawnMock.mock.calls.length === 1);
    const workerCommand = String(spawnMock.mock.calls[0]?.[0] ?? '');
    const workerArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(workerCommand.toLowerCase()).toContain('claude');
    expect(workerArgs).toEqual(
      expect.arrayContaining(['--model', 'claude-opus-4-6'])
    );

    completeGenericRuntimeTurn(claudeWorkerProc, {
      sessionId: 'claude-ranked-session',
      text: '{"status":"review","reply":"README の要点です"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(managerReviewProc, {
      sessionId: 'manager-review-ranked-runtime',
      text: '{"status":"review","reply":"README の要点です"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    const meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-live-quota-fallback']?.workerSessionRuntime).toBe(
      'claude'
    );
    expect(meta['thread-live-quota-fallback']?.workerSessionModel).toBe(
      'claude-opus-4-6'
    );
  });

  it('does not launch a worker when live ranking or ai-quota cannot produce an eligible model', async () => {
    execFileMock.mockImplementationOnce(
      (
        command: string,
        args: string[],
        _options: object,
        callback?: (
          error: Error | null,
          stdout?: string,
          stderr?: string
        ) => void
      ) => {
        const proc = new EventEmitter();
        process.nextTick(() => {
          if (isAiQuotaInvocation(command, args)) {
            callback?.(new Error('ai-quota unavailable'));
            return;
          }
          callback?.(null, '', '');
        });
        return proc;
      }
    );

    await sendToBuiltinManager(
      tempDir,
      'thread-live-selection-error',
      'README を見て要点だけ教えてください'
    );

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return (
        queue.length === 0 &&
        session.status === 'idle' &&
        addMessageMock.mock.calls.length === 1
      );
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(addMessageMock.mock.calls[0]?.[1]).toBe(
      'thread-live-selection-error'
    );
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('needs-reply');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      'Live worker model selection failed before a worker could start'
    );
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('ai-quota unavailable');

    const meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-live-selection-error']?.workerSessionRuntime).toBe(
      undefined
    );
  });

  it('treats an explicit no-change follow-up as read-only even when the existing topic was previously write-oriented', async () => {
    const routingProc = makeProc(9201);
    const dispatchProc = makeProc(9202);
    const workerProc = makeProc(9203);
    const reviewProc = makeProc(9204);
    spawnMock
      .mockReturnValueOnce(routingProc)
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);

    listThreadsMock.mockResolvedValue([
      {
        id: 'thread-readonly-followup',
        title: 'workspace-agent-hub README 調査',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: 'README を見て実装方針を確認してください',
            at: new Date().toISOString(),
          },
        ],
      },
    ]);
    getThreadMock.mockImplementation(
      async (_dir: string, threadId: string) => ({
        id: threadId,
        title:
          threadId === 'thread-readonly-followup'
            ? 'workspace-agent-hub README 調査'
            : `Thread ${threadId}`,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [
          {
            sender: 'user',
            content: 'README を見て実装方針を確認してください',
            at: new Date().toISOString(),
          },
        ],
      })
    );
    await writeManagerThreadMeta(tempDir, {
      'thread-readonly-followup': {
        requestedRunMode: 'write',
      },
    });

    const followUp =
      'QA確認です。workspace-agent-hub の README.md の最上位見出しだけ答えてください。ファイル変更や新しい作業はしないでください。';
    const sendPromise = sendGlobalToBuiltinManager(tempDir, followUp);
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(routingProc, {
      sessionId: 'routing-readonly-followup',
      text: JSON.stringify({
        actions: [
          {
            kind: 'attach-existing',
            topicRef: 'topic-1',
            content: followUp,
            reason: 'README 調査 topic の read-only な続きです',
          },
        ],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(dispatchProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('Requested run mode: read-only')
    );
    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-readonly-followup',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: [],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    expect(workerProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('This is a read-only task.')
    );
    completeCodexTurn(workerProc, {
      sessionId: 'worker-readonly-followup',
      text: '{"status":"review","reply":"# workspace-agent-hub"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    completeCodexTurn(reviewProc, {
      sessionId: 'review-readonly-followup',
      text: '{"status":"review","reply":"# workspace-agent-hub"}',
    });

    const summary = await sendPromise;
    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    const meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-readonly-followup']?.requestedRunMode).toBe(
      'read-only'
    );
    expect(summary.items[0]).toMatchObject({
      threadId: 'thread-readonly-followup',
      outcome: 'attached-existing',
    });
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

  it('infers a sibling repo root from the thread context when manager dispatch falls back to universal scope', async () => {
    const dispatchProc = makeProc(6111);
    const workerProc = makeProc(6112);
    const reviewProc = makeProc(6113);
    const repoRoot = join(tempDir, 'workspace-agent-hub');
    const inferredThread = {
      id: 'thread-repo-infer',
      title: 'workspace-agent-hub が一時アクセス不能になる問題を防ぎたい',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          sender: 'user' as const,
          content: '今の実装状況を確認したいです',
          at: new Date().toISOString(),
        },
      ],
    };
    await mkdir(join(repoRoot, '.git'), { recursive: true });
    spawnMock
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: join(tempDir, 'worktrees', 'repo-inferred'),
      branchName: 'agent/repo-inferred',
      targetRepoRoot: repoRoot,
    });
    vi.mocked(resolveTargetRepoRoot).mockImplementationOnce(
      (resolvedDir: string, writeScopes: string[]) =>
        writeScopes.includes('workspace-agent-hub') ? repoRoot : resolvedDir
    );
    listThreadsMock.mockResolvedValueOnce([inferredThread]);
    getThreadMock.mockImplementationOnce(async () => inferredThread);

    await sendToBuiltinManager(
      tempDir,
      'thread-repo-infer',
      'これって完了してます？',
      { dispatchMode: 'manager-evaluate' }
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(dispatchProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('Likely repo from context: workspace-agent-hub')
    );
    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-repo-infer',
      text: JSON.stringify({
        assignee: 'worker',
        writeScopes: ['*'],
      }),
    });

    await waitFor(
      () => vi.mocked(createWorkerWorktree).mock.calls.length === 1
    );
    expect(vi.mocked(resolveTargetRepoRoot).mock.calls.length).toBe(0);
    expect(vi.mocked(createWorkerWorktree).mock.calls[0]?.[0]).toMatchObject({
      targetRepoRoot: repoRoot,
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(workerProc, {
      sessionId: 'worker-repo-infer',
      text: '{"status":"review","reply":"repo inferred"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(reviewProc, {
      sessionId: 'review-repo-infer',
      text: '{"status":"review","reply":"repo inferred"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });
  });

  it('asks for a concrete repo instead of dispatching a worker when an existing-repo write task is ambiguous', async () => {
    const dispatchProc = makeProc(6114);
    spawnMock.mockReturnValueOnce(dispatchProc);

    await sendToBuiltinManager(
      tempDir,
      'thread-ambiguous-repo',
      'これを修正して',
      {
        dispatchMode: 'manager-evaluate',
        requestedRunMode: 'write',
      }
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);
    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-ambiguous-repo',
      text: JSON.stringify({
        assignee: 'manager',
        reply:
          '既存 repo に振るべきか新規 repo を切るべきか判断できるよう、対象や成果物をもう少し具体的に書いてください。',
        status: 'needs-reply',
      }),
    });

    await waitFor(() => addMessageMock.mock.calls.length === 1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createWorkerWorktree)).not.toHaveBeenCalled();
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-ambiguous-repo');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('判断できるよう');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('needs-reply');
  });

  it('posts a completed manager-evaluate reply without spawning a second manager turn', async () => {
    const dispatchProc = makeProc(6116);
    spawnMock.mockReturnValueOnce(dispatchProc);

    await sendToBuiltinManager(
      tempDir,
      'thread-manager-direct-review',
      '完了済みならそのまま教えて',
      {
        dispatchMode: 'manager-evaluate',
      }
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-manager-direct-review',
      text: JSON.stringify({
        assignee: 'manager',
        status: 'review',
        reply: 'その場で確定しました。',
      }),
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe(
      'thread-manager-direct-review'
    );
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('その場で確定しました。');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
  });

  it('keeps manager-evaluate active replies on the manager lane and runs a follow-up turn', async () => {
    const dispatchProc = makeProc(6117);
    const managerProc = makeProc(6118);
    spawnMock
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(managerProc);

    await sendToBuiltinManager(
      tempDir,
      'thread-manager-active',
      'もう少し考えてから返して',
      {
        dispatchMode: 'manager-evaluate',
      }
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-manager-active',
      text: JSON.stringify({
        assignee: 'manager',
        status: 'active',
        reply: 'このまま Manager が続けます。',
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(addMessageMock).not.toHaveBeenCalled();

    completeCodexTurn(managerProc, {
      sessionId: 'manager-follow-up',
      text: '{"status":"review","reply":"最終回答です"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-manager-active');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('最終回答です');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
  });

  it('lets Manager choose a brand-new repo target for a new task without a visible repo picker', async () => {
    const dispatchProc = makeProc(6119);
    const workerProc = makeProc(6120);
    const reviewProc = makeProc(6121);
    const newRepoRoot = join(tempDir, 'workspace-agent-broker');
    spawnMock
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);

    await sendToBuiltinManager(
      tempDir,
      'thread-new-repo',
      'Workspace Agent Broker を新しい repo として作って',
      {
        dispatchMode: 'manager-evaluate',
        requestedRunMode: 'write',
      }
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-new-repo',
      text: JSON.stringify({
        assignee: 'worker',
        targetKind: 'new-repo',
        newRepoName: 'workspace-agent-broker',
        writeScopes: ['*'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(vi.mocked(createWorkerWorktree)).not.toHaveBeenCalled();
    expect(vi.mocked(prepareNewRepoWorkspace)).toHaveBeenCalledWith({
      workspaceRoot: tempDir,
      targetRepoRoot: newRepoRoot,
    });
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({
      cwd: newRepoRoot,
    });

    completeCodexTurn(workerProc, {
      sessionId: 'worker-new-repo',
      text: '{"status":"review","reply":"new repo done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(reviewProc, {
      sessionId: 'review-new-repo',
      text: '{"status":"review","reply":"new repo done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });

    const meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-new-repo']).toMatchObject({
      repoTargetKind: 'new-repo',
      newRepoName: 'workspace-agent-broker',
      newRepoRoot,
      managedRepoLabel: 'workspace-agent-broker',
      managedRepoRoot: newRepoRoot,
      requestedRunMode: 'write',
    });
    expect(vi.mocked(mergeWorktreeToMain)).not.toHaveBeenCalled();
  });

  it('spawns the worker from a manager-selected workingDirectory inside the isolated worktree', async () => {
    const dispatchProc = makeProc(6122);
    const workerProc = makeProc(6123);
    const reviewProc = makeProc(6124);
    const repoRoot = join(tempDir, 'workspace-agent-hub');
    const worktreePath = join(tempDir, 'worktrees', 'repo-working-dir');
    const workerSubdir = join(worktreePath, 'packages', 'manager');
    await mkdir(workerSubdir, { recursive: true });
    spawnMock
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(workerProc)
      .mockReturnValueOnce(reviewProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath,
      branchName: 'agent/repo-working-dir',
      targetRepoRoot: repoRoot,
    });

    await sendToBuiltinManager(
      tempDir,
      'thread-working-dir',
      'packages/manager から進めて',
      {
        dispatchMode: 'manager-evaluate',
        targetRepoRoot: repoRoot,
        requestedRunMode: 'write',
      }
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-working-dir',
      text: JSON.stringify({
        assignee: 'worker',
        workingDirectory: 'packages/manager',
        writeScopes: ['workspace-agent-hub/src'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({
      cwd: workerSubdir,
    });
    expect(workerProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining(`Worker working directory: ${workerSubdir}`)
    );

    completeCodexTurn(workerProc, {
      sessionId: 'worker-working-dir',
      text: '{"status":"review","reply":"working dir done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(reviewProc, {
      sessionId: 'review-working-dir',
      text: '{"status":"review","reply":"working dir done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });
  });

  it('returns the missing workingDirectory error to manager for reconsideration before starting the worker', async () => {
    const dispatchProc = makeProc(6125);
    const recoveryProc = makeProc(6126);
    const repoRoot = join(tempDir, 'workspace-agent-hub');
    const worktreePath = join(tempDir, 'worktrees', 'repo-missing-working-dir');
    await mkdir(worktreePath, { recursive: true });
    spawnMock
      .mockReturnValueOnce(dispatchProc)
      .mockReturnValueOnce(recoveryProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath,
      branchName: 'agent/repo-missing-working-dir',
      targetRepoRoot: repoRoot,
    });

    await sendToBuiltinManager(
      tempDir,
      'thread-missing-working-dir',
      'サブディレクトリから進めて',
      {
        dispatchMode: 'manager-evaluate',
        targetRepoRoot: repoRoot,
        requestedRunMode: 'write',
      }
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(dispatchProc, {
      sessionId: 'dispatch-missing-working-dir',
      text: JSON.stringify({
        assignee: 'worker',
        workingDirectory: 'missing/dir',
        writeScopes: ['workspace-agent-hub/src'],
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    expect(spawnMock.mock.calls[1]?.[2]).toMatchObject({
      cwd: worktreePath,
    });
    expect(recoveryProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('missing/dir')
    );
    expect(recoveryProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('does not exist')
    );

    completeCodexTurn(recoveryProc, {
      sessionId: 'recover-missing-working-dir',
      text: JSON.stringify({
        assignee: 'manager',
        status: 'needs-reply',
        reply: '対象の作業フォルダを確認してください。',
      }),
    });

    await waitFor(() => addMessageMock.mock.calls.length === 1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe(
      'thread-missing-working-dir'
    );
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      '対象の作業フォルダを確認してください。'
    );
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('needs-reply');
    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith({
      targetRepoRoot: repoRoot,
      worktreePath,
      branchName: 'agent/repo-missing-working-dir',
    });
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
      expect.stringContaining(
        'own the in-scope delivery chain yourself: commit, push'
      )
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

    const meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-review']).toMatchObject({
      workerSessionId: 'worker-session-review',
      workerSessionRuntime: 'codex',
      requestedWorkerRuntime: null,
    });
    expect(meta['thread-review']?.workerLastStartedAt).toEqual(
      expect.any(String)
    );
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
    await processNextQueued(tempDir, tempDir);
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
    await processNextQueued(tempDir, tempDir);

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
          targetKind: 'existing-repo',
          newRepoName: null,
          workingDirectory: null,
          workerRuntime: 'codex',
          workerModel: null,
          workerEffort: null,
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
          targetKind: 'existing-repo',
          newRepoName: null,
          workingDirectory: null,
          workerRuntime: 'codex',
          workerModel: null,
          workerEffort: null,
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
          targetKind: 'existing-repo',
          newRepoName: null,
          workingDirectory: null,
          workerRuntime: 'codex',
          workerModel: null,
          workerEffort: null,
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
          targetKind: 'existing-repo',
          newRepoName: null,
          workingDirectory: null,
          workerRuntime: 'codex',
          workerModel: null,
          workerEffort: null,
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
    await processNextQueued(tempDir, tempDir);

    await waitFor(() => spawnMock.mock.calls.length === 1);
    expect(spawnedCommandLine(0)).toContain('"exec"');
    expect(spawnedCommandLine(0)).not.toContain('"resume"');

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

  it('wraps the Windows codex.cmd shim with cmd.exe without enabling shell mode', () => {
    expect(
      buildCodexSpawnSpec(
        'C:\\Users\\Origin\\AppData\\Roaming\\npm\\codex.cmd',
        ['exec', '--json', '-'],
        'D:\\ghws',
        {
          platform: 'win32',
          env: {} as NodeJS.ProcessEnv,
        }
      )
    ).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Users\\Origin\\AppData\\Roaming\\npm\\codex.cmd" "exec" "--json" "-""',
      ],
      spawnOptions: {
        cwd: 'D:\\ghws',
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    });

    expect(
      buildCodexSpawnOptions('cmd.exe', 'D:\\ghws', 'win32', true)
    ).toEqual({
      cwd: 'D:\\ghws',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  it('does not resume a stuck pending queue just because manager status is polled', async () => {
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
    expect(status.pendingCount).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('auto-retries a transient internal queue failure instead of stalling pending work', async () => {
    process.env.WORKSPACE_AGENT_HUB_MANAGER_INTERNAL_ERROR_RETRY_MS = '100';

    const workerProc = makeProc(7101);
    const reviewProc = makeProc(7102);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);
    listThreadsMock.mockRejectedValueOnce(
      new Error('transient thread listing failure')
    );

    await sendToBuiltinManager(tempDir, 'thread-auto-retry', 'recover me');

    await waitFor(async () => {
      const session = await readSession(tempDir);
      return (
        session.lastErrorMessage?.includes(
          'transient thread listing failure'
        ) ?? false
      );
    });

    await waitFor(() => spawnMock.mock.calls.length === 1);
    completeCodexTurn(workerProc, {
      sessionId: 'worker-thread-auto-retry',
      text: '{"status":"review","reply":"worker recovered"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-auto-retry',
      text: '{"status":"review","reply":"worker recovered"}',
    });

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const queue = await readQueue(tempDir);
      return queue.length === 0 && session.activeAssignments.length === 0;
    });

    const status = await getBuiltinManagerStatus(tempDir);
    expect(status.health).toBe('ok');
    expect(status.pendingCount).toBe(0);
    expect(status.errorMessage).toBeNull();
    expect(
      addMessageMock.mock.calls.some(
        (call) =>
          call[1] === 'thread-auto-retry' &&
          call[2] === 'worker recovered' &&
          call[4] === 'review'
      )
    ).toBe(true);
  }, 15000);

  it('recovers a stale in-memory queue-runner reservation when manager start is explicitly requested', async () => {
    const workerProc = makeProc(7101);
    const reviewProc = makeProc(7102);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    await writeQueue(tempDir, [
      {
        id: 'q_stale_runner',
        threadId: 'thread-stale-runner',
        content: 'resume this queued task',
        createdAt: new Date().toISOString(),
        processed: false,
        priority: 'normal',
      },
    ]);

    markProcessNextQueuedInFlightForTests(tempDir, Date.now() - 10 * 60 * 1000);

    const result = await startBuiltinManager(tempDir);
    expect(result.started).toBe(true);

    await waitFor(() => spawnMock.mock.calls.length === 1);
    completeCodexTurn(workerProc, {
      sessionId: 'worker-thread-stale-runner',
      text: '{"status":"review","reply":"runner recovered"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-stale-runner',
      text: '{"status":"review","reply":"runner recovered"}',
    });

    await waitFor(async () => {
      const latestSession = await readSession(tempDir);
      const queue = await readQueue(tempDir);
      return queue.length === 0 && latestSession.status === 'idle';
    });

    expect(
      addMessageMock.mock.calls.some(
        (call) =>
          call[1] === 'thread-stale-runner' &&
          call[2] === 'runner recovered' &&
          call[4] === 'review'
      )
    ).toBe(true);
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
    expect(spawnedCommandLine(0)).toContain('"exec"');
    expect(spawnedCommandLine(0)).not.toContain('"resume"');

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
    expect(spawnedCommandLine(2)).toContain('"exec"');
    expect(spawnedCommandLine(2)).not.toContain('"resume"');

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
          'Worker を起動しました。まだ進捗メッセージは届いていません。'
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
        meta['thread-live']?.workerRuntimeState === undefined &&
        meta['thread-live']?.workerLiveOutput === undefined &&
        meta['thread-live']?.assigneeLabel === undefined
      );
    });
  });

  it('stores stderr lines as live error output while a worker turn is running', async () => {
    const workerProc = makeProc(7052);
    const reviewProc = makeProc(7053);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    await sendToBuiltinManager(tempDir, 'thread-live-stderr', 'stderr message');

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        session.status === 'busy' &&
        meta['thread-live-stderr']?.workerRuntimeState === 'worker-running'
      );
    });

    workerProc.stderr.emit(
      'data',
      Buffer.from('worker stderr line 1\nworker stderr line 2\n')
    );

    await waitFor(async () => {
      const meta = await readManagerThreadMeta(tempDir);
      return (
        meta['thread-live-stderr']?.workerLiveOutput === 'worker stderr line 2'
      );
    });

    let meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-live-stderr']?.workerLiveLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: 'worker stderr line 1',
          kind: 'error',
        }),
        expect.objectContaining({
          text: 'worker stderr line 2',
          kind: 'error',
        }),
      ])
    );

    workerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-live-stderr"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"stderr handled"}}',
        ].join('\n')
      )
    );
    workerProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-live-stderr',
      text: '{"status":"review","reply":"stderr handled"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      meta = await readManagerThreadMeta(tempDir);
      return (
        queue.length === 0 &&
        session.status === 'idle' &&
        meta['thread-live-stderr']?.workerRuntimeState === undefined &&
        meta['thread-live-stderr']?.workerLiveOutput === undefined &&
        meta['thread-live-stderr']?.assigneeLabel === undefined
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

  it('extracts readable progress text from non-message completed items', () => {
    const progress = parseCodexProgressLine(
      '{"type":"item.completed","item":{"type":"tool_result","content":[{"type":"output_text","text":"PowerShell の結果を確認しています。"}]}}'
    );

    expect(progress.latestText).toBe('PowerShell の結果を確認しています。');
    expect(progress.liveEntries).toHaveLength(1);
    expect(progress.liveEntries[0]?.kind).toBe('output');
    expect(progress.liveEntries[0]?.text).toBe(
      'PowerShell の結果を確認しています。'
    );
  });

  it('treats plain stdout progress lines as live output', () => {
    const progress = parseCodexProgressLine('いま verify を実行しています。');

    expect(progress.latestText).toBe('いま verify を実行しています。');
    expect(progress.liveEntries).toHaveLength(1);
    expect(progress.liveEntries[0]?.kind).toBe('output');
    expect(progress.liveEntries[0]?.text).toBe(
      'いま verify を実行しています。'
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

  it('does not block a worker in another repository when only the repo-relative scope names match', async () => {
    const secondWorkerProc = makeProc(7064);
    const secondReviewProc = makeProc(7065);
    spawnMock
      .mockReturnValueOnce(secondWorkerProc)
      .mockReturnValueOnce(secondReviewProc);

    const runningRepoRoot = join(tempDir, 'workspace-agent-hub');
    const queuedRepoRoot = join(tempDir, 'course-docs-site');
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: join(queuedRepoRoot, '.wah-worker'),
      branchName: 'wah-worker-q_other_repo',
      targetRepoRoot: queuedRepoRoot,
    });

    const session = await readSession(tempDir);
    await writeSession(tempDir, {
      ...session,
      status: 'busy',
      currentQueueId: 'q_running',
      activeAssignments: [
        {
          id: 'assign-running',
          threadId: 'thread-running',
          queueEntryIds: ['q_running'],
          assigneeKind: 'worker',
          targetKind: 'existing-repo',
          newRepoName: null,
          workingDirectory: null,
          workerRuntime: 'codex',
          workerModel: null,
          workerEffort: null,
          assigneeLabel: 'Worker agent gpt-5.4 (xhigh)',
          writeScopes: ['src'],
          pid: null,
          startedAt: new Date().toISOString(),
          lastProgressAt: new Date().toISOString(),
          worktreePath: join(runningRepoRoot, '.wah-running'),
          worktreeBranch: 'wah-worker-running',
          targetRepoRoot: runningRepoRoot,
        },
      ],
    });
    await writeQueue(tempDir, [
      {
        id: 'q_other_repo',
        threadId: 'thread-other-repo',
        content: 'other repo work',
        dispatchMode: 'direct-worker',
        targetKind: 'existing-repo',
        targetRepoRoot: queuedRepoRoot,
        writeScopes: ['src'],
        createdAt: new Date().toISOString(),
        processed: false,
        priority: 'normal',
      },
    ]);

    await processNextQueued(tempDir, tempDir);

    await waitFor(() => spawnMock.mock.calls.length === 1);
    await waitFor(async () => {
      const meta = await readManagerThreadMeta(tempDir);
      return meta['thread-other-repo']?.workerRuntimeState === 'worker-running';
    });

    let meta = await readManagerThreadMeta(tempDir);
    expect(meta['thread-other-repo']?.workerBlockedByThreadIds ?? []).toEqual(
      []
    );
    expect(meta['thread-other-repo']?.workerWriteScopes).toEqual(['src']);

    completeCodexTurn(secondWorkerProc, {
      sessionId: 'codex-thread-other-repo',
      text: '{"status":"review","reply":"other repo done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(secondReviewProc, {
      sessionId: 'manager-review-thread-other-repo',
      text: '{"status":"review","reply":"other repo done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return (
        queue.length === 0 &&
        addMessageMock.mock.calls.some(
          (call) =>
            call[1] === 'thread-other-repo' &&
            call[2] === 'other repo done' &&
            call[4] === 'review'
        )
      );
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
          targetKind: 'existing-repo',
          newRepoName: null,
          workingDirectory: null,
          workerRuntime: 'codex',
          workerModel: null,
          workerEffort: null,
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

    expect(spawnedCommandLine(2)).toContain(
      '"exec" "resume" "codex-thread-follow-up"'
    );

    completeCodexTurn(secondWorkerProc, {
      sessionId: 'codex-thread-follow-up',
      text: '{"status":"review","reply":"reply two"}',
    });
    await waitFor(() => spawnMock.mock.calls.length === 4);
    expect(secondReviewProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining(
        'Latest user request that the final reply must answer:'
      )
    );
    expect(secondReviewProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('second message')
    );
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
    expect(spawnedCommandLine(3)).toContain('"exec"');
    expect(spawnedCommandLine(3)).not.toContain('"resume"');

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

  it('resumes the current worker during recovery and keeps Vitest files on the unit-test lane', async () => {
    const firstWorkerProc = makeProc(8121);
    const firstReviewProc = makeProc(8122);
    const recoveryDecisionProc = makeProc(8123);
    const retryWorkerProc = makeProc(8124);
    const finalReviewProc = makeProc(8125);
    queueSpawnResults(
      firstWorkerProc,
      firstReviewProc,
      recoveryDecisionProc,
      retryWorkerProc,
      finalReviewProc
    );
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-wt-recovery-retry',
      branchName: 'wah-worker-recovery-retry',
      targetRepoRoot: tempDir,
    });

    await sendToBuiltinManager(
      tempDir,
      'thread-recovery-retry',
      'Vitest の確認だけ直してください',
      {
        dispatchMode: 'direct-worker',
        targetRepoRoot: tempDir,
        requestedRunMode: 'write',
        writeScopes: ['src/__tests__/manager-worker-model-selection.test.ts'],
      }
    );

    await waitFor(() => spawnMock.mock.calls.length === 1);
    completeCodexTurn(firstWorkerProc, {
      sessionId: 'worker-session-initial',
      text: JSON.stringify({
        status: 'review',
        reply: '最初の修正です',
        changedFiles: ['src/__tests__/manager-worker-model-selection.test.ts'],
        verificationSummary:
          'npm run test:e2e -- src/__tests__/manager-worker-model-selection.test.ts FAIL',
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(firstReviewProc, {
      sessionId: 'manager-review-initial',
      text: JSON.stringify({
        status: 'needs-reply',
        reply:
          'Vitest のテストファイルを Playwright に流していました。repo 標準 verify か test:unit を使ってください。',
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 3);
    completeCodexTurn(recoveryDecisionProc, {
      sessionId: 'manager-recovery-decision',
      text: JSON.stringify({
        decision: 'retry-worker',
        reason: '既存の変更は活かせるので続きだけ直せば十分です。',
        instructions:
          'Vitest のテストファイルは Playwright ではなく test:unit で確認してください。',
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 4);
    expect(spawnedCommandLine(3)).toContain(
      '"exec" "resume" "worker-session-initial"'
    );
    expect(retryWorkerProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining(
        'declaredWriteScopes: src/__tests__/manager-worker-model-selection.test.ts'
      )
    );
    expect(retryWorkerProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('npm run test:unit -- <file ...>')
    );
    expect(retryWorkerProc.stdin.write).toHaveBeenCalledWith(
      expect.stringContaining('do not send those files to Playwright')
    );

    completeCodexTurn(retryWorkerProc, {
      sessionId: 'worker-session-retry',
      text: JSON.stringify({
        status: 'review',
        reply: '修正し直しました',
        changedFiles: ['src/__tests__/manager-worker-model-selection.test.ts'],
        verificationSummary:
          'npm run test:unit -- src/__tests__/manager-worker-model-selection.test.ts PASS',
      }),
    });

    await waitFor(() => spawnMock.mock.calls.length === 5);
    completeCodexTurn(finalReviewProc, {
      sessionId: 'manager-review-final',
      text: '{"status":"review","reply":"修正し直しました"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      const meta = await readManagerThreadMeta(tempDir);
      return (
        queue.length === 0 &&
        session.status === 'idle' &&
        meta['thread-recovery-retry']?.workerSessionId ===
          'worker-session-retry'
      );
    });
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
    vi.mocked(createIntegrationWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-merge-assign_thread-push-fail',
      branchName: 'wah-merge-assign_thread-push-fail',
      targetRepoRoot: tempDir,
      remoteName: 'origin',
      remoteBranch: 'main',
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
    expect(vi.mocked(createIntegrationWorktree)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergeWorktreeToMain)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushWithRetry)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pushWithRetry)).toHaveBeenCalledWith({
      targetRepoRoot: 'C:\\temp\\wah-merge-assign_thread-push-fail',
      remoteName: 'origin',
      remoteBranch: 'main',
    });
    expect(vi.mocked(runPostMergeDeliveryChain)).not.toHaveBeenCalled();
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-push-fail');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('needs-reply');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('push');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('remote rejected');
  });

  it('skips integration merge and push when the approved worktree has no deliverable commits', async () => {
    const workerProc = makeProc(8451);
    const reviewProc = makeProc(8452);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-wt-assign_thread-noop-delivery',
      branchName: 'wah-worker-assign_thread-noop-delivery',
      targetRepoRoot: tempDir,
    });
    vi.mocked(validateWorktreeReadyForMerge).mockResolvedValueOnce({
      ready: true,
      detail: 'Ready to merge; no repository changes need to be delivered.',
      aheadCommitCount: 0,
    });

    await sendToBuiltinManager(tempDir, 'thread-noop-delivery', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    completeCodexTurn(workerProc, {
      sessionId: 'codex-thread-noop-delivery',
      text: '{"status":"review","reply":"no files changed","changedFiles":[],"verificationSummary":"npm run verify PASS"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'manager-review-thread-noop-delivery',
      text: '{"status":"review","reply":"no-op review done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(vi.mocked(validateWorktreeReadyForMerge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createIntegrationWorktree)).not.toHaveBeenCalled();
    expect(vi.mocked(mergeWorktreeToMain)).not.toHaveBeenCalled();
    expect(vi.mocked(pushWithRetry)).not.toHaveBeenCalled();
    expect(vi.mocked(runPostMergeDeliveryChain)).not.toHaveBeenCalled();
    expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith({
      targetRepoRoot: tempDir,
      worktreePath: 'C:\\temp\\wah-wt-assign_thread-noop-delivery',
      branchName: 'wah-worker-assign_thread-noop-delivery',
    });
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-noop-delivery');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('no-op review done');
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
    vi.mocked(createIntegrationWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-merge-assign_thread-release',
      branchName: 'wah-merge-assign_thread-release',
      targetRepoRoot: tempDir,
      remoteName: 'origin',
      remoteBranch: 'main',
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
    expect(vi.mocked(runPostMergeDeliveryChain)).toHaveBeenCalledWith({
      targetRepoRoot: 'C:\\temp\\wah-merge-assign_thread-release',
    });
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-release');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('review');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('review done');
  });

  it('adopts the latest structured review reply when Codex stalls before close', async () => {
    process.env.WORKSPACE_AGENT_HUB_CODEX_STRUCTURED_REPLY_CLOSE_GRACE_MS =
      '50';
    process.env.WORKSPACE_AGENT_HUB_CODEX_IDLE_TIMEOUT_MS = '5000';
    process.env.WORKSPACE_AGENT_HUB_CODEX_TURN_TIMEOUT_MS = '5000';

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
  }, 15000);

  it('keeps waiting through quiet periods and only posts a notice before the hard timeout', async () => {
    process.env.WORKSPACE_AGENT_HUB_CODEX_IDLE_TIMEOUT_MS = '50';
    process.env.WORKSPACE_AGENT_HUB_CODEX_TURN_TIMEOUT_MS = '5000';

    const workerProc = makeProc(8611);
    const reviewProc = makeProc(8612);
    spawnMock.mockReturnValueOnce(workerProc).mockReturnValueOnce(reviewProc);

    await sendToBuiltinManager(tempDir, 'thread-quiet-turn', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(addMessageMock).not.toHaveBeenCalled();
    const quietMeta = await readManagerThreadMeta(tempDir);
    expect(
      quietMeta['thread-quiet-turn']?.workerLiveLog?.some((entry) =>
        entry.text.includes('has produced no output')
      )
    ).toBe(true);

    completeCodexTurn(workerProc, {
      sessionId: 'codex-thread-quiet-turn-worker',
      text: '{"status":"review","reply":"worker done"}',
    });

    await waitFor(() => spawnMock.mock.calls.length === 2);
    completeCodexTurn(reviewProc, {
      sessionId: 'codex-thread-quiet-turn-manager',
      text: '{"status":"review","reply":"review done"}',
    });

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('review done');
  });

  it('terminates a silent Codex turn only when the hard timeout is exceeded', async () => {
    process.env.WORKSPACE_AGENT_HUB_CODEX_IDLE_TIMEOUT_MS = '5000';
    process.env.WORKSPACE_AGENT_HUB_CODEX_TURN_TIMEOUT_MS = '50';

    const workerProc = makeProc(8621);
    spawnMock.mockReturnValueOnce(workerProc);

    await sendToBuiltinManager(tempDir, 'thread-hard-timeout', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    await waitFor(() => addMessageMock.mock.calls.length === 1, 2000);

    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-hard-timeout');
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('needs-reply');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('exited with code 124');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      'exceeded the total runtime limit'
    );
  });

  it('surfaces a stdout-only Codex structured error instead of hiding it behind a generic exit code', async () => {
    const workerProc = makeProc(8622);
    spawnMock.mockReturnValueOnce(workerProc);
    const unsupportedModelError = JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message:
          "The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account.",
      },
    });

    await sendToBuiltinManager(
      tempDir,
      'thread-structured-worker-error',
      'message'
    );
    await waitFor(() => spawnMock.mock.calls.length === 1);

    workerProc.stdout.emit(
      'data',
      Buffer.from(
        [
          JSON.stringify({
            type: 'thread.started',
            thread_id: 'codex-thread-structured-worker-error',
          }),
          JSON.stringify({
            type: 'error',
            message: unsupportedModelError,
          }),
          JSON.stringify({
            type: 'turn.failed',
            error: {
              message: unsupportedModelError,
            },
          }),
        ].join('\n')
      )
    );
    workerProc.emit('close', 1);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(addMessageMock.mock.calls[0]?.[1]).toBe(
      'thread-structured-worker-error'
    );
    expect(addMessageMock.mock.calls[0]?.[4]).toBe('needs-reply');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain('exited with code 1');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      "The 'gpt-5.4-pro' model is not supported when using Codex with a ChatGPT account."
    );
  });

  it('logs worktree cleanup failures instead of swallowing them silently', async () => {
    const cleanupError = new Error('cleanup blocked by lingering lock');
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const workerProc = makeProc(8631);
    spawnMock.mockReturnValueOnce(workerProc);
    vi.mocked(createWorkerWorktree).mockResolvedValueOnce({
      worktreePath: 'C:\\temp\\wah-wt-assign_thread-cleanup-warning',
      branchName: 'wah-worker-assign_thread-cleanup-warning',
      targetRepoRoot: tempDir,
    });
    vi.mocked(removeWorktree).mockRejectedValueOnce(cleanupError);

    try {
      await sendToBuiltinManager(tempDir, 'thread-cleanup-warning', 'message');
      await waitFor(() => spawnMock.mock.calls.length === 1);

      workerProc.stderr.emit('data', Buffer.from('worker failed hard'));
      workerProc.emit('close', 1);

      await waitFor(async () => {
        const queue = await readQueue(tempDir);
        const session = await readSession(tempDir);
        return queue.length === 0 && session.status === 'idle';
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed turn cleanup for assign_q_')
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
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
