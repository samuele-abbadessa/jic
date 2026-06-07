# jic module exec — esecuzione comandi sui moduli

**Status:** approvata (brainstorming)
**Data:** 2026-06-07
**Dimensione:** M

---

## 1. Problem / Context

Oggi per lanciare un comando su un modulo registrato bisogna fare `cd` nella sua directory e digitare il comando a mano, ripetendolo per ogni modulo. Operazioni ricorrenti (installare dipendenze, lanciare uno script di build/test del singolo modulo, un comando ad-hoc) non hanno una scorciatoia unificata in `jic`.

Inoltre molti comandi ricorrenti **cambiano in base al tipo di modulo** (`npm install` per node, `mvn ...` per java) ma concettualmente sono la stessa operazione ("installa le dipendenze"). Manca un meccanismo di **alias** che permetta di dire "esegui `install-deps` su questi moduli" lasciando che ogni modulo sappia cosa significa per sé.

### Cosa esiste già

- **`jic git foreach <command>`** (`src-ts/commands/git.ts:1086`): itera sui moduli ed esegue un comando con output per modulo. È però semanticamente legato al dominio git (risoluzione moduli session-aware orientata a git, naming `foreach`) e non gestisce alias.
- **`execInModules(modules, command, {parallel})`** (`src-ts/core/utils/shell.ts:230`): helper già pronto per eseguire un comando su più moduli in sequenza o in parallelo. Sarà il motore del nuovo comando.
- **`jic module discovery`** + **`module-detector.ts`**: già rilevano il tipo di modulo e leggono `package.json`. Aggancio naturale per generare alias di default.

Il nuovo comando colma il gap di un **runner di comandi generico, alias-aware**, complementare a `git foreach`.

---

## 2. Approach

Nuovo subcomando:

```bash
jic module exec <comando|@alias> [modules...] [--parallel]
```

- **1° argomento posizionale** = il comando da eseguire:
  - stringa libera → eseguita as-is in ogni modulo target (es. `jic module exec "npm ci" gwc`)
  - `@alias` (prefisso `@`) → risolto in un comando concreto per ciascun modulo
- **argomenti successivi** = moduli/gruppi target (stessa risoluzione di sempre: nome, alias modulo, gruppo `@backend`, glob)

### Disambiguazione posizionale del prefisso `@`

Il prefisso `@` è ambiguo: identifica sia gli **alias di comando** sia i **gruppi di moduli**. La disambiguazione è **posizionale**:

- `@` nel **1° argomento** → alias di comando
- `@` negli **argomenti successivi** → gruppo di moduli

Esempio: `jic module exec @install-deps @backend` → esegue l'alias `install-deps` sul gruppo `@backend`.

### Risoluzione `@alias`

Per ogni modulo target, l'alias viene cercato in quest'ordine:

1. `ModuleConfig.commands[alias]` del modulo (per-modulo, ha priorità)
2. `JicConfig.commands[alias]` (globale, fallback)

Se non trovato in nessuno dei due → il modulo viene **saltato con warning** (vedi §4), gli altri proseguono.

Questo permette: stesso alias `install-deps` → `npm install` su un node e (se mai definito globalmente o per-modulo) un comando diverso su un altro tipo.

### Motore di esecuzione

Riuso di `execInModules`. Nessun refactor di `git foreach` (restano comandi separati e indipendenti).

---

## 3. Config & Data model

### Per-modulo

Nuovo campo opzionale in `ModuleConfig` (`src-ts/core/types/config.ts:225`):

```typescript
/** Command aliases for `jic module exec @alias` (alias -> shell command) */
commands?: Record<string, string>;
```

### Globale (fallback)

Nuovo campo opzionale in `JicConfig` (`src-ts/core/types/config.ts:530`):

```typescript
/** Global command aliases, fallback for `jic module exec @alias` */
commands?: Record<string, string>;
```

### Persistenza e merge

- **`commands` per-modulo**: già preservato automaticamente in fase di `saveConfig` perché i moduli vengono serializzati da `module.originalConfig` (`loader.ts:462`). **Nessuna modifica necessaria** per persisterlo.
- **`commands` globale**: va aggiunto alla whitelist `cleanConfig` dentro `saveConfig` (`loader.ts:446`, lo stesso object literal dove è stato aggiunto `worktree`) perché non venga perso al salvataggio.
- **Nessuno schema zod da estendere**: `jic.config.json` / `ModuleConfig` / `JicConfig` **non hanno** validazione zod (esiste solo per i vendor in `vendor-schema.ts`). Quindi non c'è schema da aggiornare.
- Nessun merge speciale richiesto oltre alla normale catena di config: `commands` per-modulo è un campo del modulo come gli altri.

Esempio `jic.config.json`:

```json
{
  "commands": {
    "clean-install": "rm -rf node_modules && npm ci"
  },
  "modules": {
    "gwc": {
      "type": "frontend",
      "directory": "joyincloud-gw-client",
      "commands": {
        "install-deps": "npm install",
        "build": "npm run build",
        "test": "npm run test"
      }
    }
  }
}
```

---

## 4. Command behavior

### Sintassi e flag

```bash
jic module exec <comando|@alias> [modules...] [--parallel]
```

| Flag | Effetto |
|------|---------|
| `--parallel` | Esegue in parallelo sui moduli (via `execInModules(..., {parallel:true})`). Default: sequenziale. |

La strategia di fallimento è **continue-on-error** (default e unico comportamento in questa iterazione): un fallimento su un modulo non interrompe gli altri. Eventuale `--fail-fast` è rimandato a backlog.

### Risoluzione moduli target

- Se `[modules...]` è **fornito** → risolto con `resolveModules` (nomi, alias, gruppi, glob).
- Se `[modules...]` è **omesso**:
  - se c'è una **sessione attiva** → usa i moduli della sessione
  - altrimenti → **errore** (`ValidationError`/`ConfigError`) che chiede di specificare i moduli. Non si esegue mai implicitamente su `@all` (evita comandi accidentali su tutto).

### Alias mancante su un modulo

Quando il 1° argomento è un `@alias` e un modulo target non lo definisce (né per-modulo né globale):

- il modulo viene **saltato**
- viene stampato un **warning** (`ctx.output.warn`) con nome modulo e alias
- l'esecuzione prosegue sugli altri
- il modulo skippato conta come "skipped" nel riepilogo (non come fallito)

Con comando a stringa libera questo caso non esiste (il comando è uguale per tutti).

### Output

- Header per modulo (`ctx.output.subheader(module.name)`) con il comando effettivo eseguito.
- stdout/stderr del comando mostrati per modulo.
- **Riepilogo finale**: `N ok, M falliti, K saltati`.
- **Exit code**: non-zero se almeno un modulo è fallito (gli skip per alias mancante non contano come fallimento). Usa `ExitCodes` esistenti.

---

## 5. Discovery default aliases

Durante `jic module discovery`, alla creazione/aggiornamento di un modulo vengono generati alias di default in base al tipo.

### Tipi coperti (questa iterazione)

| Tipo | Alias di default |
|------|------------------|
| `node-service`, `frontend` | `install-deps` → `npm install`; più un alias per ogni voce di `package.json` → `scripts` (chiave `<nome-script>` → `npm run <nome-script>`) |
| `java-service`, `flux-client`, `dotnet-service`, `lambda-*` | nessun default (rimandati a backlog) |

Esempio: un `package.json` con `scripts: { build, test, lint }` genera:

```json
"commands": {
  "install-deps": "npm install",
  "build": "npm run build",
  "test": "npm run test",
  "lint": "npm run lint"
}
```

### Comportamento su re-discovery

- Gli alias di default **non sovrascrivono** alias già presenti in `ModuleConfig.commands` (preservano modifiche manuali dell'utente e personalizzazioni).
- Vengono **aggiunti solo gli alias mancanti** (merge non distruttivo: chiavi nuove sì, chiavi esistenti invariate).
- Un modulo node già esistente, ri-scansionato, acquisisce nuovi script aggiunti al `package.json` nel frattempo senza perdere quelli editati a mano.

### Note implementative

- L'estrazione degli script avviene leggendo `package.json` nella directory del modulo. Nota: il detector legge già `package.json` per distinguere frontend/node, ma solo `dependencies`/`devDependencies` — la lettura di `scripts` è lavoro nuovo.
- Se `package.json` non ha `scripts`, viene generato solo `install-deps`.

---

## 6. Impact

| Area | File | Modifica |
|------|------|----------|
| Tipi | `src-ts/core/types/config.ts` | `commands?` su `ModuleConfig` e su `JicConfig` |
| Persistenza | `src-ts/core/config/loader.ts` (`saveConfig`, literal `cleanConfig` ~riga 446) | aggiungere **solo** `commands` globale al literal; il per-modulo è già persistito via `originalConfig` |
| Comando | `src-ts/commands/module.ts` | nuovo subcomando `exec` |
| Discovery | `src-ts/commands/module.ts` + `src-ts/core/utils/module-detector.ts` | generazione alias di default + estrazione script package.json |
| Motore | `src-ts/core/utils/shell.ts` (`execInModules`) | riuso, nessuna modifica salvo necessità |
| Docs | `CLAUDE.md` (jic-cli), README, tabella comandi | documentare `module exec` e gli alias |

**Fuori scope:** refactor di `git foreach`, default per java/dotnet, `--fail-fast`, fallback globale avanzato (resta semplice key lookup).

---

## 7. Risks & open questions

- **Sicurezza/shell injection:** i comandi sono definiti dall'utente nella sua config o passati a mano → rischio accettato (è un tool da sviluppatore, come `git foreach`). Eseguire via shell coerentemente con `execInModules`.
- **Collisione alias vs nome modulo:** non si verifica grazie alla disambiguazione posizionale (1° arg = comando, resto = moduli).
- **package.json malformato durante discovery:** gestire con try/catch → in caso di errore, generare solo `install-deps` (o nessun alias) senza far fallire il discovery.
- **Open:** in futuro valutare un `jic module exec --list` per elencare gli alias disponibili per i moduli target (candidato backlog).

---

## 8. Success criteria

1. `jic module exec "echo hi" gwc` esegue `echo hi` nella directory di `gwc` e mostra l'output.
2. `jic module exec @build gwc tms` esegue, per ciascun modulo, il comando mappato dal suo alias `build`; un modulo senza l'alias viene saltato con warning, gli altri proseguono.
3. `@alias` non definito per-modulo ma definito globalmente in `JicConfig.commands` → usa il fallback globale.
4. `--parallel` esegue sui moduli in parallelo; senza il flag è sequenziale.
5. Senza `[modules...]`: con sessione attiva usa i moduli di sessione, senza sessione restituisce errore esplicativo.
6. Il riepilogo finale riporta `N ok / M falliti / K saltati` e l'exit code è non-zero se almeno un modulo è fallito.
7. `jic module discovery` su un progetto node popola `commands` con `install-deps` + gli script di `package.json`; un secondo discovery non sovrascrive alias già presenti e aggiunge solo i mancanti.
8. I campi `commands` (per-modulo e globale) sopravvivono a un ciclo di `saveConfig` (non vengono persi).
