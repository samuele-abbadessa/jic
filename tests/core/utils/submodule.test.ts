import { describe, it, expect } from 'vitest';
import { buildSubmodulePointerCommitMessage } from '@/core/utils/submodule.js';

describe('submodule utilities', () => {
  describe('buildSubmodulePointerCommitMessage', () => {
    it('should generate commit message listing updated modules', () => {
      const msg = buildSubmodulePointerCommitMessage(['service-a', 'frontend']);
      expect(msg).toBe('chore: update submodule pointers [service-a, frontend]');
    });

    it('should handle single module', () => {
      const msg = buildSubmodulePointerCommitMessage(['service-a']);
      expect(msg).toBe('chore: update submodule pointers [service-a]');
    });
  });
});
