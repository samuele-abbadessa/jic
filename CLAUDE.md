# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JIC CLI is a TypeScript command-line tool for managing multi-module microservices projects. It provides unified commands for git operations, builds, deployments, and AWS/Kubernetes resource management across multiple submodules.

**Version**: 2.0.0-alpha.1 (TypeScript rewrite)

## Build & Development Commands

```bash
npm run dev              # Development with hot reload (tsx watch)
npm run build            # Production build (tsup)
npm run typecheck        # Type checking (tsc --noEmit)
npm run lint             # ESLint
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier formatting
npm test                 # Vitest in watch mode
npm run test:run         # Single test run
npm run test:coverage    # With coverage
npm link                 # Link globally as `jic` command
```

Run a single test file: `npx vitest run src-ts/path/to/file.test.ts`

## Architecture

### Entry Flow

`src-ts/index.ts` → creates Commander program (`cli.ts`) → registers all commands → each command receives a context factory that lazily creates `ExecutionContext`.

### Core Layers

- **ExecutionContext** (`core/context/ExecutionContext.ts`): Central object passed to all commands. Provides config, module resolution, state management, output helpers, AWS/K8s config. All commands receive an `IExecutionContext`.
- **Config Loader** (`core/config/loader.ts`): Loads `jic.config.json`, merges with `jic.local.json` overrides, loads `jic.state.json` runtime state. Discovers project root by walking up directories. Inheritance chain: Built-in defaults → Config defaults → Module config → Local overrides → Env vars.
- **Pipeline** (`pipeline/Pipeline.ts`): Orchestrates multi-module operations through phases. Handles sequential/parallel execution, fail-fast/continue strategies, progress tracking. Used by build command.
- **Output** (`core/utils/output.ts`): Formatted console output respecting `--quiet`, `--json`, `--verbose` flags. All user-visible output should go through `ctx.output`.

### Module Types

| Type | Description |
|------|-------------|
| `java-service` | Spring Boot services (Maven + Docker) |
| `flux-client` | WebClient libraries (Maven only) |
| `frontend` | Angular applications |
| `node-service` | Node.js services |
| `lambda-layer` | AWS Lambda layers |
| `lambda-functions` | AWS Lambda functions |

### Module Resolution

Modules can be referenced by name (`my-service`), alias (`ms`), group (`@backend`), or glob pattern (`svc-*`). Groups are defined in `jic.config.json`. Resolution logic is in `core/config/loader.ts` (`resolveModules`, `getModule`).

### Dependency System

`core/utils/dependencies.ts` provides DAG operations: `buildDependencyGraph()`, `topologicalSort()` (returns build levels), `detectCycles()`, `expandDependencies()`, `getDependants()`. Build flags: `--with-deps` (include dependencies), `--dependants` (include reverse deps), `--show-deps` (display tree without building), `--parallel` (parallelize within dependency levels, not across them).

### Adding a New Command

1. Create `src-ts/commands/mycommand.ts`:
```typescript
export function registerMyCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  program
    .command('mycommand')
    .argument('[modules...]', 'Modules to operate on')
    .action(async (moduleRefs, options) => {
      const ctx = await createContext();
      const modules = ctx.resolveModules(moduleRefs);
      // Implementation — use ctx.output for display
    });
}
```
2. Export from `src-ts/commands/index.ts`
3. Register in `src-ts/index.ts`

### Error Handling

Error hierarchy in `core/errors/index.ts`: `JicError` (exit 1) → `ConfigError` (2), `BuildError` (3), `DeployError` (4), `AwsError` (5), `GitError` (6), `ServeError` (7), `SessionError` (8), `ValidationError` (9), `KubernetesError` (10), `VendorError` (11). Use `withErrorHandling()` wrapper for consistent error handling.

### Dashboard

Terminal UI built with `blessed-contrib` in `src-ts/dashboard/`. Has its own layout system with presets (default, logs-focused, monitoring) and panel components (ServiceMonitor, LogViewer, InfraStatus, QuickActions).

### Vendor & Submodules Support

For projects with `project.type: "submodules"`, the CLI supports vendor-branch distribution. Vendor is a configuration layer injected between root config and local overrides via `ExecutionContext`.

**Config loading chain:** `jic.config.json → .jic/vendors/jic.config.<vendor>.json → jic.local.json`

**New files:**
- `core/types/vendor.ts` — `VendorConfig`, `VendorBranchConfig`, `LoadedVendorConfig` types
- `core/config/vendor-schema.ts` — Zod validation schema for vendor configs
- `core/config/vendor-loader.ts` — Load, list, save, generate vendor configs from `.jic/vendors/`
- `core/utils/submodule.ts` — Git submodule helpers (`gitInRoot`, `stageSubmodulePointers`, etc.)
- `commands/vendor.ts` — `jic vendor` command family

**Vendor config** (`.jic/vendors/jic.config.<vendor>.json`):
- `modules: string[]` — filter on root config modules, defines implicit `@<vendor>` group
- `branches: { master, dev, build }` — vendor-specific branch names
- `nonVendorBranch?: string` — branch for modules NOT in this vendor (default: `"master"`)
- `env?: Record<string, string>` — vendor-specific environment variables
- `aws?`, `kubernetes?` — deep-merge overrides

**Vendor commands** (for `project.type: "submodules"` only):

| Command | Description |
|---------|-------------|
| `jic vendor list` | List available vendors |
| `jic vendor status` | Show active vendor, modules, branches |
| `jic vendor create <name>` | Create vendor config + branches |
| `jic vendor checkout <name>` | Switch to a vendor context |
| `jic vendor add <module>` | Add module to active vendor |
| `jic vendor remove <module>` | Remove module from vendor |
| `jic vendor sync` | Merge master into vendor branches |

**Module resolution with vendor:**
- No refs → only vendor modules returned
- Group refs (`@backend`) → silently intersected with vendor modules
- Explicit module refs → `VendorError` if module is outside active vendor
- Implicit `@<vendor>` group created automatically (e.g., `@acme`)

**State:** `JicState.activeVendor` tracks the active vendor (default: `"root"`). `Session` has `vendor`, `rootBranch`, `rootBaseBranch` fields for vendor-aware sessions.

**Integration:** Sessions use vendor-prefixed branches (`<vendor>/feature/<name>`, base: `<vendor>/dev`). Git commands operate on root repo when `isSubmodules()`. `jic git commit --update-root` commits submodule pointers.

### Module Commands

| Command | Description |
|---------|-------------|
| `jic module discovery` | Scan subdirectories for git repos and add to config |
| `jic module config <module> get <key>` | Read a module config value (dot-path) |
| `jic module config <module> set <key> <value>` | Write a module config value |

Module types: `java-service`, `flux-client`, `frontend`, `node-service`, `lambda-layer`, `lambda-functions`, `dotnet-service`, `unknown`.

Detection logic in `core/utils/module-detector.ts`. Discovery only scans first-level subdirectories with `.git`.

## Key Technical Details

- ESM project (`"type": "module"` in package.json) — all imports use `.js` extensions
- TypeScript path alias: `@/*` maps to `src-ts/*`
- Strict TypeScript config: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `verbatimModuleSyntax`
- Build tool: `tsup` (bundles to `dist/`)
- Test framework: `vitest`
- Shell execution: `execa` library (`core/utils/shell.ts`)
- Config validation: `zod` schemas
- Some commands have subdirectory structure (e.g., `commands/build/`, `commands/deploy/`) for complex multi-file implementations

## Configuration Files

| File | Purpose | VCS |
|------|---------|-----|
| `jic.config.json` | Module definitions, groups, AWS/K8s config, defaults | tracked |
| `jic.local.json` | Local overrides (ports, paths) | git-ignored |
| `jic.state.json` | Runtime state (sessions, deployments) | git-ignored |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `JIC_CONFIG` | Path to config file |
| `JIC_ENV` | Default environment |
| `JIC_VERBOSE` | Enable verbose output |
| `JIC_DRY_RUN` | Enable dry-run mode |
| `JIC_NO_COLOR` | Disable colored output |
