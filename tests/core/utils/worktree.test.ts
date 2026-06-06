import { describe, it, expect } from 'vitest';
import { resolveWorktreeBaseDir, resolveWorktreePath } from '@/core/utils/worktree.js';
import type { LoadedConfig } from '@/core/config/loader.js';

function fakeConfig(over: Partial<LoadedConfig> = {}): LoadedConfig {
  return {
    projectRoot: '/home/u/proj',
    project: { name: 'proj', rootDir: '.' },
    worktree: undefined,
    ...over,
  } as unknown as LoadedConfig;
}

describe('worktree path resolution', () => {
  it('usa il default ../<name>-worktrees quando baseDir assente', () => {
    expect(resolveWorktreeBaseDir(fakeConfig())).toBe('/home/u/proj-worktrees');
  });
  it('risolve baseDir relativo rispetto a projectRoot', () => {
    const cfg = fakeConfig({ worktree: { baseDir: '.worktrees' } });
    expect(resolveWorktreeBaseDir(cfg)).toBe('/home/u/proj/.worktrees');
  });
  it('usa baseDir assoluto così com\'è', () => {
    const cfg = fakeConfig({ worktree: { baseDir: '/tmp/wt' } });
    expect(resolveWorktreeBaseDir(cfg)).toBe('/tmp/wt');
  });
  it('compone il path con il nome del worktree', () => {
    expect(resolveWorktreePath(fakeConfig(), 'feat-x')).toBe('/home/u/proj-worktrees/feat-x');
  });
});
