import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, addMessageMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  addMessageMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@metyatech/thread-inbox', () => ({
  addMessage: addMessageMock,
}));

import {
  buildCodexArgs,
  buildCodexPrompt,
  isSessionInvalidError,
  MANAGER_MODEL,
  MANAGER_REASONING_EFFORT,
  parseCodexOutput,
  readQueue,
  readSession,
  resolveCodexCommand,
  sendToBuiltinManager,
} from '../manager-backend.js';

interface FakeProc extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function makeProc(pid: number): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition.');
}

let tempDir = '';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'workspace-agent-hub-manager-'));
  spawnMock.mockReset();
  addMessageMock.mockReset();
  addMessageMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('manager backend codex integration', () => {
  it('builds codex exec args for first and resumed turns', () => {
    expect(resolveCodexCommand()).toBe('codex');

    expect(buildCodexArgs('hello', null)).toEqual([
      'exec',
      '--json',
      '--model',
      MANAGER_MODEL,
      '-c',
      `model_reasoning_effort="${MANAGER_REASONING_EFFORT}"`,
      'hello',
    ]);

    expect(buildCodexArgs('follow-up', 'thread-123')).toEqual([
      'exec',
      'resume',
      'thread-123',
      '--json',
      '--model',
      MANAGER_MODEL,
      '-c',
      `model_reasoning_effort="${MANAGER_REASONING_EFFORT}"`,
      'follow-up',
    ]);
  });

  it('builds prompts that preserve system context only on first turn', () => {
    const first = buildCodexPrompt('Fix this', 'thread-a', 'D:\\ghws', true);
    const follow = buildCodexPrompt('Next', 'thread-a', 'D:\\ghws', false);

    expect(first).toContain('You are a manager AI assistant');
    expect(first).toContain('Workspace: D:\\ghws');
    expect(first).toContain('[Thread: thread-a]');
    expect(follow).toBe('[Thread: thread-a]\nNext');
  });

  it('parses codex JSON output and extracts thread continuity id + final reply', () => {
    const parsed = parseCodexOutput(
      [
        '[2026-03-20T00:00:00][INFO] prelude',
        '{"type":"thread.started","thread_id":"thread-xyz"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"First answer"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Final answer"}}',
      ].join('\n')
    );

    expect(parsed).toEqual({
      sessionId: 'thread-xyz',
      text: 'Final answer',
    });
  });

  it('parses nested assistant message content and detects stale-session errors', () => {
    const parsed = parseCodexOutput(
      [
        '{"type":"thread.started","thread_id":"thread-nested"}',
        '{"type":"item.completed","item":{"type":"assistant_message","content":[{"text":"Line one"},{"parts":[{"text":"Line two"}]}]}}',
      ].join('\n')
    );

    expect(parsed).toEqual({
      sessionId: 'thread-nested',
      text: 'Line one\nLine two',
    });
    expect(
      isSessionInvalidError('resume failed: session not found for thread-abc')
    ).toBe(true);
  });

  it('starts processing immediately when a manager message arrives while idle', async () => {
    const proc = makeProc(6101);
    spawnMock.mockReturnValueOnce(proc);

    await sendToBuiltinManager(tempDir, 'thread-idle', 'idle message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    proc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-idle"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"idle reply"}}',
        ].join('\n')
      )
    );
    proc.emit('close', 0);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      return queue.length === 0;
    });

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-idle');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('idle reply');
  });

  it('keeps one in-flight codex turn and serializes queued follow-up messages', async () => {
    const firstProc = makeProc(7001);
    const secondProc = makeProc(7002);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(secondProc);

    await sendToBuiltinManager(tempDir, 'thread-one', 'first message');
    await sendToBuiltinManager(tempDir, 'thread-two', 'second message');

    await waitFor(() => spawnMock.mock.calls.length === 1);
    const firstArgs = spawnMock.mock.calls[0]?.[1] as string[];
    expect(firstArgs[0]).toBe('exec');
    expect(firstArgs).not.toContain('resume');

    firstProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstProc.emit('close', 0);

    await waitFor(() => spawnMock.mock.calls.length === 2);
    const secondArgs = spawnMock.mock.calls[1]?.[1] as string[];
    expect(secondArgs.slice(0, 3)).toEqual([
      'exec',
      'resume',
      'codex-thread-1',
    ]);

    secondProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-1"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply two"}}',
        ].join('\n')
      )
    );
    secondProc.emit('close', 0);

    await waitFor(async () => {
      const session = await readSession(tempDir);
      const queue = await readQueue(tempDir);
      return (
        session.status === 'idle' &&
        session.currentQueueId === null &&
        session.sessionId === 'codex-thread-1' &&
        queue.length === 0
      );
    });

    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-one');
    expect(addMessageMock.mock.calls[0]?.[2]).toBe('reply one');
    expect(addMessageMock.mock.calls[1]?.[1]).toBe('thread-two');
    expect(addMessageMock.mock.calls[1]?.[2]).toBe('reply two');
  });

  it('resets the saved codex thread id after an invalid resume failure', async () => {
    const firstProc = makeProc(8101);
    const failingProc = makeProc(8102);
    spawnMock.mockReturnValueOnce(firstProc).mockReturnValueOnce(failingProc);

    await sendToBuiltinManager(tempDir, 'thread-one', 'first message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    firstProc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-stale"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply one"}}',
        ].join('\n')
      )
    );
    firstProc.emit('close', 0);

    await waitFor(async () => {
      const session = await readSession(tempDir);
      return (
        session.status === 'idle' && session.sessionId === 'codex-thread-stale'
      );
    });

    await sendToBuiltinManager(tempDir, 'thread-two', 'follow-up');
    await waitFor(() => spawnMock.mock.calls.length === 2);
    failingProc.stderr.emit(
      'data',
      Buffer.from('resume failed: session not found for codex-thread-stale')
    );
    failingProc.emit('close', 1);

    await waitFor(async () => {
      const session = await readSession(tempDir);
      return session.status === 'idle' && session.sessionId === null;
    });

    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock.mock.calls[1]?.[2]).toContain(
      'codex CLI exited with code 1'
    );
  });

  it('reports a parse error instead of silently dropping a successful turn with no usable reply', async () => {
    const proc = makeProc(8201);
    spawnMock.mockReturnValueOnce(proc);

    await sendToBuiltinManager(tempDir, 'thread-parse', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    proc.stdout.emit(
      'data',
      Buffer.from('{"type":"thread.started","thread_id":"codex-thread-parse"}')
    );
    proc.emit('close', 0);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]?.[1]).toBe('thread-parse');
    expect(addMessageMock.mock.calls[0]?.[2]).toContain(
      'no usable assistant reply could be parsed'
    );
  });

  it('consumes the queue entry even if writing a successful reply back to thread storage fails', async () => {
    const proc = makeProc(8301);
    spawnMock.mockReturnValueOnce(proc);
    addMessageMock.mockRejectedValueOnce(new Error('thread write failed'));

    await sendToBuiltinManager(tempDir, 'thread-write-fail', 'message');
    await waitFor(() => spawnMock.mock.calls.length === 1);

    proc.stdout.emit(
      'data',
      Buffer.from(
        [
          '{"type":"thread.started","thread_id":"codex-thread-write-fail"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"reply that cannot be stored"}}',
        ].join('\n')
      )
    );
    proc.emit('close', 0);

    await waitFor(async () => {
      const queue = await readQueue(tempDir);
      const session = await readSession(tempDir);
      return queue.length === 0 && session.status === 'idle';
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
  });
});
