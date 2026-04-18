import { describe, expect, it } from 'vitest';
import { validateWorkspaceVerification } from '../../contracts/workspace-verification.js';

describe('workspace-verification', () => {
  it('accepts a fully green workspace verification snapshot', () => {
    expect(
      validateWorkspaceVerification({
        workspaceRoot: 'D:\\ghws',
        generatedAt: new Date().toISOString(),
        repos: [
          {
            repoRoot: 'D:\\ghws\\workspace-agent-hub',
            repoSlug: 'metyatech/workspace-agent-hub',
            contractValid: true,
            verifyPassed: true,
            impactWarnings: [],
          },
        ],
      }).valid
    ).toBe(true);
  });

  it('reports invalid repo contracts and failed verify results', () => {
    const result = validateWorkspaceVerification({
      workspaceRoot: 'D:\\ghws',
      generatedAt: new Date().toISOString(),
      repos: [
        {
          repoRoot: 'D:\\ghws\\broken',
          contractValid: false,
          verifyPassed: false,
          impactWarnings: [],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['repo-contract-invalid', 'repo-verify-failed'])
    );
  });
});
