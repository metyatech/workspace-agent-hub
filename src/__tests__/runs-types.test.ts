import { describe, expect, it } from 'vitest';
import { canTransitionRunState } from '../runs/types.js';

describe('runs state machine', () => {
  it('allows the normal execution path', () => {
    expect(canTransitionRunState('queued', 'provisioning')).toBe(true);
    expect(canTransitionRunState('provisioning', 'running')).toBe(true);
    expect(canTransitionRunState('running', 'verifying')).toBe(true);
    expect(canTransitionRunState('verifying', 'awaiting-merge')).toBe(true);
    expect(canTransitionRunState('awaiting-merge', 'merging')).toBe(true);
    expect(canTransitionRunState('merging', 'merged')).toBe(true);
  });

  it('allows escalation to needs-human and re-entry', () => {
    expect(canTransitionRunState('running', 'needs-human')).toBe(true);
    expect(canTransitionRunState('needs-human', 'queued')).toBe(true);
    expect(canTransitionRunState('needs-human', 'merging')).toBe(true);
  });

  it('allows conflict resolution before merge success', () => {
    expect(canTransitionRunState('merging', 'conflict-resolving')).toBe(true);
    expect(canTransitionRunState('conflict-resolving', 'merging')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransitionRunState('queued', 'merged')).toBe(false);
    expect(canTransitionRunState('merged', 'running')).toBe(false);
    expect(canTransitionRunState('failed', 'queued')).toBe(false);
  });
});
