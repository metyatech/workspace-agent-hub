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

export interface WebUiConfigBootstrap {
  authRequired: boolean;
  authStorageKey: string;
  workspaceRoot: string;
}
