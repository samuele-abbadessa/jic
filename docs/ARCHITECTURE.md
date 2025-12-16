# JIC CLI Architecture

This document describes the architecture of JIC CLI v2.0, a TypeScript rewrite focused on maintainability, type safety, and extensibility.

## Overview

JIC CLI is a command-line tool for managing multi-module microservices projects. It provides unified commands for building, deploying, and managing git operations across multiple submodules.

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Entry Point                          │
│                          (index.ts)                              │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Commander.js Program                        │
│                          (cli.ts)                                │
│                   Global Options & Commands                      │
└─────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
         ┌──────────┐    ┌──────────┐    ┌──────────┐
         │  build   │    │   git    │    │  status  │
         │ Command  │    │ Command  │    │ Command  │
         └──────────┘    └──────────┘    └──────────┘
                │               │               │
                └───────────────┼───────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Execution Context                            │
│              (Configuration + State + Utilities)                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
         ┌──────────┐    ┌──────────┐    ┌──────────┐
         │  Config  │    │   State  │    │  Output  │
         │  Loader  │    │  Manager │    │  Utils   │
         └──────────┘    └──────────┘    └──────────┘
```

## Directory Structure

```
src-ts/
├── index.ts                 # Entry point
├── cli.ts                   # Commander.js setup
│
├── core/                    # Core functionality
│   ├── types/               # TypeScript interfaces
│   │   ├── config.ts        # Configuration types
│   │   ├── module.ts        # Module types
│   │   ├── execution.ts     # Execution types
│   │   └── state.ts         # State types
│   │
│   ├── config/              # Configuration loading
│   │   ├── loader.ts        # Config loading & resolution
│   │   ├── defaults.ts      # Built-in defaults per module type
│   │   └── merger.ts        # Deep merge utilities
│   │
│   ├── context/             # Execution context
│   │   └── ExecutionContext.ts
│   │
│   ├── errors/              # Error handling
│   │   └── index.ts         # Error classes & handlers
│   │
│   └── utils/               # Utilities
│       ├── output.ts        # Console output, spinners, tables
│       └── shell.ts         # Command execution, git utilities
│
├── pipeline/                # Pipeline system
│   ├── Phase.ts             # Phase interface & base class
│   ├── Pipeline.ts          # Pipeline orchestration
│   └── phases/              # Concrete phases
│       └── BuildPhase.ts    # Build, Docker, Clean phases
│
└── commands/                # Command implementations
    ├── build.ts             # Build command
    └── git.ts               # Git command
```

## Core Concepts

### 1. Execution Context

The `ExecutionContext` is the central object passed to all commands. It provides:

- **Configuration**: Loaded and resolved config with inheritance applied
- **State**: Persistent state (sessions, deployments)
- **Module Resolution**: Resolve names, aliases, or groups to modules
- **Output**: Formatted console output
- **Options**: Global CLI options (dry-run, verbose, etc.)

```typescript
interface IExecutionContext {
  // Configuration
  readonly config: LoadedConfig;
  readonly projectRoot: string;

  // Environment & Options
  readonly env: Environment;
  readonly dryRun: boolean;
  readonly verbose: boolean;
  readonly failStrategy: FailStrategy;

  // Module resolution
  getModule(nameOrAlias: string): ResolvedModule | null;
  resolveModules(refs: string[]): ResolvedModule[];

  // Session
  readonly activeSession: Session | undefined;
  isSessionActive(): boolean;
  getSessionModules(): ResolvedModule[] | null;

  // Output
  readonly output: Output;
}
```

### 2. Configuration Inheritance

Configuration follows an inheritance chain to minimize verbosity:

```
Built-in Defaults → Config Defaults → Module Config → CLI Options
```

Each layer only needs to specify what differs from the previous layer. See [CONFIGURATION.md](./CONFIGURATION.md) for details.

### 3. Module Resolution

Modules can be referenced by:

- **Name**: `joyincloud-gw-server`
- **Alias**: `gws`, `gateway`
- **Group**: `@backend`, `@flux`
- **Type**: `--type java-service`

When no modules are specified and a session is active, commands automatically use session modules (auto-scoping).

### 4. Pipeline System

The pipeline system orchestrates multi-module operations:

```typescript
// Pipeline executes phases across modules
const pipeline = new Pipeline({
  phases: [new BuildPhase(), new DockerBuildPhase()],
  modules: resolvedModules,
  parallel: options.parallel,
  failStrategy: ctx.failStrategy,
});

const result = await pipeline.execute(ctx);
```

**Phases** are units of work that can run on modules:

```typescript
interface Phase {
  readonly name: string;
  readonly description: string;

  shouldRun(module: ResolvedModule, ctx: IExecutionContext): boolean;
  execute(module: ResolvedModule, ctx: IExecutionContext, options: PhaseOptions): Promise<PhaseResult>;
}
```

**Pipeline Features**:
- Sequential or parallel execution
- Fail-fast or continue-on-error strategies
- Progress tracking and reporting
- Result aggregation with summaries

### 5. Command Pattern

All commands follow a unified pattern:

```
jic <command> [modules...] [options]
```

Commands are registered with a context factory function:

```typescript
export function registerBuildCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  program
    .command('build')
    .argument('[modules...]', 'Modules to build')
    .option('--docker', 'Build Docker images')
    .action(async (moduleRefs, options) => {
      const ctx = await createContext();
      // Execute command using ctx
    });
}
```

## Error Handling

Errors follow a hierarchy with specific exit codes:

```typescript
JicError (base)
├── ConfigError     // Configuration issues
├── BuildError      // Build failures
├── DeployError     // Deployment failures
├── GitError        // Git operation failures
├── ServeError      // Service startup failures
├── SessionError    // Session management errors
├── AwsError        // AWS operation failures
└── ValidationError // Input validation errors
```

The `withErrorHandling` wrapper provides consistent error handling:

```typescript
program.action(withErrorHandling(async () => {
  // Command logic - errors are caught and formatted
}));
```

## State Management

State is persisted in `jic.state.json`:

```typescript
interface JicState {
  activeSession?: string;
  sessions: Record<string, Session>;
  deployments: {
    dev: Record<string, DeploymentRecord>;
    staging: Record<string, DeploymentRecord>;
    prod: Record<string, DeploymentRecord>;
  };
  processes: Record<string, ProcessState>;
}
```

State is loaded with config and saved via `ctx.saveState()`.

## Output System

The `Output` class provides consistent formatting:

```typescript
ctx.output.header('Build');           // === Build ===
ctx.output.subheader('Phase 1');      // --- Phase 1 ---
ctx.output.keyValue('Modules', '3');  // Modules: 3
ctx.output.success('Done');           // ✔ Done
ctx.output.error('Failed');           // Error message
ctx.output.warning('Skipped');        // ⚠ Skipped
ctx.output.info('Note');              // ℹ Note
ctx.output.table(data, { head: [...] });
ctx.output.spinner('Loading...');
```

Output respects global options:
- `--quiet`: Minimal output
- `--json`: JSON output for scripting
- `--no-color`: Disable colors

## Shell Execution

Shell utilities wrap `execa` with common patterns:

```typescript
// Basic execution
await exec('git status', { cwd: '/path', silent: true });

// Execute in module directory
await execInModule(module, 'mvn clean install');

// Execute with spinner
await execWithSpinner('Building...', 'npm run build', { cwd: '/path' });

// Git utilities
const branch = await getGitBranch('/path');
const status = await getGitStatus('/path');
const commit = await getGitCommit('/path');
```

## Type Safety

The codebase uses TypeScript with strict mode for maximum type safety:

- All interfaces are explicitly defined
- No implicit `any` types
- Strict null checks
- Exhaustive pattern matching where applicable

Key type files:
- `types/config.ts`: Configuration schema
- `types/module.ts`: Resolved module structure
- `types/execution.ts`: Pipeline and process types
- `types/state.ts`: Persistent state structure

## Extension Points

### Adding a New Command

1. Create `commands/mycommand.ts`
2. Implement `registerMyCommand(program, createContext)`
3. Add to `commands/index.ts`
4. Register in `index.ts`

### Adding a New Phase

1. Create class extending `BasePhase`
2. Implement `shouldRun()` and `execute()`
3. Add to pipeline configuration

### Adding a New Module Type

1. Add type to `ModuleType` union in `types/config.ts`
2. Add defaults in `config/defaults.ts`
3. Update any type-specific logic in phases

## Testing

Tests use Vitest with the following structure:

```
tests/
├── unit/           # Unit tests for individual modules
├── integration/    # Integration tests for commands
└── fixtures/       # Test configuration files
```

Run tests:
```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```
