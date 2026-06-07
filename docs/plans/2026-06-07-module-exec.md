# jic module exec

**Goal:** Aggiungere il comando `jic module exec <comando|@alias> [modules...]` per eseguire comandi shell sui moduli registrati, con alias per-modulo/globali e generazione automatica di alias di default durante il discovery.

**Architecture:** Nuovo subcomando in `commands/module.ts` che riusa `execInModules` (shell.ts) come motore. Gli alias vivono in `ModuleConfig.commands` (per-modulo) e `JicConfig.commands` (globale, fallback). Il discovery popola alias di default per moduli node/frontend leggendo gli `scripts` del `package.json`, con merge non distruttivo.

**Primary scope:** comando `module exec` alias-aware.

**Secondary scopes:** alias di default da discovery; documentazione.

**Size:** M

**Branch target:** `master` (l'esecutore crea un feature branch, es. `feature/module-exec`)

**Spec:** [`docs/specs/2026-06-07-module-exec.md`](../specs/2026-06-07-module-exec.md)

---

## Chunk 1: Tipi + persistenza config

**Submodule:** `cli`
**Size:** S
**Depends on:** nessuno
**Spec refs:** §3 Config & Data model

Aggiunge il campo `commands?: Record<string,string>` a `ModuleConfig` e a `JicConfig`, e garantisce che il `commands` globale sopravviva al salvataggio della config aggiungendolo al literal `cleanConfig` di `saveConfig`. Il `commands` per-modulo è già persistito automaticamente via `originalConfig`, quindi non richiede modifiche al save.

### Task 1.1: Aggiungi `commands` a ModuleConfig

**Files:**
- Modify: `src-ts/core/types/config.ts` (interfaccia `ModuleConfig`, ~riga 225-260)

**Steps:**

1. In `ModuleConfig`, dopo il campo `aliases?: string[];` (riga ~231), aggiungi il nuovo campo:
   ```ts
   /** Short names for this module */
   aliases?: string[];
   /** Command aliases for `jic module exec @alias` (alias -> shell command) */
   commands?: Record<string, string>;
   ```

**Expected outcome:** `ModuleConfig.commands` disponibile come campo opzionale.

### Task 1.2: Aggiungi `commands` globale a JicConfig

**Files:**
- Modify: `src-ts/core/types/config.ts` (interfaccia `JicConfig`, ~riga 530-568)

**Steps:**

1. In `JicConfig`, dopo il campo `worktree?: WorktreeConfig;` (riga ~567, ultimo campo prima della `}` di chiusura), aggiungi:
   ```ts
   /** Worktree configuration */
   worktree?: WorktreeConfig;
   /** Global command aliases, fallback for `jic module exec @alias` */
   commands?: Record<string, string>;
   ```

**Expected outcome:** `JicConfig.commands` disponibile come campo opzionale globale.

### Task 1.3: Persisti `commands` globale nel save

**Files:**
- Modify: `src-ts/core/config/loader.ts` (funzione `saveConfig`, literal `cleanConfig`, ~riga 446-458)

**Steps:**

1. Nel literal `cleanConfig` dentro `saveConfig`, aggiungi `commands: config.commands,` dopo `worktree: config.worktree,`:
   ```ts
   const cleanConfig: JicConfig = {
     $schema: config.$schema,
     version: config.version,
     project: config.project,
     defaults: config.defaults,
     modules: {},
     groups: config.groups,
     buildOrder: config.buildOrder,
     aws: config.aws,
     docker: config.docker,
     serve: config.serve,
     worktree: config.worktree,
     commands: config.commands,
   };
   ```
   Nota: il `commands` per-modulo NON va toccato qui — è già serializzato dal loop che usa `module.originalConfig`.

**Expected outcome:** un `commands` globale presente in `jic.config.json` sopravvive a un ciclo di `saveConfig`.

### Task 1.4: Verifica build e typecheck

**Steps:**

1. Run: `npm run typecheck`
   Expected: nessun nuovo errore relativo a `config.ts`/`loader.ts` (ignorare errori pre-esistenti noti: `clean.ts:17`, `deploy.ts:1456`, `defaults.ts:14`).

**Expected outcome:** i tipi compilano. Commit del chunk.

---

## Chunk 2: Comando `module exec`

**Submodule:** `cli`
**Size:** M
**Depends on:** [1]
**Spec refs:** §2 Approach, §4 Command behavior

Implementa il subcomando `jic module exec <comando|@alias> [modules...] [--parallel]` in `commands/module.ts`. Risolve il comando (stringa libera o `@alias` con lookup per-modulo→globale), determina i moduli target (session-aware con errore se assenti), esegue via `execInModules`, e stampa output per modulo + riepilogo finale con exit code.

### Task 2.1: Registra il subcomando `exec`

**Files:**
- Modify: `src-ts/commands/module.ts` (dentro `registerModuleCommand`, dopo il blocco `.command('config ...')`, ~riga 82)

**Steps:**

1. Dopo il blocco `mod.command('config <module> <action> <key> [value]')...`, aggiungi la registrazione del nuovo subcomando:
   ```ts
   mod
     .command('exec <command> [modules...]')
     .description('Execute a shell command (or @alias) on the given modules')
     .option('--parallel', 'Run the command on modules in parallel', false)
     .action(
       withErrorHandling(
         async (command: string, moduleRefs: string[], options: { parallel?: boolean }) => {
           const ctx = await createContext();
           await moduleExec(ctx, command, moduleRefs, options);
         }
       )
     );
   ```

**Expected outcome:** `jic module exec --help` mostra il comando con l'opzione `--parallel`.

### Task 2.2: Implementa la funzione `moduleExec`

**Files:**
- Modify: `src-ts/commands/module.ts` (aggiungi la funzione a livello di modulo, accanto a `moduleConfigSet`/`moduleDiscovery`)
- Modify: `src-ts/commands/module.ts` (import in testa al file)

**Steps:**

1. Aggiungi gli import necessari in testa al file. Il file importa già `ConfigError`, `withErrorHandling` da `../core/errors/index.js`, `saveConfig`, `detectModuleType`. Aggiungi:
   ```ts
   import { execInModules } from '../core/utils/shell.js';
   import type { ResolvedModule } from '../core/types/module.js';
   ```

2. Aggiungi la funzione `moduleExec` a livello di modulo (dopo `moduleConfigSet`):
   ```ts
   /**
    * Resolve the shell command to run for a given module.
    * - If `command` does not start with '@', it is returned as-is (free string).
    * - If it starts with '@', the alias is looked up in module.commands first,
    *   then in the global config.commands. Returns null if not found anywhere.
    */
   function resolveModuleCommand(
     ctx: IExecutionContext,
     module: ResolvedModule,
     command: string
   ): string | null {
     if (!command.startsWith('@')) {
       return command;
     }
     const alias = command.slice(1);
     const perModule = module.originalConfig.commands?.[alias];
     if (perModule !== undefined) return perModule;
     const global = ctx.config.commands?.[alias];
     if (global !== undefined) return global;
     return null;
   }

   /**
    * Determine target modules:
    * - If refs are provided, resolve them normally.
    * - If no refs: use active session modules; error if no active session.
    */
   function resolveExecModules(
     ctx: IExecutionContext,
     moduleRefs: string[]
   ): ResolvedModule[] {
     if (moduleRefs.length > 0) {
       return ctx.resolveModules(moduleRefs);
     }
     const sessionModules = ctx.getSessionModules();
     if (!sessionModules || sessionModules.length === 0) {
       throw new ConfigError(
         'No modules specified and no active session. Specify modules: jic module exec <command> <modules...>'
       );
     }
     return sessionModules;
   }

   async function moduleExec(
     ctx: IExecutionContext,
     command: string,
     moduleRefs: string[],
     options: { parallel?: boolean }
   ): Promise<void> {
     const modules = resolveExecModules(ctx, moduleRefs);

     // Partition modules: those with a resolvable command vs skipped (alias missing)
     const runnable: Array<{ module: ResolvedModule; cmd: string }> = [];
     const skipped: ResolvedModule[] = [];
     for (const module of modules) {
       const cmd = resolveModuleCommand(ctx, module, command);
       if (cmd === null) {
         skipped.push(module);
       } else {
         runnable.push({ module, cmd });
       }
     }

     for (const module of skipped) {
       ctx.output.warn(
         `${module.name}: alias "${command}" not defined (skipped)`
       );
     }

     // Execute. execInModules takes a single command string, so when aliases
     // resolve to different commands per module we run them grouped by command.
     const results = new Map<string, { success: boolean }>();

     if (runnable.length > 0) {
       // Group runnable modules by resolved command to leverage execInModules.
       const byCommand = new Map<string, ResolvedModule[]>();
       for (const { module, cmd } of runnable) {
         const list = byCommand.get(cmd) ?? [];
         list.push(module);
         byCommand.set(cmd, list);
       }

       for (const [cmd, mods] of byCommand) {
         for (const m of mods) {
           ctx.output.subheader(`${m.name} $ ${cmd}`);
         }
         const execResults = await execInModules(mods, cmd, {
           parallel: options.parallel,
           silent: true,
         });
         for (const [name, res] of execResults) {
           if (res.stdout?.trim()) console.log(res.stdout);
           if (res.stderr?.trim()) console.error(res.stderr);
           results.set(name, { success: res.success });
         }
       }
     }

     // Summary
     const ok = Array.from(results.values()).filter((r) => r.success).length;
     const failed = Array.from(results.values()).filter((r) => !r.success).length;
     const skippedCount = skipped.length;
     ctx.output.info(
       `Done: ${ok} ok, ${failed} failed, ${skippedCount} skipped`
     );

     if (failed > 0) {
       process.exitCode = 1;
     }
   }
   ```
   Note implementative:
   - `ctx.output.subheader` stampa l'header per modulo con il comando effettivo.
   - **`silent: true` è obbligatorio**: senza, `execInModules` eredita lo stdio (`inherit`) e `res.stdout/res.stderr` restano stringa vuota (l'output finirebbe a video ma non catturato, e in `--parallel` si interlaccerebbe illeggibilmente). Con `silent: true` l'output viene catturato e stampato ordinatamente sotto l'header di ciascun modulo via i `console.log(res.stdout)`/`console.error(res.stderr)`.
   - Il raggruppamento per comando serve perché `execInModules` accetta UNA stringa comando: moduli con lo stesso comando risolto vengono eseguiti insieme (e in parallelo se `--parallel`), comandi diversi in gruppi diversi.
   - Gli skip per alias mancante NON contano come fallimento (exit code 0 se non ci sono failed).

**Expected outcome:** la funzione compila e implementa tutto il behavior della §4.

### Task 2.3: Verifica tipi ed esecuzione manuale

**Files:**
- Read: `src-ts/core/context/ExecutionContext.ts` (solo se serve verificare la firma di `getSessionModules`/`resolveModules`)

**Steps:**

1. Run: `npm run typecheck`
   Expected: nessun nuovo errore (ignorare i pre-esistenti noti).
2. Run: `npm run build`
   Expected: build OK.
3. Verifica manuale rapida (facoltativa se l'ambiente lo consente):
   Run: `node dist/index.js module exec "echo ciao" <un-modulo-reale>`
   Expected: stampa header modulo, `ciao`, e riepilogo `1 ok, 0 failed, 0 skipped`.

**Expected outcome:** comando funzionante. Commit del chunk.

---

## Chunk 3: Discovery alias di default

**Submodule:** `cli`
**Size:** M
**Depends on:** [1]
**Spec refs:** §5 Discovery default aliases

Aggiunge un helper in `module-detector.ts` che estrae gli `scripts` dal `package.json`, e integra la generazione di alias di default nel flusso `moduleDiscovery`. Per moduli `node-service`/`frontend` genera `install-deps` → `npm install` più un alias per ogni script. Il merge è non distruttivo: su re-discovery non sovrascrive alias già presenti.

### Task 3.1: Helper di estrazione scripts dal package.json

**Files:**
- Modify: `src-ts/core/utils/module-detector.ts`

**Steps:**

1. In testa al file è già importato `readFile` da `node:fs/promises` e `join` da `node:path` (usati da `detectNodeType`). Aggiungi una funzione esportata che legge gli `scripts`:
   ```ts
   /**
    * Read npm scripts from a module's package.json.
    * Returns an empty object if the file is missing, malformed, or has no scripts.
    */
   export async function extractNpmScripts(
     dirPath: string
   ): Promise<Record<string, string>> {
     const pkgPath = join(dirPath, 'package.json');
     try {
       const content = await readFile(pkgPath, 'utf-8');
       const pkg = JSON.parse(content) as { scripts?: Record<string, string> };
       return pkg.scripts ?? {};
     } catch {
       return {};
     }
   }
   ```
   Verifica che `readFile` e `join` siano già importati in testa al file (lo sono, usati da `detectNodeType`); se per qualche motivo non lo fossero, aggiungili.

**Expected outcome:** `extractNpmScripts` esportata e robusta a package.json mancante/malformato.

### Task 3.2: Genera gli alias di default durante il discovery

**Files:**
- Modify: `src-ts/commands/module.ts` (funzione `moduleDiscovery`, punto in cui costruisce `moduleConfig`, ~riga 149-164)
- Modify: `src-ts/commands/module.ts` (import in testa)

**Steps:**

1. Aggiungi l'import dell'helper accanto a `detectModuleType`:
   ```ts
   import { detectModuleType, extractNpmScripts } from '../core/utils/module-detector.js';
   ```

2. Aggiungi una funzione helper a livello di modulo (vicino alle altre helper di module.ts) che costruisce gli alias di default per tipo:
   ```ts
   /**
    * Build default command aliases for a freshly discovered module.
    * - node-service / frontend: `install-deps` + one alias per package.json script.
    * - other types: no defaults (for now).
    */
   async function buildDefaultCommands(
     type: ModuleType,
     absolutePath: string
   ): Promise<Record<string, string>> {
     if (type !== 'node-service' && type !== 'frontend') {
       return {};
     }
     const commands: Record<string, string> = { 'install-deps': 'npm install' };
     const scripts = await extractNpmScripts(absolutePath);
     for (const scriptName of Object.keys(scripts)) {
       commands[scriptName] = `npm run ${scriptName}`;
     }
     return commands;
   }

   /**
    * Merge default commands into an existing commands map without overwriting
    * aliases the user already defined. Returns the merged map (or undefined if empty).
    */
   function mergeDefaultCommands(
     existing: Record<string, string> | undefined,
     defaults: Record<string, string>
   ): Record<string, string> | undefined {
     const merged: Record<string, string> = { ...defaults, ...(existing ?? {}) };
     return Object.keys(merged).length > 0 ? merged : undefined;
   }
   ```
   Nota sul merge: `{ ...defaults, ...existing }` fa sì che le chiavi già presenti in `existing` (modifiche manuali) abbiano priorità e non vengano sovrascritte, mentre le chiavi di default mancanti vengono aggiunte.

3. Nel punto in cui `moduleDiscovery` costruisce `moduleConfig` (riga ~153-156), genera e assegna i comandi di default. Sostituisci:
   ```ts
   // Add to config
   const moduleConfig: ModuleConfig = {
     type,
     directory: moduleDirectory,
   };
   ```
   con:
   ```ts
   // Add to config
   const existing = ctx.config.modules[entry.name];
   const defaultCommands = await buildDefaultCommands(type, absoluteModulePath);
   const moduleConfig: ModuleConfig = {
     type,
     directory: moduleDirectory,
     commands: mergeDefaultCommands(existing?.commands, defaultCommands),
   };
   ```
   Questo gestisce sia il primo discovery (existing undefined → solo default) sia il re-discovery (merge non distruttivo con gli alias già presenti). Se `mergeDefaultCommands` ritorna `undefined` (tipo non-node senza alias) il campo resta `undefined` e non sporca la config.

**Expected outcome:** un discovery su un modulo node/frontend popola `commands` con `install-deps` + gli script; un secondo discovery non sovrascrive alias editati a mano e aggiunge solo i mancanti; i moduli java/dotnet non ricevono `commands`.

### Task 3.3: Verifica tipi e build

**Steps:**

1. Run: `npm run typecheck`
   Expected: nessun nuovo errore (ignorare i pre-esistenti noti).
2. Run: `npm run build`
   Expected: build OK.

**Expected outcome:** discovery con alias di default funzionante. Commit del chunk.

---

## Chunk 4: Chiusura — docs + memoria + BACKLOG

**Submodule:** `docs`
**Size:** S
**Depends on:** [1, 2, 3]
**Spec refs:** nessuno (meta-chunk)

Aggiornamento documentazione, memoria e BACKLOG post-implementazione.

### Task 4.1: Aggiorna documentazione progetto

**Files:**
- Modify: `CLAUDE.md` (jic-cli, sezione "Module Commands")
- Modify: `README.md` (jic-cli, dove sono elencati i comandi module — verificare la sezione esistente)

**Steps:**

1. In `CLAUDE.md`, nella tabella "Module Commands", aggiungi le righe per il nuovo comando:
   ```markdown
   | `jic module exec <command|@alias> [modules...]` | Execute a shell command or alias on the given modules |
   ```
   E aggiungi un breve paragrafo sotto la tabella che spiega:
   - `@alias` risolto per-modulo (`ModuleConfig.commands`) poi globale (`JicConfig.commands`);
   - alias mancante su un modulo → skip con warning;
   - target di default = moduli della sessione attiva, errore se nessuna sessione;
   - `--parallel` per esecuzione parallela;
   - il discovery genera alias di default per moduli node/frontend (`install-deps` + script del `package.json`), merge non distruttivo su re-discovery.

2. In `README.md`, individua la sezione che documenta i comandi `jic module` (se presente) e aggiungi `module exec` con un esempio:
   ```bash
   jic module exec "npm ci" gwc tms
   jic module exec @build @backend --parallel
   ```
   Se il README non ha una sezione module dedicata, aggiungi `module exec` nell'elenco comandi più pertinente, coerentemente con lo stile esistente.

**Expected outcome:** docs allineate al nuovo comando.

### Task 4.2: Aggiorna memoria personale

**Steps:**

1. Nessun aggiornamento di memoria necessario: la feature è interamente documentata in CLAUDE.md e nel codice. (Se durante l'esecuzione emergono decisioni di processo non derivabili dal codice, valutarne il salvataggio, altrimenti skip.)

**Expected outcome:** nessuna azione, oppure memoria aggiornata se applicabile.

### Task 4.3: Aggiungi voci al BACKLOG

**Files:**
- Modify: `docs/BACKLOG.md`

**Steps:**

1. Leggi `docs/BACKLOG.md` per capire categorie esistenti, prossimo ID progressivo e stile delle voci.
2. Aggiungi le seguenti voci di follow-up (adattando ID e categoria a quelle esistenti — verosimilmente categoria "Tech Debt" per la prima, una nuova/esistente categoria per le altre):
   - **cleanConfig incompleto**: il literal `cleanConfig` in `saveConfig` (`loader.ts:446`) non include `kubernetes` né `templates` → questi campi vengono persi a ogni `saveConfig`. Verificare se è intenzionale; se no, aggiungerli. (Scoperto durante il piano module-exec, chunk 1.)
   - **Default aliases per java/dotnet**: estendere `buildDefaultCommands` (discovery) con alias di default per `java-service`/`flux-client` (es. `build` → `mvn -B package`) e `dotnet-service`. (Spec §5, fuori scope iterazione corrente.)
   - **`--fail-fast` per module exec**: aggiungere flag per interrompere l'esecuzione al primo modulo fallito (oggi solo continue-on-error). (Spec §4.)
   - **`jic module exec --list`**: elencare gli alias disponibili per i moduli target senza eseguire nulla. (Spec §7 open question.)

**Expected outcome:** voci BACKLOG aggiunte. Commit del chunk di chiusura.
