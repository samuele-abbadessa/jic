/**
 * Deploy Command
 *
 * Unified deploy command following the pattern: jic deploy [modules...] [options]
 *
 * Examples:
 *   jic deploy gws tms             # Deploy specific services
 *   jic deploy @backend            # Deploy backend group
 *   jic deploy --env prod          # Deploy to production
 *   jic deploy status              # Show deployment status
 *   jic deploy status --refresh    # Refresh from AWS
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { ResolvedModule } from '../core/types/module.js';
import type { Environment } from '../core/types/config.js';
import { DeployError, withErrorHandling } from '../core/errors/index.js';
import { exec, execOrThrow, ExecError, getGitCommit } from '../core/utils/shell.js';
import { colors, formatDuration } from '../core/utils/output.js';

// ============================================================================
// Types
// ============================================================================

interface DeployOptions {
  version?: string;
  build?: boolean;
  wait?: boolean;
  waitSequential?: boolean;
  parallel?: boolean;
  withDeps?: boolean;
  skipTests?: boolean;
  invalidate?: boolean;
  create?: boolean;
}

interface LocalDeploymentRecord {
  version: string;
  commit: string;
  deployedAt: string;
  status: 'deployed' | 'failed';
}

/**
 * Result from deploying a single module, used to track which services need stabilization wait
 */
interface DeployResult {
  module: ResolvedModule;
  version: string;
  success: boolean;
  error?: Error;
  /** For ECS deployments, contains info needed to wait for stabilization */
  ecsWaitInfo?: {
    cluster: string;
    service: string;
    profile?: string;
  };
  /** For Kubernetes deployments, contains info needed to wait for stabilization */
  k8sWaitInfo?: {
    namespace: string;
    deployment: string;
    kubeconfig?: string;
    context?: string;
  };
}

/**
 * Track stabilization status for a module
 */
interface StabilizationStatus {
  moduleName: string;
  status: 'pending' | 'waiting' | 'stable' | 'failed';
  startTime?: number;
}

// ============================================================================
// Deploy Command Registration
// ============================================================================

export function registerDeployCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const deploy = program.command('deploy').description('Deployment operations');

  // Main deploy command - handles all module types
  deploy
    .command('run')
    .description('Deploy modules to environment (auto-detects type: ECS, S3, Lambda)')
    .argument('[modules...]', 'Modules to deploy (names, aliases, or @groups: @backend, @frontend, @lambda)')
    .option('-v, --version <n>', 'Version number')
    .option('--no-build', 'Skip building before deploy')
    .option('--skip-tests', 'Skip tests during build phase')
    .option('--wait', 'Wait for all deployments to stabilize (at the end)')
    .option('--no-parallel', 'Deploy modules sequentially instead of in parallel')
    .option('--wait-sequential', 'Wait for each module to stabilize before deploying the next (requires --no-parallel)')
    .option('--with-deps', 'Build dependencies first (flux clients, lambda layer)')
    .option('--no-invalidate', 'Skip CloudFront invalidation (for frontend)')
    .option('--create', 'Create Lambda function if not exists')
    .action(
      withErrorHandling(async (modules: string[], options: DeployOptions) => {
        const ctx = await createContext();
        await executeDeploy(ctx, modules, options);
      })
    );

  // Deploy status
  deploy
    .command('status')
    .description('Show deployment status')
    .option('--refresh', 'Refresh status from AWS')
    .option('--all', 'Show all environments')
    .option('--details', 'Show detailed info (ECR image tags, task definitions)')
    .action(
      withErrorHandling(
        async (options: { refresh?: boolean; all?: boolean; details?: boolean }) => {
          const ctx = await createContext();
          await deployStatus(ctx, options);
        }
      )
    );

  // Aliases for convenience (deprecated - will show warning)
  deploy
    .command('backend [services...]')
    .description('[Deprecated] Use "deploy run @backend" instead')
    .option('--no-build', 'Skip building')
    .option('--skip-tests', 'Skip tests during build')
    .option('--wait', 'Wait for deployment')
    .action(
      withErrorHandling(async (services: string[], options: DeployOptions) => {
        const ctx = await createContext();
        ctx.output.warning('Deprecated: Use "jic deploy run @backend" instead');
        ctx.output.newline();
        const modules = services.length > 0 ? services : ['@backend'];
        await executeDeploy(ctx, modules, { ...options, build: options.build !== false });
      })
    );

  deploy
    .command('frontend')
    .description('[Deprecated] Use "deploy run @frontend" instead')
    .option('--no-build', 'Skip building')
    .option('--skip-tests', 'Skip tests during build')
    .option('--no-invalidate', 'Skip CloudFront invalidation')
    .action(
      withErrorHandling(async (options: DeployOptions) => {
        const ctx = await createContext();
        ctx.output.warning('Deprecated: Use "jic deploy run @frontend" instead');
        ctx.output.newline();
        await executeDeploy(ctx, ['@frontend'], options);
      })
    );

  // Deploy Lambda functions (individual or all)
  deploy
    .command('lambda [functions...]')
    .description('Deploy Lambda function(s)')
    .option('--with-deps', 'Deploy layer first')
    .option('--skip-tests', 'Skip tests during build')
    .option('--create', 'Create function if not exists')
    .action(
      withErrorHandling(async (functions: string[], options: DeployOptions) => {
        const ctx = await createContext();
        await deployLambdaFunctions(ctx, functions, options);
      })
    );

  // Deploy Lambda layer
  deploy
    .command('lambda-layer')
    .description('Deploy Lambda layer')
    .action(
      withErrorHandling(async (options: DeployOptions) => {
        const ctx = await createContext();
        const layerModule = ctx.getModule('aws-lambda-layer');
        if (!layerModule) {
          throw new DeployError('Lambda layer module not found');
        }
        const env = ctx.env;
        ctx.output.header(`Deploy Lambda Layer → ${env}`);
        await deployLambdaLayerModule(ctx, layerModule, env, options);
      })
    );
}

// ============================================================================
// Deploy Execution
// ============================================================================

async function executeDeploy(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: DeployOptions
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);
  const env = ctx.env;

  // Filter to deployable modules
  const deployable = modules.filter((m) => m.resolvedDeploy?.[env]);

  if (deployable.length === 0) {
    ctx.output.warning(`No deployable modules found for environment: ${env}`);
    return;
  }

  // Validate options
  if (options.waitSequential && options.parallel !== false) {
    ctx.output.warning('--wait-sequential requires --no-parallel, ignoring');
  }

  const isParallel = options.parallel !== false;
  const waitSequential = options.waitSequential && !isParallel;

  ctx.output.header(`Deploy to ${env}`);
  ctx.output.keyValue('Modules', deployable.map((m) => m.name).join(', '));
  ctx.output.keyValue('Environment', env);
  ctx.output.keyValue('Mode', isParallel ? 'parallel' : 'sequential');
  if (options.wait) {
    ctx.output.keyValue('Wait', waitSequential ? 'after each module' : 'all at end');
  }
  ctx.output.newline();

  const results: DeployResult[] = [];
  let success = 0;
  let failed = 0;

  if (isParallel) {
    // Deploy all modules in parallel
    const deployPromises = deployable.map(async (module) => {
      try {
        const result = await deployModule(ctx, module, env, options);
        return result;
      } catch (error) {
        return {
          module,
          version: options.version ?? 'unknown',
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        } as DeployResult;
      }
    });

    const allResults = await Promise.all(deployPromises);
    results.push(...allResults);

    for (const result of allResults) {
      if (result.success) {
        success++;
      } else {
        failed++;
        if (ctx.failStrategy === 'fail-fast' && result.error) {
          throw result.error;
        }
        if (result.error) {
          ctx.output.error(`Failed to deploy ${result.module.name}: ${result.error.message}`);
        }
      }
    }
  } else {
    // Deploy sequentially
    for (const module of deployable) {
      try {
        const result = await deployModule(ctx, module, env, options);
        results.push(result);
        success++;

        // If --wait-sequential, wait for this module before continuing
        if (waitSequential && !ctx.dryRun) {
          await waitForModuleStabilization(ctx, result);
        }
      } catch (error) {
        failed++;
        results.push({
          module,
          version: options.version ?? 'unknown',
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });

        if (ctx.failStrategy === 'fail-fast') {
          throw error;
        }
        if (error instanceof Error) {
          ctx.output.error(`Failed to deploy ${module.name}: ${error.message}`);
        }
      }
    }
  }

  // Wait for all services at the end if --wait is set (and not --wait-sequential)
  if (options.wait && !waitSequential && !ctx.dryRun) {
    await waitForAllStabilization(ctx, results);
  }

  ctx.output.newline();
  ctx.output.info(`Deploy complete: ${success} succeeded, ${failed} failed`);
}

async function deployModule(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  options: DeployOptions
): Promise<DeployResult> {
  const deployConfig = module.resolvedDeploy?.[env];
  if (!deployConfig) {
    throw new DeployError(`No deploy config for ${module.name} in ${env}`, {
      moduleName: module.name,
    });
  }

  const startTime = Date.now();

  ctx.output.subheader(`Deploying ${module.name}`);

  // Get version
  const version = options.version ?? getNextVersion(ctx, module.name, env);
  ctx.output.keyValue('Version', version);

  let ecsWaitInfo: DeployResult['ecsWaitInfo'];
  let k8sWaitInfo: DeployResult['k8sWaitInfo'];

  // Determine deploy type based on deploy config type (not module type)
  // This allows node-services to deploy to ECS just like java-services
  switch (deployConfig.type) {
    case 'ecs':
      ecsWaitInfo = await deployEcs(ctx, module, env, version, options);
      break;
    case 'kubernetes':
      k8sWaitInfo = await deployKubernetes(ctx, module, env, version, options);
      break;
    case 's3-cloudfront':
      await deployS3CloudFront(ctx, module, env, options);
      break;
    case 'lambda-layer':
      await deployLambdaLayerModule(ctx, module, env, options);
      break;
    case 'lambda':
      // Lambda functions module - deploy all configured functions
      if (module.functions && module.functions.length > 0) {
        for (const functionName of module.functions) {
          await deploySingleLambdaFunction(ctx, module, functionName, env, options);
        }
      } else {
        throw new DeployError(
          `Lambda module ${module.name} has no functions configured`,
          { moduleName: module.name }
        );
      }
      break;
    default:
      // This should never be reached if all deploy types are handled above
      throw new DeployError(`Unsupported deploy type: ${(deployConfig as { type: string }).type}`, {
        moduleName: module.name,
      });
  }

  // Update deployment state (skip for lambda types - they handle state internally)
  if (!ctx.dryRun && deployConfig.type !== 'lambda' && deployConfig.type !== 'lambda-layer') {
    const commit = await getGitCommit(module.absolutePath);
    await updateDeploymentState(ctx, module.name, env, {
      version,
      commit: commit ?? 'unknown',
      deployedAt: new Date().toISOString(),
      status: 'deployed',
    });
  }

  const duration = Date.now() - startTime;
  ctx.output.success(`Deployed ${module.name} v${version} (${formatDuration(duration)})`);

  return {
    module,
    version,
    success: true,
    ecsWaitInfo,
    k8sWaitInfo,
  };
}

// ============================================================================
// ECS Deployment
// ============================================================================

async function deployEcs(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  version: string,
  options: DeployOptions
): Promise<DeployResult['ecsWaitInfo']> {
  const deployConfig = module.resolvedDeploy?.[env];
  const awsConfig = ctx.getAwsConfig(env);

  if (!deployConfig || deployConfig.type !== 'ecs') {
    throw new DeployError(`Invalid ECS config for ${module.name}`, { moduleName: module.name });
  }

  const ecsConfig = deployConfig;
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  // Build Docker image if needed
  if (options.build !== false && module.resolvedBuild?.dockerCommand) {
    const buildSpinner = ctx.output.spinner('Building Docker image');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build Docker image');
      } else {
        // Add skip tests flag if requested (already in dockerCommand for most cases)
        let buildCmd = module.resolvedBuild.dockerCommand;
        if (options.skipTests && !buildCmd.includes('-DskipTests')) {
          buildCmd = buildCmd.replace('mvn ', 'mvn -DskipTests=true ');
        }
        await execOrThrow(buildCmd, {
          cwd: module.absolutePath,
          silent: true,
        });
        buildSpinner.succeed('Docker image built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      // Show build error details
      if (error instanceof ExecError) {
        if (error.stderr) {
          ctx.output.error(`\n${error.stderr}`);
        }
        if (error.stdout) {
          ctx.output.error(`\n${error.stdout}`);
        }
      }
      throw new DeployError('Docker build failed', { moduleName: module.name });
    }
  }

  // Login to ECR
  const loginSpinner = ctx.output.spinner('Logging in to ECR');
  loginSpinner.start();

  try {
    if (ctx.dryRun) {
      loginSpinner.info('[dry-run] Would login to ECR');
    } else {
      await exec(
        `aws ecr get-login-password --region ${region} ${profile} | docker login --username AWS --password-stdin ${ecsConfig.ecrRegistry}`,
        { silent: true }
      );
      loginSpinner.succeed('Logged in to ECR');
    }
  } catch (error) {
    loginSpinner.fail('ECR login failed');
    throw new DeployError('ECR login failed', { moduleName: module.name });
  }

  // Tag and push image
  const pushSpinner = ctx.output.spinner('Pushing image to ECR');
  pushSpinner.start();

  const localImage = module.resolvedBuild?.dockerImage;
  const remoteImage = `${ecsConfig.ecrRegistry}/${ecsConfig.ecrRepo}`;

  try {
    if (ctx.dryRun) {
      pushSpinner.info(`[dry-run] Would push ${remoteImage}:${version}`);
    } else {
      await exec(`docker tag ${localImage} ${remoteImage}:${version}`, { silent: true });
      await exec(`docker tag ${localImage} ${remoteImage}:latest`, { silent: true });
      await exec(`docker push ${remoteImage}:${version}`, { silent: true });
      await exec(`docker push ${remoteImage}:latest`, { silent: true });
      pushSpinner.succeed(`Pushed ${remoteImage}:${version}`);
    }
  } catch (error) {
    pushSpinner.fail('Push failed');
    throw new DeployError('Push to ECR failed', { moduleName: module.name });
  }

  // Update ECS service
  const deploySpinner = ctx.output.spinner('Updating ECS service');
  deploySpinner.start();

  try {
    if (ctx.dryRun) {
      deploySpinner.info(`[dry-run] Would update ${ecsConfig.service}`);
    } else {
      await exec(
        `aws ecs update-service --no-cli-pager --region ${region} --cluster ${ecsConfig.cluster} --service ${ecsConfig.service} --force-new-deployment ${profile}`,
        { silent: true }
      );
      deploySpinner.succeed(`Updated ${ecsConfig.service}`);
    }
  } catch (error) {
    deploySpinner.fail('ECS update failed');
    throw new DeployError('ECS update failed', { moduleName: module.name });
  }

  // Return ECS wait info for later stabilization wait
  return {
    cluster: ecsConfig.cluster,
    service: ecsConfig.service,
    profile: awsConfig.profile,
  };
}

// ============================================================================
// ECS Stabilization Wait
// ============================================================================

/**
 * Wait for a single ECS service to stabilize
 */
async function waitForEcsStabilization(
  ctx: IExecutionContext,
  waitInfo: NonNullable<DeployResult['ecsWaitInfo']>
): Promise<{ success: boolean; error?: string }> {
  const region = ctx.config.aws.region;
  const profile = waitInfo.profile ? `--profile ${waitInfo.profile}` : '';

  try {
    await exec(
      `aws ecs wait services-stable --region ${region} --cluster ${waitInfo.cluster} --services ${waitInfo.service} ${profile}`,
      { silent: true, timeout: 600000 }
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Stabilization failed',
    };
  }
}

/**
 * Wait for all ECS services to stabilize, showing progress
 */
async function waitForAllStabilization(
  ctx: IExecutionContext,
  results: DeployResult[]
): Promise<void> {
  const waitableResults = results.filter((r) => r.success && (r.ecsWaitInfo || r.k8sWaitInfo));

  if (waitableResults.length === 0) {
    return;
  }

  ctx.output.newline();
  ctx.output.subheader('Waiting for services to stabilize');

  // Initialize status tracking
  const statuses: Map<string, StabilizationStatus> = new Map();
  for (const result of waitableResults) {
    statuses.set(result.module.name, {
      moduleName: result.module.name,
      status: 'waiting',
      startTime: Date.now(),
    });
  }

  // Display initial status
  const displayStatus = () => {
    const lines: string[] = [];
    for (const [name, status] of statuses) {
      let statusText: string;
      switch (status.status) {
        case 'waiting':
          statusText = colors.warning('waiting...');
          break;
        case 'stable':
          statusText = colors.success('stable');
          break;
        case 'failed':
          statusText = colors.error('failed');
          break;
        default:
          statusText = colors.muted('pending');
      }
      lines.push(`  ${ctx.output.module(name)}: ${statusText}`);
    }
    return lines;
  };

  // Start all wait operations in parallel
  const waitPromises = waitableResults.map(async (result) => {
    let waitResult: { success: boolean; error?: string };

    if (result.ecsWaitInfo) {
      waitResult = await waitForEcsStabilization(ctx, result.ecsWaitInfo);
    } else if (result.k8sWaitInfo) {
      waitResult = await waitForK8sStabilization(ctx, result.k8sWaitInfo);
    } else {
      waitResult = { success: true };
    }

    const status = statuses.get(result.module.name)!;
    status.status = waitResult.success ? 'stable' : 'failed';

    return { moduleName: result.module.name, ...waitResult };
  });

  // Show a spinner while waiting
  const spinner = ctx.output.spinner('Waiting for all services');
  spinner.start();

  const waitResults = await Promise.all(waitPromises);
  spinner.stop();

  // Display final status
  const statusLines = displayStatus();
  for (const line of statusLines) {
    ctx.output.info(line);
  }

  // Check for failures
  const failures = waitResults.filter((r) => !r.success);
  if (failures.length > 0) {
    ctx.output.newline();
    for (const failure of failures) {
      ctx.output.error(`${failure.moduleName}: ${failure.error}`);
    }
    throw new DeployError(
      `${failures.length} service(s) failed to stabilize: ${failures.map((f) => f.moduleName).join(', ')}`
    );
  }

  ctx.output.newline();
  ctx.output.success('All services stabilized');
}

/**
 * Wait for a single module to stabilize (for sequential wait mode)
 */
async function waitForModuleStabilization(
  ctx: IExecutionContext,
  result: DeployResult
): Promise<void> {
  if (!result.ecsWaitInfo && !result.k8sWaitInfo) {
    return;
  }

  const spinner = ctx.output.spinner(`Waiting for ${result.module.name} to stabilize`);
  spinner.start();

  let waitResult: { success: boolean; error?: string };

  if (result.ecsWaitInfo) {
    waitResult = await waitForEcsStabilization(ctx, result.ecsWaitInfo);
  } else if (result.k8sWaitInfo) {
    waitResult = await waitForK8sStabilization(ctx, result.k8sWaitInfo);
  } else {
    return;
  }

  if (waitResult.success) {
    spinner.succeed(`${result.module.name} stabilized`);
  } else {
    spinner.fail(`${result.module.name} failed to stabilize`);
    throw new DeployError(`Service failed to stabilize: ${waitResult.error}`, {
      moduleName: result.module.name,
    });
  }
}

// ============================================================================
// Kubernetes Deployment
// ============================================================================

async function deployKubernetes(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  version: string,
  options: DeployOptions
): Promise<DeployResult['k8sWaitInfo']> {
  const deployConfig = module.resolvedDeploy?.[env];
  const k8sConfig = ctx.getK8sConfig(env);

  if (!deployConfig || deployConfig.type !== 'kubernetes') {
    throw new DeployError(`Invalid Kubernetes config for ${module.name}`, { moduleName: module.name });
  }

  const registry = deployConfig.registry ?? k8sConfig.registry;
  if (!registry) {
    throw new DeployError(`No container registry configured for ${module.name}`, { moduleName: module.name });
  }

  const namespace = deployConfig.namespace ?? k8sConfig.namespace ?? 'default';
  const imageName = deployConfig.image ?? module.name;
  const remoteImage = `${registry}/${imageName}`;
  const kubeconfigFlag = k8sConfig.kubeconfig ? `--kubeconfig ${k8sConfig.kubeconfig}` : '';
  const contextFlag = k8sConfig.context ? `--context ${k8sConfig.context}` : '';
  const kubectlBase = `kubectl ${kubeconfigFlag} ${contextFlag}`.trim();

  // Build Docker image if needed
  if (options.build !== false) {
    const buildSpinner = ctx.output.spinner('Building Docker image');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build Docker image');
      } else {
        const buildCmd = module.resolvedBuild?.dockerCommand
          ? module.resolvedBuild.dockerCommand
          : `docker build -t ${remoteImage}:${version} .`;

        await execOrThrow(buildCmd, {
          cwd: module.absolutePath,
          silent: true,
        });
        buildSpinner.succeed('Docker image built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      if (error instanceof ExecError) {
        if (error.stderr) ctx.output.error(`\n${error.stderr}`);
        if (error.stdout) ctx.output.error(`\n${error.stdout}`);
      }
      throw new DeployError('Docker build failed', { moduleName: module.name });
    }
  }

  // Login to registry
  const loginSpinner = ctx.output.spinner(`Logging in to ${registry}`);
  loginSpinner.start();

  try {
    if (ctx.dryRun) {
      loginSpinner.info('[dry-run] Would login to registry');
    } else {
      await exec(`docker login ${registry}`, { silent: true });
      loginSpinner.succeed(`Logged in to ${registry}`);
    }
  } catch (error) {
    loginSpinner.fail('Registry login failed');
    throw new DeployError('Registry login failed', { moduleName: module.name });
  }

  // Tag and push image
  const pushSpinner = ctx.output.spinner('Pushing image to registry');
  pushSpinner.start();

  const localImage = module.resolvedBuild?.dockerImage ?? `${remoteImage}:${version}`;

  try {
    if (ctx.dryRun) {
      pushSpinner.info(`[dry-run] Would push ${remoteImage}:${version}`);
    } else {
      await exec(`docker tag ${localImage} ${remoteImage}:${version}`, { silent: true });
      await exec(`docker tag ${localImage} ${remoteImage}:latest`, { silent: true });
      await exec(`docker push ${remoteImage}:${version}`, { silent: true });
      await exec(`docker push ${remoteImage}:latest`, { silent: true });
      pushSpinner.succeed(`Pushed ${remoteImage}:${version}`);
    }
  } catch (error) {
    pushSpinner.fail('Push failed');
    throw new DeployError('Push to registry failed', { moduleName: module.name });
  }

  // Update Kubernetes deployment
  const deploySpinner = ctx.output.spinner('Updating Kubernetes deployment');
  deploySpinner.start();

  try {
    if (ctx.dryRun) {
      deploySpinner.info(`[dry-run] Would update deployment ${deployConfig.deployment}`);
    } else {
      // Set the new image on the deployment
      await exec(
        `${kubectlBase} -n ${namespace} set image deployment/${deployConfig.deployment} ${deployConfig.deployment}=${remoteImage}:${version}`,
        { silent: true }
      );
      deploySpinner.succeed(`Updated deployment ${deployConfig.deployment}`);
    }
  } catch (error) {
    deploySpinner.fail('Kubernetes update failed');
    throw new DeployError('Kubernetes deployment update failed', { moduleName: module.name });
  }

  // Update deployment state with K8s-specific info
  if (!ctx.dryRun) {
    const record = ctx.config.state.deployments[env]?.[module.name];
    if (record) {
      record.k8sNamespace = namespace;
      record.k8sDeployment = deployConfig.deployment;
      record.k8sImageTag = version;
    }
  }

  return {
    namespace,
    deployment: deployConfig.deployment,
    kubeconfig: k8sConfig.kubeconfig,
    context: k8sConfig.context,
  };
}

/**
 * Wait for a Kubernetes deployment to stabilize
 */
async function waitForK8sStabilization(
  _ctx: IExecutionContext,
  waitInfo: NonNullable<DeployResult['k8sWaitInfo']>
): Promise<{ success: boolean; error?: string }> {
  const kubeconfigFlag = waitInfo.kubeconfig ? `--kubeconfig ${waitInfo.kubeconfig}` : '';
  const contextFlag = waitInfo.context ? `--context ${waitInfo.context}` : '';
  const kubectlBase = `kubectl ${kubeconfigFlag} ${contextFlag}`.trim();

  try {
    await exec(
      `${kubectlBase} -n ${waitInfo.namespace} rollout status deployment/${waitInfo.deployment} --timeout=600s`,
      { silent: true, timeout: 660000 }
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Rollout stabilization failed',
    };
  }
}

// ============================================================================
// S3/CloudFront Deployment
// ============================================================================

async function deployS3CloudFront(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  options: DeployOptions & { invalidate?: boolean }
): Promise<void> {
  const deployConfig = module.resolvedDeploy?.[env];
  const awsConfig = ctx.getAwsConfig(env);

  if (!deployConfig || deployConfig.type !== 's3-cloudfront') {
    throw new DeployError(`Invalid S3 config for ${module.name}`, { moduleName: module.name });
  }

  const s3Config = deployConfig;
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  // Build if needed
  if (options.build !== false && module.resolvedBuild?.command) {
    const buildSpinner = ctx.output.spinner('Building frontend');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build frontend');
      } else {
        await execOrThrow(module.resolvedBuild.command, {
          cwd: module.absolutePath,
          silent: true,
          env: { NODE_OPTIONS: '--max_old_space_size=4096' },
        });
        buildSpinner.succeed('Frontend built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      // Show build error details
      if (error instanceof ExecError) {
        if (error.stderr) {
          ctx.output.error(`\n${error.stderr}`);
        }
        if (error.stdout) {
          ctx.output.error(`\n${error.stdout}`);
        }
      }
      throw new DeployError('Frontend build failed', { moduleName: module.name });
    }
  }

  // Sync to S3
  const syncSpinner = ctx.output.spinner('Syncing to S3');
  syncSpinner.start();

  const outputDir = module.resolvedBuild?.outputDir ?? 'dist';

  try {
    if (ctx.dryRun) {
      syncSpinner.info(`[dry-run] Would sync to s3://${s3Config.bucket}`);
    } else {
      await exec(
        `aws s3 sync ${outputDir} s3://${s3Config.bucket} --delete --region ${region} ${profile}`,
        { cwd: module.absolutePath, silent: true }
      );
      syncSpinner.succeed(`Synced to s3://${s3Config.bucket}`);
    }
  } catch (error) {
    syncSpinner.fail('S3 sync failed');
    throw new DeployError('S3 sync failed', { moduleName: module.name });
  }

  // Invalidate CloudFront
  if (options.invalidate !== false && s3Config.distributionId) {
    const invalidateSpinner = ctx.output.spinner('Invalidating CloudFront');
    invalidateSpinner.start();

    try {
      if (ctx.dryRun) {
        invalidateSpinner.info('[dry-run] Would invalidate CloudFront');
      } else {
        await exec(
          `aws cloudfront create-invalidation --distribution-id ${s3Config.distributionId} --paths "/*" --region ${region} ${profile}`,
          { silent: true }
        );
        invalidateSpinner.succeed('CloudFront invalidated');
      }
    } catch (error) {
      invalidateSpinner.fail('CloudFront invalidation failed');
      // Don't throw - invalidation failure is not critical
      ctx.output.warning('CloudFront invalidation failed, deployment still succeeded');
    }
  }
}

// ============================================================================
// Lambda Deployment
// ============================================================================

interface LambdaFunctionRuntimeConfig {
  runtime: string;
  handler: string;
  timeout: number;
  memorySize: number;
}

/**
 * Get Lambda function configuration from module config
 */
function getLambdaFunctionConfig(module: ResolvedModule, functionName: string): LambdaFunctionRuntimeConfig {
  const defaults = module.lambdaDefaults ?? {
    runtime: 'nodejs20.x',
    handler: 'index.handler',
    timeout: 30,
    memorySize: 256,
  };

  const functionConfig = module.functionConfig?.[functionName] ?? {};

  return {
    ...defaults,
    ...functionConfig,
  };
}

/**
 * Check if a Lambda function exists
 */
async function lambdaFunctionExists(
  functionName: string,
  region: string,
  profile?: string
): Promise<boolean> {
  const profileArg = profile ? `--profile ${profile}` : '';
  try {
    await exec(`aws lambda get-function --function-name ${functionName} --region ${region} ${profileArg}`, {
      silent: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deploy multiple Lambda functions
 */
async function deployLambdaFunctions(
  ctx: IExecutionContext,
  functionNames: string[],
  options: DeployOptions & { create?: boolean }
): Promise<void> {
  const env = ctx.env;

  // Get Lambda functions module
  const lambdaModule = ctx.getModule('aws-lambda-functions');
  if (!lambdaModule) {
    throw new DeployError('Lambda functions module not found');
  }

  const availableFunctions = lambdaModule.functions ?? [];

  // Deploy layer first if requested
  if (options.withDeps) {
    const layerModule = ctx.getModule('aws-lambda-layer');
    if (layerModule) {
      ctx.output.subheader('Deploying Lambda layer');
      await deployLambdaLayerModule(ctx, layerModule, env, options);
      ctx.output.newline();
    }
  }

  // Determine which functions to deploy
  const functionsToDeply =
    functionNames.length > 0 ? functionNames : availableFunctions;

  if (functionsToDeply.length === 0) {
    ctx.output.warning('No Lambda functions configured');
    return;
  }

  // Validate function names
  for (const fn of functionsToDeply) {
    if (!availableFunctions.includes(fn)) {
      throw new DeployError(`Unknown Lambda function: ${fn}. Available: ${availableFunctions.join(', ')}`);
    }
  }

  ctx.output.header(`Deploy Lambda Functions → ${env}`);
  ctx.output.keyValue('Functions', functionsToDeply.join(', '));
  ctx.output.newline();

  let success = 0;
  let failed = 0;

  for (const functionName of functionsToDeply) {
    try {
      await deploySingleLambdaFunction(ctx, lambdaModule, functionName, env, options);
      success++;
    } catch (error) {
      failed++;
      if (ctx.failStrategy === 'fail-fast') {
        throw error;
      }
      if (error instanceof Error) {
        ctx.output.error(`Failed to deploy ${functionName}: ${error.message}`);
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Lambda deploy complete: ${success} succeeded, ${failed} failed`);
}

/**
 * Deploy a single Lambda function
 */
async function deploySingleLambdaFunction(
  ctx: IExecutionContext,
  module: ResolvedModule,
  functionName: string,
  env: Environment,
  options: DeployOptions & { create?: boolean }
): Promise<void> {
  const awsConfig = ctx.getAwsConfig(env);
  const deployConfig = module.resolvedDeploy?.[env];
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  // Version key uses lambda: prefix for individual function tracking
  const versionKey = `lambda:${functionName}`;
  const version = options.version ?? getNextVersion(ctx, versionKey, env);

  ctx.output.subheader(`Deploy: ${functionName}`);
  ctx.output.keyValue('Version', version);

  // Check if function exists
  const exists = await lambdaFunctionExists(functionName, region, awsConfig.profile);

  if (!exists) {
    if (options.create) {
      // Create the function first
      const funcConfig = getLambdaFunctionConfig(module, functionName);

      if (!deployConfig || !('role' in deployConfig) || !deployConfig.role) {
        throw new DeployError(
          `No IAM role configured for Lambda in ${env} environment. Add 'role' to deploy.${env} in jic.config.json`,
          { moduleName: functionName }
        );
      }

      ctx.output.keyValue('Runtime', funcConfig.runtime);
      ctx.output.keyValue('Handler', funcConfig.handler);

      const createSpinner = ctx.output.spinner('Creating Lambda function');
      createSpinner.start();

      try {
        if (ctx.dryRun) {
          createSpinner.info(`[dry-run] Would create ${functionName}`);
        } else {
          const functionPath = `${module.absolutePath}/${functionName}`;
          const zipFile = `${module.absolutePath}/create-${functionName}.zip`;

          // Install dependencies and create zip
          await exec(
            `cd ${functionPath} && [ -f package.json ] && npm install --production || true`,
            { silent: true }
          );
          await exec(`cd ${functionPath} && zip -r ${zipFile} .`, { silent: true });

          // Create the function
          await exec(
            `aws lambda create-function \
              --function-name ${functionName} \
              --runtime ${funcConfig.runtime} \
              --handler ${funcConfig.handler} \
              --role ${deployConfig.role} \
              --timeout ${funcConfig.timeout} \
              --memory-size ${funcConfig.memorySize} \
              --zip-file fileb://${zipFile} \
              --region ${region} ${profile}`,
            { silent: true }
          );

          await exec(`rm -f ${zipFile}`, { silent: true });
          createSpinner.succeed(`Created ${functionName}`);

          // Wait for function to be active
          await exec(
            `aws lambda wait function-active --function-name ${functionName} --region ${region} ${profile}`,
            { silent: true, timeout: 60000 }
          );
        }
      } catch (error) {
        createSpinner.fail('Creation failed');
        throw new DeployError(`Failed to create Lambda function: ${functionName}`, {
          moduleName: functionName,
        });
      }
    } else {
      throw new DeployError(
        `Lambda function '${functionName}' does not exist in ${env}. Use --create flag to create it.`,
        { moduleName: functionName }
      );
    }
  }

  const functionPath = `${module.absolutePath}/${functionName}`;

  // Create deployment package
  const zipSpinner = ctx.output.spinner('Creating deployment package');
  zipSpinner.start();

  try {
    if (ctx.dryRun) {
      zipSpinner.info('[dry-run] Would create zip package');
    } else {
      // Install dependencies if package.json exists
      await exec(
        `cd ${functionPath} && [ -f package.json ] && npm install --production || true`,
        { silent: true }
      );
      // Create zip
      await exec(`cd ${functionPath} && zip -r ../deploy-${functionName}.zip .`, {
        silent: true,
      });
      zipSpinner.succeed('Deployment package created');
    }
  } catch (error) {
    zipSpinner.fail('Failed to create package');
    throw new DeployError(`Failed to create package for ${functionName}`, {
      moduleName: functionName,
    });
  }

  // Update Lambda function code
  const deploySpinner = ctx.output.spinner('Updating Lambda function');
  deploySpinner.start();

  try {
    if (ctx.dryRun) {
      deploySpinner.info(`[dry-run] Would update ${functionName}`);
    } else {
      await exec(
        `aws lambda update-function-code --function-name ${functionName} --zip-file fileb://${module.absolutePath}/deploy-${functionName}.zip --region ${region} ${profile}`,
        { silent: true }
      );
      // Clean up zip
      await exec(`rm -f ${module.absolutePath}/deploy-${functionName}.zip`, {
        silent: true,
      });
      deploySpinner.succeed(`Updated ${functionName}`);
    }
  } catch (error) {
    deploySpinner.fail('Lambda update failed');
    throw new DeployError(`Lambda update failed for ${functionName}`, {
      moduleName: functionName,
    });
  }

  // Publish new version
  const publishSpinner = ctx.output.spinner('Publishing Lambda version');
  publishSpinner.start();

  let publishedVersion: string | null = null;
  try {
    if (ctx.dryRun) {
      publishSpinner.info(`[dry-run] Would publish version ${version}`);
    } else {
      // Wait for function to be ready after update
      await exec(
        `aws lambda wait function-updated --function-name ${functionName} --region ${region} ${profile}`,
        { silent: true, timeout: 60000 }
      );

      // Publish version with description
      const result = await exec(
        `aws lambda publish-version --function-name ${functionName} --description "v${version}" --region ${region} ${profile}`,
        { silent: true }
      );

      const versionInfo = JSON.parse(result.stdout);
      publishedVersion = versionInfo.Version;
      publishSpinner.succeed(`Published version ${publishedVersion}`);
    }
  } catch (error) {
    publishSpinner.fail('Failed to publish version');
    throw new DeployError(`Failed to publish version for ${functionName}`, {
      moduleName: functionName,
    });
  }

  // Update state with lambda: prefix for individual tracking
  if (!ctx.dryRun) {
    const commit = await getGitCommit(module.absolutePath);
    await updateDeploymentState(ctx, versionKey, env, {
      version,
      commit: commit ?? 'unknown',
      deployedAt: new Date().toISOString(),
      status: 'deployed',
    });

    // Also store Lambda-specific info
    await updateLambdaVersionState(ctx, env, functionName, {
      version,
      awsVersion: publishedVersion,
      deployedAt: new Date().toISOString(),
      commit: commit ?? 'unknown',
    });
  }

  ctx.output.success(`Lambda ${functionName} v${version} deployed`);
}

/**
 * Update Lambda version state
 */
async function updateLambdaVersionState(
  ctx: IExecutionContext,
  env: Environment,
  functionName: string,
  info: { version: string; awsVersion: string | null; deployedAt: string; commit: string }
): Promise<void> {
  if (!ctx.state.lambdaVersions) {
    ctx.state.lambdaVersions = { dev: {}, staging: {}, prod: {} };
  }
  if (!ctx.state.lambdaVersions[env]) {
    ctx.state.lambdaVersions[env] = {};
  }
  ctx.state.lambdaVersions[env][functionName] = info;
  await ctx.saveState();
}

/**
 * Deploy Lambda layer module
 */
async function deployLambdaLayerModule(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  options: DeployOptions
): Promise<void> {
  const awsConfig = ctx.getAwsConfig(env);
  const deployConfig = module.resolvedDeploy?.[env] ?? module.originalConfig.deploy;
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  // Get layer name from config
  // layerName can be at the root of deploy config or in the environment-specific config
  const getLayerName = (): string => {
    if (deployConfig && 'layerName' in deployConfig) {
      const name = (deployConfig as { layerName?: string }).layerName;
      if (typeof name === 'string') return name;
    }
    if (module.originalConfig.deploy && 'layerName' in module.originalConfig.deploy) {
      const name = (module.originalConfig.deploy as { layerName?: string }).layerName;
      if (typeof name === 'string') return name;
    }
    return 'jic-shared-layer';
  };
  const layerName = getLayerName();

  // Use module name as version key for consistency with existing state data
  const versionKey = module.name;
  const version = options.version ?? getNextVersion(ctx, versionKey, env);

  ctx.output.keyValue('Layer', layerName);
  ctx.output.keyValue('Version', version);

  // Install dependencies
  const installSpinner = ctx.output.spinner('Installing dependencies');
  installSpinner.start();

  try {
    if (ctx.dryRun) {
      installSpinner.info('[dry-run] Would install dependencies');
    } else {
      await exec('npm install --production', {
        cwd: `${module.absolutePath}/nodejs`,
        silent: true,
      });
      installSpinner.succeed('Dependencies installed');
    }
  } catch (error) {
    installSpinner.fail('Failed to install dependencies');
    throw new DeployError('Failed to install dependencies for layer', {
      moduleName: module.name,
    });
  }

  // Create zip
  const zipSpinner = ctx.output.spinner('Creating layer package');
  zipSpinner.start();

  try {
    if (ctx.dryRun) {
      zipSpinner.info('[dry-run] Would create layer zip');
    } else {
      await exec(`cd ${module.absolutePath} && zip -r layer.zip nodejs`, {
        silent: true,
      });
      zipSpinner.succeed('Layer package created');
    }
  } catch (error) {
    zipSpinner.fail('Failed to create package');
    throw new DeployError('Failed to create layer package', { moduleName: module.name });
  }

  // Publish layer
  const publishSpinner = ctx.output.spinner('Publishing layer');
  publishSpinner.start();

  let awsLayerVersion: string | null = null;
  let layerArn: string | null = null;
  try {
    if (ctx.dryRun) {
      publishSpinner.info(`[dry-run] Would publish ${layerName}`);
    } else {
      const result = await exec(
        `aws lambda publish-layer-version --layer-name ${layerName} --zip-file fileb://${module.absolutePath}/layer.zip --compatible-runtimes nodejs18.x nodejs20.x --description "v${version}" --region ${region} ${profile}`,
        { silent: true }
      );

      // Clean up
      await exec(`rm -f ${module.absolutePath}/layer.zip`, { silent: true });

      const layerData = JSON.parse(result.stdout);
      awsLayerVersion = layerData.Version;
      layerArn = layerData.LayerVersionArn;
      publishSpinner.succeed(`Published ${layerName} version ${awsLayerVersion}`);
    }
  } catch (error) {
    publishSpinner.fail('Layer publish failed');
    throw new DeployError('Layer publish failed', { moduleName: module.name });
  }

  // Update Lambda functions to use the new layer version
  if (!ctx.dryRun && layerArn) {
    await updateFunctionsWithNewLayer(ctx, layerArn, region, profile, options);
  }

  // Update state
  if (!ctx.dryRun) {
    const commit = await getGitCommit(module.absolutePath);
    await updateDeploymentState(ctx, versionKey, env, {
      version,
      commit: commit ?? 'unknown',
      deployedAt: new Date().toISOString(),
      status: 'deployed',
    });

    // Store layer-specific info (using module name for consistency)
    await updateLambdaVersionState(ctx, env, module.name, {
      version,
      awsVersion: awsLayerVersion,
      deployedAt: new Date().toISOString(),
      commit: commit ?? 'unknown',
    });
  }

  ctx.output.success(`Lambda layer v${version} deployed`);
}

/**
 * Update Lambda functions to use the new layer version
 * Only updates Node.js functions (skips Python, Java, etc.)
 */
async function updateFunctionsWithNewLayer(
  ctx: IExecutionContext,
  layerArn: string,
  region: string,
  profile: string,
  _options: DeployOptions
): Promise<void> {
  // Get Lambda functions module to find which functions to update
  const lambdaModule = ctx.getModule('aws-lambda-functions');
  if (!lambdaModule || !lambdaModule.functions || lambdaModule.functions.length === 0) {
    ctx.output.muted('No Lambda functions configured to update with new layer');
    return;
  }

  // Filter to only Node.js functions (the layer is for Node.js)
  const nodeFunctions = lambdaModule.functions.filter((fn) => {
    const funcConfig = lambdaModule.functionConfig?.[fn];
    const runtime = funcConfig?.runtime ?? lambdaModule.lambdaDefaults?.runtime ?? 'nodejs20.x';
    return runtime.startsWith('nodejs');
  });

  if (nodeFunctions.length === 0) {
    ctx.output.muted('No Node.js functions to update with new layer');
    return;
  }

  ctx.output.newline();
  ctx.output.subheader('Updating functions to use new layer');
  ctx.output.keyValue('Functions', nodeFunctions.join(', '));

  let updated = 0;
  let failed = 0;

  for (const functionName of nodeFunctions) {
    const updateSpinner = ctx.output.spinner(`Updating ${functionName}`);
    updateSpinner.start();

    try {
      // Update function configuration to use the new layer
      await exec(
        `aws lambda update-function-configuration --function-name ${functionName} --layers ${layerArn} --region ${region} ${profile}`,
        { silent: true }
      );
      updateSpinner.succeed(`Updated ${functionName}`);
      updated++;
    } catch (error) {
      updateSpinner.fail(`Failed to update ${functionName}`);
      failed++;
      // Don't throw - continue with other functions
      if (ctx.verbose && error instanceof Error) {
        ctx.output.muted(`  Error: ${error.message}`);
      }
    }
  }

  ctx.output.info(`Layer update: ${updated} functions updated, ${failed} failed`);
}

// ============================================================================
// Frontend Deployment (convenience method)
// ============================================================================

async function deployFrontend(
  ctx: IExecutionContext,
  options: DeployOptions & { invalidate?: boolean }
): Promise<void> {
  const frontendModule = ctx.getModule('joyincloud-gw-client');
  if (!frontendModule) {
    throw new DeployError('Frontend module not found');
  }

  const env = ctx.env;
  await deployS3CloudFront(ctx, frontendModule, env, options);
}

// ============================================================================
// Deploy Status
// ============================================================================

/**
 * Get local Docker image digest for a given image name
 */
async function getLocalDockerDigest(imageName: string): Promise<string | null> {
  try {
    // Try to get the digest from local Docker
    const result = await exec(
      `docker inspect --format='{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' ${imageName}:latest 2>/dev/null`,
      { silent: true }
    );

    const output = result.stdout?.trim();
    if (output && output.includes('@sha256:')) {
      // Extract just the sha256:... part
      return output.split('@')[1];
    }

    // Fallback: try to get digest from docker images command
    const digestResult = await exec(
      `docker images --digests --format "{{.Digest}}" ${imageName}:latest 2>/dev/null`,
      { silent: true }
    );

    const digest = digestResult.stdout?.trim();
    if (digest && digest !== '<none>') {
      return digest;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Determine deployment status by comparing local Docker digest with ECR digest
 */
type DeployStatusResult = {
  status: 'up-to-date' | 'behind' | 'local-only' | 'not-deployed' | 'unknown';
  localDigest?: string;
  remoteDigest?: string;
};

async function getDeploymentStatus(
  module: ResolvedModule,
  deployment: { commit?: string; ecrImageDigest?: string } | undefined,
  localCommit: string | null
): Promise<DeployStatusResult> {
  // If no deployment record, it's not deployed
  if (!deployment) {
    return { status: 'not-deployed' };
  }

  // For ECS modules with ECR digest, compare Docker images
  if (deployment.ecrImageDigest && module.resolvedBuild?.dockerImage) {
    const localDigest = await getLocalDockerDigest(module.resolvedBuild.dockerImage);

    if (localDigest) {
      const remoteDigest = deployment.ecrImageDigest;
      if (localDigest === remoteDigest) {
        return { status: 'up-to-date', localDigest, remoteDigest };
      } else {
        return { status: 'behind', localDigest, remoteDigest };
      }
    }

    // No local image built - fallback to commit comparison
    if (localCommit && deployment.commit) {
      return {
        status: localCommit === deployment.commit ? 'up-to-date' : 'behind',
        remoteDigest: deployment.ecrImageDigest,
      };
    }

    return { status: 'unknown', remoteDigest: deployment.ecrImageDigest };
  }

  // Fallback: compare git commits (for non-ECS or when digest not available)
  if (localCommit && deployment.commit) {
    return {
      status: localCommit === deployment.commit ? 'up-to-date' : 'behind',
    };
  }

  return { status: 'unknown' };
}

async function deployStatus(
  ctx: IExecutionContext,
  options: { refresh?: boolean; all?: boolean; details?: boolean }
): Promise<void> {
  ctx.output.header('Deployment Status');

  const environments: Environment[] = options.all
    ? ['dev', 'staging', 'prod']
    : [ctx.env];

  for (const env of environments) {
    ctx.output.subheader(`Environment: ${env}`);

    const deployments = ctx.state.deployments?.[env] ?? {};

    // Get deployable modules (excluding lambda-functions which are tracked individually)
    const modules = Object.values(ctx.config.resolvedModules).filter(
      (m) => m.resolvedDeploy?.[env] && m.type !== 'lambda-functions'
    );

    const rows: string[][] = [];

    // Show regular modules first
    for (const module of modules) {
      const deployment = deployments[module.name];
      const localCommit = await getGitCommit(module.absolutePath);

      if (deployment) {
        // Get real deployment status by comparing digests
        const statusResult = await getDeploymentStatus(module, deployment, localCommit);

        let statusDisplay: string;
        switch (statusResult.status) {
          case 'up-to-date':
            statusDisplay = colors.success('up-to-date');
            break;
          case 'behind':
            statusDisplay = colors.warning('behind');
            break;
          case 'local-only':
            statusDisplay = colors.info('local-only');
            break;
          case 'unknown':
            statusDisplay = colors.muted('unknown');
            break;
          default:
            statusDisplay = colors.muted('not deployed');
        }

        const row = [
          ctx.output.module(module.name),
          deployment.version,
          deployment.commit?.substring(0, 7) ?? 'N/A',
          localCommit?.substring(0, 7) ?? 'N/A',
          statusDisplay,
        ];

        // Add ECR image tag in details mode
        if (options.details) {
          row.push(deployment.ecrImageTag ?? deployment.lambdaVersion ?? colors.muted('-'));
        }

        rows.push(row);
      } else {
        const row = [
          ctx.output.module(module.name),
          colors.muted('never'),
          colors.muted('N/A'),
          localCommit?.substring(0, 7) ?? 'N/A',
          colors.muted('not deployed'),
        ];

        if (options.details) {
          row.push(colors.muted('-'));
        }

        rows.push(row);
      }
    }

    // Show individual lambda functions (tracked as lambda:<functionName>)
    const lambdaModule = ctx.getModule('aws-lambda-functions');

    // Individual lambda functions
    if (lambdaModule) {
      const localCommit = await getGitCommit(lambdaModule.absolutePath);
      const functions = lambdaModule.functions ?? [];

      for (const functionName of functions) {
        const versionKey = `lambda:${functionName}`;
        const deployment = deployments[versionKey];

        if (deployment) {
          const row = [
            ctx.output.module(versionKey),
            deployment.version,
            deployment.commit?.substring(0, 7) ?? 'N/A',
            localCommit?.substring(0, 7) ?? 'N/A',
            colors.success('deployed'),
          ];
          if (options.details) {
            row.push(deployment.lambdaVersion ?? colors.muted('-'));
          }
          rows.push(row);
        }
      }
    }

    if (rows.length === 0) {
      ctx.output.info('No deployments recorded');
      continue;
    }

    const headers = ['Module', 'Version', 'Deployed', 'Local', 'Status'];
    if (options.details) {
      headers.push('Image/Ver');
    }

    ctx.output.table(rows, { head: headers });

    // Show additional details in verbose mode
    if (options.details) {
      const detailModules = modules.filter((m) => {
        const d = deployments[m.name];
        return d?.ecrImageTag || d?.ecrImageDigest;
      });

      if (detailModules.length > 0) {
        ctx.output.newline();
        ctx.output.muted('ECR Details:');
        for (const module of detailModules) {
          const deployment = deployments[module.name];
          ctx.output.muted(`  ${module.name}:`);
          if (deployment?.ecrImageTag) {
            ctx.output.muted(`    Tag: ${deployment.ecrImageTag}`);
          }
          if (deployment?.ecrImageDigest) {
            ctx.output.muted(`    Digest: ${deployment.ecrImageDigest.substring(0, 20)}...`);
          }
          if (deployment?.ecrImagePushedAt) {
            ctx.output.muted(`    Pushed: ${new Date(deployment.ecrImagePushedAt).toLocaleString()}`);
          }

          // Show local digest comparison
          if (module.resolvedBuild?.dockerImage) {
            const localDigest = await getLocalDockerDigest(module.resolvedBuild.dockerImage);
            if (localDigest) {
              const matches = localDigest === deployment?.ecrImageDigest;
              ctx.output.muted(
                `    Local:  ${localDigest.substring(0, 20)}... ${matches ? colors.success('✓ matches') : colors.warning('✗ differs')}`
              );
            } else {
              ctx.output.muted(`    Local:  ${colors.muted('(no local image)')}`);
            }
          }
        }
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get next deploy version for a module
 * Supports both integer versions (1, 2, 3) and decimal versions (1.00, 1.01, 1.02)
 * Decimal versions increment by 0.01
 */
function getNextVersion(ctx: IExecutionContext, moduleName: string, env: Environment): string {
  const deployments = ctx.state.deployments?.[env] ?? {};
  const current = deployments[moduleName]?.version;

  if (!current) {
    return '1.00';
  }

  // Parse as float to handle both "3.01" strings and numeric values
  const currentNum = parseFloat(current);

  if (isNaN(currentNum)) {
    return '1.00';
  }

  // Check if it's a decimal version (has decimal places or is a string with decimals)
  const isDecimal = String(current).includes('.') || currentNum % 1 !== 0;

  if (isDecimal) {
    // Increment by 0.01 and fix floating point precision
    return (currentNum + 0.01).toFixed(2);
  } else {
    // Legacy integer versioning - convert to decimal format
    return (currentNum + 0.01).toFixed(2);
  }
}

async function updateDeploymentState(
  ctx: IExecutionContext,
  moduleName: string,
  env: Environment,
  record: LocalDeploymentRecord
): Promise<void> {
  // Ensure structure exists
  if (!ctx.state.deployments) {
    ctx.state.deployments = { dev: {}, staging: {}, prod: {} };
  }
  if (!ctx.state.deployments[env]) {
    ctx.state.deployments[env] = {};
  }

  // Add moduleName and environment to create full DeploymentRecord
  ctx.state.deployments[env][moduleName] = {
    ...record,
    moduleName,
    environment: env,
  };
  await ctx.saveState();
}
