import { resolve as resolvePath } from 'node:path';
import { deriveApprovalQueue } from './approval-queue.js';
import type { PreflightReport } from './preflight.js';
import {
  auditWorkspaceContracts,
  type WorkspaceContractAuditEntry,
} from './repo-auditor.js';
import { deriveMergeLanes } from './merge-lanes.js';
import { readManagedRepos } from './manager-repos.js';
import { readManagerWorkItems } from './manager-work-items.js';
import { deriveRunsForWorkspace } from './runs.js';
import { readQueue, readSession } from './manager-backend.js';
import { listWorkerRuntimeAvailability } from './worker-adapter/availability.js';

export interface WorkspaceHealthSnapshot {
  workspaceRoot: string;
  generatedAt: string;
  inScopeRepoCount: number;
  invalidRepoCount: number;
  approvalQueueCount: number;
  runCount: number;
  mergeLaneCount: number;
  unavailableRuntimeCount: number;
  repoAudits: WorkspaceContractAuditEntry[];
}

export function deriveWorkspaceHealthFromPreflight(
  report: PreflightReport
): WorkspaceHealthSnapshot {
  return {
    workspaceRoot: report.workspaceRoot,
    generatedAt: report.generatedAt,
    inScopeRepoCount: report.summary.inScopeRepoCount,
    invalidRepoCount: report.summary.invalidRepoCount,
    approvalQueueCount: report.summary.approvalQueueCount,
    runCount: report.summary.runCount,
    mergeLaneCount: report.summary.mergeLaneCount,
    unavailableRuntimeCount: report.summary.unavailableRuntimeCount,
    repoAudits: report.repoAudits,
  };
}

export async function deriveWorkspaceHealth(
  workspaceRoot: string
): Promise<WorkspaceHealthSnapshot> {
  const resolvedWorkspaceRoot = resolvePath(workspaceRoot);
  const [repoAudits, repos, workItems, session, queue] = await Promise.all([
    auditWorkspaceContracts(resolvedWorkspaceRoot, {
      requireMwt: false,
      requireWriteAccess: true,
    }),
    readManagedRepos(resolvedWorkspaceRoot),
    readManagerWorkItems(resolvedWorkspaceRoot),
    readSession(resolvedWorkspaceRoot),
    readQueue(resolvedWorkspaceRoot),
  ]);
  const approvalQueue = deriveApprovalQueue(workItems);
  const mergeLanes = deriveMergeLanes({ repos, workItems });
  const runs = await deriveRunsForWorkspace(resolvedWorkspaceRoot, {
    session,
    queue,
  });
  const runtimeAvailability = listWorkerRuntimeAvailability();

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    generatedAt: new Date().toISOString(),
    inScopeRepoCount: repoAudits.length,
    invalidRepoCount: repoAudits.filter((entry) => !entry.audit.valid).length,
    approvalQueueCount: approvalQueue.length,
    runCount: runs.runs.length,
    mergeLaneCount: mergeLanes.length,
    unavailableRuntimeCount: runtimeAvailability.filter(
      (entry) => !entry.available
    ).length,
    repoAudits,
  };
}
