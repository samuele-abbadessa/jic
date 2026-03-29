/**
 * PR (Merge Request) command for JIC CLI
 *
 * Creates and lists GitLab merge requests for vendor modules.
 */

import { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { VendorError, withErrorHandling } from '../core/errors/index.js';
import { createMergeRequestsForModules, listMergeRequestsForModules } from '../core/utils/gitlab.js';

export function registerPrCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const pr = program
    .command('pr')
    .description('Manage GitLab merge requests for vendor modules');

  // --- pr create ---
  pr
    .command('create')
    .description('Create merge requests from vendor/dev to target branch for all vendor modules')
    .option('--target <branch>', 'Target branch for merge requests', 'master')
    .option('--title <title>', 'MR title (default: auto-generated)')
    .option('--draft', 'Create as draft merge request')
    .action(
      withErrorHandling(async (options: { target: string; title?: string; draft?: boolean }) => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        await createMergeRequestsForModules(ctx, {
          target: options.target,
          title: options.title,
          draft: options.draft ?? false,
        });
      })
    );

  // --- pr list ---
  pr
    .command('list')
    .description('List open merge requests for active vendor modules')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        assertSubmodules(ctx);

        await listMergeRequestsForModules(ctx);
      })
    );
}

function assertSubmodules(ctx: IExecutionContext): void {
  if (!ctx.isSubmodules()) {
    throw new VendorError(
      'PR commands are only available for projects with type "submodules".'
    );
  }
}
