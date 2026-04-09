import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve as resolvePath } from 'node:path';
import { execGit, findGitRoot } from './manager-worktree.js';

export type ManagerWorkerRuntime = 'codex' | 'claude' | 'gemini' | 'copilot';
export type ManagerRunMode = 'read-only' | 'write';
export type ManagerTargetKind = 'existing-repo' | 'new-repo';

export interface ManagedRepoConfig {
  id: string;
  label: string;
  repoRoot: string;
  defaultBranch: string;
  verifyCommand: string;
  supportedWorkerRuntimes: ManagerWorkerRuntime[];
  preferredWorkerRuntime: ManagerWorkerRuntime | null;
  mergeLaneEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

const NEW_REPO_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function normalizeRepoId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'repo';
}

function resolveVerifyRunner(
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

function formatScriptCommand(
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

async function detectVerifyCommand(repoRoot: string): Promise<string> {
  const packageJsonPath = join(repoRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const parsed = JSON.parse(
        await readFile(packageJsonPath, 'utf-8')
      ) as Record<string, unknown>;
      const scripts =
        parsed.scripts && typeof parsed.scripts === 'object'
          ? (parsed.scripts as Record<string, unknown>)
          : null;
      const runner = resolveVerifyRunner(parsed);
      if (
        scripts &&
        typeof scripts.verify === 'string' &&
        scripts.verify.trim()
      ) {
        return formatScriptCommand(runner, 'verify');
      }
      if (scripts && typeof scripts.test === 'string' && scripts.test.trim()) {
        return formatScriptCommand(runner, 'test');
      }
    } catch {
      /* fall through */
    }
  }

  if (
    existsSync(join(repoRoot, 'pyproject.toml')) ||
    existsSync(join(repoRoot, 'pytest.ini'))
  ) {
    return 'pytest';
  }
  if (existsSync(join(repoRoot, 'Cargo.toml'))) {
    return 'cargo test';
  }
  return 'Inspect repo scripts/docs to choose the correct verification command.';
}

async function detectDefaultBranch(repoRoot: string): Promise<string> {
  const originHead = await execGit(repoRoot, [
    'symbolic-ref',
    '--short',
    'refs/remotes/origin/HEAD',
  ]).catch(() => null);
  if (originHead?.code === 0 && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, '');
  }

  const currentHead = await execGit(repoRoot, [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ]).catch(() => null);
  if (
    currentHead?.code === 0 &&
    currentHead.stdout.trim() &&
    currentHead.stdout.trim() !== 'HEAD'
  ) {
    return currentHead.stdout.trim();
  }

  return 'main';
}

async function listWorkspaceRepoRoots(
  workspaceRoot: string
): Promise<string[]> {
  const normalizedWorkspaceRoot = resolvePath(workspaceRoot);
  const roots = new Map<string, string>();

  const addRoot = (candidateRoot: string | null): void => {
    if (!candidateRoot) {
      return;
    }
    const normalizedRoot = resolvePath(candidateRoot);
    const rel = relative(normalizedWorkspaceRoot, normalizedRoot);
    if (rel.startsWith('..')) {
      return;
    }
    roots.set(normalizedRoot.toLowerCase(), normalizedRoot);
  };

  const workspaceGitRoot = findGitRoot(normalizedWorkspaceRoot);
  if (
    workspaceGitRoot &&
    resolvePath(workspaceGitRoot).toLowerCase() ===
      normalizedWorkspaceRoot.toLowerCase()
  ) {
    addRoot(workspaceGitRoot);
  }

  let entries;
  try {
    entries = await readdir(normalizedWorkspaceRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    addRoot(findGitRoot(join(normalizedWorkspaceRoot, entry.name)));
  }

  return [...roots.values()].sort((left, right) =>
    basename(left).localeCompare(basename(right), 'ja-JP')
  );
}

async function buildManagedRepoConfig(
  repoRoot: string
): Promise<ManagedRepoConfig> {
  const normalizedRoot = resolvePath(repoRoot);
  const now = new Date().toISOString();
  return {
    id: normalizeRepoId(basename(normalizedRoot)),
    label: basename(normalizedRoot),
    repoRoot: normalizedRoot,
    defaultBranch: await detectDefaultBranch(normalizedRoot),
    verifyCommand: await detectVerifyCommand(normalizedRoot),
    supportedWorkerRuntimes: ['codex', 'claude'],
    preferredWorkerRuntime: null,
    mergeLaneEnabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export async function readManagedRepos(
  dir: string
): Promise<ManagedRepoConfig[]> {
  const repoRoots = await listWorkspaceRepoRoots(dir);
  const configs = await Promise.all(
    repoRoots.map((repoRoot) => buildManagedRepoConfig(repoRoot))
  );
  const deduped = new Map<string, ManagedRepoConfig>();
  for (const config of configs) {
    if (!deduped.has(config.id)) {
      deduped.set(config.id, config);
      continue;
    }
    let suffix = 2;
    let nextId = `${config.id}-${suffix}`;
    while (deduped.has(nextId)) {
      suffix += 1;
      nextId = `${config.id}-${suffix}`;
    }
    deduped.set(nextId, { ...config, id: nextId });
  }
  return [...deduped.values()].sort((left, right) =>
    left.label.localeCompare(right.label, 'ja-JP')
  );
}

export async function findManagedRepo(
  dir: string,
  repoId: string
): Promise<ManagedRepoConfig | null> {
  const normalizedId = normalizeRepoId(repoId);
  const repos = await readManagedRepos(dir);
  return repos.find((repo) => repo.id === normalizedId) ?? null;
}

export async function findManagedRepoByRoot(
  dir: string,
  repoRoot: string
): Promise<ManagedRepoConfig | null> {
  const normalizedRoot = resolvePath(repoRoot).toLowerCase();
  const repos = await readManagedRepos(dir);
  return (
    repos.find(
      (repo) => resolvePath(repo.repoRoot).toLowerCase() === normalizedRoot
    ) ?? null
  );
}

export function normalizeNewRepoName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function validateNewRepoName(raw: string): string {
  const normalized = normalizeNewRepoName(raw);
  if (!normalized) {
    throw new Error('newRepoName is required');
  }
  if (!NEW_REPO_NAME_PATTERN.test(normalized)) {
    throw new Error(
      'newRepoName must use only letters, numbers, dots, underscores, or hyphens'
    );
  }
  return normalized;
}

export function resolveNewRepoRoot(
  workspaceRoot: string,
  rawRepoName: string
): string {
  return join(resolvePath(workspaceRoot), validateNewRepoName(rawRepoName));
}
