import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  auditRepositoryContractMock,
  auditWorkspaceContractsMock,
  ensureRepoBootstrapMock,
  isManagedWorktreeRepositoryMock,
  maybeAutoInitializeManagerRepositoryMock,
  readQueueMock,
  readSessionMock,
  readManagedReposMock,
  readManagerWorkItemsMock,
  deriveApprovalQueueMock,
  deriveMergeLanesMock,
  deriveRunsForWorkspaceMock,
  listWorkerRuntimeAvailabilityMock,
} = vi.hoisted(() => ({
  auditRepositoryContractMock: vi.fn(),
  auditWorkspaceContractsMock: vi.fn(),
  ensureRepoBootstrapMock: vi.fn(),
  isManagedWorktreeRepositoryMock: vi.fn(),
  maybeAutoInitializeManagerRepositoryMock: vi.fn(),
  readQueueMock: vi.fn(),
  readSessionMock: vi.fn(),
  readManagedReposMock: vi.fn(),
  readManagerWorkItemsMock: vi.fn(),
  deriveApprovalQueueMock: vi.fn(),
  deriveMergeLanesMock: vi.fn(),
  deriveRunsForWorkspaceMock: vi.fn(),
  listWorkerRuntimeAvailabilityMock: vi.fn(),
}));

vi.mock('../repo-auditor.js', () => ({
  auditRepositoryContract: auditRepositoryContractMock,
  auditWorkspaceContracts: auditWorkspaceContractsMock,
}));

vi.mock('../repo-bootstrap.js', () => ({
  ensureRepoBootstrap: ensureRepoBootstrapMock,
}));

vi.mock('../manager-mwt.js', () => ({
  isManagedWorktreeRepository: isManagedWorktreeRepositoryMock,
  maybeAutoInitializeManagerRepository:
    maybeAutoInitializeManagerRepositoryMock,
}));

vi.mock('../manager-backend.js', () => ({
  readQueue: readQueueMock,
  readSession: readSessionMock,
}));

vi.mock('../manager-repos.js', () => ({
  readManagedRepos: readManagedReposMock,
}));

vi.mock('../manager-work-items.js', () => ({
  readManagerWorkItems: readManagerWorkItemsMock,
}));

vi.mock('../approval-queue.js', () => ({
  deriveApprovalQueue: deriveApprovalQueueMock,
}));

vi.mock('../merge-lanes.js', () => ({
  deriveMergeLanes: deriveMergeLanesMock,
}));

vi.mock('../runs.js', () => ({
  deriveRunsForWorkspace: deriveRunsForWorkspaceMock,
}));

vi.mock('../worker-adapter/availability.js', () => ({
  listWorkerRuntimeAvailability: listWorkerRuntimeAvailabilityMock,
}));

import {
  checkMwtReadiness,
  checkQueueIntegrity,
  checkRepoBootstrap,
  checkRepoContract,
  checkRuntimeAvailability,
  formatPreflightReport,
  runPreflight,
  type PreflightReport,
} from '../preflight.js';

describe('preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readManagedReposMock.mockResolvedValue([]);
    readManagerWorkItemsMock.mockResolvedValue([]);
    deriveApprovalQueueMock.mockReturnValue([]);
    deriveMergeLanesMock.mockReturnValue([]);
    deriveRunsForWorkspaceMock.mockResolvedValue({ runs: [] });
    listWorkerRuntimeAvailabilityMock.mockReturnValue([
      { runtime: 'opencode', available: true, detail: 'ok' },
      { runtime: 'codex', available: false, detail: 'missing codex' },
    ]);
    readSessionMock.mockResolvedValue({
      status: 'idle',
      dispatchingThreadId: null,
      dispatchingQueueEntryIds: null,
      pid: null,
      activeAssignments: [],
    });
    readQueueMock.mockResolvedValue([]);
  });

  it('maps repo contract issues into fail severity and corrective actions', async () => {
    auditRepositoryContractMock.mockResolvedValue({
      valid: false,
      snapshot: { repoRoot: 'D:\\ghws\\demo' },
      issues: [
        {
          code: 'missing-agent-ruleset',
          path: 'agent-ruleset.json',
          message: 'agent-ruleset.json is required',
          fixable: true,
        },
        {
          code: 'tasks-not-tracked',
          path: '.tasks.jsonl',
          message: '.tasks.jsonl must remain tracked',
          fixable: false,
        },
      ],
    });

    const result = await checkRepoContract('D:\\ghws\\demo');

    expect(result.severity).toBe('fail');
    expect(result.issues).toEqual([
      'missing-agent-ruleset: agent-ruleset.json is required',
      'tasks-not-tracked: .tasks.jsonl must remain tracked',
    ]);
    expect(result.correctiveActions).toEqual([
      {
        description: 'Resolve missing-agent-ruleset',
        applied: false,
        filesChanged: ['agent-ruleset.json'],
      },
    ]);
  });

  it('reports bootstrap prerequisites without mutating when applyCorrections is false', async () => {
    const audit = {
      valid: false,
      snapshot: { repoRoot: 'D:\\ghws\\demo' },
      issues: [
        {
          code: 'missing-agent-ruleset' as const,
          path: 'agent-ruleset.json',
          message: 'agent-ruleset.json is required',
          fixable: true,
        },
        {
          code: 'missing-mwt' as const,
          path: '.mwt/config.toml',
          message: 'Managed worktree bootstrap is required',
          fixable: false,
        },
      ],
    };

    const result = await checkRepoBootstrap({
      workspaceRoot: 'D:\\ghws',
      repoRoot: 'D:\\ghws\\demo',
      applyCorrections: false,
      existingAudit: audit,
    });

    expect(ensureRepoBootstrapMock).not.toHaveBeenCalled();
    expect(result.severity).toBe('fail');
    expect(result.issues).toEqual([
      'missing-agent-ruleset: agent-ruleset.json is required',
    ]);
    expect(result.correctiveActions[0]).toMatchObject({
      description: 'Run repository bootstrap-managed setup',
      applied: false,
    });
  });

  it('uses safe mwt auto-init and records applied files when corrections are enabled', async () => {
    isManagedWorktreeRepositoryMock.mockResolvedValue(false);
    maybeAutoInitializeManagerRepositoryMock.mockResolvedValue({
      initialized: true,
      reasonId: null,
      detail: 'initialized',
      defaultBranch: 'main',
      remoteName: 'origin',
      changedFiles: ['.mwt/config.toml', '.gitignore'],
      onboardingCommit: 'abc12345',
    });

    const result = await checkMwtReadiness({
      repoRoot: 'D:\\ghws\\demo',
      applyCorrections: true,
      bootstrapManagedFiles: ['.gitignore', '.tasks.jsonl'],
    });

    expect(result.severity).toBe('pass');
    expect(result.correctiveActions).toEqual([
      {
        description: 'Attempt safe mwt auto-initialization',
        applied: true,
        filesChanged: ['.gitignore', '.mwt/config.toml'],
      },
    ]);
  });

  it('detects queue integrity drift without attempting recovery', async () => {
    readSessionMock.mockResolvedValue({
      status: 'busy',
      dispatchingThreadId: 'thread-1',
      dispatchingQueueEntryIds: ['q-missing'],
      pid: null,
      activeAssignments: [],
    });
    readQueueMock.mockResolvedValue([{ id: 'q-1' }, { id: 'q-1' }]);

    const result = await checkQueueIntegrity('D:\\ghws');

    expect(result.severity).toBe('warn');
    expect(result.issues).toEqual([
      'duplicate-queue-id: q-1',
      'dispatching-thread-has-no-queue-entry',
    ]);
    expect(result.correctiveActions).toEqual([]);
  });

  it('composes a preflight report and respects skipChecks', async () => {
    auditWorkspaceContractsMock
      .mockResolvedValueOnce([
        {
          repoRoot: 'D:\\ghws\\repo-a',
          audit: {
            valid: false,
            snapshot: { repoRoot: 'D:\\ghws\\repo-a' },
            issues: [],
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          repoRoot: 'D:\\ghws\\repo-a',
          audit: {
            valid: true,
            snapshot: { repoRoot: 'D:\\ghws\\repo-a' },
            issues: [],
          },
        },
      ]);
    ensureRepoBootstrapMock.mockResolvedValue({
      ready: true,
      attempted: true,
      repoRoot: 'D:\\ghws\\repo-a',
      detail: 'bootstrapped',
      issues: [],
      touchedFiles: ['agent-ruleset.json'],
      managedFiles: ['agent-ruleset.json', '.gitignore'],
    });
    isManagedWorktreeRepositoryMock.mockResolvedValue(false);
    maybeAutoInitializeManagerRepositoryMock.mockResolvedValue({
      initialized: false,
      reasonId: 'init_requires_clean_repo',
      detail: 'repo not clean',
      defaultBranch: 'main',
      remoteName: 'origin',
      changedFiles: ['.gitignore'],
      onboardingCommit: null,
    });
    deriveApprovalQueueMock.mockReturnValue([{ id: 'approval' }]);
    deriveMergeLanesMock.mockReturnValue([{ id: 'lane' }]);
    deriveRunsForWorkspaceMock.mockResolvedValue({ runs: [{ id: 'run-1' }] });

    const report = await runPreflight({
      workspaceRoot: 'D:\\ghws',
      applyCorrections: true,
      skipChecks: ['queue-integrity'],
    });

    expect(report.overall).toBe('fail');
    expect(report.summary).toEqual({
      inScopeRepoCount: 1,
      invalidRepoCount: 0,
      approvalQueueCount: 1,
      runCount: 1,
      mergeLaneCount: 1,
      unavailableRuntimeCount: 1,
    });
    expect(
      report.checks.some((check) => check.checkId === 'queue-integrity')
    ).toBe(false);
    expect(
      report.checks.find((check) => check.checkId === 'mwt-readiness')
    ).toMatchObject({
      severity: 'warn',
      issues: ['init_requires_clean_repo'],
    });
  });

  it('formats a report with severity markers and corrective actions', () => {
    const report: PreflightReport = {
      workspaceRoot: 'D:\\ghws',
      generatedAt: '2026-04-19T00:00:00.000Z',
      overall: 'warn',
      checks: [
        {
          checkId: 'mwt-readiness',
          severity: 'warn',
          target: 'D:\\ghws\\repo-a',
          summary: 'mwt requires attention',
          issues: ['missing-mwt'],
          correctiveActions: [
            {
              description: 'Attempt safe mwt auto-initialization',
              applied: false,
              filesChanged: ['.mwt/config.toml'],
            },
          ],
          durationMs: 5,
        },
      ],
      summary: {
        inScopeRepoCount: 1,
        invalidRepoCount: 1,
        approvalQueueCount: 0,
        runCount: 0,
        mergeLaneCount: 0,
        unavailableRuntimeCount: 1,
      },
      repoAudits: [],
      totalDurationMs: 10,
    };

    expect(formatPreflightReport(report)).toContain(
      '[WARN] mwt-readiness :: D:\\ghws\\repo-a'
    );
    expect(formatPreflightReport(report)).toContain(
      '* available: Attempt safe mwt auto-initialization (.mwt/config.toml)'
    );
  });

  it('returns one runtime check per known runtime', () => {
    const checks = checkRuntimeAvailability();

    expect(checks).toHaveLength(2);
    expect(checks[1]).toMatchObject({
      checkId: 'runtime-availability',
      target: 'codex',
      severity: 'fail',
    });
  });
});
