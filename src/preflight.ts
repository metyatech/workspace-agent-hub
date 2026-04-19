import { resolve as resolvePath } from 'node:path';
import {
  auditRepositoryContract,
  auditWorkspaceContracts,
  type RepoContractAuditResult,
  type WorkspaceContractAuditEntry,
} from './repo-auditor.js';
import { ensureRepoBootstrap } from './repo-bootstrap.js';
import { readQueue, readSession } from './manager-backend.js';
import {
  isManagedWorktreeRepository,
  maybeAutoInitializeManagerRepository,
} from './manager-mwt.js';
import { readManagedRepos } from './manager-repos.js';
import { readManagerWorkItems } from './manager-work-items.js';
import { deriveApprovalQueue } from './approval-queue.js';
import { deriveMergeLanes } from './merge-lanes.js';
import { deriveRunsForWorkspace } from './runs.js';
import {
  listWorkerRuntimeAvailability,
  type WorkerRuntimeAvailability,
} from './worker-adapter/availability.js';

export type PreflightSeverity = 'pass' | 'warn' | 'fail';

export type PreflightCheckId =
  | 'repo-contract'
  | 'repo-bootstrap'
  | 'mwt-readiness'
  | 'runtime-availability'
  | 'queue-integrity';

export interface PreflightCorrectiveAction {
  description: string;
  applied: boolean;
  filesChanged: string[];
}

export interface PreflightCheckResult {
  checkId: PreflightCheckId;
  severity: PreflightSeverity;
  target: string;
  summary: string;
  issues: string[];
  correctiveActions: PreflightCorrectiveAction[];
  durationMs: number;
}

export interface PreflightSummary {
  inScopeRepoCount: number;
  invalidRepoCount: number;
  approvalQueueCount: number;
  runCount: number;
  mergeLaneCount: number;
  unavailableRuntimeCount: number;
}

export interface PreflightReport {
  workspaceRoot: string;
  generatedAt: string;
  overall: PreflightSeverity;
  checks: PreflightCheckResult[];
  summary: PreflightSummary;
  repoAudits: WorkspaceContractAuditEntry[];
  totalDurationMs: number;
}

export interface PreflightOptions {
  workspaceRoot: string;
  applyCorrections?: boolean;
  repoRoots?: string[];
  skipChecks?: PreflightCheckId[];
}

export interface PreflightRepoContractOptions {
  requireMwt?: boolean;
  requireWriteAccess?: boolean;
}

function durationMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function severityRank(severity: PreflightSeverity): number {
  switch (severity) {
    case 'fail':
      return 3;
    case 'warn':
      return 2;
    default:
      return 1;
  }
}

function summarizeOverall(checks: PreflightCheckResult[]): PreflightSeverity {
  if (checks.some((check) => check.severity === 'fail')) {
    return 'fail';
  }
  if (checks.some((check) => check.severity === 'warn')) {
    return 'warn';
  }
  return 'pass';
}

function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function formatIssueCodes(result: RepoContractAuditResult): string[] {
  return result.issues.map((issue) => `${issue.code}: ${issue.message}`);
}

function mapFixableRepoContractActions(
  result: RepoContractAuditResult
): PreflightCorrectiveAction[] {
  return result.issues
    .filter((issue) => issue.fixable)
    .map((issue) => ({
      description: `Resolve ${issue.code}`,
      applied: false,
      filesChanged: issue.path ? [issue.path] : [],
    }));
}

export async function checkRepoContract(
  repoRoot: string,
  options: PreflightRepoContractOptions = {},
  existingAudit?: RepoContractAuditResult
): Promise<PreflightCheckResult> {
  const startedAt = Date.now();
  const audit =
    existingAudit ??
    (await auditRepositoryContract(repoRoot, {
      requireMwt: options.requireMwt ?? false,
      requireWriteAccess: options.requireWriteAccess ?? true,
    }));

  return {
    checkId: 'repo-contract',
    severity: audit.valid ? 'pass' : 'fail',
    target: repoRoot,
    summary: audit.valid
      ? 'Repository contract is satisfied.'
      : `Repository contract has ${audit.issues.length} issue(s).`,
    issues: formatIssueCodes(audit),
    correctiveActions: mapFixableRepoContractActions(audit),
    durationMs: durationMs(startedAt),
  };
}

const BOOTSTRAP_RELEVANT_ISSUES = new Set([
  'missing-agent-ruleset',
  'missing-agents',
  'missing-gitignore',
  'missing-verify-command',
  'threads-not-gitignored',
  'tasks-not-tracked',
]);

export async function checkRepoBootstrap(input: {
  workspaceRoot: string;
  repoRoot: string;
  applyCorrections?: boolean;
  existingAudit?: RepoContractAuditResult;
}): Promise<PreflightCheckResult> {
  const startedAt = Date.now();
  const repoRoot = resolvePath(input.repoRoot);
  if (input.applyCorrections) {
    const result = await ensureRepoBootstrap({
      workspaceRoot: input.workspaceRoot,
      repoRoot,
    });
    return {
      checkId: 'repo-bootstrap',
      severity: result.ready ? 'pass' : 'fail',
      target: repoRoot,
      summary: result.ready
        ? result.attempted
          ? 'Repository bootstrap corrections were applied.'
          : 'Repository bootstrap is already satisfied.'
        : 'Repository bootstrap could not reach a ready state.',
      issues: result.issues,
      correctiveActions: result.managedFiles.length
        ? [
            {
              description: 'Apply repository bootstrap-managed files',
              applied: result.ready && result.attempted,
              filesChanged: sortPaths(
                result.attempted ? result.touchedFiles : result.managedFiles
              ),
            },
          ]
        : [],
      durationMs: durationMs(startedAt),
    };
  }

  const audit =
    input.existingAudit ??
    (await auditRepositoryContract(repoRoot, {
      requireMwt: false,
      requireWriteAccess: true,
    }));
  const relevantIssues = audit.issues.filter((issue) =>
    BOOTSTRAP_RELEVANT_ISSUES.has(issue.code)
  );
  return {
    checkId: 'repo-bootstrap',
    severity: relevantIssues.length === 0 ? 'pass' : 'fail',
    target: repoRoot,
    summary:
      relevantIssues.length === 0
        ? 'Repository bootstrap prerequisites are already satisfied.'
        : `Repository bootstrap is missing ${relevantIssues.length} managed prerequisite(s).`,
    issues: relevantIssues.map((issue) => `${issue.code}: ${issue.message}`),
    correctiveActions:
      relevantIssues.length === 0
        ? []
        : [
            {
              description: 'Run repository bootstrap-managed setup',
              applied: false,
              filesChanged: sortPaths(
                relevantIssues
                  .map((issue) => issue.path)
                  .filter((value): value is string => Boolean(value))
              ),
            },
          ],
    durationMs: durationMs(startedAt),
  };
}

export async function checkMwtReadiness(input: {
  repoRoot: string;
  applyCorrections?: boolean;
  bootstrapManagedFiles?: readonly string[];
}): Promise<PreflightCheckResult> {
  const startedAt = Date.now();
  const repoRoot = resolvePath(input.repoRoot);
  if (await isManagedWorktreeRepository(repoRoot)) {
    return {
      checkId: 'mwt-readiness',
      severity: 'pass',
      target: repoRoot,
      summary: 'managed-worktree-system is already initialized.',
      issues: [],
      correctiveActions: [],
      durationMs: durationMs(startedAt),
    };
  }

  if (!input.applyCorrections) {
    return {
      checkId: 'mwt-readiness',
      severity: 'warn',
      target: repoRoot,
      summary:
        'managed-worktree-system is not initialized and would block isolated write tasks.',
      issues: ['missing-mwt'],
      correctiveActions: [
        {
          description: 'Attempt safe mwt auto-initialization',
          applied: false,
          filesChanged: ['.mwt/config.toml'],
        },
      ],
      durationMs: durationMs(startedAt),
    };
  }

  const result = await maybeAutoInitializeManagerRepository({
    targetRepoRoot: repoRoot,
    bootstrapManagedFiles: input.bootstrapManagedFiles,
  });
  return {
    checkId: 'mwt-readiness',
    severity: result.initialized ? 'pass' : 'warn',
    target: repoRoot,
    summary: result.initialized
      ? 'managed-worktree-system was initialized safely.'
      : 'managed-worktree-system could not be auto-initialized safely.',
    issues: result.initialized
      ? []
      : [result.reasonId ?? 'mwt-auto-init-blocked'],
    correctiveActions: [
      {
        description: 'Attempt safe mwt auto-initialization',
        applied: result.initialized,
        filesChanged: sortPaths(result.changedFiles),
      },
    ],
    durationMs: durationMs(startedAt),
  };
}

export function checkRuntimeAvailability(): PreflightCheckResult[] {
  return listWorkerRuntimeAvailability().map((runtime) => ({
    checkId: 'runtime-availability',
    severity: runtime.available ? 'pass' : 'fail',
    target: runtime.runtime,
    summary: runtime.available
      ? `${runtime.runtime} runtime is available.`
      : `${runtime.runtime} runtime is unavailable.`,
    issues: runtime.available ? [] : [runtime.detail],
    correctiveActions: [],
    durationMs: 0,
  }));
}

function buildQueueIntegrityIssues(input: {
  session: Awaited<ReturnType<typeof readSession>>;
  queue: Awaited<ReturnType<typeof readQueue>>;
}): string[] {
  const issues: string[] = [];
  const queueIds = new Set<string>();
  for (const entry of input.queue) {
    if (queueIds.has(entry.id)) {
      issues.push(`duplicate-queue-id: ${entry.id}`);
    }
    queueIds.add(entry.id);
  }

  const dispatchingIds = input.session.dispatchingQueueEntryIds ?? [];
  if (
    input.session.dispatchingThreadId &&
    dispatchingIds.length > 0 &&
    dispatchingIds.every((id) => !queueIds.has(id)) &&
    input.session.activeAssignments.length === 0
  ) {
    issues.push('dispatching-thread-has-no-queue-entry');
  }

  if (
    input.session.status === 'busy' &&
    !input.session.pid &&
    input.session.activeAssignments.length === 0 &&
    !input.session.dispatchingThreadId
  ) {
    issues.push('busy-session-without-runtime');
  }

  return issues;
}

export async function checkQueueIntegrity(
  workspaceRoot: string
): Promise<PreflightCheckResult> {
  const startedAt = Date.now();
  const [session, queue] = await Promise.all([
    readSession(workspaceRoot),
    readQueue(workspaceRoot),
  ]);
  const issues = buildQueueIntegrityIssues({ session, queue });
  return {
    checkId: 'queue-integrity',
    severity: issues.length === 0 ? 'pass' : 'warn',
    target: resolvePath(workspaceRoot),
    summary:
      issues.length === 0
        ? 'Manager queue/session state is internally consistent.'
        : `Manager queue/session state has ${issues.length} issue(s) that may require recovery.`,
    issues,
    correctiveActions: [],
    durationMs: durationMs(startedAt),
  };
}

async function resolveRepoAuditMap(
  workspaceRoot: string,
  repoRoots?: readonly string[]
): Promise<WorkspaceContractAuditEntry[]> {
  if (!repoRoots || repoRoots.length === 0) {
    return auditWorkspaceContracts(workspaceRoot, {
      requireMwt: false,
      requireWriteAccess: true,
    });
  }

  const resolvedRepoRoots = repoRoots.map((repoRoot) => resolvePath(repoRoot));
  return Promise.all(
    resolvedRepoRoots.map(async (repoRoot) => ({
      repoRoot,
      audit: await auditRepositoryContract(repoRoot, {
        requireMwt: false,
        requireWriteAccess: true,
      }),
    }))
  );
}

export async function runPreflight(
  options: PreflightOptions
): Promise<PreflightReport> {
  const startedAt = Date.now();
  const workspaceRoot = resolvePath(options.workspaceRoot);
  const skip = new Set(options.skipChecks ?? []);
  let repoAudits = await resolveRepoAuditMap(workspaceRoot, options.repoRoots);
  const checks: PreflightCheckResult[] = [];
  const bootstrapResults = new Map<
    string,
    Awaited<ReturnType<typeof ensureRepoBootstrap>>
  >();

  if (!skip.has('repo-bootstrap')) {
    const bootstrapChecks = await Promise.all(
      repoAudits.map(async (entry) => {
        if (options.applyCorrections) {
          const result = await ensureRepoBootstrap({
            workspaceRoot,
            repoRoot: entry.repoRoot,
          });
          bootstrapResults.set(entry.repoRoot, result);
          return {
            checkId: 'repo-bootstrap',
            severity: result.ready ? 'pass' : 'fail',
            target: entry.repoRoot,
            summary: result.ready
              ? result.attempted
                ? 'Repository bootstrap corrections were applied.'
                : 'Repository bootstrap is already satisfied.'
              : 'Repository bootstrap could not reach a ready state.',
            issues: result.issues,
            correctiveActions: result.managedFiles.length
              ? [
                  {
                    description: 'Apply repository bootstrap-managed files',
                    applied: result.ready && result.attempted,
                    filesChanged: sortPaths(
                      result.attempted
                        ? result.touchedFiles
                        : result.managedFiles
                    ),
                  },
                ]
              : [],
            durationMs: 0,
          } satisfies PreflightCheckResult;
        }
        return checkRepoBootstrap({
          workspaceRoot,
          repoRoot: entry.repoRoot,
          applyCorrections: false,
          existingAudit: entry.audit,
        });
      })
    );
    checks.push(...bootstrapChecks);
  }

  if (!skip.has('mwt-readiness')) {
    const bootstrapByRepo = new Map(
      checks
        .filter((check) => check.checkId === 'repo-bootstrap')
        .map((check) => [check.target, check])
    );
    checks.push(
      ...(await Promise.all(
        repoAudits.map(async (entry) => {
          return checkMwtReadiness({
            repoRoot: entry.repoRoot,
            applyCorrections: options.applyCorrections,
            bootstrapManagedFiles:
              bootstrapResults.get(entry.repoRoot)?.managedFiles ??
              bootstrapByRepo.get(entry.repoRoot)?.correctiveActions[0]
                ?.filesChanged ??
              [],
          });
        })
      ))
    );
  }

  if (options.applyCorrections) {
    repoAudits = await resolveRepoAuditMap(workspaceRoot, options.repoRoots);
  }

  if (!skip.has('repo-contract')) {
    checks.push(
      ...(await Promise.all(
        repoAudits.map((entry) =>
          checkRepoContract(entry.repoRoot, {}, entry.audit)
        )
      ))
    );
  }

  if (!skip.has('runtime-availability')) {
    checks.push(...checkRuntimeAvailability());
  }

  if (!skip.has('queue-integrity')) {
    checks.push(await checkQueueIntegrity(workspaceRoot));
  }

  const [repos, workItems, session, queue] = await Promise.all([
    readManagedRepos(workspaceRoot),
    readManagerWorkItems(workspaceRoot),
    readSession(workspaceRoot),
    readQueue(workspaceRoot),
  ]);
  const approvalQueue = deriveApprovalQueue(workItems);
  const mergeLanes = deriveMergeLanes({ repos, workItems });
  const runs = await deriveRunsForWorkspace(workspaceRoot, {
    session,
    queue,
  });
  const runtimeAvailability = listWorkerRuntimeAvailability();

  return {
    workspaceRoot,
    generatedAt: new Date().toISOString(),
    overall: summarizeOverall(checks),
    checks,
    summary: {
      inScopeRepoCount: repoAudits.length,
      invalidRepoCount: repoAudits.filter((entry) => !entry.audit.valid).length,
      approvalQueueCount: approvalQueue.length,
      runCount: runs.runs.length,
      mergeLaneCount: mergeLanes.length,
      unavailableRuntimeCount: runtimeAvailability.filter(
        (entry) => !entry.available
      ).length,
    },
    repoAudits,
    totalDurationMs: durationMs(startedAt),
  };
}

function severityMarker(severity: PreflightSeverity): string {
  switch (severity) {
    case 'pass':
      return 'OK';
    case 'warn':
      return 'WARN';
    default:
      return 'FAIL';
  }
}

export function formatPreflightReport(report: PreflightReport): string {
  const lines = [
    `workspace: ${report.workspaceRoot}`,
    `overall: ${report.overall}`,
    `repos: ${report.summary.inScopeRepoCount} (invalid: ${report.summary.invalidRepoCount})`,
    `approval queue: ${report.summary.approvalQueueCount}`,
    `runs: ${report.summary.runCount}`,
    `merge lanes: ${report.summary.mergeLaneCount}`,
    `unavailable runtimes: ${report.summary.unavailableRuntimeCount}`,
  ];

  for (const check of report.checks.sort((left, right) => {
    const severityDelta =
      severityRank(right.severity) - severityRank(left.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.target.localeCompare(right.target);
  })) {
    lines.push('');
    lines.push(
      `[${severityMarker(check.severity)}] ${check.checkId} :: ${check.target}`
    );
    lines.push(`  ${check.summary}`);
    for (const issue of check.issues) {
      lines.push(`  - ${issue}`);
    }
    for (const action of check.correctiveActions) {
      const actionState = action.applied ? 'applied' : 'available';
      const files = action.filesChanged.length
        ? ` (${action.filesChanged.join(', ')})`
        : '';
      lines.push(`  * ${actionState}: ${action.description}${files}`);
    }
  }

  return lines.join('\n');
}
