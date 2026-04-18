import { describe, expect, it } from 'vitest';
import {
  getWorkerRuntimeAvailability,
  listWorkerRuntimeAvailability,
} from '../worker-adapter/availability.js';

describe('worker-adapter availability', () => {
  it('reports missing runtimes when the command is unavailable', () => {
    const availability = getWorkerRuntimeAvailability('opencode', {
      platform: 'win32',
      env: { PATH: '', Path: '', APPDATA: '', USERPROFILE: '' },
    });

    expect(availability.runtime).toBe('opencode');
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('was not found');
  });

  it('lists every known runtime exactly once', () => {
    const runtimes = listWorkerRuntimeAvailability({
      platform: 'win32',
      env: { PATH: '', Path: '', APPDATA: '', USERPROFILE: '' },
    }).map((entry) => entry.runtime);

    expect(runtimes).toEqual([
      'opencode',
      'codex',
      'claude',
      'gemini',
      'copilot',
    ]);
  });
});
