import type { ManagerThreadView } from './manager-thread-state.js';

export type ApprovalQueueKind =
  | 'routing-confirmation'
  | 'human-reply'
  | 'delivery-confirmation'
  | 'recovery-needed';

export interface ApprovalQueueItem {
  threadId: string;
  title: string;
  kind: ApprovalQueueKind;
  repoRoot: string | null;
  reason: string;
  createdAt: string;
}

export function deriveApprovalQueue(
  workItems: ManagerThreadView[]
): ApprovalQueueItem[] {
  return workItems
    .flatMap((item): ApprovalQueueItem[] => {
      if (item.uiState === 'routing-confirmation-needed') {
        return [
          {
            threadId: item.id,
            title: item.title,
            kind: 'routing-confirmation',
            repoRoot: item.managedRepoRoot,
            reason:
              item.routingHint ??
              item.canonicalStateReason ??
              'Routing confirmation is required.',
            createdAt: item.updatedAt,
          },
        ];
      }
      if (item.seedRecoveryPending) {
        return [
          {
            threadId: item.id,
            title: item.title,
            kind: 'recovery-needed',
            repoRoot: item.managedRepoRoot,
            reason: item.canonicalStateReason ?? 'Manual recovery is required.',
            createdAt: item.updatedAt,
          },
        ];
      }
      if (item.uiState === 'ai-finished-awaiting-user-confirmation') {
        return [
          {
            threadId: item.id,
            title: item.title,
            kind: 'delivery-confirmation',
            repoRoot: item.managedRepoRoot,
            reason:
              item.canonicalStateReason ??
              'AI completed work and is awaiting confirmation.',
            createdAt: item.updatedAt,
          },
        ];
      }
      if (item.uiState === 'user-reply-needed') {
        return [
          {
            threadId: item.id,
            title: item.title,
            kind: 'human-reply',
            repoRoot: item.managedRepoRoot,
            reason:
              item.canonicalStateReason ??
              'A human reply is required before work can continue.',
            createdAt: item.updatedAt,
          },
        ];
      }
      return [];
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
