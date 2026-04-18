export interface RepoContractSnapshot {
  repoRoot: string;
  repoSlug?: string | null;
  readmePath?: string | null;
  licensePath?: string | null;
  agentRulesetPath?: string | null;
  agentsPath?: string | null;
  claudePath?: string | null;
  gitignorePath?: string | null;
  verifyCommand?: string | null;
  threadsGitignored?: boolean;
  tasksTracked?: boolean;
  mwtInitialized?: boolean;
  workspaceWritable?: boolean;
}

export type RepoContractIssueCode =
  | 'missing-readme'
  | 'missing-license'
  | 'missing-agent-ruleset'
  | 'missing-agents'
  | 'missing-gitignore'
  | 'missing-verify-command'
  | 'threads-not-gitignored'
  | 'tasks-not-tracked'
  | 'missing-mwt'
  | 'repo-not-writable';

export interface RepoContractIssue {
  code: RepoContractIssueCode;
  path: string | null;
  message: string;
  fixable: boolean;
}

export interface RepoContractValidationOptions {
  requireMwt: boolean;
  requireWriteAccess: boolean;
}

export interface RepoContractValidationResult {
  valid: boolean;
  issues: RepoContractIssue[];
}

export const REPO_CONTRACT_SCHEMA = {
  type: 'object',
  required: ['repoRoot'],
  properties: {
    repoRoot: { type: 'string', minLength: 1 },
    repoSlug: { type: ['string', 'null'] },
    readmePath: { type: ['string', 'null'] },
    licensePath: { type: ['string', 'null'] },
    agentRulesetPath: { type: ['string', 'null'] },
    agentsPath: { type: ['string', 'null'] },
    claudePath: { type: ['string', 'null'] },
    gitignorePath: { type: ['string', 'null'] },
    verifyCommand: { type: ['string', 'null'] },
    threadsGitignored: { type: 'boolean' },
    tasksTracked: { type: 'boolean' },
    mwtInitialized: { type: 'boolean' },
    workspaceWritable: { type: 'boolean' },
  },
} as const;

export const DEFAULT_REPO_CONTRACT_OPTIONS: RepoContractValidationOptions = {
  requireMwt: true,
  requireWriteAccess: true,
};

function buildIssue(
  code: RepoContractIssueCode,
  path: string | null,
  message: string,
  fixable: boolean
): RepoContractIssue {
  return { code, path, message, fixable };
}

export function validateRepoContract(
  snapshot: RepoContractSnapshot,
  options: Partial<RepoContractValidationOptions> = {}
): RepoContractValidationResult {
  const resolved = { ...DEFAULT_REPO_CONTRACT_OPTIONS, ...options };
  const issues: RepoContractIssue[] = [];

  if (!snapshot.readmePath) {
    issues.push(
      buildIssue(
        'missing-readme',
        null,
        'README.md is required for every workspace repository.',
        false
      )
    );
  }

  if (!snapshot.licensePath) {
    issues.push(
      buildIssue(
        'missing-license',
        null,
        'LICENSE is required for every workspace repository.',
        true
      )
    );
  }

  if (!snapshot.agentRulesetPath) {
    issues.push(
      buildIssue(
        'missing-agent-ruleset',
        null,
        'agent-ruleset.json is required to compose repository instructions.',
        true
      )
    );
  }

  if (!snapshot.agentsPath) {
    issues.push(
      buildIssue(
        'missing-agents',
        null,
        'AGENTS.md is required and must be composed from the ruleset.',
        true
      )
    );
  }

  if (!snapshot.gitignorePath) {
    issues.push(
      buildIssue(
        'missing-gitignore',
        null,
        '.gitignore is required for artifact and thread hygiene.',
        true
      )
    );
  }

  if (!snapshot.verifyCommand?.trim()) {
    issues.push(
      buildIssue(
        'missing-verify-command',
        null,
        'A canonical repository verify command is required.',
        true
      )
    );
  }

  if (snapshot.threadsGitignored !== true) {
    issues.push(
      buildIssue(
        'threads-not-gitignored',
        snapshot.gitignorePath ?? null,
        '.threads.jsonl must be ignored by git.',
        true
      )
    );
  }

  if (snapshot.tasksTracked !== true) {
    issues.push(
      buildIssue(
        'tasks-not-tracked',
        '.tasks.jsonl',
        '.tasks.jsonl must remain tracked in version control.',
        false
      )
    );
  }

  if (resolved.requireMwt && snapshot.mwtInitialized !== true) {
    issues.push(
      buildIssue(
        'missing-mwt',
        '.mwt/config.toml',
        'Managed worktree bootstrap is required for writable repositories.',
        false
      )
    );
  }

  if (resolved.requireWriteAccess && snapshot.workspaceWritable !== true) {
    issues.push(
      buildIssue(
        'repo-not-writable',
        snapshot.repoRoot,
        'The repository is not writable by the current workspace policy.',
        false
      )
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
