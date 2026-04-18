import { describe, expect, it } from 'vitest';
import {
  validateRepoContract,
  type RepoContractSnapshot,
} from '../../contracts/repo-contract.js';

function validSnapshot(): RepoContractSnapshot {
  return {
    repoRoot: 'D:\\ghws\\workspace-agent-hub',
    repoSlug: 'metyatech/workspace-agent-hub',
    readmePath: 'README.md',
    licensePath: 'LICENSE',
    agentRulesetPath: 'agent-ruleset.json',
    agentsPath: 'AGENTS.md',
    claudePath: 'CLAUDE.md',
    gitignorePath: '.gitignore',
    verifyCommand: 'npm run verify',
    threadsGitignored: true,
    tasksTracked: true,
    mwtInitialized: true,
    workspaceWritable: true,
  };
}

describe('repo-contract', () => {
  it('accepts a valid writable repo snapshot', () => {
    expect(validateRepoContract(validSnapshot()).valid).toBe(true);
  });

  it('reports missing contract surfaces', () => {
    const result = validateRepoContract({
      repoRoot: 'D:\\ghws\\broken',
      readmePath: null,
      licensePath: null,
      agentRulesetPath: null,
      agentsPath: null,
      gitignorePath: null,
      verifyCommand: null,
      threadsGitignored: false,
      tasksTracked: false,
      mwtInitialized: false,
      workspaceWritable: false,
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'missing-readme',
        'missing-license',
        'missing-agent-ruleset',
        'missing-agents',
        'missing-gitignore',
        'missing-verify-command',
        'threads-not-gitignored',
        'tasks-not-tracked',
        'missing-mwt',
        'repo-not-writable',
      ])
    );
  });

  it('allows read-only repos to skip mwt and write-access requirements', () => {
    const result = validateRepoContract(
      {
        ...validSnapshot(),
        mwtInitialized: false,
        workspaceWritable: false,
      },
      { requireMwt: false, requireWriteAccess: false }
    );

    expect(result.valid).toBe(true);
  });
});
