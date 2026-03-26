import {
  rename as fsRename,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';

const DEFAULT_RENAME_RETRY_COUNT = process.platform === 'win32' ? 4 : 0;
const DEFAULT_RENAME_RETRY_DELAY_MS = 40;
const RETRYABLE_RENAME_ERROR_CODES = new Set(['EPERM', 'EACCES']);

export interface AtomicWriteOperations {
  writeFile: typeof fsWriteFile;
  rename: typeof fsRename;
  unlink: typeof fsUnlink;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface AtomicWriteOptions {
  renameRetryCount?: number;
  renameRetryDelayMs?: number;
  operations?: Partial<AtomicWriteOperations>;
}

function isRetryableRenameError(
  error: unknown
): error is NodeJS.ErrnoException {
  if (process.platform !== 'win32') {
    return false;
  }
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === 'string' &&
    RETRYABLE_RENAME_ERROR_CODES.has((error as NodeJS.ErrnoException).code!)
  );
}

async function bestEffortCleanupTempFile(
  filePath: string,
  operations: AtomicWriteOperations
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await operations.unlink(filePath);
      return;
    } catch (error) {
      const code =
        error instanceof Error
          ? ((error as NodeJS.ErrnoException).code ?? null)
          : null;
      if (code === 'ENOENT') {
        return;
      }
      if (!isRetryableRenameError(error) || attempt === 2) {
        return;
      }
      await operations.sleep(DEFAULT_RENAME_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

export async function writeFileAtomically(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const operations: AtomicWriteOperations = {
    writeFile: fsWriteFile,
    rename: fsRename,
    unlink: fsUnlink,
    sleep: (milliseconds: number) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...options.operations,
  };
  const renameRetryCount = Math.max(
    0,
    options.renameRetryCount ?? DEFAULT_RENAME_RETRY_COUNT
  );
  const renameRetryDelayMs = Math.max(
    0,
    options.renameRetryDelayMs ?? DEFAULT_RENAME_RETRY_DELAY_MS
  );

  await operations.writeFile(tmpPath, content, 'utf-8');

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= renameRetryCount; attempt += 1) {
    try {
      await operations.rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableRenameError(error) || attempt === renameRetryCount) {
        break;
      }
      await operations.sleep(renameRetryDelayMs * (attempt + 1));
    }
  }

  if (isRetryableRenameError(lastError)) {
    await operations.writeFile(filePath, content, 'utf-8');
    await bestEffortCleanupTempFile(tmpPath, operations);
    return;
  }

  await bestEffortCleanupTempFile(tmpPath, operations);
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to write ${filePath}.`);
}
