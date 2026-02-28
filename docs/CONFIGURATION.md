# JIC CLI Configuration

This document describes the configuration system for JIC CLI v2.0, including the inheritance chain that dramatically reduces configuration verbosity.

## Configuration File

JIC CLI looks for configuration in the following locations (in order):

1. Path specified with `--config` flag
2. `jic.config.json` in current directory
3. `jic.config.json` in parent directories (up to git root)

## Configuration Inheritance

The key feature of v2.0 is configuration inheritance. Instead of repeating the same settings for each module, you define defaults once and only override what differs.

### Inheritance Chain

```
Built-in Defaults → Config Defaults → Module Config → CLI Options
       ↓                  ↓                ↓              ↓
   (hardcoded)      (jic.config.json    (per module)   (runtime)
                     defaults section)
```

### Example: Before vs After

**Before (verbose - ~50 lines per module):**
```json
{
  "modules": {
    "joyincloud-gw-server": {
      "type": "java-service",
      "directory": "joyincloud-gw-server",
      "aliases": ["gws", "gateway"],
      "port": 8080,
      "build": {
        "command": "mvn clean install -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerCommand": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true",
        "dockerImage": "localhost:5000/joyincloudgatewayserver"
      },
      "serve": {
        "command": "mvn -q -DskipTests spring-boot:run -Dspring-boot.run.profiles=dev",
        "healthCheck": "curl -sf http://localhost:8080/management/health",
        "startupTimeout": 80000
      }
    },
    "joyincloud-tenant-mainservice": {
      "type": "java-service",
      "directory": "joyincloud-tenant-mainservice",
      "aliases": ["tms"],
      "port": 8082,
      "build": {
        "command": "mvn clean install -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerCommand": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true",
        "dockerImage": "localhost:5000/joyincloudtenantmainservice"
      },
      "serve": {
        "command": "mvn -q -DskipTests spring-boot:run -Dspring-boot.run.profiles=dev",
        "healthCheck": "curl -sf http://localhost:8082/management/health",
        "startupTimeout": 80000
      }
    }
  }
}
```

**After (with inheritance - ~10 lines per module):**
```json
{
  "defaults": {
    "branches": {
      "local": "feature/samuele",
      "dev": "origin/feature/samuele",
      "main": "origin/master"
    },
    "build": {
      "java-service": {
        "command": "mvn clean install -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerCommand": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true"
      }
    },
    "serve": {
      "java-service": {
        "command": "mvn -q -DskipTests spring-boot:run -Dspring-boot.run.profiles=dev",
        "healthCheckPath": "/management/health",
        "startupTimeout": 80000
      }
    }
  },
  "modules": {
    "joyincloud-gw-server": {
      "type": "java-service",
      "directory": "joyincloud-gw-server",
      "aliases": ["gws", "gateway"],
      "port": 8080,
      "build": { "dockerImage": "localhost:5000/joyincloudgatewayserver" }
    },
    "joyincloud-tenant-mainservice": {
      "type": "java-service",
      "directory": "joyincloud-tenant-mainservice",
      "aliases": ["tms"],
      "port": 8082,
      "build": { "dockerImage": "localhost:5000/joyincloudtenantmainservice" }
    },
    "whatsapp-service-server": {
      "type": "node-service",
      "directory": "whatsapp-service-server",
      "aliases": ["whatsapp", "wa"],
      "port": 3004,
      "branches": {
        "local": "rewrite",
        "dev": "origin/rewrite",
        "main": "origin/master"
      }
    }
  }
}
```

Note how `whatsapp-service-server` overrides the default branches while other modules inherit them.

## Configuration Schema

### Root Configuration

```typescript
interface JicConfig {
  // Project metadata
  project?: {
    name?: string;
    description?: string;
  };

  // Default settings per module type
  defaults?: DefaultsConfig;

  // Module definitions
  modules: Record<string, ModuleConfig>;

  // Module groups for batch operations
  groups?: Record<string, string[]>;

  // AWS configuration
  aws?: AwsConfig;

  // Global defaults
  globalDefaults?: {
    environment?: Environment;
    failStrategy?: FailStrategy;
  };
}
```

### Defaults Configuration

```typescript
interface DefaultsConfig {
  // Default branch for new sessions (deprecated, use branches)
  branch?: string;

  // Default branch configuration for all modules
  branches?: {
    local: string;   // Local development branch
    dev: string;     // Development remote branch
    main: string;    // Main/production remote branch
  };

  // Default environment
  environment: Environment;

  // Default failure handling strategy
  failStrategy: FailStrategy;

  // Build defaults per module type
  build?: Partial<Record<ModuleType, Partial<BuildConfig>>>;

  // Serve defaults per module type
  serve?: Partial<Record<ModuleType, Partial<ServeConfig>>>;

  // Deploy defaults per type and environment
  deploy?: {
    ecs?: Record<Environment, Partial<EcsDeployConfig>>;
    's3-cloudfront'?: Record<Environment, Partial<S3DeployConfig>>;
    lambda?: Record<Environment, Partial<LambdaDeployConfig>>;
    'lambda-layer'?: Record<Environment, Partial<LambdaLayerDeployConfig>>;
  };
}
```

### Module Configuration

```typescript
interface ModuleConfig {
  // Required
  type: ModuleType;
  directory: string;

  // Optional
  aliases?: string[];
  port?: number;
  dependencies?: string[];  // Modules that must be built before this one

  // Overrides (merged with defaults)
  build?: Partial<BuildConfig>;
  serve?: Partial<ServeConfig>;
  deploy?: {
    dev?: DeployConfig;
    staging?: DeployConfig;
    prod?: DeployConfig;
  };

  // Branch configuration (overrides defaults.branches)
  branches?: {
    local?: string;    // Local development branch
    dev?: string;      // Development remote branch
    main?: string;     // Main/production remote branch
  };
}
```

### Module Dependencies

Modules can declare dependencies on other modules. When building with `--with-deps`, dependencies are automatically included and built first:

```json
{
  "modules": {
    "joyincloud-gw-server": {
      "type": "java-service",
      "directory": "joyincloud-gw-server",
      "dependencies": [
        "jic-tenant-mainsvc-client-flux",
        "jic-tenant-agenda-client-flux"
      ]
    },
    "jic-tenant-mainsvc-client-flux": {
      "type": "flux-client",
      "directory": "jic-tenant-mainsvc-client-flux"
    }
  }
}
```

Usage:
```bash
# Build gws with its dependencies (flux clients first)
jic build gws --with-deps

# Build flux client and all services that depend on it
jic build jic-tenant-mainsvc-client-flux --dependants

# Show dependency tree
jic build --show-deps
```

The build system:
- Organizes modules into **dependency levels** (level 0 has no deps, level 1 depends only on level 0, etc.)
- Builds levels sequentially, ensuring dependencies are ready before dependants
- When using `--parallel`, only modules within the same level are parallelized
- Deduplicates dependencies (each module is built only once)

### Build Configuration

```typescript
interface BuildConfig {
  command: string;           // Build command
  preBuild?: string;         // Pre-build hook
  postBuild?: string;        // Post-build hook
  cleanCommand?: string;     // Clean command
  outputDir?: string;        // Build output directory
  env?: Record<string, string>; // Environment variables
  timeout?: number;          // Build timeout (ms)
}

// Docker extension
interface DockerBuildConfig extends BuildConfig {
  dockerCommand: string;     // Docker build command
  dockerImage: string;       // Image name/tag
  registry?: string;         // Docker registry
}
```

### Serve Configuration

```typescript
interface ServeConfig {
  command: string;           // Start command
  healthCheck?: string;      // Health check command
  healthCheckPath?: string;  // Health check path (auto-generates curl)
  startupTimeout?: number;   // Startup timeout (ms)
  env?: Record<string, string>; // Environment variables
  dependencies?: string[];   // Services to start first
}
```

## Module Types

JIC CLI supports the following module types with built-in defaults:

| Type | Description | Build | Serve |
|------|-------------|-------|-------|
| `java-service` | Spring Boot services | Maven | Spring Boot run |
| `flux-client` | WebClient libraries | Maven | - |
| `frontend` | Angular application | npm | ng serve |
| `node-service` | Node.js services | npm | npm start |
| `lambda-layer` | AWS Lambda layers | zip | - |
| `lambda-functions` | AWS Lambda functions | zip | - |

### Built-in Defaults

```typescript
// java-service defaults
{
  build: {
    command: 'mvn clean install -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true',
    dockerCommand: 'mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true'
  },
  serve: {
    command: 'mvn -q -DskipTests spring-boot:run -Dspring-boot.run.profiles=dev',
    healthCheckPath: '/management/health',
    startupTimeout: 80000
  }
}

// flux-client defaults
{
  build: {
    command: 'mvn clean install'
  }
}

// frontend defaults
{
  build: {
    command: 'npm run build',
    preBuild: 'npm ci'
  },
  serve: {
    command: 'npm start',
    healthCheckPath: '/',
    startupTimeout: 60000
  }
}

// node-service defaults
{
  build: {
    command: 'npm run build',
    preBuild: 'npm ci'
  },
  serve: {
    command: 'npm start',
    startupTimeout: 30000
  }
}
```

## Module Groups

Groups allow batch operations on related modules:

```json
{
  "groups": {
    "@backend": [
      "joyincloud-gw-server",
      "joyincloud-tenant-mainservice",
      "joyincloud-tenant-agenda",
      "joyincloud-tenant-notificationservice"
    ],
    "@flux": [
      "jic-tenant-agenda-client-flux",
      "jic-tenant-mainsvc-client-flux",
      "whatsapp-service-client-flux"
    ],
    "@frontend": ["joyincloud-gw-client"],
    "@minServe": [
      "joyincloud-gw-server",
      "joyincloud-tenant-mainservice"
    ]
  }
}
```

Usage:
```bash
jic build @backend          # Build all backend services
jic git status @flux        # Git status for flux clients
jic serve @minServe         # Start minimal service set
```

## AWS Configuration

```json
{
  "aws": {
    "region": "eu-south-1",
    "dev": {
      "profile": "default",
      "accountId": "123456789012",
      "ecsCluster": "jic-dev-cluster",
      "ecrRegistry": "123456789012.dkr.ecr.eu-south-1.amazonaws.com",
      "logGroup": "jic-dev-logs"
    },
    "staging": {
      "profile": "staging",
      "accountId": "123456789013",
      "ecsCluster": "jic-staging-cluster"
    },
    "prod": {
      "profile": "prod",
      "accountId": "123456789014",
      "ecsCluster": "jic-prod-cluster",
      "ecrRegistry": "123456789014.dkr.ecr.eu-south-1.amazonaws.com"
    }
  }
}
```

## State File

JIC CLI maintains state in `jic.state.json`:

```json
{
  "version": "2.0.0",
  "lastUpdated": "2024-01-15T12:00:00Z",
  "activeSession": "myFeature",
  "sessions": {
    "myFeature": {
      "name": "myFeature",
      "description": "My feature description",
      "status": "active",
      "createdAt": "2024-01-15T10:00:00Z",
      "baseBranch": "feature/samuele",
      "sessionBranch": "feature/myFeature",
      "modules": {
        "joyincloud-gw-server": {
          "branch": "feature/myFeature",
          "baseBranch": "feature/samuele"
        },
        "joyincloud-tenant-mainservice": {
          "branch": "feature/myFeature",
          "baseBranch": "feature/samuele"
        }
      },
      "mergedBranches": []
    }
  },
  "deployments": {
    "dev": {
      "joyincloud-gw-server": {
        "moduleName": "joyincloud-gw-server",
        "environment": "dev",
        "version": "3.07",
        "commit": "abc123",
        "deployedAt": "2024-01-15T12:00:00Z",
        "status": "deployed"
      },
      "aws-lambda-functions": {
        "moduleName": "aws-lambda-functions",
        "environment": "dev",
        "version": "1.01",
        "commit": "def456",
        "deployedAt": "2024-01-15T12:00:00Z",
        "status": "deployed",
        "functions": {
          "importClienti": {
            "version": "1.01",
            "lambdaVersion": "2",
            "deployedAt": "2024-01-15T12:00:00Z"
          }
        }
      }
    },
    "staging": {},
    "prod": {}
  },
  "serve": {
    "processes": {},
    "infrastructure": {
      "running": false
    }
  },
  "buildCache": {}
}
```

## Environment Variables

JIC CLI respects these environment variables:

| Variable | Description |
|----------|-------------|
| `JIC_CONFIG` | Path to config file |
| `JIC_ENV` | Default environment (dev/staging/prod) |
| `JIC_VERBOSE` | Enable verbose output |
| `JIC_DRY_RUN` | Enable dry-run mode |
| `JIC_NO_COLOR` | Disable colored output |

## CLI Option Overrides

Global options override configuration:

```bash
jic build --env prod          # Override environment
jic build --dry-run           # Preview without executing
jic build --fail-fast         # Stop on first error
jic build --continue-on-error # Continue despite errors
jic build --verbose           # Detailed output
jic build --quiet             # Minimal output
jic build --json              # JSON output
jic build --no-color          # Disable colors
```

### Build-specific Options

```bash
jic build --docker            # Also build Docker images
jic build --clean             # Clean before building
jic build --parallel          # Build in parallel (within dependency levels)
jic build --skip-tests        # Skip test execution
jic build -d, --with-deps     # Include dependencies of specified modules
jic build -D, --dependants    # Also build modules that depend on the specified modules
jic build --show-deps         # Show dependency tree without building
jic build --type <type>       # Build only modules of specific type
jic build --skip-flux         # Skip flux client builds
jic build --skip-java         # Skip Java service builds
jic build --skip-node         # Skip Node.js service builds
jic build --skip-frontend     # Skip frontend build
```

## Configuration Resolution

When a command runs, configuration is resolved in this order:

1. **Load base config**: Read `jic.config.json`
2. **Apply built-in defaults**: Merge hardcoded defaults for each module type
3. **Apply config defaults**: Merge `defaults` section per module type
4. **Apply module config**: Merge module-specific overrides
5. **Resolve paths**: Convert relative paths to absolute
6. **Apply CLI options**: Override with command-line flags

The result is a `ResolvedModule` with all settings computed:

```typescript
interface ResolvedModule {
  name: string;
  type: ModuleType;
  directory: string;
  absolutePath: string;
  aliases?: string[];
  port?: number;

  // Fully merged configurations
  resolvedBuild?: ResolvedBuildConfig;
  resolvedServe?: ResolvedServeConfig;
  resolvedDeploy?: ResolvedDeployConfig;
}
```

## Migration from v1

If you have an existing v1 configuration without defaults, JIC CLI will work with it directly. To take advantage of inheritance:

1. Identify common patterns across modules of the same type
2. Extract those patterns to the `defaults` section
3. Remove duplicated settings from individual modules
4. Keep only module-specific overrides (ports, image names, etc.)

The CLI can help identify patterns:
```bash
jic config analyze  # (future) Suggest defaults based on current config
```
