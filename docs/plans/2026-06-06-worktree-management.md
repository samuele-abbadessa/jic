# Gestione Git Worktree in jic

**Goal:** Aggiungere a `jic` il comando `jic worktree` per creare e gestire git worktree isolati (cartelle separate, auto-sufficienti) in progetti con submodules, più l'integrazione con le sessioni.

**Architecture:** Modello A — ogni worktree è una `projectRoot` indipendente: contiene il suo `jic.config.json` (tracciato) e il suo `jic.state.json` (git-ignored, isolato). Il core di `jic` (loader, ExecutionContext) NON viene toccato: un `jic` lanciato dentro un worktree opera già su quella cartella come root. Il lavoro si concentra in (1) un helper submodule-aware per provisionare/rimuovere worktree e (2) il comando che lo espone, più l'integrazione sessioni via spawn di `jic session start` nel cwd del worktree.

**Primary scope:** comando `jic worktree` (create/list/remove/path) per worktree isolati in progetti submodules.

**Secondary scopes:** integrazione sessioni (`session start --worktree`), config `worktree`, `WorktreeError`, documentazione.

**Size:** L

**Branch target:** `master`

**Spec:** [`docs/specs/2026-06-06-worktree-management.md`](../specs/2026-06-06-worktree-management.md)

---

## Chunk 1: Foundation — config, tipi, errori

**Submodule:** `cli`
**Size:** S
**Depends on:** nessuno
**Spec refs:** §3.1 (layout/baseDir), §4.5 (errore/guardrail), §5.3 (campo Session)

Aggiunge le fondamenta su cui poggiano gli altri chunk: il tipo di config `worktree`, la classe `WorktreeError` con il suo exit code, e il campo `worktreePath?` sul tipo `Session`. Nessuna logica, solo tipi/struttura.

### Task 1.1: Aggiungi il tipo `WorktreeConfig` e il campo `worktree` a `JicConfig`

**Files:**
- Modify: `src-ts/core/types/config.ts`

**Steps:**

1. Subito dopo l'interfaccia `ProjectConfig` (che termina a riga 486), aggiungi il nuovo tipo:
   ```ts
   // ============================================================================
   // Worktree Configuration
   // ============================================================================

   /**
    * Configurazione dei git worktree gestiti da `jic worktree`.
    */
   export interface WorktreeConfig {
     /**
      * Directory base in cui vengono creati i worktree.
      * Se relativa, è risolta rispetto alla projectRoot; se assoluta, usata così com'è.
      * Default (quando assente): "../<project.name>-worktrees".
      */
     baseDir?: string;
   }
   ```
2. Nell'interfaccia `JicConfig` (riga 514), aggiungi il campo opzionale dopo `docker?: DockerConfig;` (riga 548):
   ```ts
     /** Docker configuration */
     docker?: DockerConfig;

     /** Worktree configuration */
     worktree?: WorktreeConfig;
   }
   ```
3. In `src-ts/core/config/loader.ts`, nella funzione `saveConfig` (inizia a riga 439), aggiungi `worktree` all'oggetto `cleanConfig` così non viene perso al salvataggio. Dopo la riga `serve: config.serve,` (riga 457) aggiungi:
   ```ts
     serve: config.serve,
     worktree: config.worktree,
   };
   ```

**Expected outcome:** `ctx.config.worktree?.baseDir` è leggibile e tipizzato. `npm run typecheck` passa.

### Task 1.2: Aggiungi `WorktreeError` e l'exit code `WORKTREE_ERROR`

**Files:**
- Modify: `src-ts/core/errors/index.ts`

**Steps:**

1. Nell'oggetto `ExitCodes` (riga 17-32), aggiungi il nuovo codice dopo `GITLAB_ERROR: 12,` (riga 30):
   ```ts
     GITLAB_ERROR: 12,
     WORKTREE_ERROR: 13,
     INTERRUPTED: 130,
   ```
2. Dopo la classe `GitlabError` (termina a riga 344), aggiungi la nuova classe seguendo lo stesso pattern di `VendorError`:
   ```ts
   /**
    * Worktree error
    */
   export class WorktreeError extends JicError {
     readonly worktreeName?: string;

     constructor(message: string, worktreeName?: string, cause?: Error) {
       super(message, {
         exitCode: ExitCodes.WORKTREE_ERROR,
         context: worktreeName ? { worktree: worktreeName } : undefined,
         cause,
       });
       this.name = 'WorktreeError';
       this.worktreeName = worktreeName;
     }
   }
   ```

**Expected outcome:** `WorktreeError` importabile da `../core/errors/index.js`. `npm run typecheck` passa.

### Task 1.3: Aggiungi il campo `worktreePath?` al tipo `Session`

**Files:**
- Modify: `src-ts/core/types/state.ts`

**Steps:**

1. Nell'interfaccia `Session` (riga 74-103), aggiungi il campo dopo `rootBaseBranch?: string;` (riga 102):
   ```ts
     /** Root repo base branch for this session */
     rootBaseBranch?: string;
     /** Path assoluto del worktree in cui vive la sessione (se creata con --worktree) */
     worktreePath?: string;
   }
   ```

**Expected outcome:** `Session.worktreePath` tipizzato. `npm run typecheck` passa.

> **Commit del chunk:** `feat(worktree): fondamenta config, errore e tipo sessione`

---

## Chunk 2: Helper worktree (core)

**Submodule:** `cli`
**Size:** L
**Depends on:** [1]
**Spec refs:** §3.2 (strategia submodule), §3.3 (branch), §3.4 (seeding), §3.5 (source of truth), §4.5 (versione git), §7 (spike)

Il cuore tecnico. Crea `src-ts/core/utils/worktree.ts` con: validazione spike della strategia submodule, check versione git, parsing di `git worktree list`, creazione/rimozione worktree submodule-aware, seeding dello stato. Usa `execa` direttamente come fa `submodule.ts` (coerenza con il modulo vicino).

### Task 2.1: SPIKE — ESEGUITO (risultati validati su git 2.45.2)

> Lo spike è già stato eseguito durante il planning su un repo sintetico isolato (superproject + 1 submodule). Strategia nativa **confermata**. Questi risultati vincolano l'implementazione dei task successivi.

**Risultati:**

- **(A) Popolamento submodule:** ✅ `git submodule update --init --recursive` nel worktree popola i submodule. git li isola **per-worktree** in `<root>/.git/worktrees/<wt>/modules/<path>` (il `.git` del submodule nel worktree punta lì). Nessun conflitto con la working dir principale.
- **(B) Branch + commit nel submodule:** ✅ con vincolo: il branch del submodule va creato da **`HEAD`** (il commit pinnato già in checkout dopo l'init), NON da `dev`. Nel clone del submodule del worktree il ref **locale** `dev` non esiste (esiste solo `origin/dev`), quindi `git checkout -b <branch> dev` fallisce con `fatal: 'dev' non è un commit`. La forma corretta è `git checkout -b <branch>` (base implicita = HEAD/commit pinnato).
- **Rimozione worktree:** ⚠️ `git worktree remove` **rifiuta sempre** un worktree che contiene submodule senza `--force` (anche se pulito: `fatal: gli alberi di lavoro contenenti sottomoduli non possono essere ... rimossi`). Con `--force` funziona (exit 0) e ripulisce automaticamente le registrazioni submodule sotto `.git/worktrees`. → Implicazione: il controllo "modifiche pendenti" lo facciamo NOI prima della rimozione; a git passiamo **sempre** `--force`.
- **Risoluzione root principale da dentro il worktree:** ✅ `git rev-parse --path-format=absolute --git-common-dir` ritorna `<root>/.git`; `dirname` = root principale. Abilita `session end --worktree-remove` (Task 4.2).
- **Versione git:** validato su **2.45.2**. Floor documentato: `2.38` (supporto submodule-per-worktree presente da ~2.38; non testato sotto 2.45, da indicare come minimo prudenziale nel check di Task 2.2).

**Expected outcome:** nessuna azione di codice; i risultati sopra sono già incorporati nei Task 2.2, 2.4, 2.5 e 4.2.

### Task 2.2: Crea `worktree.ts` con check versione git e risoluzione path

**Files:**
- Create: `src-ts/core/utils/worktree.ts`
- Read: `src-ts/core/config/loader.ts` (per `LoadedConfig`)

**Steps:**

1. Crea il file con import e le funzioni di base. `MIN_GIT_VERSION = [2, 38, 0]` (floor prudenziale; lo spike Task 2.1 ha validato la meccanica su git 2.45.2):
   ```ts
   import { execa } from 'execa';
   import { join, isAbsolute, resolve } from 'path';
   import type { LoadedConfig } from '../config/loader.js';
   import { WorktreeError } from '../errors/index.js';

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

   /**
    * Risolve la directory base dei worktree.
    * config.worktree.baseDir se presente (relativa a projectRoot o assoluta),
    * altrimenti "../<project.name>-worktrees".
    */
   export function resolveWorktreeBaseDir(config: LoadedConfig): string {
     const configured = config.worktree?.baseDir;
     if (configured) {
       return isAbsolute(configured) ? configured : resolve(config.projectRoot, configured);
     }
     return resolve(config.projectRoot, '..', `${config.project.name}-worktrees`);
   }

   /** Path assoluto del worktree di nome `name`. */
   export function resolveWorktreePath(config: LoadedConfig, name: string): string {
     return join(resolveWorktreeBaseDir(config), name);
   }
   ```
2. Verifica che `LoadedConfig` esponga `projectRoot` e `project.name` (loader.ts:70 `LoadedConfig extends JicConfig`; `projectRoot` è proprietà runtime). Se `projectRoot` non è in `LoadedConfig`, usa `config.paths` per derivarlo. Run: `npm run typecheck`. Expected: nessun errore.

**Expected outcome:** funzioni `assertGitWorktreeSupport`, `resolveWorktreeBaseDir`, `resolveWorktreePath` disponibili e tipizzate.

### Task 2.3: Implementa `listWorktrees` (parsing di `git worktree list --porcelain`)

**Files:**
- Modify: `src-ts/core/utils/worktree.ts`

**Steps:**

1. Aggiungi il tipo e la funzione:
   ```ts
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
         current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
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
   ```

**Expected outcome:** `listWorktrees(projectRoot)` ritorna l'elenco con il worktree principale marcato `isMain: true`.

### Task 2.4: Implementa `addWorktree` (root + init submodule + branch vendor-aware)

**Files:**
- Modify: `src-ts/core/utils/worktree.ts`

**Steps:**

1. Aggiungi il tipo opzioni e la funzione. Per i submodule del vendor crea un branch NUOVO `<vendorBranch>` (no conflitto two-worktree perché è un branch nuovo, vedi spike Task 2.1):
   ```ts
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
     /**
      * Branch da creare nei submodule del vendor (tipicamente == branch).
      * Il branch è creato da HEAD (commit pinnato post-init), NON da un branch base:
      * nel clone submodule del worktree il ref locale del base branch non esiste (spike Task 2.1).
      * Se assente, i submodule restano al commit pinnato (detached) dopo l'init.
      */
     submoduleBranch?: string;
     /** Directory (relative a projectRoot) dei submodule su cui creare il branch */
     vendorModuleDirs?: string[];
     /** Logger opzionale per progress */
     onProgress?: (msg: string) => void;
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

     // 2. Popola i submodule nel nuovo worktree
     log('Inizializzazione submodule nel worktree...');
     await execa('git', ['submodule', 'update', '--init', '--recursive'], { cwd: opts.worktreePath });

     // 3. Allinea i branch dei submodule del vendor.
     // Il branch è creato da HEAD (commit pinnato post-init): NON passare un base branch,
     // perché nel clone submodule del worktree il ref locale del base non esiste (spike Task 2.1).
     if (opts.submoduleBranch && opts.vendorModuleDirs?.length) {
       for (const dir of opts.vendorModuleDirs) {
         const subPath = join(opts.worktreePath, dir);
         log(`  ${dir}: checkout -b ${opts.submoduleBranch} (da HEAD)`);
         await execa('git', ['checkout', '-b', opts.submoduleBranch], { cwd: subPath });
       }
     }
   }
   ```

**Expected outcome:** `addWorktree` crea il worktree root, popola i submodule e (se richiesto) crea i branch vendor nei submodule. `npm run typecheck` passa.

### Task 2.5: Implementa `removeWorktree` e `seedWorktreeState`

**Files:**
- Modify: `src-ts/core/utils/worktree.ts`

**Steps:**

1. In `worktree.ts` aggiungi gli import necessari in cima al file. **`createEmptyState` è definita ed esportata in `src-ts/core/types/state.ts` (riga ~307), NON in loader.ts** — importala da lì:
   ```ts
   import { writeFile } from 'fs/promises';
   import { createEmptyState } from '../types/state.js';
   import type { JicState } from '../types/state.js';
   ```
2. Aggiungi `removeWorktree`:
   ```ts
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
    * `projectRoot` deve essere la ROOT PRINCIPALE, non il worktree (vedi Task 4.2).
    */
   export async function removeWorktree(projectRoot: string, opts: RemoveWorktreeOptions): Promise<void> {
     const log = opts.onProgress ?? (() => {});
     log(`Rimozione worktree: ${opts.worktreePath}`);
     await execa('git', ['worktree', 'remove', '--force', opts.worktreePath], { cwd: projectRoot });
     // prune difensivo (con --force git pulisce già le registrazioni submodule)
     await execa('git', ['worktree', 'prune'], { cwd: projectRoot });
     await execa('git', ['submodule', 'foreach', '--recursive', 'git worktree prune'], {
       cwd: projectRoot,
     }).catch(() => undefined);
   }
   ```
3. Aggiungi `seedWorktreeState` (scrive `jic.state.json` nel worktree con il solo `activeVendor`):
   ```ts
   /**
    * Seeda lo stato del nuovo worktree copiando l'activeVendor dalla root corrente.
    * Il resto (sessioni, deployment, build cache) resta isolato/vuoto per natura.
    */
   export async function seedWorktreeState(worktreePath: string, activeVendor?: string): Promise<void> {
     const state: JicState = createEmptyState();
     if (activeVendor) state.activeVendor = activeVendor;
     await writeFile(join(worktreePath, 'jic.state.json'), JSON.stringify(state, null, 2) + '\n', 'utf-8');
   }
   ```

**Expected outcome:** `removeWorktree`, `isWorktreeDirty`, `seedWorktreeState` disponibili. `npm run typecheck` passa.

### Task 2.6: Test unitari per il parsing e il check versione

**Files:**
- Create: `tests/core/utils/worktree.test.ts`
- Read: `tests/core/utils/submodule.test.ts` (pattern vitest)

**Steps:**

1. Scrivi test sul parsing di `listWorktrees` estraendo la logica di parsing in una funzione pura testabile, OPPURE testa direttamente `assertGitWorktreeSupport` e `resolveWorktreePath` (funzioni che non richiedono un repo git mockato). Esempio per `resolveWorktreePath` con config minimale:
   ```ts
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
   ```
2. Run: `npx vitest run tests/core/utils/worktree.test.ts`. Expected: `PASS`.

**Expected outcome:** test verdi sulla risoluzione path. `npm run typecheck` passa.

> **Commit del chunk:** `feat(worktree): helper submodule-aware (create/list/remove + seeding)`

---

## Chunk 3: Comando `jic worktree`

**Submodule:** `cli`
**Size:** M
**Depends on:** [1, 2]
**Spec refs:** §4.1 (create), §4.2 (list), §4.3 (remove), §4.4 (path), §4.5 (check git)

Crea `src-ts/commands/worktree.ts` con i sottocomandi `create`/`list`/`remove`/`path`, replicando il pattern di `vendor.ts` (`registerWorktreeCommand`, `withErrorHandling`, `ctx.output`). Registra il comando. Supporta sia progetti `submodules` sia `independent` (per independent salta l'init submodule).

### Task 3.1: Scaffold `worktree.ts` con struttura comando e helper interni

**Files:**
- Create: `src-ts/commands/worktree.ts`
- Read: `src-ts/commands/vendor.ts` (pattern di riferimento)

**Steps:**

1. Crea il file con import, registrazione del comando root e gli helper interni. I sottocomandi sono aggiunti nei task successivi:
   ```ts
   /**
    * Worktree command for JIC CLI
    *
    * Crea e gestisce git worktree isolati. Ogni worktree è una projectRoot
    * indipendente (Modello A): cartella separata, stato isolato.
    */
   import { Command } from 'commander';
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

     // i sottocomandi vengono aggiunti nei task 3.2-3.5 dentro questa funzione
   }
   ```
2. Run: `npm run typecheck` (gli import non ancora usati daranno errore con `noUnusedLocals`: aggiungi i sottocomandi nei task seguenti prima di considerare il typecheck verde; per ora basta che il file sia sintatticamente valido).

**Expected outcome:** file creato con la struttura base e `registerWorktreeCommand` esportata.

### Task 3.2: Sottocomando `worktree create <name>`

**Files:**
- Modify: `src-ts/commands/worktree.ts`

**Steps:**

1. Dentro `registerWorktreeCommand`, dopo la creazione di `worktree`, aggiungi il sottocomando. Calcola branch e base vendor-aware con la stessa logica di `session.ts:247-262`:
   ```ts
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

         // Verifica che non esista già un worktree con quel path
         const existing = await listWorktrees(ctx.projectRoot);
         if (existing.some((w) => w.path === worktreePath)) {
           throw new WorktreeError(`Esiste già un worktree in ${worktreePath}`, name);
         }

         // Branch naming vendor-aware (coerente con session start)
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

         // Directory dei submodule del vendor (per allineare i branch)
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

         // Seeda lo stato del worktree con il vendor attivo
         await seedWorktreeState(worktreePath, ctx.activeVendor);

         ctx.output.success(`Worktree "${name}" creato.`);
         ctx.output.log(worktreePath);
       })
     );
   ```

**Expected outcome:** `jic worktree create <name>` crea worktree + branch + submodule + seeding e stampa il path.

### Task 3.3: Sottocomando `worktree list`

**Files:**
- Modify: `src-ts/commands/worktree.ts`

**Steps:**

1. Aggiungi dopo `create`:
   ```ts
   worktree
     .command('list')
     .description('Elenca i worktree esistenti')
     .action(
       withErrorHandling(async () => {
         const ctx = await createContext();
         const worktrees = await listWorktrees(ctx.projectRoot);

         // --json: emette i dati grezzi (output umano si auto-silenzia in modalità json)
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
   ```

**Expected outcome:** `jic worktree list` mostra i worktree con branch e marcatore `(main)`.

### Task 3.4: Sottocomando `worktree remove <name>`

**Files:**
- Modify: `src-ts/commands/worktree.ts`

**Steps:**

1. Aggiungi dopo `list`:
   ```ts
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
   ```
2. Dopo `registerWorktreeCommand` (a livello di modulo, in fondo al file), aggiungi l'helper che elimina il branch nel root e nei submodule del vendor. Usa `-D` per forzare (il worktree è già rimosso, il branch potrebbe non essere merged):
   ```ts
   async function deleteWorktreeBranch(ctx: IExecutionContext, branch: string): Promise<void> {
     const { execa } = await import('execa');
     // root repo
     await execa('git', ['branch', '-D', branch], { cwd: ctx.projectRoot }).catch(() => undefined);
     // submodule del vendor (se submodules)
     if (ctx.isSubmodules() && ctx.vendorConfig) {
       const vendorConfig = ctx.vendorConfig;
       for (const mod of Object.values(ctx.config.resolvedModules)) {
         if (!vendorConfig.modules.includes(mod.name)) continue;
         await execa('git', ['branch', '-D', branch], { cwd: mod.absolutePath }).catch(() => undefined);
       }
     }
   }
   ```

**Expected outcome:** `jic worktree remove <name>` blocca se sporco senza `--force`, altrimenti rimuove, fa prune ed elimina il branch (root + submodule vendor) salvo `--keep-branch`.

### Task 3.5: Sottocomando `worktree path <name>`

**Files:**
- Modify: `src-ts/commands/worktree.ts`

**Steps:**

1. Aggiungi dopo `remove`. Stampa SOLO il path su stdout (niente decorazioni, per uso in `cd "$(jic worktree path foo)"`):
   ```ts
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
         // stdout puro, niente formattazione
         process.stdout.write(worktreePath + '\n');
       })
     );
   ```

**Expected outcome:** `jic worktree path <name>` stampa solo il path; errore pulito se non esiste.

### Task 3.6: Registra il comando

**Files:**
- Modify: `src-ts/commands/index.ts`
- Modify: `src-ts/index.ts`

**Steps:**

1. In `src-ts/commands/index.ts`, aggiungi accanto a `export * from './vendor.js';` (riga 16):
   ```ts
   export * from './worktree.js';
   ```
2. In `src-ts/index.ts`, aggiungi `registerWorktreeCommand` all'import da `'./commands/index.js'` (blocco riga 18-32, vicino a `registerVendorCommand`).
3. In `src-ts/index.ts`, nella `main()`, aggiungi dopo `registerVendorCommand(program, createCtx);` (riga ~416):
   ```ts
   registerVendorCommand(program, createCtx);
   registerWorktreeCommand(program, createCtx);
   ```
4. Run: `npm run typecheck && npm run build`. Expected: build ok, `node dist/index.js worktree --help` mostra i sottocomandi.

**Expected outcome:** `jic worktree --help` elenca create/list/remove/path. `npm run typecheck` e `npm run build` passano.

> **Commit del chunk:** `feat(worktree): comando jic worktree (create/list/remove/path)`

---

## Chunk 4: Integrazione sessioni

**Submodule:** `cli`
**Size:** M
**Depends on:** [1, 2, 3]
**Spec refs:** §5.1, §5.2, §5.3, §5.4

Integra worktree e sessioni. `session start --worktree` crea il worktree e poi avvia la sessione DENTRO di esso eseguendo `jic session start <name>` con `cwd` nel worktree (coerente con Modello A: `jic` lanciato nel worktree opera su quella root). `session end` ricorda all'utente di rimuovere il worktree se la sessione vi risiede.

> **Nota su spec §5.3 (rimozione worktree da session end):** `session end --worktree-remove` rimuove il worktree automaticamente. Poiché `session end` gira *dentro* il worktree (non puoi rimuovere la cartella in cui ti trovi), il flow è: (1) esegui il normale `session end` (merge/cleanup), (2) risolvi la root principale da dentro il worktree con `git rev-parse --path-format=absolute --git-common-dir`, (3) `process.chdir()` sulla root principale, (4) `removeWorktree(mainRoot, ...)`. Validato nello spike (Task 2.1). Senza il flag, `session end` stampa solo un promemoria.
>
> **Caveat noto (merge two-worktree):** `session end --merge` fa checkout del branch base e ci mergia la feature. Se quel branch base è già checked-out nel worktree principale, git lo rifiuta (vincolo two-worktree). È comportamento della logica di merge esistente, non introdotto qui; registrato come nota di BACKLOG (Task 5.3).

### Task 4.1: Flag `--worktree` su `session start`

**Files:**
- Modify: `src-ts/commands/session.ts`
- Read: `src-ts/commands/worktree.ts` (per coerenza naming branch)

**Steps:**

1. Individua la definizione del sottocomando `session start` (cerca `.command('start` in `session.ts`) e aggiungi l'opzione `--worktree` accanto alle altre opzioni esistenti (`-m, --modules`, `--template`, `--base`, `-d, --description`):
   ```ts
   .option('--worktree', 'Crea un worktree isolato e avvia la sessione al suo interno')
   ```
2. Nell'`.action` di `session start`, prima di chiamare `sessionStart(ctx, name, options)`, intercetta il caso worktree. Aggiungi in cima all'action (adattando i nomi delle variabili a quelli reali dell'action):
   ```ts
   const ctx = await createContext();
   if (options.worktree) {
     await sessionStartInWorktree(ctx, name, options);
     return;
   }
   await sessionStart(ctx, name, options);
   ```
3. Aggiungi la nuova funzione vicino a `sessionStart` (dopo la riga 403). Crea il worktree riusando gli helper, poi esegue `jic session start <name>` (senza `--worktree`) con `cwd` nel worktree tramite `execa`, ereditando lo stdio:
   ```ts
   async function sessionStartInWorktree(
     ctx: IExecutionContext,
     name: string,
     options: { modules?: string[]; template?: string; base?: string; description?: string }
   ): Promise<void> {
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
       branch = `${ctx.activeVendor}/feature/${name}`;
       baseBranch = options.base ?? vendorConfig.branches.dev;
     } else {
       branch = `feature/${name}`;
       baseBranch = options.base ?? 'master';
     }
     const vendorModuleDirs =
       isSubmodules && vendorConfig
         ? Object.values(ctx.config.resolvedModules)
             .filter((m) => vendorConfig.modules.includes(m.name))
             .map((m) => m.originalConfig.directory)
         : [];

     ctx.output.header(`Crea worktree + sessione: ${name}`);
     await addWorktree(ctx.projectRoot, {
       worktreePath,
       branch,
       baseBranch,
       skipSubmodules: !isSubmodules,
       submoduleBranch: isSubmodules ? branch : undefined,
       vendorModuleDirs,
       onProgress: (msg) => ctx.output.log(`  ${msg}`),
     });
     await seedWorktreeState(worktreePath, ctx.activeVendor);

     // Avvia la sessione DENTRO il worktree (jic lì opera su quella root)
     const args = [process.argv[1], 'session', 'start', name];
     if (options.modules?.length) args.push('-m', ...options.modules);
     if (options.template) args.push('--template', options.template);
     if (options.base) args.push('--base', options.base);
     if (options.description) args.push('-d', options.description);

     ctx.output.info('Avvio sessione nel worktree...');
     await execa(process.execPath, args, { cwd: worktreePath, stdio: 'inherit' });

     // Registra worktreePath nella sessione appena creata nel worktree
     const wtStatePath = join(worktreePath, 'jic.state.json');
     try {
       const wtState = JSON.parse(await readFile(wtStatePath, 'utf-8')) as JicState;
       if (wtState.sessions?.[name]) {
         wtState.sessions[name].worktreePath = worktreePath;
         await writeFile(wtStatePath, JSON.stringify(wtState, null, 2) + '\n', 'utf-8');
       }
     } catch {
       // se la lettura/scrittura fallisce, non è bloccante
     }

     ctx.output.success(`Sessione "${name}" avviata nel worktree.`);
     ctx.output.log(worktreePath);
   }
   ```
4. Aggiungi gli import mancanti in cima a `session.ts`:
   ```ts
   import { execa } from 'execa';
   import { readFile, writeFile } from 'fs/promises';
   import { join, dirname } from 'path';
   import { WorktreeError } from '../core/errors/index.js';
   import { assertGitWorktreeSupport, resolveWorktreePath, listWorktrees, addWorktree, removeWorktree, seedWorktreeState } from '../core/utils/worktree.js';
   import type { JicState } from '../core/types/state.js';
   ```
   (`dirname` e `removeWorktree` servono a Task 4.2. Verifica quali import sono già presenti per non duplicare.)
5. Run: `npm run typecheck`. Expected: nessun errore.

**Expected outcome:** `jic session start feat --worktree` crea il worktree, avvia la sessione al suo interno e registra `worktreePath` nello stato del worktree.

### Task 4.2: `session end --worktree-remove` (rimozione automatica del worktree)

**Files:**
- Modify: `src-ts/commands/session.ts`

**Steps:**

1. Individua la definizione del sottocomando `session end` (cerca `.command('end` in `session.ts`) e aggiungi l'opzione, accanto a `--merge`/`--delete-branches`/`--pr`:
   ```ts
   .option('--worktree-remove', 'Se la sessione vive in un worktree, rimuovilo dopo la chiusura')
   ```
2. Estendi la firma delle opzioni di `sessionEnd` (riga 409-413) con il nuovo flag:
   ```ts
   async function sessionEnd(
     ctx: IExecutionContext,
     name: string | undefined,
     options: { merge?: boolean; deleteBranches?: boolean; pr?: boolean; worktreeRemove?: boolean }
   ): Promise<void> {
   ```
   E propaga il flag dall'`.action` di `session end` a `sessionEnd(ctx, name, options)` (il passaggio di `options` è già presente).
3. Alla fine di `sessionEnd`, dopo che la sessione è stata chiusa con successo (dopo il checkout dei branch di default e il messaggio di successo finale), aggiungi la gestione worktree. Recupera l'oggetto sessione già in scope in `sessionEnd` (adatta il nome variabile a quello reale, es. `session`; `sessionName` è il nome risolto):
   ```ts
   if (session.worktreePath) {
     if (options.worktreeRemove) {
       // session end gira DENTRO il worktree: risolvi la root principale, poi chdir + remove.
       // (spike Task 2.1: git rev-parse --git-common-dir da un worktree ritorna <root>/.git)
       const { stdout: commonDir } = await execa(
         'git',
         ['rev-parse', '--path-format=absolute', '--git-common-dir'],
         { cwd: session.worktreePath }
       );
       const mainRoot = dirname(commonDir.trim());
       const wtPath = session.worktreePath;
       ctx.output.newline();
       ctx.output.info(`Rimozione worktree: ${wtPath}`);
       // esci dal worktree prima di rimuoverlo
       process.chdir(mainRoot);
       await removeWorktree(mainRoot, {
         worktreePath: wtPath,
         onProgress: (msg) => ctx.output.log(`  ${msg}`),
       });
       ctx.output.success('Worktree rimosso.');
     } else {
       ctx.output.newline();
       ctx.output.info(`Questa sessione vive nel worktree: ${session.worktreePath}`);
       ctx.output.info(
         `Per rimuoverlo: termina con --worktree-remove, oppure dalla root principale esegui "jic worktree remove ${sessionName}".`
       );
     }
   }
   ```
   Gli import `execa`, `dirname`, `removeWorktree` sono già aggiunti in Task 4.1.
4. Run: `npm run typecheck && npm run build`. Expected: ok.

**Expected outcome:** `jic session end <name> --worktree-remove` chiude la sessione e rimuove il worktree (chdir sulla root principale + `removeWorktree`). Senza il flag, stampa il promemoria. `npm run typecheck` e `npm run build` passano.

> **Commit del chunk:** `feat(worktree): integrazione con le sessioni (session start --worktree)`

---

## Chunk 5: Chiusura — docs + memoria + BACKLOG

**Submodule:** `docs`
**Size:** S
**Depends on:** [1, 2, 3, 4]
**Spec refs:** nessuno (meta-chunk)

Aggiornamento documentazione, memoria e BACKLOG post-implementazione.

### Task 5.1: Aggiorna documentazione progetto

**Files:**
- Modify: `jic-cli/CLAUDE.md`
- Modify: `CLAUDE.md` (root joyincloud, se presente la sezione "JIC CLI Quick Reference")
- Read: `docs/specs/2026-06-06-worktree-management.md`

**Steps:**

1. In `jic-cli/CLAUDE.md`, aggiungi una sezione "Worktree Support" (analoga a "Vendor & Submodules Support") che documenta: scopo (lavoro in parallelo, isolamento per agenti), il Modello A (worktree = root indipendente), i comandi `create/list/remove/path`, il flag `session start --worktree`, la config `worktree.baseDir`, e il requisito git minimo determinato nello spike (Task 2.1).
2. Nella tabella "Module Commands" / quick reference, aggiungi le righe per i comandi worktree.
3. Nella root `CLAUDE.md` (se esiste la tabella "JIC CLI Quick Reference"), aggiungi una riga: `| Crea worktree isolato | jic worktree create <name> |`.
4. Documenta il pattern per agenti: `cd "$(jic worktree path <name>)"`.

**Expected outcome:** documentazione allineata ai comandi reali implementati.

### Task 5.2: Aggiorna memoria personale

**Files:**
- (memoria personale Claude, fuori dal repo)

**Steps:**

1. Crea/aggiorna una memoria `project` sul fatto che `jic` ora supporta i worktree con Modello A (worktree = root indipendente), utile per future sessioni che toccano sessioni/vendor/worktree. Collega a eventuali memorie esistenti su `jic`.

**Expected outcome:** memoria registrata (o "nessun aggiornamento necessario" se già coperta).

### Task 5.3: Aggiungi voci al BACKLOG

**Files:**
- Modify: `docs/BACKLOG.md` (crea se non esiste, seguendo lo stile delle altre tabelle del progetto se presente)

**Steps:**

1. Leggi `docs/BACKLOG.md` per categorie, ID progressivo e stile. Aggiungi queste voci (adatta formato alle colonne esistenti):
   - **Merge two-worktree in `session end --merge`**: se il branch base da mergiare è già checked-out nel worktree principale, git rifiuta il checkout nel worktree (vincolo two-worktree). Valutare merge senza checkout (es. `git merge` su ref, o merge dal lato root principale) per `session end` eseguito dentro un worktree.
   - **Fallback cloni indipendenti submodule**: se in futuro emergono versioni git dove la strategia nativa worktree+submodule è inaffidabile (lo spike Task 2.1 l'ha validata su 2.45.2), implementare la strategia alternativa a cloni indipendenti.
   - **Isolamento porte serve/deploy tra worktree**: worktree paralleli che fanno `jic serve`/`deploy` potrebbero collidere su porte/risorse. Valutare offset di porta per worktree.
2. Se durante l'esecuzione sono emerse altre opportunità fuori scope, aggiungile.

**Expected outcome:** voci di follow-up registrate nel BACKLOG.

> **Commit del chunk:** `docs(worktree): documentazione, memoria e backlog`
