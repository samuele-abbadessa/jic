# JIC-CLI Configuration Reference

## Configuration Files Overview

| File | Location | Git-tracked | Purpose |
|------|----------|-------------|---------|
| `jic.config.json` | Project root | Yes | Shared project configuration |
| `jic.local.json` | Project root | No | Local overrides and secrets |
| `jic.state.json` | Project root | No | Runtime state (sessions, versions) |

## Project Configuration Schema (`jic.config.json`)

```json
{
  "$schema": "./node_modules/jic-cli/schema/jic.config.schema.json",
  "version": "1.0.0",
  "project": {
    "name": "joyincloud",
    "description": "JoyInCloud Multi-tenant Business Platform",
    "rootDir": "."
  },

  "modules": {
    "joyincloud-gw-client": {
      "type": "frontend",
      "directory": "joyincloud-gw-client",
      "aliases": ["gwc", "frontend", "client"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "npm run build",
        "preBuild": "rm -rf node_modules/.cache .angular/cache",
        "outputDir": "target/classes/static",
        "env": {
          "NODE_OPTIONS": "--max_old_space_size=4096"
        }
      },
      "deploy": {
        "type": "s3-cloudfront",
        "dev": {
          "bucket": "jic-preprod-client",
          "distributionId": "E2D6TCOO4OB8VU"
        },
        "prod": {
          "bucket": "jic-test-client",
          "distributionId": "E3CD4EA3EWUX7E",
          "profile": "prod"
        }
      }
    },

    "joyincloud-gw-server": {
      "type": "java-service",
      "directory": "joyincloud-gw-server",
      "aliases": ["gws", "gateway"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerImage": "localhost:5000/joyincloudgatewayserver"
      },
      "deploy": {
        "type": "ecs",
        "dev": {
          "cluster": "jic-dev-cluster",
          "service": "gws-dev-service",
          "ecrRepo": "joyincloudgatewayserver",
          "ecrRegistry": "364420384910.dkr.ecr.eu-south-1.amazonaws.com"
        },
        "prod": {
          "cluster": "jic-test-cluster",
          "service": "gws-test-service",
          "ecrRepo": "joyincloudgatewayserver",
          "ecrRegistry": "963540619228.dkr.ecr.eu-south-1.amazonaws.com",
          "profile": "prod"
        }
      },
      "port": 8080
    },

    "joyincloud-mainservice": {
      "type": "java-service",
      "directory": "joyincloud-mainservice",
      "aliases": ["ms", "mainservice"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerImage": "localhost:5000/joyincloudmainservice"
      },
      "deploy": {
        "type": "ecs",
        "dev": {
          "cluster": "jic-dev-cluster",
          "service": "ms-dev-service",
          "ecrRepo": "joyincloudmainservice",
          "ecrRegistry": "364420384910.dkr.ecr.eu-south-1.amazonaws.com"
        },
        "prod": {
          "cluster": "jic-test-cluster",
          "service": "ms-test-service",
          "ecrRepo": "joyincloudmainservice",
          "ecrRegistry": "963540619228.dkr.ecr.eu-south-1.amazonaws.com",
          "profile": "prod"
        }
      },
      "port": 8081
    },

    "joyincloud-tenant-mainservice": {
      "type": "java-service",
      "directory": "joyincloud-tenant-mainservice",
      "aliases": ["tms", "tenant-main"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerImage": "localhost:5000/joyincloudtenantmainservice"
      },
      "deploy": {
        "type": "ecs",
        "dev": {
          "cluster": "jic-dev-cluster",
          "service": "tms-dev-service",
          "ecrRepo": "joyincloudtenantmainservice",
          "ecrRegistry": "364420384910.dkr.ecr.eu-south-1.amazonaws.com"
        },
        "prod": {
          "cluster": "jic-test-cluster",
          "service": "tms-test-service",
          "ecrRepo": "joyincloudtenantmainservice",
          "ecrRegistry": "963540619228.dkr.ecr.eu-south-1.amazonaws.com",
          "profile": "prod"
        }
      },
      "port": 8083,
      "dependencies": ["jic-tenant-mainsvc-client-flux"]
    },

    "joyincloud-tenant-agenda": {
      "type": "java-service",
      "directory": "joyincloud-tenant-agenda",
      "aliases": ["tas", "tenant-agenda", "agenda"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerImage": "localhost:5000/joyincloudtenantagenda"
      },
      "deploy": {
        "type": "ecs",
        "dev": {
          "cluster": "jic-dev-cluster",
          "service": "tas-dev-service",
          "ecrRepo": "joyincloudtenantagenda",
          "ecrRegistry": "364420384910.dkr.ecr.eu-south-1.amazonaws.com"
        },
        "prod": {
          "cluster": "jic-test-cluster",
          "service": "tas-test-service",
          "ecrRepo": "joyincloudtenantagenda",
          "ecrRegistry": "963540619228.dkr.ecr.eu-south-1.amazonaws.com",
          "profile": "prod"
        }
      },
      "port": 8082,
      "dependencies": ["jic-tenant-agenda-client-flux", "jic-tenant-mainsvc-client-flux"]
    },

    "joyincloud-tenant-notificationservice": {
      "type": "java-service",
      "directory": "joyincloud-tenant-notificationservice",
      "aliases": ["tns", "notifications"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true",
        "dockerImage": "localhost:5000/joyincloudtenantnotificationservice"
      },
      "deploy": {
        "type": "ecs",
        "dev": {
          "cluster": "jic-dev-cluster",
          "service": "tns-dev-service",
          "ecrRepo": "joyincloudtenantnotificationservice",
          "ecrRegistry": "364420384910.dkr.ecr.eu-south-1.amazonaws.com"
        },
        "prod": {
          "cluster": "jic-test-cluster",
          "service": "tns-test-service",
          "ecrRepo": "joyincloudtenantnotificationservice",
          "ecrRegistry": "963540619228.dkr.ecr.eu-south-1.amazonaws.com",
          "profile": "prod"
        }
      },
      "port": 8084,
      "dependencies": ["jic-tenant-mainsvc-client-flux", "whatsapp-service-client-flux"]
    },

    "jic-tenant-agenda-client-flux": {
      "type": "flux-client",
      "directory": "jic-tenant-agenda-client-flux",
      "aliases": ["flux-agenda", "taf"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install"
      },
      "targetService": "joyincloud-tenant-agenda"
    },

    "jic-tenant-mainsvc-client-flux": {
      "type": "flux-client",
      "directory": "jic-tenant-mainsvc-client-flux",
      "aliases": ["flux-mainsvc", "tmf"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install"
      },
      "targetService": "joyincloud-tenant-mainservice"
    },

    "whatsapp-service-client-flux": {
      "type": "flux-client",
      "directory": "whatsapp-service-client-flux",
      "aliases": ["flux-whatsapp", "waf"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "mvn clean install"
      },
      "targetService": "whatsapp-service-server"
    },

    "whatsapp-service-server": {
      "type": "node-service",
      "directory": "whatsapp-service-server",
      "aliases": ["whatsapp", "wa"],
      "branches": {
        "local": "feature/samuele",
        "dev": "origin/feature/samuele",
        "main": "origin/master"
      },
      "build": {
        "command": "npm run build"
      },
      "port": 3004
    },

    "aws-lambda-layer": {
      "type": "lambda-layer",
      "directory": "aws-lambda-layer",
      "aliases": ["layer", "lambda-layer"],
      "branches": {
        "local": "main",
        "dev": "origin/main",
        "main": "origin/main"
      },
      "build": {
        "command": "cd nodejs && npm install --production"
      },
      "deploy": {
        "type": "lambda-layer",
        "layerName": "jic-shared-layer",
        "dev": {
          "region": "eu-south-1"
        },
        "prod": {
          "region": "eu-south-1",
          "profile": "prod"
        }
      }
    },

    "aws-lambda-functions": {
      "type": "lambda-functions",
      "directory": "aws-lambda-functions",
      "aliases": ["lambdas", "functions"],
      "branches": {
        "local": "main",
        "dev": "origin/main",
        "main": "origin/main"
      },
      "functions": [
        "importClienti",
        "importProdotti",
        "importPagamenti",
        "importAccontiSospesi",
        "importMovimentiContabili",
        "jasperGenerator",
        "invioEmailSQSToSES",
        "mongoBackupToS3",
        "verifyLicenseStatus",
        "addTenantID"
      ],
      "deploy": {
        "type": "lambda",
        "dev": {
          "region": "eu-south-1"
        },
        "prod": {
          "region": "eu-south-1",
          "profile": "prod"
        }
      }
    }
  },

  "groups": {
    "@all": ["*"],
    "@backend": ["joyincloud-gw-server", "joyincloud-mainservice", "joyincloud-tenant-*"],
    "@frontend": ["joyincloud-gw-client"],
    "@flux": ["jic-*-flux", "whatsapp-service-client-flux"],
    "@java": ["joyincloud-*", "jic-*-flux"],
    "@node": ["whatsapp-service-server"],
    "@lambda": ["aws-lambda-*"],
    "@deployable": ["@backend", "@frontend", "@lambda"]
  },

  "buildOrder": [
    { "group": "@flux", "parallel": true },
    { "group": "@backend", "parallel": true },
    { "group": "@node", "parallel": true },
    { "group": "@frontend", "parallel": false }
  ],

  "aws": {
    "region": "eu-south-1",
    "dev": {
      "profile": "default",
      "accountId": "364420384910",
      "ecsCluster": "jic-dev-cluster",
      "ecrRegistry": "364420384910.dkr.ecr.eu-south-1.amazonaws.com"
    },
    "prod": {
      "profile": "prod",
      "accountId": "963540619228",
      "ecsCluster": "jic-test-cluster",
      "ecrRegistry": "963540619228.dkr.ecr.eu-south-1.amazonaws.com"
    }
  },

  "docker": {
    "localRegistry": "localhost:5000",
    "composeFile": "docker-compose.yml"
  },

  "defaults": {
    "branch": "feature/samuele",
    "environment": "dev",
    "failStrategy": "fail-fast"
  }
}
```

## Local Configuration Schema (`jic.local.json`)

```json
{
  "aws": {
    "dev": {
      "profile": "my-dev-profile"
    },
    "prod": {
      "profile": "my-prod-profile"
    }
  },
  "editor": "code",
  "terminal": "gnome-terminal",
  "notifications": {
    "enabled": true,
    "onBuildComplete": true,
    "onDeployComplete": true,
    "onError": true
  },
  "defaults": {
    "environment": "dev",
    "verbose": false
  }
}
```

## State File Schema (`jic.state.json`)

```json
{
  "version": "1.0.0",
  "lastUpdated": "2024-12-14T20:30:00Z",

  "sessions": {
    "importMerged": {
      "name": "importMerged",
      "description": "Import functionality merge",
      "createdAt": "2024-12-14T19:00:00Z",
      "status": "active",
      "baseBranch": "feature/samuele",
      "sessionBranch": "feature/importMerged",
      "modules": {
        "joyincloud-gw-client": {
          "branch": "feature/importMerged",
          "baseBranch": "feature/samuele",
          "mergedBranches": ["feature/importProdotti", "feature/importMovimentiContabili"]
        },
        "joyincloud-gw-server": {
          "branch": "feature/importMerged",
          "baseBranch": "feature/samuele",
          "mergedBranches": ["feature/importProdotti", "feature/importMovimentiContabili"]
        }
      },
      "plan": ".claude/plans/import-merged.md"
    }
  },

  "activeSession": "importMerged",

  "deployVersions": {
    "dev": {
      "joyincloud-gw-server": {
        "version": 45,
        "deployedAt": "2024-12-14T18:00:00Z",
        "commit": "abc123"
      },
      "joyincloud-tenant-mainservice": {
        "version": 42,
        "deployedAt": "2024-12-14T17:30:00Z",
        "commit": "def456"
      }
    },
    "prod": {
      "joyincloud-gw-server": {
        "version": 2.25,
        "deployedAt": "2024-12-10T10:00:00Z",
        "commit": "xyz789"
      }
    }
  },

  "lastDeploy": {
    "environment": "dev",
    "timestamp": "2024-12-14T18:00:00Z",
    "modules": ["joyincloud-gw-server"],
    "success": true
  },

  "buildCache": {
    "joyincloud-gw-server": {
      "lastBuild": "2024-12-14T17:45:00Z",
      "commit": "abc123",
      "success": true
    }
  }
}
```

## Environment Variables

The CLI respects the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `JIC_CONFIG` | Path to config file | `./jic.config.json` |
| `JIC_ENV` | Default environment | `dev` |
| `JIC_PROFILE` | AWS profile override | (from config) |
| `JIC_NO_COLOR` | Disable colored output | `false` |
| `JIC_VERBOSE` | Enable verbose output | `false` |
| `JIC_DRY_RUN` | Enable dry-run mode | `false` |

## Module Type Reference

### `frontend`
Angular/React applications deployed to S3 with CloudFront.

### `java-service`
Spring Boot microservices built with Maven, deployed as Docker containers to ECS.

### `flux-client`
Maven libraries providing type-safe WebClient interfaces for inter-service communication.

### `node-service`
Node.js services deployed to ECS or run locally.

### `lambda-layer`
Shared Lambda layer containing common dependencies.

### `lambda-functions`
Individual Lambda functions deployed via zip upload.
