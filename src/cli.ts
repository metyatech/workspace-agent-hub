import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { readManagerWorkItems } from './manager-work-items.js';
import { startWebUi } from './web-ui.js';
import {
  listBuilds,
  resolvePackageRoot,
  restoreBuild,
  snapshotBuild,
} from './build-archive.js';

type StartWebUiCommand = typeof startWebUi;

// ---------------------------------------------------------------------------
// State file helpers
// ---------------------------------------------------------------------------

interface WebUiState {
  ListenUrl: string;
  AccessCode: string | null;
  ProcessId: number | null;
  AuthDisabled?: boolean;
}

function webUiStatePath(): string {
  return join(homedir(), 'agent-handoff', 'workspace-agent-hub-web-ui.json');
}

async function readWebUiState(): Promise<WebUiState | null> {
  const statePath = webUiStatePath();
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    const content = await readFile(statePath, 'utf-8');
    return JSON.parse(content) as WebUiState;
  } catch {
    return null;
  }
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
  const args = ['run', 'start', '--', '--json'];
  if (state?.AuthDisabled) {
    args.push('--auth-token', 'none');
  } else if (state?.AccessCode) {
    args.push('--auth-token', state.AccessCode);
  }

  const child = nodeSpawn('npm', args, {
    cwd: packageRoot,
    detached: true,
    stdio: 'ignore',
    shell: true,
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
        json?: boolean;
        openBrowser?: boolean;
      }) => {
        await startWebUiCommand({
          host: options.host,
          port: Number(options.port),
          publicUrl: options.publicUrl,
          tailscaleServe: Boolean(options.tailscaleServe),
          authToken: options.authToken,
          jsonOutput: Boolean(options.json),
          openBrowser: options.openBrowser,
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
      console.log('Building...');
      await new Promise<void>((resolvePromise, reject) => {
        const build = nodeSpawn('npm', ['run', 'build'], {
          cwd: packageRoot,
          stdio: 'inherit',
          shell: true,
          windowsHide: true,
        });
        build.on('close', (code) => {
          if (code === 0) {
            resolvePromise();
          } else {
            reject(new Error(`Build failed with exit code ${code}`));
          }
        });
        build.on('error', reject);
      });

      // Archive the new build
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

      console.log('Starting new instance...');
      const ready = await spawnAndWaitForReady(packageRoot, state);
      if (!ready) {
        process.exitCode = 1;
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
