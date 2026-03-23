import { describe, expect, it, vi } from 'vitest';

const { readManagerWorkItemsMock } = vi.hoisted(() => ({
  readManagerWorkItemsMock: vi.fn(),
}));

vi.mock('../manager-work-items.js', () => ({
  readManagerWorkItems: readManagerWorkItemsMock,
}));

import { createProgram } from '../cli.js';

describe('CLI', () => {
  it('passes machine-readable launch options through to startWebUi', async () => {
    const startWebUiMock = vi.fn().mockResolvedValue(undefined);
    const program = createProgram(
      startWebUiMock as Parameters<typeof createProgram>[0]
    );

    await program.parseAsync(
      [
        'node',
        'workspace-agent-hub',
        'web-ui',
        '--host',
        '0.0.0.0',
        '--port',
        '4455',
        '--public-url',
        'https://hub.example.test/connect',
        '--tailscale-serve',
        '--auth-token',
        'secret-token',
        '--json',
        '--no-open-browser',
      ],
      { from: 'node' }
    );

    expect(startWebUiMock).toHaveBeenCalledWith({
      host: '0.0.0.0',
      port: 4455,
      publicUrl: 'https://hub.example.test/connect',
      tailscaleServe: true,
      authToken: 'secret-token',
      jsonOutput: true,
      openBrowser: false,
    });
  });

  it('prints the work-item graph as JSON', async () => {
    readManagerWorkItemsMock.mockResolvedValueOnce([
      {
        id: 'item-1',
        title: '親作業',
        uiState: 'ai-working',
        derivedFromThreadIds: [],
        derivedChildThreadIds: ['item-2'],
      },
      {
        id: 'item-2',
        title: '派生作業',
        uiState: 'queued',
        derivedFromThreadIds: ['item-1'],
        derivedChildThreadIds: [],
      },
    ]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram(vi.fn().mockResolvedValue(undefined));

    await program.parseAsync(
      [
        'node',
        'workspace-agent-hub',
        'work-items',
        '--workspace',
        'D:\\ghws\\workspace-agent-hub',
        '--json',
      ],
      { from: 'node' }
    );

    expect(readManagerWorkItemsMock).toHaveBeenCalledWith(
      'D:\\ghws\\workspace-agent-hub'
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          workItems: [
            {
              id: 'item-1',
              title: '親作業',
              uiState: 'ai-working',
              derivedFromThreadIds: [],
              derivedChildThreadIds: ['item-2'],
            },
            {
              id: 'item-2',
              title: '派生作業',
              uiState: 'queued',
              derivedFromThreadIds: ['item-1'],
              derivedChildThreadIds: [],
            },
          ],
        },
        null,
        2
      )
    );
    logSpy.mockRestore();
  });
});
