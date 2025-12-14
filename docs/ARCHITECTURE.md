# JIC-CLI Architecture Design

## Overview

**jic** (JoyInCloud CLI) is a development workflow automation tool designed for managing multi-module microservices projects. It provides a unified interface for git operations, builds, deployments, and AWS resource management across multiple submodules.

## Design Principles

1. **Composable Commands**: Each command does one thing well and can be piped/combined
2. **Smart Defaults**: Sensible defaults with full override capability
3. **Machine-Readable Output**: JSON output mode for scripting and TUI wrappers
4. **Fail-Safe Operations**: Dry-run mode, confirmations for destructive operations
5. **Configuration as Code**: All settings in version-controllable config files
6. **Extensible**: Plugin architecture for custom commands

## Command Structure

```
jic <domain> <action> [options] [targets...]

Domains:
  git       - Git operations across submodules
  build     - Build operations (compile, package, docker)
  deploy    - Deployment operations (AWS ECS, S3, Lambda)
  aws       - AWS resource management wrapper
  session   - Work session management
  config    - Configuration management
  status    - Status and health checks
```

## Core Commands

### Git Domain (`jic git`)

```bash
# Branch operations
jic git checkout <branch> [modules...]     # Checkout branch in modules
jic git branch create <name> [--from <base>] [modules...]
jic git branch delete <name> [modules...]
jic git branch list [--all] [modules...]

# Merge operations
jic git merge <source> [--into <target>] [modules...]
jic git rebase <base> [modules...]

# Status and sync
jic git status [modules...]                # Show status across modules
jic git fetch [modules...]                 # Fetch all remotes
jic git pull [modules...]                  # Pull current branch
jic git push [modules...]                  # Push current branch

# Bulk operations
jic git foreach <command>                  # Run git command in each module
jic git sync                               # Sync all modules to their tracking branch
```

### Build Domain (`jic build`)

```bash
# Individual builds
jic build flux [clients...]                # Build flux clients
jic build java [services...]               # Build Java services (Maven)
jic build docker [services...]             # Build Docker images
jic build node [services...]               # Build Node.js services
jic build frontend                         # Build Angular frontend

# Composite builds
jic build all                              # Full build (respects dependency order)
jic build changed                          # Build only changed modules
jic build service <name>                   # Build service with its dependencies

# Options
--skip-tests                               # Skip test execution
--parallel                                 # Parallel builds where possible
--fail-fast | --continue-on-error          # Failure handling
--dry-run                                  # Show what would be built
```

### Deploy Domain (`jic deploy`)

```bash
# Backend services (ECS)
jic deploy backend <service> [--env dev|prod] [--version <n>]
jic deploy backend all [--env dev|prod]

# Frontend (S3 + CloudFront)
jic deploy frontend [--env dev|prod]

# Lambda functions
jic deploy lambda <function> [--env dev|prod]
jic deploy lambda all [--env dev|prod]

# Composite deployments
jic deploy release <version>               # Full release deployment
jic deploy hotfix <service> [--env prod]   # Quick hotfix deploy

# Options
--dry-run                                  # Show deployment plan
--no-invalidate                            # Skip CloudFront invalidation
--wait                                     # Wait for deployment completion
```

### AWS Domain (`jic aws`)

```bash
# ECS operations
jic aws ecs list [--env dev|prod]          # List services
jic aws ecs status <service>               # Service status
jic aws ecs logs <service> [--follow]      # View logs
jic aws ecs restart <service>              # Force new deployment
jic aws ecs scale <service> <count>        # Scale service
jic aws ecs start-all                      # Start all services (desired=1)
jic aws ecs stop-all                       # Stop all services (desired=0)

# ECR operations
jic aws ecr list                           # List images
jic aws ecr versions <image>               # List image versions
jic aws ecr clean [--keep <n>]             # Clean old images

# Lambda operations
jic aws lambda list                        # List functions
jic aws lambda invoke <function> [--payload <json>]
jic aws lambda logs <function> [--follow]

# S3 operations
jic aws s3 sync <local> <bucket>           # Sync files
jic aws s3 ls <bucket>                     # List bucket contents

# CloudFront
jic aws cf invalidate [--paths <...>]      # Invalidate cache

# SSM/Session Manager
jic aws connect <service>                  # SSH into container
```

### Session Domain (`jic session`)

```bash
# Session lifecycle
jic session start <name> [--modules <...>] # Start new work session
jic session resume <name>                  # Resume existing session
jic session end <name>                     # End session (optional merge)
jic session list                           # List all sessions
jic session status [name]                  # Current session status

# Session operations
jic session checkout                       # Checkout session branches
jic session commit [--all]                 # Commit changes in session
jic session merge [--to <branch>]          # Merge session to target
```

### Config Domain (`jic config`)

```bash
jic config init                            # Initialize config in project
jic config validate                        # Validate configuration
jic config show [key]                      # Show configuration
jic config set <key> <value>               # Set configuration value
jic config get <key>                       # Get configuration value
```

### Status Domain (`jic status`)

```bash
jic status                                 # Overall project status
jic status modules                         # Module status (branch, changes)
jic status builds                          # Build status
jic status deploys                         # Deployment status
jic status aws                             # AWS resources status
```

## Output Modes

All commands support multiple output formats:

```bash
jic git status                             # Human-readable (default)
jic git status --json                      # JSON for scripting
jic git status --quiet                     # Minimal output
jic git status --verbose                   # Detailed output
```

## Global Options

```bash
--config <path>                            # Custom config file
--env <dev|prod>                           # Environment override
--dry-run                                  # Preview without executing
--yes                                      # Skip confirmations
--json                                     # JSON output
--quiet                                    # Minimal output
--verbose                                  # Detailed output
--no-color                                 # Disable colored output
```

## Configuration Files

### Project Configuration (`jic.config.json`)

Located in project root, version-controlled, shared across team.

### Local Configuration (`jic.local.json`)

Located in project root, git-ignored, contains user-specific settings.

### State File (`jic.state.json`)

Located in project root, git-ignored, contains:
- Active sessions
- Last deploy versions
- Build cache information

## Module Resolution

Modules can be referenced by:
- Full name: `joyincloud-gw-server`
- Alias: `gws`, `gateway`
- Directory: `./joyincloud-gw-server`
- Glob pattern: `jic-*-flux` (for flux clients)
- Group: `@backend`, `@frontend`, `@flux`

## Error Handling

Exit codes follow Unix conventions:
- `0`: Success
- `1`: General error
- `2`: Configuration error
- `3`: Build error
- `4`: Deploy error
- `5`: AWS error
- `130`: Interrupted (Ctrl+C)

## Dependency Graph

Build order is determined by dependency configuration:

```
flux-clients (parallel)
    ↓
java-services (parallel, depends on flux)
    ↓
node-services (parallel)
    ↓
frontend (depends on backend for type generation)
```

## Future Extensibility

- Plugin system for custom commands
- Hook system for pre/post command execution
- Template system for project scaffolding
- Integration with CI/CD pipelines
