import { rm } from 'node:fs/promises';

export const WINDOWS_TEMP_DIR_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 50,
} as const;

export const WINDOWS_SLOW_TEST_TIMEOUT_MS = 15000;

export async function removeTempDirWithRetries(path: string): Promise<void> {
  await rm(path, WINDOWS_TEMP_DIR_RM_OPTIONS);
}
