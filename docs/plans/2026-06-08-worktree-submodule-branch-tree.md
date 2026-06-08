# Worktree submodule branch tree

**Goal:** Far sì che il branch di una sessione/worktree nasca nei submodule della root e venga ereditato dai worktree (modello origin-based tree), così il base esiste a ogni livello e la catena piano→chunk funziona dal root e da dentro un worktree.

**Architecture:** La copia dei submodule nella root (`mainRoot/<sub>`) è la source of truth (`origin`) dei submodule dei worktree. `addWorktree` crea il branch in `mainRoot/<sub>` dal base, poi il worktree lo deriva da `origin/<branch>`. La propagazione del lavoro avviene via `session end --merge` con push verso `origin`, gated su worktree+submodules.

**Primary scope:** propagazione del branch base ai submodule nei worktree.

**Secondary scopes:** risoluzione del base via config chain (parziale WT-4/WT-10), docs.

**Size:** L

**Branch target:** `master` (l'esecutore crea un feature branch, es. `feature/worktree-submodule-tree`)

**Spec:** [`docs/specs/2026-06-08-worktree-submodule-branch-tree.md`](../specs/2026-06-08-worktree-submodule-branch-tree.md)

---

## Chunk 1: Core + chiamanti — branch nasce nel parent, worktree deriva da origin

**Submodule:** `cli` (`src-ts/core/utils/worktree.ts`, `src-ts/commands/worktree.ts`, `src-ts/commands/session.ts`)
**Size:** L
**Depends on:** nessuno
**Spec refs:** §3, §4, §5

Riscrive il branching dei submodule in `addWorktree` (branch creato in `mainRoot/<sub>` dal base, poi derivato da `origin/<branch>` nel worktree) e adatta nello stesso chunk i due chiamanti (`worktree create`, `sessionStartInWorktree`) alla nuova firma. Core + chiamanti stanno in un unico chunk perché la rinomina della firma (`vendorModuleDirs`→`submoduleDirs`, nuovo `submoduleBaseBranch`) rompe il build se separata: vanno committati insieme (commit atomico e buildabile).

### Task 1.1: Helper `refExists`

**Files:**
- Modify: `src-ts/core/utils/worktree.ts`

**Steps:**

1. Aggiungi un helper a livello di modulo (vicino a `relativeSubmoduleUrlOverrides`):
   ```ts
   /** True se `ref` esiste nel repo in `cwd` (branch, tag o commit). */
   async function refExists(cwd: string, ref: string): Promise<boolean> {
     return execa('git', ['rev-parse', '--verify', '--quiet', ref], { cwd })
       .then(() => true)
       .catch(() => false);
   }
   ```

**Expected outcome:** helper disponibile per i controlli di esistenza ref.

### Task 1.2: Estendi `AddWorktreeOptions`

**Files:**
- Modify: `src-ts/core/utils/worktree.ts` (interfaccia `AddWorktreeOptions`, ~righe 154-176)

**Steps:**

1. Rinomina `vendorModuleDirs` → `submoduleDirs` e aggiungi `submoduleBaseBranch`. Sostituisci l'interfaccia con:
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
   ```

**Expected outcome:** la firma riflette il nuovo modello; `submoduleDirs` sostituisce `vendorModuleDirs`.

### Task 1.3: Riscrivi `addWorktree`

**Files:**
- Modify: `src-ts/core/utils/worktree.ts` (funzione `addWorktree`, ~righe 232-277)

**Steps:**

1. Sostituisci l'intera funzione `addWorktree` con:
   ```ts
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
   ```
   Note: l'ordine è cambiato — la creazione dei branch nel parent (step 2) avviene **prima** del `submodule update --init` (step 3), così il clone del worktree eredita `origin/<branch>`; il checkout nel worktree (step 4) viene dopo.

### Task 1.4: Adatta `worktree create`

**Files:**
- Modify: `src-ts/commands/worktree.ts` (comando `create`, blocco branch/baseBranch ~righe 53-59, blocco `vendorModuleDirs` + chiamata `addWorktree` ~righe 61-85)

**Steps:**

1. Sostituisci il blocco di calcolo `branch`/`baseBranch`:
   ```ts
   if (isSubmodules && vendorConfig) {
     branch = options.branch ?? `${ctx.activeVendor}/feature/${name}`;
     baseBranch = options.base ?? vendorConfig.branches.dev;
   } else {
     branch = options.branch ?? `feature/${name}`;
     baseBranch = options.base ?? ctx.config.defaults.branches?.local ?? 'main';
   }
   ```

2. Sostituisci il blocco `const vendorModuleDirs = ...` con il calcolo generalizzato (vendor → moduli vendor; non-vendor → tutti i submodule):
   ```ts
   const submoduleDirs = !isSubmodules
     ? []
     : vendorConfig
       ? Object.values(ctx.config.resolvedModules)
           .filter((m) => vendorConfig.modules.includes(m.name))
           .map((m) => m.originalConfig.directory)
       : Object.values(ctx.config.resolvedModules).map((m) => m.originalConfig.directory);
   ```

3. Aggiorna la chiamata `addWorktree`:
   ```ts
   await addWorktree(mainRoot, {
     worktreePath,
     branch,
     baseBranch,
     useExistingBranch: !!options.branch,
     skipSubmodules: options.submodules === false || !isSubmodules,
     submoduleBranch: isSubmodules && !options.branch ? branch : undefined,
     submoduleBaseBranch: isSubmodules && !options.branch ? baseBranch : undefined,
     submoduleDirs,
     onProgress: (msg) => ctx.output.log(`  ${msg}`),
   });
   ```

**Expected outcome:** `worktree create` usa la nuova firma; submodule branch dal base.

### Task 1.5: Adatta `sessionStartInWorktree`

**Files:**
- Modify: `src-ts/commands/session.ts` (funzione `sessionStartInWorktree`, blocco branch/baseBranch ~righe 449-454, blocco `vendorModuleDirs` ~righe 455-460, chiamata `addWorktree` ~righe 462-471)

**Steps:**

1. Sostituisci il blocco branch/baseBranch:
   ```ts
   if (isSubmodules && vendorConfig) {
     branch = `${ctx.activeVendor}/feature/${name}`;
     baseBranch = options.base ?? vendorConfig.branches.dev;
   } else {
     branch = `feature/${name}`;
     baseBranch = options.base ?? ctx.config.defaults.branches?.local ?? 'main';
   }
   ```

2. Sostituisci `const vendorModuleDirs = ...` con:
   ```ts
   const submoduleDirs = !isSubmodules
     ? []
     : vendorConfig
       ? Object.values(ctx.config.resolvedModules)
           .filter((m) => vendorConfig.modules.includes(m.name))
           .map((m) => m.originalConfig.directory)
       : Object.values(ctx.config.resolvedModules).map((m) => m.originalConfig.directory);
   ```

3. Aggiorna la chiamata `addWorktree`:
   ```ts
   await addWorktree(mainRoot, {
     worktreePath,
     branch,
     baseBranch,
     skipSubmodules: !isSubmodules,
     submoduleBranch: isSubmodules ? branch : undefined,
     submoduleBaseBranch: isSubmodules ? baseBranch : undefined,
     submoduleDirs,
     onProgress: (msg) => ctx.output.log(`  ${msg}`),
   });
   ```

**Expected outcome:** `sessionStartInWorktree` usa la nuova firma.

### Task 1.6: Verifica build e typecheck

**Steps:**

1. Run: `npm run typecheck`
   Expected: nessun NUOVO errore oltre ai pre-esistenti noti (`clean.ts:17`, `deploy.ts:1456`, `defaults.ts:14`). Non devono restare riferimenti a `vendorModuleDirs`.
2. Run: `npm run build`
   Expected: OK (il chunk è atomico e buildabile).

**Expected outcome:** core + chiamanti coerenti e buildabili. Commit del chunk.

---

## Chunk 2: Propagazione (session end --merge worktree-aware)

**Submodule:** `cli` (`src-ts/commands/session.ts`)
**Size:** S
**Depends on:** [1]
**Spec refs:** §6

Estende `mergeSessionBranches`: dopo il merge nel submodule, se la sessione vive in un worktree (`session.worktreePath`) e il progetto è a submodule, push del branch target verso `origin` (= `mainRoot/<sub>`), così il lavoro propaga al parent e ai worktree fratelli/figli. Gestione non-fast-forward senza force.

### Task 2.1: Push verso origin dopo il merge

**Files:**
- Modify: `src-ts/commands/session.ts` (funzione `mergeSessionBranches`, dopo `spinner.succeed(\`${moduleName}: merged to ${targetBranch}\`)` ~riga 810, prima del blocco `if (deleteBranches)`)

**Steps:**

1. Subito dopo la riga `spinner.succeed(\`${moduleName}: merged to ${targetBranch}\`);` e PRIMA di `// Delete branch if requested`, inserisci:
   ```ts
   // Propagazione al parent (solo worktree + submodules): push del target verso
   // origin (= mainRoot/<sub>), così i worktree fratelli/figli vedono il merge.
   // NB: assume che il comando giri da dentro il worktree, quindi module.absolutePath
   // è il submodule del worktree (il suo origin è mainRoot/<sub>).
   if (ctx.isSubmodules() && session.worktreePath) {
     const pushResult = await exec(`git push origin ${targetBranch}`, {
       cwd: module.absolutePath,
       silent: true,
     });
     if (pushResult.success) {
       ctx.output.info(`  ${moduleName}: ${targetBranch} propagato al parent`);
     } else {
       const firstLine = pushResult.stderr?.split('\n').find((l) => l.trim()) ?? '';
       ctx.output.warn(
         `  ${moduleName}: push di ${targetBranch} verso origin fallito (merge locale ok). ${firstLine}`
       );
     }
   }
   ```
   Note: niente `--force`; in caso di non-fast-forward si avvisa e si lascia il merge locale committato (l'utente risolve). `exec` è già importato da `../core/utils/shell.js`.

### Task 2.2: Verifica build e typecheck

**Steps:**

1. Run: `npm run typecheck`
   Expected: nessun nuovo errore oltre ai pre-esistenti noti.
2. Run: `npm run build`
   Expected: OK.

**Expected outcome:** propagazione attiva nel caso worktree+submodules; comportamento invariato altrove. Commit del chunk.

---

## Chunk 3: Cleanup dei branch nel parent

**Submodule:** `cli` (`src-ts/commands/worktree.ts`)
**Size:** M
**Depends on:** [1]
**Spec refs:** §7

Generalizza `deleteWorktreeBranch` al caso non-vendor (tutti i submodule, non solo `vendorConfig.modules`) e aggiunge il guard sui commit non mergeati: elimina con `git branch -d` (safe) salvo `--force` (`-D`), avvisando quando un branch non viene eliminato. (Indipendente da Chunk 2: tocca `commands/worktree.ts`, file diverso da `session.ts` → eseguibile in parallelo a Chunk 2.)

### Task 3.1: Riscrivi `deleteWorktreeBranch` e propaga `force`

**Files:**
- Modify: `src-ts/commands/worktree.ts` (funzione `deleteWorktreeBranch` ~righe 192-208 e la sua chiamata nel comando `remove` ~righe 155-163)

**Steps:**

1. Sostituisci la funzione `deleteWorktreeBranch` con la versione generalizzata + guard:
   ```ts
   async function deleteWorktreeBranch(
     ctx: IExecutionContext,
     branch: string,
     mainRoot: string,
     force: boolean
   ): Promise<void> {
     const flag = force ? '-D' : '-d';
     // Target: la root principale + i submodule (vendor → solo moduli vendor;
     // non-vendor → tutti i submodule del progetto). I path sono risolti contro mainRoot.
     const targets: string[] = [mainRoot];
     if (ctx.isSubmodules()) {
       const vendorConfig = ctx.vendorConfig;
       for (const mod of Object.values(ctx.config.resolvedModules)) {
         if (vendorConfig && !vendorConfig.modules.includes(mod.name)) continue;
         targets.push(join(mainRoot, mod.originalConfig.directory));
       }
     }
     for (const cwd of targets) {
       const res = await execa('git', ['branch', flag, branch], { cwd, reject: false });
       if (res.exitCode !== 0 && !force) {
         ctx.output.warn(
           `  ${cwd}: branch ${branch} non eliminato (commit non mergeati?). Usa --force per forzare.`
         );
       }
     }
   }
   ```
   Note: `reject: false` fa sì che execa ritorni il risultato anche su exit code != 0 (niente throw). Con `-d`, git rifiuta i branch non mergeati → warning; con `-D` (force) elimina comunque. `removeWorktree` gira PRIMA di questa funzione (il worktree è già rimosso), quindi il branch root non è più checked-out altrove.

2. Aggiorna la chiamata nel comando `remove`. Sostituisci:
   ```ts
   if (!options.keepBranch && target.branch) {
     const branch = target.branch;
     try {
       await deleteWorktreeBranch(ctx, branch, mainRoot);
       ctx.output.log(`  Branch ${branch} eliminato`);
     } catch {
       ctx.output.warn(`  Impossibile eliminare il branch ${branch} (lascialo o eliminalo a mano).`);
     }
   }
   ```
   con:
   ```ts
   if (!options.keepBranch && target.branch) {
     await deleteWorktreeBranch(ctx, target.branch, mainRoot, !!options.force);
   }
   ```
   (i messaggi per-target sono ora gestiti dentro `deleteWorktreeBranch`).

### Task 3.2: Verifica build e typecheck

**Steps:**

1. Run: `npm run typecheck`
   Expected: nessun nuovo errore oltre ai pre-esistenti noti.
2. Run: `npm run build`
   Expected: OK.

**Expected outcome:** cleanup branch generalizzato e con guard. Commit del chunk.

---

## Chunk 4: Chiusura — docs + memoria + BACKLOG

**Submodule:** `docs`
**Size:** S
**Depends on:** [1, 2, 3]
**Spec refs:** nessuno (meta-chunk)

Aggiornamento documentazione, memoria e BACKLOG post-implementazione.

### Task 4.1: Aggiorna documentazione progetto

**Files:**
- Modify: `CLAUDE.md` (jic-cli, sezione "Worktree Support")
- Modify: `README.md` (jic-cli, sezione worktree se presente)

**Steps:**

1. In `CLAUDE.md`, nella sezione "### Worktree Support", aggiungi un paragrafo che descrive il **modello origin-based tree** per i progetti a submodule:
   - il branch di una sessione/worktree nasce nei submodule della root (`mainRoot/<sub>`) dal base e il worktree lo deriva da `origin/<branch>`;
   - il base di un chunk (`--base feature/<plan>`) deve esistere nei submodule della root (creato quando il piano è stato avviato con lo stesso modello);
   - la propagazione del lavoro avviene con `jic session end --merge` (in contesto worktree+submodules fa push del branch target verso `origin`); va eseguito da dentro il worktree;
   - flusso tipico: plan worktree → lavoro → session end --merge → chunk worktree dal piano.
2. In `README.md`, se esiste una sezione worktree, aggiungi una nota sintetica sullo stesso modello e sul flusso plan→chunk.

**Expected outcome:** docs allineate al nuovo comportamento.

### Task 4.2: Aggiorna memoria personale

**Steps:**

1. Nessun aggiornamento di memoria necessario: il comportamento è documentato in CLAUDE.md/spec. (Se durante l'esecuzione emergono decisioni di processo non derivabili dal codice, valutarne il salvataggio.)

**Expected outcome:** nessuna azione, o memoria aggiornata se applicabile.

### Task 4.3: Aggiungi voci al BACKLOG

**Files:**
- Modify: `docs/BACKLOG.md`

**Steps:**

1. Leggi `docs/BACKLOG.md` per categorie, ID progressivo e stile.
2. Aggiungi nella categoria "Worktree" (o la più pertinente) le voci:
   - **Test integrazione worktree+submodule**: i flussi worktree+submodule non sono coperti da test automatici (operazioni git, difficili da mockare). Aggiungere test d'integrazione su repo usa-e-getta (setup submodule URL relativi, plan→chunk, propagazione, cleanup). (Origine: piano worktree-submodule-branch-tree.)
   - **Cleanup branch del parent a `session end --worktree-remove`**: la propagazione (Chunk 2) crea/aggiorna branch in `mainRoot/<sub>`; verificare che `session end --worktree-remove` (oltre a `worktree remove`) ripulisca i branch del parent non più necessari. (Origine: spec §7, oltre lo scope corrente.)
   - **Base per-modulo eterogeneo**: `submoduleBaseBranch` è unico per tutti i submodule; se in futuro i submodule avessero default branch diversi (`module.branches.local` per-modulo), valutare un base per-submodule. (Origine: spec §5, semplificazione corrente.)
   - **Push del chunk 2 eseguito dal root**: se `session end --merge` di una sessione worktree viene lanciato dal root invece che da dentro il worktree, `module.absolutePath` non punta al submodule del worktree e il push non parte. Valutare di risolvere il path del submodule via `session.worktreePath`. (Origine: review piano, nota.)
   - (Se non già presente) confermare che **WT-5** (two-worktree sul merge del root base) resta aperto: la propagazione di questo piano riguarda i submodule, non il merge del root base.

**Expected outcome:** voci BACKLOG aggiunte. Commit del chunk di chiusura.
