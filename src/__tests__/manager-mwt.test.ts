import { describe, expect, it } from 'vitest';
import { describeMwtError } from '../manager-mwt.js';

describe('describeMwtError', () => {
  it('includes recovery guidance and verify output excerpts', () => {
    const detail = describeMwtError({
      message: 'Verification failed during deliver.',
      details: {
        recovery: 'Resolve the verification failure and retry deliver.',
        stderr:
          '\u001b[31mError: listen EADDRINUSE: address already in use :::3101\u001b[39m',
        stdout:
          '> course-docs-site@0.0.0 verify\n> npm run lint && npm run test',
      },
    });

    expect(detail).toContain('Verification failed during deliver.');
    expect(detail).toContain(
      'Resolve the verification failure and retry deliver.'
    );
    expect(detail).toContain(
      'stderr:\nError: listen EADDRINUSE: address already in use :::3101'
    );
    expect(detail).toContain(
      'stdout:\n> course-docs-site@0.0.0 verify\n> npm run lint && npm run test'
    );
  });

  it('falls back to the raw value for non-structured errors', () => {
    expect(describeMwtError('plain failure')).toBe('plain failure');
  });
});
