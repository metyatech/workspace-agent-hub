/**
 * Git worktree lifecycle management for worker isolation.
 *
 * Every worker agent runs in an isolated git worktree created from the
 * target repository's HEAD.  After the worker (and the Manager review step)
 * finishes, the worktree branch is merged back to the main branch by the
 * Manager backend.  This module owns: create, merge, conflict-resolution,
 * push, remove, and orphan-cleanup operations.
 */

import { spawn } from 'child_process';
import { existsSync, symlinkSync, unlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve as resolvePath } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  worktreePath: string;
  branchName: string;
  targetRepoRoot: string;
}

export interface MergeResult {
  success: boolean;
  conflicted: boolean;
  conflictFiles: string[];
  detail: string;
}

// ---------------------------------------------------------------------------
// Module-level merge lock  (serialises merges per repository)
// ---------------------------------------------------------------------------

const _mergeLocks = new Map<string, Promise<void>>();

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

export function execGit(
  cwd: string,
  args: string[],
  options?: { timeoutMs?: number }
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
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
  const worktreePath = join(tmpdir(), `wah-wt-${assignmentId}`);

  const tryCreate = async (): Promise<void> => {
    // Clean up leftovers from a previous crashed run.
    await cleanupStaleBranch(targetRepoRoot, worktreePath, branchName);

    const result = await execGit(targetRepoRoot, [
      'worktree',
      'add',
      worktreePath,
      '-b',
      branchName,
      'HEAD',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `git worktree add failed (code ${result.code}): ${result.stderr}`
      );
    }

    // Junction for node_modules (Windows directory junction — instant, no admin)
    const nmSource = join(targetRepoRoot, 'node_modules');
    const nmTarget = join(worktreePath, 'node_modules');
    if (existsSync(nmSource) && !existsSync(nmTarget)) {
      symlinkSync(nmSource, nmTarget, 'junction');
    }
  };

  try {
    await tryCreate();
  } catch (firstErr) {
    // One retry after cleaning up any partial state.
    await safeRemoveWorktree(targetRepoRoot, worktreePath, branchName);
    try {
      await tryCreate();
    } catch (retryErr) {
      await safeRemoveWorktree(targetRepoRoot, worktreePath, branchName);
      throw retryErr;
    }
  }

  return { worktreePath, branchName, targetRepoRoot };
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
  branchName: string;
}): Promise<MergeResult> {
  const { targetRepoRoot, branchName } = input;

  return withMergeLock(targetRepoRoot, async () => {
    const result = await execGit(targetRepoRoot, [
      'merge',
      '--no-ff',
      branchName,
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
}): Promise<{ success: boolean; detail: string }> {
  const { targetRepoRoot, maxRetries = 2 } = input;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await execGit(targetRepoRoot, ['push']);
    if (result.code === 0) {
      return { success: true, detail: 'pushed' };
    }

    // If rejected because remote is ahead, pull --rebase and retry.
    const isRejection =
      result.stderr.includes('rejected') ||
      result.stderr.includes('non-fast-forward') ||
      result.stderr.includes('fetch first');

    if (isRejection && attempt < maxRetries) {
      const pullResult = await execGit(targetRepoRoot, [
        'pull',
        '--rebase',
        '--no-edit',
      ]);
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

  // 3. Manual cleanup if the directory still exists.
  if (existsSync(worktreePath)) {
    // Remove the node_modules junction first (it's a junction, not real files).
    const nmJunction = join(worktreePath, 'node_modules');
    try {
      if (existsSync(nmJunction)) {
        unlinkSync(nmJunction);
      }
    } catch {
      /* best-effort */
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // 4. Prune stale worktree references.
  await execGit(targetRepoRoot, ['worktree', 'prune']).catch(() => {});
}

// ---------------------------------------------------------------------------
// cleanupOrphanedWorktrees
// ---------------------------------------------------------------------------

/**
 * Remove worktrees whose assignment ID is no longer active.
 * Reads `git worktree list --porcelain` and matches branch names
 * against the `wah-worker-` prefix.
 */
export async function cleanupOrphanedWorktrees(
  targetRepoRoot: string,
  activeAssignmentIds: string[]
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
  for (const block of blocks) {
    const pathMatch = block.match(/^worktree (.+)$/m);
    const branchMatch = block.match(/^branch refs\/heads\/(wah-worker-.+)$/m);
    if (!pathMatch || !branchMatch) {
      continue;
    }
    const wtPath = pathMatch[1]!;
    const branchName = branchMatch[1]!;
    // Extract assignment ID from branch name: wah-worker-assign_q_xxxxx
    const assignmentId = branchName.replace(/^wah-worker-/, '');
    if (!activeAssignmentIds.includes(assignmentId)) {
      await removeWorktree({
        targetRepoRoot,
        worktreePath: wtPath,
        branchName,
      }).catch(() => {});
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
  // Remove existing worktree at the path (if any).
  if (existsSync(worktreePath)) {
    await execGit(targetRepoRoot, [
      'worktree',
      'remove',
      worktreePath,
      '--force',
    ]).catch(() => {});
    if (existsSync(worktreePath)) {
      const nmJunction = join(worktreePath, 'node_modules');
      try {
        if (existsSync(nmJunction)) unlinkSync(nmJunction);
      } catch {
        /* best-effort */
      }
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

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
): Promise<void> {
  try {
    await removeWorktree({ targetRepoRoot, worktreePath, branchName });
  } catch {
    /* swallow — this is a cleanup path */
  }
}
