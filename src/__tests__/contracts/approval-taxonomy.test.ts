import { describe, expect, it } from 'vitest';
import { classifyApprovalOperation } from '../../contracts/approval-taxonomy.js';

describe('approval-taxonomy', () => {
  it('classifies irreversible operations as human-gated', () => {
    expect(classifyApprovalOperation('repository-delete').category).toBe(
      'always-require-human'
    );
    expect(classifyApprovalOperation('force-push-default').category).toBe(
      'always-require-human'
    );
  });

  it('classifies operational delivery work as manager-auto-approved', () => {
    expect(classifyApprovalOperation('mwt-deliver').category).toBe(
      'manager-auto-approved'
    );
    expect(classifyApprovalOperation('branch-delete').category).toBe(
      'manager-auto-approved'
    );
  });

  it('classifies mechanical actions as never-needs-human', () => {
    expect(classifyApprovalOperation('compose-regenerate').category).toBe(
      'never-needs-human'
    );
    expect(classifyApprovalOperation('read-query').category).toBe(
      'never-needs-human'
    );
  });
});
