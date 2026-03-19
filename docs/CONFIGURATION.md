# JIC CLI Configuration

This document describes the configuration system for JIC CLI v2.0, including the inheritance chain that dramatically reduces configuration verbosity.

## Configuration File

JIC CLI looks for configuration in the following locations (in order):

1. Path specified with `--config` flag
2. `jic.config.json` in current directory
3. `jic.config.json` in parent directories (up to git root)
4. `.jic/vendors/jic.config.<vendor>.json` for vendor-specific config (when `project.type: "submodules"`)

## Configuration Inheritance

The key feature of v2.0 is configuration inheritance. Instead of repeating the same settings for each module, you define defaults once and only override what differs.

### Inheritance Chain

```
Built-in Defaults → Config Defaults → Vendor Config → Module Config → CLI Options
       ↓                  ↓                ↓              ↓              ↓
   (hardcoded)      (jic.config.json  (.jic/vendors/  (per module)   (runtime)
                     defaults section) jic.config.
                                      <vendor>.json)
```

Vendor config is only active when `project.type` is `"submodules"`. For `"independent"` projects (default), this layer is skipped.

### Example: Before vs After

**Before (verbose - ~50 lines per module):**
```json
{
  "modules": {
    "api-server": {
      "type": "java-service",
      "directory": "api-server",
      "aliases": ["api", "gateway"],
      "port": 8080,
      "build": {
        "command": "mvn clean install -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerCommand": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true",
        "dockerImage": "localhost:5000/api-server"
      },
      "serve": {
        "command": "mvn -q -DskipTests spring-boot:run -Dspring-boot.run.profiles=dev",
        "healthCheck": "curl -sf http://localhost:8080/management/health",
        "startupTimeout": 80000
      }
    },
    "user-service": {
      "type": "java-service",
      "directory": "user-service",
      "aliases": ["us"],
      "port": 8082,
      "build": {
        "command": "mvn clean install -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerCommand": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true",
        "dockerImage": "localhost:5000/user-service"
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
      "local": "develop",
      "dev": "origin/develop",
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
    "api-server": {
      "type": "java-service",
      "directory": "api-server",
      "aliases": ["api", "gateway"],
      "port": 8080,
      "build": { "dockerImage": "localhost:5000/api-server" }
    },
    "user-service": {
      "type": "java-service",
      "directory": "user-service",
      "aliases": ["us"],
      "port": 8082,
      "build": { "dockerImage": "localhost:5000/user-service" }
    },
    "messaging-service": {
      "type": "node-service",
      "directory": "messaging-service",
      "aliases": ["msg"],
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

Note how `messaging-service` overrides the default branches while other modules inherit them from defaults.

## Configuration Schema

### Root Configuration

```typescript
interface JicConfig {
  // Project metadata
  project?: {
    name?: string;
    description?: string;
    type?: 'independent' | 'submodules';  // default: 'independent'
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

  // Environment variables (can be overridden by vendor config)
  env?: Record<string, string>;

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
    "api-server": {
      "type": "java-service",
      "directory": "api-server",
      "dependencies": [
        "user-service-client",
        "booking-service-client"
      ]
    },
    "user-service-client": {
      "type": "flux-client",
      "directory": "user-service-client"
    }
  }
}
```

Usage:
```bash
# Build gws with its dependencies (flux clients first)
jic build api --with-deps

# Build flux client and all services that depend on it
jic build user-service-client --dependants

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
| `frontend` | Frontend application (Angular, React, Vue, TanStack) | npm | ng serve |
| `node-service` | Node.js services | npm | npm start |
| `lambda-layer` | AWS Lambda layers | zip | - |
| `lambda-functions` | AWS Lambda functions | zip | - |
| `dotnet-service` | C#/.NET services | dotnet | dotnet run |
| `unknown` | Unrecognized (auto-detected) | - | - |

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
      "api-server",
      "user-service",
      "booking-service",
      "notification-service"
    ],
    "@flux": [
      "booking-service-client",
      "user-service-client",
      "messaging-service-client"
    ],
    "@frontend": ["frontend"],
    "@minServe": [
      "api-server",
      "user-service"
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

## Vendor Configuration

For projects with `project.type: "submodules"`, vendor configuration files define per-client customizations.

### File Location

Vendor configs are stored in `.jic/vendors/jic.config.<vendor>.json`. The active vendor is tracked in `jic.state.json` via the `activeVendor` field (defaults to `"root"`).

### Vendor Config Schema

```typescript
interface VendorConfig {
  description?: string;
  modules: string[];              // Module names from root config (acts as filter)
  branches: {
    master: string;               // e.g., "acme/master"
    dev: string;                  // e.g., "acme/dev"
    build: string;                // e.g., "acme/build"
  };
  nonVendorBranch?: string;       // Branch for non-vendor modules (default: "master")
  env?: Record<string, string>;   // Vendor-specific environment variables
  aws?: Partial<AwsConfig>;       // AWS overrides (deep-merged)
  kubernetes?: Partial<KubernetesConfig>; // K8s overrides (deep-merged)
}
```

### Example

```json
{
  "description": "Acme Corp customization",
  "modules": ["service-a", "frontend"],
  "branches": {
    "master": "acme/master",
    "dev": "acme/dev",
    "build": "acme/build"
  },
  "nonVendorBranch": "master",
  "env": {
    "API_URL": "https://acme.example.com/api",
    "THEME": "acme"
  }
}
```

### The "root" Vendor

The `root` vendor is the default. It includes all modules with standard branch names (`master`, `dev`, `build`). Generated by `jic vendor create root` or automatically when no vendor is set.

### Merge Rules

- **`modules`**: Filters which modules are visible to commands. Creates implicit `@<vendor>` group.
- **`env`**: Deep-merged with `defaults.env` (vendor values override root values)
- **`aws`, `kubernetes`**: Deep-merged with root config
- **Module resolution**: `resolveModules([])` returns only vendor modules. Group references (`@backend`) are intersected with vendor modules. Explicit module references outside vendor throw `VendorError`.

### Implicit Groups

Each vendor automatically creates a group `@<vendorName>` containing its modules:
```bash
jic build @acme          # Build all modules in the acme vendor
```

Existing groups (`@backend`, `@frontend`) are intersected with the active vendor's modules.

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
  "activeVendor": "acme",
  "sessions": {
    "myFeature": {
      "name": "myFeature",
      "description": "My feature description",
      "status": "active",
      "createdAt": "2024-01-15T10:00:00Z",
      "baseBranch": "develop",
      "sessionBranch": "feature/myFeature",
      "vendor": "acme",
      "rootBranch": "acme/feature/myFeature",
      "rootBaseBranch": "acme/dev",
      "modules": {
        "api-server": {
          "branch": "feature/myFeature",
          "baseBranch": "develop"
        },
        "user-service": {
          "branch": "feature/myFeature",
          "baseBranch": "develop"
        }
      },
      "mergedBranches": []
    }
  },
  "deployments": {
    "dev": {
      "api-server": {
        "moduleName": "api-server",
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
          "importData": {
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
2. **Load state**: Read `jic.state.json` (includes `activeVendor`)
3. **Load vendor config** (if `project.type: "submodules"`): Read `.jic/vendors/jic.config.<activeVendor>.json`
4. **Apply built-in defaults**: Merge hardcoded defaults for each module type
5. **Apply config defaults**: Merge `defaults` section per module type
6. **Apply module config**: Merge module-specific overrides
7. **Resolve paths**: Convert relative paths to absolute
8. **Apply CLI options**: Override with command-line flags

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
