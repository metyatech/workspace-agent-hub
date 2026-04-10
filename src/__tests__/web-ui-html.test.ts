import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const indexHtml = readFileSync(
  join(__dirname, '..', '..', 'public', 'index.html'),
  'utf-8'
);

describe('web-ui HTML', () => {
  it('keeps primary Hub actions and support cards above the workbench', () => {
    const primaryStripIndex = indexHtml.indexOf('class="primary-strip"');
    const statusStripIndex = indexHtml.indexOf('class="status-strip"');
    const workbenchIndex = indexHtml.indexOf(
      '<h2 class="panel-title">最初にやること</h2>'
    );

    expect(primaryStripIndex).toBeGreaterThan(-1);
    expect(indexHtml).toContain('id="jumpStartSessionButton"');
    expect(indexHtml).toContain('id="jumpResumeSessionButton"');
    expect(indexHtml).toContain('id="openManagerButton"');
    expect(statusStripIndex).toBeGreaterThan(primaryStripIndex);
    expect(workbenchIndex).toBeGreaterThan(statusStripIndex);
  });
});
