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

---

## Tech Debt

| ID | Stato | Task | Descrizione | Note | Chiuso |
|----|-------|------|-------------|------|--------|
| TD-1 | aperto | Pulizia errori typecheck `clean.ts` | `clean.ts` ha un import `colors` non utilizzato (TS6133 noUnusedLocals). Pre-esistente, scoperto durante implementazione worktree. | `src-ts/commands/clean.ts` | |
| TD-2 | aperto | Pulizia errori typecheck `deploy.ts` | `deploy.ts` ha `deployFrontend` importata ma non usata (TS6133). Pre-esistente. | `src-ts/commands/deploy.ts` | |
| TD-3 | aperto | Pulizia errori typecheck `defaults.ts` | `defaults.ts` ha `BranchConfig` importato ma non usato (TS6196). Pre-esistente. | `src-ts/core/config/defaults.ts` | |

---

## Testing

| ID | Stato | Task | Descrizione | Note | Chiuso |
|----|-------|------|-------------|------|--------|
| TEST-1 | aperto | Test unitari `listWorktrees` | Parsing porcelain: multi-entry, detached HEAD, marker `(main)`. Mock di `execa`. | `core/utils/worktree.ts`, spec §8 | |
| TEST-2 | aperto | Test unitari `seedWorktreeState` | Verifica che lo stato venga scritto correttamente nel worktree. Mock di `fs`. | `core/utils/worktree.ts`, spec §8 | |
| TEST-3 | aperto | Test unitari `assertGitWorktreeSupport` | Tre scenari: versione ok (≥ 2.38), versione troppo vecchia, output non parsabile. Mock di `execa`. | `core/utils/worktree.ts`, spec §8 | |
