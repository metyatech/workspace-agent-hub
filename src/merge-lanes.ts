import type { ManagedRepoConfig } from './manager-repos.js';
import type { MergeLaneRecord, MergeLaneState } from './merge-lane/types.js';
import type { ManagerThreadView } from './manager-thread-state.js';

function deriveLaneState(
  repo: ManagedRepoConfig,
  workItems: ManagerThreadView[]
): MergeLaneState {
  const repoItems = workItems.filter(
    (item) => item.managedRepoRoot === repo.repoRoot
  );
  if (repoItems.some((item) => item.seedRecoveryPending)) {
    return 'needs-human';
  }
  if (
    repoItems.some(
      (item) => item.uiState === 'ai-working' || item.uiState === 'ai-starting'
    )
  ) {
    return 'merging';
  }
  return 'idle';
}

export function deriveMergeLanes(input: {
  repos: ManagedRepoConfig[];
  workItems: ManagerThreadView[];
}): MergeLaneRecord[] {
  return input.repos.map((repo) => {
    const queueDepth = input.workItems
      .filter((item) => item.managedRepoRoot === repo.repoRoot)
      .reduce((sum, item) => sum + item.queueDepth, 0);
    const activeRunId =
      input.workItems.find(
        (item) =>
          item.managedRepoRoot === repo.repoRoot &&
          (item.uiState === 'ai-working' || item.uiState === 'ai-starting')
      )?.workerAgentId ?? null;

    return {
      repoRoot: repo.repoRoot,
      state: deriveLaneState(repo, input.workItems),
      queueDepth,
      activeRunId,
    };
  });
}
