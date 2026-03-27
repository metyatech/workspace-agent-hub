import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execGit } from '../manager-worktree.js';
import {
  readManagedRepos,
  upsertManagedRepo,
  validateManagedRepoInput,
} from '../manager-repos.js';

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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('manager-repos', () => {
  it('canonicalizes the repo root to the git root and applies defaults', async () => {
    const workspaceRoot = await createTempDir('wah-manager-repos-workspace-');
    const repoRoot = join(workspaceRoot, 'repo-a');
    const nestedDir = join(repoRoot, 'src', 'nested');
    await mkdir(nestedDir, { recursive: true });
    await initGitRepo(repoRoot);

    const stored = await upsertManagedRepo(workspaceRoot, {
      label: 'Repo A',
      repoRoot: nestedDir,
    });

    expect(stored.label).toBe('Repo A');
    expect(stored.repoRoot).toBe(repoRoot);
    expect(stored.defaultBranch).toBe('main');
    expect(stored.verifyCommand).toBe('npm run verify');
    expect(stored.supportedWorkerRuntimes).toEqual(['codex']);
    expect(stored.preferredWorkerRuntime).toBe('codex');

    await expect(readManagedRepos(workspaceRoot)).resolves.toEqual([stored]);
  });

  it('updates an existing managed repo when the same repo root is saved again', async () => {
    const workspaceRoot = await createTempDir('wah-manager-repos-update-');
    const repoRoot = join(workspaceRoot, 'repo-b');
    await mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);

    const first = await upsertManagedRepo(workspaceRoot, {
      label: 'Repo B',
      repoRoot,
    });
    const updated = await upsertManagedRepo(workspaceRoot, {
      label: 'Repo B Updated',
      repoRoot,
      defaultBranch: 'develop',
      verifyCommand: 'pnpm verify',
    });

    expect(updated.id).toBe(first.id);
    expect(updated.label).toBe('Repo B Updated');
    expect(updated.defaultBranch).toBe('develop');
    expect(updated.verifyCommand).toBe('pnpm verify');

    await expect(readManagedRepos(workspaceRoot)).resolves.toEqual([updated]);
  });

  it('accepts a managed repo even when git hook context env vars are present', async () => {
    const workspaceRoot = await createTempDir('wah-manager-repos-hook-env-');
    const repoRoot = join(workspaceRoot, 'repo-c');
    await mkdir(repoRoot, { recursive: true });

    vi.stubEnv('GIT_DIR', join(process.cwd(), '.git'));
    vi.stubEnv('GIT_WORK_TREE', process.cwd());
    vi.stubEnv('GIT_INDEX_FILE', join(process.cwd(), '.git', 'index'));
    try {
      await initGitRepo(repoRoot);

      const stored = await upsertManagedRepo(workspaceRoot, {
        label: 'Repo C',
        repoRoot,
      });

      expect(stored.repoRoot).toBe(repoRoot);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects non-git directories', () => {
    expect(() =>
      validateManagedRepoInput({
        label: 'Invalid',
        repoRoot: join('C:\\', 'not-a-real-repo'),
      })
    ).toThrow('repoRoot must point to a local git repository');
  });
});
