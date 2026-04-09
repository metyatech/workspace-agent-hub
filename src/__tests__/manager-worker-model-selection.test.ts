import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, fetchMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.stubGlobal('fetch', fetchMock);

import {
  classifyWorkerTask,
  parseScaleLeaderboardEntries,
  selectRankedWorkerModel,
} from '../manager-worker-model-selection.js';

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

const mockPages = {
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

beforeEach(() => {
  execFileMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    const body = mockPages[url as keyof typeof mockPages];
    if (!body) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    return {
      ok: true,
      status: 200,
      text: async () => body,
    };
  });
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', fetchMock);
});

describe('manager-worker-model-selection', () => {
  it('classifies read-only tasks as codebase QnA and test-oriented writes as test writing', () => {
    expect(
      classifyWorkerTask({
        content: 'README を読んで説明してください',
        writeScopes: [],
        runMode: 'read-only',
      })
    ).toBe('codebase-qna');

    expect(
      classifyWorkerTask({
        content: '壊れた回帰を直すための regression test を足してください',
        writeScopes: ['src/__tests__/manager-backend.test.ts'],
        runMode: 'write',
      })
    ).toBe('test-writing');
  });

  it('parses the live leaderboard entries payload embedded in the Scale page', () => {
    const entries = parseScaleLeaderboardEntries(
      mockPages['https://labs.scale.com/leaderboard/sweatlas-qna']
    );

    expect(entries).toEqual(
      expect.arrayContaining([
        { model: 'Gpt 5.4 xHigh (Codex)', score: 40.8 },
        { model: 'Opus 4.6 (Claude Code)', score: 33.3 },
      ])
    );
  });

  it('selects the top live-ranked candidate when its runtime still has quota', async () => {
    const selection = await selectRankedWorkerModel({
      content: '既存の不具合を実装で修正してください',
      writeScopes: ['src/manager-backend.ts'],
      runMode: 'write',
      supportedRuntimes: ['codex', 'claude'],
    });

    expect(selection.taskClass).toBe('implementation');
    expect(selection.selected.runtime).toBe('codex');
    expect(selection.selected.model).toBe('gpt-5.4-pro');
    expect(selection.selected.effort).toBe('xhigh');
    expect(
      [
        String(execFileMock.mock.calls[0]?.[0]),
        ...((execFileMock.mock.calls[0]?.[1] as string[] | undefined) ?? []),
      ].join(' ')
    ).toMatch(/ai-quota(?:\.cmd)?/i);
  });

  it('falls back to the next runtime when the higher-ranked runtime is quota-constrained', async () => {
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

    const selection = await selectRankedWorkerModel({
      content: 'README を読んで要点だけ答えてください',
      writeScopes: [],
      runMode: 'read-only',
      supportedRuntimes: ['codex', 'claude'],
    });

    expect(selection.taskClass).toBe('codebase-qna');
    expect(selection.selected.runtime).toBe('claude');
    expect(selection.selected.model).toBe('claude-opus-4-6');
  });
});
