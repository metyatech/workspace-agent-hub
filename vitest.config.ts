import { defineConfig } from 'vitest/config';

const isWindows = process.platform === 'win32';

export default defineConfig({
  test: {
    testTimeout: isWindows ? 15000 : 5000,
    hookTimeout: isWindows ? 15000 : 5000,
  },
});
