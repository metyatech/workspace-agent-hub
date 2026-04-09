import { describe, expect, it } from 'vitest';
import {
  isWindowsBatchCommand,
  wrapWindowsBatchCommandForSpawn,
} from '../windows-batch-spawn.js';

describe('windows-batch-spawn', () => {
  it('detects Windows batch shims', () => {
    expect(isWindowsBatchCommand('C:\\tools\\codex.cmd', 'win32')).toBe(true);
    expect(isWindowsBatchCommand('C:\\tools\\codex.exe', 'win32')).toBe(false);
    expect(isWindowsBatchCommand('/usr/bin/codex', 'linux')).toBe(false);
  });

  it('wraps batch shims with cmd.exe and preserves quoted arguments', () => {
    expect(
      wrapWindowsBatchCommandForSpawn(
        'C:\\Path With Space\\codex.cmd',
        ['exec', 'hello world', 'model_reasoning_effort="xhigh"'],
        {
          platform: 'win32',
          env: {
            ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          } as NodeJS.ProcessEnv,
        }
      )
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Path With Space\\codex.cmd" "exec" "hello world" "model_reasoning_effort=""xhigh""""',
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });
});
