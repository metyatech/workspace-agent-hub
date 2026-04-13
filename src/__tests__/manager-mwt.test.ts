import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execGitMock, initializeRepositoryMock, planInitializeRepositoryMock } =
  vi.hoisted(() => ({
    execGitMock: vi.fn(),
    initializeRepositoryMock: vi.fn(),
    planInitializeRepositoryMock: vi.fn(),
  }));

vi.mock('../manager-worktree.js', () => ({
  execGit: execGitMock,
}));

vi.mock('@metyatech/managed-worktree-system', () => ({
  createTaskWorktree: vi.fn(),
  deliverTaskWorktree: vi.fn(),
  doctorRepository: vi.fn(),
  dropTaskWorktree: vi.fn(),
  initializeRepository: initializeRepositoryMock,
  listWorktrees: vi.fn(),
  loadConfig: vi.fn(),
  loadMarker: vi.fn(),
  planInitializeRepository: planInitializeRepositoryMock,
}));

import {
  describeMwtError,
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
    execGitMock.mockReset();
    initializeRepositoryMock.mockReset();
    planInitializeRepositoryMock.mockReset();
    planInitializeRepositoryMock.mockResolvedValue(undefined);
    initializeRepositoryMock.mockResolvedValue(undefined);
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
