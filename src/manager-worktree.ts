/**
 * Git worktree lifecycle management for worker isolation.
 *
 * Every worker agent runs in an isolated git worktree created from the
 * latest tracked base branch when available (falling back to the current
 * HEAD only when the checkout has no tracked base). After the worker (and
 * the Manager review step) finishes, the worktree branch is merged back by
 * the Manager backend. This module owns: create, merge,
 * conflict-resolution, push, canonical-checkout sync, remove, and
 * orphan-cleanup operations.
 */

import { spawn } from 'child_process';
import { existsSync, readdirSync, type Dirent } from 'fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm as rmAsync,
  unlink,
  writeFile,
} from 'fs/promises';
import { dirname, join, relative, resolve as resolvePath, sep } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  targetRepoRoot: string;
}

export interface IntegrationWorktreeInfo extends WorktreeInfo {
  remoteName: string;
  remoteBranch: string;
}

export interface MergeResult {
  success: boolean;
  conflicted: boolean;
  conflictFiles: string[];
  detail: string;
}

export interface WorktreeDeliveryReadiness {
  ready: boolean;
  detail: string;
  aheadCommitCount: number;
  mergeSourceRef: string | null;
}

export interface PostMergeDeliveryResult {
  success: boolean;
  detail: string;
  performed: string[];
}

export interface CanonicalCheckoutSyncResult {
  success: boolean;
  synced: boolean;
  skipped: boolean;
  reason:
    | 'synced'
    | 'dirty'
    | 'detached-head'
    | 'branch-mismatch'
    | 'git-operation-in-progress'
    | 'not-fast-forwardable'
    | 'status-failed'
    | 'branch-check-failed'
    | 'fetch-failed'
    | 'remote-ref-missing'
    | 'merge-failed';
  detail: string;
}

// ---------------------------------------------------------------------------
// Module-level merge lock  (serialises merges per repository)
// ---------------------------------------------------------------------------

const _mergeLocks = new Map<string, Promise<void>>();
const GIT_CONTEXT_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_SUPER_PREFIX',
  'GIT_WORK_TREE',
] as const;

async function withMergeLock<T>(
  targetRepoRoot: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = resolvePath(targetRepoRoot);
  const previous = _mergeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  _mergeLocks.set(key, gate);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (_mergeLocks.get(key) === gate) {
      _mergeLocks.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

function createSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of GIT_CONTEXT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

export function execGit(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: createSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: options?.timeoutMs ?? 120_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code });
    });
  });
}

function resolveExternalCommand(command: 'npm' | 'npx' | 'gh'): string {
  if (process.platform !== 'win32') {
    return command;
  }
  if (command === 'npm' || command === 'npx') {
    return `${command}.cmd`;
  }
  return command;
}

async function execCommand(
  cwd: string,
  command: 'npm' | 'npx' | 'gh',
  args: string[],
  options?: { timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveExternalCommand(command), args, {
      cwd,
      env: createSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: options?.timeoutMs ?? 300_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code });
    });
  });
}

async function execWsl(
  args: string[],
  options?: { timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('wsl.exe', args, {
      env: createSpawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: options?.timeoutMs ?? 30_000,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code });
    });
  });
}

function summarizeCommandFailure(
  label: string,
  result: { stdout: string; stderr: string; code: number | null }
): string {
  const detail =
    result.stderr ||
    result.stdout ||
    `${label} exited with code ${result.code ?? '?'}.`;
  return `${label} failed: ${detail}`;
}

function toBashSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function isPathWithinWslWorktree(
  panePath: string,
  worktreePath: string
): boolean {
  return panePath === worktreePath || panePath.startsWith(`${worktreePath}/`);
}

async function releaseTaskOwnedWslTmuxLocks(
  worktreePath: string
): Promise<void> {
  if (process.platform !== 'win32' || !existsSync(worktreePath)) {
    return;
  }

  const distro = process.env.WORKSPACE_AGENT_HUB_WSL_DISTRO?.trim() || 'Ubuntu';
  const wslPathResult = await execWsl(
    [
      '-d',
      distro,
      '--',
      'wslpath',
      '-a',
      '-u',
      worktreePath.replace(/\\/g, '/'),
    ],
    { timeoutMs: 15_000 }
  ).catch(() => null);
  const targetWslPath = wslPathResult?.stdout.trim();
  if (!targetWslPath || wslPathResult?.code !== 0) {
    return;
  }

  const socketListResult = await execWsl(
    [
      '-d',
      distro,
      '--',
      'bash',
      '-lc',
      "find /tmp -maxdepth 2 -type s -path '/tmp/tmux-*/*' -printf '%f\\n' 2>/dev/null || true",
    ],
    { timeoutMs: 15_000 }
  ).catch(() => null);
  if (!socketListResult || socketListResult.code !== 0) {
    return;
  }

  const socketNames = [
    ...new Set(
      socketListResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(
          (line) => line.length > 0 && line.startsWith('workspace-agent-hub-')
        )
    ),
  ];

  for (const socketName of socketNames) {
    const paneListResult = await execWsl(
      [
        '-d',
        distro,
        '--',
        'bash',
        '-lc',
        `tmux -L ${toBashSingleQuotedLiteral(socketName)} list-panes -a -F '#{pane_current_path}' 2>/dev/null || true`,
      ],
      { timeoutMs: 15_000 }
    ).catch(() => null);
    if (!paneListResult || paneListResult.code !== 0) {
      continue;
    }

    const holdsWorktree = paneListResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .some((panePath) => isPathWithinWslWorktree(panePath, targetWslPath));
    if (!holdsWorktree) {
      continue;
    }

    await execWsl(
      ['-d', distro, '--', 'tmux', '-L', socketName, 'kill-server'],
      { timeoutMs: 15_000 }
    ).catch(() => {});
    await wait(WORKTREE_DIRECTORY_CLEANUP_RETRY_MS);
  }
}

function normalizeGitHubRepoSlug(
  raw: string | null | undefined
): string | null {
  if (!raw) {
    return null;
  }
  const value = raw.trim().replace(/^git\+/, '');
  if (!value) {
    return null;
  }

  const httpsMatch = value.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/)?$/i
  );
  if (httpsMatch) {
    return httpsMatch[1] ?? null;
  }

  const sshMatch = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return sshMatch[1] ?? null;
  }

  return null;
}

function parseRemoteBranchSpec(
  raw: string | null | undefined
): { remoteName: string; remoteBranch: string } | null {
  if (!raw) {
    return null;
  }
  const normalized = raw
    .trim()
    .replace(/^refs\/remotes\//, '')
    .replace(/^remotes\//, '');
  if (!normalized) {
    return null;
  }

  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    return null;
  }

  return {
    remoteName: normalized.slice(0, slashIndex),
    remoteBranch: normalized.slice(slashIndex + 1),
  };
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  const result = await execGit(cwd, ['rev-parse', '--verify', ref]).catch(
    () => null
  );
  return result?.code === 0;
}

async function resolveGitPath(
  cwd: string,
  gitPath: string
): Promise<string | null> {
  const result = await execGit(cwd, ['rev-parse', '--git-path', gitPath]).catch(
    () => null
  );
  if (result?.code !== 0 || !result.stdout.trim()) {
    return null;
  }
  return resolvePath(cwd, result.stdout.trim());
}

async function hasGitOperationInProgress(cwd: string): Promise<boolean> {
  const sentinelPaths = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-apply',
    'rebase-merge',
  ];
  for (const sentinelPath of sentinelPaths) {
    const resolvedPath = await resolveGitPath(cwd, sentinelPath);
    if (resolvedPath && existsSync(resolvedPath)) {
      return true;
    }
  }
  return false;
}

interface PublishablePackageInfo {
  name: string;
  version: string;
  repoSlug: string | null;
  binCommand: string | null;
}

async function readPublishablePackageInfo(
  targetRepoRoot: string
): Promise<PublishablePackageInfo | null> {
  const packageJsonPath = join(targetRepoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  if (parsed.private === true) {
    return null;
  }

  const name =
    typeof parsed.name === 'string' && parsed.name.trim()
      ? parsed.name.trim()
      : null;
  const version =
    typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  if (!name || !version) {
    return null;
  }

  const repositoryField = parsed.repository;
  const repositoryUrl =
    typeof repositoryField === 'string'
      ? repositoryField
      : repositoryField &&
          typeof repositoryField === 'object' &&
          typeof (repositoryField as { url?: unknown }).url === 'string'
        ? ((repositoryField as { url: string }).url ?? null)
        : null;

  const remoteResult = await execGit(targetRepoRoot, [
    'remote',
    'get-url',
    'origin',
  ]).catch(() => null);
  const repoSlug =
    normalizeGitHubRepoSlug(
      remoteResult?.code === 0 ? remoteResult.stdout : repositoryUrl
    ) ?? normalizeGitHubRepoSlug(repositoryUrl);

  const binField = parsed.bin;
  const binCommand =
    typeof binField === 'string'
      ? (name.split('/').pop() ?? null)
      : binField && typeof binField === 'object'
        ? (Object.keys(binField).find((key) => key.trim().length > 0) ?? null)
        : null;

  return {
    name,
    version,
    repoSlug,
    binCommand,
  };
}

function isUserOwnedPublishablePackage(
  pkg: PublishablePackageInfo | null
): pkg is PublishablePackageInfo {
  if (!pkg) {
    return false;
  }
  return (
    pkg.name.startsWith('@metyatech/') ||
    (pkg.repoSlug !== null && pkg.repoSlug.startsWith('metyatech/'))
  );
}

// ---------------------------------------------------------------------------
// resolveTargetRepoRoot
// ---------------------------------------------------------------------------

/** Walk up the directory tree looking for a `.git` entry. */
export function findGitRoot(startDir: string): string | null {
  let current = resolvePath(startDir);
  for (;;) {
    if (existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Determine which git repository a set of write-scopes targets.
 *
 * - Empty / universal (`*`) → `resolvedDir`.
 * - All scopes within the same repo → that repo root.
 * - Mixed repos → `resolvedDir` (fallback).
 */
export function resolveTargetRepoRoot(
  resolvedDir: string,
  writeScopes: string[]
): string {
  if (writeScopes.length === 0 || writeScopes.includes('*')) {
    return resolvedDir;
  }

  const roots = new Set<string>();
  for (const scope of writeScopes) {
    const abs = resolvePath(resolvedDir, scope);
    // The scope may point at a file that doesn't exist yet, so walk
    // from its parent directory.
    const dir = existsSync(abs) ? abs : dirname(abs);
    const root = findGitRoot(dir);
    if (root) {
      roots.add(root);
    }
  }

  if (roots.size === 1) {
    return Array.from(roots)[0]!;
  }

  // Zero matches or mixed → default to the workspace root.
  return resolvedDir;
}

export async function prepareNewRepoWorkspace(input: {
  workspaceRoot: string;
  targetRepoRoot: string;
}): Promise<void> {
  const workspaceRoot = resolvePath(input.workspaceRoot);
  const targetRepoRoot = resolvePath(input.targetRepoRoot);
  const relativeTarget = targetRepoRoot
    .slice(workspaceRoot.length)
    .replace(/^[\\/]+/, '');
  if (
    targetRepoRoot.toLowerCase() === workspaceRoot.toLowerCase() ||
    !relativeTarget ||
    targetRepoRoot
      .toLowerCase()
      .startsWith(`${workspaceRoot.toLowerCase()}\\`) === false
  ) {
    throw new Error(
      `new repo target must stay under the workspace root (${workspaceRoot})`
    );
  }

  const existingRoot = findGitRoot(targetRepoRoot);
  if (existingRoot && resolvePath(existingRoot) === targetRepoRoot) {
    throw new Error(`new repo target already exists as a git repository`);
  }

  if (existsSync(targetRepoRoot)) {
    const entries = await readdir(targetRepoRoot);
    if (entries.length > 0) {
      throw new Error(`new repo target already exists and is not empty`);
    }
    return;
  }

  await mkdir(targetRepoRoot, { recursive: true });
}

// ---------------------------------------------------------------------------
// Shared isolated-worktree helpers
// ---------------------------------------------------------------------------

const ROOT_LOCAL_ENV_OVERLAY_PATTERN = /^\.env(?:\..+)?\.local$/;
const GIT_WORKTREE_CONTROL_NAMES = new Set(['.git']);

async function copyRootLocalEnvOverlays(
  targetRepoRoot: string,
  worktreePath: string
): Promise<void> {
  const repoRootEntries = await readdir(targetRepoRoot, {
    withFileTypes: true,
  });
  for (const entry of repoRootEntries) {
    if (!ROOT_LOCAL_ENV_OVERLAY_PATTERN.test(entry.name)) {
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    const sourcePath = join(targetRepoRoot, entry.name);
    const targetPath = join(worktreePath, entry.name);
    await copyFile(sourcePath, targetPath);
  }
}

function normalizePathForComparison(pathValue: string): string {
  const resolvedPath = resolvePath(pathValue).replace(/^\\\\\?\\/, '');
  return process.platform === 'win32'
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const normalizedRootPath = normalizePathForComparison(rootPath);
  const normalizedCandidatePath = normalizePathForComparison(candidatePath);
  if (normalizedCandidatePath === normalizedRootPath) {
    return true;
  }
  const rootPathWithSep = normalizedRootPath.endsWith(sep)
    ? normalizedRootPath
    : `${normalizedRootPath}${sep}`;
  return normalizedCandidatePath.startsWith(rootPathWithSep);
}

async function isTrackedWorktreePath(
  worktreePath: string,
  targetPath: string
): Promise<boolean> {
  const relativeTargetPath = relative(worktreePath, targetPath).replace(
    /\\/g,
    '/'
  );
  if (!relativeTargetPath || relativeTargetPath.startsWith('../')) {
    return false;
  }
  const result = await execGit(worktreePath, [
    'ls-files',
    '--error-unmatch',
    '--',
    relativeTargetPath,
  ]).catch(() => null);
  return result?.code === 0;
}

async function removeSymbolicLinkPath(targetPath: string): Promise<void> {
  try {
    await unlink(targetPath);
    return;
  } catch {
    // Fall back to rm for directory junctions if unlink is not accepted.
  }

  await rmAsync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 0,
  });
}

async function materializePathFromSource(
  sourcePath: string,
  targetPath: string,
  activeRealPaths = new Set<string>()
): Promise<void> {
  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isSymbolicLink()) {
    const resolvedSourcePath = await realpath(sourcePath);
    await materializePathFromSource(
      resolvedSourcePath,
      targetPath,
      activeRealPaths
    );
    return;
  }

  if (sourceStats.isDirectory()) {
    const normalizedSourcePath = normalizePathForComparison(sourcePath);
    if (activeRealPaths.has(normalizedSourcePath)) {
      throw new Error(
        `External worktree link materialization hit a cycle at ${sourcePath}`
      );
    }
    activeRealPaths.add(normalizedSourcePath);
    try {
      await mkdir(targetPath, { recursive: true });
      const entries = await readdir(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        if (GIT_WORKTREE_CONTROL_NAMES.has(entry.name)) {
          continue;
        }
        await materializePathFromSource(
          join(sourcePath, entry.name),
          join(targetPath, entry.name),
          activeRealPaths
        );
      }
    } finally {
      activeRealPaths.delete(normalizedSourcePath);
    }
    return;
  }

  if (sourceStats.isFile()) {
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    return;
  }

  throw new Error(
    `Unsupported external worktree link target type at ${sourcePath}`
  );
}

async function normalizeExternalLinkPath(input: {
  worktreePath: string;
  worktreeRealPath: string;
  linkPath: string;
}): Promise<void> {
  const { worktreePath, worktreeRealPath, linkPath } = input;
  const resolvedTargetPath = await realpath(linkPath).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to resolve worktree symlink/junction target for ${linkPath}: ${detail}`
    );
  });
  if (isPathInsideRoot(worktreeRealPath, resolvedTargetPath)) {
    return;
  }

  const relativeLinkPath = relative(worktreePath, linkPath).replace(/\\/g, '/');
  if (await isTrackedWorktreePath(worktreePath, linkPath)) {
    throw new Error(
      `Tracked symlink/junction points outside the worktree: ${relativeLinkPath} -> ${resolvedTargetPath}`
    );
  }

  await removeSymbolicLinkPath(linkPath);
  await materializePathFromSource(resolvedTargetPath, linkPath);
}

async function normalizeExternalWorktreeLinks(input: {
  worktreePath: string;
  directoryPath?: string;
  worktreeRealPath?: string;
}): Promise<void> {
  const { worktreePath } = input;
  const directoryPath = input.directoryPath ?? worktreePath;
  const worktreeRealPath =
    input.worktreeRealPath ??
    (await realpath(worktreePath).catch(() => resolvePath(worktreePath)));
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (GIT_WORKTREE_CONTROL_NAMES.has(entry.name)) {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);
    const entryStats = await lstat(entryPath);
    if (entryStats.isSymbolicLink()) {
      await normalizeExternalLinkPath({
        worktreePath,
        worktreeRealPath,
        linkPath: entryPath,
      });
      const materializedEntryStats = await lstat(entryPath).catch(() => null);
      if (materializedEntryStats?.isDirectory()) {
        await normalizeExternalWorktreeLinks({
          worktreePath,
          directoryPath: entryPath,
          worktreeRealPath,
        });
      }
      continue;
    }

    if (entryStats.isDirectory()) {
      await normalizeExternalWorktreeLinks({
        worktreePath,
        directoryPath: entryPath,
        worktreeRealPath,
      });
    }
  }
}

async function bootstrapIsolatedWorktree(
  targetRepoRoot: string,
  worktreePath: string
): Promise<void> {
  const syncResult = await execGit(worktreePath, [
    'submodule',
    'sync',
    '--recursive',
  ]);
  if (syncResult.code !== 0) {
    throw new Error(
      summarizeCommandFailure('git submodule sync --recursive', syncResult)
    );
  }

  const updateResult = await execGit(worktreePath, [
    'submodule',
    'update',
    '--init',
    '--recursive',
  ]);
  if (updateResult.code !== 0) {
    throw new Error(
      summarizeCommandFailure(
        'git submodule update --init --recursive',
        updateResult
      )
    );
  }

  await copyRootLocalEnvOverlays(targetRepoRoot, worktreePath);
  await normalizeExternalWorktreeLinks({ worktreePath });
}

function allocateWorktreePath(
  targetRepoRoot: string,
  baseName: string
): string {
  const basePath = join(dirname(resolvePath(targetRepoRoot)), baseName);
  if (!existsSync(basePath)) {
    return basePath;
  }

  const nonce = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
  for (let attempt = 1; attempt <= 64; attempt++) {
    const candidate = `${basePath}-${nonce}-${attempt.toString(36)}`;
    if (!existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not allocate a unique worktree path for ${basePath}; too many stale temp directories remain.`
  );
}

function describeBlockingWorktreePath(worktreePath: string): string {
  if (!existsSync(worktreePath)) {
    return `${worktreePath} no longer exists`;
  }

  const entries = readdirSync(worktreePath, { withFileTypes: true })
    .slice(0, 8)
    .map((entry) => entry.name);
  const suffix =
    entries.length > 0
      ? ` Directory still contains: ${entries.join(', ')}${entries.length === 8 ? ', ...' : ''}.`
      : ' Directory is still present but empty.';
  return `${worktreePath} still exists after cleanup.${suffix}`;
}

const WORKTREE_DIRECTORY_CLEANUP_ATTEMPTS = 5;
const WORKTREE_DIRECTORY_CLEANUP_RETRY_MS = 200;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeWorktreeDirectory(
  worktreePath: string
): Promise<string | null> {
  if (!existsSync(worktreePath)) {
    return null;
  }

  for (
    let attempt = 0;
    attempt < WORKTREE_DIRECTORY_CLEANUP_ATTEMPTS;
    attempt++
  ) {
    try {
      await rmAsync(worktreePath, {
        recursive: true,
        force: true,
        maxRetries: 0,
      });
    } catch {
      /* best-effort */
    }

    if (!existsSync(worktreePath)) {
      return null;
    }

    if (attempt < WORKTREE_DIRECTORY_CLEANUP_ATTEMPTS - 1) {
      await wait(WORKTREE_DIRECTORY_CLEANUP_RETRY_MS * (attempt + 1));
    }
  }

  return describeBlockingWorktreePath(worktreePath);
}

function enrichWorktreeCreateError(
  error: unknown,
  cleanupDetail: string | null
): Error {
  const baseMessage = error instanceof Error ? error.message : String(error);
  if (!cleanupDetail) {
    return error instanceof Error ? error : new Error(baseMessage);
  }
  return new Error(`${baseMessage}\nCleanup detail: ${cleanupDetail}`);
}

async function createIsolatedWorktree(input: {
  targetRepoRoot: string;
  worktreePath: string;
  branchName: string;
  startPoint: string;
}): Promise<void> {
  const { targetRepoRoot, worktreePath, branchName, startPoint } = input;
  let cleanupDetail: string | null = null;

  const tryCreate = async (): Promise<void> => {
    await cleanupStaleBranch(targetRepoRoot, worktreePath, branchName);

    const result = await execGit(targetRepoRoot, [
      'worktree',
      'add',
      worktreePath,
      '-b',
      branchName,
      startPoint,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `git worktree add failed (code ${result.code}): ${result.stderr}`
      );
    }

    await bootstrapIsolatedWorktree(targetRepoRoot, worktreePath);
  };

  try {
    await tryCreate();
  } catch {
    cleanupDetail = await safeRemoveWorktree(
      targetRepoRoot,
      worktreePath,
      branchName
    );
    try {
      await tryCreate();
    } catch (retryErr) {
      cleanupDetail =
        (await safeRemoveWorktree(targetRepoRoot, worktreePath, branchName)) ??
        cleanupDetail;
      throw enrichWorktreeCreateError(retryErr, cleanupDetail);
    }
  }
}

async function resolveIntegrationBase(input: {
  targetRepoRoot: string;
}): Promise<{
  remoteName: string;
  remoteBranch: string;
  startPoint: string;
}> {
  const { targetRepoRoot } = input;

  const upstreamResult = await execGit(targetRepoRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]).catch(() => null);
  const upstream = parseRemoteBranchSpec(upstreamResult?.stdout ?? null);
  let remoteName = upstream?.remoteName ?? 'origin';
  let remoteBranch = upstream?.remoteBranch ?? null;

  if (!remoteBranch) {
    const currentBranchResult = await execGit(targetRepoRoot, [
      'branch',
      '--show-current',
    ]).catch(() => null);
    const currentBranch =
      currentBranchResult?.code === 0 && currentBranchResult.stdout.trim()
        ? currentBranchResult.stdout.trim()
        : null;
    if (currentBranch) {
      remoteBranch = currentBranch;
    }
  }

  if (!remoteBranch) {
    const remoteHeadResult = await execGit(targetRepoRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'refs/remotes/origin/HEAD',
    ]).catch(() => null);
    const remoteHead = parseRemoteBranchSpec(remoteHeadResult?.stdout ?? null);
    if (remoteHead) {
      remoteName = remoteHead.remoteName;
      remoteBranch = remoteHead.remoteBranch;
    }
  }

  if (!remoteBranch) {
    throw new Error(
      'Could not determine the integration target branch from the current checkout.'
    );
  }

  await execGit(targetRepoRoot, ['fetch', remoteName, remoteBranch]).catch(
    () => {}
  );
  const remoteRef = `refs/remotes/${remoteName}/${remoteBranch}`;
  const startPoint = (await gitRefExists(targetRepoRoot, remoteRef))
    ? remoteRef
    : remoteBranch;

  return {
    remoteName,
    remoteBranch,
    startPoint,
  };
}

// ---------------------------------------------------------------------------
// createWorkerWorktree
// ---------------------------------------------------------------------------

/**
 * Create an isolated git worktree for a worker assignment.
 *
 * **No fallback**: if creation fails after one retry the function throws.
 */
export async function createWorkerWorktree(input: {
  targetRepoRoot: string;
  assignmentId: string;
}): Promise<WorktreeInfo> {
  const { targetRepoRoot, assignmentId } = input;
  const branchName = `wah-worker-${assignmentId}`;
  const worktreePath = allocateWorktreePath(
    targetRepoRoot,
    `wah-wt-${assignmentId}`
  );
  const trackedBase = await resolveIntegrationBase({ targetRepoRoot }).catch(
    () => null
  );

  await createIsolatedWorktree({
    targetRepoRoot,
    worktreePath,
    branchName,
    startPoint: trackedBase?.startPoint ?? 'HEAD',
  });

  return { worktreePath, branchName, targetRepoRoot };
}

// ---------------------------------------------------------------------------
// createIntegrationWorktree
// ---------------------------------------------------------------------------

export async function createIntegrationWorktree(input: {
  targetRepoRoot: string;
  assignmentId: string;
}): Promise<IntegrationWorktreeInfo> {
  const { targetRepoRoot, assignmentId } = input;
  const branchName = `wah-merge-${assignmentId}`;
  const worktreePath = allocateWorktreePath(
    targetRepoRoot,
    `wah-merge-${assignmentId}`
  );
  const integrationBase = await resolveIntegrationBase({ targetRepoRoot });

  await createIsolatedWorktree({
    targetRepoRoot,
    worktreePath,
    branchName,
    startPoint: integrationBase.startPoint,
  });

  return {
    worktreePath,
    branchName,
    targetRepoRoot,
    remoteName: integrationBase.remoteName,
    remoteBranch: integrationBase.remoteBranch,
  };
}

// ---------------------------------------------------------------------------
// abortStaleMerge — recover from a crash that left MERGE_HEAD behind
// ---------------------------------------------------------------------------

export async function abortStaleMerge(
  targetRepoRoot: string
): Promise<boolean> {
  const mergeHeadPath = join(targetRepoRoot, '.git', 'MERGE_HEAD');
  if (!existsSync(mergeHeadPath)) {
    return false;
  }
  console.error(
    `[manager-worktree] Stale MERGE_HEAD detected in ${targetRepoRoot}; aborting leftover merge.`
  );
  await execGit(targetRepoRoot, ['merge', '--abort']).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// mergeWorktreeToMain
// ---------------------------------------------------------------------------

/**
 * Merge a worktree branch into the current branch of the target repo.
 *
 * Merges are serialised per repository via an in-process lock.
 */
export async function mergeWorktreeToMain(input: {
  targetRepoRoot: string;
  sourceRef: string;
  lockRepoRoot?: string;
}): Promise<MergeResult> {
  const { targetRepoRoot, sourceRef, lockRepoRoot } = input;

  return withMergeLock(lockRepoRoot ?? targetRepoRoot, async () => {
    // Recover from a previous crash that may have left a stale merge state.
    await abortStaleMerge(targetRepoRoot);

    const result = await execGit(targetRepoRoot, [
      'merge',
      '--no-ff',
      sourceRef,
      '--no-edit',
    ]);

    if (result.code === 0) {
      return {
        success: true,
        conflicted: false,
        conflictFiles: [],
        detail: 'clean merge',
      };
    }

    // Check whether the failure is a conflict or something else.
    const conflictCheck = await execGit(targetRepoRoot, [
      'diff',
      '--name-only',
      '--diff-filter=U',
    ]);
    const conflictFiles = conflictCheck.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (conflictFiles.length > 0) {
      // Leave the conflict state intact for the caller to resolve.
      return {
        success: false,
        conflicted: true,
        conflictFiles,
        detail: `Merge conflict in ${conflictFiles.length} file(s)`,
      };
    }

    // Non-conflict merge failure — abort and report.
    await execGit(targetRepoRoot, ['merge', '--abort']).catch(() => {});
    return {
      success: false,
      conflicted: false,
      conflictFiles: [],
      detail: result.stderr || `git merge failed with code ${result.code}`,
    };
  });
}

// ---------------------------------------------------------------------------
// resolveConflictAndVerify
// ---------------------------------------------------------------------------

/**
 * Resolve merge conflicts by spawning a Manager Codex turn, then verify
 * the result.  On failure the merge is aborted.
 *
 * `runCodexTurnFn` is injected to avoid a circular dependency on
 * `manager-backend.ts`.
 */
export async function resolveConflictAndVerify(input: {
  targetRepoRoot: string;
  conflictFiles: string[];
  runCodexTurnFn: (
    prompt: string,
    cwd: string
  ) => Promise<{ code: number | null; stderr: string }>;
}): Promise<MergeResult> {
  const { targetRepoRoot, conflictFiles } = input;

  // Gather the conflict diff for the Codex prompt.
  const diffResult = await execGit(targetRepoRoot, ['diff']);
  const conflictDiff = diffResult.stdout.slice(0, 12_000); // cap size

  const prompt = [
    'You are resolving a git merge conflict.',
    'The following files have conflict markers that you must resolve:',
    conflictFiles.map((f) => `- ${f}`).join('\n'),
    '',
    'Conflict diff (may be truncated):',
    conflictDiff,
    '',
    'Instructions:',
    '1. Read each conflicted file, understand both sides, and resolve the conflict.',
    '2. Run `git add` on each resolved file.',
    '3. Run the repository verification command (e.g., `npm run verify`) to ensure correctness.',
    '4. Do NOT run `git commit` — the merge commit will be completed automatically.',
    'Return JSON: {"status":"review","reply":"<summary of what you resolved>"}',
  ].join('\n');

  const codexResult = await input.runCodexTurnFn(prompt, targetRepoRoot);

  // Check for remaining conflict markers.
  const check = await execGit(targetRepoRoot, ['diff', '--check']);
  const hasConflictMarkers =
    check.code !== 0 && check.stdout.includes('conflict');

  if (hasConflictMarkers || codexResult.code !== 0) {
    await execGit(targetRepoRoot, ['merge', '--abort']).catch(() => {});
    return {
      success: false,
      conflicted: true,
      conflictFiles,
      detail:
        codexResult.code !== 0
          ? `Codex conflict resolution exited with code ${codexResult.code}`
          : 'Conflict markers remain after resolution attempt',
    };
  }

  // Complete the merge commit.
  const commitResult = await execGit(targetRepoRoot, ['commit', '--no-edit']);
  if (commitResult.code !== 0) {
    await execGit(targetRepoRoot, ['merge', '--abort']).catch(() => {});
    return {
      success: false,
      conflicted: false,
      conflictFiles: [],
      detail: `git commit after conflict resolution failed: ${commitResult.stderr}`,
    };
  }

  return {
    success: true,
    conflicted: false,
    conflictFiles: [],
    detail: 'conflict resolved',
  };
}

// ---------------------------------------------------------------------------
// pushWithRetry
// ---------------------------------------------------------------------------

export async function pushWithRetry(input: {
  targetRepoRoot: string;
  maxRetries?: number;
  remoteName?: string;
  remoteBranch?: string;
}): Promise<{ success: boolean; detail: string }> {
  const { targetRepoRoot, maxRetries = 2, remoteName, remoteBranch } = input;
  const pushArgs =
    remoteName && remoteBranch
      ? ['push', remoteName, `HEAD:${remoteBranch}`]
      : ['push'];
  const pullArgs =
    remoteName && remoteBranch
      ? ['pull', '--rebase', '--no-edit', remoteName, remoteBranch]
      : ['pull', '--rebase', '--no-edit'];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await execGit(targetRepoRoot, pushArgs);
    if (result.code === 0) {
      return { success: true, detail: 'pushed' };
    }

    // If rejected because remote is ahead, pull --rebase and retry.
    const isRejection =
      result.stderr.includes('rejected') ||
      result.stderr.includes('non-fast-forward') ||
      result.stderr.includes('fetch first');

    if (isRejection && attempt < maxRetries) {
      const pullResult = await execGit(targetRepoRoot, pullArgs);
      if (pullResult.code !== 0) {
        return {
          success: false,
          detail: `git pull --rebase failed: ${pullResult.stderr}`,
        };
      }
      continue;
    }

    return {
      success: false,
      detail: result.stderr || `git push failed with code ${result.code}`,
    };
  }

  return { success: false, detail: 'max push retries exceeded' };
}

export async function syncCanonicalCheckoutToRemoteBranch(input: {
  targetRepoRoot: string;
  remoteName: string;
  remoteBranch: string;
}): Promise<CanonicalCheckoutSyncResult> {
  const { targetRepoRoot, remoteName, remoteBranch } = input;
  return withMergeLock(targetRepoRoot, async () => {
    const statusResult = await execGit(targetRepoRoot, [
      'status',
      '--porcelain',
    ]);
    if (statusResult.code !== 0) {
      return {
        success: false,
        synced: false,
        skipped: false,
        reason: 'status-failed',
        detail: summarizeCommandFailure('git status --porcelain', statusResult),
      };
    }
    if (statusResult.stdout.trim()) {
      return {
        success: true,
        synced: false,
        skipped: true,
        reason: 'dirty',
        detail:
          'Skipped canonical checkout sync because the checkout has local changes.',
      };
    }

    if (await hasGitOperationInProgress(targetRepoRoot)) {
      return {
        success: true,
        synced: false,
        skipped: true,
        reason: 'git-operation-in-progress',
        detail:
          'Skipped canonical checkout sync because another git operation is already in progress.',
      };
    }

    const branchResult = await execGit(targetRepoRoot, [
      'branch',
      '--show-current',
    ]);
    if (branchResult.code !== 0) {
      return {
        success: false,
        synced: false,
        skipped: false,
        reason: 'branch-check-failed',
        detail: summarizeCommandFailure(
          'git branch --show-current',
          branchResult
        ),
      };
    }
    const currentBranch = branchResult.stdout.trim();
    if (!currentBranch) {
      return {
        success: true,
        synced: false,
        skipped: true,
        reason: 'detached-head',
        detail:
          'Skipped canonical checkout sync because the checkout is detached.',
      };
    }
    if (currentBranch !== remoteBranch) {
      return {
        success: true,
        synced: false,
        skipped: true,
        reason: 'branch-mismatch',
        detail: `Skipped canonical checkout sync because the checkout is on '${currentBranch}' instead of '${remoteBranch}'.`,
      };
    }

    const fetchResult = await execGit(targetRepoRoot, [
      'fetch',
      remoteName,
      remoteBranch,
    ]);
    if (fetchResult.code !== 0) {
      return {
        success: false,
        synced: false,
        skipped: false,
        reason: 'fetch-failed',
        detail: summarizeCommandFailure(
          `git fetch ${remoteName} ${remoteBranch}`,
          fetchResult
        ),
      };
    }

    const remoteRef = `refs/remotes/${remoteName}/${remoteBranch}`;
    if (!(await gitRefExists(targetRepoRoot, remoteRef))) {
      return {
        success: false,
        synced: false,
        skipped: false,
        reason: 'remote-ref-missing',
        detail: `Remote ref ${remoteRef} is missing after fetch.`,
      };
    }

    const mergeResult = await execGit(targetRepoRoot, [
      'merge',
      '--ff-only',
      remoteRef,
    ]);
    if (mergeResult.code === 0) {
      return {
        success: true,
        synced: true,
        skipped: false,
        reason: 'synced',
        detail:
          mergeResult.stdout.trim() ||
          mergeResult.stderr.trim() ||
          `Fast-forwarded ${currentBranch} to ${remoteRef}.`,
      };
    }

    const mergeDetail =
      mergeResult.stderr.trim() ||
      mergeResult.stdout.trim() ||
      `git merge --ff-only exited with code ${mergeResult.code ?? '?'}.`;
    if (
      mergeDetail.includes('Not possible to fast-forward') ||
      mergeDetail.includes('fast-forward')
    ) {
      return {
        success: true,
        synced: false,
        skipped: true,
        reason: 'not-fast-forwardable',
        detail: `Skipped canonical checkout sync because '${currentBranch}' is not a fast-forward of ${remoteRef}: ${mergeDetail}`,
      };
    }

    return {
      success: false,
      synced: false,
      skipped: false,
      reason: 'merge-failed',
      detail: summarizeCommandFailure(
        `git merge --ff-only ${remoteRef}`,
        mergeResult
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Worktree delivery readiness
// ---------------------------------------------------------------------------

export async function validateWorktreeReadyForMerge(input: {
  targetRepoRoot: string;
  worktreePath: string;
  reportedChangedFiles: string[];
}): Promise<WorktreeDeliveryReadiness> {
  const statusResult = await execGit(input.worktreePath, [
    'status',
    '--porcelain',
  ]);
  if (statusResult.code !== 0) {
    return {
      ready: false,
      detail: summarizeCommandFailure('git status --porcelain', statusResult),
      aheadCommitCount: 0,
      mergeSourceRef: null,
    };
  }

  if (statusResult.stdout.trim()) {
    return {
      ready: false,
      detail: `The review step approved the worktree before all changes were committed.\n${statusResult.stdout}`,
      aheadCommitCount: 0,
      mergeSourceRef: null,
    };
  }

  const baseHead = await execGit(input.targetRepoRoot, ['rev-parse', 'HEAD']);
  if (baseHead.code !== 0 || !baseHead.stdout.trim()) {
    return {
      ready: false,
      detail: summarizeCommandFailure('git rev-parse HEAD', baseHead),
      aheadCommitCount: 0,
      mergeSourceRef: null,
    };
  }

  const worktreeHead = await execGit(input.worktreePath, ['rev-parse', 'HEAD']);
  if (worktreeHead.code !== 0 || !worktreeHead.stdout.trim()) {
    return {
      ready: false,
      detail: summarizeCommandFailure('git rev-parse HEAD', worktreeHead),
      aheadCommitCount: 0,
      mergeSourceRef: null,
    };
  }

  const aheadResult = await execGit(input.worktreePath, [
    'rev-list',
    '--count',
    'HEAD',
    `^${baseHead.stdout.trim()}`,
  ]);
  if (aheadResult.code !== 0) {
    return {
      ready: false,
      detail: summarizeCommandFailure(
        'git rev-list --count HEAD ^<target-head>',
        aheadResult
      ),
      aheadCommitCount: 0,
      mergeSourceRef: null,
    };
  }

  const aheadCommitCount = Number.parseInt(aheadResult.stdout.trim(), 10);
  if (!Number.isFinite(aheadCommitCount)) {
    return {
      ready: false,
      detail: `Could not parse ahead commit count: ${aheadResult.stdout}`,
      aheadCommitCount: 0,
      mergeSourceRef: null,
    };
  }

  const reportedChanges = input.reportedChangedFiles.some(
    (path) => path.trim().length > 0
  );
  if (reportedChanges && aheadCommitCount === 0) {
    return {
      ready: false,
      detail:
        'The worker reported changed files, but the review step did not create a commit for them before approval.',
      aheadCommitCount,
      mergeSourceRef: null,
    };
  }

  return {
    ready: true,
    detail:
      aheadCommitCount > 0
        ? `Ready to merge with ${aheadCommitCount} commit(s) ahead of the target repository.`
        : 'Ready to merge; no repository changes need to be delivered.',
    aheadCommitCount,
    mergeSourceRef: aheadCommitCount > 0 ? worktreeHead.stdout.trim() : null,
  };
}

// ---------------------------------------------------------------------------
// Post-merge release / publish delivery
// ---------------------------------------------------------------------------

export async function runPostMergeDeliveryChain(input: {
  targetRepoRoot: string;
}): Promise<PostMergeDeliveryResult> {
  const pkg = await readPublishablePackageInfo(input.targetRepoRoot);
  if (!isUserOwnedPublishablePackage(pkg)) {
    return {
      success: true,
      detail:
        'No release/publish delivery chain is required for this repository.',
      performed: [],
    };
  }

  if (!pkg.repoSlug) {
    return {
      success: false,
      detail:
        'Release/publish is required, but the GitHub repository slug could not be determined from package.json or the origin remote.',
      performed: [],
    };
  }

  const performed: string[] = [];
  const tagName = `v${pkg.version}`;

  const auditResult = await execCommand(input.targetRepoRoot, 'npm', [
    'audit',
    '--omit=dev',
  ]);
  if (auditResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure('npm audit --omit=dev', auditResult),
      performed,
    };
  }
  performed.push('npm audit --omit=dev');

  const packResult = await execCommand(input.targetRepoRoot, 'npm', [
    'pack',
    '--dry-run',
  ]);
  if (packResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure('npm pack --dry-run', packResult),
      performed,
    };
  }
  performed.push('npm pack --dry-run');

  const existingVersion = await execCommand(input.targetRepoRoot, 'npm', [
    'view',
    `${pkg.name}@${pkg.version}`,
    'version',
    '--json',
  ]);
  if (existingVersion.code === 0) {
    return {
      success: false,
      detail: `Version ${pkg.version} of ${pkg.name} is already published. Prepare a new version before approving release/publish.`,
      performed,
    };
  }
  const packageNotFound =
    /E404|404|No match found for version|not in this registry/i.test(
      `${existingVersion.stdout}\n${existingVersion.stderr}`
    );
  if (!packageNotFound) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `npm view ${pkg.name}@${pkg.version} version --json`,
        existingVersion
      ),
      performed,
    };
  }

  const localTagResult = await execGit(input.targetRepoRoot, [
    'tag',
    '--list',
    tagName,
  ]);
  if (localTagResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `git tag --list ${tagName}`,
        localTagResult
      ),
      performed,
    };
  }
  if (
    localTagResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(tagName)
  ) {
    return {
      success: false,
      detail: `Git tag ${tagName} already exists locally. Prepare a new version before approving release/publish.`,
      performed,
    };
  }

  const remoteTagResult = await execGit(input.targetRepoRoot, [
    'ls-remote',
    '--tags',
    'origin',
    tagName,
  ]);
  if (remoteTagResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `git ls-remote --tags origin ${tagName}`,
        remoteTagResult
      ),
      performed,
    };
  }
  if (remoteTagResult.stdout.trim()) {
    return {
      success: false,
      detail: `Git tag ${tagName} already exists on origin. Prepare a new version before approving release/publish.`,
      performed,
    };
  }

  const releaseView = await execCommand(input.targetRepoRoot, 'gh', [
    'release',
    'view',
    tagName,
    '--repo',
    pkg.repoSlug,
  ]);
  if (releaseView.code === 0) {
    return {
      success: false,
      detail: `GitHub release ${tagName} already exists for ${pkg.repoSlug}. Prepare a new version before approving release/publish.`,
      performed,
    };
  }
  const releaseMissing = /not found|404/i.test(
    `${releaseView.stdout}\n${releaseView.stderr}`
  );
  if (!releaseMissing) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `gh release view ${tagName} --repo ${pkg.repoSlug}`,
        releaseView
      ),
      performed,
    };
  }

  const createTagResult = await execGit(input.targetRepoRoot, ['tag', tagName]);
  if (createTagResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure(`git tag ${tagName}`, createTagResult),
      performed,
    };
  }
  performed.push(`git tag ${tagName}`);

  const pushTagResult = await execGit(input.targetRepoRoot, [
    'push',
    'origin',
    tagName,
  ]);
  if (pushTagResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `git push origin ${tagName}`,
        pushTagResult
      ),
      performed,
    };
  }
  performed.push(`git push origin ${tagName}`);

  const publishResult = await execCommand(input.targetRepoRoot, 'npm', [
    'publish',
  ]);
  if (publishResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure('npm publish', publishResult),
      performed,
    };
  }
  performed.push('npm publish');

  const releaseCreateResult = await execCommand(input.targetRepoRoot, 'gh', [
    'release',
    'create',
    tagName,
    '--repo',
    pkg.repoSlug,
    '--title',
    tagName,
    '--notes',
    'See CHANGELOG.md',
  ]);
  if (releaseCreateResult.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `gh release create ${tagName} --repo ${pkg.repoSlug}`,
        releaseCreateResult
      ),
      performed,
    };
  }
  performed.push(`gh release create ${tagName}`);

  const registryVerify = await execCommand(input.targetRepoRoot, 'npm', [
    'view',
    pkg.name,
    'version',
    '--json',
  ]);
  if (registryVerify.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `npm view ${pkg.name} version --json`,
        registryVerify
      ),
      performed,
    };
  }
  if (!registryVerify.stdout.includes(pkg.version)) {
    return {
      success: false,
      detail: `Registry verification did not return version ${pkg.version} for ${pkg.name}: ${registryVerify.stdout}`,
      performed,
    };
  }
  performed.push(`npm view ${pkg.name} version --json`);

  const npxVerify = await execCommand(
    input.targetRepoRoot,
    'npx',
    [`${pkg.name}@latest`, '--version'],
    { timeoutMs: 300_000 }
  );
  if (npxVerify.code !== 0) {
    return {
      success: false,
      detail: summarizeCommandFailure(
        `npx ${pkg.name}@latest --version`,
        npxVerify
      ),
      performed,
    };
  }
  if (!`${npxVerify.stdout}\n${npxVerify.stderr}`.includes(pkg.version)) {
    return {
      success: false,
      detail: `Fresh-install verification did not print version ${pkg.version}. Output: ${npxVerify.stdout || npxVerify.stderr}`,
      performed,
    };
  }
  performed.push(`npx ${pkg.name}@latest --version`);

  return {
    success: true,
    detail: `Completed release/publish delivery for ${pkg.name}@${pkg.version}.`,
    performed,
  };
}

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

export async function removeWorktree(input: {
  targetRepoRoot: string;
  worktreePath: string;
  branchName: string;
}): Promise<void> {
  const { targetRepoRoot, worktreePath, branchName } = input;

  // 1. git worktree remove
  await execGit(targetRepoRoot, [
    'worktree',
    'remove',
    worktreePath,
    '--force',
  ]).catch(() => {});

  // 2. Delete temporary branch (may already be gone).
  await execGit(targetRepoRoot, ['branch', '-D', branchName]).catch(() => {});

  // 3. Best-effort release of leaked task-owned WSL/tmux locks before
  // deleting the temp directory on Windows.
  await releaseTaskOwnedWslTmuxLocks(worktreePath).catch(() => {});

  // 4. Manual cleanup if the directory still exists.
  let cleanupFailure = await removeWorktreeDirectory(worktreePath);
  if (cleanupFailure) {
    await releaseTaskOwnedWslTmuxLocks(worktreePath).catch(() => {});
    cleanupFailure = await removeWorktreeDirectory(worktreePath);
  }
  if (cleanupFailure) {
    console.error(
      `[manager-worktree] Failed to fully remove worktree directory: ${cleanupFailure}`
    );
  }

  // 5. Prune stale worktree references.
  await execGit(targetRepoRoot, ['worktree', 'prune']).catch(() => {});

  // 6. Remove any leaked remote temp branch that should never survive
  // cleanup of an isolated Manager worktree.
  await deleteLeakedRemoteTempBranch({ targetRepoRoot, branchName }).catch(
    () => {}
  );

  if (cleanupFailure) {
    throw new Error(
      `Failed to fully remove worktree directory: ${cleanupFailure}`
    );
  }
}

function isManagedTempWorktreeName(name: string): boolean {
  return name.startsWith('wah-wt-') || name.startsWith('wah-merge-');
}

function isManagedTempBranchName(name: string): boolean {
  return name.startsWith('wah-worker-') || name.startsWith('wah-merge-');
}

function extractManagedAssignmentIdFromBranch(
  branchName: string
): string | null {
  const match = branchName.match(/^wah-(?:worker|merge)-(.+)$/);
  return match?.[1] ?? null;
}

function tempWorktreeBelongsToActiveAssignment(
  name: string,
  activeAssignmentIds: string[]
): boolean {
  return activeAssignmentIds.some((assignmentId) => {
    for (const prefix of ['wah-wt-', 'wah-merge-']) {
      const baseName = `${prefix}${assignmentId}`;
      if (name === baseName || name.startsWith(`${baseName}-`)) {
        return true;
      }
    }
    return false;
  });
}

async function cleanupUnregisteredTempWorktrees(input: {
  registeredWorktreePaths: Set<string>;
  activeAssignmentIds: string[];
  tempRoot?: string;
}): Promise<void> {
  const tempRoot = input.tempRoot;
  if (!tempRoot) {
    return;
  }
  let tempEntries: Dirent[];
  try {
    tempEntries = await readdir(tempRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of tempEntries) {
    if (!entry.isDirectory() || !isManagedTempWorktreeName(entry.name)) {
      continue;
    }

    if (
      tempWorktreeBelongsToActiveAssignment(
        entry.name,
        input.activeAssignmentIds
      )
    ) {
      continue;
    }

    const candidatePath = resolvePath(tempRoot, entry.name);
    if (input.registeredWorktreePaths.has(candidatePath)) {
      continue;
    }

    const cleanupFailure = await removeWorktreeDirectory(candidatePath);
    if (cleanupFailure) {
      console.error(
        `[manager-worktree] Failed to remove orphaned temp worktree directory: ${cleanupFailure}`
      );
    }
  }
}

async function listGitRemotes(targetRepoRoot: string): Promise<string[]> {
  const remotesResult = await execGit(targetRepoRoot, ['remote'], {
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!remotesResult || remotesResult.code !== 0) {
    return [];
  }

  return [
    ...new Set(
      remotesResult.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ];
}

async function deleteLeakedRemoteTempBranch(input: {
  targetRepoRoot: string;
  branchName: string;
}): Promise<void> {
  if (!isManagedTempBranchName(input.branchName)) {
    return;
  }

  const remotes = await listGitRemotes(input.targetRepoRoot);
  for (const remoteName of remotes) {
    await execGit(
      input.targetRepoRoot,
      ['push', remoteName, '--delete', input.branchName],
      { timeoutMs: 15_000 }
    ).catch(() => {});
  }
}

async function cleanupInactiveRemoteTempBranches(input: {
  targetRepoRoot: string;
  activeAssignmentIds: string[];
}): Promise<void> {
  const remotes = await listGitRemotes(input.targetRepoRoot);
  for (const remoteName of remotes) {
    const remoteHeadsResult = await execGit(
      input.targetRepoRoot,
      ['ls-remote', '--heads', remoteName, 'wah-worker-*', 'wah-merge-*'],
      { timeoutMs: 15_000 }
    ).catch(() => null);
    if (!remoteHeadsResult || remoteHeadsResult.code !== 0) {
      continue;
    }

    const branchNames = [
      ...new Set(
        remoteHeadsResult.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.match(/refs\/heads\/(.+)$/)?.[1] ?? null)
          .filter((name): name is string => Boolean(name))
          .filter((name) => isManagedTempBranchName(name))
      ),
    ];

    for (const branchName of branchNames) {
      const assignmentId = extractManagedAssignmentIdFromBranch(branchName);
      if (assignmentId && input.activeAssignmentIds.includes(assignmentId)) {
        continue;
      }
      await execGit(
        input.targetRepoRoot,
        ['push', remoteName, '--delete', branchName],
        { timeoutMs: 15_000 }
      ).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// cleanupOrphanedWorktrees
// ---------------------------------------------------------------------------

/**
 * Remove worktrees whose assignment ID is no longer active.
 * Removes both git-registered orphaned worktrees and stray managed directories
 * left behind after earlier cleanup failures.
 */
export async function cleanupOrphanedWorktrees(
  targetRepoRoot: string,
  activeAssignmentIds: string[],
  options?: {
    tempRoot?: string;
  }
): Promise<void> {
  const result = await execGit(targetRepoRoot, [
    'worktree',
    'list',
    '--porcelain',
  ]);
  if (result.code !== 0) {
    return;
  }

  // Parse porcelain output.  Each worktree block is separated by a blank
  // line and contains "worktree <path>" and "branch refs/heads/<name>".
  const blocks = result.stdout.split('\n\n');
  const registeredWorktreePaths = new Set<string>();
  for (const block of blocks) {
    const pathMatch = block.match(/^worktree (.+)$/m);
    if (pathMatch?.[1]) {
      registeredWorktreePaths.add(resolvePath(pathMatch[1]));
    }

    const branchMatch = block.match(
      /^branch refs\/heads\/((?:wah-worker|wah-merge)-.+)$/m
    );
    if (!pathMatch || !branchMatch) {
      continue;
    }
    const wtPath = pathMatch[1]!;
    const branchName = branchMatch[1]!;
    const assignmentId = branchName.replace(/^wah-(?:worker|merge)-/, '');
    if (!activeAssignmentIds.includes(assignmentId)) {
      await removeWorktree({
        targetRepoRoot,
        worktreePath: wtPath,
        branchName,
      }).catch(() => {});
    }
  }

  await cleanupUnregisteredTempWorktrees({
    registeredWorktreePaths,
    activeAssignmentIds,
    tempRoot: options?.tempRoot ?? dirname(resolvePath(targetRepoRoot)),
  });

  await cleanupInactiveRemoteTempBranches({
    targetRepoRoot,
    activeAssignmentIds,
  });
}

async function listRegisteredWorktreePathsForBranch(
  targetRepoRoot: string,
  branchName: string
): Promise<string[]> {
  const result = await execGit(targetRepoRoot, [
    'worktree',
    'list',
    '--porcelain',
  ]).catch(() => null);
  if (!result || result.code !== 0) {
    return [];
  }

  const repoRoot = resolvePath(targetRepoRoot);
  const paths: string[] = [];
  for (const block of result.stdout.split('\n\n')) {
    const pathMatch = block.match(/^worktree (.+)$/m);
    const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
    if (!pathMatch?.[1] || !branchMatch?.[1]) {
      continue;
    }
    if (branchMatch[1].trim() !== branchName) {
      continue;
    }
    const resolvedWorktreePath = resolvePath(pathMatch[1].trim());
    if (resolvedWorktreePath === repoRoot) {
      continue;
    }
    paths.push(resolvedWorktreePath);
  }

  return [...new Set(paths)];
}

async function removeRegisteredWorktreesForBranch(
  targetRepoRoot: string,
  branchName: string
): Promise<void> {
  const stalePaths = await listRegisteredWorktreePathsForBranch(
    targetRepoRoot,
    branchName
  );
  for (const stalePath of stalePaths) {
    await execGit(targetRepoRoot, [
      'worktree',
      'remove',
      stalePath,
      '--force',
    ]).catch(() => {});
    const cleanupFailure = await removeWorktreeDirectory(stalePath);
    if (cleanupFailure) {
      throw new Error(
        `Failed to clear stale registered worktree before recreation: ${cleanupFailure}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Remove a stale branch and/or worktree left over from a previous crash. */
async function cleanupStaleBranch(
  targetRepoRoot: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  await removeRegisteredWorktreesForBranch(targetRepoRoot, branchName);

  // Remove existing worktree at the path (if any).
  if (existsSync(worktreePath)) {
    await execGit(targetRepoRoot, [
      'worktree',
      'remove',
      worktreePath,
      '--force',
    ]).catch(() => {});
    const cleanupFailure = await removeWorktreeDirectory(worktreePath);
    if (cleanupFailure) {
      throw new Error(
        `Failed to clear stale worktree path before recreation: ${cleanupFailure}`
      );
    }
  }

  // Prune stale worktree refs before deleting the branch so git no longer
  // considers the temp branch checked out elsewhere.
  await execGit(targetRepoRoot, ['worktree', 'prune']).catch(() => {});

  // Delete the branch if it already exists.
  await execGit(targetRepoRoot, ['branch', '-D', branchName]).catch(() => {});

  // Prune stale worktree refs.
  await execGit(targetRepoRoot, ['worktree', 'prune']).catch(() => {});
}

/** Best-effort worktree removal that never throws. */
async function safeRemoveWorktree(
  targetRepoRoot: string,
  worktreePath: string,
  branchName: string
): Promise<string | null> {
  try {
    await removeWorktree({ targetRepoRoot, worktreePath, branchName });
    return null;
  } catch {
    return describeBlockingWorktreePath(worktreePath);
  }
}
