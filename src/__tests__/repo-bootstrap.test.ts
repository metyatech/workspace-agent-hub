import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as bootstrap from '../repo-bootstrap.js';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

async function makeRepo(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  await mkdir(join(dir, '.git'));
  return dir;
}

async function makeBootstrappableRepo(name: string): Promise<string> {
  const repo = await makeRepo(name);
  await writeFile(join(repo, 'README.md'), '# test\n');
  await writeFile(join(repo, 'LICENSE'), 'MIT\n');
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name,
        private: true,
        scripts: {
          verify: 'npm run build',
          build: 'tsc -p tsconfig.json',
        },
      },
      null,
      2
    )
  );
  await writeFile(
    join(repo, 'compose-agentsmd.cmd'),
    '@echo off\r\necho # rules> AGENTS.md\r\necho # claude> CLAUDE.md\r\nexit /b 0\r\n'
  );
  return repo;
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('repo-bootstrap', () => {
  it('returns a hard stop when verify evidence is absent', async () => {
    const repo = await makeRepo('bootstrap-missing');
    const result = await bootstrap.ensureRepoBootstrap({
      workspaceRoot: repo,
      repoRoot: repo,
    });

    expect(result.ready).toBe(false);
    expect(result.issues).toContain('bootstrap-command-failed');
    expect(result.detail).toContain('No canonical verification command');
  });

  it('bootstraps an existing repo to a ready state by creating hygiene files', async () => {
    const repo = await makeBootstrappableRepo('bootstrap-ready');
    process.env.PATH = `${repo};${originalPath ?? ''}`;

    const result = await bootstrap.ensureRepoBootstrap({
      workspaceRoot: repo,
      repoRoot: repo,
    });

    expect(result).toMatchObject({
      ready: true,
      attempted: true,
      repoRoot: repo,
      issues: [],
    });
    expect(result.detail).toContain('created .tasks.jsonl');
    expect(result.detail).toContain('added .threads.jsonl to .gitignore');

    expect(await readFile(join(repo, '.tasks.jsonl'), 'utf-8')).toBe('');
    expect(await readFile(join(repo, '.gitignore'), 'utf-8')).toContain(
      '.threads.jsonl'
    );
    expect(await readFile(join(repo, 'agent-ruleset.json'), 'utf-8')).toContain(
      'high-quality-workflow.md'
    );
  });

  it('does not duplicate the .threads.jsonl ignore entry when rerun', async () => {
    const repo = await makeBootstrappableRepo('bootstrap-idempotent');
    process.env.PATH = `${repo};${originalPath ?? ''}`;

    await bootstrap.runBootstrapCommand({
      workspaceRoot: repo,
      repoRoot: repo,
    });
    await bootstrap.runBootstrapCommand({
      workspaceRoot: repo,
      repoRoot: repo,
    });

    const gitignore = await readFile(join(repo, '.gitignore'), 'utf-8');
    const threadEntries = gitignore
      .split(/\r?\n/)
      .filter((line) => line.trim() === '.threads.jsonl');
    expect(threadEntries).toHaveLength(1);
  });
});
