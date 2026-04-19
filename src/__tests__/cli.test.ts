import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildEnsureWebUiRunningArgs,
  createProgram,
  createDetachedSpawnOptions,
  createStreamingSpawnOptions,
  waitForWebUiReadyFromState,
} from '../cli.js';

describe('cli restart helpers', () => {
  it('builds ensure-web-ui-running arguments with the explicit state path and workspace root', () => {
    const packageRoot = 'D:\\ghws\\workspace-agent-hub';
    const statePath =
      'C:\\Users\\Origin\\agent-handoff\\workspace-agent-hub-web-ui.json';
    const workspaceRoot = 'D:\\ghws';

    expect(
      buildEnsureWebUiRunningArgs(packageRoot, statePath, workspaceRoot)
    ).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(packageRoot, 'scripts', 'ensure-web-ui-running.ps1'),
      '-StatePath',
      statePath,
      '-JsonOutput',
      '-WorkspaceRoot',
      workspaceRoot,
    ]);
  });

  it('uses pipe-based stdio for streaming restarts instead of inherit handles', () => {
    expect(
      createStreamingSpawnOptions('D:\\ghws\\workspace-agent-hub')
    ).toEqual({
      cwd: 'D:\\ghws\\workspace-agent-hub',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  });

  it('uses detached stdio-less launch options for Windows ensure polling', () => {
    expect(createDetachedSpawnOptions('D:\\ghws\\workspace-agent-hub')).toEqual(
      {
        cwd: 'D:\\ghws\\workspace-agent-hub',
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }
    );
  });

  it('waits for the ensured web UI readiness from the state file instead of child close events', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'workspace-agent-hub-cli-'));
    const statePath = join(tempDir, 'hub-state.json');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('[]');
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', () => resolvePromise());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP address for the test server.');
      }

      const waitPromise = waitForWebUiReadyFromState(
        statePath,
        '2026-03-28T08:00:00.000Z',
        5000
      );
      await writeFile(
        statePath,
        `\uFEFF${JSON.stringify({
          ListenUrl: `http://127.0.0.1:${address.port}/`,
          AccessCode: null,
          ProcessId: 4242,
          UpdatedUtc: '2026-03-28T08:00:01.000Z',
        })}`
      );

      await expect(waitPromise).resolves.toMatchObject({
        ListenUrl: `http://127.0.0.1:${address.port}/`,
        ProcessId: 4242,
      });
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    }
  });

  it('registers the audit command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const auditCommand = program.commands.find(
      (command) => command.name() === 'audit'
    );

    expect(auditCommand?.description()).toContain('Audit one repository');
  });

  it('supports workspace-wide audit from the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const auditCommand = program.commands.find(
      (command) => command.name() === 'audit'
    );

    expect(
      auditCommand?.options.some((option) => option.long === '--workspace')
    ).toBe(true);
  });

  it('registers the runs command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const runsCommand = program.commands.find(
      (command) => command.name() === 'runs'
    );

    expect(runsCommand?.description()).toContain('execution-layer runs');
  });

  it('registers the worker-runtimes command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const runtimesCommand = program.commands.find(
      (command) => command.name() === 'worker-runtimes'
    );

    expect(runtimesCommand?.description()).toContain('runtime availability');
  });

  it('registers the approval-queue command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const command = program.commands.find(
      (entry) => entry.name() === 'approval-queue'
    );

    expect(command?.description()).toContain('require human input');
  });

  it('registers the merge-lanes command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const command = program.commands.find(
      (entry) => entry.name() === 'merge-lanes'
    );

    expect(command?.description()).toContain('merge-lane state');
  });

  it('registers the workspace-health command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const command = program.commands.find(
      (entry) => entry.name() === 'workspace-health'
    );

    expect(command?.description()).toContain('workspace-level contract');
  });

  it('registers the bootstrap-repo command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const command = program.commands.find(
      (entry) => entry.name() === 'bootstrap-repo'
    );

    expect(command?.description()).toContain('high-quality workflow');
  });

  it('registers the preflight command on the CLI surface', () => {
    const program = createProgram(async () => undefined);
    const command = program.commands.find(
      (entry) => entry.name() === 'preflight'
    );

    expect(command?.description()).toContain('unified workspace preflight');
    expect(command?.options.some((option) => option.long === '--apply')).toBe(
      true
    );
    expect(command?.options.some((option) => option.long === '--skip')).toBe(
      true
    );
  });
});
