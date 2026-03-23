export type SessionType = 'codex' | 'claude' | 'gemini' | 'shell';

export interface SessionRecord {
  Name: string;
  Type: SessionType | 'unknown';
  DisplayName: string;
  Distro: string;
  CreatedUnix: number;
  CreatedLocal: string;
  AttachedClients: number;
  WindowCount: number;
  LastActivityUnix: number;
  LastActivityLocal: string;
  Title: string;
  WorkingDirectoryWindows: string;
  PreviewText: string;
  Archived: boolean;
  ClosedUtc: string;
  IsLive: boolean;
  State: string;
  SortUnix: number;
  DisplayTitle: string;
}

export interface SessionTranscript {
  SessionName: string;
  WorkingDirectoryWsl: string;
  Transcript: string;
  CapturedAtUtc: string;
}

export interface HubLiveSnapshotPayload {
  kind: 'snapshot';
  emittedAt: string;
  sessions: SessionRecord[];
  selectedSessionName: string | null;
  selectedTranscript: SessionTranscript | null;
  selectedSessionMissing: boolean;
}

export interface HubLiveUpdateWatchConfig {
  watchRootPath: string;
  sessionCatalogPath: string;
  sessionLiveDirPath: string;
}

export interface SessionMutationResult {
  SessionName?: string;
  Deleted?: boolean;
  Interrupted?: boolean;
  Submitted?: boolean;
  Action?: string;
}

export interface DirectorySuggestion {
  label: string;
  path: string;
}

export type PreferredConnectUrlSource =
  | 'listen-url'
  | 'public-url'
  | 'tailscale-direct'
  | 'tailscale-serve';

export interface TailscaleConnectInfo {
  dnsName: string;
  directConnectUrl: string | null;
  secureConnectUrl: string;
  serveCommand: string;
  serveEnabled: boolean;
  serveFallbackReason: string | null;
  serveSetupUrl: string | null;
}

export interface WebUiConfigBootstrap {
  authRequired: boolean;
  authStorageKey: string;
  workspaceRoot: string;
  preferredConnectUrl: string | null;
  preferredConnectUrlSource: PreferredConnectUrlSource;
  tailscaleDirectUrl: string | null;
  tailscaleSecureUrl: string | null;
  tailscaleServeCommand: string | null;
  tailscaleServeFallbackReason: string | null;
  tailscaleServeSetupUrl: string | null;
}
