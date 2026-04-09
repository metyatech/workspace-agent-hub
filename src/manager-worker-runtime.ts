import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
    runtime === 'claude'
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

function runtimeModel(
  runtime: ManagerWorkerRuntime,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (runtime === 'claude') {
    return env.WORKSPACE_AGENT_HUB_CLAUDE_MODEL?.trim() || 'claude-sonnet-4-6';
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
  if (runtime === 'copilot') {
    return env.WORKSPACE_AGENT_HUB_COPILOT_EFFORT?.trim() || 'high';
  }
  if (runtime === 'codex') {
    return env.WORKSPACE_AGENT_HUB_CODEX_EFFORT?.trim() || 'xhigh';
  }
  return null;
}

function runtimeDisplayName(runtime: ManagerWorkerRuntime): string {
  return runtime === 'claude'
    ? 'Claude'
    : runtime === 'copilot'
      ? 'Copilot'
      : runtime === 'gemini'
        ? 'Gemini'
        : 'Codex';
}

export function workerRuntimeAssigneeLabel(
  runtime: ManagerWorkerRuntime,
  env: NodeJS.ProcessEnv = process.env
): string {
  const model = runtimeModel(runtime, env);
  const effort = runtimeEffort(runtime, env);
  return effort
    ? `Worker ${runtimeDisplayName(runtime)} ${model} (${effort})`
    : `Worker ${runtimeDisplayName(runtime)} ${model}`;
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

function buildCodexCommandSpec(input: {
  prompt: string;
  sessionId: string | null;
  resolvedDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  imagePaths: string[];
}): WorkerRuntimeLaunchSpec {
  const command = runtimeCommand('codex', {
    platform: input.platform,
    env: input.env,
  });
  const effort = runtimeEffort('codex', input.env) ?? 'xhigh';
  const model = runtimeModel('codex', input.env);
  const args = input.sessionId ? ['exec', 'resume', input.sessionId] : ['exec'];
  for (const imagePath of input.imagePaths) {
    args.push('--image', imagePath);
  }
  args.push(
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
    displayLabel: workerRuntimeAssigneeLabel('codex', input.env),
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
}): WorkerRuntimeLaunchSpec {
  const platform = input.platform ?? process.platform;
  const env = sanitizeAgentEnv(input.env);
  const sessionId =
    input.runtime === 'claude' || input.runtime === 'copilot'
      ? (input.sessionId ?? randomUUID())
      : input.sessionId;

  if (input.runtime === 'codex') {
    return buildCodexCommandSpec({
      prompt: input.prompt,
      sessionId,
      resolvedDir: input.resolvedDir,
      env,
      platform,
      imagePaths: input.imagePaths ?? [],
    });
  }

  if (input.runtime === 'claude') {
    const command = runtimeCommand('claude', { platform, env });
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--permission-mode',
      input.runMode === 'read-only' ? 'plan' : 'acceptEdits',
      '--model',
      runtimeModel('claude', env),
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
    args.push(input.prompt);
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
      displayLabel: workerRuntimeAssigneeLabel('claude', env),
      spawnOptions: launchSpec.spawnOptions,
    };
  }

  if (input.runtime === 'copilot') {
    const command = runtimeCommand('copilot', { platform, env });
    const args = [
      '--output-format',
      'json',
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-ask-user',
      '--model',
      runtimeModel('copilot', env),
      '--reasoning-effort',
      runtimeEffort('copilot', env) ?? 'high',
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
      displayLabel: workerRuntimeAssigneeLabel('copilot', env),
      spawnOptions: launchSpec.spawnOptions,
    };
  }

  const command = runtimeCommand('gemini', { platform, env });
  const args = [
    '--output-format',
    'stream-json',
    '--model',
    runtimeModel('gemini', env),
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
    displayLabel: workerRuntimeAssigneeLabel('gemini', env),
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
  if (type === 'init' || type.endsWith('.started')) {
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
      const delta = parsed['delta'] === true;
      const fragments = collectTextFragments(parsed);
      if (fragments.length === 0) {
        continue;
      }
      const text = fragments.join('\n').trim();
      if (!text) {
        continue;
      }
      if (role === 'assistant' && delta) {
        assistantDeltas.push(text);
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
