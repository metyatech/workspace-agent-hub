import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { readManagerWorkItems } from './manager-work-items.js';
import { readQueue, readSession } from './manager-backend.js';
import { deriveApprovalQueue } from './approval-queue.js';
import { startWebUi } from './web-ui.js';
import { startWebUiFrontDoor } from './web-ui-front-door.js';
import {
  listBuilds,
  resolvePackageRoot,
  restoreBuild,
  snapshotBuild,
} from './build-archive.js';
import {
  auditRepositoryContract,
  auditWorkspaceContracts,
  formatRepoContractAudit,
} from './repo-auditor.js';
import { deriveMergeLanes } from './merge-lanes.js';
import { readManagedRepos } from './manager-repos.js';
import { deriveRunsForWorkspace } from './runs.js';
import { listWorkerRuntimeAvailability } from './worker-adapter/availability.js';
import { deriveWorkspaceHealth } from './workspace-health.js';

type StartWebUiCommand = typeof startWebUi;
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// State file helpers
// ---------------------------------------------------------------------------

interface WebUiState {
  ListenUrl: string;
  AccessCode: string | null;
  ProcessId: number | null;
  WorkspaceRoot?: string | null;
  AuthDisabled?: boolean;
  FrontDoorProcessId?: number | null;
  StatePath?: string | null;
  UpdatedUtc?: string | null;
  PackageRoot?: string | null;
}

export function buildEnsureWebUiRunningArgs(
  packageRoot: string,
  statePath: string,
  workspaceRoot?: string | null
): string[] {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(packageRoot, 'scripts', 'ensure-web-ui-running.ps1'),
    '-StatePath',
    statePath,
    '-JsonOutput',
  ];
  if (workspaceRoot?.trim()) {
    args.push('-WorkspaceRoot', workspaceRoot.trim());
  }
  return args;
}

export function createStreamingSpawnOptions(cwd: string): {
  cwd: string;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: boolean;
} {
  return {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

export function createDetachedSpawnOptions(cwd: string): {
  cwd: string;
  stdio: 'ignore';
  detached: true;
  windowsHide: boolean;
} {
  return {
    cwd,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  };
}

function webUiStatePath(): string {
  return join(homedir(), 'agent-handoff', 'workspace-agent-hub-web-ui.json');
}

async function readWebUiStateFromPath(
  statePath: string
): Promise<WebUiState | null> {
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const content = await readFile(statePath, 'utf-8');
    return JSON.parse(content.replace(/^\uFEFF/, '')) as WebUiState;
  } catch {
    return null;
  }
}

async function readWebUiState(): Promise<WebUiState | null> {
  return readWebUiStateFromPath(webUiStatePath());
}

async function httpShutdown(
  listenUrl: string,
  accessCode: string | null
): Promise<boolean> {
  const url = new URL('/api/shutdown', listenUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (accessCode) {
    headers['Authorization'] = `Bearer ${accessCode}`;
  }
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function killProcess(pid: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    if (process.platform === 'win32') {
      execFile(
        'taskkill',
        ['/F', '/T', '/PID', String(pid)],
        { windowsHide: true },
        () => resolvePromise()
      );
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
      resolvePromise();
    }
  });
}

function streamChildOutput(child: ReturnType<typeof nodeSpawn>): void {
  child.stdout?.on('data', (chunk: Buffer | string) => {
    process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });
}

async function runStreamingCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = nodeSpawn(command, args, createStreamingSpawnOptions(cwd));
    streamChildOutput(child);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} failed with exit code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

function resolveBootstrapScriptPath(workspaceRoot: string): string {
  const configured = process.env.WORKSPACE_AGENT_HUB_BOOTSTRAP_SCRIPT?.trim();
  if (configured) {
    return configured;
  }
  return join(resolve(workspaceRoot), 'scripts', 'bootstrap-user-repo.ps1');
}

function resolvePowerShellCommand(): string {
  const configured = process.env.WORKSPACE_AGENT_HUB_PWSH_PATH?.trim();
  if (configured) {
    return configured;
  }
  return 'pwsh';
}

async function forceStopFromState(state: WebUiState | null): Promise<void> {
  const pids = [
    state?.ProcessId ?? null,
    state?.FrontDoorProcessId ?? null,
  ].filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
  );
  await Promise.allSettled(pids.map((pid) => killProcess(pid)));
}

async function launchDetachedCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = nodeSpawn(command, args, createDetachedSpawnOptions(cwd));
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolvePromise();
    });
  });
}

export async function waitForWebUiReadyFromState(
  statePath: string,
  previousUpdatedUtc: string | null = null,
  timeoutMs = 180000
): Promise<WebUiState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readWebUiStateFromPath(statePath);
    if (state?.ListenUrl) {
      try {
        const listenUrl = new URL(state.ListenUrl);
        const stateUpdated =
          !previousUpdatedUtc ||
          !state.UpdatedUtc ||
          state.UpdatedUtc !== previousUpdatedUtc;
        if (
          stateUpdated &&
          (await isPortOpen(listenUrl.hostname, Number(listenUrl.port)))
        ) {
          return state;
        }
      } catch {
        /* keep polling until the state file becomes usable */
      }
    }
    await new Promise<void>((resolvePromise) =>
      setTimeout(resolvePromise, 500)
    );
  }
  throw new Error(
    `Timed out waiting for Workspace Agent Hub readiness via ${statePath}.`
  );
}

async function runEnsureWebUiRunning(
  packageRoot: string,
  state: WebUiState | null
): Promise<void> {
  const statePath = state?.StatePath?.trim() || webUiStatePath();
  const workspaceRoot = state?.WorkspaceRoot?.trim() || null;
  const command = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const args = buildEnsureWebUiRunningArgs(
    packageRoot,
    statePath,
    workspaceRoot
  );
  if (process.platform === 'win32') {
    await launchDetachedCommand(command, args, packageRoot);
    await waitForWebUiReadyFromState(statePath, state?.UpdatedUtc ?? null);
    return;
  }

  await runStreamingCommand(command, args, packageRoot);
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host, port }, () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}

async function waitForPortClosed(
  host: string,
  port: number,
  timeoutMs = 10000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(host, port))) {
      return true;
    }
    await new Promise<void>((r) => setTimeout(r, 300));
  }
  return false;
}

async function spawnAndWaitForReady(
  packageRoot: string,
  state: WebUiState | null
): Promise<boolean> {
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  const args = [cliPath, 'web-ui', '--json', '--no-open-browser'];
  if (state?.WorkspaceRoot?.trim()) {
    args.push('--workspace-root', state.WorkspaceRoot.trim());
  }
  if (state?.AuthDisabled) {
    args.push('--auth-token', 'none');
  } else if (state?.AccessCode) {
    args.push('--auth-token', state.AccessCode);
  }

  const child = nodeSpawn(process.execPath, args, {
    cwd: packageRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const port = state?.ListenUrl ? Number(new URL(state.ListenUrl).port) : 3360;
  const host = state?.ListenUrl
    ? new URL(state.ListenUrl).hostname
    : '127.0.0.1';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 500));
    if (await isPortOpen(host, port)) {
      console.log(`Workspace Agent Hub listening on http://${host}:${port}`);
      return true;
    }
  }

  console.error(
    `Workspace Agent Hub did not become ready within 30 seconds on port ${port}.`
  );
  return false;
}

async function stopWebUi(): Promise<{
  stopped: boolean;
  listenUrl: string | null;
}> {
  const state = await readWebUiState();
  if (!state) {
    return { stopped: false, listenUrl: null };
  }

  const listenUrl = state.ListenUrl;
  let url: URL;
  try {
    url = new URL(listenUrl);
  } catch {
    return { stopped: false, listenUrl };
  }

  // Try HTTP shutdown first
  const httpOk = await httpShutdown(listenUrl, state.AccessCode);
  if (!httpOk && state.ProcessId) {
    // Fallback: kill the process directly
    await killProcess(state.ProcessId);
  }

  // Wait for the port to be released
  const closed = await waitForPortClosed(url.hostname, Number(url.port), 10000);
  return { stopped: closed, listenUrl };
}

export function createProgram(startWebUiCommand: StartWebUiCommand): Command {
  const program = new Command();

  program
    .name('workspace-agent-hub')
    .description(packageJson.description)
    .version(packageJson.version);

  program
    .command('audit')
    .description('Audit one repository against the workspace repo contract')
    .argument('[repo-root]', 'Repository root path to audit')
    .option('--json', 'Print machine-readable JSON output')
    .option('--no-mwt', 'Do not require .mwt/config.toml')
    .option('--read-only', 'Do not require write-capable workspace status')
    .option(
      '--workspace <path>',
      'Audit every repository directly under a workspace root'
    )
    .action(
      async (
        repoRoot: string | undefined,
        options: {
          json?: boolean;
          mwt?: boolean;
          readOnly?: boolean;
          workspace?: string;
        }
      ) => {
        if (options.workspace) {
          const results = await auditWorkspaceContracts(
            resolve(options.workspace),
            {
              requireMwt: options.mwt !== false,
              requireWriteAccess: options.readOnly !== true,
            }
          );
          if (options.json) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            for (const result of results) {
              console.log(formatRepoContractAudit(result.audit));
            }
          }
          if (results.some((result) => !result.audit.valid)) {
            process.exitCode = 1;
          }
          return;
        }

        if (!repoRoot) {
          throw new Error('Specify either <repo-root> or --workspace <path>.');
        }
        const result = await auditRepositoryContract(resolve(repoRoot), {
          requireMwt: options.mwt !== false,
          requireWriteAccess: options.readOnly !== true,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          if (!result.valid) {
            process.exitCode = 1;
          }
          return;
        }

        console.log(formatRepoContractAudit(result));
        if (!result.valid) {
          process.exitCode = 1;
        }
      }
    );

  program
    .command('work-items')
    .description('Inspect the Manager work-item graph for a workspace')
    .option('--workspace <path>', 'Workspace root to inspect', process.cwd())
    .option('--json', 'Print the work-item graph as JSON')
    .action(async (options: { workspace: string; json?: boolean }) => {
      const workItems = await readManagerWorkItems(options.workspace);
      if (options.json) {
        console.log(JSON.stringify({ workItems }, null, 2));
        return;
      }

      const titleById = new Map(
        workItems.map((item) => [item.id, item.title] as const)
      );
      for (const item of workItems) {
        const parentTitles = item.derivedFromThreadIds
          .map((id) => titleById.get(id) ?? id)
          .filter(Boolean);
        const childTitles = item.derivedChildThreadIds
          .map((id) => titleById.get(id) ?? id)
          .filter(Boolean);
        console.log(`[${item.uiState}] ${item.title}`);
        if (parentTitles.length > 0) {
          console.log(`  derived from: ${parentTitles.join(', ')}`);
        }
        if (childTitles.length > 0) {
          console.log(`  branches: ${childTitles.join(', ')}`);
        }
      }
    });

  program
    .command('runs')
    .description('Inspect execution-layer runs for a workspace')
    .option('--workspace <path>', 'Workspace root to inspect', process.cwd())
    .option('--json', 'Print runs as JSON')
    .action(async (options: { workspace: string; json?: boolean }) => {
      const workspaceRoot = resolve(options.workspace);
      const [session, queue] = await Promise.all([
        readSession(workspaceRoot),
        readQueue(workspaceRoot),
      ]);
      const snapshot = await deriveRunsForWorkspace(workspaceRoot, {
        session,
        queue,
      });
      if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }

      for (const run of snapshot.runs) {
        console.log(
          `[${run.state}] ${run.id} :: ${run.runtime} :: ${run.repoRoot}`
        );
      }
    });

  program
    .command('worker-runtimes')
    .description('Inspect worker runtime availability for the current machine')
    .option('--json', 'Print runtime availability as JSON')
    .action(async (options: { json?: boolean }) => {
      const availability = listWorkerRuntimeAvailability();
      if (options.json) {
        console.log(JSON.stringify(availability, null, 2));
        return;
      }

      for (const runtime of availability) {
        console.log(
          `[${runtime.available ? 'OK' : 'MISSING'}] ${runtime.runtime} :: ${runtime.detail}`
        );
      }
    });

  program
    .command('approval-queue')
    .description('Inspect work items that currently require human input')
    .option('--workspace <path>', 'Workspace root to inspect', process.cwd())
    .option('--json', 'Print approval queue items as JSON')
    .action(async (options: { workspace: string; json?: boolean }) => {
      const workItems = await readManagerWorkItems(resolve(options.workspace));
      const queue = deriveApprovalQueue(workItems);
      if (options.json) {
        console.log(JSON.stringify(queue, null, 2));
        return;
      }

      for (const item of queue) {
        console.log(
          `[${item.kind}] ${item.threadId} :: ${item.title} :: ${item.reason}`
        );
      }
    });

  program
    .command('merge-lanes')
    .description('Inspect merge-lane state by managed repository')
    .option('--workspace <path>', 'Workspace root to inspect', process.cwd())
    .option('--json', 'Print merge-lane records as JSON')
    .action(async (options: { workspace: string; json?: boolean }) => {
      const workspaceRoot = resolve(options.workspace);
      const [repos, workItems] = await Promise.all([
        readManagedRepos(workspaceRoot),
        readManagerWorkItems(workspaceRoot),
      ]);
      const lanes = deriveMergeLanes({ repos, workItems });
      if (options.json) {
        console.log(JSON.stringify(lanes, null, 2));
        return;
      }

      for (const lane of lanes) {
        console.log(
          `[${lane.state}] ${lane.repoRoot} :: queue=${lane.queueDepth} :: active=${lane.activeRunId ?? 'none'}`
        );
      }
    });

  program
    .command('workspace-health')
    .description('Inspect workspace-level contract, runtime, and queue health')
    .option('--workspace <path>', 'Workspace root to inspect', process.cwd())
    .option('--json', 'Print workspace health as JSON')
    .action(async (options: { workspace: string; json?: boolean }) => {
      const snapshot = await deriveWorkspaceHealth(resolve(options.workspace));
      if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }

      console.log(`workspace: ${snapshot.workspaceRoot}`);
      console.log(`in-scope repos: ${snapshot.inScopeRepoCount}`);
      console.log(`invalid repos: ${snapshot.invalidRepoCount}`);
      console.log(`approval queue: ${snapshot.approvalQueueCount}`);
      console.log(`runs: ${snapshot.runCount}`);
      console.log(`merge lanes: ${snapshot.mergeLaneCount}`);
      console.log(`unavailable runtimes: ${snapshot.unavailableRuntimeCount}`);
    });

  program
    .command('bootstrap-repo')
    .description(
      'Apply the standardized high-quality workflow to a user-controlled repository'
    )
    .option(
      '--workspace-root <path>',
      'Canonical ghws workspace root',
      process.cwd()
    )
    .option('--repo-root <path>', 'Existing repository root to bootstrap')
    .option(
      '--repository <slug>',
      'Repository slug to clone/bootstrap, for example metyatech/some-repo'
    )
    .option(
      '--verify-command <command>',
      'Explicit canonical verify command override'
    )
    .option(
      '--create-if-missing',
      'Create a new user-controlled repository under the workspace if it does not exist yet'
    )
    .option(
      '--private',
      'Create a private repository when used with --create-if-missing'
    )
    .option('--force', 'Overwrite bootstrap-managed template files')
    .action(
      async (options: {
        workspaceRoot: string;
        repoRoot?: string;
        repository?: string;
        verifyCommand?: string;
        createIfMissing?: boolean;
        private?: boolean;
        force?: boolean;
      }) => {
        const scriptPath = resolveBootstrapScriptPath(options.workspaceRoot);
        const args = [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-WorkspaceRoot',
          resolve(options.workspaceRoot),
        ];
        if (options.repoRoot) {
          args.push('-RepoRoot', resolve(options.repoRoot));
        }
        if (options.repository) {
          args.push('-Repository', options.repository);
        }
        if (options.verifyCommand) {
          args.push('-VerifyCommand', options.verifyCommand);
        }
        if (options.createIfMissing) {
          args.push('-CreateIfMissing');
        }
        if (options.private) {
          args.push('-Private');
        }
        if (options.force) {
          args.push('-Force');
        }

        const command = resolvePowerShellCommand();
        const { stdout, stderr } = await execFileAsync(command, args, {
          windowsHide: true,
        });
        if (stdout.trim()) {
          console.log(stdout.trim());
        }
        if (stderr.trim()) {
          console.error(stderr.trim());
        }
      }
    );

  program
    .command('web-ui')
    .description(
      'Start the mobile-friendly browser UI for session management and prompt sending.'
    )
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--port <port>', 'Port to bind', '3360')
    .option(
      '--public-url <url>',
      'Phone-facing HTTPS URL or Tailscale Serve URL used for reconnect links and QR pairing'
    )
    .option(
      '--tailscale-serve',
      'Configure Tailscale Serve for this run and prefer the resulting HTTPS tailnet URL'
    )
    .option(
      '--auth-token <token>',
      'Access code required by the browser UI. Use auto to generate one, or none to disable auth.'
    )
    .option(
      '--workspace-root <path>',
      'Explicit workspace root containing .tasks.jsonl, .threads.jsonl, and Manager state'
    )
    .option(
      '--json',
      'Print machine-readable launch metadata as a single JSON object'
    )
    .option(
      '--no-open-browser',
      'Do not open a browser automatically after the server starts'
    )
    .action(
      async (options: {
        host: string;
        port: string;
        publicUrl?: string;
        tailscaleServe?: boolean;
        authToken: string;
        workspaceRoot?: string;
        json?: boolean;
        openBrowser?: boolean;
      }) => {
        await startWebUiCommand({
          host: options.host,
          port: Number(options.port),
          publicUrl: options.publicUrl,
          tailscaleServe: Boolean(options.tailscaleServe),
          authToken: options.authToken,
          workspaceRoot: options.workspaceRoot,
          jsonOutput: Boolean(options.json),
          openBrowser: options.openBrowser,
        });
      }
    );

  program
    .command('web-ui-front-door')
    .description('Start the stable phone-ready front door proxy')
    .requiredOption(
      '--state-path <path>',
      'Workspace Agent Hub state file path'
    )
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--port <port>', 'Port to bind', '0')
    .action(
      async (options: { host: string; port: string; statePath: string }) => {
        await startWebUiFrontDoor({
          host: options.host,
          port: Number(options.port),
          statePath: options.statePath,
        });
      }
    );

  program
    .command('stop')
    .description('Stop the running Workspace Agent Hub web UI')
    .action(async () => {
      const { stopped, listenUrl } = await stopWebUi();
      if (!listenUrl) {
        console.log('No running Workspace Agent Hub instance found.');
        return;
      }
      if (stopped) {
        console.log(`Workspace Agent Hub stopped (was ${listenUrl}).`);
      } else {
        console.error(
          `Failed to stop Workspace Agent Hub at ${listenUrl}. The port may still be in use.`
        );
        process.exitCode = 1;
      }
    });

  program
    .command('restart')
    .description(
      'Stop, rebuild, and restart the Workspace Agent Hub web UI with the same options'
    )
    .action(async () => {
      const state = await readWebUiState();
      const { stopped, listenUrl } = await stopWebUi();
      if (listenUrl) {
        console.log(
          stopped
            ? `Stopped existing instance at ${listenUrl}.`
            : `Warning: could not confirm stop of ${listenUrl}. Continuing anyway.`
        );
      }

      const packageRoot = resolvePackageRoot();
      if (!stopped) {
        await forceStopFromState(state);
      }

      console.log('Restarting via ensure-web-ui-running.ps1...');
      await runEnsureWebUiRunning(packageRoot, state);

      try {
        const archived = await snapshotBuild(packageRoot);
        console.log(
          `Archived build ${archived.commitHash} (${archived.commitMessage})`
        );
      } catch (error) {
        console.error(
          'Warning: failed to archive build:',
          error instanceof Error ? error.message : error
        );
      }
    });

  program
    .command('rollback')
    .description(
      'List archived builds, or restore a previous build and restart'
    )
    .argument('[hash]', 'Commit hash (or prefix) to rollback to')
    .action(async (hash?: string) => {
      if (!hash) {
        // List mode
        const builds = await listBuilds();
        if (builds.length === 0) {
          console.log('No archived builds found.');
          return;
        }

        let currentHash = '';
        try {
          const packageRoot = resolvePackageRoot();
          const { getGitInfo } = await import('./build-archive.js');
          currentHash = (await getGitInfo(packageRoot)).hashFull;
        } catch {
          /* ignore */
        }

        console.log('Available builds:\n');
        for (const build of builds) {
          const isCurrent = currentHash && build.commitHashFull === currentHash;
          const marker = isCurrent ? ' (現在)' : '';
          const date = new Date(build.archivedAt).toLocaleString();
          console.log(
            `  ${build.commitHash}${marker}  ${date}  ${build.commitMessage}`
          );
        }
        console.log(
          '\nRun: workspace-agent-hub rollback <hash> to restore a build.'
        );
        return;
      }

      // Restore mode
      const state = await readWebUiState();
      const { stopped, listenUrl } = await stopWebUi();
      if (listenUrl) {
        console.log(
          stopped
            ? `Stopped existing instance at ${listenUrl}.`
            : `Warning: could not confirm stop of ${listenUrl}. Continuing anyway.`
        );
      }

      const packageRoot = resolvePackageRoot();
      console.log(`Restoring build ${hash}...`);
      const restored = await restoreBuild(hash, packageRoot);
      if (!restored) {
        console.error(
          `No archived build matching "${hash}" found. Run: workspace-agent-hub rollback`
        );
        process.exitCode = 1;
        return;
      }

      console.log(
        `Restored ${restored.commitHash} (${restored.commitMessage}). Starting...`
      );
      const ready = await spawnAndWaitForReady(packageRoot, state);
      if (!ready) {
        process.exitCode = 1;
      }
    });

  return program;
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  await createProgram(startWebUi).parseAsync(process.argv);
}
