/**
 * Worktree command for JIC CLI
 *
 * Crea e gestisce git worktree isolati. Ogni worktree è una projectRoot
 * indipendente (Modello A): cartella separata, stato isolato.
 */

import { Command } from 'commander';
import { execa } from 'execa';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { WorktreeError, withErrorHandling } from '../core/errors/index.js';
import {
  assertGitWorktreeSupport,
  resolveWorktreePath,
  listWorktrees,
  addWorktree,
  removeWorktree,
  isWorktreeDirty,
  seedWorktreeState,
} from '../core/utils/worktree.js';

export function registerWorktreeCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const worktree = program
    .command('worktree')
    .description('Crea e gestisce git worktree isolati per lavoro in parallelo');

  // --- worktree create ---
  worktree
    .command('create <name>')
    .description('Crea un worktree isolato con branch vendor-aware e submodule popolati')
    .option('--branch <branch>', 'Aggancia a un branch esistente invece di crearne uno nuovo')
    .option('--base <branch>', 'Branch base (default: dev del vendor)')
    .option('--no-submodules', 'Non popolare i submodule (caso avanzato)')
    .action(
      withErrorHandling(async (name: string, options: { branch?: string; base?: string; submodules?: boolean }) => {
        const ctx = await createContext();
        await assertGitWorktreeSupport();

        const worktreePath = resolveWorktreePath(ctx.config, name);

        const existing = await listWorktrees(ctx.projectRoot);
        if (existing.some((w) => w.path === worktreePath)) {
          throw new WorktreeError(`Esiste già un worktree in ${worktreePath}`, name);
        }

        const isSubmodules = ctx.isSubmodules();
        const vendorConfig = ctx.vendorConfig;
        let branch: string;
        let baseBranch: string;
        if (isSubmodules && vendorConfig) {
          branch = options.branch ?? `${ctx.activeVendor}/feature/${name}`;
          baseBranch = options.base ?? vendorConfig.branches.dev;
        } else {
          branch = options.branch ?? `feature/${name}`;
          baseBranch = options.base ?? 'master';
        }

        const vendorModuleDirs =
          isSubmodules && vendorConfig
            ? Object.values(ctx.config.resolvedModules)
                .filter((m) => vendorConfig.modules.includes(m.name))
                .map((m) => m.originalConfig.directory)
            : [];

        ctx.output.header(`Crea worktree: ${name}`);
        ctx.output.keyValue('Path', worktreePath);
        ctx.output.keyValue('Branch', branch);
        ctx.output.keyValue('Base', baseBranch);

        await addWorktree(ctx.projectRoot, {
          worktreePath,
          branch,
          baseBranch,
          useExistingBranch: !!options.branch,
          skipSubmodules: options.submodules === false || !isSubmodules,
          submoduleBranch: isSubmodules && !options.branch ? branch : undefined,
          vendorModuleDirs,
          onProgress: (msg) => ctx.output.log(`  ${msg}`),
        });

        await seedWorktreeState(worktreePath, ctx.activeVendor);

        ctx.output.success(`Worktree "${name}" creato.`);
        ctx.output.log(worktreePath);
      })
    );

  // --- worktree list ---
  worktree
    .command('list')
    .description('Elenca i worktree esistenti')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        const worktrees = await listWorktrees(ctx.projectRoot);

        if (ctx.json) {
          ctx.output.json(worktrees);
          return;
        }

        const secondary = worktrees.filter((w) => !w.isMain);
        if (secondary.length === 0) {
          ctx.output.info('Nessun worktree secondario. Usa "jic worktree create <name>" per crearne uno.');
          return;
        }

        ctx.output.info('Worktree:');
        for (const w of worktrees) {
          const marker = w.isMain ? ' (main)' : '';
          const branch = w.branch ? ` [${w.branch}]` : ' [detached]';
          ctx.output.log(`  ${w.path}${branch}${marker}`);
        }
      })
    );

  // --- worktree remove ---
  worktree
    .command('remove <name>')
    .description('Rimuove un worktree e ripulisce i riferimenti')
    .option('-f, --force', 'Rimuovi anche con modifiche pendenti')
    .option('--keep-branch', 'Non eliminare il branch associato al worktree')
    .action(
      withErrorHandling(async (name: string, options: { force?: boolean; keepBranch?: boolean }) => {
        const ctx = await createContext();
        const worktreePath = resolveWorktreePath(ctx.config, name);

        const existing = await listWorktrees(ctx.projectRoot);
        const target = existing.find((w) => w.path === worktreePath);
        if (!target) {
          throw new WorktreeError(`Nessun worktree trovato in ${worktreePath}`, name);
        }
        if (target.isMain) {
          throw new WorktreeError('Non puoi rimuovere il worktree principale.', name);
        }

        if (!options.force && (await isWorktreeDirty(worktreePath))) {
          throw new WorktreeError(
            `Il worktree "${name}" ha modifiche non committate. Usa --force per rimuoverlo comunque.`,
            name
          );
        }

        // Il check "sporco" sopra (guardato da --force) sostituisce il --force di git,
        // che removeWorktree passa comunque sempre (richiesto dai submodule, spike Task 2.1).
        await removeWorktree(ctx.projectRoot, {
          worktreePath,
          onProgress: (msg) => ctx.output.log(`  ${msg}`),
        });

        // Elimina il branch associato (root + submodule vendor) salvo --keep-branch
        if (!options.keepBranch && target.branch) {
          const branch = target.branch;
          try {
            await deleteWorktreeBranch(ctx, branch);
            ctx.output.log(`  Branch ${branch} eliminato`);
          } catch {
            ctx.output.warn(`  Impossibile eliminare il branch ${branch} (lascialo o eliminalo a mano).`);
          }
        }

        ctx.output.success(`Worktree "${name}" rimosso.`);
      })
    );

  // --- worktree path ---
  worktree
    .command('path <name>')
    .description('Stampa il path assoluto di un worktree (per cd/scripting)')
    .action(
      withErrorHandling(async (name: string) => {
        const ctx = await createContext();
        const worktreePath = resolveWorktreePath(ctx.config, name);
        const existing = await listWorktrees(ctx.projectRoot);
        if (!existing.some((w) => w.path === worktreePath)) {
          throw new WorktreeError(`Nessun worktree trovato in ${worktreePath}`, name);
        }
        process.stdout.write(worktreePath + '\n');
      })
    );
}

async function deleteWorktreeBranch(ctx: IExecutionContext, branch: string): Promise<void> {
  await execa('git', ['branch', '-D', branch], { cwd: ctx.projectRoot }).catch(() => undefined);
  if (ctx.isSubmodules() && ctx.vendorConfig) {
    const vendorConfig = ctx.vendorConfig;
    for (const mod of Object.values(ctx.config.resolvedModules)) {
      if (!vendorConfig.modules.includes(mod.name)) continue;
      await execa('git', ['branch', '-D', branch], { cwd: mod.absolutePath }).catch(() => undefined);
    }
  }
}
