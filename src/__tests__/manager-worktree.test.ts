import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

import {
  abortStaleMerge,
  cleanupOrphanedWorktrees,
  createIntegrationWorktree,
  createWorkerWorktree,
  execGit,
  findGitRoot,
  mergeWorktreeToMain,
  pushWithRetry,
  removeWorktree,
  resolveTargetRepoRoot,
  runPostMergeDeliveryChain,
  validateWorktreeReadyForMerge,
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
  vi.unstubAllEnvs();
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

  it('removes git hook context env vars before spawning child git commands', async () => {
    vi.stubEnv('GIT_DIR', '/parent/.git');
    vi.stubEnv('GIT_WORK_TREE', '/parent');
    vi.stubEnv('GIT_INDEX_FILE', '/parent/.git/index');

    await execGit('/repo', ['status']);

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['status'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.not.objectContaining({
          GIT_DIR: '/parent/.git',
          GIT_WORK_TREE: '/parent',
          GIT_INDEX_FILE: '/parent/.git/index',
        }),
      })
    );
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

describe('createIntegrationWorktree', () => {
  it('bases the integration worktree on the latest upstream branch', async () => {
    const gitArgs: string[][] = [];
    const calls = [
      gitResult(0, 'origin/main'),
      gitResult(0, 'fetched'),
      gitResult(0, 'refs/remotes/origin/main'),
      gitResult(0, ''),
      gitResult(0, ''),
      gitResult(0, ''),
    ];
    let callIndex = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      gitArgs.push(args);
      const factory = calls[callIndex] ?? gitResult(0, '');
      callIndex++;
      return factory();
    });

    const result = await createIntegrationWorktree({
      targetRepoRoot: '/repo-int',
      assignmentId: 'assign-upstream',
    });

    expect(result.worktreePath).toContain('wah-merge-assign-upstream');
    expect(result.branchName).toBe('wah-merge-assign-upstream');
    expect(result.remoteName).toBe('origin');
    expect(result.remoteBranch).toBe('main');
    expect(gitArgs).toEqual(
      expect.arrayContaining([
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        ['fetch', 'origin', 'main'],
        ['rev-parse', '--verify', 'refs/remotes/origin/main'],
        [
          'worktree',
          'add',
          result.worktreePath,
          '-b',
          'wah-merge-assign-upstream',
          'refs/remotes/origin/main',
        ],
      ])
    );
  });
});

describe('createWorkerWorktree', () => {
  it('allocates a fresh temp path when the legacy assignment path is already occupied', async () => {
    const assignmentId = `assign-stale-${Date.now()}`;
    const stalePath = join(tmpdir(), `wah-wt-${assignmentId}`);
    let createdPath: string | null = null;
    const gitArgs: string[][] = [];

    await rm(stalePath, { recursive: true, force: true });
    await mkdir(stalePath, { recursive: true });
    await writeFile(join(stalePath, 'trace.zip'), 'stale residue');

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      gitArgs.push(args);
      return gitResult(0, '')();
    });

    try {
      const result = await createWorkerWorktree({
        targetRepoRoot: '/repo-worker',
        assignmentId,
      });
      createdPath = result.worktreePath;

      const worktreeAddCall =
        gitArgs.find((args) => args[0] === 'worktree' && args[1] === 'add') ??
        null;

      expect(worktreeAddCall).not.toBeNull();
      expect(worktreeAddCall?.[2]).toBe(createdPath);
      expect(createdPath).not.toBe(stalePath);
      expect(createdPath).toContain(`wah-wt-${assignmentId}-`);
      expect(result.branchName).toBe(`wah-worker-${assignmentId}`);
    } finally {
      await rm(stalePath, { recursive: true, force: true });
      if (createdPath) {
        await rm(createdPath, { recursive: true, force: true });
      }
    }
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

  it('pushes an integration worktree back to the tracked base branch', async () => {
    const gitArgs: string[][] = [];
    const calls = [
      gitResult(1, '', 'rejected'),
      gitResult(0, 'rebased'),
      gitResult(0, 'pushed'),
    ];
    let callIndex = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      gitArgs.push(args);
      const factory = calls[callIndex] ?? gitResult(0, '');
      callIndex++;
      return factory();
    });

    const result = await pushWithRetry({
      targetRepoRoot: '/repo-merge',
      remoteName: 'origin',
      remoteBranch: 'main',
    });

    expect(result.success).toBe(true);
    expect(gitArgs).toEqual([
      ['push', 'origin', 'HEAD:main'],
      ['pull', '--rebase', '--no-edit', 'origin', 'main'],
      ['push', 'origin', 'HEAD:main'],
    ]);
  });
});

describe('validateWorktreeReadyForMerge', () => {
  it('rejects approval when the review step left uncommitted changes', async () => {
    const calls = [gitResult(0, ' M src/manager-backend.ts')];
    let callIndex = 0;
    spawnMock.mockImplementation(() => {
      const factory = calls[callIndex] ?? gitResult(0, '');
      callIndex++;
      return factory();
    });

    const result = await validateWorktreeReadyForMerge({
      targetRepoRoot: '/repo',
      worktreePath: '/tmp/wah-wt-test',
      reportedChangedFiles: ['src/manager-backend.ts'],
    });

    expect(result.ready).toBe(false);
    expect(result.detail).toContain(
      'approved the worktree before all changes were committed'
    );
  });
});

describe('runPostMergeDeliveryChain', () => {
  it('runs the npm release/publish chain for a metyatech-owned package', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'wah-release-chain-'));
    try {
      await writeFile(
        join(repoDir, 'package.json'),
        JSON.stringify(
          {
            name: '@metyatech/workspace-agent-hub',
            version: '1.2.3',
            bin: {
              'workspace-agent-hub': 'dist/cli.js',
            },
            repository: {
              type: 'git',
              url: 'git+https://github.com/metyatech/workspace-agent-hub.git',
            },
          },
          null,
          2
        )
      );

      const calls = [
        gitResult(0, 'https://github.com/metyatech/workspace-agent-hub.git'),
        gitResult(0, 'audit ok'),
        gitResult(0, 'pack ok'),
        gitResult(1, '', 'E404'),
        gitResult(0, ''),
        gitResult(0, ''),
        gitResult(1, '', 'release not found'),
        gitResult(0, ''),
        gitResult(0, ''),
        gitResult(0, '+ @metyatech/workspace-agent-hub@1.2.3'),
        gitResult(0, 'release created'),
        gitResult(0, '"1.2.3"'),
        gitResult(0, '1.2.3'),
      ];
      let callIndex = 0;
      spawnMock.mockImplementation(() => {
        const factory = calls[callIndex] ?? gitResult(0, '');
        callIndex++;
        return factory();
      });

      const result = await runPostMergeDeliveryChain({
        targetRepoRoot: repoDir,
      });

      expect(result.success).toBe(true);
      expect(result.detail).toContain('@metyatech/workspace-agent-hub@1.2.3');
      expect(result.performed).toEqual([
        'npm audit --omit=dev',
        'npm pack --dry-run',
        'git tag v1.2.3',
        'git push origin v1.2.3',
        'npm publish',
        'gh release create v1.2.3',
        'npm view @metyatech/workspace-agent-hub version --json',
        'npx @metyatech/workspace-agent-hub@latest --version',
      ]);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
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

  it('releases task-owned WSL tmux sockets before deleting a Windows worktree directory', async () => {
    if (process.platform !== 'win32') {
      return;
    }

    const worktreePath = await mkdtemp(join(tmpdir(), 'wah-remove-lock-'));
    const wslPath =
      '/mnt/c/Users/Origin/AppData/Local/Temp/wah-remove-lock-test';
    const childCalls: Array<{ cmd: string; args: string[] }> = [];

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      childCalls.push({ cmd, args });
      if (cmd === 'git') {
        return gitResult(0, '')();
      }
      if (cmd === 'wsl.exe') {
        if (args.includes('wslpath')) {
          return gitResult(0, wslPath)();
        }
        const finalArg = args[args.length - 1] ?? '';
        if (finalArg.includes('find /tmp -maxdepth 2 -type s')) {
          return gitResult(
            0,
            ['workspace-agent-hub-npm-e2e-deadbeef', 'unrelated-socket'].join(
              '\n'
            )
          )();
        }
        if (finalArg.includes('list-panes -a -F')) {
          return gitResult(0, [wslPath, '/home/tester'].join('\n'))();
        }
        if (args.includes('kill-server')) {
          return gitResult(0, '')();
        }
      }
      return gitResult(0, '')();
    });

    try {
      await removeWorktree({
        targetRepoRoot: 'D:\\repo',
        worktreePath,
        branchName: 'wah-worker-locked',
      });

      expect(existsSync(worktreePath)).toBe(false);
      expect(
        childCalls.some(
          ({ cmd, args }) => cmd === 'wsl.exe' && args.includes('wslpath')
        )
      ).toBe(true);
      expect(
        childCalls.some(
          ({ cmd, args }) =>
            cmd === 'wsl.exe' &&
            (args[args.length - 1] ?? '').includes(
              'find /tmp -maxdepth 2 -type s'
            )
        )
      ).toBe(true);
      expect(
        childCalls.some(
          ({ cmd, args }) =>
            cmd === 'wsl.exe' &&
            args.includes('kill-server') &&
            args.includes('workspace-agent-hub-npm-e2e-deadbeef')
        )
      ).toBe(true);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
    }
  });
});

describe('cleanupOrphanedWorktrees', () => {
  it('removes worktrees not in active assignments', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'wah-cleanup-root-'));
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

    try {
      await cleanupOrphanedWorktrees('/repo', ['active-id'], { tempRoot });

      // First call is worktree list, subsequent calls are for removing orphan
      expect(spawnMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('does nothing when all worktrees are active', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'wah-cleanup-root-'));
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

    try {
      await cleanupOrphanedWorktrees('/repo', ['active-id'], { tempRoot });

      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('removes orphaned merge-lane worktrees too', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'wah-cleanup-root-'));
    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /tmp/wah-merge-orphan',
      'HEAD def456',
      'branch refs/heads/wah-merge-orphan-id',
    ].join('\n');

    let firstCall = true;
    spawnMock.mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return gitResult(0, porcelain)();
      }
      return gitResult(0, '')();
    });

    try {
      await cleanupOrphanedWorktrees('/repo', [], { tempRoot });

      expect(spawnMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('removes unregistered temp worktree directories that are no longer active', async () => {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempRoot = await mkdtemp(join(tmpdir(), 'wah-cleanup-root-'));
    const orphanWorkerDir = join(tempRoot, `wah-wt-orphan-${nonce}`);
    const orphanMergeDir = join(tempRoot, `wah-merge-orphan-${nonce}`);
    const activeDir = join(tempRoot, `wah-wt-active-id-${nonce}`);

    await rm(orphanWorkerDir, { recursive: true, force: true });
    await rm(orphanMergeDir, { recursive: true, force: true });
    await rm(activeDir, { recursive: true, force: true });
    await mkdir(orphanWorkerDir, { recursive: true });
    await mkdir(orphanMergeDir, { recursive: true });
    await mkdir(activeDir, { recursive: true });
    await writeFile(join(orphanWorkerDir, 'trace.txt'), 'stale');
    await writeFile(join(orphanMergeDir, 'trace.txt'), 'stale');
    await writeFile(join(activeDir, 'trace.txt'), 'active');

    const porcelain = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
    ].join('\n');

    spawnMock.mockImplementation(gitResult(0, porcelain));

    try {
      await cleanupOrphanedWorktrees('/repo', ['active-id'], { tempRoot });

      expect(existsSync(orphanWorkerDir)).toBe(false);
      expect(existsSync(orphanMergeDir)).toBe(false);
      expect(existsSync(activeDir)).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(orphanWorkerDir, { recursive: true, force: true });
      await rm(orphanMergeDir, { recursive: true, force: true });
      await rm(activeDir, { recursive: true, force: true });
    }
  });
});

describe('abortStaleMerge', () => {
  let tempDir: string;

  it('returns false when no MERGE_HEAD exists', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wah-merge-'));
    const result = await abortStaleMerge(tempDir);
    expect(result).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('aborts and returns true when MERGE_HEAD exists', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wah-merge-'));
    const gitDir = join(tempDir, '.git');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'MERGE_HEAD'), 'abc123\n');

    spawnMock.mockImplementation(gitResult(0, ''));
    const result = await abortStaleMerge(tempDir);
    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await rm(tempDir, { recursive: true, force: true });
  });
});
