import { describe, expect, it, vi } from 'vitest';
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
});
