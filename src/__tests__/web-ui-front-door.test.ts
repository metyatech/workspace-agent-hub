import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWebUiFrontDoorServer,
  type StartWebUiFrontDoorOptions,
} from '../web-ui-front-door.js';

async function startTextServer(text: string): Promise<{
  server: ReturnType<typeof createServer>;
  url: string;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  });
  const port = await new Promise<number>((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise(typeof address === 'object' && address ? address.port : 0);
    });
  });
  return {
    server,
    url: `http://127.0.0.1:${port}`,
  };
}

describe('web-ui front door', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it('returns 503 when no upstream is configured yet', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wah-front-door-'));
    cleanup.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const statePath = join(tempDir, 'state.json');

    const frontDoor = await createWebUiFrontDoorServer({
      host: '127.0.0.1',
      port: 0,
      statePath,
    } satisfies StartWebUiFrontDoorOptions);
    cleanup.push(
      async () =>
        await new Promise<void>((resolvePromise) =>
          frontDoor.server.close(() => resolvePromise())
        )
    );

    const response = await fetch(
      `http://127.0.0.1:${frontDoor.port}/api/front-door/health`
    );
    expect(response.status).toBe(503);
  });

  it('proxies requests to the upstream from the shared state file and hot-swaps on update', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wah-front-door-'));
    cleanup.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const statePath = join(tempDir, 'state.json');

    const upstreamOne = await startTextServer('one');
    cleanup.push(
      async () =>
        await new Promise<void>((resolvePromise) =>
          upstreamOne.server.close(() => resolvePromise())
        )
    );
    const upstreamTwo = await startTextServer('two');
    cleanup.push(
      async () =>
        await new Promise<void>((resolvePromise) =>
          upstreamTwo.server.close(() => resolvePromise())
        )
    );

    await writeFile(
      statePath,
      JSON.stringify({ ListenUrl: upstreamOne.url }, null, 2),
      'utf8'
    );

    const frontDoor = await createWebUiFrontDoorServer({
      host: '127.0.0.1',
      port: 0,
      statePath,
    } satisfies StartWebUiFrontDoorOptions);
    cleanup.push(
      async () =>
        await new Promise<void>((resolvePromise) =>
          frontDoor.server.close(() => resolvePromise())
        )
    );

    const first = await fetch(`http://127.0.0.1:${frontDoor.port}/`);
    expect(await first.text()).toBe('one');

    await writeFile(
      statePath,
      JSON.stringify({ ListenUrl: upstreamTwo.url }, null, 2),
      'utf8'
    );

    const second = await fetch(`http://127.0.0.1:${frontDoor.port}/`);
    expect(await second.text()).toBe('two');
  });

  it('accepts state files written with a UTF-8 BOM', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'wah-front-door-'));
    cleanup.push(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });
    const statePath = join(tempDir, 'state.json');

    const upstream = await startTextServer('bom-ok');
    cleanup.push(
      async () =>
        await new Promise<void>((resolvePromise) =>
          upstream.server.close(() => resolvePromise())
        )
    );

    await writeFile(
      statePath,
      `\uFEFF${JSON.stringify({ ListenUrl: upstream.url }, null, 2)}`,
      'utf8'
    );

    const frontDoor = await createWebUiFrontDoorServer({
      host: '127.0.0.1',
      port: 0,
      statePath,
    } satisfies StartWebUiFrontDoorOptions);
    cleanup.push(
      async () =>
        await new Promise<void>((resolvePromise) =>
          frontDoor.server.close(() => resolvePromise())
        )
    );

    const response = await fetch(`http://127.0.0.1:${frontDoor.port}/`);
    expect(await response.text()).toBe('bom-ok');
  });
});
