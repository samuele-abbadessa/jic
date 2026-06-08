# BACKLOG

Voci di lavoro aperte per jic-cli. Le voci sono raggruppate per categoria e ordinate per priorità indicativa. Tutte le voci nascono dallo sviluppo della feature `jic worktree` (chunk 1-4) o da revisioni di codice correlate.

---

## Worktree

| ID | Stato | Task | Descrizione | Note | Chiuso |
|----|-------|------|-------------|------|--------|
| WT-1 | aperto | `AddWorktreeOptions.baseBranch` opzionale | Oggi il campo è obbligatorio anche quando si usa `--branch <esistente>` (dove viene ignorato). Renderlo opzionale con guard runtime. | `core/utils/worktree.ts` | |
| WT-2 | aperto | `jic worktree prune` per worktree orfani | `remove` non gestisce worktree spariti da disco ma ancora presenti in `git worktree list`. Valutare un sottocomando `prune` dedicato. | spec §7 | |
| WT-3 | aperto | Warning `--no-submodules` su progetto submodules | Avvisare esplicitamente che i submodule resteranno vuoti quando si usa `--no-submodules`. | UX/safety, chunk 3 | |
| WT-4 | aperto | Fallback `baseBranch='master'` hardcoded | In `commands/worktree.ts` e `commands/session.ts` (`sessionStartInWorktree`) il fallback è `'master'` hard-coded. Usare `ctx.config.defaults.branches?.local ?? 'master'`. | review chunk 3/4 | |
| WT-5 | aperto | Merge two-worktree in `session end --merge` | Se il branch base è già checked-out nel worktree principale, git rifiuta il checkout (vincolo two-worktree). Valutare merge senza checkout o dal lato del worktree root principale. | piano §5.3 / spec | |
| WT-6 | aperto | Fallback cloni indipendenti submodule | Se future versioni git rendono inaffidabile la strategia nativa worktree+submodule (validata su 2.45.2), implementare strategia alternativa con cloni indipendenti. | piano §7 / spec | |
| WT-7 | aperto | Isolamento porte serve/deploy tra worktree | Worktree paralleli che eseguono `jic serve`/`deploy` possono collidere su porte o risorse condivise. Valutare offset di porta automatico per worktree. | spec §7, fuori scope feature corrente | |
| WT-8 | aperto | Check versione git su list/remove/path | Solo `create` e `session start --worktree` chiamano `assertGitWorktreeSupport`. Spec §4.5 prevede il check per tutti i sottocomandi `jic worktree`. Decidere se estenderlo. | review finale | |
| WT-9 | aperto | `--branch` su `session start --worktree` | `worktree create` supporta `--branch <esistente>`, ma `session start --worktree` non lo espone. Allineare le due superfici se utile. | review finale | |
| WT-10 | aperto | Default base branch intelligente (`main` vs `master`) | Per progetti non-vendor il base branch di default è `'master'` hardcoded; un repo su `main` (es. cicero) richiede `--base main` esplicito. Rilevare il branch corrente/di default del repo principale (es. `git symbolic-ref --short HEAD` o `git rev-parse --abbrev-ref origin/HEAD`) invece di assumere `master`. Correlata a WT-4. | `commands/worktree.ts`, `commands/session.ts`; emersa testando il fix submodule URL relativi | |
| WT-11 | aperto | Test integrazione worktree+submodule | I flussi worktree+submodule (origin-based tree, catena plan→chunk, propagazione `session end --merge`, cleanup branch) non sono coperti da test automatici (le operazioni git reali richiedono repo usa-e-getta). Aggiungere test d'integrazione con repo temporanei e URL relativi. | origine: piano worktree-submodule-branch-tree | |
| WT-12 | aperto | Cleanup branch parent a `session end --worktree-remove` | La propagazione origin-based crea/aggiorna branch nei submodule della mainRoot (`mainRoot/<sub>`). Verificare che `session end --worktree-remove` (oltre a `worktree remove`) ripulisca i branch del parent non più necessari. | spec §7 | |
| WT-13 | aperto | Base per-modulo eterogeneo nei worktree | `submoduleBaseBranch` è unico per tutti i submodule. Se i submodule avessero default branch diversi (tramite `module.branches.local` per-modulo) valutare un base per-submodule invece di un valore globale. | spec §5 | |
| WT-14 | aperto | Push propagazione se `session end --merge` lanciato dal root | Se la sessione worktree viene chiusa dal root invece che da dentro il worktree, `module.absolutePath` non punta al submodule del worktree e il push di propagazione non parte. Valutare di risolvere il path tramite `session.worktreePath`. Correlata a WT-5. | review piano, chunk 2 | |

---

## Tech Debt

| ID | Stato | Task | Descrizione | Note | Chiuso |
|----|-------|------|-------------|------|--------|
| TD-1 | aperto | Pulizia errori typecheck `clean.ts` | `clean.ts` ha un import `colors` non utilizzato (TS6133 noUnusedLocals). Pre-esistente, scoperto durante implementazione worktree. | `src-ts/commands/clean.ts` | |
| TD-2 | aperto | Pulizia errori typecheck `deploy.ts` | `deploy.ts` ha `deployFrontend` importata ma non usata (TS6133). Pre-esistente. | `src-ts/commands/deploy.ts` | |
| TD-3 | aperto | Pulizia errori typecheck `defaults.ts` | `defaults.ts` ha `BranchConfig` importato ma non usato (TS6196). Pre-esistente. | `src-ts/core/config/defaults.ts` | |
| TD-4 | aperto | `cleanConfig` perde campi `kubernetes` e `templates` | Il literal `cleanConfig` in `saveConfig` (~riga 446-458) non include `kubernetes` né `templates` → questi campi vengono persi a ogni `saveConfig`. Verificare se intenzionale; se no, aggiungerli. Scoperto durante implementazione `module exec`. | `src-ts/core/config/loader.ts` | |

---

## Module Exec

Feature `jic module exec` — miglioramenti e estensioni post-implementazione.

| ID | Stato | Task | Descrizione | Note | Chiuso |
|----|-------|------|-------------|------|--------|
| ME-1 | aperto | Output header+output in coppia con `--parallel` | Con `--parallel` (o più moduli), gli header vengono stampati in blocco e poi gli output in blocco. Migliorare stampando header+output appaiati per ciascun modulo. | `src-ts/commands/module.ts` | |
| ME-2 | aperto | Default aliases per java/dotnet | Estendere `buildDefaultCommands` con alias di default per `java-service`/`flux-client` (es. `build`→`mvn -B package`) e `dotnet-service`. Oggi solo node/frontend. | `src-ts/commands/module.ts` | |
| ME-3 | aperto | `--fail-fast` per `module exec` | Aggiungere flag per interrompere l'esecuzione al primo modulo fallito. Oggi il comportamento è sempre continue-on-error. | `src-ts/commands/module.ts` | |
| ME-4 | aperto | `--dry-run` per `module exec` | Mostrare quali comandi verrebbero eseguiti su quali moduli senza eseguirli effettivamente. | `src-ts/commands/module.ts` | |
| ME-5 | aperto | `jic module exec --list` | Elencare gli alias disponibili per i moduli target senza eseguire nulla. Utile per discovery degli alias definiti. | `src-ts/commands/module.ts` | |

---

## Testing

| ID | Stato | Task | Descrizione | Note | Chiuso |
|----|-------|------|-------------|------|--------|
| TEST-1 | aperto | Test unitari `listWorktrees` | Parsing porcelain: multi-entry, detached HEAD, marker `(main)`. Mock di `execa`. | `core/utils/worktree.ts`, spec §8 | |
| TEST-2 | aperto | Test unitari `seedWorktreeState` | Verifica che lo stato venga scritto correttamente nel worktree. Mock di `fs`. | `core/utils/worktree.ts`, spec §8 | |
| TEST-3 | aperto | Test unitari `assertGitWorktreeSupport` | Tre scenari: versione ok (≥ 2.38), versione troppo vecchia, output non parsabile. Mock di `execa`. | `core/utils/worktree.ts`, spec §8 | |
