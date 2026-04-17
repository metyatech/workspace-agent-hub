import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, posix as posixPath, win32 as win32Path } from 'node:path';
import type { ManagerWorkerLiveEntry } from './manager-thread-state.js';
import type { ManagerRunMode, ManagerWorkerRuntime } from './manager-repos.js';
import { wrapWindowsBatchCommandForSpawn } from './windows-batch-spawn.js';

export interface WorkerRuntimeProgressState {
  sessionId: string | null;
  latestText: string | null;
  liveEntries: ManagerWorkerLiveEntry[];
}

export interface WorkerRuntimeParsedOutput {
  text: string;
  sessionId: string | null;
}

export interface WorkerRuntimeLaunchSpec {
  runtime: ManagerWorkerRuntime;
  command: string;
  args: string[];
  prompt: string | null;
  sessionId: string | null;
  displayLabel: string;
  spawnOptions: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: boolean;
    windowsVerbatimArguments: boolean;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide: boolean;
  };
}

const GIT_CONTEXT_ENV_KEYS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_SUPER_PREFIX',
  'GIT_WORK_TREE',
] as const;

function sanitizeAgentEnv(
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of GIT_CONTEXT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function runtimeCommand(
  runtime: ManagerWorkerRuntime,
  options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
): string {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const override = (
    runtime === 'opencode'
      ? (env.WORKSPACE_AGENT_HUB_OPENCODE_PATH ??
        env.AGENT_OPENCODE_PATH ??
        env.OPENCODE_PATH)
      : runtime === 'claude'
        ? (env.WORKSPACE_AGENT_HUB_CLAUDE_PATH ??
          env.AGENT_CLAUDE_PATH ??
          env.CLAUDE_PATH)
        : runtime === 'copilot'
          ? (env.WORKSPACE_AGENT_HUB_COPILOT_PATH ??
            env.AGENT_COPILOT_PATH ??
            env.COPILOT_PATH)
          : runtime === 'gemini'
            ? (env.WORKSPACE_AGENT_HUB_GEMINI_PATH ??
              env.AGENT_GEMINI_PATH ??
              env.GEMINI_PATH)
            : (env.WORKSPACE_AGENT_HUB_CODEX_PATH ??
              env.AGENT_CODEX_PATH ??
              env.CODEX_PATH)
  )?.trim();
  if (override) {
    return override;
  }

  if (runtime === 'opencode') {
    if (platform === 'win32') {
      const roamingAppData =
        env.APPDATA?.trim() ||
        (env.USERPROFILE?.trim()
          ? join(env.USERPROFILE.trim(), 'AppData', 'Roaming')
          : '');
      if (roamingAppData) {
        const opencodeCmd = join(roamingAppData, 'npm', 'opencode.cmd');
        if (existsSync(opencodeCmd)) {
          return opencodeCmd;
        }
      }
      return 'opencode.cmd';
    }
    return 'opencode';
  }

  if (runtime === 'codex') {
    if (platform === 'win32') {
      const roamingAppData =
        env.APPDATA?.trim() ||
        (env.USERPROFILE?.trim()
          ? join(env.USERPROFILE.trim(), 'AppData', 'Roaming')
          : '');
      if (roamingAppData) {
        const codexCmd = join(roamingAppData, 'npm', 'codex.cmd');
        if (existsSync(codexCmd)) {
          return codexCmd;
        }
      }
      return 'codex.cmd';
    }
    return 'codex';
  }

  if (runtime === 'gemini') {
    return platform === 'win32' ? 'gemini.cmd' : 'gemini';
  }
  if (runtime === 'copilot') {
    return platform === 'win32' ? 'copilot.exe' : 'copilot';
  }
  return platform === 'win32' ? 'claude.exe' : 'claude';
}

function envPathValue(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? '';
}

function pathListDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

function pathApiForPlatform(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32Path : posixPath;
}

function pathHasDirectoryPart(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function commandPathExists(commandPath: string): boolean {
  try {
    return statSync(commandPath).isFile();
  } catch {
    return false;
  }
}

function windowsPathExtensions(
  command: string,
  env: NodeJS.ProcessEnv
): string[] {
  const parsedExtension = win32Path.extname(command);
  if (parsedExtension) {
    return [''];
  }
  const raw = env.PATHEXT?.trim() || '.COM;.EXE;.BAT;.CMD';
  const extensions = raw
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return extensions.length > 0 ? extensions : ['.COM', '.EXE', '.BAT', '.CMD'];
}

function resolveCommandPath(input: {
  command: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): string | null {
  const command = input.command.trim();
  if (!command) {
    return null;
  }

  const pathApi = pathApiForPlatform(input.platform);
  if (pathApi.isAbsolute(command) || pathHasDirectoryPart(command)) {
    return commandPathExists(command) ? command : null;
  }

  const pathEntries = envPathValue(input.env)
    .split(pathListDelimiter(input.platform))
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (pathEntries.length === 0) {
    return null;
  }

  for (const pathEntry of pathEntries) {
    const candidate = pathApi.join(pathEntry, command);
    if (commandPathExists(candidate)) {
      return candidate;
    }
    if (input.platform === 'win32') {
      for (const extension of windowsPathExtensions(command, input.env)) {
        if (!extension) {
          continue;
        }
        const extendedCandidate = `${candidate}${extension}`;
        if (commandPathExists(extendedCandidate)) {
          return extendedCandidate;
        }
      }
    }
  }

  return null;
}

export interface WorkerRuntimeCliAvailability {
  runtime: ManagerWorkerRuntime;
  command: string;
  resolvedPath: string | null;
  available: boolean;
  detail: string;
}

export function describeWorkerRuntimeCliAvailability(
  runtime: ManagerWorkerRuntime,
  options?: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
): WorkerRuntimeCliAvailability {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  const command = runtimeCommand(runtime, { platform, env });
  const resolvedPath = resolveCommandPath({ command, platform, env });
  const displayName = runtimeDisplayName(runtime);
  return {
    runtime,
    command,
    resolvedPath,
    available: resolvedPath !== null,
    detail:
      resolvedPath !== null
        ? `${displayName} CLI found at ${resolvedPath}.`
        : `${displayName} CLI command "${command}" was not found in PATH or at the configured override path.`,
  };
}

function runtimeModel(
  runtime: ManagerWorkerRuntime,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (runtime === 'claude') {
    return env.WORKSPACE_AGENT_HUB_CLAUDE_MODEL?.trim() || 'claude-sonnet-4-6';
  }
  if (runtime === 'opencode') {
    return env.WORKSPACE_AGENT_HUB_OPENCODE_MODEL?.trim() || '';
  }
  if (runtime === 'gemini') {
    return (
      env.WORKSPACE_AGENT_HUB_GEMINI_MODEL?.trim() || 'gemini-3-pro-preview'
    );
  }
  if (runtime === 'copilot') {
    return env.WORKSPACE_AGENT_HUB_COPILOT_MODEL?.trim() || 'gpt-5.4';
  }
  return env.WORKSPACE_AGENT_HUB_CODEX_MODEL?.trim() || 'gpt-5.4';
}

function runtimeEffort(
  runtime: ManagerWorkerRuntime,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  if (runtime === 'claude') {
    return env.WORKSPACE_AGENT_HUB_CLAUDE_EFFORT?.trim() || 'medium';
  }
  if (runtime === 'opencode') {
    return (
      env.WORKSPACE_AGENT_HUB_OPENCODE_VARIANT?.trim() ||
      env.WORKSPACE_AGENT_HUB_OPENCODE_EFFORT?.trim() ||
      null
    );
  }
  if (runtime === 'copilot') {
    return env.WORKSPACE_AGENT_HUB_COPILOT_EFFORT?.trim() || 'high';
  }
  if (runtime === 'codex') {
    return env.WORKSPACE_AGENT_HUB_CODEX_EFFORT?.trim() || 'xhigh';
  }
  return null;
}

function runtimeDisplayName(runtime: ManagerWorkerRuntime): string {
  return runtime === 'opencode'
    ? 'OpenCode'
    : runtime === 'claude'
      ? 'Claude'
      : runtime === 'copilot'
        ? 'Copilot'
        : runtime === 'gemini'
          ? 'Gemini'
          : 'Codex';
}

export interface WorkerRuntimeModelSelection {
  model: string;
  effort: string | null;
}

export function workerRuntimeDefaults(
  runtime: ManagerWorkerRuntime,
  env: NodeJS.ProcessEnv = process.env
): WorkerRuntimeModelSelection {
  return {
    model: runtimeModel(runtime, env),
    effort: runtimeEffort(runtime, env),
  };
}

export function workerRuntimeAssigneeLabel(
  runtime: ManagerWorkerRuntime,
  env: NodeJS.ProcessEnv = process.env,
  selection?: {
    model?: string | null;
    effort?: string | null;
  } | null
): string {
  const runtimeLabel = `Worker ${runtimeDisplayName(runtime)}`;
  if (
    !selection ||
    (!selection.model?.trim() &&
      !Object.prototype.hasOwnProperty.call(selection, 'effort'))
  ) {
    return runtimeLabel;
  }
  const defaults = workerRuntimeDefaults(runtime, env);
  const model = selection?.model?.trim() || defaults.model;
  const effort =
    selection && Object.prototype.hasOwnProperty.call(selection, 'effort')
      ? selection.effort?.trim() || null
      : defaults.effort;
  if (!model && !effort) {
    return runtimeLabel;
  }
  return effort
    ? `${runtimeLabel} ${model} (${effort})`
    : `${runtimeLabel} ${model}`;
}

function buildLaunchSpec(
  command: string,
  args: string[],
  resolvedDir: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Pick<WorkerRuntimeLaunchSpec, 'command' | 'args' | 'spawnOptions'> {
  const wrappedCommand = wrapWindowsBatchCommandForSpawn(command, args, {
    platform,
    env,
  });
  return {
    command: wrappedCommand.command,
    args: wrappedCommand.args,
    spawnOptions: {
      cwd: resolvedDir,
      env,
      shell: wrappedCommand.shell,
      windowsVerbatimArguments: wrappedCommand.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: platform === 'win32',
    },
  };
}

function buildOpenCodeCommandSpec(input: {
  prompt: string;
  sessionId: string | null;
  resolvedDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  imagePaths: string[];
  model?: string | null;
  effort?: string | null;
}): WorkerRuntimeLaunchSpec {
  const command = runtimeCommand('opencode', {
    platform: input.platform,
    env: input.env,
  });
  const model = input.model?.trim() || runtimeModel('opencode', input.env);
  const effort =
    input.effort?.trim() || runtimeEffort('opencode', input.env) || null;
  const args = [
    'run',
    '--format',
    'json',
    '--dir',
    input.resolvedDir,
    '--agent',
    'Sisyphus',
    '--dangerously-skip-permissions',
  ];
  if (input.sessionId) {
    args.push('--session', input.sessionId);
  }
  if (model) {
    args.push('--model', model);
  }
  if (effort) {
    args.push('--variant', effort);
  }
  for (const imagePath of input.imagePaths) {
    args.push('--file', imagePath);
  }
  args.push(input.prompt);
  const launchSpec = buildLaunchSpec(
    command,
    args,
    input.resolvedDir,
    input.env,
    input.platform
  );

  return {
    runtime: 'opencode',
    command: launchSpec.command,
    args: launchSpec.args,
    prompt: null,
    sessionId: input.sessionId,
    displayLabel: workerRuntimeAssigneeLabel('opencode', input.env, {
      model: model || null,
      effort,
    }),
    spawnOptions: launchSpec.spawnOptions,
  };
}

function buildCodexCommandSpec(input: {
  prompt: string;
  sessionId: string | null;
  resolvedDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  imagePaths: string[];
  model?: string | null;
  effort?: string | null;
}): WorkerRuntimeLaunchSpec {
  const command = runtimeCommand('codex', {
    platform: input.platform,
    env: input.env,
  });
  const effort =
    input.effort?.trim() || runtimeEffort('codex', input.env) || 'xhigh';
  const model = input.model?.trim() || runtimeModel('codex', input.env);
  const args = input.sessionId ? ['exec', 'resume', input.sessionId] : ['exec'];
  for (const imagePath of input.imagePaths) {
    args.push('--image', imagePath);
  }
  args.push(
    '--skip-git-repo-check',
    '--json',
    '--model',
    model,
    '-c',
    `model_reasoning_effort="${effort}"`,
    '-'
  );
  const launchSpec = buildLaunchSpec(
    command,
    args,
    input.resolvedDir,
    input.env,
    input.platform
  );

  return {
    runtime: 'codex',
    command: launchSpec.command,
    args: launchSpec.args,
    prompt: input.prompt,
    sessionId: input.sessionId,
    displayLabel: workerRuntimeAssigneeLabel('codex', input.env, {
      model,
      effort,
    }),
    spawnOptions: launchSpec.spawnOptions,
  };
}

export function buildWorkerRuntimeLaunchSpec(input: {
  runtime: ManagerWorkerRuntime;
  prompt: string;
  sessionId: string | null;
  resolvedDir: string;
  runMode: ManagerRunMode | null;
  imagePaths?: string[];
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  model?: string | null;
  effort?: string | null;
}): WorkerRuntimeLaunchSpec {
  const platform = input.platform ?? process.platform;
  const env = sanitizeAgentEnv(input.env);
  const sessionId =
    input.runtime === 'claude' || input.runtime === 'copilot'
      ? (input.sessionId ?? randomUUID())
      : input.sessionId;

  if (input.runtime === 'opencode') {
    return buildOpenCodeCommandSpec({
      prompt: input.prompt,
      sessionId,
      resolvedDir: input.resolvedDir,
      env,
      platform,
      imagePaths: input.imagePaths ?? [],
      model: input.model,
      effort: input.effort,
    });
  }

  if (input.runtime === 'codex') {
    return buildCodexCommandSpec({
      prompt: input.prompt,
      sessionId,
      resolvedDir: input.resolvedDir,
      env,
      platform,
      imagePaths: input.imagePaths ?? [],
      model: input.model,
      effort: input.effort,
    });
  }

  if (input.runtime === 'claude') {
    const command = runtimeCommand('claude', { platform, env });
    const model = input.model?.trim() || runtimeModel('claude', env);
    const args = [
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '--permission-mode',
      input.runMode === 'read-only' ? 'plan' : 'acceptEdits',
      '--model',
      model,
      '--add-dir',
      input.resolvedDir,
    ];
    if (sessionId) {
      if (input.sessionId) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
    }
    args.push('--', input.prompt);
    const launchSpec = buildLaunchSpec(
      command,
      args,
      input.resolvedDir,
      env,
      platform
    );
    return {
      runtime: 'claude',
      command: launchSpec.command,
      args: launchSpec.args,
      prompt: null,
      sessionId,
      displayLabel: workerRuntimeAssigneeLabel('claude', env, {
        model,
        effort: input.effort ?? null,
      }),
      spawnOptions: launchSpec.spawnOptions,
    };
  }

  if (input.runtime === 'copilot') {
    const command = runtimeCommand('copilot', { platform, env });
    const model = input.model?.trim() || runtimeModel('copilot', env);
    const effort =
      input.effort?.trim() || runtimeEffort('copilot', env) || 'high';
    const args = [
      '--output-format',
      'json',
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-ask-user',
      '--model',
      model,
      '--reasoning-effort',
      effort,
      '--add-dir',
      input.resolvedDir,
      `--resume=${sessionId ?? randomUUID()}`,
      '--prompt',
      input.prompt,
    ];
    const launchSpec = buildLaunchSpec(
      command,
      args,
      input.resolvedDir,
      env,
      platform
    );
    return {
      runtime: 'copilot',
      command: launchSpec.command,
      args: launchSpec.args,
      prompt: null,
      sessionId: sessionId ?? null,
      displayLabel: workerRuntimeAssigneeLabel('copilot', env, {
        model,
        effort,
      }),
      spawnOptions: launchSpec.spawnOptions,
    };
  }

  const command = runtimeCommand('gemini', { platform, env });
  const model = input.model?.trim() || runtimeModel('gemini', env);
  const args = [
    '--output-format',
    'stream-json',
    '--model',
    model,
    '--include-directories',
    input.resolvedDir,
  ];
  if (input.runMode === 'read-only') {
    args.push('--approval-mode', 'plan');
  } else {
    args.push('--approval-mode', 'yolo');
  }
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  args.push('--prompt', input.prompt);
  const launchSpec = buildLaunchSpec(
    command,
    args,
    input.resolvedDir,
    env,
    platform
  );
  return {
    runtime: 'gemini',
    command: launchSpec.command,
    args: launchSpec.args,
    prompt: null,
    sessionId,
    displayLabel: workerRuntimeAssigneeLabel('gemini', env, {
      model,
      effort: input.effort ?? null,
    }),
    spawnOptions: launchSpec.spawnOptions,
  };
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextFragments(entry));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  for (const key of [
    'response',
    'content',
    'message',
    'text',
    'parts',
    'part',
    'value',
    'delta',
  ]) {
    const fragments = collectTextFragments(record[key]);
    if (fragments.length > 0) {
      return fragments;
    }
  }

  return [];
}

function extractSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const key of [
      'session_id',
      'sessionID',
      'sessionId',
      'thread_id',
      'threadId',
      'conversation_id',
      'conversationId',
    ]) {
      if (typeof record[key] === 'string' && record[key]?.trim()) {
        return record[key].trim();
      }
    }
    queue.push(...Object.values(record));
  }
  return null;
}

function classifyEntryKind(
  record: Record<string, unknown>
): ManagerWorkerLiveEntry['kind'] {
  const severity =
    typeof record['severity'] === 'string'
      ? record['severity'].toLowerCase()
      : '';
  const type =
    typeof record['type'] === 'string' ? record['type'].toLowerCase() : '';
  if (
    severity === 'error' ||
    type === 'error' ||
    (record['error'] && typeof record['error'] === 'object')
  ) {
    return 'error';
  }
  if (
    type === 'init' ||
    type === 'step_start' ||
    type === 'step_finish' ||
    type.endsWith('.started')
  ) {
    return 'status';
  }
  return 'output';
}

export function parseGenericRuntimeProgressLine(
  line: string,
  threadStartedText: string
): WorkerRuntimeProgressState {
  const trimmed = line.trim();
  if (!trimmed) {
    return {
      sessionId: null,
      latestText: null,
      liveEntries: [],
    };
  }

  const at = new Date().toISOString();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const sessionId = extractSessionId(parsed);
    const type =
      typeof parsed['type'] === 'string' ? parsed['type'].toLowerCase() : '';
    const fragments = collectTextFragments(parsed);
    const latestText =
      fragments.length > 0
        ? fragments.join('\n').trim()
        : (type === 'init' || type.endsWith('.started')) && sessionId
          ? threadStartedText
          : null;

    return {
      sessionId,
      latestText,
      liveEntries: latestText
        ? [
            {
              at,
              text: latestText,
              kind:
                latestText === threadStartedText
                  ? 'status'
                  : classifyEntryKind(parsed),
            },
          ]
        : [],
    };
  } catch {
    return {
      sessionId: null,
      latestText: trimmed,
      liveEntries: [
        {
          at,
          text: trimmed,
          kind: 'output',
        },
      ],
    };
  }
}

export function parseGenericRuntimeOutput(
  stdout: string
): WorkerRuntimeParsedOutput {
  const assistantDeltas: string[] = [];
  let latestText = '';
  let sessionId: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      sessionId = extractSessionId(parsed) ?? sessionId;
      const role =
        typeof parsed['role'] === 'string' ? parsed['role'].toLowerCase() : '';
      const type =
        typeof parsed['type'] === 'string' ? parsed['type'].toLowerCase() : '';
      const delta = parsed['delta'] === true;
      const fragments = collectTextFragments(parsed);
      if (fragments.length === 0) {
        continue;
      }
      const text = fragments.join('\n').trim();
      if (!text) {
        continue;
      }
      if ((role === 'assistant' && delta) || type === 'text') {
        assistantDeltas.push(text);
        continue;
      }
      if (
        type === 'tool_use' ||
        type === 'step_start' ||
        type === 'step_finish'
      ) {
        continue;
      }
      latestText = text;
    } catch {
      latestText = line;
    }
  }

  return {
    text: assistantDeltas.length > 0 ? assistantDeltas.join('') : latestText,
    sessionId,
  };
}
