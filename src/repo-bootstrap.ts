import { execFile as execFileCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import { auditRepositoryContract } from './repo-auditor.js';
import {
  inferVerifyCommand,
  PROFILE_VERIFY_COMMANDS,
} from './verify-inference.js';

const execFileAsync = promisify(execFileCb);
const REQUIRED_WORKFLOW_COMMANDS = [
  'start-task',
  'verify',
  'fix-bug',
  'deliver',
] as const;

const HIGH_QUALITY_RULE = `# High-quality OpenCode workflow

- Repository-local OpenCode workflows MUST live in \`.opencode/commands/\`.
- The canonical verification command MUST be the same command used for local validation before delivery.
- When no canonical verification command is configured, the agent MUST stop and report the missing bootstrap requirement instead of inventing a partial substitute.
- Bug fixes MUST add or strengthen a regression check before concluding.
- Irreversible operations such as destructive deletion, publish, release, force-push, or external side effects MUST remain approval-gated.
`;

const COMMAND_TEMPLATES: Record<string, string> = {
  'start-task': `---
description: Establish acceptance criteria and verification before editing this repository
---

Before editing this repository:

1. Read \`README.md\`, \`CONTRIBUTING.md\`, and \`AGENTS.md\` if present.
2. State the task's binary acceptance criteria.
3. Confirm the canonical verification command for this repository.
4. If the verification command is missing, stop and report the bootstrap gap.
5. Keep changes scoped to the requested outcome only.
`,
  verify: `---
description: Run the canonical repository verification command and summarize the result
---

Run this repository's canonical verification command and use the actual output as evidence:

{{VERIFY_COMMAND}}

Report whether verification passed, which checks ran, and any follow-up needed.
Do not claim success without command output.
`,
  'fix-bug': `---
description: Run the repository bug-fix loop with regression-first verification
---

Use this repository bug-fix workflow:

1. Reproduce the failing behavior or deterministic failing condition first.
2. Add or strengthen the earliest reliable regression check that should have caught it.
3. Fix the root cause with the smallest viable change set.
4. Run the canonical verification command:

{{VERIFY_COMMAND}}

5. Summarize the cause, the prevention mechanism, and any residual risk.
`,
  deliver: `---
description: Final delivery checklist before reporting completion
---

Before concluding work in this repository:

1. Run the canonical verification command:

{{VERIFY_COMMAND}}

2. Confirm docs changed anywhere behavior, workflow, or commands changed.
3. Report the changed files, the verification evidence, and any unresolved issues.
4. Do not commit or push unless the user explicitly requested it.
`,
};

const MAX_BOOTSTRAP_ATTEMPTS = 2;

export interface BootstrapCommandInput {
  workspaceRoot: string;
  repoRoot?: string | null;
  repository?: string | null;
  verifyCommand?: string | null;
  createIfMissing?: boolean;
  privateRepo?: boolean;
  force?: boolean;
}

export interface BootstrapCommandResult {
  stdout: string;
  stderr: string;
  scriptPath: string;
}

export interface RepoBootstrapResult {
  ready: boolean;
  attempted: boolean;
  repoRoot: string | null;
  detail: string;
  issues: string[];
}

function inferRepoRootFromRepository(
  workspaceRoot: string,
  repository: string
): string {
  const leaf = repository.split('/').at(-1) ?? repository;
  return join(resolvePath(workspaceRoot), leaf);
}

async function resolveVerifyCommandForBootstrap(
  repository: string | null,
  explicitVerifyCommand: string | null | undefined,
  repoRoot: string | null
): Promise<string | null> {
  if (explicitVerifyCommand?.trim()) {
    return explicitVerifyCommand.trim();
  }
  if (repository && PROFILE_VERIFY_COMMANDS[repository]) {
    return PROFILE_VERIFY_COMMANDS[repository]!;
  }
  if (repoRoot && existsSync(repoRoot)) {
    return (
      (await inferVerifyCommand(repoRoot, { repoSlug: repository }))?.command ??
      null
    );
  }
  return null;
}

function isRetryableBootstrapFailure(issues: string[]): boolean {
  return (
    issues.includes('bootstrap-command-failed') ||
    issues.includes('missing-opencode-commands')
  );
}

function hasRequiredWorkflowCommands(repoRoot: string): boolean {
  return REQUIRED_WORKFLOW_COMMANDS.every((commandName) =>
    existsSync(join(repoRoot, '.opencode', 'commands', `${commandName}.md`))
  );
}

export function resolveBootstrapScriptPath(workspaceRoot: string): string {
  return join(
    resolvePath(workspaceRoot),
    '[builtin workspace-agent-hub bootstrap]'
  );
}

export function resolvePowerShellCommand(): string {
  const configured = process.env.WORKSPACE_AGENT_HUB_PWSH_PATH?.trim();
  if (configured) {
    return configured;
  }
  return 'pwsh';
}

async function runExternal(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      windowsHide: true,
    });
    return { stdout: stdout.toString(), stderr: stderr.toString(), code: 0 };
  } catch (error) {
    if (error && typeof error === 'object') {
      const err = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
        message?: string;
      };
      return {
        stdout: err.stdout?.toString() ?? '',
        stderr: err.stderr?.toString() ?? err.message ?? '',
        code: typeof err.code === 'number' ? err.code : 1,
      };
    }
    return { stdout: '', stderr: String(error), code: 1 };
  }
}

function parseRepoSlugFromRemoteUrl(remoteUrl: string): string | null {
  const normalized = remoteUrl.trim();
  const match = normalized.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  return match?.[1] ?? null;
}

async function resolveRepoSlug(
  input: BootstrapCommandInput
): Promise<string | null> {
  if (input.repository) {
    return input.repository;
  }
  if (!input.repoRoot) {
    return null;
  }
  const result = await runExternal(
    'git',
    ['remote', 'get-url', 'origin'],
    input.repoRoot
  );
  if (result.code !== 0) {
    return null;
  }
  return parseRepoSlugFromRemoteUrl(result.stdout);
}

async function ensureDirectory(pathValue: string): Promise<void> {
  await mkdir(pathValue, { recursive: true });
}

async function writeUtf8(pathValue: string, content: string): Promise<void> {
  await ensureDirectory(join(pathValue, '..'));
  await writeFile(pathValue, content, 'utf-8');
}

async function ensureFileIfMissing(
  pathValue: string,
  content: string
): Promise<void> {
  if (!existsSync(pathValue)) {
    await writeUtf8(pathValue, content);
  }
}

async function ensureNewRepositoryScaffold(input: {
  workspaceRoot: string;
  repository: string;
  targetRepoRoot: string;
  verifyCommand: string;
  privateRepo: boolean;
}): Promise<string[]> {
  const actions: string[] = [];
  await ensureDirectory(input.targetRepoRoot);
  actions.push(`created repo root ${input.targetRepoRoot}`);

  if (!existsSync(join(input.targetRepoRoot, '.git'))) {
    const gitInit = await runExternal(
      'git',
      ['init', '-b', 'main'],
      input.targetRepoRoot
    );
    if (gitInit.code !== 0) {
      throw new Error(gitInit.stderr || gitInit.stdout || 'git init failed');
    }
    actions.push('initialized git repository');
  }

  await ensureFileIfMissing(
    join(input.targetRepoRoot, 'README.md'),
    `# ${basename(input.targetRepoRoot)}\n`
  );
  await ensureFileIfMissing(
    join(input.targetRepoRoot, 'LICENSE'),
    `MIT License\n\nCopyright (c) ${new Date().getFullYear()} metyatech\n`
  );
  await ensureFileIfMissing(
    join(input.targetRepoRoot, '.gitignore'),
    '.threads.jsonl\n'
  );
  await ensureFileIfMissing(join(input.targetRepoRoot, '.tasks.jsonl'), '');
  actions.push('scaffolded README, LICENSE, .gitignore, and .tasks.jsonl');

  const visibility = input.privateRepo ? '--private' : '--public';
  const createResult = await runExternal(
    'gh',
    [
      'repo',
      'create',
      input.repository,
      visibility,
      '--source',
      input.targetRepoRoot,
      '--remote',
      'origin',
    ],
    input.targetRepoRoot
  );
  if (createResult.code !== 0) {
    throw new Error(
      createResult.stderr || createResult.stdout || 'gh repo create failed'
    );
  }
  actions.push(`created GitHub repository ${input.repository}`);
  return actions;
}

async function ensureAgentRuleset(targetRepoRoot: string): Promise<string[]> {
  const actions: string[] = [];
  const rulesetPath = join(targetRepoRoot, 'agent-ruleset.json');
  let extra = ['agent-rules-local/high-quality-workflow.md'];
  const existingAgentsPath = join(targetRepoRoot, 'AGENTS.md');
  if (!existsSync(rulesetPath)) {
    if (existsSync(existingAgentsPath)) {
      await ensureDirectory(join(targetRepoRoot, 'agent-rules-local'));
      const existingAgents = await readFile(existingAgentsPath, 'utf-8');
      await writeUtf8(
        join(
          targetRepoRoot,
          'agent-rules-local',
          'repo-existing-instructions.md'
        ),
        existingAgents
      );
      extra = [
        'agent-rules-local/repo-existing-instructions.md',
        'agent-rules-local/high-quality-workflow.md',
      ];
      actions.push(
        'preserved existing AGENTS.md as repo-existing-instructions.md'
      );
    }
    await writeUtf8(
      rulesetPath,
      `${JSON.stringify(
        {
          source: 'github:metyatech/agent-rules',
          output: 'AGENTS.md',
          extra,
        },
        null,
        2
      )}\n`
    );
    actions.push('created agent-ruleset.json');
    return actions;
  }

  const parsed = JSON.parse(await readFile(rulesetPath, 'utf-8')) as {
    source?: string;
    output?: string;
    extra?: string[];
  };
  const nextExtra = new Set(parsed.extra ?? []);
  nextExtra.add('agent-rules-local/high-quality-workflow.md');
  parsed.extra = [...nextExtra];
  await writeUtf8(rulesetPath, `${JSON.stringify(parsed, null, 2)}\n`);
  actions.push('updated agent-ruleset.json extras');
  return actions;
}

async function ensureDataHygieneFiles(
  targetRepoRoot: string
): Promise<string[]> {
  const actions: string[] = [];
  const tasksPath = join(targetRepoRoot, '.tasks.jsonl');
  if (!existsSync(tasksPath)) {
    await writeUtf8(tasksPath, '');
    actions.push('created .tasks.jsonl');
  }

  const gitignorePath = join(targetRepoRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    await writeUtf8(gitignorePath, '.threads.jsonl\n');
    actions.push('created .gitignore with .threads.jsonl');
    return actions;
  }

  const currentGitignore = await readFile(gitignorePath, 'utf-8');
  const hasThreadsEntry = currentGitignore
    .split(/\r?\n/)
    .some((line) => line.trim() === '.threads.jsonl');
  if (!hasThreadsEntry) {
    const nextGitignore = currentGitignore.length
      ? currentGitignore.endsWith('\n')
        ? `${currentGitignore}.threads.jsonl\n`
        : `${currentGitignore}\n.threads.jsonl\n`
      : '.threads.jsonl\n';
    await writeUtf8(gitignorePath, nextGitignore);
    actions.push('added .threads.jsonl to .gitignore');
  }

  return actions;
}

async function writeBootstrapFiles(input: {
  targetRepoRoot: string;
  verifyCommand: string;
  force?: boolean;
}): Promise<string[]> {
  const actions: string[] = [];
  await ensureDirectory(join(input.targetRepoRoot, 'agent-rules-local'));
  const rulePath = join(
    input.targetRepoRoot,
    'agent-rules-local',
    'high-quality-workflow.md'
  );
  if (!existsSync(rulePath) || input.force) {
    await writeUtf8(rulePath, HIGH_QUALITY_RULE);
    actions.push('wrote high-quality workflow rule');
  }

  for (const [name, template] of Object.entries(COMMAND_TEMPLATES)) {
    const filePath = join(
      input.targetRepoRoot,
      '.opencode',
      'commands',
      `${name}.md`
    );
    if (!existsSync(filePath) || input.force) {
      await ensureDirectory(
        join(input.targetRepoRoot, '.opencode', 'commands')
      );
      await writeUtf8(
        filePath,
        template.replace('{{VERIFY_COMMAND}}', input.verifyCommand)
      );
      actions.push(`wrote .opencode/commands/${name}.md`);
    }
  }

  return actions;
}

async function runComposeAgentsmd(targetRepoRoot: string): Promise<string[]> {
  const result =
    process.platform === 'win32'
      ? await runExternal(
          'cmd.exe',
          ['/d', '/s', '/c', 'compose-agentsmd.cmd', '--root', targetRepoRoot],
          targetRepoRoot
        )
      : await runExternal(
          'compose-agentsmd',
          ['--root', targetRepoRoot],
          targetRepoRoot
        );
  if (result.code !== 0) {
    throw new Error(
      result.stderr || result.stdout || 'compose-agentsmd failed'
    );
  }
  return ['composed AGENTS.md'];
}

async function runSetupHooksIfPresent(
  targetRepoRoot: string
): Promise<string[]> {
  const scriptPath = join(targetRepoRoot, 'scripts', 'setup-hooks.ps1');
  if (!existsSync(scriptPath)) {
    return [];
  }
  const result = await runExternal(
    resolvePowerShellCommand(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    targetRepoRoot
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'setup-hooks failed');
  }
  return ['configured hooks'];
}

export async function runBootstrapCommand(
  input: BootstrapCommandInput
): Promise<BootstrapCommandResult> {
  const workspaceRoot = resolvePath(input.workspaceRoot);
  const repository = await resolveRepoSlug(input);
  const repoRoot = input.repoRoot
    ? resolvePath(input.repoRoot)
    : repository
      ? inferRepoRootFromRepository(workspaceRoot, repository)
      : null;

  if (!repoRoot) {
    throw new Error('No target repository could be resolved for bootstrap.');
  }

  const verifyCommand = await resolveVerifyCommandForBootstrap(
    repository,
    input.verifyCommand,
    repoRoot
  );
  if (input.createIfMissing && !verifyCommand) {
    throw new Error(
      'Automatic bootstrap for a brand-new repository requires a canonical verify command or a bootstrap profile entry.'
    );
  }

  const actions: string[] = [];
  if (!existsSync(repoRoot) && repository && input.createIfMissing) {
    actions.push(
      ...(await ensureNewRepositoryScaffold({
        workspaceRoot,
        repository,
        targetRepoRoot: repoRoot,
        verifyCommand: verifyCommand!,
        privateRepo: Boolean(input.privateRepo),
      }))
    );
  }

  actions.push(...(await ensureAgentRuleset(repoRoot)));
  actions.push(...(await ensureDataHygieneFiles(repoRoot)));
  if (!verifyCommand) {
    throw new Error(
      'No canonical verification command found for this repository. Provide --verify-command or add a bootstrap profile entry first.'
    );
  }
  actions.push(
    ...(await writeBootstrapFiles({
      targetRepoRoot: repoRoot,
      verifyCommand,
      force: input.force,
    }))
  );
  actions.push(...(await runSetupHooksIfPresent(repoRoot)));
  actions.push(...(await runComposeAgentsmd(repoRoot)));

  return {
    stdout: actions.join('\n'),
    stderr: '',
    scriptPath: '[workspace-agent-hub builtin bootstrap]',
  };
}

export async function ensureRepoBootstrap(
  input: BootstrapCommandInput
): Promise<RepoBootstrapResult> {
  const resolvedRepoRoot = input.repoRoot
    ? resolvePath(input.repoRoot)
    : input.repository
      ? inferRepoRootFromRepository(input.workspaceRoot, input.repository)
      : null;
  if (!resolvedRepoRoot) {
    return {
      ready: false,
      attempted: false,
      repoRoot: null,
      detail: 'No target repository could be resolved for bootstrap.',
      issues: ['missing-target'],
    };
  }

  if (existsSync(resolvedRepoRoot)) {
    const initialAudit = await auditRepositoryContract(resolvedRepoRoot, {
      requireMwt: false,
      requireWriteAccess: true,
    });
    if (initialAudit.valid && hasRequiredWorkflowCommands(resolvedRepoRoot)) {
      return {
        ready: true,
        attempted: false,
        repoRoot: resolvedRepoRoot,
        detail: 'Repository already satisfies the bootstrap contract.',
        issues: [],
      };
    }
  }

  const attemptDetails: string[] = [];
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= MAX_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      const result = await runBootstrapCommand({
        ...input,
        repoRoot: input.repoRoot ?? resolvedRepoRoot,
      });
      const finalAudit = await auditRepositoryContract(resolvedRepoRoot, {
        requireMwt: false,
        requireWriteAccess: true,
      });
      const commandsReady = hasRequiredWorkflowCommands(resolvedRepoRoot);
      const issues =
        finalAudit.valid && commandsReady
          ? []
          : [
              ...finalAudit.issues.map((issue) => issue.code),
              ...(commandsReady ? [] : ['missing-opencode-commands']),
            ];
      if (issues.length === 0) {
        return {
          ready: true,
          attempted: true,
          repoRoot: resolvedRepoRoot,
          detail: result.stdout || result.stderr || 'Bootstrap completed.',
          issues: [],
        };
      }
      lastIssues = issues;
      attemptDetails.push(
        `attempt ${attempt}: ${result.stdout || result.stderr || issues.join(', ')}`
      );
      if (
        attempt >= MAX_BOOTSTRAP_ATTEMPTS ||
        !isRetryableBootstrapFailure(issues)
      ) {
        return {
          ready: false,
          attempted: true,
          repoRoot: resolvedRepoRoot,
          detail: attemptDetails.join('\n\n'),
          issues,
        };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      attemptDetails.push(`attempt ${attempt}: ${detail}`);
      lastIssues = ['bootstrap-command-failed'];
      if (attempt >= MAX_BOOTSTRAP_ATTEMPTS) {
        return {
          ready: false,
          attempted: true,
          repoRoot: resolvedRepoRoot,
          detail: attemptDetails.join('\n\n'),
          issues: lastIssues,
        };
      }
    }
  }

  return {
    ready: false,
    attempted: true,
    repoRoot: resolvedRepoRoot,
    detail: attemptDetails.join('\n\n') || 'Bootstrap attempts failed.',
    issues: lastIssues,
  };
}
