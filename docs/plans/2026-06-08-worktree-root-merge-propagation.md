# Worktree root merge propagation

**Goal:** far sì che `jic session end <chunk> --merge` (contesto worktree + submodules) propaghi il commit del repo ROOT dal branch del chunk al branch di piano, eseguendo il merge nel worktree che ha il base checked-out.

**Architecture:** approccio b2 validato da spike. Il root repo è condiviso tra i worktree linkati, quindi il base (`feature/<plan>`) può essere checked-out solo in un worktree (l'integration). Il merge va eseguito lì: si individua quel worktree via `git worktree list --porcelain` (riusando `listWorktrees`) e si fa `git merge <rootBranch>` con quella `cwd`, senza `checkout`. Se nessun worktree ha il base checked-out si usa il path legacy (checkout+merge in `ctx.projectRoot`). Errori esposti, conflitti abortiti.

**Primary scope:** il root merge chunk→piano nel worktree del base (b2).

**Secondary scopes:** esposizione dello stderr git reale (oggi `catch {}` muto, #3); aggiornamento docs/BACKLOG.

**Size:** M

**Branch target:** `master` (l'esecutore crea il feature branch)

**Spec:** [`docs/specs/2026-06-08-worktree-root-merge-propagation.md`](../specs/2026-06-08-worktree-root-merge-propagation.md)

---

## Chunk 1: findWorktreeForBranch + unit test

**Submodule:** `cli`
**Size:** S
**Depends on:** nessuno
**Spec refs:** [§4]

Aggiunge l'helper `findWorktreeForBranch(mainRoot, branch)` in `core/utils/worktree.ts`, che riusa `listWorktrees` per trovare il path del worktree che ha `branch` come HEAD checked-out (o `null`). Più gli unit test del comportamento (match, nessun match, detached).

### Task 1.1: Aggiungi l'helper `findWorktreeForBranch`

**Files:**
- Modify: `src-ts/core/utils/worktree.ts` (inserire subito dopo `listWorktrees`, che termina a riga 148)
- Read: `src-ts/core/utils/worktree.ts:108-148` (interfaccia `WorktreeInfo` + `listWorktrees`, per contesto)

**Steps:**

1. Subito dopo la chiusura di `listWorktrees` (riga 148) e prima del commento-separatore `// ===... Add worktree`, inserire:
   ```ts
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
   ```
2. Verifica che il file compili:
   Run: `npm run typecheck`
   Expected: nessun errore su `worktree.ts`.

**Expected outcome:** `findWorktreeForBranch` esportato, basato su `listWorktrees`, confronto sul nome nudo del branch.

### Task 1.2: Unit test di `findWorktreeForBranch`

**Files:**
- Create: `tests/core/utils/worktree-find.test.ts`
- Read: `tests/core/utils/worktree.test.ts` (stile dei test esistenti)

**Steps:**

1. Creare `tests/core/utils/worktree-find.test.ts` con mock di `execa` (l'helper passa per `listWorktrees` → `execa`):
   ```ts
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
       // Il branch del detached-wt non esiste: nessun match -> null
       expect(await findWorktreeForBranch('/home/u/proj', '3333333333333333333333333333333333333333')).toBeNull();
     });

     it('matcha sul nome nudo, non su refs/heads/', async () => {
       expect(await findWorktreeForBranch('/home/u/proj', 'refs/heads/feature/plan')).toBeNull();
     });
   });
   ```
2. Esegui i test del file:
   Run: `npx vitest run tests/core/utils/worktree-find.test.ts`
   Expected: 4 test PASS.

**Expected outcome:** suite verde che copre match, no-match, detached, e il confronto sul nome nudo.

### Commit chunk 1

Run: `git add -A && git commit -m "feat(worktree): findWorktreeForBranch per individuare il worktree del base"`

---

## Chunk 2: Root merge b2 in mergeSessionBranches

**Submodule:** `cli`
**Size:** M
**Depends on:** [1]
**Spec refs:** [§3, §5, §7]

Riscrive il blocco root merge di `mergeSessionBranches` (`session.ts:851-873`) per usare l'approccio b2: merge nel worktree del base (se checked-out) o path legacy. Aggiunge abort su conflitto, esposizione stderr, e sposta il commit dei pointer submodule sul worktree dove è avvenuto il merge.

### Task 2.1: Importa gli helper worktree in session.ts

**Files:**
- Modify: `src-ts/commands/session.ts:32-40` (import esistente da `../core/utils/worktree.js`)

**Steps:**

1. L'import da `'../core/utils/worktree.js'` esiste già (riga ~32-40) e importa già `getMainRepoRoot` e `listWorktrees`. Aggiungere a quell'import **solo** `findWorktreeForBranch` (gli altri nomi restano invariati, non duplicare `getMainRepoRoot`):
   ```ts
   import {
     getMainRepoRoot,        // già presente
     findWorktreeForBranch,  // <-- aggiungere
     // ...altri nomi già importati da questo modulo...
   } from '../core/utils/worktree.js';
   ```
2. Verifica che `stageSubmodulePointers` e `commitSubmodulePointers` siano già importati da `'../core/utils/submodule.js'` (lo sono: usati nel blocco root attuale). Non modificarli.

**Expected outcome:** `getMainRepoRoot` e `findWorktreeForBranch` disponibili in `session.ts`.

### Task 2.2: Riscrivi il blocco root merge (b2 + legacy + abort + stderr)

**Files:**
- Modify: `src-ts/commands/session.ts:851-873` (blocco `// Root repo merge for submodules`)
- Read: `src-ts/commands/session.ts:780-848` (per replicare il pattern `exec(...).success/.stderr` già usato nel blocco submodule)

**Steps:**

1. Sostituire integralmente il blocco attuale (righe 851-873):
   ```ts
   // Root repo merge for submodules
   if (ctx.isSubmodules() && session.rootBranch && session.rootBaseBranch) {
     const spinner = ctx.output.spinner(`root: merging to ${session.rootBaseBranch}`);
     spinner.start();
     try {
       if (ctx.dryRun) {
         spinner.info(`[dry-run] Would merge ${session.rootBranch} to ${session.rootBaseBranch}`);
       } else {
         await exec(`git checkout ${session.rootBaseBranch}`, { cwd: ctx.projectRoot, silent: true });
         await exec(`git merge ${session.rootBranch} --no-edit`, { cwd: ctx.projectRoot, silent: true });
         spinner.succeed(`root: merged to ${session.rootBaseBranch}`);

         // Update submodule pointers
         const modulePaths = Object.keys(session.modules)
           .map((name) => ctx.config.resolvedModules[name]?.originalConfig.directory)
           .filter((dir): dir is string => dir !== undefined);
         await stageSubmodulePointers(ctx.projectRoot, modulePaths);
         await commitSubmodulePointers(ctx.projectRoot, Object.keys(session.modules));
       }
     } catch {
       spinner.fail('root: merge failed');
     }
   }
   ```
   con:
   ```ts
   // Root repo merge for submodules.
   // Il root repo è condiviso tra i worktree linkati: il base (es. feature/<plan>)
   // può essere checked-out solo in un worktree (l'integration). git rifiuta
   // checkout/push/branch -f su un branch checked-out altrove, quindi il merge va
   // eseguito NEL worktree che possiede il base (approccio b2). Se nessun worktree
   // ha il base checked-out (sessioni non-worktree) si usa il path legacy.
   if (ctx.isSubmodules() && session.rootBranch && session.rootBaseBranch) {
     const spinner = ctx.output.spinner(`root: merging to ${session.rootBaseBranch}`);
     spinner.start();
     try {
       if (ctx.dryRun) {
         spinner.info(`[dry-run] Would merge ${session.rootBranch} to ${session.rootBaseBranch}`);
       } else {
         const mainRoot = await getMainRepoRoot(ctx.projectRoot);
         const baseWorktree = await findWorktreeForBranch(mainRoot, session.rootBaseBranch);

         let mergeCwd: string;
         if (baseWorktree) {
           // b2: base checked-out in un worktree -> merge in-place lì, niente checkout.
           mergeCwd = baseWorktree;
         } else {
           // Legacy: base non checked-out in alcun worktree -> checkout+merge in projectRoot.
           mergeCwd = ctx.projectRoot;
           const checkoutResult = await exec(`git checkout ${session.rootBaseBranch}`, {
             cwd: mergeCwd,
             silent: true,
           });
           if (!checkoutResult.success) {
             spinner.fail('root: merge failed');
             if (checkoutResult.stderr) ctx.output.error(`  ${checkoutResult.stderr}`);
             return;
           }
         }

         const mergeResult = await exec(`git merge ${session.rootBranch} --no-edit`, {
           cwd: mergeCwd,
           silent: true,
         });
         if (!mergeResult.success) {
           // Conflitto o tree sporco: non lasciare il worktree del base in stato MERGING.
           // abort best-effort (se non c'è merge in corso fallisce silenziosamente).
           await exec('git merge --abort', { cwd: mergeCwd, silent: true });
           spinner.fail('root: merge failed');
           if (mergeResult.stderr) ctx.output.error(`  ${mergeResult.stderr}`);
           return;
         }

         spinner.succeed(`root: merged to ${session.rootBaseBranch}`);

         // Commit dei pointer submodule nel worktree dove è avvenuto il merge.
         const modulePaths = Object.keys(session.modules)
           .map((name) => ctx.config.resolvedModules[name]?.originalConfig.directory)
           .filter((dir): dir is string => dir !== undefined);
         await stageSubmodulePointers(mergeCwd, modulePaths);
         await commitSubmodulePointers(mergeCwd, Object.keys(session.modules));
       }
     } catch (error) {
       spinner.fail('root: merge failed');
       if (error instanceof Error) ctx.output.error(`  ${error.message}`);
     }
   }
   ```
   Note per l'esecutore:
   - Il blocco root è **l'ultima cosa** in `mergeSessionBranches` → i `return` escono dalla funzione, comportamento corretto.
   - `exec(...)` è il wrapper già usato nel file (ritorna `{ success, stdout, stderr }`, non lancia su exitCode≠0). NON sostituirlo con `execa`.
   - Il lato submodule (loop sopra, righe ~766-849) **non va toccato**.
2. Type-check:
   Run: `npm run typecheck`
   Expected: nessun errore.
3. Build:
   Run: `npm run build`
   Expected: `Build success`.

**Expected outcome:** il root merge avviene in `mergeCwd` (worktree del base se trovato, altrimenti `projectRoot`); su conflitto/errore fa abort + stampa lo stderr git reale; i pointer submodule sono committati in `mergeCwd`; path legacy invariato per le sessioni non-worktree.

### Task 2.3: Verifica suite test del CLI

**Files:**
- Read: nessuno (esecuzione test)

**Steps:**

1. Esegui l'intera suite per assicurarti che nulla sia regredito:
   Run: `npm run test:run`
   Expected: tutti i test verdi (inclusi i 4 nuovi di chunk 1).

**Expected outcome:** suite completa verde.

### Commit chunk 2

Run: `git add -A && git commit -m "feat(session): root merge nel worktree del base (b2) con abort e stderr esposto"`

---

## Chunk 3: Chiusura — docs + memoria + BACKLOG

**Submodule:** `docs`
**Size:** S
**Depends on:** [1, 2]
**Spec refs:** nessuno (meta-chunk)

Aggiornamento documentazione, memoria e BACKLOG post-implementazione.

### Task 3.1: Aggiorna documentazione progetto

**Files:**
- Modify: `jic-cli/CLAUDE.md` (sezione "Worktree Support", paragrafo "Modello branch per submodule (origin-based tree)", punto 4 sulla propagazione)
- Read: `docs/specs/2026-06-08-worktree-root-merge-propagation.md`

**Steps:**

1. Nel paragrafo §"Modello branch per submodule (origin-based tree)" di `jic-cli/CLAUDE.md`, al punto 4 (propagazione via `session end --merge`), aggiungere una frase che documenti il comportamento del **root merge**: che, in contesto worktree+submodules, il merge del repo root verso il branch di piano viene eseguito nel worktree dove il branch di piano è checked-out (non serve push: i ref del root sono condivisi), e che su conflitto il merge viene abortito e l'errore git mostrato. Mantenere lo stile conciso dei punti esistenti.
2. Verifica che non restino riferimenti al vecchio comportamento "root: merge failed" come limite noto nello stesso file.

**Expected outcome:** CLAUDE.md riflette il nuovo comportamento del root merge.

### Task 3.2: Aggiorna memoria personale

**Files:**
- nessuna modifica

**Steps:**

1. Nessun aggiornamento di memoria personale necessario: il comportamento è documentato in CLAUDE.md + spec, e non emergono preferenze/fatti di progetto non derivabili dal codice. Task no-op.

**Expected outcome:** nessuna memoria creata.

### Task 3.3: Aggiungi/aggiorna voci al BACKLOG

**Files:**
- Modify: `docs/BACKLOG.md` (sezione Worktree)
- Read: `docs/BACKLOG.md` (per ID progressivo e stile)

**Steps:**

1. Aggiornare **WT-5** ("Merge two-worktree in `session end --merge`"): il caso submodules è ora risolto dall'approccio b2 (merge nel worktree del base, niente checkout che collide). Annotare nella colonna `Note` che è risolto da `feat(session): root merge nel worktree del base (b2)` e impostare lo Stato a `chiuso` con data `2026-06-08` nella colonna `Chiuso`, **se** dopo verifica non restano sotto-casi aperti (es. base non gestito da worktree); altrimenti lasciare `aperto` con nota di parziale risoluzione. L'esecutore decide leggendo il testo attuale di WT-5.
2. Valutare se aggiungere una voce per un eventuale **test d'integrazione del root merge b2** (analogo a WT-11, che già copre i flussi worktree+submodule): se WT-11 lo ingloba già, non duplicare; altrimenti aggiungere una riga `WT-15` nella sezione Worktree con: Task "Test integrazione root merge b2", Descrizione "Verificare con repo temporanei che `session end --merge` dal chunk worktree aggiorni il branch di piano nel worktree dell'integration (casi ff, conflitto→abort, tree sporco, base non checked-out)", Note "origine: spec worktree-root-merge-propagation".

**Expected outcome:** WT-5 aggiornato coerentemente; eventuale WT-15 aggiunto solo se non coperto da WT-11.

### Commit chunk 3

Run: `git add -A && git commit -m "docs(worktree): documenta root merge b2 e aggiorna BACKLOG"`
