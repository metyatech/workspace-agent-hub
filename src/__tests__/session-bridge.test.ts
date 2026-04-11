import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceRoot } from '../session-bridge.js';

describe('session bridge workspace root resolution', () => {
  it('infers the workspace root from a normal checkout package root', () => {
    expect(
      resolveWorkspaceRoot({
        packageRoot: 'D:\\ghws\\workspace-agent-hub',
        env: {},
      })
    ).toBe('D:\\ghws');
  });

  it('accepts an explicit workspace root for temporary checkouts', () => {
    const packageRoot = join(tmpdir(), 'wah-live-runtime-test');
    expect(
      resolveWorkspaceRoot({
        packageRoot,
        workspaceRoot: 'D:\\ghws',
        env: {},
      })
    ).toBe('D:\\ghws');
  });

  it('fails fast when a temporary checkout has no explicit workspace root', () => {
    const packageRoot = join(tmpdir(), 'wah-live-runtime-test');
    expect(() =>
      resolveWorkspaceRoot({
        packageRoot,
        env: {},
      })
    ).toThrow(/Workspace root must be provided explicitly/);
  });
});
