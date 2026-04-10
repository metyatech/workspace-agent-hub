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
  it('keeps primary Hub actions above the workbench and secondary support cards', () => {
    const heroActionsIndex = indexHtml.indexOf('class="hero-actions"');
    const workbenchIndex = indexHtml.indexOf('id="workbench"');
    const supportGridIndex = indexHtml.indexOf('class="support-grid"');

    expect(heroActionsIndex).toBeGreaterThan(-1);
    expect(indexHtml).toContain(
      'href="#workbench" class="button">新しい session を始める</a>'
    );
    expect(indexHtml).toContain(
      'href="#sessionsList" class="button secondary">続きから選ぶ</a>'
    );
    expect(indexHtml).toContain('id="openManagerButton"');
    expect(workbenchIndex).toBeGreaterThan(heroActionsIndex);
    expect(supportGridIndex).toBeGreaterThan(workbenchIndex);
  });
});
