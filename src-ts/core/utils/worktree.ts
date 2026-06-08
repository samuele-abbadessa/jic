/**
 * Utility per la gestione dei git worktree in JIC CLI.
 *
 * Risultati spike (Task 2.1, git 2.45.2):
 * - (A) `git submodule update --init --recursive` nel worktree popola i submodule
 *       (git li isola per-worktree in <root>/.git/worktrees/<wt>/modules/<path>).
 * - (B) Il branch di un submodule nel worktree va creato da HEAD (commit pinnato
 *       post-init), NON da `dev`: nel clone submodule del worktree il ref locale
 *       del base branch NON esiste. Usa `git checkout -b <branch>` SENZA base.
 * - (Rimozione) `git worktree remove` rifiuta SEMPRE worktree con submodule senza
 *   --force (anche se puliti). Con --force funziona. Il check "sporco" lo fa il
 *   chiamante; a git passiamo sempre --force.
 */

import { execa } from 'execa';
import { join, isAbsolute, resolve, dirname } from 'path';
import { writeFile } from 'fs/promises';
import type { LoadedConfig } from '../config/loader.js';
import { WorktreeError } from '../errors/index.js';
import { createEmptyState } from '../types/state.js';
import type { JicState } from '../types/state.js';

// ============================================================================
// Version check
// ============================================================================

/** Versione git minima per worktree+submodule affidabili (spike Task 2.1, validato su 2.45.2). */
const MIN_GIT_VERSION: [number, number, number] = [2, 38, 0];

/**
 * Verifica che la versione di git installata supporti worktree+submodule.
 * Lancia WorktreeError con messaggio chiaro se non soddisfatta.
 */
export async function assertGitWorktreeSupport(): Promise<void> {
  let raw: string;
  try {
    const { stdout } = await execa('git', ['--version']);
    raw = stdout;
  } catch (e) {
    throw new WorktreeError(
      'Impossibile determinare la versione di git. Assicurati che git sia installato.',
      undefined,
      e instanceof Error ? e : undefined
    );
  }
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return; // versione non parsabile: non blocchiamo
  const current: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ok =
    current[0] > MIN_GIT_VERSION[0] ||
    (current[0] === MIN_GIT_VERSION[0] &&
      (current[1] > MIN_GIT_VERSION[1] ||
        (current[1] === MIN_GIT_VERSION[1] && current[2] >= MIN_GIT_VERSION[2])));
  if (!ok) {
    throw new WorktreeError(
      `git ${current.join('.')} non supporta in modo affidabile worktree+submodule. ` +
        `Richiesta versione >= ${MIN_GIT_VERSION.join('.')}.`
    );
  }
}

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Risolve la ROOT PRINCIPALE del repo a partire da una cwd qualsiasi.
 *
 * `git rev-parse --path-format=absolute --git-common-dir` restituisce la common
 * git dir del repo PRINCIPALE sia eseguito dalla root sia da un worktree linkato;
 * il suo `dirname` è la root principale. Necessario per risolvere i path dei
 * worktree SEMPRE contro la root: altrimenti, eseguendo da dentro un worktree,
 * `config.projectRoot` è il worktree stesso e i nuovi worktree si annidano
 * (es. `cicero-worktrees/cicero-worktrees/<name>`).
 */
export async function getMainRepoRoot(cwd: string): Promise<string> {
  const { stdout } = await execa(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd }
  );
  return dirname(stdout.trim());
}

/**
 * Risolve la directory base dei worktree.
 * config.worktree.baseDir se presente (relativa a `mainRoot` o assoluta),
 * altrimenti "../<project.name>-worktrees" relativa alla ROOT PRINCIPALE.
 */
export function resolveWorktreeBaseDir(config: LoadedConfig, mainRoot: string): string {
  const configured = config.worktree?.baseDir;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(mainRoot, configured);
  }
  return resolve(mainRoot, '..', `${config.project.name}-worktrees`);
}

/** Path assoluto del worktree di nome `name` (risolto contro la root principale). */
export function resolveWorktreePath(config: LoadedConfig, name: string, mainRoot: string): string {
  return join(resolveWorktreeBaseDir(config, mainRoot), name);
}

// ============================================================================
// List worktrees
// ============================================================================

export interface WorktreeInfo {
  /** Path assoluto del worktree */
  path: string;
  /** Branch checked-out (senza refs/heads/), o undefined se detached */
  branch?: string;
  /** SHA HEAD */
  head?: string;
  /** true se è il worktree principale (== projectRoot) */
  isMain: boolean;
}

/**
 * Elenca i worktree del repo root via `git worktree list --porcelain`.
 * git è la source of truth (anche per worktree creati a mano).
 */
export async function listWorktrees(projectRoot: string): Promise<WorktreeInfo[]> {
  const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: projectRoot });
  const result: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        result.push({ ...current, isMain: current.path === projectRoot } as WorktreeInfo);
      }
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (line.trim() === '' && current.path) {
      result.push({ ...current, isMain: current.path === projectRoot } as WorktreeInfo);
      current = {};
    }
  }
  if (current.path) {
    result.push({ ...current, isMain: current.path === projectRoot } as WorktreeInfo);
  }
  return result;
}

/**
 * Restituisce il path assoluto del worktree che ha `branch` come HEAD checked-out,
 * oppure null se nessun worktree linkato lo ha. Riusa listWorktrees (porcelain).
 * `branch` è il nome nudo (senza refs/heads/), coerente con WorktreeInfo.branch.
 */
export async function findWorktreeForBranch(
  mainRoot: string,
  branch: string
): Promise<string | null> {
  const worktrees = await listWorktrees(mainRoot);
  return worktrees.find((w) => w.branch === branch)?.path ?? null;
}

// ============================================================================
// Add worktree
// ============================================================================

export interface AddWorktreeOptions {
  /** Path assoluto dove creare il worktree */
  worktreePath: string;
  /** Branch del root da creare (nuovo) o su cui agganciarsi (esistente) */
  branch: string;
  /** Branch base da cui creare `branch` (ignorato se useExistingBranch) */
  baseBranch: string;
  /** Se true, aggancia a un branch esistente invece di crearne uno nuovo */
  useExistingBranch?: boolean;
  /** Se true, NON popolare i submodule */
  skipSubmodules?: boolean;
  /** Branch da creare nei submodule target (tipicamente == branch). */
  submoduleBranch?: string;
  /**
   * Base da cui creare il branch dei submodule. Deve esistere in mainRoot/<sub>.
   * Modello origin-based tree: il branch nasce in mainRoot/<sub> da questo base e il
   * worktree lo deriva da origin/<branch>. Se assente, il branch del submodule è
   * creato da HEAD (legacy, es. useExistingBranch).
   */
  submoduleBaseBranch?: string;
  /** Directory (relative a projectRoot) dei submodule target. */
  submoduleDirs?: string[];
  /** Logger opzionale per progress */
  onProgress?: (msg: string) => void;
}

/**
 * Legge gli URL dei submodule da `.gitmodules` e, per quelli RELATIVI (`./` o `../`),
 * costruisce override `-c submodule.<name>.url=<assoluto>` risolti contro la ROOT
 * PRINCIPALE del repo.
 *
 * Necessario perché git risolve gli URL relativi dei submodule contro
 * `remote.origin.url` del superprogetto e, in assenza di remote, contro la posizione
 * su disco del superprogetto. In un worktree quella posizione è il path del worktree,
 * quindi `./back` verrebbe risolto in `<worktree>/back` (inesistente) → clone fallito,
 * e l'eventuale `submodule init` sovrascriverebbe la config CONDIVISA con quel path
 * errato, rompendo anche il repo principale.
 *
 * Passando gli URL assoluti (risolti contro `projectRoot`) come override `-c`, il clone
 * usa il submodule già presente nel repo principale, senza persistere nulla in config.
 * Per URL assoluti (https://, git@, ...) non genera override.
 */
/** True se `ref` esiste nel repo in `cwd` (branch, tag o commit). */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  return execa('git', ['rev-parse', '--verify', '--quiet', ref], { cwd })
    .then(() => true)
    .catch(() => false);
}

async function relativeSubmoduleUrlOverrides(projectRoot: string): Promise<string[]> {
  let raw: string;
  try {
    const { stdout } = await execa(
      'git',
      [
        'config',
        '--file',
        join(projectRoot, '.gitmodules'),
        '--get-regexp',
        '^submodule\\..*\\.url$',
      ],
      { cwd: projectRoot }
    );
    raw = stdout;
  } catch {
    // .gitmodules assente o senza URL: nessun override
    return [];
  }
  const overrides: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp === -1) continue;
    const key = trimmed.slice(0, sp);
    const url = trimmed.slice(sp + 1).trim();
    if (url.startsWith('./') || url.startsWith('../')) {
      overrides.push('-c', `${key}=${resolve(projectRoot, url)}`);
    }
  }
  return overrides;
}

/**
 * Crea un worktree del repo root e (per submodules) popola i submodule.
 * Idempotenza NON garantita: il chiamante verifica prima che il path non esista.
 */
export async function addWorktree(projectRoot: string, opts: AddWorktreeOptions): Promise<void> {
  const log = opts.onProgress ?? (() => {});

  // 1. Crea il worktree del root repo
  const addArgs = opts.useExistingBranch
    ? ['worktree', 'add', opts.worktreePath, opts.branch]
    : ['worktree', 'add', '-b', opts.branch, opts.worktreePath, opts.baseBranch];
  log(`Creazione worktree root: ${opts.worktreePath} (${opts.branch})`);
  await execa('git', addArgs, { cwd: projectRoot });

  if (opts.skipSubmodules) return;

  const dirs = opts.submoduleDirs ?? [];

  // 2. Modello origin-based tree: crea il branch dei submodule in mainRoot/<sub> dal base,
  //    PRIMA di popolare il worktree (così il clone eredita origin/<branch>).
  if (opts.submoduleBranch && opts.submoduleBaseBranch && dirs.length) {
    const base = opts.submoduleBaseBranch;
    // 2a. Verifica preventiva: il base deve esistere in ogni mainRoot/<sub>
    //     (salvo dove il branch esiste già: caso idempotente).
    const missing: string[] = [];
    for (const dir of dirs) {
      const mainSub = join(projectRoot, dir);
      if (await refExists(mainSub, `refs/heads/${opts.submoduleBranch}`)) continue;
      if (!(await refExists(mainSub, base))) missing.push(dir);
    }
    if (missing.length) {
      // cleanup-on-failure: rimuovi il worktree root appena creato, niente stati a metà
      await execa('git', ['worktree', 'remove', '--force', opts.worktreePath], {
        cwd: projectRoot,
      }).catch(() => undefined);
      await execa('git', ['worktree', 'prune'], { cwd: projectRoot }).catch(() => undefined);
      throw new WorktreeError(
        `Base '${base}' non trovato nei submodule: ${missing.join(', ')}. ` +
          `Crea prima il branch base (es. il piano) prima di derivarne un worktree.`
      );
    }
    // 2b. Crea il branch nel parent dal base (idempotente).
    for (const dir of dirs) {
      const mainSub = join(projectRoot, dir);
      if (await refExists(mainSub, `refs/heads/${opts.submoduleBranch}`)) {
        log(`  ${dir}: branch ${opts.submoduleBranch} già presente in root (riuso)`);
        continue;
      }
      log(`  ${dir}: branch ${opts.submoduleBranch} da ${base} (in root)`);
      await execa('git', ['branch', opts.submoduleBranch, base], { cwd: mainSub });
    }
  }

  // 3. Popola i submodule nel worktree (clona da mainRoot/<sub>, eredita origin/*).
  // protocol.file.allow + override URL relativi: vedi relativeSubmoduleUrlOverrides.
  const urlOverrides = await relativeSubmoduleUrlOverrides(projectRoot);
  log('Inizializzazione submodule nel worktree...');
  await execa(
    'git',
    [
      '-c',
      'protocol.file.allow=always',
      ...urlOverrides,
      'submodule',
      'update',
      '--init',
      '--recursive',
    ],
    { cwd: opts.worktreePath }
  );

  // 4. Crea il branch dei submodule nel worktree.
  if (opts.submoduleBranch && dirs.length) {
    for (const dir of dirs) {
      const wtSub = join(opts.worktreePath, dir);
      if (opts.submoduleBaseBranch) {
        // origin-based: il branch esiste in mainRoot/<sub> → ereditato come origin/<branch>
        log(`  ${dir}: checkout -b ${opts.submoduleBranch} (da origin/${opts.submoduleBranch})`);
        await execa(
          'git',
          ['checkout', '-b', opts.submoduleBranch, `origin/${opts.submoduleBranch}`],
          { cwd: wtSub }
        );
      } else {
        // legacy: da HEAD (commit pinnato)
        log(`  ${dir}: checkout -b ${opts.submoduleBranch} (da HEAD)`);
        await execa('git', ['checkout', '-b', opts.submoduleBranch], { cwd: wtSub });
      }
    }
  }
}

// ============================================================================
// Remove worktree
// ============================================================================

export interface RemoveWorktreeOptions {
  worktreePath: string;
  onProgress?: (msg: string) => void;
}

/**
 * Verifica se nel worktree (root o submodule) ci sono modifiche non committate.
 * Ritorna true se "sporco".
 */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const { stdout } = await execa('git', ['status', '--porcelain'], { cwd: worktreePath });
  if (stdout.trim().length > 0) return true;
  // submodule
  const { stdout: subStatus } = await execa(
    'git',
    ['submodule', 'foreach', '--recursive', 'git status --porcelain'],
    { cwd: worktreePath }
  ).catch(() => ({ stdout: '' }));
  // foreach stampa righe "Entering '<path>'" + eventuali porcelain: cerca righe non-Entering
  return subStatus
    .split('\n')
    .some((l) => l.trim().length > 0 && !l.startsWith('Entering '));
}

/**
 * Rimuove un worktree e ripulisce i riferimenti (root + submodule prune).
 * Passa SEMPRE --force: git rifiuta la rimozione di worktree con submodule senza
 * --force, anche quando puliti (spike Task 2.1). Il controllo "modifiche pendenti"
 * è responsabilità del chiamante (isWorktreeDirty), PRIMA di invocare questa funzione.
 * `projectRoot` deve essere la ROOT PRINCIPALE, non il worktree.
 */
export async function removeWorktree(
  projectRoot: string,
  opts: RemoveWorktreeOptions
): Promise<void> {
  const log = opts.onProgress ?? (() => {});
  log(`Rimozione worktree: ${opts.worktreePath}`);
  await execa('git', ['worktree', 'remove', '--force', opts.worktreePath], { cwd: projectRoot });
  // prune difensivo (con --force git pulisce già le registrazioni submodule)
  await execa('git', ['worktree', 'prune'], { cwd: projectRoot });
  await execa('git', ['submodule', 'foreach', '--recursive', 'git worktree prune'], {
    cwd: projectRoot,
  }).catch(() => undefined);
}

// ============================================================================
// Seed worktree state
// ============================================================================

/**
 * Seeda lo stato del nuovo worktree copiando l'activeVendor dalla root corrente.
 * Il resto (sessioni, deployment, build cache) resta isolato/vuoto per natura.
 */
export async function seedWorktreeState(
  worktreePath: string,
  activeVendor?: string
): Promise<void> {
  const state: JicState = createEmptyState();
  if (activeVendor) state.activeVendor = activeVendor;
  await writeFile(
    join(worktreePath, 'jic.state.json'),
    JSON.stringify(state, null, 2) + '\n',
    'utf-8'
  );
}
