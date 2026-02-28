# JIC CLI

**JoyInCloud Development Workflow CLI** - A comprehensive command-line tool for managing multi-module microservices projects.

## Features

- **Git Operations**: Manage branches, merges, and rebases across multiple submodules
- **Build Orchestration**: Build flux clients, Java services, and frontend with dependency ordering
- **Deployment Automation**: Deploy to AWS ECS, S3/CloudFront, and Lambda
- **AWS Management**: Wrapper for common AWS operations (ECS, ECR, Lambda, CloudFront)
- **Session Management**: Track work streams across related modules
- **Version Tracking**: Automatic version tracking for Docker images

## Installation

```bash
# Install dependencies
npm install

# Link globally for development
npm link

# Now you can use 'jic' command globally
jic --help
```

## Quick Start

```bash
# Show project status
jic status

# Show git status across all modules
jic git status

# Checkout a branch in all modules
jic git checkout feature/myFeature

# Build all modules
jic build all

# Deploy a backend service
jic deploy backend gws --env dev

# Deploy frontend
jic deploy frontend --env dev
```

## Command Reference

### Git Commands

```bash
jic git status [modules...]              # Show status across modules
jic git checkout <branch> [modules...]   # Checkout branch
jic git branch create <name> [modules...]# Create branch
jic git merge <source> [modules...]      # Merge branch
jic git rebase <base> [modules...]       # Rebase onto base
jic git fetch [modules...]               # Fetch from remotes
jic git pull [modules...]                # Pull current branch
jic git push [modules...]                # Push current branch
```

### Build Commands

```bash
jic build                                # Build all modules in dependency order
jic build @backend                       # Build a group
jic build gws tms                        # Build specific modules
jic build --docker                       # Build with Docker images
jic build --parallel                     # Build in parallel (within dependency levels)

# Dependency-aware builds
jic build gws --with-deps                # Build gws and its dependencies (flux clients)
jic build @flux --dependants             # Build flux clients + all services using them
jic build --show-deps                    # Show dependency tree without building
jic build gws --with-deps --show-deps    # Show what would be built
```

### Deploy Commands

```bash
jic deploy backend <service> --env dev   # Deploy backend service
jic deploy backend-all --env dev         # Deploy all backend services
jic deploy frontend --env dev            # Deploy frontend
jic deploy lambda <function> --env dev   # Deploy Lambda function
jic deploy release <version>             # Full release deployment
jic deploy status                        # Show deployment versions
```

### AWS Commands

```bash
jic aws ecs list                         # List ECS services
jic aws ecs status <service>             # Service status
jic aws ecs logs <service> -f            # Stream logs
jic aws ecs restart <service>            # Force new deployment
jic aws ecs start-all                    # Start all services
jic aws ecs stop-all                     # Stop all services
jic aws ecr list                         # List ECR repositories
jic aws lambda list                      # List Lambda functions
jic aws cf invalidate                    # Invalidate CloudFront
```

### Session Commands

```bash
jic session start <name>                 # Start work session
jic session end <name>                   # End session
jic session checkout [name]              # Checkout session branches
jic session list                         # List sessions
jic session status                       # Show session details
jic session merge                        # Merge session to base
```

## Configuration

Configuration is stored in `jic.config.json` in the project root:

```json
{
  "project": {
    "name": "myproject",
    "description": "My Project"
  },
  "modules": {
    "my-service": {
      "type": "java-service",
      "directory": "my-service",
      "aliases": ["ms"],
      "build": { "command": "mvn clean install" },
      "deploy": { ... }
    }
  },
  "aws": {
    "region": "eu-south-1",
    "dev": { "profile": "default", "ecsCluster": "my-cluster" },
    "prod": { "profile": "prod", "ecsCluster": "prod-cluster" }
  }
}
```

### Module Types

- `frontend` - Angular/React apps deployed to S3
- `java-service` - Spring Boot services deployed to ECS
- `flux-client` - Maven libraries for service communication
- `node-service` - Node.js services
- `lambda-layer` - AWS Lambda layer
- `lambda-functions` - AWS Lambda functions

### Module Resolution

Modules can be referenced by:
- Full name: `joyincloud-gw-server`
- Alias: `gws`
- Group: `@backend`
- Glob: `jic-*-flux`

## Global Options

```bash
--env <dev|prod>     # Environment
--dry-run            # Preview without executing
--yes                # Skip confirmations
--json               # JSON output
--quiet              # Minimal output
--verbose            # Detailed output
--fail-fast          # Stop on first error
--continue-on-error  # Continue despite errors
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - Detailed architecture design
- [Configuration](docs/CONFIGURATION.md) - Configuration reference

## License

MIT
