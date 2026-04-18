import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as bootstrap from '../repo-bootstrap.js';

const tempDirs: string[] = [];

async function makeRepo(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  await mkdir(join(dir, '.git'));
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
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
});
