import { resolve as resolvePath } from 'node:path';
import { rm } from 'node:fs/promises';
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
  onboardingCommit: string | null;
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
const MWT_CONFIG_PATH = '.mwt/config.toml';
const MWT_MARKER_PATH = '.mwt-worktree.json';
const AUTO_INIT_COMMIT_MESSAGE = 'chore: initialize managed-worktree-system';

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

function summarizeGitFailure(
  label: string,
  result: { stdout: string; stderr: string; code: number | null }
): string {
  const detail =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `${label} exited with code ${result.code ?? '?'}.`;
  return `${label} failed: ${detail}`;
}

function parseStatusPath(line: string): string {
  const raw = line.slice(3).trim();
  if (raw.includes(' -> ')) {
    return raw.split(' -> ').at(-1)?.trim() ?? raw;
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1);
  }
  return raw;
}

async function rollbackManagerAutoInit(targetRepoRoot: string): Promise<void> {
  await execGit(targetRepoRoot, ['reset', '--', MWT_CONFIG_PATH]).catch(
    () => {}
  );
  await rm(resolvePath(targetRepoRoot, '.mwt'), {
    recursive: true,
    force: true,
  }).catch(() => {});
  await rm(resolvePath(targetRepoRoot, MWT_MARKER_PATH), {
    force: true,
  }).catch(() => {});
}

async function commitAutoInitializedRepositoryPolicy(
  targetRepoRoot: string
): Promise<{
  commit: string;
  changedFiles: string[];
}> {
  const statusResult = await execGit(targetRepoRoot, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (statusResult.code !== 0) {
    throw new Error(
      summarizeGitFailure(
        'git status --porcelain --untracked-files=all',
        statusResult
      )
    );
  }

  const changedFiles = statusResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parseStatusPath);
  const uniqueChangedFiles = Array.from(new Set(changedFiles));

  if (
    uniqueChangedFiles.length !== 1 ||
    uniqueChangedFiles[0] !== MWT_CONFIG_PATH
  ) {
    const detail = uniqueChangedFiles.length
      ? uniqueChangedFiles.join(', ')
      : '(none)';
    throw new Error(
      `Automatic mwt onboarding commit expected only ${MWT_CONFIG_PATH}, but found: ${detail}`
    );
  }

  const addResult = await execGit(targetRepoRoot, [
    'add',
    '--',
    MWT_CONFIG_PATH,
  ]);
  if (addResult.code !== 0) {
    throw new Error(
      summarizeGitFailure(`git add -- ${MWT_CONFIG_PATH}`, addResult)
    );
  }

  const commitResult = await execGit(targetRepoRoot, [
    'commit',
    '-m',
    AUTO_INIT_COMMIT_MESSAGE,
  ]);
  if (commitResult.code !== 0) {
    throw new Error(
      summarizeGitFailure(
        `git commit -m "${AUTO_INIT_COMMIT_MESSAGE}"`,
        commitResult
      )
    );
  }

  const headResult = await execGit(targetRepoRoot, ['rev-parse', 'HEAD']);
  if (headResult.code !== 0 || !headResult.stdout.trim()) {
    throw new Error(summarizeGitFailure('git rev-parse HEAD', headResult));
  }

  return {
    commit: headResult.stdout.trim(),
    changedFiles: uniqueChangedFiles,
  };
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
      onboardingCommit: null,
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
      onboardingCommit: null,
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
      onboardingCommit: null,
    };
  }

  try {
    await initializeRepository(targetRepoRoot, {
      base: defaultBranch,
      remote: remoteName,
    });

    const onboarding =
      await commitAutoInitializedRepositoryPolicy(targetRepoRoot);
    return {
      initialized: true,
      reasonId: null,
      detail:
        `managed-worktree-system を自動初期化し、${MWT_CONFIG_PATH} を onboarding commit として記録しました ` +
        `(base: ${defaultBranch}, remote: ${remoteName}, commit: ${onboarding.commit.slice(0, 8)})。`,
      defaultBranch,
      remoteName,
      changedFiles: onboarding.changedFiles,
      onboardingCommit: onboarding.commit,
    };
  } catch (error) {
    await rollbackManagerAutoInit(targetRepoRoot).catch(() => {});
    return {
      initialized: false,
      reasonId: 'auto_init_commit_failed',
      detail:
        `managed-worktree-system の自動初期化後に ${MWT_CONFIG_PATH} の onboarding commit を作れませんでした。\n\n` +
        (error instanceof Error ? error.message : String(error)),
      defaultBranch,
      remoteName,
      changedFiles: [MWT_CONFIG_PATH],
      onboardingCommit: null,
    };
  }
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
