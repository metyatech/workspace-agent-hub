import { describe, expect, it } from 'vitest';
import { canTransitionMergeLaneState } from '../../merge-lane/types.js';

describe('merge-lane state machine', () => {
  it('allows the happy-path transition sequence', () => {
    expect(canTransitionMergeLaneState('idle', 'merging')).toBe(true);
    expect(canTransitionMergeLaneState('merging', 'verifying')).toBe(true);
    expect(canTransitionMergeLaneState('verifying', 'pushing')).toBe(true);
    expect(canTransitionMergeLaneState('pushing', 'syncing')).toBe(true);
    expect(canTransitionMergeLaneState('syncing', 'releasing')).toBe(true);
    expect(canTransitionMergeLaneState('releasing', 'idle')).toBe(true);
  });

  it('allows conflict resolution and re-entry from needs-human', () => {
    expect(canTransitionMergeLaneState('merging', 'conflict-resolving')).toBe(
      true
    );
    expect(canTransitionMergeLaneState('conflict-resolving', 'verifying')).toBe(
      true
    );
    expect(canTransitionMergeLaneState('merging', 'needs-human')).toBe(true);
    expect(canTransitionMergeLaneState('needs-human', 'merging')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransitionMergeLaneState('idle', 'pushing')).toBe(false);
    expect(canTransitionMergeLaneState('releasing', 'merging')).toBe(false);
    expect(canTransitionMergeLaneState('verifying', 'idle')).toBe(false);
  });
});
