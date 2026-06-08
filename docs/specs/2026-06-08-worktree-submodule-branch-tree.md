# Worktree submodule branch tree — branch base propagato come albero

**Status:** approvata (brainstorming)
**Data:** 2026-06-08
**Dimensione:** L

---

## 1. Problem / Context

Dal pacchetto evidenze del team che usa `jic worktree` (problema #1):

```
jic session start <chunk> --base feature/<plan> --worktree   # eseguito dal ROOT
back/cli/front/scaffold: failed to create feature/<chunk> from feature/<plan>
  fatal: 'feature/<plan>' non è un commit ...
ℹ Root repo: created branch feature/<chunk>   ← solo root
```

Il branch base del piano (`feature/<plan>`) esiste nei submodule **solo dentro il worktree del piano**, non nei submodule della root. Quando si crea un chunk, la creazione del suo branch fallisce nei submodule (il base non c'è) → il branch nasce solo nel root, i submodule restano detached. A catena: sessione "senza moduli", commit e merge rotti.

**Causa.** `addWorktree` crea i branch dei submodule con `git checkout -b <branch>` **da HEAD dentro il worktree** (scelta originale: nel clone del submodule il ref del base non esisteva). Risultato: il branch vive isolato nel worktree del piano e non è disponibile come base per i worktree figli.

**Contesto già risolto** (commit precedenti, fuori da questa spec):
- #2 — path dei worktree risolti contro la root principale (no annidamento).
- #3 — `jic git commit --update-root` committa anche i file propri della root.
- #4 — branch principale (`main`/`master`) configurabile via `defaults.branches.local` (gestito da config).

---

## 2. Spike findings (validazione meccanica)

Spike eseguito su repo usa-e-getta in `/tmp`, replicando il caso del team (submodule con URL relativo che risolve sulla copia nella root, **nessun remote**). Risultati:

- **Origin del submodule del worktree** = `mainRoot/<sub>`: il worktree clona il submodule dalla copia presente nella root.
- **Ereditarietà ref**: un branch creato in `mainRoot/<sub>` **prima** del `submodule update --init` del worktree è disponibile nel clone del worktree come **`origin/<branch>`** (ref remoto).
- **Push worktree → parent**: dal submodule del worktree `git push origin <branch>` aggiorna `mainRoot/<sub>`.
- **Catena**: un secondo worktree (chunk) creato **dopo** il push clona `mainRoot/<sub>` aggiornato → eredita `origin/<plan>` **con i commit del piano**; `git checkout -b <chunk> origin/<plan>` funziona e include il lavoro del piano.
- **Asimmetria chiave**: il **root** repo condivide ref e object store tra i worktree linkati (le modifiche ai branch root propagano da sole); i **submodule** hanno git dir **isolati** per-worktree (serve push esplicito per propagare).

Conclusione: i primitivi git per il modello "albero" esistono tutti. Il design qui sotto li sfrutta.

---

## 3. Approach — modello "origin-based tree"

Principio: **la copia dei submodule nella root (`mainRoot/<sub>`) è la source of truth (`origin`) dei submodule dei worktree.** Il branch di una sessione/worktree **nasce nel parent** (root + submodule della root) e i worktree lo **derivano da `origin/<base>`**, ereditandolo. Si forma un albero: root → worktree del piano → worktree dei chunk → …

Conseguenze dirette dall'asimmetria root/submodule:
- **Root**: i branch sono condivisi tra i worktree → nessun lavoro extra per propagare.
- **Submodule**: isolati → il branch va **creato in `mainRoot/<sub>`** alla creazione del worktree (così esiste subito per i figli) e il **lavoro va pushato** verso `origin` per renderlo disponibile ai worktree fratelli/figli.

---

## 4. Creazione del branch (`addWorktree`, `worktree create`, `session start --worktree`)

Nuovo comportamento per la fase di branching dei submodule in `addWorktree`, **solo per progetti a submodule**:

1. `git worktree add` del root (invariato) dal base risolto.
2. `git submodule update --init` con gli override già introdotti (URL relativi risolti contro `mainRoot`, `protocol.file.allow=always`). A questo punto ogni submodule del worktree ha `origin = mainRoot/<sub>` e i ref `origin/*` ereditati.
3. **Creazione del branch nel parent**: per ogni submodule target — i submodule del **vendor** se attivo, **altrimenti tutti i submodule del progetto** (caso non-vendor, es. cicero) — creare il branch in `mainRoot/<sub>` dal base risolto (vedi §5):
   ```
   git -C mainRoot/<sub> branch <branch> <base>     # <base> esiste in mainRoot/<sub>
   ```
   Questo è "il branch nasce nel parent": diventa subito `origin/<branch>` per qualsiasi worktree.
4. **Checkout nel worktree**: nel submodule del worktree, derivare il branch dal ref ereditato:
   ```
   git -C <worktree>/<sub> checkout -b <branch> origin/<branch>
   ```
   (branch locale che traccia `origin/<branch>`).

Questo **sostituisce** l'attuale `git checkout -b <branch>` da HEAD (isolato). Vendor e non-vendor sono trattati allo stesso modo: cambia solo il nome del branch (prefisso vendor vs `feature/`), non il meccanismo.

> Nota: se `mainRoot/<sub>` ha già il branch (es. base = piano già esistente), la creazione al punto 3 va resa idempotente (skip se esiste, vedi §5).

---

## 5. Risoluzione del `--base` nei submodule

Il base deve essere un ref **esistente in `mainRoot/<sub>`** (quindi ereditabile come `origin/<base>` nel worktree):

- `--base feature/<plan>` → deve esistere `feature/<plan>` in `mainRoot/<sub>` (ci è nato quando il piano è stato creato con questo stesso modello). La creazione del branch del chunk al §4.3 parte da `feature/<plan>`; il checkout al §4.4 deriva da `origin/<chunk>`.
- **Se il base non esiste** in `mainRoot/<sub>` → errore chiaro per quel submodule, che spiega di creare prima il piano (e non lasciare il submodule detached silenziosamente).
- **`--base` omesso** → default-branch per modulo dalla catena di config: `module.branches?.local → defaults.branches?.local → 'main'` (coerente con #4; un repo su `master` lo configura via `defaults.branches.local`).

---

## 6. Propagazione del lavoro (`session end --merge` worktree-aware)

`session end --merge` resta il comando designato per la propagazione. Estensione **gated** su due condizioni insieme — la sessione vive in un **worktree** (`session.worktreePath` valorizzato / linked worktree) **e** progetto a **submodule**:

- Il merge avviene già nel **submodule del worktree** (`module.absolutePath` punta al worktree quando la sessione vive lì). Il cui `origin` è `mainRoot/<sub>` (vedi spike §2). Subito dopo `git merge <sessionBranch> --no-edit`, dallo **stesso submodule del worktree** aggiungere:
  ```
  git -C <worktree>/<sub> push origin <targetBranch>
  ```
  Il push ha come destinazione `mainRoot/<sub>` (è l'origin di quel clone), quindi il merge raggiunge il parent e i worktree fratelli/figli.
- **Root**: nessuna modifica — i ref sono condivisi tra i worktree, il merge del branch root è già visibile nel parent.
- **Sessione non-worktree**: comportamento **identico** a oggi (nessun push aggiunto).

Casi da gestire:
- **Push non fast-forward** (il target in `mainRoot/<sub>` è avanzato nel frattempo): non forzare; riportare errore chiaro e lasciare il merge locale committato (l'utente risolve). Niente `--force`.
- **Interazione con WT-5** (già a backlog): il merge del **root** base branch può collidere col vincolo git "stesso branch checked-out in due worktree" se il base è attivo nel worktree principale. Da affrontare nel piano (merge senza checkout, o merge dal lato giusto).

---

## 7. Lifecycle / pulizia

Alla rimozione del worktree (`worktree remove`, `session end --worktree-remove`):

- Eliminare il branch del worktree **anche** in `mainRoot/<sub>` (oltre che root + submodule del worktree), perché ora il branch vive anche nel parent.
- **Generalizzare il targeting dei submodule**: oggi `deleteWorktreeBranch` (commands/worktree.ts) elimina i branch dei submodule **solo se `ctx.vendorConfig` è presente** (filtro `vendorConfig.modules`). Va esteso al caso **non-vendor** (es. cicero), dove i submodule target sono tutti quelli del progetto. Stessa logica di selezione usata in §4.3.
- **Solo** il branch del worktree rimosso: mai eliminare un base ancora in uso da altri worktree (es. rimuovendo un chunk non si tocca `feature/<plan>`).
- Se il branch in `mainRoot/<sub>` ha **commit non mergeati** verso il suo base → **warning** invece di forzare l'eliminazione (coerente con `git branch -d` vs `-D`), salvo `--force`.

---

## 8. Impact

| Area | File | Modifica |
|------|------|----------|
| Branching worktree | `src-ts/core/utils/worktree.ts` (`addWorktree`) | branch creato in `mainRoot/<sub>` dal base + checkout da `origin/<branch>` nel worktree (sostituisce checkout da HEAD) |
| Risoluzione base | `src-ts/core/utils/worktree.ts` / chiamanti | base risolto come ref di `mainRoot/<sub>`; errore se assente |
| Propagazione | `src-ts/commands/session.ts` (`mergeSessionBranches`) | push `origin <target>` nei submodule, gated su worktree + submodules |
| Pulizia | `src-ts/core/utils/worktree.ts` (`removeWorktree`) + `src-ts/commands/worktree.ts` (`deleteWorktreeBranch`) | elimina il branch anche in `mainRoot/<sub>`, con guard sui commit non mergeati; generalizza il targeting submodule al caso **non-vendor** (oggi gated su `vendorConfig`) |

**Nessun impatto** su: `session start` non-worktree, progetti non-submodule, comandi git non worktree.

---

## 9. Risks & open questions

- **WT-5 (two-worktree sul root base)**: il merge/checkout del root base branch può fallire se il base è già checked-out nel worktree principale. Da risolvere nel piano (merge senza checkout o dal lato corretto).
- **Push non fast-forward**: gestione conflitti in propagazione (vedi §6) — strategia "no force, report".
- **Submodule parziali**: se solo alcuni submodule hanno il base, comportamento per-submodule (errore mirato, gli altri proseguono?) da fissare nel piano.
- **Branch idempotente in mainRoot/<sub>**: creazione branch quando esiste già (base = piano) — skip vs errore.
- **`protocol.file.allow` / URL relativi**: già gestiti dai fix precedenti; la spec ne dipende ma non li ri-tratta.

---

## 10. Success criteria

1. `jic session start <plan> --worktree` (submodules) crea `feature/<plan>` in `mainRoot/<sub>` e nel worktree (derivato da origin); il repo principale resta sul suo branch (il base è solo un ref aggiuntivo).
2. `jic session start <chunk> --base feature/<plan> --worktree` — sia dal **root** sia da **dentro un worktree** — crea il branch del chunk nei submodule a partire da `feature/<plan>` (nessun submodule detached, nessun "fatal: not a commit").
3. Dopo `session end --merge` di un chunk (in worktree+submodules), il lavoro è pushato in `mainRoot/<sub>`; un chunk successivo creato dal piano **vede** quel lavoro.
4. La catena piano → chunk → (eventuale) sotto-chunk funziona a più livelli.
5. `worktree remove` elimina il branch del worktree in root + submodule del worktree + `mainRoot/<sub>`, senza toccare base in uso da altri worktree; warning sui commit non mergeati.
6. Comportamento invariato per sessioni non-worktree e progetti non-submodule.
