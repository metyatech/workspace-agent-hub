import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import { writeFileAtomically } from './atomic-file.js';
import { notifyManagerUpdate } from './manager-live-updates.js';
import { findGitRoot } from './manager-worktree.js';

export const MANAGER_REPOS_FILE = '.workspace-agent-hub-manager-repos.json';

export type ManagerWorkerRuntime = 'codex' | 'claude' | 'gemini' | 'copilot';
export type ManagerRunMode = 'read-only' | 'write';

export interface ManagedRepoConfig {
  id: string;
  label: string;
  repoRoot: string;
  defaultBranch: string;
  verifyCommand: string;
  supportedWorkerRuntimes: ManagerWorkerRuntime[];
  preferredWorkerRuntime: ManagerWorkerRuntime;
  mergeLaneEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertManagedRepoInput {
  id?: string | null;
  label: string;
  repoRoot: string;
  defaultBranch?: string | null;
  verifyCommand?: string | null;
  supportedWorkerRuntimes?: ManagerWorkerRuntime[] | null;
  preferredWorkerRuntime?: ManagerWorkerRuntime | null;
  mergeLaneEnabled?: boolean | null;
}

const VALID_RUNTIMES = new Set<ManagerWorkerRuntime>([
  'codex',
  'claude',
  'gemini',
  'copilot',
]);

const repoWriteLocks = new Map<string, Promise<void>>();

function managerReposFilePath(dir: string): string {
  return join(resolvePath(dir), MANAGER_REPOS_FILE);
}

async function withRepoWriteLock<T>(
  dir: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = resolvePath(dir);
  const previous = repoWriteLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  repoWriteLocks.set(key, gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (repoWriteLocks.get(key) === gate) {
      repoWriteLocks.delete(key);
    }
  }
}

function normalizeRuntimeList(
  value: ManagerWorkerRuntime[] | null | undefined
): ManagerWorkerRuntime[] {
  if (!Array.isArray(value)) {
    return ['codex'];
  }

  const runtimes = Array.from(
    new Set(
      value.filter((entry): entry is ManagerWorkerRuntime =>
        VALID_RUNTIMES.has(entry)
      )
    )
  );
  return runtimes.length > 0 ? runtimes : ['codex'];
}

function normalizeRepoId(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'repo';
}

function normalizeManagedRepo(
  raw: Partial<ManagedRepoConfig>
): ManagedRepoConfig | null {
  if (
    typeof raw.id !== 'string' ||
    typeof raw.label !== 'string' ||
    typeof raw.repoRoot !== 'string'
  ) {
    return null;
  }

  const id = normalizeRepoId(raw.id);
  const label = raw.label.trim();
  const repoRoot = resolvePath(raw.repoRoot);
  if (!id || !label || !repoRoot) {
    return null;
  }

  const supportedWorkerRuntimes = normalizeRuntimeList(
    raw.supportedWorkerRuntimes
  );
  const preferredWorkerRuntime = supportedWorkerRuntimes.includes(
    raw.preferredWorkerRuntime as ManagerWorkerRuntime
  )
    ? (raw.preferredWorkerRuntime as ManagerWorkerRuntime)
    : supportedWorkerRuntimes[0]!;
  const defaultBranch =
    typeof raw.defaultBranch === 'string' && raw.defaultBranch.trim()
      ? raw.defaultBranch.trim()
      : 'main';
  const verifyCommand =
    typeof raw.verifyCommand === 'string' && raw.verifyCommand.trim()
      ? raw.verifyCommand.trim()
      : 'npm run verify';
  const createdAt =
    typeof raw.createdAt === 'string' && raw.createdAt.trim()
      ? raw.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
      ? raw.updatedAt
      : createdAt;

  return {
    id,
    label,
    repoRoot,
    defaultBranch,
    verifyCommand,
    supportedWorkerRuntimes,
    preferredWorkerRuntime,
    mergeLaneEnabled: raw.mergeLaneEnabled !== false,
    createdAt,
    updatedAt,
  };
}

async function readManagedRepoFile(
  filePath: string
): Promise<ManagedRepoConfig[]> {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const content = await readFile(filePath, 'utf-8');
    if (!content.trim()) {
      return [];
    }
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => normalizeManagedRepo(entry as Partial<ManagedRepoConfig>))
      .filter((entry): entry is ManagedRepoConfig => entry !== null)
      .sort((left, right) => left.label.localeCompare(right.label, 'ja-JP'));
  } catch {
    return [];
  }
}

async function writeManagedRepoFile(
  dir: string,
  repos: ManagedRepoConfig[]
): Promise<void> {
  await withRepoWriteLock(dir, async () => {
    await writeFileAtomically(
      managerReposFilePath(dir),
      JSON.stringify(repos, null, 2)
    );
  });
  notifyManagerUpdate(dir);
}

export async function readManagedRepos(
  dir: string
): Promise<ManagedRepoConfig[]> {
  return readManagedRepoFile(managerReposFilePath(dir));
}

export async function findManagedRepo(
  dir: string,
  repoId: string
): Promise<ManagedRepoConfig | null> {
  const normalizedId = normalizeRepoId(repoId);
  const repos = await readManagedRepos(dir);
  return repos.find((repo) => repo.id === normalizedId) ?? null;
}

function uniqueRepoId(
  requestedId: string | null,
  label: string,
  repoRoot: string,
  existing: ManagedRepoConfig[]
): string {
  const baseId = normalizeRepoId(
    requestedId?.trim() || basename(repoRoot) || label
  );
  if (!existing.some((repo) => repo.id === baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (existing.some((repo) => repo.id === `${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

export function validateManagedRepoInput(
  input: UpsertManagedRepoInput
): Omit<ManagedRepoConfig, 'id' | 'createdAt' | 'updatedAt'> {
  const label = input.label?.trim();
  if (!label) {
    throw new Error('repo label is required');
  }

  const requestedPath = input.repoRoot?.trim();
  if (!requestedPath) {
    throw new Error('repoRoot is required');
  }

  const repoRoot = findGitRoot(resolvePath(requestedPath));
  if (!repoRoot) {
    throw new Error('repoRoot must point to a local git repository');
  }

  const supportedWorkerRuntimes = normalizeRuntimeList(
    input.supportedWorkerRuntimes
  );
  const preferredWorkerRuntime = supportedWorkerRuntimes.includes(
    input.preferredWorkerRuntime as ManagerWorkerRuntime
  )
    ? (input.preferredWorkerRuntime as ManagerWorkerRuntime)
    : supportedWorkerRuntimes[0]!;

  return {
    label,
    repoRoot,
    defaultBranch: input.defaultBranch?.trim() || 'main',
    verifyCommand: input.verifyCommand?.trim() || 'npm run verify',
    supportedWorkerRuntimes,
    preferredWorkerRuntime,
    mergeLaneEnabled: input.mergeLaneEnabled !== false,
  };
}

export async function upsertManagedRepo(
  dir: string,
  input: UpsertManagedRepoInput
): Promise<ManagedRepoConfig> {
  const normalized = validateManagedRepoInput(input);
  const filePath = managerReposFilePath(dir);

  let stored: ManagedRepoConfig | null = null;
  await withRepoWriteLock(dir, async () => {
    const current = await readManagedRepoFile(filePath);
    const now = new Date().toISOString();
    const existingIndex = current.findIndex(
      (repo) =>
        repo.id === normalizeRepoId(input.id ?? '') ||
        repo.repoRoot.toLowerCase() === normalized.repoRoot.toLowerCase()
    );

    if (existingIndex >= 0) {
      const existing = current[existingIndex]!;
      stored = {
        ...existing,
        ...normalized,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      current[existingIndex] = stored;
    } else {
      stored = {
        ...normalized,
        id: uniqueRepoId(
          input.id ?? null,
          normalized.label,
          normalized.repoRoot,
          current
        ),
        createdAt: now,
        updatedAt: now,
      };
      current.push(stored);
    }

    current.sort((left, right) =>
      left.label.localeCompare(right.label, 'ja-JP')
    );
    await writeFileAtomically(filePath, JSON.stringify(current, null, 2));
  });

  notifyManagerUpdate(dir);
  return stored!;
}
