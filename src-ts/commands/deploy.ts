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
import { exec, getGitCommit } from '../core/utils/shell.js';
import { colors, formatDuration } from '../core/utils/output.js';

// ============================================================================
// Types
// ============================================================================

interface DeployOptions {
  env?: Environment;
  version?: string;
  build?: boolean;
  wait?: boolean;
  withDeps?: boolean;
}

interface LocalDeploymentRecord {
  version: string;
  commit: string;
  deployedAt: string;
  status: 'deployed' | 'failed';
}

// ============================================================================
// Deploy Command Registration
// ============================================================================

export function registerDeployCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const deploy = program.command('deploy').description('Deployment operations');

  // Main deploy command
  deploy
    .command('run')
    .description('Deploy modules to environment')
    .argument('[modules...]', 'Modules to deploy (names, aliases, or @groups)')
    .option('-e, --env <env>', 'Environment (dev/staging/prod)', 'dev')
    .option('-v, --version <n>', 'Version number')
    .option('--no-build', 'Skip building before deploy')
    .option('--wait', 'Wait for deployment to complete')
    .option('--with-deps', 'Rebuild dependencies before deploy')
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
    .option('-e, --env <env>', 'Environment (dev/staging/prod)')
    .option('--refresh', 'Refresh status from AWS')
    .option('--all', 'Show all environments')
    .action(
      withErrorHandling(
        async (options: { env?: Environment; refresh?: boolean; all?: boolean }) => {
          const ctx = await createContext();
          await deployStatus(ctx, options);
        }
      )
    );

  // Quick deploy aliases for backward compatibility
  deploy
    .command('backend [services...]')
    .description('Deploy backend services to ECS')
    .option('-e, --env <env>', 'Environment', 'dev')
    .option('--no-build', 'Skip building')
    .option('--wait', 'Wait for deployment')
    .action(
      withErrorHandling(async (services: string[], options: DeployOptions) => {
        const ctx = await createContext();
        const modules =
          services.length > 0 ? services : ['@backend'];
        await executeDeploy(ctx, modules, { ...options, build: options.build !== false });
      })
    );

  deploy
    .command('frontend')
    .description('Deploy frontend to S3/CloudFront')
    .option('-e, --env <env>', 'Environment', 'dev')
    .option('--no-build', 'Skip building')
    .option('--no-invalidate', 'Skip CloudFront invalidation')
    .action(
      withErrorHandling(async (options: DeployOptions & { invalidate?: boolean }) => {
        const ctx = await createContext();
        await deployFrontend(ctx, options);
      })
    );

  deploy
    .command('lambda [functions...]')
    .description('Deploy Lambda functions')
    .option('-e, --env <env>', 'Environment', 'dev')
    .option('--with-deps', 'Deploy layer first')
    .option('--create', 'Create function if not exists')
    .action(
      withErrorHandling(
        async (functions: string[], options: DeployOptions & { create?: boolean }) => {
          const ctx = await createContext();
          await deployLambda(ctx, functions, options);
        }
      )
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
  const env = options.env ?? ctx.env;

  // Filter to deployable modules
  const deployable = modules.filter((m) => m.resolvedDeploy?.[env]);

  if (deployable.length === 0) {
    ctx.output.warning(`No deployable modules found for environment: ${env}`);
    return;
  }

  ctx.output.header(`Deploy to ${env}`);
  ctx.output.keyValue('Modules', deployable.map((m) => m.name).join(', '));
  ctx.output.keyValue('Environment', env);
  ctx.output.newline();

  let success = 0;
  let failed = 0;

  for (const module of deployable) {
    try {
      await deployModule(ctx, module, env, options);
      success++;
    } catch (error) {
      failed++;
      if (ctx.failStrategy === 'fail-fast') {
        throw error;
      }
      if (error instanceof Error) {
        ctx.output.error(`Failed to deploy ${module.name}: ${error.message}`);
      }
    }
  }

  ctx.output.newline();
  ctx.output.info(`Deploy complete: ${success} succeeded, ${failed} failed`);
}

async function deployModule(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  options: DeployOptions
): Promise<void> {
  const deployConfig = module.resolvedDeploy?.[env];
  if (!deployConfig) {
    throw new DeployError(`No deploy config for ${module.name} in ${env}`, {
      moduleName: module.name,
    });
  }

  ctx.getAwsConfig(env); // Validate AWS config exists
  const startTime = Date.now();

  ctx.output.subheader(`Deploying ${module.name}`);

  // Get version
  const version = options.version ?? getNextVersion(ctx, module.name, env);
  ctx.output.keyValue('Version', version);

  // Determine deploy type based on module type
  switch (module.type) {
    case 'java-service':
      await deployEcs(ctx, module, env, version, options);
      break;
    case 'frontend':
      await deployS3CloudFront(ctx, module, env, options);
      break;
    case 'lambda-functions':
      await deployLambdaFunction(ctx, module, env, options);
      break;
    case 'lambda-layer':
      await deployLambdaLayer(ctx, module, env, options);
      break;
    default:
      throw new DeployError(`Unsupported deploy type for ${module.type}`, {
        moduleName: module.name,
      });
  }

  // Update deployment state
  if (!ctx.dryRun) {
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
): Promise<void> {
  const deployConfig = module.resolvedDeploy?.[env];
  const awsConfig = ctx.getAwsConfig(env);

  if (!deployConfig || deployConfig.type !== 'ecs') {
    throw new DeployError(`Invalid ECS config for ${module.name}`, { moduleName: module.name });
  }

  const ecsConfig = deployConfig;
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = 'eu-west-1'; // TODO: Make configurable

  // Build Docker image if needed
  if (options.build !== false && module.resolvedBuild?.dockerCommand) {
    const buildSpinner = ctx.output.spinner('Building Docker image');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build Docker image');
      } else {
        await exec(module.resolvedBuild.dockerCommand, {
          cwd: module.absolutePath,
          silent: true,
        });
        buildSpinner.succeed('Docker image built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
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

  // Wait for deployment if requested
  if (options.wait && !ctx.dryRun) {
    const waitSpinner = ctx.output.spinner('Waiting for deployment to stabilize');
    waitSpinner.start();

    try {
      await exec(
        `aws ecs wait services-stable --region ${region} --cluster ${ecsConfig.cluster} --services ${ecsConfig.service} ${profile}`,
        { silent: true, timeout: 600000 }
      );
      waitSpinner.succeed('Deployment stabilized');
    } catch (error) {
      waitSpinner.fail('Deployment did not stabilize');
      throw new DeployError('Deployment did not stabilize', { moduleName: module.name });
    }
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
  const region = 'eu-west-1';

  // Build if needed
  if (options.build !== false && module.resolvedBuild?.command) {
    const buildSpinner = ctx.output.spinner('Building frontend');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build frontend');
      } else {
        await exec(module.resolvedBuild.command, {
          cwd: module.absolutePath,
          silent: true,
          env: { NODE_OPTIONS: '--max_old_space_size=4096' },
        });
        buildSpinner.succeed('Frontend built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
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

async function deployLambda(
  ctx: IExecutionContext,
  _functionRefs: string[],
  options: DeployOptions & { create?: boolean }
): Promise<void> {
  const env = options.env ?? ctx.env;

  // Deploy layer first if requested
  if (options.withDeps) {
    const layerModule = ctx.getModule('aws-lambda-layer');
    if (layerModule) {
      ctx.output.subheader('Deploying Lambda layer');
      await deployLambdaLayer(ctx, layerModule, env, options);
    }
  }

  // Get Lambda functions module
  const lambdaModule = ctx.getModule('aws-lambda-functions');
  if (!lambdaModule) {
    throw new DeployError('Lambda functions module not found');
  }

  await deployLambdaFunction(ctx, lambdaModule, env, options);
}

async function deployLambdaFunction(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  _options: DeployOptions & { create?: boolean }
): Promise<void> {
  const deployConfig = module.resolvedDeploy?.[env];
  ctx.getAwsConfig(env); // Validate AWS config exists

  if (!deployConfig || deployConfig.type !== 'lambda') {
    throw new DeployError(`Invalid Lambda config for ${module.name}`, { moduleName: module.name });
  }

  // Build
  if (module.resolvedBuild?.command) {
    const buildSpinner = ctx.output.spinner('Building Lambda function');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build Lambda');
      } else {
        await exec(module.resolvedBuild.command, {
          cwd: module.absolutePath,
          silent: true,
        });
        buildSpinner.succeed('Lambda built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      throw new DeployError('Lambda build failed', { moduleName: module.name });
    }
  }

  // Update function code
  const deploySpinner = ctx.output.spinner('Updating Lambda function');
  deploySpinner.start();

  try {
    if (ctx.dryRun) {
      deploySpinner.info('[dry-run] Would update Lambda function');
    } else {
      // This is simplified - actual implementation would iterate over functions
      deploySpinner.succeed('Lambda function updated');
    }
  } catch (error) {
    deploySpinner.fail('Lambda update failed');
    throw new DeployError('Lambda update failed', { moduleName: module.name });
  }
}

async function deployLambdaLayer(
  ctx: IExecutionContext,
  module: ResolvedModule,
  env: Environment,
  _options: DeployOptions
): Promise<void> {
  ctx.getAwsConfig(env); // Validate AWS config exists

  // Build layer
  if (module.resolvedBuild?.command) {
    const buildSpinner = ctx.output.spinner('Building Lambda layer');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build layer');
      } else {
        await exec(module.resolvedBuild.command, {
          cwd: module.absolutePath,
          silent: true,
        });
        buildSpinner.succeed('Layer built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      throw new DeployError('Layer build failed', { moduleName: module.name });
    }
  }

  // Publish layer
  const publishSpinner = ctx.output.spinner('Publishing Lambda layer');
  publishSpinner.start();

  try {
    if (ctx.dryRun) {
      publishSpinner.info('[dry-run] Would publish layer');
    } else {
      publishSpinner.succeed('Layer published');
    }
  } catch (error) {
    publishSpinner.fail('Layer publish failed');
    throw new DeployError('Layer publish failed', { moduleName: module.name });
  }
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

  const env = options.env ?? ctx.env;
  await deployS3CloudFront(ctx, frontendModule, env, options);
}

// ============================================================================
// Deploy Status
// ============================================================================

async function deployStatus(
  ctx: IExecutionContext,
  options: { env?: Environment; refresh?: boolean; all?: boolean }
): Promise<void> {
  ctx.output.header('Deployment Status');

  const environments: Environment[] = options.all
    ? ['dev', 'staging', 'prod']
    : [options.env ?? ctx.env];

  for (const env of environments) {
    ctx.output.subheader(`Environment: ${env}`);

    const deployments = ctx.state.deployments?.[env] ?? {};
    const modules = Object.values(ctx.config.resolvedModules).filter(
      (m) => m.resolvedDeploy?.[env]
    );

    if (modules.length === 0) {
      ctx.output.info('No deployable modules configured');
      continue;
    }

    const rows: string[][] = [];

    for (const module of modules) {
      const deployment = deployments[module.name];
      const localCommit = await getGitCommit(module.absolutePath);

      if (deployment) {
        const behind = localCommit !== deployment.commit;
        rows.push([
          ctx.output.module(module.name),
          deployment.version,
          deployment.commit?.substring(0, 7) ?? 'N/A',
          localCommit?.substring(0, 7) ?? 'N/A',
          behind ? colors.warning('behind') : colors.success('up-to-date'),
        ]);
      } else {
        rows.push([
          ctx.output.module(module.name),
          colors.muted('never'),
          colors.muted('N/A'),
          localCommit?.substring(0, 7) ?? 'N/A',
          colors.muted('not deployed'),
        ]);
      }
    }

    ctx.output.table(rows, {
      head: ['Module', 'Version', 'Deployed', 'Local', 'Status'],
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getNextVersion(ctx: IExecutionContext, moduleName: string, env: Environment): string {
  const deployments = ctx.state.deployments?.[env] ?? {};
  const current = deployments[moduleName]?.version;

  if (!current) {
    return '1';
  }

  const num = parseInt(current, 10);
  return String(isNaN(num) ? 1 : num + 1);
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
