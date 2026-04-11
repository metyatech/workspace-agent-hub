import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  DirectorySuggestion,
  HubLiveUpdateWatchConfig,
  SessionMutationResult,
  SessionRecord,
  SessionTranscript,
  SessionType,
} from './types.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_BRIDGE_SCRIPT = join(
  DEFAULT_REPO_ROOT,
  'scripts',
  'session-web-bridge.ps1'
);
const DEFAULT_POWERSHELL_COMMAND =
  process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const WORKSPACE_ROOT_ENV_VAR = 'WORKSPACE_AGENT_HUB_WORKSPACE_ROOT';

function resolveEnvOverridePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : null;
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const normalizedParent = trimTrailingSeparators(resolve(parentPath));
  const normalizedCandidate = trimTrailingSeparators(resolve(candidatePath));
  const parentLower = normalizedParent.toLowerCase();
  const candidateLower = normalizedCandidate.toLowerCase();
  return (
    candidateLower === parentLower ||
    candidateLower.startsWith(`${parentLower}\\`) ||
    candidateLower.startsWith(`${parentLower}/`)
  );
}

export function resolveWorkspaceRoot(options?: {
  workspaceRoot?: string;
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const explicitRoot = resolveEnvOverridePath(options?.workspaceRoot);
  if (explicitRoot) {
    return explicitRoot;
  }

  const envRoot = resolveEnvOverridePath(
    options?.env?.[WORKSPACE_ROOT_ENV_VAR] ??
      process.env[WORKSPACE_ROOT_ENV_VAR]
  );
  if (envRoot) {
    return envRoot;
  }

  const packageRoot = resolve(options?.packageRoot ?? DEFAULT_REPO_ROOT);
  if (isPathInside(tmpdir(), packageRoot)) {
    throw new Error(
      `Workspace root must be provided explicitly when running Workspace Agent Hub from a temporary checkout (${packageRoot}). Pass --workspace-root or set ${WORKSPACE_ROOT_ENV_VAR}.`
    );
  }

  return resolve(packageRoot, '..');
}

function resolveHubWatchRoot(
  sessionCatalogPath: string,
  sessionLiveDirPath: string
): string {
  const catalogRoot = dirname(sessionCatalogPath);
  const liveRoot = dirname(sessionLiveDirPath);
  if (catalogRoot === liveRoot) {
    return catalogRoot;
  }
  return DEFAULT_AGENT_HANDOFF_ROOT;
}

const DEFAULT_AGENT_HANDOFF_ROOT = join(
  process.env.USERPROFILE ?? homedir(),
  'agent-handoff'
);
const DEFAULT_SESSION_CATALOG_PATH =
  resolveEnvOverridePath(process.env.AI_AGENT_SESSION_CATALOG_PATH) ??
  join(DEFAULT_AGENT_HANDOFF_ROOT, 'session-catalog.json');
const DEFAULT_SESSION_LIVE_DIR_PATH =
  resolveEnvOverridePath(process.env.AI_AGENT_SESSION_LIVE_DIR_PATH) ??
  join(DEFAULT_AGENT_HANDOFF_ROOT, 'session-live');
const DEFAULT_HUB_WATCH_ROOT = resolveHubWatchRoot(
  DEFAULT_SESSION_CATALOG_PATH,
  DEFAULT_SESSION_LIVE_DIR_PATH
);

function normalizeJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [] as T;
  }
  return JSON.parse(trimmed) as T;
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function makeAutoLabel(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  const suffix = Math.random().toString(16).slice(2, 6);
  return `auto-${timestamp}-${suffix}`;
}

export interface SessionBridge {
  getWorkspaceRoot(): string;
  getHubLiveUpdateWatchConfig?(): HubLiveUpdateWatchConfig | null;
  listSessions(includeArchived?: boolean): Promise<SessionRecord[]>;
  startSession(input: {
    type: SessionType;
    title?: string;
    workingDirectory?: string;
  }): Promise<SessionRecord>;
  renameSession(
    sessionName: string,
    title: string
  ): Promise<SessionRecord | SessionMutationResult>;
  archiveSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult>;
  unarchiveSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult>;
  closeSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult>;
  deleteSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult>;
  readTranscript(
    sessionName: string,
    lines?: number
  ): Promise<SessionTranscript>;
  sendInput(
    sessionName: string,
    text: string,
    submit: boolean
  ): Promise<SessionMutationResult>;
  interruptSession(sessionName: string): Promise<SessionMutationResult>;
  listSuggestedDirectories(): Promise<DirectorySuggestion[]>;
}

export class PowerShellSessionBridge implements SessionBridge {
  #bridgeScriptPath: string;
  #workspaceRoot: string;
  #powerShellCommand: string;

  constructor(options?: {
    bridgeScriptPath?: string;
    workspaceRoot?: string;
    powerShellCommand?: string;
    packageRoot?: string;
  }) {
    this.#bridgeScriptPath = options?.bridgeScriptPath ?? DEFAULT_BRIDGE_SCRIPT;
    this.#workspaceRoot = resolveWorkspaceRoot({
      workspaceRoot: options?.workspaceRoot,
      packageRoot: options?.packageRoot ?? DEFAULT_REPO_ROOT,
    });
    this.#powerShellCommand =
      options?.powerShellCommand ?? DEFAULT_POWERSHELL_COMMAND;
  }

  getWorkspaceRoot(): string {
    return this.#workspaceRoot;
  }

  getHubLiveUpdateWatchConfig(): HubLiveUpdateWatchConfig {
    return {
      watchRootPath: DEFAULT_HUB_WATCH_ROOT,
      sessionCatalogPath: DEFAULT_SESSION_CATALOG_PATH,
      sessionLiveDirPath: DEFAULT_SESSION_LIVE_DIR_PATH,
    };
  }

  async #runBridge(
    args: string[],
    filePayloads?: Partial<Record<'TitlePath' | 'TextPath', string>>
  ): Promise<string> {
    const tempPaths: string[] = [];
    const finalArgs = [...args];

    for (const [parameterName, payloadValue] of Object.entries(
      filePayloads ?? {}
    )) {
      if (!payloadValue?.length) {
        continue;
      }

      const tempPath = join(
        tmpdir(),
        `workspace-agent-hub-${parameterName.toLowerCase()}-${randomUUID()}.txt`
      );
      await writeFile(tempPath, payloadValue, 'utf8');
      tempPaths.push(tempPath);
      finalArgs.push(`-${parameterName}`, tempPath);
    }

    try {
      const { stdout } = await execFileAsync(
        this.#powerShellCommand,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.#bridgeScriptPath,
          ...finalArgs,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        }
      );
      return stdout;
    } finally {
      await Promise.all(
        tempPaths.map((tempPath) =>
          rm(tempPath, { force: true }).catch(() => {})
        )
      );
    }
  }

  async listSessions(includeArchived = true): Promise<SessionRecord[]> {
    const args = ['-Action', 'list', '-Json'];
    if (includeArchived) {
      args.push('-IncludeArchived');
    }
    const parsed = normalizeJson<SessionRecord | SessionRecord[]>(
      await this.#runBridge(args)
    );
    return toArray(parsed);
  }

  async startSession(input: {
    type: SessionType;
    title?: string;
    workingDirectory?: string;
  }): Promise<SessionRecord> {
    const label = makeAutoLabel();
    const args = [
      '-Action',
      'start',
      '-Type',
      input.type,
      '-SessionName',
      label,
      '-Json',
    ];
    args.push(
      '-WorkingDirectory',
      input.workingDirectory?.trim() || this.#workspaceRoot
    );
    return normalizeJson<SessionRecord>(
      await this.#runBridge(args, {
        TitlePath: input.title?.trim(),
      })
    );
  }

  async renameSession(
    sessionName: string,
    title: string
  ): Promise<SessionRecord | SessionMutationResult> {
    return normalizeJson<SessionRecord | SessionMutationResult>(
      await this.#runBridge(
        ['-Action', 'rename', '-SessionName', sessionName, '-Json'],
        {
          TitlePath: title,
        }
      )
    );
  }

  async archiveSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    return normalizeJson<SessionRecord | SessionMutationResult>(
      await this.#runBridge([
        '-Action',
        'archive',
        '-SessionName',
        sessionName,
        '-Json',
      ])
    );
  }

  async unarchiveSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    return normalizeJson<SessionRecord | SessionMutationResult>(
      await this.#runBridge([
        '-Action',
        'unarchive',
        '-SessionName',
        sessionName,
        '-Json',
      ])
    );
  }

  async closeSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    return normalizeJson<SessionRecord | SessionMutationResult>(
      await this.#runBridge([
        '-Action',
        'close',
        '-SessionName',
        sessionName,
        '-Json',
      ])
    );
  }

  async deleteSession(
    sessionName: string
  ): Promise<SessionRecord | SessionMutationResult> {
    return normalizeJson<SessionRecord | SessionMutationResult>(
      await this.#runBridge([
        '-Action',
        'delete',
        '-SessionName',
        sessionName,
        '-Json',
      ])
    );
  }

  async readTranscript(
    sessionName: string,
    lines = 400
  ): Promise<SessionTranscript> {
    return normalizeJson<SessionTranscript>(
      await this.#runBridge([
        '-Action',
        'output',
        '-SessionName',
        sessionName,
        '-Lines',
        String(lines),
        '-Json',
      ])
    );
  }

  async sendInput(
    sessionName: string,
    text: string,
    submit: boolean
  ): Promise<SessionMutationResult> {
    const args = ['-Action', 'send', '-SessionName', sessionName, '-Json'];
    if (submit) {
      args.push('-Submit');
    }
    return normalizeJson<SessionMutationResult>(
      await this.#runBridge(args, {
        TextPath: text,
      })
    );
  }

  async interruptSession(sessionName: string): Promise<SessionMutationResult> {
    return normalizeJson<SessionMutationResult>(
      await this.#runBridge([
        '-Action',
        'interrupt',
        '-SessionName',
        sessionName,
        '-Json',
      ])
    );
  }

  async listSuggestedDirectories(): Promise<DirectorySuggestion[]> {
    const suggestions: DirectorySuggestion[] = [
      {
        label: 'Workspace root',
        path: this.#workspaceRoot,
      },
    ];

    for (const entry of readdirSync(this.#workspaceRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }

      const path = join(this.#workspaceRoot, entry.name);
      if (!statSync(path).isDirectory()) {
        continue;
      }

      suggestions.push({
        label: entry.name,
        path,
      });
    }

    suggestions.sort((left, right) => left.path.localeCompare(right.path));
    return suggestions;
  }
}
