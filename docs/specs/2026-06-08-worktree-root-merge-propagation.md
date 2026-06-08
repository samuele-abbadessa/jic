# Worktree root merge propagation — merge del root chunk→piano dal worktree fratello

**Status:** approvata (brainstorming)
**Data:** 2026-06-08
**Dimensione:** L
**Spec correlata:** [`2026-06-08-worktree-submodule-branch-tree.md`](./2026-06-08-worktree-submodule-branch-tree.md) (modello origin-based tree, #1)

---

## 1. Problem / Context

Dal field-test del team che usa `jic worktree` in contesto submodules (problema #5):

```
jic session end <chunk> --merge        # lanciato dal CHUNK worktree
... submodule: propagato al parent      # OK (fix #1)
✖ root: merge failed                    # opaco, nessun messaggio git
```

`jic session end <chunk> --merge` **non propaga il commit del repo ROOT** dal branch del chunk al branch di piano. I submodule funzionano già (push `origin <target>`, fix #1); manca solo il root.

**Causa** (`src-ts/commands/session.ts:851-873`). Il root merge fa, in `cwd: ctx.projectRoot`:
```ts
await exec(`git checkout ${session.rootBaseBranch}`, { cwd: ctx.projectRoot, silent: true });
await exec(`git merge ${session.rootBranch} --no-edit`, { cwd: ctx.projectRoot, silent: true });
```
Eseguito dal chunk worktree, `ctx.projectRoot` è il chunk worktree. Il `git checkout feature/<plan>` **fallisce** perché `feature/<plan>` è già checked-out nell'integration worktree: il repo root è **condiviso** tra i worktree linkati e git rifiuta di avere lo stesso branch HEAD in due worktree. L'eccezione è inghiottita da `catch {}` (riga 870) → "root: merge failed" senza dettaglio.

**Asimmetria root vs submodule** (documentata nello spike del #1, spec correlata §2):
- **Submodule** → git dir **isolato** per-worktree. `feature/<plan>` può essere checked-out indipendentemente in ogni worktree, e `origin` è un repo separato (`mainRoot/<sub>`) → `checkout`+`merge`+`push origin` funzionano dal chunk worktree.
- **Root** → git dir **condiviso** tra i worktree. `feature/<plan>` è checked-out in **un solo** worktree (l'integration); non esiste un `origin` separato verso cui pushare; i ref sono già condivisi. Dal chunk worktree non si può né `checkout`, né `push .`, né `branch -f` su `feature/<plan>`.

**Conseguenza diretta**: la direzione "applica al root la stessa 'propaga al parent' dei submodule" **non è applicabile** (non c'è parent separato). L'unico modo di aggiornare `feature/<plan>` è eseguire il merge **nel worktree dove è checked-out** (l'integration worktree). Poiché i ref del root sono condivisi, `feature/<chunk>` è già visibile da lì senza fetch/push.

**Scope**: il fix è circoscritto al **solo merge del root**. Il lato submodule resta invariato. Confermato col team jic (non esiste `jic git merge`; il merge coordinato repo+submodule vive solo dentro `session end --merge`, quindi è terreno di `jic`).

---

## 2. Spike findings (validazione meccanica)

Spike su repo usa-e-getta (`/tmp`), scenario plan→chunk con root condiviso e worktree integration + chunk:

| Test | Esito |
|------|-------|
| **(b2)** `git -C <integration-wt> merge <rootBranch> --no-edit` lanciato **dal chunk worktree** | ✅ Aggiorna `feature/<plan>` in-place nel worktree dove è checked-out. Meccanismo solido. |
| **(B-ff)** `git update-ref refs/heads/<plan> <chunk-tip>` su branch checked-out altrove | ⚠️ **Permesso ma corrompe** il working tree dell'altro worktree (mostra modifiche fantasma). **Scartato**. |
| **(b2) working tree sporco** nell'integration | ✅ git rifiuta con stderr chiaro ("le tue modifiche locali sarebbero sovrascritte"); errore riportabile. |
| **base non checked-out in alcun worktree** | ✅ `git worktree list --porcelain` lo rileva → si usa il path legacy (`checkout`+`merge` in `ctx.projectRoot`). |

Conclusione: **(b2)** è la strada. **(B-ff)** scartato (unsafe). Il path legacy resta per sessioni non-worktree e per il caso in cui il base non è checked-out da nessuna parte.

---

## 3. Approach — merge nel worktree che possiede il base

Principio: **il merge del root avviene là dove `session.rootBaseBranch` è checked-out.** Non si sposta il branch verso il chunk worktree; si esegue il merge nella `cwd` corretta.

Nuova logica per il blocco root merge di `mergeSessionBranches` (`session.ts:851-873`), **solo quando `ctx.isSubmodules() && session.rootBranch && session.rootBaseBranch`**:

1. **Trova il worktree del base**: parsare `git worktree list --porcelain` (eseguito su `ctx.projectRoot`) e individuare l'entry il cui `branch` è `refs/heads/<rootBaseBranch>`. Restituisce il path del worktree, oppure `null` se nessun worktree ha quel branch checked-out.

2. **Caso "base checked-out in un worktree"** (path nuovo, b2):
   - `mergeCwd = <path del worktree del base>`.
   - **Niente `git checkout`**: il base è già HEAD in quel worktree.
   - `git -C <mergeCwd> merge <rootBranch> --no-edit`.
   - **Conflitto** (exitCode ≠ 0 con merge in corso) → `git -C <mergeCwd> merge --abort` + riportare lo stderr reale. Non lasciare l'integration worktree in stato `MERGING`.
   - **Tree sporco / altri errori** → riportare lo stderr reale, nessun stash/force.

3. **Caso "base non checked-out in alcun worktree"** (path legacy, invariato):
   - `mergeCwd = ctx.projectRoot`.
   - `git -C <mergeCwd> checkout <rootBaseBranch>` poi `git -C <mergeCwd> merge <rootBranch> --no-edit` (comportamento attuale).

4. **Commit dei pointer submodule** (`stageSubmodulePointers` / `commitSubmodulePointers`): eseguiti su **`mergeCwd`** (il worktree dove è avvenuto il merge), non più hard-coded su `ctx.projectRoot`. Restano subordinati al successo del merge.

5. **Esposizione errori** (bonus #3): sostituire il `catch {}` muto (riga 870) con cattura e stampa dello stderr git reale, in entrambi i path.

> **Nota propagazione**: per il root **non serve** alcun push. Aggiornato `feature/<plan>` nel suo worktree, i ref sono condivisi: il chunk worktree e i futuri worktree figli vedono già il merge. La propagazione "verso il parent" del root è automatica una volta che il ref è aggiornato.

---

## 4. Risoluzione del worktree del base

Helper nuovo (in `core/utils/worktree.ts`), che **riusa `listWorktrees`** già esistente (`worktree.ts:122`) invece di ri-parsare il porcelain:

```ts
/**
 * Restituisce il path assoluto del worktree che ha `branch` come HEAD checked-out,
 * oppure null se nessun worktree linkato lo ha. Source of truth: git worktree list.
 */
export async function findWorktreeForBranch(
  mainRoot: string,
  branch: string
): Promise<string | null> {
  const worktrees = await listWorktrees(mainRoot);
  return worktrees.find((w) => w.branch === branch)?.path ?? null;
}
```

- `listWorktrees(mainRoot)` restituisce già `{ path, branch, head, isMain }` con `branch` **senza** prefisso `refs/heads/` (`worktree.ts:138`). Quindi il confronto è sul **nome nudo** del branch (`w.branch === branch`), non su `refs/heads/<branch>`.
- I worktree detached hanno `branch` vuoto/undefined → non matchano mai.

`mainRoot` è risolto dal chiamante via `getMainRepoRoot(ctx.projectRoot)` (coerente col fix #2), così la lista dei worktree è completa anche lanciando il comando da dentro un worktree.

---

## 5. Impact

| Area | File | Modifica |
|------|------|----------|
| Risoluzione worktree del base | `src-ts/core/utils/worktree.ts` | nuovo `findWorktreeForBranch(mainRoot, branch)` (parsing porcelain) |
| Root merge | `src-ts/commands/session.ts` (`mergeSessionBranches`, ~851-873) | merge in `mergeCwd` (worktree del base se trovato, altrimenti `ctx.projectRoot`); no checkout nel caso b2; abort su conflitto; pointer commit su `mergeCwd` |
| Esposizione errori | `src-ts/commands/session.ts` (riga ~870) | rimuovere `catch {}` muto; stampare stderr git reale |
| Test | `tests/core/utils/worktree.test.ts` (o nuovo file) | unit test del parsing di `findWorktreeForBranch` (mock `execa`): match, detached, multi-entry, nessun match |

**Nessun impatto** su: lato submodule del merge (invariato), sessioni non-worktree (path legacy), progetti non-submodule, comandi git non worktree, storage delle sessioni (resta per-worktree, Modello A intatto — **nessuna** modifica alla discovery delle sessioni).

---

## 6. Risks & open questions

- **Merge lanciato dal root invece che dal worktree** (correlato WT-14): se `session end --merge` è lanciato da fuori dei worktree, `findWorktreeForBranch` trova comunque l'integration worktree e il merge funziona; il lato submodule però (WT-14) resta dipendente dalla cwd. Fuori scope qui: questa spec tocca solo il root.
- **Conflitti reali nel merge non-ff**: gestiti con `merge --abort` + report. L'utente risolve manualmente nell'integration worktree. Non automatizziamo la risoluzione.
- **Pointer submodule in caso di path legacy vs b2**: la funzione di commit dei pointer ora gira su `mergeCwd`. Confermato leggendo `core/utils/submodule.ts:11,20`: `stageSubmodulePointers(projectRoot, ...)` e `commitSubmodulePointers(projectRoot, ...)` accettano già il root come **primo argomento** → chiamarle con `mergeCwd` è fattibile **senza** estendere la firma.
- **WT-5** (a backlog) è di fatto **risolto** da questa spec per il caso submodules: il merge two-worktree sul root non passa più da un `checkout` che collide. Aggiornare lo stato di WT-5 nel chunk di chiusura.

---

## 7. Success criteria

1. `jic session end <chunk> --merge` lanciato dal **chunk worktree** (submodules) porta il commit del **root** dal branch del chunk a `feature/<plan>`, aggiornando il branch in-place nell'integration worktree dove è checked-out — senza "root: merge failed".
2. Se il merge del root va in conflitto, l'integration worktree **non** resta in stato `MERGING` (abort eseguito) e l'utente vede lo **stderr git reale**.
3. Se il working tree dell'integration worktree è sporco, il merge è rifiutato con messaggio git chiaro (nessuno stash/force automatico).
4. Sessioni **non-worktree** e progetti **non-submodule**: comportamento del root merge **invariato** (path legacy checkout+merge).
5. I pointer dei submodule vengono committati nel worktree dove è avvenuto il root merge.
6. `findWorktreeForBranch` è coperto da unit test (match / detached / nessun match).
