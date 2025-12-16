/**
 * Core configuration types for JIC CLI
 *
 * These types define the structure of jic.config.json with support for:
 * - Configuration inheritance (defaults per module type)
 * - Environment-specific settings
 * - Type-safe module configuration
 */

// ============================================================================
// Enums and Constants
// ============================================================================

/**
 * Module types supported by the CLI
 */
export type ModuleType =
  | 'java-service'
  | 'flux-client'
  | 'frontend'
  | 'node-service'
  | 'lambda-layer'
  | 'lambda-functions';

/**
 * Deployment types
 */
export type DeployType = 'ecs' | 's3-cloudfront' | 'lambda' | 'lambda-layer';

/**
 * Environments
 */
export type Environment = 'dev' | 'staging' | 'prod';

/**
 * Failure handling strategy
 */
export type FailStrategy = 'fail-fast' | 'continue';

// ============================================================================
// Build Configuration
// ============================================================================

/**
 * Base build configuration
 */
export interface BuildConfig {
  /** Build command to execute */
  command: string;
  /** Command to run before build */
  preBuild?: string;
  /** Command to run after build */
  postBuild?: string;
  /** Command to clean build artifacts */
  cleanCommand?: string;
  /** Output directory for build artifacts */
  outputDir?: string;
  /** Environment variables for build */
  env?: Record<string, string>;
  /** Build timeout in milliseconds */
  timeout?: number;
}

/**
 * Docker build configuration (extends BuildConfig)
 */
export interface DockerBuildConfig extends BuildConfig {
  /** Command for Docker image build */
  dockerCommand: string;
  /** Docker image name/tag */
  dockerImage: string;
  /** Docker registry URL */
  registry?: string;
}

// ============================================================================
// Serve Configuration
// ============================================================================

/**
 * Service configuration for development mode
 */
export interface ServeConfig {
  /** Command to start the service */
  command: string;
  /** Health check command (curl, etc.) */
  healthCheck?: string;
  /** Health check path (appended to http://localhost:{port}) */
  healthCheckPath?: string;
  /** Startup timeout in milliseconds */
  startupTimeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Services that must start before this one */
  dependencies?: string[];
}

// ============================================================================
// Deploy Configuration
// ============================================================================

/**
 * Base deploy configuration
 */
export interface BaseDeployConfig {
  /** Deploy type */
  type: DeployType;
  /** AWS profile to use */
  profile?: string;
  /** AWS region */
  region?: string;
}

/**
 * ECS deployment configuration
 */
export interface EcsDeployConfig extends BaseDeployConfig {
  type: 'ecs';
  /** ECS cluster name */
  cluster: string;
  /** ECS service name */
  service: string;
  /** ECR repository name */
  ecrRepo: string;
  /** ECR registry URL */
  ecrRegistry: string;
}

/**
 * S3/CloudFront deployment configuration
 */
export interface S3DeployConfig extends BaseDeployConfig {
  type: 's3-cloudfront';
  /** S3 bucket name */
  bucket: string;
  /** CloudFront distribution ID */
  distributionId: string;
}

/**
 * Lambda deployment configuration
 */
export interface LambdaDeployConfig extends BaseDeployConfig {
  type: 'lambda';
  /** IAM role ARN for Lambda execution */
  role: string;
}

/**
 * Lambda Layer deployment configuration
 */
export interface LambdaLayerDeployConfig extends BaseDeployConfig {
  type: 'lambda-layer';
  /** Layer name */
  layerName: string;
}

/**
 * Union of all deploy configuration types
 */
export type DeployConfig =
  | EcsDeployConfig
  | S3DeployConfig
  | LambdaDeployConfig
  | LambdaLayerDeployConfig;

// ============================================================================
// Lambda-Specific Configuration
// ============================================================================

/**
 * Lambda function configuration
 */
export interface LambdaFunctionConfig {
  /** Runtime (e.g., nodejs20.x, python3.11) */
  runtime: string;
  /** Handler function */
  handler: string;
  /** Timeout in seconds */
  timeout: number;
  /** Memory size in MB */
  memorySize: number;
}

// ============================================================================
// Module Configuration
// ============================================================================

/**
 * Branch configuration for a module
 */
export interface BranchConfig {
  /** Local development branch */
  local: string;
  /** Development remote branch */
  dev: string;
  /** Main/production remote branch */
  main: string;
}

/**
 * Module configuration in jic.config.json
 * Build/serve/deploy configs are optional - defaults come from DefaultsConfig
 */
export interface ModuleConfig {
  /** Module type */
  type: ModuleType;
  /** Directory path relative to project root */
  directory: string;
  /** Short names for this module */
  aliases?: string[];
  /** Service port (for servable modules) */
  port?: number;
  /** Module dependencies (built before this module) */
  dependencies?: string[];
  /** Branch configuration */
  branches?: BranchConfig;

  /** Build config overrides (merged with defaults) */
  build?: Partial<BuildConfig & DockerBuildConfig>;
  /** Serve config overrides (merged with defaults) */
  serve?: Partial<ServeConfig>;
  /** Deploy config per environment */
  deploy?: {
    type?: DeployType;
    dev?: DeployConfig;
    staging?: DeployConfig;
    prod?: DeployConfig;
  };

  // Lambda-specific
  /** Lambda function names (for lambda-functions type) */
  functions?: string[];
  /** Default Lambda config */
  lambdaDefaults?: LambdaFunctionConfig;
  /** Per-function config overrides */
  functionConfig?: Record<string, Partial<LambdaFunctionConfig>>;
  /** Target service (for flux-client type) */
  targetService?: string;
}

// ============================================================================
// Defaults Configuration
// ============================================================================

/**
 * Default configurations per module type
 * This is the key to eliminating configuration verbosity
 */
export interface DefaultsConfig {
  /** Default branch for new sessions */
  branch: string;
  /** Default environment */
  environment: Environment;
  /** Default failure handling strategy */
  failStrategy: FailStrategy;

  /** Default build configs per module type */
  build: {
    'java-service'?: BuildConfig & Partial<DockerBuildConfig>;
    'flux-client'?: BuildConfig;
    'frontend'?: BuildConfig;
    'node-service'?: BuildConfig;
    'lambda-layer'?: BuildConfig;
    'lambda-functions'?: BuildConfig;
  };

  /** Default serve configs per module type */
  serve: {
    'java-service'?: ServeConfig;
    'frontend'?: ServeConfig;
    'node-service'?: ServeConfig;
  };

  /** Default deploy configs per deploy type and environment */
  deploy: {
    ecs?: {
      dev?: Partial<EcsDeployConfig>;
      staging?: Partial<EcsDeployConfig>;
      prod?: Partial<EcsDeployConfig>;
    };
    's3-cloudfront'?: {
      dev?: Partial<S3DeployConfig>;
      staging?: Partial<S3DeployConfig>;
      prod?: Partial<S3DeployConfig>;
    };
    lambda?: {
      dev?: Partial<LambdaDeployConfig>;
      staging?: Partial<LambdaDeployConfig>;
      prod?: Partial<LambdaDeployConfig>;
    };
    'lambda-layer'?: {
      dev?: Partial<LambdaLayerDeployConfig>;
      staging?: Partial<LambdaLayerDeployConfig>;
      prod?: Partial<LambdaLayerDeployConfig>;
    };
  };
}

// ============================================================================
// AWS Configuration
// ============================================================================

/**
 * AWS environment-specific configuration
 */
export interface AwsEnvironmentConfig {
  /** AWS CLI profile */
  profile?: string;
  /** AWS account ID */
  accountId?: string;
  /** ECS cluster name */
  ecsCluster?: string;
  /** ECR registry URL */
  ecrRegistry?: string;
  /** CloudWatch log group */
  logGroup?: string;
}

/**
 * AWS configuration section
 */
export interface AwsConfig {
  /** Default region */
  region: string;
  /** Dev environment config */
  dev: AwsEnvironmentConfig;
  /** Staging environment config */
  staging?: AwsEnvironmentConfig;
  /** Production environment config */
  prod: AwsEnvironmentConfig;
}

// ============================================================================
// Serve/Docker Configuration
// ============================================================================

/**
 * Infrastructure service configuration
 */
export interface InfraServiceConfig {
  /** Port number */
  port: number;
  /** Docker container name */
  container: string;
  /** Health check command */
  healthCheck: string;
}

/**
 * Global serve configuration
 */
export interface ServeGlobalConfig {
  /** Docker compose file for infrastructure */
  infraComposeFile?: string;
  /** Default serve mode */
  defaultMode?: 'native' | 'docker';
  /** Logs directory */
  logsDir?: string;
  /** Default serve options */
  defaults?: {
    startInfra?: boolean;
    localstack?: boolean;
    sequential?: boolean;
    startupDelay?: number;
  };
  /** Infrastructure services configuration */
  infrastructure?: Record<string, InfraServiceConfig>;
  /** Docker service name mapping */
  dockerServiceNames?: Record<string, string>;
}

/**
 * Docker configuration section
 */
export interface DockerConfig {
  /** Local Docker registry URL */
  localRegistry?: string;
  /** Docker compose file path */
  composeFile?: string;
}

// ============================================================================
// Build Order Configuration
// ============================================================================

/**
 * Build order entry
 */
export interface BuildOrderEntry {
  /** Group to build */
  group: string;
  /** Whether to build in parallel */
  parallel: boolean;
}

// ============================================================================
// Project Configuration
// ============================================================================

/**
 * Project metadata
 */
export interface ProjectConfig {
  /** Project name */
  name: string;
  /** Project description */
  description?: string;
  /** Root directory (usually ".") */
  rootDir: string;
}

// ============================================================================
// Main Configuration Interface
// ============================================================================

/**
 * Complete JIC configuration file structure
 * This is the root type for jic.config.json
 */
export interface JicConfig {
  /** JSON schema reference */
  $schema?: string;
  /** Config version */
  version: string;

  /** Project metadata */
  project: ProjectConfig;

  /** Default configurations per type */
  defaults: DefaultsConfig;

  /** Module configurations */
  modules: Record<string, ModuleConfig>;

  /** Module groups */
  groups: Record<string, string[]>;

  /** Build order */
  buildOrder?: BuildOrderEntry[];

  /** AWS configuration */
  aws: AwsConfig;

  /** Serve configuration */
  serve?: ServeGlobalConfig;

  /** Docker configuration */
  docker?: DockerConfig;
}

// ============================================================================
// Config File Paths
// ============================================================================

/**
 * Paths to configuration files
 */
export interface ConfigPaths {
  /** Main config file */
  config: string;
  /** Local overrides file */
  localConfig: string;
  /** State file */
  state: string;
}
