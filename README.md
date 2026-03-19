# JIC CLI

A command-line tool for managing multi-module microservices projects. Provides unified commands for git operations, builds, deployments, sessions, and infrastructure management across multiple submodules.

## Features

- **Git Operations**: Manage branches, commits, diffs, and syncs across multiple submodules
- **Build Orchestration**: Dependency-aware builds with parallel execution support
- **Deployment Automation**: Deploy to AWS ECS, S3/CloudFront, Lambda, and Kubernetes
- **AWS Management**: ECS, ECR, Lambda, and CloudFront operations
- **Kubernetes Management**: Namespace, deployment, and pod operations
- **Session Management**: Track work sessions across related modules with branch management
- **Vendor Support**: Multi-client vendor-branch workflows with git submodules
- **Project Init**: Initialize new projects with `jic init`
- **Module Discovery**: Auto-detect module types from filesystem
- **Dashboard**: Terminal UI for monitoring services and logs
- **Code Search**: Search across all modules with pattern matching

## Installation

```bash
npm install -g jic-cli
```

Or for development:

```bash
git clone <repo-url>
cd jic-cli
npm install
npm link
```

## Quick Start

```bash
# Initialize a new project
jic init --yes

# Show project status
jic status

# Show git status across all modules
jic git status

# Start a work session
jic session start my-feature -m api-server frontend

# Build with dependency resolution
jic build api-server --with-deps

# Deploy a service
jic deploy backend api-server

# Search across modules
jic search "SomeClass"
```

## Command Reference

### Git Commands

```bash
jic git status [modules...]              # Show status across modules
jic git checkout [branch] [modules...]   # Checkout branch
jic git branch create <name>             # Create branch across modules
jic git branch delete <name>             # Delete branch across modules
jic git fetch [modules...]               # Fetch from remotes
jic git pull [modules...]                # Pull current branch
jic git push [modules...]                # Push current branch
jic git sync [modules...]                # Sync with base branch (merge or rebase)
jic git diff [modules...]                # Show diffs across modules
jic git log [modules...]                 # Show commits across modules
jic git graph [modules...]               # Show branch graph
jic git stash save [message]             # Stash changes across modules
jic git stash pop                        # Pop stash across modules
jic git commit -m "message"              # Commit across session modules
jic git commit --update-root             # Also update submodule pointers in root
jic git changelog                        # Generate changelog from commits
jic git foreach "command"                # Run git command in each module
```

Use `-g` / `--global` to operate on all modules (overrides session scope).

### Build Commands

```bash
jic build [modules...]                   # Build modules in dependency order
jic build @backend                       # Build a module group
jic build api-server --with-deps         # Build with dependencies
jic build @flux --dependants             # Build + everything that depends on it
jic build api-server --with-deps --docker # Build with Docker images
jic build --parallel                     # Parallel within dependency levels
jic build --show-deps                    # Preview dependency tree
jic build --clean                        # Clean before building
jic build --skip-tests                   # Skip tests
```

### Deploy Commands

```bash
jic deploy backend <service>             # Deploy backend service
jic deploy frontend                      # Deploy frontend
jic deploy lambda <function>             # Deploy Lambda function
jic deploy status                        # Show deployment status
```

### Session Commands

```bash
jic session start <name> [-m modules]    # Start work session
jic session end [name] [--merge]         # End session (optionally merge)
jic session checkout [name]              # Checkout session branches
jic session list                         # List all sessions
jic session status [name]                # Show session details
jic session pause                        # Stash and checkout default branches
jic session resume [name]               # Restore session branches and stash
jic session switch <name>                # Switch to different session
jic session add <module>                 # Add module to active session
jic session remove <module>              # Remove module from session
jic session templates                    # Show available session templates
jic session delete <name>                # Delete a session
```

### Vendor Commands

For projects using git submodules with vendor-branch distribution (`project.type: "submodules"`):

```bash
jic vendor list                          # List available vendors
jic vendor status                        # Show active vendor and module branches
jic vendor create <name>                 # Create vendor config + branches
jic vendor checkout <name>               # Switch to a vendor context
jic vendor add <module>                  # Add module to active vendor
jic vendor remove <module>               # Remove module from vendor
jic vendor sync                          # Merge master into vendor branches
```

### Init Command

```bash
jic init                                 # Initialize project (interactive)
jic init --yes                           # Auto-init (dir name + submodules type)
jic init --name myproject --type independent  # Non-interactive
jic init --force                         # Overwrite existing config
```

### Module Commands

```bash
jic module discovery                     # Scan subdirectories and add to config
jic module config <module> get <key>     # Read config value (dot-path)
jic module config <module> set <key> <value>  # Write config value
```

### AWS Commands

```bash
jic aws ecs list                         # List ECS services
jic aws ecs status <service>             # Service status
jic aws ecs logs <service> [-f]          # View/stream logs
jic aws ecs restart <service>            # Force new deployment
jic aws ecs start-all                    # Start all services
jic aws ecs stop-all                     # Stop all services
jic aws ecr list                         # List ECR repositories
jic aws lambda list                      # List Lambda functions
jic aws lambda invoke <function>         # Invoke Lambda function
jic aws cf invalidate                    # Invalidate CloudFront cache
```

### Kubernetes Commands

```bash
jic k8s status [modules...]              # Show deployment status
jic k8s logs <module> [-f]               # View/stream pod logs
jic k8s restart <module>                 # Restart deployment
jic k8s scale <module> <replicas>        # Scale deployment
```

### Other Commands

```bash
jic search <pattern> [modules...]        # Search code across modules
jic clean [modules...]                   # Clean build artifacts
jic serve [modules...]                   # Start local development servers
jic serve --status                       # Check running services
jic serve --stop                         # Stop services
jic dashboard                            # Open terminal dashboard
```

## Configuration

Configuration is stored in `jic.config.json` in the project root:

```json
{
  "project": {
    "name": "my-project",
    "type": "independent"
  },
  "modules": {
    "api-server": {
      "type": "java-service",
      "directory": "api-server",
      "aliases": ["api"],
      "port": 8080,
      "dependencies": ["shared-client"]
    },
    "frontend": {
      "type": "frontend",
      "directory": "frontend",
      "aliases": ["fe"],
      "port": 9000
    }
  },
  "groups": {
    "@backend": ["api-server", "user-service"],
    "@frontend": ["frontend"]
  },
  "defaults": {
    "branches": {
      "local": "main",
      "dev": "origin/main",
      "main": "origin/main"
    },
    "environment": "dev",
    "failStrategy": "fail-fast"
  }
}
```

### Module Types

| Type | Description |
|------|-------------|
| `java-service` | Java/Spring Boot services (Maven build, Docker deploy) |
| `flux-client` | Java WebClient libraries (Maven build only) |
| `frontend` | Frontend applications (npm build, S3 deploy) |
| `node-service` | Node.js services (npm build, Docker deploy) |
| `lambda-layer` | AWS Lambda shared dependency layers |
| `lambda-functions` | AWS Lambda function bundles |
| `dotnet-service` | C#/.NET services |
| `unknown` | Unrecognized module type (added by discovery) |

### Project Types

| Type | Description |
|------|-------------|
| `independent` | Default. Each module has its own git repo, no root repo. |
| `submodules` | Root git repo with submodules. Enables vendor commands. |

### Vendor Configuration

For `submodules` projects, vendor configs live in `.jic/vendors/`:

```json
{
  "description": "Acme Corp",
  "modules": ["service-a", "frontend"],
  "branches": {
    "master": "acme/master",
    "dev": "acme/dev",
    "build": "acme/build"
  },
  "nonVendorBranch": "master",
  "env": {
    "API_URL": "https://acme.example.com/api"
  }
}
```

Active vendor is tracked in `jic.state.json` (`activeVendor` field, defaults to `"root"`). An implicit `@<vendor>` group is created automatically for each vendor.

### Module Resolution

Modules can be referenced by:
- **Name**: `api-server`
- **Alias**: `api`
- **Group**: `@backend`
- **Glob**: `*-service`

### Configuration Files

| File | Purpose | Tracked |
|------|---------|---------|
| `jic.config.json` | Module definitions, groups, infra config, defaults | Yes |
| `jic.local.json` | Local developer overrides (ports, paths) | No |
| `jic.state.json` | Runtime state (sessions, deployments) | No |
| `.jic/vendors/jic.config.<vendor>.json` | Vendor-specific config (modules, branches, env) | Yes |

## Global Options

```
--env <environment>    Environment (dev, staging, prod)
--dry-run              Preview without executing
--yes                  Skip confirmations
--json                 JSON output format
--quiet                Minimal output
--verbose              Detailed output
--fail-fast            Stop on first error (default)
--continue-on-error    Continue despite errors
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System architecture and design
- [Configuration](docs/CONFIGURATION.md) - Full configuration reference
- [Dashboard](docs/DASHBOARD_ARCHITECTURE.md) - Terminal UI architecture

## License

[MIT](LICENSE) - Copyright (c) 2026 Angelo Samuele Abbadessa
