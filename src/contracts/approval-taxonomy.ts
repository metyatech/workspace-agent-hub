export type ApprovalCategory =
  | 'always-require-human'
  | 'manager-auto-approved'
  | 'never-needs-human';

export type ApprovalOperation =
  | 'repository-delete'
  | 'force-push-default'
  | 'npm-publish-first'
  | 'github-release-create'
  | 'secret-rotation'
  | 'cross-repo-breaking-change'
  | 'mwt-deliver'
  | 'mwt-prune'
  | 'branch-delete'
  | 'compose-regenerate'
  | 'task-tracker-write'
  | 'read-query';

export interface ApprovalDecision {
  operation: ApprovalOperation;
  category: ApprovalCategory;
  reason: string;
}

export const APPROVAL_TAXONOMY_SCHEMA = {
  type: 'object',
  required: ['operation', 'category', 'reason'],
  properties: {
    operation: { type: 'string' },
    category: {
      enum: [
        'always-require-human',
        'manager-auto-approved',
        'never-needs-human',
      ],
    },
    reason: { type: 'string', minLength: 1 },
  },
} as const;

export function classifyApprovalOperation(
  operation: ApprovalOperation
): ApprovalDecision {
  switch (operation) {
    case 'repository-delete':
    case 'force-push-default':
    case 'npm-publish-first':
    case 'github-release-create':
    case 'secret-rotation':
    case 'cross-repo-breaking-change':
      return {
        operation,
        category: 'always-require-human',
        reason:
          'This operation is destructive, externally visible, or difficult to reverse.',
      };
    case 'mwt-deliver':
    case 'mwt-prune':
    case 'branch-delete':
      return {
        operation,
        category: 'manager-auto-approved',
        reason:
          'This operation is operationally necessary and safe when upstream verification already passed.',
      };
    case 'compose-regenerate':
    case 'task-tracker-write':
    case 'read-query':
      return {
        operation,
        category: 'never-needs-human',
        reason:
          'This operation is mechanical or read-only and should never block automation.',
      };
  }
}
