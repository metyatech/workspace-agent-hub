export interface WorkspaceVerificationRepoResult {
  repoRoot: string;
  repoSlug?: string | null;
  contractValid: boolean;
  verifyPassed: boolean;
  impactWarnings: string[];
}

export interface WorkspaceVerificationSnapshot {
  workspaceRoot: string;
  generatedAt: string;
  repos: WorkspaceVerificationRepoResult[];
}

export type WorkspaceVerificationIssueCode =
  | 'missing-workspace-root'
  | 'missing-generated-at'
  | 'no-repo-results'
  | 'repo-contract-invalid'
  | 'repo-verify-failed';

export interface WorkspaceVerificationIssue {
  code: WorkspaceVerificationIssueCode;
  repoRoot: string | null;
  message: string;
}

export interface WorkspaceVerificationResult {
  valid: boolean;
  issues: WorkspaceVerificationIssue[];
}

export const WORKSPACE_VERIFICATION_SCHEMA = {
  type: 'object',
  required: ['workspaceRoot', 'generatedAt', 'repos'],
  properties: {
    workspaceRoot: { type: 'string', minLength: 1 },
    generatedAt: { type: 'string', minLength: 1 },
    repos: { type: 'array' },
  },
} as const;

export function validateWorkspaceVerification(
  snapshot: WorkspaceVerificationSnapshot
): WorkspaceVerificationResult {
  const issues: WorkspaceVerificationIssue[] = [];

  if (!snapshot.workspaceRoot.trim()) {
    issues.push({
      code: 'missing-workspace-root',
      repoRoot: null,
      message: 'workspaceRoot is required.',
    });
  }

  if (!snapshot.generatedAt.trim()) {
    issues.push({
      code: 'missing-generated-at',
      repoRoot: null,
      message: 'generatedAt is required.',
    });
  }

  if (snapshot.repos.length === 0) {
    issues.push({
      code: 'no-repo-results',
      repoRoot: null,
      message: 'At least one repo verification result is required.',
    });
  }

  for (const repo of snapshot.repos) {
    if (!repo.contractValid) {
      issues.push({
        code: 'repo-contract-invalid',
        repoRoot: repo.repoRoot,
        message: 'The repository contract is not satisfied.',
      });
    }
    if (!repo.verifyPassed) {
      issues.push({
        code: 'repo-verify-failed',
        repoRoot: repo.repoRoot,
        message: 'The repository verification command failed.',
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
