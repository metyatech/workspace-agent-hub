import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execGit } from '../manager-worktree.js';
import {
  findManagedRepoByRoot,
  readManagedRepos,
  resolveNewRepoRoot,
  validateNewRepoName,
} from '../manager-repos.js';
import {
  removeTempDirWithRetries,
  WINDOWS_SLOW_TEST_TIMEOUT_MS,
} from './temp-dir-test-helpers.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initGitRepo(repoRoot: string): Promise<void> {
  const initResult = await execGit(repoRoot, ['init']);
  expect(initResult.code).toBe(0);
  await writeFile(join(repoRoot, 'README.md'), '# temp\n', 'utf8');
}

async function initGitRepoWithCommit(repoRoot: string): Promise<void> {
  await initGitRepo(repoRoot);
  const addResult = await execGit(repoRoot, ['add', 'README.md']);
  expect(addResult.code).toBe(0);
  const commitResult = await execGit(repoRoot, [
    '-c',
    'user.name=Test User',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'seed',
  ]);
  expect(commitResult.code).toBe(0);
  const branchResult = await execGit(repoRoot, ['branch', '-M', 'main']);
  expect(branchResult.code).toBe(0);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removeTempDirWithRetries(dir);
  }
});

describe('manager-repos', () => {
  it('auto-discovers existing top-level git repos in the workspace', async () => {
    const workspaceRoot = await createTempDir('wah-manager-repos-workspace-');
    const repoARoot = join(workspaceRoot, 'repo-a');
    const repoBRoot = join(workspaceRoot, 'repo-b');
    await mkdir(repoARoot, { recursive: true });
    await mkdir(repoBRoot, { recursive: true });
    await initGitRepo(repoARoot);
    await initGitRepo(repoBRoot);

    const repos = await readManagedRepos(workspaceRoot);

    expect(repos.map((repo) => repo.label)).toEqual(['repo-a', 'repo-b']);
    expect(
      repos.every(
        (repo) =>
          repo.supportedWorkerRuntimes.includes('codex') &&
          repo.supportedWorkerRuntimes.includes('claude')
      )
    ).toBe(true);
    expect(repos.every((repo) => repo.preferredWorkerRuntime === null)).toBe(
      true
    );
    expect(repos.every((repo) => repo.verifyCommand.length > 0)).toBe(true);
  });

  it('finds a discovered repo by root even when git hook env vars are present', async () => {
    const workspaceRoot = await createTempDir('wah-manager-repos-hook-env-');
    const repoRoot = join(workspaceRoot, 'repo-c');
    await mkdir(repoRoot, { recursive: true });

    vi.stubEnv('GIT_DIR', join(process.cwd(), '.git'));
    vi.stubEnv('GIT_WORK_TREE', process.cwd());
    vi.stubEnv('GIT_INDEX_FILE', join(process.cwd(), '.git', 'index'));
    try {
      await initGitRepo(repoRoot);

      const found = await findManagedRepoByRoot(workspaceRoot, repoRoot);

      expect(found?.repoRoot).toBe(repoRoot);
      expect(found?.label).toBe('repo-c');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it(
    'dedupes linked worktree directories and canonicalizes them back to the primary repo root',
    async () => {
      const workspaceRoot = await createTempDir(
        'wah-manager-repos-linked-worktree-'
      );
      const repoRoot = join(workspaceRoot, 'repo-seed');
      const worktreeRoot = join(workspaceRoot, 'repo-seed-wt-task');
      await mkdir(repoRoot, { recursive: true });
      await initGitRepoWithCommit(repoRoot);

      const addWorktreeResult = await execGit(repoRoot, [
        'worktree',
        'add',
        worktreeRoot,
        '-b',
        'wt/test-linked-worktree',
      ]);
      expect(addWorktreeResult.code).toBe(0);

      const repos = await readManagedRepos(workspaceRoot);

      expect(repos.map((repo) => repo.repoRoot)).toEqual([repoRoot]);

      const found = await findManagedRepoByRoot(workspaceRoot, worktreeRoot);

      expect(found?.repoRoot).toBe(repoRoot);
      expect(found?.label).toBe('repo-seed');
    },
    WINDOWS_SLOW_TEST_TIMEOUT_MS
  );

  it('normalizes a new repo name into a workspace-local repo root', async () => {
    const workspaceRoot = await createTempDir('wah-manager-new-repo-root-');

    expect(validateNewRepoName(' Workspace Agent Hub ')).toBe(
      'workspace-agent-hub'
    );
    expect(resolveNewRepoRoot(workspaceRoot, ' Workspace Agent Hub ')).toBe(
      join(workspaceRoot, 'workspace-agent-hub')
    );
  });

  it('rejects empty new repo names', () => {
    expect(() => validateNewRepoName('   ')).toThrow('newRepoName is required');
  });
});
