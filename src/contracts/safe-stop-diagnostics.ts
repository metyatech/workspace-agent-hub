export interface SafeStopBlocker {
  summary: string;
  failed: string;
  attempted: string;
  nextAction: string;
}

export interface SafeStopProcessOutcome {
  pid: number;
  detail: string;
}

export interface SafeStopDiagnosticReport {
  trigger:
    | 'graceful-shutdown'
    | 'preflight-block'
    | 'paused-worktree-block'
    | 'mwt-auto-init-block'
    | 'quota-pause';
  blockers: SafeStopBlocker[];
  killedProcesses: SafeStopProcessOutcome[];
  survivingProcesses: SafeStopProcessOutcome[];
  summary: string;
}

export function formatSafeStopBlockerMessage(input: {
  header: string;
  blocker: SafeStopBlocker;
}): string {
  return [
    `[Manager] ${input.header}`,
    `何が失敗したか: ${input.blocker.failed}`,
    `自動で試したこと: ${input.blocker.attempted}`,
    `次にやること: ${input.blocker.nextAction}`,
  ].join('\n');
}
