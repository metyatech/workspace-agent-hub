import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inferVerifyCommand } from '../verify-inference.js';

const tempDirs: string[] = [];

async function makeRepo(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('verify-inference', () => {
  it('prefers scripts/verify.ps1 over lower-priority signals', async () => {
    const repo = await makeRepo('verify-ps1');
    await mkdir(join(repo, 'scripts'));
    await writeFile(join(repo, 'scripts', 'verify.ps1'), 'Write-Output ok\n');
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { verify: 'echo verify' } })
    );

    await expect(inferVerifyCommand(repo)).resolves.toEqual({
      command:
        'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1',
      source: 'scripts/verify.ps1',
    });
  });

  it('detects package and make-based contracts', async () => {
    const verifyRepo = await makeRepo('pkg-verify');
    await writeFile(
      join(verifyRepo, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@9.0.0',
        scripts: { verify: 'pnpm lint' },
      })
    );
    await expect(inferVerifyCommand(verifyRepo)).resolves.toEqual({
      command: 'pnpm run verify',
      source: 'package.json:verify',
    });

    const testRepo = await makeRepo('pkg-test');
    await writeFile(
      join(testRepo, 'package.json'),
      JSON.stringify({
        packageManager: 'bun@1.1.0',
        scripts: { test: 'vitest' },
      })
    );
    await expect(inferVerifyCommand(testRepo)).resolves.toEqual({
      command: 'bun run test',
      source: 'package.json:test',
    });

    const makeVerifyRepo = await makeRepo('make-verify');
    await writeFile(join(makeVerifyRepo, 'Makefile'), 'verify:\n\t@echo ok\n');
    await expect(inferVerifyCommand(makeVerifyRepo)).resolves.toEqual({
      command: 'make verify',
      source: 'Makefile:verify',
    });
  });

  it('detects profile, python, cargo, and null fallback', async () => {
    const profileRepo = await makeRepo('profile-verify');
    await expect(
      inferVerifyCommand(profileRepo, { repoSlug: 'metyatech/opencode' })
    ).resolves.toEqual({
      command: 'bun run lint; bun run typecheck; bun turbo test:ci',
      source: 'profile:metyatech/opencode',
    });

    const pyRepo = await makeRepo('py-verify');
    await writeFile(join(pyRepo, 'pyproject.toml'), '[project]\nname="demo"\n');
    await expect(inferVerifyCommand(pyRepo)).resolves.toEqual({
      command: 'pytest',
      source: 'pyproject.toml',
    });

    const cargoRepo = await makeRepo('cargo-verify');
    await writeFile(
      join(cargoRepo, 'Cargo.toml'),
      '[package]\nname="demo"\nversion="0.1.0"\n'
    );
    await expect(inferVerifyCommand(cargoRepo)).resolves.toEqual({
      command: 'cargo test',
      source: 'Cargo.toml',
    });

    const emptyRepo = await makeRepo('empty-verify');
    await expect(inferVerifyCommand(emptyRepo)).resolves.toBeNull();
  });
});
