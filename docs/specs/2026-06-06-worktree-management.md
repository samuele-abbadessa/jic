# Spec: Gestione Git Worktree in `jic` (con submodules)

- **Stato:** RFC — in review
- **Data:** 2026-06-06
- **Autore:** Samuele (brainstorming con Claude)
- **Dimensione:** L
- **Topic:** Aggiungere a `jic` la gestione dei git worktree, con primo cittadino i progetti `project.type: "submodules"` e la strategia vendor-branch, integrata con il sistema di sessioni.

---

## 1. Problem / Context

`jic` è un CLI che astrae le operazioni su progetti multi-modulo, in particolare progetti con submodules e strategia vendor-branch. È pensato anche per essere usato da agenti AI, che lo lanciano dalla **root** del progetto senza dover saltare tra le cartelle dei singoli submodule.

Limite attuale: **più contesti di lavoro non possono procedere in parallelo sullo stesso checkout**. Due agenti (o un agente + l'utente) che lavorano contemporaneamente sulla stessa working directory si pestano i piedi, a volte con esiti distruttivi (checkout incrociati, stash che si sovrascrivono, build concorrenti sugli stessi artefatti).

La soluzione standard git per questo è il **worktree**: working directory multiple che condividono lo stesso repository. Ma con i **submodules** i worktree sono notoriamente scomodi: `git worktree add` sul repo principale crea la nuova working dir lasciando i submodule **vuoti**, e popolarli/gestirli a mano è fragile.

### Vincoli del modello attuale (dall'esplorazione del codice)

- Tutto il CLI poggia su **una singola `projectRoot`**, scoperta risalendo le cartelle fino al primo `jic.config.json` (`core/config/loader.ts:92-109`).
- Ogni modulo ha `absolutePath = join(projectRoot, directory)`, calcolato **una volta sola** al load (`core/config/loader.ts:282`).
- Lo stato runtime (`jic.state.json`) vive nella `projectRoot` ed è **git-ignored**.
- Il layer di esecuzione shell è già cwd-parametrico: ogni comando gira con `cwd: module.absolutePath` (`core/utils/shell.ts:93`).
- Helper submodule esistenti (`core/utils/submodule.ts`): `gitInRoot`, `stageSubmodulePointers`, `updateSubmodulePointers`, `commitSubmodulePointers`.
- Le sessioni creano branch per-modulo (+ root branch per submodules) con naming vendor-prefissato (`<vendor>/feature/<name>`) e gestiscono stash/checkout assumendo l'unica working dir.
- **Zero** riferimenti a "worktree" oggi: si parte da zero.

---

## 2. Approach — Modello A: il worktree come root indipendente

### Principio guida

> **Ogni worktree è una cartella separata, auto-sufficiente, che è a tutti gli effetti una `projectRoot` completa.**

Un worktree contiene il suo `jic.config.json` (tracciato in git, quindi presente automaticamente) e avrà il suo `jic.state.json` (git-ignored, quindi **isolato per natura**). Un `jic` lanciato dentro un worktree funziona **già oggi** senza modifiche al core: la project-root discovery trova la config locale, lo stato è separato, l'esecuzione gira nei path locali.

Di conseguenza il lavoro di `jic` si concentra su due cose:

1. **Provisionare** il worktree — la parte difficile: creare il worktree del root repo *e* popolare correttamente i submodule, gestendo branch vendor-aware e seeding dello stato.
2. **Gestire il ciclo di vita** — elencare, rimuovere (con cleanup pulito), e fornire ergonomia (stampa del path) per agenti e utente.

### Perché Modello A e non Modello B

Era stato valutato un **Modello B** ("context worktree-aware": `projectRoot` unica, `jic` traccia N worktree e muta dinamicamente gli `absolutePath`). Scartato perché:

- **Impatto invasivo** sul core (loader, ExecutionContext, ogni iterazione moduli).
- L'isolamento dello stato sarebbe da costruire a mano, mentre nel Modello A è gratis.
- Contrario al requisito esplicito: "voglio che ogni worktree sia una cartella separata".

Nel Modello A il core di `jic` (loader, ExecutionContext) **non viene toccato**: continua a vedere una sola root, semplicemente *quella* root è il worktree quando ci lavori dentro.

---

## 3. Worktree lifecycle & layout

### 3.1 Dove vivono fisicamente

I worktree stanno **fuori** dalla cartella del repo principale (annidarli dentro romperebbe la project-root discovery e sporcherebbe il repo). Layout di default:

```
<parent>/
├── <progetto>/                       ← root principale (repo + submodules)
└── <progetto>-worktrees/             ← contenitore dedicato (worktree.baseDir)
    ├── <nome-worktree-1>/
    ├── <nome-worktree-2>/
    └── ...
```

- Contenitore dedicato → tutti i worktree raggruppati, facili da elencare e pulire.
- Path configurabile in `jic.config.json` tramite `worktree.baseDir` (default: `../<nome-progetto>-worktrees`).

### 3.2 Strategia di checkout dei submodule (cuore tecnico)

Strategia target: **worktree nativo + init submodule**.

1. `git worktree add <path> <branch>` sul repo root (in `projectRoot`).
2. `git -C <path> submodule update --init --recursive` per popolare i submodule nel nuovo worktree.
3. Allineamento dei branch dei submodule alla logica vendor-aware (vedi 3.3) quando il worktree è creato come ambiente di feature.

Vantaggi: condivide l'object store (`.git/modules`), leggero e veloce, riusa la logica submodule esistente.

> ⚠️ **Da validare con spike** (vedi §7): worktree + submodule nativi hanno spigoli noti e dipendono dalla versione di git. Lo spike in fase di planning conferma il comportamento e fissa la versione minima.

Alternativa scartata (resta documentata): **cloni indipendenti** dei submodule per worktree — isolamento totale ma pesante su disco e lento. Si terrà come fallback solo se lo spike dimostra che la strategia nativa è inaffidabile sulle versioni git target.

### 3.3 Naming e branch

Coerente con le sessioni:

- `jic worktree create <nome>` crea worktree **+ branch nuovo** vendor-aware: `<vendor>/feature/<nome>` (per submodules), branch base = dev del vendor (stessa logica di `session start`).
- Flag `--branch <esistente>` per agganciare il worktree a un branch già presente invece di crearne uno nuovo.

### 3.4 Seeding dello stato del nuovo worktree

Poiché `jic.state.json` è git-ignored, il worktree nasce **senza stato** (nessun vendor attivo). Alla creazione `jic`:

- **Seeda** `activeVendor` nel `jic.state.json` del worktree copiandolo dallo stato della root corrente → coerenza vendor.
- Se il worktree è creato via `session start --worktree`, registra **anche** la sessione attiva nello stato del worktree.
- Non viene ereditato altro (deployment, build cache, serve → restano isolati per natura, ed è desiderato).

### 3.5 Source of truth dei worktree

- **`git worktree list` è la source of truth.** Sempre veritiero, anche per worktree creati a mano fuori da `jic`.
- Eventuali metadati `jic` (vendor associato, sessione associata) sono salvati come arricchimento nello state della root principale, ma **non sono autoritativi**: se mancano o divergono, `git worktree list` vince. Niente registro separato che possa desincronizzarsi.

---

## 4. Comandi `jic worktree`

Nuova famiglia di comandi. Disponibile per progetti `project.type: "submodules"` (e, dove sensato, anche per progetti independent — vedi nota finale).

### 4.1 `jic worktree create <nome>`

Crea un worktree isolato pronto all'uso.

- Calcola path: `<worktree.baseDir>/<nome>`.
- Crea branch vendor-aware (o usa `--branch <esistente>`).
- `git worktree add` sul root + `git submodule update --init --recursive` nel worktree.
- Allinea branch submodule (per ambiente feature). **Nota:** come per le sessioni, i branch vendor-prefissati vengono creati solo sui moduli **del vendor attivo**; i moduli non-vendor restano sul loro `nonVendorBranch`. La logica è la stessa di `session start` e va riusata, non reinventata.
- Seeda lo stato del worktree (`activeVendor`).
- Stampa il path assoluto del worktree al termine.

Flag principali:
- `--branch <nome>` — aggancia a un branch esistente invece di crearne uno nuovo.
- `--base <branch>` — override del branch base (default: dev del vendor).
- `--no-submodules` — crea solo il worktree del root senza popolare i submodule (caso avanzato / debug).

### 4.2 `jic worktree list`

Elenca i worktree esistenti basandosi su `git worktree list`, arricchiti con metadati jic se disponibili (vendor, sessione, branch). Rispetta i flag di output (`--json`, `--quiet`, `--verbose`).

### 4.3 `jic worktree remove <nome>`

Rimuove un worktree in modo pulito:

- Verifica modifiche pendenti (root + submodule); se presenti, richiede conferma o `--force`.
- Rimuove i worktree dei submodule e il worktree del root.
- `git worktree prune` per ripulire i riferimenti.
- Rimuove i metadati jic associati dallo state della root.

Flag: `--force` (rimuove anche con modifiche pendenti), `--keep-branch` (non elimina il branch associato).

### 4.4 `jic worktree path <nome>`

Stampa **solo** il path assoluto del worktree, niente altro. Pensato per gli agenti e per l'utente:

```bash
cd "$(jic worktree path foo)"
```

> Nota: in Modello A non esiste uno `switch`/`cd` nel processo corrente — non avrebbe senso, perché si entra fisicamente nella cartella del worktree. Per questo `path` è l'unico helper di "navigazione".

### 4.5 Requisito git + check runtime

worktree + submodule affidabili richiedono una versione di git ragionevolmente recente. `jic worktree` esegue un **check a runtime** della versione e fallisce con messaggio chiaro se non soddisfatta. La versione minima esatta viene fissata dopo lo spike (ipotesi di lavoro: git ≥ 2.38).

---

## 5. Integrazione con le sessioni

Due livelli componibili.

### 5.1 `jic worktree` autonomo

La famiglia `jic worktree …` esiste indipendentemente: si può creare un worktree senza avviare una sessione.

### 5.2 `jic session start <nome> --worktree` (zucchero)

Con il flag `--worktree`, `session start`:

1. Crea il worktree (riusa la logica di `worktree create`).
2. Avvia la sessione **al suo interno**: la logica di `session start` (oggi operante su `ctx.projectRoot`) va eseguita con `projectRoot` = path del worktree, così branch e stato sessione vengono registrati nel `jic.state.json` del worktree e non in quello della root principale. Questo è il punto di integrazione più delicato lato implementazione: serve poter rieseguire la logica di sessione puntando a una root diversa da quella corrente.
3. Stampa il path del worktree così l'utente/agente ci entra.

In questo modo un solo comando dà "un ambiente isolato pronto, già su una sessione".

### 5.3 Campo su `Session` e comportamento di `session end`

- Aggiunta di un campo opzionale su `Session` (es. `worktreePath?: string`) che indica se la sessione vive in un worktree.
- `jic session end` su una sessione worktree-based **offre la rimozione del worktree** dopo merge/cleanup (con conferma; comportamento configurabile via flag tipo `--remove-worktree` / `--keep-worktree`).
- Il merge/cleanup dei branch resta la logica esistente; la novità è solo l'eventuale `worktree remove` finale.

### 5.4 Coerenza vendor

La sessione creata nel worktree usa lo stesso vendor della root da cui è stata lanciata (grazie al seeding dello state, §3.4). I branch restano vendor-prefissati come oggi.

---

## 6. Impact map

### Nuovi file

| File | Ruolo |
|------|-------|
| `src-ts/commands/worktree.ts` | Famiglia comandi `jic worktree` (create/list/remove/path) |
| `src-ts/core/utils/worktree.ts` | Helper submodule-aware: `addWorktree`, `removeWorktree`, `listWorktrees`, init submodule, check versione git |

### File modificati

| File | Modifica |
|------|----------|
| `src-ts/core/utils/submodule.ts` | Eventuali helper condivisi riusati/estesi per il worktree |
| `src-ts/commands/session.ts` | Flag `--worktree` su `start`; cleanup worktree in `end` |
| `src-ts/core/types/state.ts` (tipo `Session`, `JicState`) | Campo `worktreePath?` su `Session`; eventuali metadati worktree nello state |
| `src-ts/core/types/config.ts` | Sezione `worktree` in `ProjectConfig`/config (es. `baseDir`) |
| `src-ts/commands/index.ts`, `src-ts/index.ts`, `src-ts/cli.ts` | Registrazione nuovo comando |
| Config validation (zod) | Schema per la sezione `worktree` |
| Docs (`CLAUDE.md`, `docs/`) | Documentazione comandi + requisito git |

### Cosa NON cambia (importante)

- `core/config/loader.ts` — la project-root discovery e il calcolo `absolutePath` restano invariati.
- `core/context/ExecutionContext.ts` — nessuna mutazione dinamica di root o path.
- Il core continua a vedere **una sola root**; il worktree è semplicemente *un'altra* root quando ci si lavora dentro.

Conclusione: il grosso del lavoro è concentrato in **2 punti** (comando + helper submodule-aware), più un'integrazione **mirata** con le sessioni. Niente refactor invasivo del core.

---

## 7. Risks & open questions

- **Spigoli git worktree + submodule (rischio principale).** La strategia nativa (§3.2) va validata con uno **spike** in fase di planning: creare un worktree del root, popolare submodule, fare checkout di branch nei submodule, verificare che non ci siano conflitti su `.git/modules/<sub>/worktrees/`. Esito dello spike → conferma strategia (a) o fallback ai cloni indipendenti (b).
- **Versione minima di git.** Da fissare dopo lo spike (ipotesi git ≥ 2.38). Check runtime con messaggio chiaro.
- **Worktree orfani / prune.** Worktree rimossi a mano o cartelle cancellate senza `jic worktree remove`: `git worktree prune` come rete di sicurezza; `list` deve gestire entry "prunabili".
- **Remove con modifiche pendenti.** Gestione di modifiche non committate in root e submodule prima della rimozione (conferma / `--force`).
- **Metadati jic vs git.** Tenere `git worktree list` come autorità ed evitare che i metadati jic diventino una seconda fonte di verità divergente.
- **Progetti `independent` (non submodules).** Il valore principale è per i submodules, ma i worktree hanno senso anche per progetti independent (più semplici: niente init submodule). Decisione aperta: abilitare `jic worktree` anche per `independent` fin da subito, o limitarsi a submodules nella prima versione. *(Default proposto in planning: supportare anche `independent`, è quasi gratis.)*
- **Build/serve concorrenti.** Worktree separati isolano il codice, ma porte/risorse di `serve` e artefatti `deploy` potrebbero collidere tra worktree. Fuori scope di questa spec, ma da tenere a mente (eventuale follow-up).

---

## 8. Success criteria

La feature è implementata correttamente quando:

1. **Due contesti in parallelo.** Da un progetto submodules, `jic worktree create a` e `jic worktree create b` producono due cartelle separate, ciascuna con root + submodule popolati e branch vendor-aware corretti. Lavorare in `a` non ha alcun effetto su `b` né sulla root principale.
2. **Agente pronto in un comando.** `cd "$(jic worktree path a)"` porta l'agente in un ambiente dove `jic status`, `jic build`, `jic git status` funzionano come nella root, con stato isolato.
3. **Sessione in worktree.** `jic session start feat --worktree` crea worktree + sessione coerente (vendor ereditato, branch corretti); `jic session end feat --merge` mergia e, su conferma, rimuove il worktree senza lasciare residui (`git worktree list` pulito, branch gestiti).
4. **Cleanup pulito.** `jic worktree remove a` rimuove worktree del root e dei submodule, esegue prune, e `git worktree list` non mostra più entry orfane. Con modifiche pendenti, blocca senza `--force`.
5. **Coerenza vendor.** Il vendor attivo nella root è quello attivo nel worktree appena creato.
6. **Guardrail versione git.** Su una versione git non supportata, i comandi worktree falliscono con messaggio chiaro invece di lasciare uno stato a metà.
