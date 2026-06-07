/**
 * Built-in default configurations per module type
 *
 * These defaults eliminate the need to repeat common configuration
 * in jic.config.json. Modules only need to override what differs.
 */

import type {
  DefaultsConfig,
  BuildConfig,
  DockerBuildConfig,
  ServeConfig,
  Environment,
  BranchConfig,
  SessionTemplateConfig,
} from '../types/config.js';

// ============================================================================
// Build Defaults
// ============================================================================

/**
 * Default build config for Java services
 */
export const javaServiceBuildDefaults: BuildConfig & Partial<DockerBuildConfig> = {
  command: 'mvn clean install -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true',
  dockerCommand: 'mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true',
  cleanCommand: 'mvn clean',
  timeout: 300000, // 5 minutes
};

/**
 * Default build config for flux clients
 */
export const fluxClientBuildDefaults: BuildConfig = {
  command: 'mvn clean install',
  cleanCommand: 'mvn clean',
  timeout: 120000, // 2 minutes
};

/**
 * Default build config for frontend
 */
export const frontendBuildDefaults: BuildConfig = {
  command: 'npm run build',
  cleanCommand: 'rm -rf node_modules/.cache .angular/cache target/angular target/classes/static',
  outputDir: 'target/classes/static',
  env: {
    NODE_OPTIONS: '--max_old_space_size=4096',
  },
  timeout: 300000, // 5 minutes
};

/**
 * Default build config for Node services
 */
export const nodeServiceBuildDefaults: BuildConfig = {
  command: 'npm run build',
  timeout: 60000, // 1 minute
};

/**
 * Default build config for Lambda layer
 */
export const lambdaLayerBuildDefaults: BuildConfig = {
  command: 'cd nodejs && npm install --production',
  timeout: 60000,
};

/**
 * Default build config for Lambda functions
 */
export const lambdaFunctionsBuildDefaults: BuildConfig = {
  command: 'zip -r function.zip .',
  timeout: 60000,
};

// ============================================================================
// Serve Defaults
// ============================================================================

/**
 * Default serve config for Java services
 */
export const javaServiceServeDefaults: ServeConfig = {
  command: 'mvn -q -DskipTests spring-boot:run -Dspring-boot.run.fork=false -Dspring-boot.run.profiles=dev',
  healthCheckPath: '/management/health',
  startupTimeout: 80000, // 80 seconds
};

/**
 * Default serve config for frontend
 */
export const frontendServeDefaults: ServeConfig = {
  command: 'ng serve',
  healthCheckPath: '/',
  startupTimeout: 60000,
  env: {
    NODE_OPTIONS: '--max_old_space_size=4096',
  },
};

/**
 * Default serve config for Node services
 */
export const nodeServiceServeDefaults: ServeConfig = {
  command: 'npm run dev',
  healthCheckPath: '/health',
  startupTimeout: 30000,
};

// ============================================================================
// Deploy Defaults
// ============================================================================

/**
 * Default ECS deploy config per environment
 */
export const ecsDeployDefaults: Record<Environment, { profile?: string }> = {
  dev: { profile: 'default' },
  staging: { profile: 'staging' },
  prod: { profile: 'prod' },
};

/**
 * Default S3/CloudFront deploy config per environment
 */
export const s3DeployDefaults: Record<Environment, { profile?: string }> = {
  dev: { profile: 'default' },
  staging: { profile: 'staging' },
  prod: { profile: 'prod' },
};

/**
 * Default Lambda deploy config per environment
 */
export const lambdaDeployDefaults: Record<Environment, { profile?: string; region?: string }> = {
  dev: { profile: 'default', region: 'eu-south-1' },
  staging: { profile: 'staging', region: 'eu-south-1' },
  prod: { profile: 'prod', region: 'eu-south-1' },
};

/**
 * Default Kubernetes deploy config per environment
 */
export const kubernetesDeployDefaults: Record<Environment, Record<string, never>> = {
  dev: {},
  staging: {},
  prod: {},
};

// ============================================================================
// Complete Defaults
// ============================================================================

/**
 * Complete built-in defaults configuration
 */
export const builtInDefaults: DefaultsConfig = {
  branches: {
    local: 'main',
    dev: 'origin/main',
    main: 'origin/main',
  },
  environment: 'dev',
  failStrategy: 'fail-fast',

  build: {
    'java-service': javaServiceBuildDefaults,
    'flux-client': fluxClientBuildDefaults,
    'frontend': frontendBuildDefaults,
    'node-service': nodeServiceBuildDefaults,
    'lambda-layer': lambdaLayerBuildDefaults,
    'lambda-functions': lambdaFunctionsBuildDefaults,
  },

  serve: {
    'java-service': javaServiceServeDefaults,
    'frontend': frontendServeDefaults,
    'node-service': nodeServiceServeDefaults,
  },

  deploy: {
    ecs: ecsDeployDefaults,
    's3-cloudfront': s3DeployDefaults,
    lambda: lambdaDeployDefaults,
    'lambda-layer': lambdaDeployDefaults,
    kubernetes: kubernetesDeployDefaults,
  },
};

// ============================================================================
// Session Template Defaults
// ============================================================================

/**
 * Template di sessione built-in, disponibili in ogni progetto senza doverli
 * definire in jic.config.json. Servono a scegliere il PREFISSO del branch
 * (`<prefix>/<nome-sessione>`); non vincolano i moduli (`moduleGroups: []` =
 * tutti i moduli) né il base branch (omesso = default per-modulo).
 *
 * Sono solo i default: un progetto può ridefinire/aggiungere template in
 * jic.config.json sotto "templates" (quelli dell'utente hanno precedenza).
 * Per i progetti vendor/submodules il prefisso del branch è gestito dal vendor
 * e questi prefissi non si applicano.
 */
export const builtInTemplates: Record<string, SessionTemplateConfig> = {
  feature: {
    description: 'Feature di prodotto',
    moduleGroups: [],
    branchPrefix: 'feature/',
  },
  api: {
    description: 'Lavoro su API',
    moduleGroups: [],
    branchPrefix: 'api/',
  },
  bugfix: {
    description: 'Correzione bug',
    moduleGroups: [],
    branchPrefix: 'bugfix/',
  },
  backend: {
    description: 'Lavoro backend',
    moduleGroups: [],
    branchPrefix: 'backend/',
  },
};

/**
 * Get default build config for a module type
 */
export function getDefaultBuildConfig(type: string): BuildConfig | undefined {
  return builtInDefaults.build[type as keyof typeof builtInDefaults.build];
}

/**
 * Get default serve config for a module type
 */
export function getDefaultServeConfig(type: string): ServeConfig | undefined {
  return builtInDefaults.serve[type as keyof typeof builtInDefaults.serve];
}
