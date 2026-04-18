import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  validateRepoContract,
  type RepoContractIssue,
  type RepoContractSnapshot,
  type RepoContractValidationOptions,
} from './contracts/repo-contract.js';

const execFile = promisify(execFileCb);

export interface RepoContractAuditResult {
  snapshot: RepoContractSnapshot;
  valid: boolean;
  issues: RepoContractIssue[];
}

export interface WorkspaceContractAuditEntry {
  repoRoot: string;
  audit: RepoContractAuditResult;
}

async function tryExecGit(
  repoRoot: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const result = await execFile('git', ['-C', repoRoot, ...args], {
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout.toString() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

async function resolveVerifyCommand(repoRoot: string): Promise<string | null> {
  if (existsSync(join(repoRoot, 'scripts', 'verify.ps1'))) {
    return 'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1';
  }
  if (existsSync(join(repoRoot, 'scripts', 'verify.sh'))) {
    return 'bash scripts/verify.sh';
  }
  const packageJsonPath = join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  if (!packageJson.scripts?.verify) {
    return null;
  }
  return packageJson.packageManager?.startsWith('bun@')
    ? 'bun run verify'
    : 'npm run verify';
}

async function isTasksTracked(repoRoot: string): Promise<boolean> {
  const gitResult = await tryExecGit(repoRoot, [
    'ls-files',
    '--error-unmatch',
    '.tasks.jsonl',
  ]);
  if (gitResult.ok) {
    return true;
  }
  return existsSync(join(repoRoot, '.tasks.jsonl'));
}

async function isThreadsGitignored(repoRoot: string): Promise<boolean> {
  const gitResult = await tryExecGit(repoRoot, [
    'check-ignore',
    '.threads.jsonl',
  ]);
  if (gitResult.ok) {
    return true;
  }

  const gitignorePath = join(repoRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    return false;
  }
  const content = await readFile(gitignorePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .some((line) => line.trim() === '.threads.jsonl');
}

export async function auditRepositoryContract(
  repoRoot: string,
  options: Partial<RepoContractValidationOptions> = {}
): Promise<RepoContractAuditResult> {
  const repoSlugResult = await tryExecGit(repoRoot, [
    'remote',
    'get-url',
    'origin',
  ]);
  const repoSlugMatch = repoSlugResult.stdout
    .trim()
    .match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);

  const snapshot: RepoContractSnapshot = {
    repoRoot,
    repoSlug: repoSlugMatch?.[1] ?? null,
    readmePath: existsSync(join(repoRoot, 'README.md')) ? 'README.md' : null,
    licensePath: existsSync(join(repoRoot, 'LICENSE')) ? 'LICENSE' : null,
    agentRulesetPath: existsSync(join(repoRoot, 'agent-ruleset.json'))
      ? 'agent-ruleset.json'
      : null,
    agentsPath: existsSync(join(repoRoot, 'AGENTS.md')) ? 'AGENTS.md' : null,
    claudePath: existsSync(join(repoRoot, 'CLAUDE.md')) ? 'CLAUDE.md' : null,
    gitignorePath: existsSync(join(repoRoot, '.gitignore'))
      ? '.gitignore'
      : null,
    verifyCommand: await resolveVerifyCommand(repoRoot),
    threadsGitignored: await isThreadsGitignored(repoRoot),
    tasksTracked: await isTasksTracked(repoRoot),
    mwtInitialized: existsSync(join(repoRoot, '.mwt', 'config.toml')),
    workspaceWritable: existsSync(join(repoRoot, '.git')),
  };

  const validation = validateRepoContract(snapshot, options);
  return {
    snapshot,
    valid: validation.valid,
    issues: validation.issues,
  };
}

export function formatRepoContractAudit(
  result: RepoContractAuditResult
): string {
  const status = result.valid ? 'OK' : 'FAIL';
  const issueLabel = result.issues.length
    ? result.issues.map((issue) => issue.code).join(', ')
    : 'no issues';
  return `[${status}] ${result.snapshot.repoSlug ?? result.snapshot.repoRoot} :: ${issueLabel}`;
}

function isWorkspaceCandidate(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.endsWith('/agent-rules-local')) {
    return false;
  }
  return !/-wt-|-[a-z]+-mgr-/.test(normalized);
}

export function discoverWorkspaceRepos(workspaceRoot: string): string[] {
  if (!existsSync(workspaceRoot)) {
    return [];
  }

  return readDirRepos(workspaceRoot);
}

function readDirRepos(workspaceRoot: string): string[] {
  return readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(workspaceRoot, entry.name))
    .filter((repoRoot) => isWorkspaceCandidate(repoRoot))
    .filter((repoRoot) => {
      const gitPath = join(repoRoot, '.git');
      if (!existsSync(gitPath)) {
        return false;
      }
      try {
        return statSync(gitPath).isDirectory() || statSync(gitPath).isFile();
      } catch {
        return false;
      }
    });
}

export async function auditWorkspaceContracts(
  workspaceRoot: string,
  options: Partial<RepoContractValidationOptions> = {}
): Promise<WorkspaceContractAuditEntry[]> {
  const repos = discoverWorkspaceRepos(workspaceRoot);
  return Promise.all(
    repos.map(async (repoRoot) => ({
      repoRoot,
      audit: await auditRepositoryContract(repoRoot, options),
    }))
  );
}
