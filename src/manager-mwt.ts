import { resolve as resolvePath } from 'node:path';
import {
  createTaskWorktree,
  deliverTaskWorktree,
  doctorRepository,
  dropTaskWorktree,
  initializeRepository,
  listWorktrees,
  loadConfig,
  loadMarker,
  planInitializeRepository,
} from '@metyatech/managed-worktree-system';
import { execGit } from './manager-worktree.js';

const MANAGER_TASK_PATH_TEMPLATE =
  '{{ seed_parent }}/{{ repo }}-mgr-{{ slug }}-{{ shortid }}';
const MANAGER_TASK_BRANCH_TEMPLATE = 'mgr/{{ slug }}/{{ shortid }}';

export interface ManagerMwtWorktreeInfo {
  worktreePath: string;
  branchName: string;
  targetRepoRoot: string;
}

export interface ManagerMwtDeliveryResult {
  worktreeId: string;
  targetBranch: string;
  pushedCommit: string;
  seedSyncedTo: string;
}

export interface ManagerMwtAutoInitResult {
  initialized: boolean;
  reasonId: string | null;
  detail: string;
  defaultBranch: string | null;
  remoteName: string | null;
  changedFiles: string[];
}

function looksLikeMwtError(
  error: unknown
): error is { id?: unknown; message?: unknown; details?: unknown } {
  return Boolean(error) && typeof error === 'object';
}

export function isMwtDeliverConflictError(error: unknown): boolean {
  return looksLikeMwtError(error) && error.id === 'deliver_rebase_conflict';
}

export function isMwtSeedTrackedDirtyError(error: unknown): boolean {
  return looksLikeMwtError(error) && error.id === 'seed_tracked_dirty';
}

export function listMwtChangedFiles(error: unknown): string[] {
  if (
    !looksLikeMwtError(error) ||
    !error.details ||
    typeof error.details !== 'object'
  ) {
    return [];
  }

  const changedFiles = (error.details as { changedFiles?: unknown })
    .changedFiles;
  if (!Array.isArray(changedFiles)) {
    return [];
  }

  return Array.from(
    new Set(
      changedFiles
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
    )
  );
}

function mwtErrorId(error: unknown): string | null {
  return looksLikeMwtError(error) && typeof error.id === 'string'
    ? error.id
    : null;
}

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const MWT_OUTPUT_PREVIEW_LIMIT = 4_000;

function normalizeMwtOutput(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ANSI_ESCAPE_PATTERN, '').trim();
}

function formatMwtOutputSection(label: string, value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = normalizeMwtOutput(value);
  if (!normalized) {
    return null;
  }
  const preview =
    normalized.length > MWT_OUTPUT_PREVIEW_LIMIT
      ? `${normalized.slice(0, MWT_OUTPUT_PREVIEW_LIMIT)}\n...[truncated]`
      : normalized;
  return `${label}:\n${preview}`;
}

export function describeMwtError(error: unknown): string {
  if (!looksLikeMwtError(error)) {
    return String(error);
  }

  const message =
    typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : String(error);
  const recovery =
    error.details &&
    typeof error.details === 'object' &&
    typeof (error.details as { recovery?: unknown }).recovery === 'string'
      ? ((error.details as { recovery: string }).recovery ?? '').trim()
      : '';
  const stderrSection =
    error.details && typeof error.details === 'object'
      ? formatMwtOutputSection(
          'stderr',
          (error.details as { stderr?: unknown }).stderr
        )
      : null;
  const stdoutSection =
    error.details && typeof error.details === 'object'
      ? formatMwtOutputSection(
          'stdout',
          (error.details as { stdout?: unknown }).stdout
        )
      : null;
  const distinctStdoutSection =
    stdoutSection && stdoutSection !== stderrSection ? stdoutSection : null;

  return [message, recovery || null, stderrSection, distinctStdoutSection]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

export async function isManagedWorktreeRepository(
  targetRepoRoot: string
): Promise<boolean> {
  try {
    await loadConfig(resolvePath(targetRepoRoot));
    return true;
  } catch {
    return false;
  }
}

function parseOriginHeadBranch(stdout: string): string | null {
  const trimmed = stdout.trim();
  const prefix = 'refs/remotes/origin/';
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch || null;
}

async function detectOriginDefaultBranch(
  targetRepoRoot: string
): Promise<string | null> {
  const result = await execGit(targetRepoRoot, [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
  ]);
  if (result.code !== 0) {
    return null;
  }
  return parseOriginHeadBranch(result.stdout);
}

async function hasGitRemote(
  targetRepoRoot: string,
  remoteName: string
): Promise<boolean> {
  const result = await execGit(targetRepoRoot, [
    'remote',
    'get-url',
    remoteName,
  ]);
  return result.code === 0 && Boolean(result.stdout.trim());
}

export async function maybeAutoInitializeManagerRepository(input: {
  targetRepoRoot: string;
  defaultBranch?: string | null;
}): Promise<ManagerMwtAutoInitResult> {
  const targetRepoRoot = resolvePath(input.targetRepoRoot);
  const remoteName = 'origin';
  const defaultBranch =
    input.defaultBranch?.trim() ||
    (await detectOriginDefaultBranch(targetRepoRoot));

  if (!defaultBranch) {
    return {
      initialized: false,
      reasonId: 'missing_default_branch',
      detail:
        'Manager が自動初期化に必要な default branch を確定できませんでした。repo 登録の default branch を設定するか、seed で `mwt init --base <branch> --remote origin` を実行してください。',
      defaultBranch: null,
      remoteName,
      changedFiles: [],
    };
  }

  if (!(await hasGitRemote(targetRepoRoot, remoteName))) {
    return {
      initialized: false,
      reasonId: 'missing_origin_remote',
      detail:
        'Manager の自動初期化は標準の `origin` remote がある既存 repo に限定しています。`origin` がないため、自動初期化は行いませんでした。',
      defaultBranch,
      remoteName: null,
      changedFiles: [],
    };
  }

  try {
    await planInitializeRepository(targetRepoRoot, {
      base: defaultBranch,
      remote: remoteName,
    });
  } catch (error) {
    return {
      initialized: false,
      reasonId: mwtErrorId(error),
      detail: describeMwtError(error),
      defaultBranch,
      remoteName,
      changedFiles: listMwtChangedFiles(error),
    };
  }

  await initializeRepository(targetRepoRoot, {
    base: defaultBranch,
    remote: remoteName,
  });
  return {
    initialized: true,
    reasonId: null,
    detail: `managed-worktree-system を自動初期化しました (base: ${defaultBranch}, remote: ${remoteName})。`,
    defaultBranch,
    remoteName,
    changedFiles: [],
  };
}

export async function createManagerWorktree(input: {
  targetRepoRoot: string;
  assignmentId: string;
}): Promise<ManagerMwtWorktreeInfo> {
  const targetRepoRoot = resolvePath(input.targetRepoRoot);
  const created = await createTaskWorktree(targetRepoRoot, input.assignmentId, {
    createdBy: 'manager',
    pathTemplate: MANAGER_TASK_PATH_TEMPLATE,
    branchTemplate: MANAGER_TASK_BRANCH_TEMPLATE,
  });

  return {
    worktreePath: resolvePath(created.worktreePath),
    branchName: created.branch,
    targetRepoRoot,
  };
}

export async function deliverManagerWorktree(input: {
  worktreePath: string;
  targetBranch?: string | null;
  resume?: boolean;
}): Promise<ManagerMwtDeliveryResult> {
  return deliverTaskWorktree(resolvePath(input.worktreePath), {
    target: input.targetBranch ?? undefined,
    resume: input.resume,
  });
}

export async function dropManagerWorktree(input: {
  worktreePath: string;
}): Promise<boolean> {
  const worktreePath = resolvePath(input.worktreePath);
  const marker = await loadMarker(worktreePath).catch(() => null);
  if (!marker || marker.kind !== 'task' || marker.createdBy !== 'manager') {
    return false;
  }

  await dropTaskWorktree(worktreePath, {
    force: true,
    deleteBranch: true,
    forceBranchDelete: true,
  });
  return true;
}

export async function isManagerManagedWorktreePath(
  worktreePath: string
): Promise<boolean> {
  const marker = await loadMarker(resolvePath(worktreePath)).catch(() => null);
  return Boolean(
    marker && marker.kind === 'task' && marker.createdBy === 'manager'
  );
}

export async function cleanupOrphanedManagerWorktrees(input: {
  targetRepoRoot: string;
  activeWorktreePaths: string[];
}): Promise<void> {
  const targetRepoRoot = resolvePath(input.targetRepoRoot);
  if (!(await isManagedWorktreeRepository(targetRepoRoot))) {
    return;
  }

  await doctorRepository(targetRepoRoot, { fix: true, deep: true });
  const activePaths = new Set(
    input.activeWorktreePaths.map((worktreePath) => resolvePath(worktreePath))
  );
  const items = await listWorktrees(targetRepoRoot, { kind: 'task' });
  for (const item of items) {
    const candidatePath = resolvePath(item.path);
    if (activePaths.has(candidatePath)) {
      continue;
    }
    const marker = await loadMarker(candidatePath).catch(() => null);
    if (!marker || marker.kind !== 'task' || marker.createdBy !== 'manager') {
      continue;
    }
    await dropTaskWorktree(candidatePath, {
      force: true,
      deleteBranch: true,
      forceBranchDelete: true,
    }).catch(() => {});
  }
}
