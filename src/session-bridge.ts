import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DirectorySuggestion,
  SessionMutationResult,
  SessionRecord,
  SessionTranscript,
  SessionType,
} from './types.js';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_REPO_ROOT = resolve(__dirname, '..');
const DEFAULT_WORKSPACE_ROOT = resolve(DEFAULT_REPO_ROOT, '..');
const DEFAULT_BRIDGE_SCRIPT = join(
  DEFAULT_REPO_ROOT,
  'scripts',
  'session-web-bridge.ps1'
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

  constructor(options?: { bridgeScriptPath?: string; workspaceRoot?: string }) {
    this.#bridgeScriptPath = options?.bridgeScriptPath ?? DEFAULT_BRIDGE_SCRIPT;
    this.#workspaceRoot = options?.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  }

  getWorkspaceRoot(): string {
    return this.#workspaceRoot;
  }

  async #runBridge(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.#bridgeScriptPath,
        ...args,
      ],
      {
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }
    );
    return stdout;
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
    if (input.title?.trim()) {
      args.push('-Title', input.title.trim());
    }
    args.push(
      '-WorkingDirectory',
      input.workingDirectory?.trim() || this.#workspaceRoot
    );
    return normalizeJson<SessionRecord>(await this.#runBridge(args));
  }

  async renameSession(
    sessionName: string,
    title: string
  ): Promise<SessionRecord | SessionMutationResult> {
    return normalizeJson<SessionRecord | SessionMutationResult>(
      await this.#runBridge([
        '-Action',
        'rename',
        '-SessionName',
        sessionName,
        '-Title',
        title,
        '-Json',
      ])
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
    const args = [
      '-Action',
      'send',
      '-SessionName',
      sessionName,
      '-Text',
      text,
      '-Json',
    ];
    if (submit) {
      args.push('-Submit');
    }
    return normalizeJson<SessionMutationResult>(await this.#runBridge(args));
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
