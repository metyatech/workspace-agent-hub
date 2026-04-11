import { resolve as resolvePath } from 'node:path';
import {
  createTaskWorktree,
  deliverTaskWorktree,
  doctorRepository,
  dropTaskWorktree,
  listWorktrees,
  loadConfig,
  loadMarker,
} from '@metyatech/managed-worktree-system';

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

function looksLikeMwtError(
  error: unknown
): error is { id?: unknown; message?: unknown; details?: unknown } {
  return Boolean(error) && typeof error === 'object';
}

export function isMwtDeliverConflictError(error: unknown): boolean {
  return looksLikeMwtError(error) && error.id === 'deliver_rebase_conflict';
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
  return recovery ? `${message} ${recovery}`.trim() : message;
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
