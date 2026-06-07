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

// La root principale è ora passata esplicitamente (risolta via getMainRepoRoot dai chiamanti).
const MAIN_ROOT = '/home/u/proj';

describe('worktree path resolution', () => {
  it('usa il default ../<name>-worktrees quando baseDir assente', () => {
    expect(resolveWorktreeBaseDir(fakeConfig(), MAIN_ROOT)).toBe('/home/u/proj-worktrees');
  });
  it('risolve baseDir relativo rispetto alla root principale', () => {
    const cfg = fakeConfig({ worktree: { baseDir: '.worktrees' } });
    expect(resolveWorktreeBaseDir(cfg, MAIN_ROOT)).toBe('/home/u/proj/.worktrees');
  });
  it('usa baseDir assoluto così com\'è', () => {
    const cfg = fakeConfig({ worktree: { baseDir: '/tmp/wt' } });
    expect(resolveWorktreeBaseDir(cfg, MAIN_ROOT)).toBe('/tmp/wt');
  });
  it('compone il path con il nome del worktree', () => {
    expect(resolveWorktreePath(fakeConfig(), 'feat-x', MAIN_ROOT)).toBe(
      '/home/u/proj-worktrees/feat-x'
    );
  });
});
