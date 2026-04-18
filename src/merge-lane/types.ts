export type MergeLaneState =
  | 'idle'
  | 'merging'
  | 'verifying'
  | 'pushing'
  | 'syncing'
  | 'releasing'
  | 'conflict-resolving'
  | 'needs-human';

export interface MergeLaneRecord {
  repoRoot: string;
  state: MergeLaneState;
  queueDepth: number;
  activeRunId: string | null;
}

export const MERGE_LANE_ALLOWED_TRANSITIONS: Record<
  MergeLaneState,
  MergeLaneState[]
> = {
  idle: ['merging'],
  merging: ['verifying', 'conflict-resolving', 'needs-human'],
  verifying: ['pushing', 'needs-human'],
  pushing: ['syncing', 'needs-human'],
  syncing: ['releasing', 'idle', 'needs-human'],
  releasing: ['idle', 'needs-human'],
  'conflict-resolving': ['verifying', 'needs-human'],
  'needs-human': ['merging', 'idle'],
};

export function canTransitionMergeLaneState(
  from: MergeLaneState,
  to: MergeLaneState
): boolean {
  return MERGE_LANE_ALLOWED_TRANSITIONS[from].includes(to);
}
