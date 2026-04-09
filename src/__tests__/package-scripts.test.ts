import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type PackageJson = {
  scripts?: Record<string, string>;
};

const packageJsonPath = join(import.meta.dirname, '..', '..', 'package.json');
const packageJson = JSON.parse(
  readFileSync(packageJsonPath, 'utf8')
) as PackageJson;

describe('package scripts', () => {
  it('uses the expected local command wrappers for hook-facing scripts', () => {
    const scripts = packageJson.scripts ?? {};

    expect(scripts.build).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-package.ps1'
    );
    expect(scripts.typecheck).toBe('npm exec tsc -- --noEmit');
    expect(scripts['pretest:e2e']).toBe(
      'npm run build && npm exec playwright install chromium'
    );
    expect(scripts['test:unit']).toBe('npm exec vitest run src/__tests__');
    expect(scripts['test:e2e']).toBe('npm exec playwright test');
    expect(scripts.format).toBe(
      'npm exec prettier -- --write "src/**/*.ts" "public/**/*.{html,js,webmanifest}" "*.{json,md,ts}"'
    );
    expect(scripts['format:check']).toBe(
      'npm exec prettier -- --check "src/**/*.ts" "public/**/*.{html,js,webmanifest}" "*.{json,md,ts}"'
    );
  });
});
