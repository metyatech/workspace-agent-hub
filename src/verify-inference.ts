import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface InferredVerifyCommand {
  command: string;
  source: string;
}

export const PROFILE_VERIFY_COMMANDS: Record<string, string> = {
  'metyatech/opencode': 'bun run lint; bun run typecheck; bun turbo test:ci',
};

export function resolveVerifyRunner(
  parsedPackageJson: Record<string, unknown>
): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const packageManager =
    typeof parsedPackageJson.packageManager === 'string'
      ? parsedPackageJson.packageManager.trim().toLowerCase()
      : '';
  if (packageManager.startsWith('pnpm@')) {
    return 'pnpm';
  }
  if (packageManager.startsWith('yarn@')) {
    return 'yarn';
  }
  if (packageManager.startsWith('bun@')) {
    return 'bun';
  }
  return 'npm';
}

export function formatScriptCommand(
  runner: 'npm' | 'pnpm' | 'yarn' | 'bun',
  scriptName: 'verify' | 'test'
): string {
  if (runner === 'yarn') {
    return `yarn ${scriptName}`;
  }
  if (runner === 'bun') {
    return `bun run ${scriptName}`;
  }
  return `${runner} run ${scriptName}`;
}

async function readPackageJson(
  repoRoot: string
): Promise<Record<string, unknown> | null> {
  const packageJsonPath = join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(packageJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

async function inferMakeTarget(
  repoRoot: string,
  target: 'verify' | 'test'
): Promise<InferredVerifyCommand | null> {
  const makefilePath = join(repoRoot, 'Makefile');
  if (!existsSync(makefilePath)) {
    return null;
  }
  try {
    const makefile = await readFile(makefilePath, 'utf-8');
    const pattern = new RegExp(`^${target}:`, 'm');
    if (pattern.test(makefile)) {
      return {
        command: `make ${target}`,
        source: `Makefile:${target}`,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function inferVerifyCommand(
  repoRoot: string,
  options?: { repoSlug?: string | null }
): Promise<InferredVerifyCommand | null> {
  if (existsSync(join(repoRoot, 'scripts', 'verify.ps1'))) {
    return {
      command:
        'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1',
      source: 'scripts/verify.ps1',
    };
  }

  if (existsSync(join(repoRoot, 'scripts', 'verify.sh'))) {
    return {
      command: 'bash scripts/verify.sh',
      source: 'scripts/verify.sh',
    };
  }

  const packageJson = await readPackageJson(repoRoot);
  if (packageJson) {
    const scripts =
      packageJson.scripts && typeof packageJson.scripts === 'object'
        ? (packageJson.scripts as Record<string, unknown>)
        : null;
    const runner = resolveVerifyRunner(packageJson);
    if (
      scripts &&
      typeof scripts.verify === 'string' &&
      scripts.verify.trim()
    ) {
      return {
        command: formatScriptCommand(runner, 'verify'),
        source: 'package.json:verify',
      };
    }
  }

  if (options?.repoSlug && PROFILE_VERIFY_COMMANDS[options.repoSlug]) {
    return {
      command: PROFILE_VERIFY_COMMANDS[options.repoSlug]!,
      source: `profile:${options.repoSlug}`,
    };
  }

  const makeVerify = await inferMakeTarget(repoRoot, 'verify');
  if (makeVerify) {
    return makeVerify;
  }

  if (packageJson) {
    const scripts =
      packageJson.scripts && typeof packageJson.scripts === 'object'
        ? (packageJson.scripts as Record<string, unknown>)
        : null;
    const runner = resolveVerifyRunner(packageJson);
    if (scripts && typeof scripts.test === 'string' && scripts.test.trim()) {
      return {
        command: formatScriptCommand(runner, 'test'),
        source: 'package.json:test',
      };
    }
  }

  const makeTest = await inferMakeTarget(repoRoot, 'test');
  if (makeTest) {
    return makeTest;
  }

  if (
    existsSync(join(repoRoot, 'pyproject.toml')) ||
    existsSync(join(repoRoot, 'pytest.ini'))
  ) {
    return {
      command: 'pytest',
      source: existsSync(join(repoRoot, 'pyproject.toml'))
        ? 'pyproject.toml'
        : 'pytest.ini',
    };
  }

  if (existsSync(join(repoRoot, 'Cargo.toml'))) {
    return {
      command: 'cargo test',
      source: 'Cargo.toml',
    };
  }

  return null;
}
