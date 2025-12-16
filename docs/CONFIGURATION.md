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
    }
  }
}
```

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
  // Build defaults per module type
  build?: Partial<Record<ModuleType, Partial<BuildConfig>>>;

  // Serve defaults per module type
  serve?: Partial<Record<ModuleType, Partial<ServeConfig>>>;

  // Deploy defaults per type and environment
  deploy?: {
    ecs?: Record<Environment, Partial<EcsDeployConfig>>;
    's3-cloudfront'?: Record<Environment, Partial<S3DeployConfig>>;
    lambda?: Record<Environment, Partial<LambdaDeployConfig>>;
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

  // Overrides (merged with defaults)
  build?: Partial<BuildConfig>;
  serve?: Partial<ServeConfig>;
  deploy?: {
    dev?: DeployConfig;
    staging?: DeployConfig;
    prod?: DeployConfig;
  };

  // Branch configuration
  branches?: {
    local?: string;    // Default local branch
    remote?: string;   // Default remote branch
  };
}
```

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
    "dev": {
      "profile": "joyincloud-dev",
      "accountId": "123456789012",
      "ecsCluster": "jic-dev-cluster",
      "ecrRegistry": "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
      "logGroup": "jic-dev-logs"
    },
    "staging": {
      "profile": "joyincloud-staging",
      "accountId": "123456789013",
      "ecsCluster": "jic-staging-cluster"
    },
    "prod": {
      "profile": "joyincloud-prod",
      "accountId": "123456789014",
      "ecsCluster": "jic-prod-cluster"
    }
  }
}
```

## State File

JIC CLI maintains state in `jic.state.json`:

```json
{
  "activeSession": "myFeature",
  "sessions": {
    "myFeature": {
      "name": "myFeature",
      "status": "active",
      "createdAt": "2024-01-15T10:00:00Z",
      "modules": {
        "joyincloud-gw-server": { "branch": "feature/myFeature" },
        "joyincloud-tenant-mainservice": { "branch": "feature/myFeature" }
      }
    }
  },
  "deployments": {
    "dev": {
      "joyincloud-gw-server": {
        "version": "1.2.3",
        "commit": "abc123",
        "deployedAt": "2024-01-15T12:00:00Z",
        "status": "deployed"
      }
    }
  }
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
