import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
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
import { execGit, releaseTaskOwnedWslTmuxLocks } from './manager-worktree.js';

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

export function isMwtDeliverRemoteAdvanceError(error: unknown): boolean {
  const detail = looksLikeMwtError(error)
    ? [
        typeof error.message === 'string' ? error.message : '',
        typeof (error.details as { stderr?: unknown } | undefined)?.stderr ===
        'string'
          ? ((error.details as { stderr?: string }).stderr ?? '')
          : '',
        typeof (error.details as { stdout?: unknown } | undefined)?.stdout ===
        'string'
          ? ((error.details as { stdout?: string }).stdout ?? '')
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);

  return (
    /non-fast-forward/i.test(detail) ||
    /failed to push some refs/i.test(detail) ||
    /\[rejected\]/i.test(detail) ||
    /fetch first/i.test(detail) ||
    /pushed branch tip is behind/i.test(detail)
  );
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

export function isMwtDropCwdHoldersError(error: unknown): boolean {
  return looksLikeMwtError(error) && error.id === 'drop_cwd_holders';
}

function mwtErrorId(error: unknown): string | null {
  return looksLikeMwtError(error) && typeof error.id === 'string'
    ? error.id
    : null;
}

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const MWT_OUTPUT_PREVIEW_LIMIT = 4_000;
const DROP_CWD_RELEASE_RETRY_WAIT_MS = 1_000;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const MWT_CONFIG_PATH = '.mwt/config.toml';
const MWT_MARKER_PATH = '.mwt-worktree.json';
const AUTO_INIT_COMMIT_MESSAGE = 'chore: initialize managed-worktree-system';
const SAFE_BOOTSTRAP_TRACKED_PATHS = new Set(['.gitignore']);

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

function formatMwtStructuredDetailItem(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = normalizeMwtOutput(value);
    return normalized ? `- ${normalized}` : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const detail = value as Record<string, unknown>;
  const prefix =
    typeof detail.step === 'string' && detail.step.trim()
      ? detail.step.trim()
      : typeof detail.id === 'string' && detail.id.trim()
        ? detail.id.trim()
        : null;
  const body =
    typeof detail.message === 'string' && detail.message.trim()
      ? normalizeMwtOutput(detail.message)
      : typeof detail.description === 'string' && detail.description.trim()
        ? normalizeMwtOutput(detail.description)
        : null;
  const qualifiers = [
    typeof detail.branch === 'string' && detail.branch.trim()
      ? `branch: ${detail.branch.trim()}`
      : null,
    typeof detail.path === 'string' && detail.path.trim()
      ? `path: ${detail.path.trim()}`
      : null,
    typeof detail.taskPath === 'string' && detail.taskPath.trim()
      ? `taskPath: ${detail.taskPath.trim()}`
      : null,
    typeof detail.worktreeId === 'string' && detail.worktreeId.trim()
      ? `worktreeId: ${detail.worktreeId.trim()}`
      : null,
    typeof detail.scope === 'string' && detail.scope.trim()
      ? `scope: ${detail.scope.trim()}`
      : null,
  ].filter((part): part is string => Boolean(part));

  const main =
    prefix && body && body !== prefix
      ? `${prefix}: ${body}`
      : body || prefix || null;
  if (!main) {
    return null;
  }

  return qualifiers.length > 0
    ? `- ${main} (${qualifiers.join(', ')})`
    : `- ${main}`;
}

function formatMwtHoldersSection(holders: unknown): string | null {
  if (!Array.isArray(holders) || holders.length === 0) {
    return null;
  }
  const lines = holders
    .map((h) => {
      if (!h || typeof h !== 'object') return null;
      const holder = h as { pid?: unknown; name?: unknown; cwd?: unknown };
      const pid =
        typeof holder.pid === 'number' || typeof holder.pid === 'string'
          ? String(holder.pid)
          : '?';
      const name =
        typeof holder.name === 'string' && holder.name.trim()
          ? holder.name.trim()
          : 'unknown';
      const cwd =
        typeof holder.cwd === 'string' && holder.cwd.trim()
          ? holder.cwd.trim()
          : '';
      return cwd ? `- PID ${pid} (${name}): ${cwd}` : `- PID ${pid} (${name})`;
    })
    .filter((l): l is string => Boolean(l));
  if (lines.length === 0) return null;
  return `CWD holders:\n${lines.join('\n')}`;
}

function formatMwtStructuredDetailSection(
  label: string,
  value: unknown
): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const lines = value
    .map((entry) => formatMwtStructuredDetailItem(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (lines.length === 0) {
    return null;
  }

  return `${label}:\n${lines.join('\n')}`;
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
  const appliedActionsSection =
    error.details && typeof error.details === 'object'
      ? formatMwtStructuredDetailSection(
          'applied fixes',
          (error.details as { appliedActions?: unknown }).appliedActions
        )
      : null;
  const completedStepsSection =
    error.details && typeof error.details === 'object'
      ? formatMwtStructuredDetailSection(
          'completed cleanup steps',
          (error.details as { completedSteps?: unknown }).completedSteps
        )
      : null;
  const failuresSection =
    error.details && typeof error.details === 'object'
      ? formatMwtStructuredDetailSection(
          'remaining cleanup failures',
          (error.details as { failures?: unknown }).failures
        )
      : null;
  const holdersSection =
    error.details && typeof error.details === 'object'
      ? formatMwtHoldersSection(
          (error.details as { holders?: unknown }).holders
        )
      : null;
  const distinctStdoutSection =
    stdoutSection && stdoutSection !== stderrSection ? stdoutSection : null;

  return [
    message,
    holdersSection,
    appliedActionsSection,
    completedStepsSection,
    failuresSection,
    recovery || null,
    stderrSection,
    distinctStdoutSection,
  ]
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

function normalizeRepoRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').trim();
}

async function hasOnlySafeBootstrapGitignoreDiff(
  targetRepoRoot: string
): Promise<boolean> {
  const diffResult = await execGit(targetRepoRoot, [
    'diff',
    '--',
    '.gitignore',
  ]);
  if (diffResult.code !== 0) {
    return false;
  }

  const relevantLines = diffResult.stdout
    .split(/\r?\n/)
    .filter(
      (line) =>
        line &&
        !line.startsWith('diff --git') &&
        !line.startsWith('index ') &&
        !line.startsWith('--- ') &&
        !line.startsWith('+++ ') &&
        !line.startsWith('@@')
    );

  return relevantLines.every((line) => {
    if (line.startsWith('+')) {
      return line.slice(1).trim() === '.threads.jsonl';
    }
    return !line.startsWith('-');
  });
}

async function shouldForceBootstrapManagedAutoInit(input: {
  targetRepoRoot: string;
  changedFiles: string[];
}): Promise<boolean> {
  if (input.changedFiles.length === 0) {
    return false;
  }

  const normalizedFiles = input.changedFiles.map(normalizeRepoRelativePath);
  if (
    !normalizedFiles.every((file) => SAFE_BOOTSTRAP_TRACKED_PATHS.has(file))
  ) {
    return false;
  }

  return hasOnlySafeBootstrapGitignoreDiff(input.targetRepoRoot);
}

async function commitAutoInitializedRepositoryPolicy(
  targetRepoRoot: string,
  additionalPaths: readonly string[] = []
): Promise<{
  commit: string;
  changedFiles: string[];
}> {
  const onboardingPaths = [
    MWT_CONFIG_PATH,
    ...additionalPaths.filter((relativePath) =>
      existsSync(resolvePath(targetRepoRoot, relativePath))
    ),
  ];
  const addResult = await execGit(targetRepoRoot, [
    'add',
    '-f',
    '--',
    ...onboardingPaths,
  ]);
  if (addResult.code !== 0) {
    throw new Error(
      summarizeGitFailure(
        `git add -f -- ${onboardingPaths.join(' ')}`,
        addResult
      )
    );
  }

  const stagedResult = await execGit(targetRepoRoot, [
    'diff',
    '--cached',
    '--name-only',
  ]);
  if (stagedResult.code !== 0) {
    throw new Error(
      summarizeGitFailure('git diff --cached --name-only', stagedResult)
    );
  }

  const stagedFiles = stagedResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.trim());
  const uniqueChangedFiles = Array.from(new Set(stagedFiles));

  const allowedChangedFiles = new Set(
    onboardingPaths.map(normalizeRepoRelativePath)
  );
  const unexpectedChangedFiles = uniqueChangedFiles.filter(
    (file) => !allowedChangedFiles.has(normalizeRepoRelativePath(file))
  );

  if (unexpectedChangedFiles.length > 0 || uniqueChangedFiles.length === 0) {
    const detail = uniqueChangedFiles.length
      ? uniqueChangedFiles.join(', ')
      : '(none)';
    throw new Error(
      `Automatic mwt onboarding commit expected only bootstrap-managed files, but found: ${detail}`
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
  bootstrapManagedFiles?: readonly string[];
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
    if (
      mwtErrorId(error) === 'init_requires_clean_repo' &&
      Array.isArray(input.bootstrapManagedFiles) &&
      input.bootstrapManagedFiles.length > 0 &&
      (await shouldForceBootstrapManagedAutoInit({
        targetRepoRoot,
        changedFiles: listMwtChangedFiles(error),
      }))
    ) {
      try {
        await initializeRepository(targetRepoRoot, {
          base: defaultBranch,
          remote: remoteName,
          force: true,
        });

        const onboarding = await commitAutoInitializedRepositoryPolicy(
          targetRepoRoot,
          input.bootstrapManagedFiles
        );
        return {
          initialized: true,
          reasonId: null,
          detail:
            'high-quality bootstrap が加えた repo policy files を onboarding commit に含めつつ、managed-worktree-system を自動初期化しました ' +
            `(base: ${defaultBranch}, remote: ${remoteName}, commit: ${onboarding.commit.slice(0, 8)})。`,
          defaultBranch,
          remoteName,
          changedFiles: onboarding.changedFiles,
          onboardingCommit: onboarding.commit,
        };
      } catch (forcedError) {
        await rollbackManagerAutoInit(targetRepoRoot).catch(() => {});
        return {
          initialized: false,
          reasonId: 'auto_init_commit_failed',
          detail:
            'managed-worktree-system の自動初期化後に bootstrap 管理ファイルを含む onboarding commit を作れませんでした。\n\n' +
            (forcedError instanceof Error
              ? forcedError.message
              : String(forcedError)),
          defaultBranch,
          remoteName,
          changedFiles: [MWT_CONFIG_PATH],
          onboardingCommit: null,
        };
      }
    }

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

  await releaseTaskOwnedWslTmuxLocks(worktreePath).catch(() => {});
  try {
    await dropTaskWorktree(worktreePath, {
      force: true,
      deleteBranch: true,
      forceBranchDelete: true,
    });
  } catch (error) {
    if (!isMwtDropCwdHoldersError(error)) {
      throw error;
    }
    // WSL session processes may still hold the CWD briefly after tmux kill-server.
    // Release locks once more and wait before a single retry.
    await releaseTaskOwnedWslTmuxLocks(worktreePath).catch(() => {});
    await waitMs(DROP_CWD_RELEASE_RETRY_WAIT_MS);
    await dropTaskWorktree(worktreePath, {
      force: true,
      deleteBranch: true,
      forceBranchDelete: true,
    });
  }
  return true;
}

function isMatchingStaleRegistryIssue(
  issue: Record<string, unknown>,
  input: {
    worktreePath: string;
    branchName?: string | null;
  }
): boolean {
  if (issue.id !== 'stale_registry_entry') {
    return false;
  }

  const details =
    issue.details && typeof issue.details === 'object'
      ? (issue.details as { path?: unknown; branch?: unknown })
      : null;
  const issuePath =
    typeof details?.path === 'string' ? resolvePath(details.path) : null;
  const issueBranch =
    typeof details?.branch === 'string' ? details.branch.trim() : null;
  const targetPath = resolvePath(input.worktreePath);
  const targetBranch = input.branchName?.trim() || null;

  return (
    issuePath === targetPath ||
    (targetBranch !== null && issueBranch === targetBranch)
  );
}

export async function repairManagerWorktreeResidue(input: {
  targetRepoRoot: string;
  worktreePath: string;
  branchName?: string | null;
}): Promise<string | null> {
  const targetRepoRoot = resolvePath(input.targetRepoRoot);
  if (!(await isManagedWorktreeRepository(targetRepoRoot))) {
    return null;
  }

  let repairError: unknown = null;
  try {
    await doctorRepository(targetRepoRoot, {
      fix: true,
      deep: true,
    });
  } catch (error) {
    repairError = error;
  }

  let assessment: { issues?: Array<Record<string, unknown>> } | null = null;
  try {
    assessment = await doctorRepository(targetRepoRoot, {
      deep: true,
    });
  } catch (error) {
    return describeMwtError(repairError ?? error);
  }

  const targetedResidueRemaining =
    assessment?.issues?.some((issue) =>
      isMatchingStaleRegistryIssue(issue, input)
    ) ?? false;
  if (!targetedResidueRemaining) {
    return null;
  }

  const targetLabel = input.branchName?.trim()
    ? `${resolvePath(input.worktreePath)} (${input.branchName.trim()})`
    : resolvePath(input.worktreePath);
  const residueDetail = `Targeted manager-owned mwt residue still remains after repair: ${targetLabel}`;
  return repairError
    ? `${describeMwtError(repairError)}\n\n${residueDetail}`
    : residueDetail;
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
  const livePaths = new Set(items.map((item) => resolvePath(item.path)));
  await cleanupOrphanedEmptyManagerSiblingDirs({
    targetRepoRoot,
    activePaths,
    livePaths,
  });
  for (const item of items) {
    const candidatePath = resolvePath(item.path);
    if (activePaths.has(candidatePath)) {
      continue;
    }
    const marker = await loadMarker(candidatePath).catch(() => null);
    if (!marker || marker.kind !== 'task' || marker.createdBy !== 'manager') {
      continue;
    }
    await releaseTaskOwnedWslTmuxLocks(candidatePath).catch(() => {});
    await dropTaskWorktree(candidatePath, {
      force: true,
      deleteBranch: true,
      forceBranchDelete: true,
    }).catch(() => {});
  }
}

async function cleanupOrphanedEmptyManagerSiblingDirs(input: {
  targetRepoRoot: string;
  activePaths: Set<string>;
  livePaths: Set<string>;
}): Promise<void> {
  const parentDir = dirname(input.targetRepoRoot);
  const prefix = `${basename(input.targetRepoRoot)}-mgr-`;
  const entries = await readdir(parentDir, { withFileTypes: true }).catch(
    () => []
  );

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }

    const candidatePath = resolvePath(join(parentDir, entry.name));
    if (
      candidatePath === input.targetRepoRoot ||
      input.activePaths.has(candidatePath) ||
      input.livePaths.has(candidatePath)
    ) {
      continue;
    }

    const childEntries = await readdir(candidatePath, {
      withFileTypes: true,
    }).catch(() => null);
    if (!childEntries || childEntries.length > 0) {
      continue;
    }

    await rm(candidatePath, {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
}
