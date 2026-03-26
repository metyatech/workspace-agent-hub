import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import {
  cleanupOrphanedWorktrees,
  execGit,
  findGitRoot,
  mergeWorktreeToMain,
  pushWithRetry,
  removeWorktree,
  resolveTargetRepoRoot,
} from '../manager-worktree.js';

/**
 * Returns a factory function that, when called, creates and returns
 * a fake ChildProcess that emits stdout/stderr/close on next tick.
 * This ensures events fire AFTER listeners are attached.
 */
function gitResult(
  code: number,
  stdout: string,
  stderr = ''
): () => EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  return () => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => {
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', code);
    });
    return proc;
  };
}

beforeEach(() => {
  spawnMock.mockReset();
  // Default: any unplanned git call succeeds with empty output.
  spawnMock.mockImplementation(gitResult(0, ''));
});

describe('findGitRoot', () => {
  it('finds .git in the current directory', () => {
    const result = findGitRoot(process.cwd());
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('returns null when no .git is found at root', () => {
    const result = findGitRoot('/');
    expect(result).toBeNull();
  });
});

describe('resolveTargetRepoRoot', () => {
  it('returns resolvedDir when writeScopes is empty', () => {
    const result = resolveTargetRepoRoot('/workspace', []);
    expect(result).toBe('/workspace');
  });

  it('returns resolvedDir when writeScopes includes universal scope', () => {
    const result = resolveTargetRepoRoot('/workspace', ['*']);
    expect(result).toBe('/workspace');
  });

  it('returns resolvedDir for scopes within the same repo', () => {
    const cwd = process.cwd();
    const result = resolveTargetRepoRoot(cwd, ['src/manager-backend.ts']);
    expect(result).toBeTruthy();
  });
});

describe('execGit', () => {
  it('passes correct args to spawn for git commands', async () => {
    spawnMock.mockImplementation(gitResult(0, 'output'));

    const result = await execGit('/repo', ['status']);

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({
        cwd: '/repo',
        windowsHide: true,
      })
    );
    expect(result.stdout).toBe('output');
    expect(result.code).toBe(0);
  });
});

describe('mergeWorktreeToMain', () => {
  it('returns clean merge result on success', async () => {
    spawnMock.mockImplementation(gitResult(0, 'merge successful'));

    const result = await mergeWorktreeToMain({
      targetRepoRoot: '/repo-a',
      branchName: 'wah-worker-test',
    });

    expect(result.success).toBe(true);
    expect(result.conflicted).toBe(false);
    expect(result.conflictFiles).toHaveLength(0);
    expect(result.detail).toBe('clean merge');
  });

  it('detects conflict files on merge failure', async () => {
    const calls: (() => EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    })[] = [
      gitResult(1, '', 'CONFLICT'), // merge fails
      gitResult(0, 'src/file-a.ts\nsrc/file-b.ts'), // diff --name-only
    ];
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
      const factory = calls[callIndex] ?? gitResult(0, '');
      callIndex++;
      return factory();
    });

    const result = await mergeWorktreeToMain({
      targetRepoRoot: '/repo-b',
      branchName: 'wah-worker-conflict',
    });

    expect(result.success).toBe(false);
    expect(result.conflicted).toBe(true);
    expect(result.conflictFiles).toEqual(['src/file-a.ts', 'src/file-b.ts']);
  });

  it('aborts and reports non-conflict merge failure', async () => {
    const calls = [
      gitResult(128, '', 'fatal: error'), // merge fails
      gitResult(0, ''), // diff returns no conflicts
      gitResult(0, ''), // merge --abort
    ];
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
      const factory = calls[callIndex] ?? gitResult(0, '');
      callIndex++;
      return factory();
    });

    const result = await mergeWorktreeToMain({
      targetRepoRoot: '/repo-c',
      branchName: 'wah-worker-fatal',
    });

    expect(result.success).toBe(false);
    expect(result.conflicted).toBe(false);
    expect(result.detail).toContain('fatal: error');
  });
});

describe('pushWithRetry', () => {
  it('returns success on first attempt', async () => {
    spawnMock.mockImplementation(gitResult(0, 'pushed'));

    const result = await pushWithRetry({ targetRepoRoot: '/repo' });

    expect(result.success).toBe(true);
    expect(result.detail).toBe('pushed');
  });

  it('retries after push rejection with pull --rebase', async () => {
    const calls = [
      gitResult(1, '', 'rejected'), // push rejected
      gitResult(0, 'rebased'), // pull --rebase
      gitResult(0, 'pushed'), // push success
    ];
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
      const factory = calls[callIndex] ?? gitResult(0, '');
      callIndex++;
      return factory();
    });

    const result = await pushWithRetry({ targetRepoRoot: '/repo' });

    expect(result.success).toBe(true);
  });

  it('fails after max retries', async () => {
    const calls = [
      gitResult(1, '', 'rejected'), // push rejected
      gitResult(0, 'rebased'), // pull --rebase
      gitResult(1, '', 'rejected'), // push rejected
      gitResult(0, 'rebased'), // pull --rebase
      gitResult(1, '', 'rejected'), // push rejected
    ];
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
      const factory = calls[callIndex] ?? gitResult(0, '');
      callIndex++;
      return factory();
    });

    const result = await pushWithRetry({ targetRepoRoot: '/repo' });

    expect(result.success).toBe(false);
  });
});

describe('removeWorktree', () => {
  it('calls git worktree remove and branch delete', async () => {
    const gitArgs: string[][] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      gitArgs.push(args);
      return gitResult(0, '')();
    });

    await removeWorktree({
      targetRepoRoot: '/repo',
      worktreePath: '/tmp/wah-wt-test',
      branchName: 'wah-worker-test',
    });

    expect(gitArgs.some((a) => a.includes('remove'))).toBe(true);
    expect(gitArgs.some((a) => a.includes('-D'))).toBe(true);
    expect(gitArgs.some((a) => a.includes('prune'))).toBe(true);
  });
});

describe('cleanupOrphanedWorktrees', () => {
  it('removes worktrees not in active assignments', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /tmp/wah-wt-orphan',
      'HEAD def456',
      'branch refs/heads/wah-worker-orphan-id',
      '',
      'worktree /tmp/wah-wt-active',
      'HEAD ghi789',
      'branch refs/heads/wah-worker-active-id',
    ].join('\n');

    let firstCall = true;
    spawnMock.mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return gitResult(0, porcelain)();
      }
      return gitResult(0, '')();
    });

    await cleanupOrphanedWorktrees('/repo', ['active-id']);

    // First call is worktree list, subsequent calls are for removing orphan
    expect(spawnMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('does nothing when all worktrees are active', async () => {
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /tmp/wah-wt-active',
      'HEAD def456',
      'branch refs/heads/wah-worker-active-id',
    ].join('\n');

    spawnMock.mockImplementation(gitResult(0, porcelain));

    await cleanupOrphanedWorktrees('/repo', ['active-id']);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
