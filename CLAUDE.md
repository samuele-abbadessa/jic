# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JIC CLI is a TypeScript command-line tool for managing multi-module microservices projects. It provides unified commands for git operations, builds, deployments, and AWS resource management across multiple submodules.

**Version**: 2.0.0-alpha.1 (TypeScript rewrite)

## Build & Development Commands

```bash
# Development with hot reload
npm run dev

# Build for production
npm run build

# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Testing
npm test              # Watch mode
npm run test:run      # Single run
npm run test:coverage # With coverage

# Format code
npm run format

# Link globally for testing
npm link
```

## Architecture

```
src-ts/
├── index.ts                 # Entry point, shell completion generators
├── cli.ts                   # Commander.js setup, global options
├── core/
│   ├── types/               # TypeScript interfaces
│   │   ├── config.ts        # Configuration schema (JicConfig, ModuleConfig)
│   │   ├── module.ts        # Resolved module types
│   │   ├── execution.ts     # Pipeline and process types
│   │   └── state.ts         # Persistent state (JicState)
│   ├── config/
│   │   ├── loader.ts        # Config loading, module resolution
│   │   ├── defaults.ts      # Built-in defaults per module type
│   │   └── merger.ts        # Deep merge utilities
│   ├── context/
│   │   └── ExecutionContext.ts  # Central context for all commands
│   ├── errors/
│   │   └── index.ts         # Error classes with exit codes
│   └── utils/
│       ├── output.ts        # Console output, spinners, tables
│       ├── shell.ts         # Command execution, git utilities
│       └── dependencies.ts  # Dependency graph, topological sort, cycle detection
├── pipeline/
│   ├── Phase.ts             # Phase interface
│   ├── Pipeline.ts          # Multi-module orchestration
│   └── phases/              # Build, Docker phases
├── commands/                # Command implementations
│   ├── build.ts, git.ts, deploy.ts, serve.ts
│   ├── session.ts, aws.ts, clean.ts, search.ts
│   └── index.ts             # Command exports
└── dashboard/               # Terminal UI (blessed-contrib)
    ├── Dashboard.ts         # Main dashboard orchestration
    ├── layout/              # Layout manager and presets
    └── components/          # Panel components
```

## Key Concepts

### ExecutionContext

All commands receive an `IExecutionContext` providing:
- **config**: Loaded and resolved configuration
- **output**: Formatted console output (respects --quiet, --json, --verbose)
- **getModule()/resolveModules()**: Module resolution by name, alias, or group
- **activeSession**: Current work session
- **getAwsConfig()**: Environment-specific AWS config

### Configuration Inheritance

Configuration flows: `Built-in Defaults → Config Defaults → Module Config → CLI Options`

Modules can be referenced by:
- Name: `joyincloud-gw-server`
- Alias: `gws`, `gateway`
- Group: `@backend`, `@flux`

### Module Types

| Type | Description |
|------|-------------|
| `java-service` | Spring Boot services (Maven + Docker) |
| `flux-client` | WebClient libraries (Maven only) |
| `frontend` | Angular applications |
| `node-service` | Node.js services |
| `lambda-layer` | AWS Lambda layers |
| `lambda-functions` | AWS Lambda functions |

### Pipeline System

Pipelines orchestrate multi-module operations through phases:
```typescript
const pipeline = new Pipeline({
  phases: [new BuildPhase()],
  modules: resolvedModules,
  failStrategy: ctx.failStrategy,
});
await pipeline.execute(ctx);
```

### Dependency System

Modules can declare dependencies that must be built first:
```typescript
// In jic.config.json
{
  "joyincloud-gw-server": {
    "type": "java-service",
    "dependencies": ["jic-tenant-mainsvc-client-flux", "jic-tenant-agenda-client-flux"]
  }
}
```

The dependency utilities (`src-ts/core/utils/dependencies.ts`) provide:
- **buildDependencyGraph()**: Creates DAG from module dependencies
- **topologicalSort()**: Returns build levels for correct ordering
- **detectCycles()**: Detects circular dependencies
- **expandDependencies()**: Expands modules to include their dependencies
- **getDependants()**: Finds modules that depend on a given module
- **getBuildOrder()**: Returns build levels respecting dependencies

Build command options:
- `--with-deps`: Include dependencies of specified modules
- `--dependants`: Also build modules that depend on the specified modules
- `--show-deps`: Display dependency tree without building
- `--parallel`: Parallelize within dependency levels (not across them)

### Error Handling

Error hierarchy with specific exit codes:
```
JicError (1) → ConfigError (2), BuildError (3), DeployError (4),
               AwsError (5), GitError (6), ServeError (7),
               SessionError (8), ValidationError (9)
```

Use `withErrorHandling()` wrapper for consistent error handling in commands.

## Adding New Commands

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
      // Implementation
    });
}
```

2. Export from `src-ts/commands/index.ts`
3. Register in `src-ts/index.ts`

## Configuration Files

- **jic.config.json**: Main configuration (modules, AWS, groups)
- **jic.state.json**: Persistent state (sessions, deployments)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `JIC_CONFIG` | Path to config file |
| `JIC_ENV` | Default environment |
| `JIC_VERBOSE` | Enable verbose output |
| `JIC_DRY_RUN` | Enable dry-run mode |
| `JIC_NO_COLOR` | Disable colored output |
