import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  doctorRepositoryMock,
  dropTaskWorktreeMock,
  execGitMock,
  initializeRepositoryMock,
  listWorktreesMock,
  loadConfigMock,
  loadMarkerMock,
  planInitializeRepositoryMock,
  releaseTaskOwnedWslTmuxLocksMock,
} = vi.hoisted(() => ({
  doctorRepositoryMock: vi.fn(),
  dropTaskWorktreeMock: vi.fn(),
  execGitMock: vi.fn(),
  initializeRepositoryMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  loadConfigMock: vi.fn(),
  loadMarkerMock: vi.fn(),
  planInitializeRepositoryMock: vi.fn(),
  releaseTaskOwnedWslTmuxLocksMock: vi.fn(),
}));

vi.mock('../manager-worktree.js', () => ({
  execGit: execGitMock,
  releaseTaskOwnedWslTmuxLocks: releaseTaskOwnedWslTmuxLocksMock,
}));

vi.mock('@metyatech/managed-worktree-system', () => ({
  createTaskWorktree: vi.fn(),
  deliverTaskWorktree: vi.fn(),
  doctorRepository: doctorRepositoryMock,
  dropTaskWorktree: dropTaskWorktreeMock,
  initializeRepository: initializeRepositoryMock,
  listWorktrees: listWorktreesMock,
  loadConfig: loadConfigMock,
  loadMarker: loadMarkerMock,
  planInitializeRepository: planInitializeRepositoryMock,
}));

import {
  cleanupOrphanedManagerWorktrees,
  describeMwtError,
  dropManagerWorktree,
  maybeAutoInitializeManagerRepository,
} from '../manager-mwt.js';

describe('describeMwtError', () => {
  it('includes recovery guidance and verify output excerpts', () => {
    const detail = describeMwtError({
      message: 'Verification failed during deliver.',
      details: {
        recovery: 'Resolve the verification failure and retry deliver.',
        stderr:
          '\u001b[31mError: listen EADDRINUSE: address already in use :::3101\u001b[39m',
        stdout:
          '> course-docs-site@0.0.0 verify\n> npm run lint && npm run test',
      },
    });

    expect(detail).toContain('Verification failed during deliver.');
    expect(detail).toContain(
      'Resolve the verification failure and retry deliver.'
    );
    expect(detail).toContain(
      'stderr:\nError: listen EADDRINUSE: address already in use :::3101'
    );
    expect(detail).toContain(
      'stdout:\n> course-docs-site@0.0.0 verify\n> npm run lint && npm run test'
    );
  });

  it('falls back to the raw value for non-structured errors', () => {
    expect(describeMwtError('plain failure')).toBe('plain failure');
  });
});

describe('maybeAutoInitializeManagerRepository', () => {
  beforeEach(() => {
    doctorRepositoryMock.mockReset();
    doctorRepositoryMock.mockResolvedValue(undefined);
    dropTaskWorktreeMock.mockReset();
    dropTaskWorktreeMock.mockResolvedValue(undefined);
    execGitMock.mockReset();
    initializeRepositoryMock.mockReset();
    listWorktreesMock.mockReset();
    listWorktreesMock.mockResolvedValue([]);
    loadConfigMock.mockReset();
    loadConfigMock.mockResolvedValue({});
    loadMarkerMock.mockReset();
    planInitializeRepositoryMock.mockReset();
    planInitializeRepositoryMock.mockResolvedValue(undefined);
    initializeRepositoryMock.mockResolvedValue(undefined);
    releaseTaskOwnedWslTmuxLocksMock.mockReset();
    releaseTaskOwnedWslTmuxLocksMock.mockResolvedValue(undefined);
  });

  it('commits only .mwt/config.toml after a safe auto-init', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'wah-manager-mwt-'));
    execGitMock
      .mockResolvedValueOnce({
        stdout: 'refs/remotes/origin/main',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'https://github.com/metyatech/example.git',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: '?? .mwt/config.toml',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: '',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: '[main abc12345] chore: initialize managed-worktree-system',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'abc1234567890',
        stderr: '',
        code: 0,
      });

    const result = await maybeAutoInitializeManagerRepository({
      targetRepoRoot: repoRoot,
    });

    expect(planInitializeRepositoryMock).toHaveBeenCalledWith(repoRoot, {
      base: 'main',
      remote: 'origin',
    });
    expect(initializeRepositoryMock).toHaveBeenCalledWith(repoRoot, {
      base: 'main',
      remote: 'origin',
    });
    expect(execGitMock).toHaveBeenCalledWith(repoRoot, [
      'add',
      '--',
      '.mwt/config.toml',
    ]);
    expect(execGitMock).toHaveBeenCalledWith(repoRoot, [
      'commit',
      '-m',
      'chore: initialize managed-worktree-system',
    ]);
    expect(result).toMatchObject({
      initialized: true,
      reasonId: null,
      defaultBranch: 'main',
      remoteName: 'origin',
      changedFiles: ['.mwt/config.toml'],
      onboardingCommit: 'abc1234567890',
    });
    expect(result.detail).toContain('.mwt/config.toml');
    expect(result.detail).toContain('abc12345');
  });
});

describe('manager mwt cleanup', () => {
  beforeEach(() => {
    doctorRepositoryMock.mockReset();
    doctorRepositoryMock.mockResolvedValue(undefined);
    dropTaskWorktreeMock.mockReset();
    dropTaskWorktreeMock.mockResolvedValue(undefined);
    listWorktreesMock.mockReset();
    listWorktreesMock.mockResolvedValue([]);
    loadConfigMock.mockReset();
    loadConfigMock.mockResolvedValue({});
    loadMarkerMock.mockReset();
    releaseTaskOwnedWslTmuxLocksMock.mockReset();
    releaseTaskOwnedWslTmuxLocksMock.mockResolvedValue(undefined);
  });

  it('releases task-owned WSL/tmux locks before dropping a manager mwt worktree', async () => {
    const worktreePath = join(
      await mkdtemp(join(tmpdir(), 'wah-manager-drop-')),
      'manager-worktree'
    );
    loadMarkerMock.mockResolvedValue({
      kind: 'task',
      createdBy: 'manager',
    });

    const dropped = await dropManagerWorktree({ worktreePath });

    expect(dropped).toBe(true);
    expect(releaseTaskOwnedWslTmuxLocksMock).toHaveBeenCalledWith(worktreePath);
    expect(dropTaskWorktreeMock).toHaveBeenCalledWith(worktreePath, {
      force: true,
      deleteBranch: true,
      forceBranchDelete: true,
    });
    expect(
      releaseTaskOwnedWslTmuxLocksMock.mock.invocationCallOrder[0]
    ).toBeLessThan(dropTaskWorktreeMock.mock.invocationCallOrder[0] ?? 0);
  });

  it('releases task-owned WSL/tmux locks while sweeping orphaned manager mwt worktrees', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'wah-manager-sweep-'));
    const orphanPath = join(repoRoot, 'orphan-worktree');
    listWorktreesMock.mockResolvedValue([{ path: orphanPath }]);
    loadMarkerMock.mockResolvedValue({
      kind: 'task',
      createdBy: 'manager',
    });

    await cleanupOrphanedManagerWorktrees({
      targetRepoRoot: repoRoot,
      activeWorktreePaths: [],
    });

    expect(doctorRepositoryMock).toHaveBeenCalledWith(repoRoot, {
      fix: true,
      deep: true,
    });
    expect(releaseTaskOwnedWslTmuxLocksMock).toHaveBeenCalledWith(orphanPath);
    expect(dropTaskWorktreeMock).toHaveBeenCalledWith(orphanPath, {
      force: true,
      deleteBranch: true,
      forceBranchDelete: true,
    });
    expect(
      releaseTaskOwnedWslTmuxLocksMock.mock.invocationCallOrder[0]
    ).toBeLessThan(dropTaskWorktreeMock.mock.invocationCallOrder[0] ?? 0);
  });
});
