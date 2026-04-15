import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
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
  repairManagerWorktreeResidue,
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

  it('includes structured cleanup progress and remaining failures', () => {
    const detail = describeMwtError({
      message:
        'Doctor repaired some managed-worktree state but could not finish every requested fix.',
      details: {
        appliedActions: [
          {
            id: 'remove_stale_registry_entry',
            worktreeId: 'mgr-worktree-1234',
          },
        ],
        completedSteps: ['remove_empty_stale_worktree_dir: D:/ghws/example-wt'],
        failures: [
          {
            step: 'delete_stale_branch',
            message: 'branch is checked out in another worktree',
            branch: 'mgr/example-branch',
          },
        ],
        recovery:
          'Resolve the blocking cleanup failure, then rerun mwt doctor --fix.',
      },
    });

    expect(detail).toContain(
      'Doctor repaired some managed-worktree state but could not finish every requested fix.'
    );
    expect(detail).toContain(
      'applied fixes:\n- remove_stale_registry_entry (worktreeId: mgr-worktree-1234)'
    );
    expect(detail).toContain(
      'completed cleanup steps:\n- remove_empty_stale_worktree_dir: D:/ghws/example-wt'
    );
    expect(detail).toContain(
      'remaining cleanup failures:\n- delete_stale_branch: branch is checked out in another worktree (branch: mgr/example-branch)'
    );
    expect(detail).toContain(
      'Resolve the blocking cleanup failure, then rerun mwt doctor --fix.'
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
        stdout: '',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: '.mwt/config.toml',
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
      '-f',
      '--',
      '.mwt/config.toml',
    ]);
    expect(execGitMock).toHaveBeenCalledWith(repoRoot, [
      'diff',
      '--cached',
      '--name-only',
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

  it('force-adds .mwt/config.toml even when git status would not show it because the path is ignored', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'wah-manager-mwt-ignored-'));
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
        stdout: '',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: '.mwt/config.toml',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: '[main def67890] chore: initialize managed-worktree-system',
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({
        stdout: 'def6789012345',
        stderr: '',
        code: 0,
      });

    const result = await maybeAutoInitializeManagerRepository({
      targetRepoRoot: repoRoot,
    });

    expect(execGitMock).toHaveBeenCalledWith(repoRoot, [
      'add',
      '-f',
      '--',
      '.mwt/config.toml',
    ]);
    expect(result).toMatchObject({
      initialized: true,
      changedFiles: ['.mwt/config.toml'],
      onboardingCommit: 'def6789012345',
    });
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

  it('removes fully orphaned empty manager sibling directories', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'wah-manager-parent-'));
    const repoRoot = join(parentDir, 'example-repo');
    const orphanDir = join(parentDir, 'example-repo-mgr-stale-deadbeef');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(orphanDir, { recursive: true });

    await cleanupOrphanedManagerWorktrees({
      targetRepoRoot: repoRoot,
      activeWorktreePaths: [],
    });

    await expect(readdir(parentDir)).resolves.not.toContain(
      'example-repo-mgr-stale-deadbeef'
    );
  });

  it('keeps non-empty orphan manager sibling directories for manual inspection', async () => {
    const parentDir = await mkdtemp(join(tmpdir(), 'wah-manager-parent-'));
    const repoRoot = join(parentDir, 'example-repo');
    const orphanDir = join(parentDir, 'example-repo-mgr-stale-deadbeef');
    await mkdir(repoRoot, { recursive: true });
    await mkdir(orphanDir, { recursive: true });
    await writeFile(join(orphanDir, 'keep.txt'), 'still in use\n', 'utf8');

    await cleanupOrphanedManagerWorktrees({
      targetRepoRoot: repoRoot,
      activeWorktreePaths: [],
    });

    await expect(readdir(parentDir)).resolves.toContain(
      'example-repo-mgr-stale-deadbeef'
    );
  });

  it('repairs stale registry residue after plain git cleanup removed the live worktree', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'wah-manager-repair-'));
    const stalePath = join(
      repoRoot,
      '..',
      'example-repo-mgr-assign-task-deadbeef'
    );
    const branchName = 'mgr/assign-task/deadbeef';
    doctorRepositoryMock
      .mockResolvedValueOnce({
        initialized: true,
        issues: [
          {
            id: 'stale_registry_entry',
            details: {
              path: stalePath,
              branch: branchName,
            },
          },
        ],
        actions: [
          {
            id: 'remove_stale_registry_entry',
            worktreeId: 'deadbeef',
          },
        ],
      })
      .mockResolvedValueOnce({
        initialized: true,
        issues: [],
        actions: [],
      });

    const detail = await repairManagerWorktreeResidue({
      targetRepoRoot: repoRoot,
      worktreePath: stalePath,
      branchName,
    });

    expect(detail).toBeNull();
    expect(doctorRepositoryMock).toHaveBeenNthCalledWith(1, repoRoot, {
      fix: true,
      deep: true,
    });
    expect(doctorRepositoryMock).toHaveBeenNthCalledWith(2, repoRoot, {
      deep: true,
    });
  });

  it('reports a targeted failure when stale registry residue survives doctor repair', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'wah-manager-repair-'));
    const stalePath = join(
      repoRoot,
      '..',
      'example-repo-mgr-assign-task-deadbeef'
    );
    const branchName = 'mgr/assign-task/deadbeef';
    doctorRepositoryMock
      .mockResolvedValueOnce({
        initialized: true,
        issues: [
          {
            id: 'stale_registry_entry',
            details: {
              path: stalePath,
              branch: branchName,
            },
          },
        ],
        actions: [],
      })
      .mockResolvedValueOnce({
        initialized: true,
        issues: [
          {
            id: 'stale_registry_entry',
            details: {
              path: stalePath,
              branch: branchName,
            },
          },
        ],
        actions: [],
      });

    const detail = await repairManagerWorktreeResidue({
      targetRepoRoot: repoRoot,
      worktreePath: stalePath,
      branchName,
    });

    expect(detail).toContain(
      'Targeted manager-owned mwt residue still remains after repair'
    );
    expect(detail).toContain(branchName);
  });
});
