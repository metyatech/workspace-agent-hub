import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWorkerRuntimeLaunchSpec,
  describeWorkerRuntimeCliAvailability,
  parseGenericRuntimeOutput,
  parseGenericRuntimeProgressLine,
  workerRuntimeAssigneeLabel,
} from '../manager-worker-runtime.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('manager-worker-runtime', () => {
  it('builds a Claude launch spec that resumes the existing session in read-only mode', () => {
    const spec = buildWorkerRuntimeLaunchSpec({
      runtime: 'claude',
      prompt: 'Investigate the failure',
      sessionId: 'claude-session-1',
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      runMode: 'read-only',
      platform: 'win32',
      env: {
        CLAUDE_PATH: 'claude.exe',
        GIT_DIR: 'D:\\ghws\\workspace-agent-hub\\.git',
        GIT_WORK_TREE: 'D:\\ghws\\workspace-agent-hub',
      },
    });

    expect(spec.command).toBe('claude.exe');
    expect(spec.prompt).toBeNull();
    expect(spec.sessionId).toBe('claude-session-1');
    expect(spec.args).toEqual(
      expect.arrayContaining([
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'plan',
        '--resume',
        'claude-session-1',
        '--add-dir',
        'D:\\ghws\\workspace-agent-hub',
        '--',
        'Investigate the failure',
      ])
    );
    expect(spec.spawnOptions.env.GIT_DIR).toBeUndefined();
    expect(spec.spawnOptions.env.GIT_WORK_TREE).toBeUndefined();
  });

  it('builds a Copilot launch spec with explicit prompt arguments', () => {
    const spec = buildWorkerRuntimeLaunchSpec({
      runtime: 'copilot',
      prompt: 'Apply the requested fix',
      sessionId: 'copilot-session-1',
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      runMode: 'write',
      platform: 'win32',
      env: {
        COPILOT_PATH: 'copilot.exe',
      },
    });

    expect(spec.command).toBe('copilot.exe');
    expect(spec.prompt).toBeNull();
    expect(spec.args).toEqual(
      expect.arrayContaining([
        '--output-format',
        'json',
        '--allow-all-tools',
        '--allow-all-paths',
        '--no-ask-user',
        '--resume=copilot-session-1',
        '--prompt',
        'Apply the requested fix',
      ])
    );
    expect(workerRuntimeAssigneeLabel('copilot')).toBe('Worker Copilot');
  });

  it('builds an OpenCode launch spec that runs sisyphus in non-interactive JSON mode', () => {
    const spec = buildWorkerRuntimeLaunchSpec({
      runtime: 'opencode',
      prompt: 'Apply the requested fix',
      sessionId: 'opencode-session-1',
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      runMode: 'write',
      platform: 'win32',
      env: {
        OPENCODE_PATH: 'C:\\tools\\opencode.cmd',
      },
    });

    expect(spec.command).toBe('cmd.exe');
    expect(spec.prompt).toBe('Apply the requested fix');
    expect(spec.sessionId).toBe('opencode-session-1');
    expect(spec.args.join(' ')).toContain('"C:\\tools\\opencode.cmd" "run"');
    expect(spec.args.join(' ')).toContain('"--format" "json"');
    expect(spec.args.join(' ')).toContain('"--agent" "sisyphus"');
    expect(spec.args.join(' ')).toContain('"--dangerously-skip-permissions"');
    expect(spec.args.join(' ')).toContain('"--session" "opencode-session-1"');
    expect(spec.args.join(' ')).not.toContain('Apply the requested fix');
    expect(workerRuntimeAssigneeLabel('opencode')).toBe('Worker OpenCode');
  });

  it('prefers the PATH-resolved OpenCode executable over the AppData npm shim on Windows', async () => {
    const pathDir = await makeTempDir('wah-opencode-path-');
    const appDataDir = await makeTempDir('wah-opencode-appdata-');
    const pathBinary = join(pathDir, 'opencode.exe');
    const appDataShimDir = join(appDataDir, 'npm');
    const appDataShim = join(appDataShimDir, 'opencode.cmd');
    await writeFile(pathBinary, '');
    await mkdir(appDataShimDir, { recursive: true });
    await writeFile(appDataShim, '@echo off\r\n');

    const spec = buildWorkerRuntimeLaunchSpec({
      runtime: 'opencode',
      prompt: 'Apply the requested fix',
      sessionId: null,
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      runMode: 'write',
      platform: 'win32',
      env: {
        PATH: pathDir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        APPDATA: appDataDir,
      },
    });

    expect(spec.command.toLowerCase()).toBe(pathBinary.toLowerCase());
  });

  it('respects an explicit OpenCode agent override', () => {
    const spec = buildWorkerRuntimeLaunchSpec({
      runtime: 'opencode',
      prompt: 'Apply the requested fix',
      sessionId: null,
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      runMode: 'write',
      platform: 'win32',
      env: {
        OPENCODE_PATH: 'C:\\tools\\opencode.exe',
        WORKSPACE_AGENT_HUB_OPENCODE_AGENT: 'hephaestus',
      },
    });

    expect(spec.command).toBe('C:\\tools\\opencode.exe');
    expect(spec.args).toEqual(
      expect.arrayContaining(['--agent', 'hephaestus'])
    );
  });

  it('reports PATH-resolved OpenCode availability before falling back to AppData shims', async () => {
    const pathDir = await makeTempDir('wah-opencode-availability-');
    const pathBinary = join(pathDir, 'opencode.exe');
    await writeFile(pathBinary, '');

    const availability = describeWorkerRuntimeCliAvailability('opencode', {
      platform: 'win32',
      env: {
        PATH: pathDir,
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        APPDATA: 'C:\\missing-appdata',
      },
    });

    expect(availability.available).toBe(true);
    expect(availability.resolvedPath?.toLowerCase()).toBe(
      pathBinary.toLowerCase()
    );
  });

  it('builds a Codex launch spec that wraps the Windows cmd shim through cmd.exe', () => {
    const spec = buildWorkerRuntimeLaunchSpec({
      runtime: 'codex',
      prompt: 'Apply the requested fix',
      sessionId: null,
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      runMode: 'write',
      platform: 'win32',
      env: {
        CODEX_PATH: 'C:\\tools\\codex.cmd',
      },
    });

    expect(spec.command).toBe('cmd.exe');
    expect(spec.prompt).toBe('Apply the requested fix');
    expect(spec.args).toEqual([
      '/d',
      '/s',
      '/c',
      '""C:\\tools\\codex.cmd" "exec" "--skip-git-repo-check" "--json" "--model" "gpt-5.4" "-c" "model_reasoning_effort=""xhigh""" "-""',
    ]);
    expect(spec.spawnOptions).toEqual({
      cwd: 'D:\\ghws\\workspace-agent-hub',
      env: expect.objectContaining({
        CODEX_PATH: 'C:\\tools\\codex.cmd',
      }),
      shell: false,
      windowsVerbatimArguments: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(workerRuntimeAssigneeLabel('codex')).toBe('Worker Codex');
  });

  it('allows a worker assignment to override the default model and effort', () => {
    const spec = buildWorkerRuntimeLaunchSpec({
      runtime: 'codex',
      model: 'gpt-5.4-pro',
      effort: 'xhigh',
      prompt: 'Apply the requested fix',
      sessionId: null,
      resolvedDir: 'D:\\ghws\\workspace-agent-hub',
      runMode: 'write',
      platform: 'win32',
      env: {
        CODEX_PATH: 'C:\\tools\\codex.cmd',
      },
    });

    expect(spec.args.join(' ')).toContain('"gpt-5.4-pro"');
    expect(spec.displayLabel).toContain('gpt-5.4-pro');
  });

  it('parses generic runtime JSON progress and final output', () => {
    const progress = parseGenericRuntimeProgressLine(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        session_id: 'gemini-session-1',
        text: 'First delta',
      }),
      'Started'
    );
    expect(progress.sessionId).toBe('gemini-session-1');
    expect(progress.latestText).toBe('First delta');
    expect(progress.liveEntries[0]?.kind).toBe('output');

    const parsed = parseGenericRuntimeOutput(
      [
        JSON.stringify({
          type: 'init',
          session_id: 'gemini-session-1',
        }),
        JSON.stringify({
          role: 'assistant',
          delta: true,
          text: '{"status":"review",',
        }),
        JSON.stringify({
          role: 'assistant',
          delta: true,
          text: '"reply":"all set"}',
        }),
      ].join('\n')
    );

    expect(parsed.sessionId).toBe('gemini-session-1');
    expect(parsed.text).toBe('{"status":"review","reply":"all set"}');
  });

  it('parses OpenCode JSON event streams into progress and final output', () => {
    const progress = parseGenericRuntimeProgressLine(
      JSON.stringify({
        type: 'text',
        sessionID: 'opencode-session-1',
        part: { text: 'First delta' },
      }),
      'Started'
    );
    expect(progress.sessionId).toBe('opencode-session-1');
    expect(progress.latestText).toBe('First delta');
    expect(progress.liveEntries[0]?.kind).toBe('output');

    const parsed = parseGenericRuntimeOutput(
      [
        JSON.stringify({
          type: 'step_start',
          sessionID: 'opencode-session-1',
        }),
        JSON.stringify({
          type: 'text',
          sessionID: 'opencode-session-1',
          part: { text: '{"status":"review",' },
        }),
        JSON.stringify({
          type: 'text',
          sessionID: 'opencode-session-1',
          part: { text: '"reply":"all set"}' },
        }),
      ].join('\n')
    );

    expect(parsed.sessionId).toBe('opencode-session-1');
    expect(parsed.text).toBe('{"status":"review","reply":"all set"}');
  });
});
