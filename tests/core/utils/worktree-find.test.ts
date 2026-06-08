import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
import { execa } from 'execa';
import { findWorktreeForBranch } from '@/core/utils/worktree.js';

const mockExeca = vi.mocked(execa);

// Output porcelain realistico: main su master, integration su feature/plan, chunk detached
const PORCELAIN = [
  'worktree /home/u/proj',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/master',
  '',
  'worktree /home/u/proj-worktrees/integration',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feature/plan',
  '',
  'worktree /home/u/proj-worktrees/detached-wt',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
].join('\n');

describe('findWorktreeForBranch', () => {
  beforeEach(() => {
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({ stdout: PORCELAIN } as never);
  });

  it('trova il path del worktree che ha il branch checked-out', async () => {
    expect(await findWorktreeForBranch('/home/u/proj', 'feature/plan')).toBe(
      '/home/u/proj-worktrees/integration'
    );
  });

  it('restituisce null se nessun worktree ha quel branch', async () => {
    expect(await findWorktreeForBranch('/home/u/proj', 'feature/inesistente')).toBeNull();
  });

  it('ignora i worktree detached', async () => {
    expect(await findWorktreeForBranch('/home/u/proj', '3333333333333333333333333333333333333333')).toBeNull();
  });

  it('matcha sul nome nudo, non su refs/heads/', async () => {
    expect(await findWorktreeForBranch('/home/u/proj', 'refs/heads/feature/plan')).toBeNull();
  });
});
