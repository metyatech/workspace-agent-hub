import { describe, expect, it, vi } from 'vitest';
import { writeFileAtomically } from '../atomic-file.js';

describe('writeFileAtomically', () => {
  it('retries a transient Windows rename collision before succeeding', async () => {
    const writeFileMock = vi.fn().mockResolvedValue(undefined);
    const renameMock = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('busy'), { code: 'EPERM' })
      )
      .mockResolvedValueOnce(undefined);
    const unlinkMock = vi.fn().mockResolvedValue(undefined);
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    await writeFileAtomically('C:\\temp\\manager-meta.json', 'payload', {
      renameRetryCount: 1,
      operations: {
        writeFile: writeFileMock as typeof writeFileMock,
        rename: renameMock as typeof renameMock,
        unlink: unlinkMock as typeof unlinkMock,
        sleep: sleepMock,
      },
    });

    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith(
      'C:\\temp\\manager-meta.json.tmp',
      'payload',
      'utf-8'
    );
    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(renameMock).toHaveBeenLastCalledWith(
      'C:\\temp\\manager-meta.json.tmp',
      'C:\\temp\\manager-meta.json'
    );
    expect(sleepMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it('falls back to an in-place write after repeated Windows rename collisions', async () => {
    const writeFileMock = vi.fn().mockResolvedValue(undefined);
    const renameMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('busy'), { code: 'EPERM' }));
    const unlinkMock = vi.fn().mockResolvedValue(undefined);
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    await writeFileAtomically('C:\\temp\\manager-meta.json', 'payload', {
      renameRetryCount: 2,
      operations: {
        writeFile: writeFileMock as typeof writeFileMock,
        rename: renameMock as typeof renameMock,
        unlink: unlinkMock as typeof unlinkMock,
        sleep: sleepMock,
      },
    });

    expect(renameMock).toHaveBeenCalledTimes(3);
    expect(writeFileMock).toHaveBeenCalledTimes(2);
    expect(writeFileMock).toHaveBeenNthCalledWith(
      1,
      'C:\\temp\\manager-meta.json.tmp',
      'payload',
      'utf-8'
    );
    expect(writeFileMock).toHaveBeenNthCalledWith(
      2,
      'C:\\temp\\manager-meta.json',
      'payload',
      'utf-8'
    );
    expect(unlinkMock).toHaveBeenCalledWith('C:\\temp\\manager-meta.json.tmp');
  });

  it('retries the in-place fallback write when Windows keeps the target file busy', async () => {
    const writeFileMock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error('target busy'), { code: 'EPERM' })
      )
      .mockResolvedValueOnce(undefined);
    const renameMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('busy'), { code: 'EPERM' }));
    const unlinkMock = vi.fn().mockResolvedValue(undefined);
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    await writeFileAtomically('C:\\temp\\manager-meta.json', 'payload', {
      renameRetryCount: 1,
      operations: {
        writeFile: writeFileMock as typeof writeFileMock,
        rename: renameMock as typeof renameMock,
        unlink: unlinkMock as typeof unlinkMock,
        sleep: sleepMock,
      },
    });

    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(writeFileMock).toHaveBeenCalledTimes(3);
    expect(writeFileMock).toHaveBeenNthCalledWith(
      1,
      'C:\\temp\\manager-meta.json.tmp',
      'payload',
      'utf-8'
    );
    expect(writeFileMock).toHaveBeenNthCalledWith(
      2,
      'C:\\temp\\manager-meta.json',
      'payload',
      'utf-8'
    );
    expect(writeFileMock).toHaveBeenNthCalledWith(
      3,
      'C:\\temp\\manager-meta.json',
      'payload',
      'utf-8'
    );
    expect(sleepMock).toHaveBeenCalledTimes(2);
    expect(unlinkMock).toHaveBeenCalledWith('C:\\temp\\manager-meta.json.tmp');
  });
});
