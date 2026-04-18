import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditRepositoryContract,
  auditWorkspaceContracts,
  discoverWorkspaceRepos,
} from '../repo-auditor.js';

const tempDirs: string[] = [];

async function makeRepo(contract: {
  includeMwt?: boolean;
  includeVerifyScript?: boolean;
}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'wah-audit-'));
  tempDirs.push(repoRoot);
  await mkdir(join(repoRoot, '.git'));
  await writeFile(join(repoRoot, 'README.md'), '# test\n');
  await writeFile(join(repoRoot, 'LICENSE'), 'MIT\n');
  await writeFile(join(repoRoot, 'AGENTS.md'), '# rules\n');
  await writeFile(
    join(repoRoot, 'agent-ruleset.json'),
    '{"source":"github:metyatech/agent-rules"}\n'
  );
  await writeFile(join(repoRoot, '.gitignore'), '.threads.jsonl\n');
  await writeFile(join(repoRoot, '.tasks.jsonl'), '{}\n');
  if (contract.includeVerifyScript) {
    await mkdir(join(repoRoot, 'scripts'));
    await writeFile(
      join(repoRoot, 'scripts', 'verify.ps1'),
      'Write-Output "ok"\n'
    );
  }
  if (contract.includeMwt) {
    await mkdir(join(repoRoot, '.mwt'));
    await writeFile(join(repoRoot, '.mwt', 'config.toml'), 'version = 1\n');
  }
  return repoRoot;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('repo-auditor', () => {
  it('accepts a repo with the full contract surface', async () => {
    const repoRoot = await makeRepo({
      includeMwt: true,
      includeVerifyScript: true,
    });
    const result = await auditRepositoryContract(repoRoot, {
      requireMwt: true,
      requireWriteAccess: true,
    });

    expect(result.valid).toBe(true);
    expect(result.snapshot.verifyCommand).toBe(
      'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1'
    );
  });

  it('reports a missing verify command and missing mwt', async () => {
    const repoRoot = await makeRepo({
      includeMwt: false,
      includeVerifyScript: false,
    });
    const result = await auditRepositoryContract(repoRoot);

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['missing-verify-command', 'missing-mwt'])
    );
  });

  it('discovers direct child repos and skips obvious worktree names', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'wah-workspace-'));
    tempDirs.push(workspaceRoot);
    const canonicalRepo = join(workspaceRoot, 'workspace-agent-hub');
    const worktreeRepo = join(
      workspaceRoot,
      'workspace-agent-hub-wt-wave0-1234abcd'
    );
    await mkdir(join(canonicalRepo, '.git'), { recursive: true });
    await mkdir(join(worktreeRepo, '.git'), { recursive: true });

    expect(discoverWorkspaceRepos(workspaceRoot)).toEqual([canonicalRepo]);
  });

  it('audits every direct child repo in a workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'wah-workspace-'));
    tempDirs.push(workspaceRoot);
    const repoA = join(workspaceRoot, 'repo-a');
    const repoB = join(workspaceRoot, 'repo-b');
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await mkdir(join(repoA, '.git'));
    await mkdir(join(repoB, '.git'));
    await writeFile(join(repoA, 'README.md'), '# a\n');
    await writeFile(join(repoA, 'LICENSE'), 'MIT\n');
    await writeFile(join(repoA, 'AGENTS.md'), '# rules\n');
    await writeFile(
      join(repoA, 'agent-ruleset.json'),
      '{"source":"github:metyatech/agent-rules"}\n'
    );
    await writeFile(join(repoA, '.gitignore'), '.threads.jsonl\n');
    await writeFile(join(repoA, '.tasks.jsonl'), '{}\n');
    await mkdir(join(repoA, '.mwt'));
    await writeFile(join(repoA, '.mwt', 'config.toml'), 'version = 1\n');
    await mkdir(join(repoA, 'scripts'));
    await writeFile(
      join(repoA, 'scripts', 'verify.ps1'),
      'Write-Output "ok"\n'
    );
    await writeFile(join(repoB, 'README.md'), '# b\n');

    const results = await auditWorkspaceContracts(workspaceRoot);

    expect(results).toHaveLength(2);
    expect(results.find((entry) => entry.repoRoot === repoA)?.audit.valid).toBe(
      true
    );
    expect(results.find((entry) => entry.repoRoot === repoB)?.audit.valid).toBe(
      false
    );
  });
});
