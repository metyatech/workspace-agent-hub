import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildEnsureWebUiRunningArgs,
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
});
