/**
 * AWS Command
 *
 * AWS operations for ECS, ECR, CloudWatch, and other services.
 *
 * Examples:
 *   jic aws logs gws              # Tail logs for a service
 *   jic aws ecs status            # Show ECS service status
 *   jic aws ecr list              # List ECR images
 *   jic aws lambda list           # List Lambda functions
 *   jic aws refresh               # Sync local state with AWS deployments
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { DeploymentRecord } from '../core/types/state.js';
import { AwsError, withErrorHandling } from '../core/errors/index.js';
import { exec, getGitCommit } from '../core/utils/shell.js';
import { colors } from '../core/utils/output.js';

// ============================================================================
// AWS Command Registration
// ============================================================================

export function registerAwsCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const aws = program.command('aws').description('AWS operations');

  // Logs command
  aws
    .command('logs <service>')
    .description('Tail CloudWatch logs for a service')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines to show', '100')
    .option('--since <time>', 'Show logs since (e.g., 1h, 30m, 2d)')
    .action(
      withErrorHandling(
        async (
          service: string,
          options: { follow?: boolean; lines?: string; since?: string }
        ) => {
          const ctx = await createContext();
          await awsLogs(ctx, service, options);
        }
      )
    );

  // ECS subcommand
  const ecs = aws.command('ecs').description('ECS operations');

  ecs
    .command('status')
    .description('Show ECS service status')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await ecsStatus(ctx);
      })
    );

  ecs
    .command('restart <service>')
    .description('Force new deployment for a service')
    .option('--wait', 'Wait for deployment to stabilize')
    .action(
      withErrorHandling(async (service: string, options: { wait?: boolean }) => {
        const ctx = await createContext();
        await ecsRestart(ctx, service, options);
      })
    );

  ecs
    .command('scale <service> <count>')
    .description('Scale service to desired count')
    .action(
      withErrorHandling(async (service: string, count: string) => {
        const ctx = await createContext();
        await ecsScale(ctx, service, parseInt(count, 10));
      })
    );

  // ECR subcommand
  const ecr = aws.command('ecr').description('ECR operations');

  ecr
    .command('list [service]')
    .description('List ECR images')
    .option('-n, --limit <n>', 'Number of images to show', '10')
    .action(
      withErrorHandling(
        async (service: string | undefined, options: { limit?: string }) => {
          const ctx = await createContext();
          await ecrList(ctx, service, options);
        }
      )
    );

  ecr
    .command('login')
    .description('Login to ECR')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await ecrLogin(ctx);
      })
    );

  // Lambda subcommand
  const lambda = aws.command('lambda').description('Lambda operations');

  lambda
    .command('list')
    .description('List Lambda functions')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await lambdaList(ctx);
      })
    );

  lambda
    .command('invoke <function>')
    .description('Invoke a Lambda function')
    .option('-p, --payload <json>', 'JSON payload')
    .action(
      withErrorHandling(
        async (func: string, options: { payload?: string }) => {
          const ctx = await createContext();
          await lambdaInvoke(ctx, func, options);
        }
      )
    );

  // Config/Profile command
  aws
    .command('whoami')
    .description('Show current AWS identity')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await awsWhoami(ctx);
      })
    );

  // Refresh command - sync local state with AWS
  aws
    .command('refresh')
    .description('Sync local state with current AWS deployment status')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await awsRefresh(ctx);
      })
    );
}

// ============================================================================
// AWS Logs
// ============================================================================

async function awsLogs(
  ctx: IExecutionContext,
  serviceRef: string,
  options: { follow?: boolean; lines?: string; since?: string }
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const module = ctx.getModule(serviceRef);

  if (!module) {
    throw new AwsError(`Service '${serviceRef}' not found`);
  }

  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;
  const logGroup = awsConfig.logGroup ?? `jic-${env}-logs`;

  // Get ECS service name from deploy config, fallback to module name
  const deployConfig = module.resolvedDeploy?.[env];
  const serviceName =
    (deployConfig && 'service' in deployConfig ? deployConfig.service : null) ?? module.name;

  // Stream prefix is the service name without "-service" suffix (e.g., "gws-dev" from "gws-dev-service")
  // Add trailing slash to match CloudWatch log stream naming convention
  const streamPrefix = serviceName.replace(/-service$/, '') + '/';

  ctx.output.header(`Logs: ${module.name}`);
  ctx.output.keyValue('Environment', env);
  ctx.output.keyValue('Log Group', logGroup);
  ctx.output.keyValue('Stream Prefix', streamPrefix);
  ctx.output.newline();

  // Build command - default to 1h if no since specified
  const since = options.since ?? '1h';
  let cmd = `aws logs tail ${logGroup} --region ${region} ${profile} --since ${since}`;

  if (options.follow) {
    cmd += ' --follow';
  }

  // Filter to specific service stream
  cmd += ` --log-stream-name-prefix ${streamPrefix}`;

  if (ctx.dryRun) {
    ctx.output.info(`[dry-run] Would run: ${cmd}`);
    return;
  }

  ctx.output.info('Streaming logs... (Ctrl+C to stop)\n');

  try {
    // Stream logs to stdout
    await exec(cmd, { silent: false, timeout: 0 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('SIGINT')) {
      // User interrupted, not an error
      return;
    }
    throw new AwsError(`Failed to tail logs: ${error}`);
  }
}

// ============================================================================
// ECS Operations
// ============================================================================

async function ecsStatus(
  ctx: IExecutionContext
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;
  const cluster = awsConfig.ecsCluster;

  if (!cluster) {
    throw new AwsError(`No ECS cluster configured for ${env}`);
  }

  ctx.output.header(`ECS Status: ${env}`);
  ctx.output.keyValue('Cluster', cluster);
  ctx.output.newline();

  const spinner = ctx.output.spinner('Fetching service status');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would fetch ECS status');
      return;
    }

    // List services
    const listResult = await exec(
      `aws ecs list-services --cluster ${cluster} --region ${region} ${profile} --output json`,
      { silent: true }
    );

    if (!listResult.stdout || listResult.stdout.trim() === '') {
      spinner.fail('Empty response from AWS');
      throw new AwsError('Failed to list ECS services: empty response');
    }

    let listParsed;
    try {
      listParsed = JSON.parse(listResult.stdout);
    } catch (parseError) {
      spinner.fail('Invalid JSON response');
      throw new AwsError(`Failed to parse ECS list response: ${parseError}`);
    }

    const serviceArns = (listParsed.serviceArns ?? []) as string[];

    if (serviceArns.length === 0) {
      spinner.info('No services found in cluster');
      return;
    }

    // Describe services
    const describeResult = await exec(
      `aws ecs describe-services --cluster ${cluster} --services ${serviceArns.join(' ')} --region ${region} ${profile} --output json`,
      { silent: true }
    );

    if (!describeResult.stdout || describeResult.stdout.trim() === '') {
      spinner.fail('Empty response from AWS');
      throw new AwsError('Failed to describe ECS services: empty response');
    }

    let describeParsed;
    try {
      describeParsed = JSON.parse(describeResult.stdout);
    } catch (parseError) {
      spinner.fail('Invalid JSON response');
      throw new AwsError(`Failed to parse ECS describe response: ${parseError}`);
    }

    const services = (describeParsed.services ?? []) as Array<{
      serviceName: string;
      status: string;
      runningCount: number;
      desiredCount: number;
      deployments: Array<{ status: string; runningCount: number }>;
    }>;

    if (services.length === 0) {
      spinner.info('No service details available');
      return;
    }

    spinner.succeed('Service status retrieved');
    ctx.output.newline();

    const rows: string[][] = [];

    for (const svc of services) {
      const healthy = svc.runningCount === svc.desiredCount;
      const deploying = svc.deployments.some((d) => d.status === 'PRIMARY' && d.runningCount < svc.desiredCount);

      let status: string;
      if (deploying) {
        status = colors.warning('deploying');
      } else if (healthy) {
        status = colors.success('healthy');
      } else {
        status = colors.error('unhealthy');
      }

      rows.push([
        svc.serviceName,
        `${svc.runningCount}/${svc.desiredCount}`,
        status,
      ]);
    }

    ctx.output.table(rows, {
      head: ['Service', 'Running', 'Status'],
    });
  } catch (error) {
    spinner.fail('Failed to fetch status');
    throw new AwsError(`Failed to get ECS status: ${error}`);
  }
}

async function ecsRestart(
  ctx: IExecutionContext,
  serviceRef: string,
  options: { wait?: boolean }
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const module = ctx.getModule(serviceRef);

  if (!module) {
    throw new AwsError(`Service '${serviceRef}' not found`);
  }

  const deployConfig = module.resolvedDeploy?.[env];
  if (!deployConfig || deployConfig.type !== 'ecs') {
    throw new AwsError(`No ECS config for ${module.name} in ${env}`);
  }

  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  ctx.output.header(`Restart: ${module.name}`);

  const spinner = ctx.output.spinner('Forcing new deployment');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would force new deployment');
      return;
    }

    await exec(
      `aws ecs update-service --cluster ${deployConfig.cluster} --service ${deployConfig.service} --force-new-deployment --region ${region} ${profile} --no-cli-pager`,
      { silent: true }
    );

    spinner.succeed('New deployment triggered');

    if (options.wait) {
      const waitSpinner = ctx.output.spinner('Waiting for deployment to stabilize');
      waitSpinner.start();

      await exec(
        `aws ecs wait services-stable --cluster ${deployConfig.cluster} --services ${deployConfig.service} --region ${region} ${profile}`,
        { silent: true, timeout: 600000 }
      );

      waitSpinner.succeed('Deployment stabilized');
    }
  } catch (error) {
    spinner.fail('Failed to restart service');
    throw new AwsError(`Failed to restart: ${error}`);
  }
}

async function ecsScale(
  ctx: IExecutionContext,
  serviceRef: string,
  count: number
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const module = ctx.getModule(serviceRef);

  if (!module) {
    throw new AwsError(`Service '${serviceRef}' not found`);
  }

  const deployConfig = module.resolvedDeploy?.[env];
  if (!deployConfig || deployConfig.type !== 'ecs') {
    throw new AwsError(`No ECS config for ${module.name} in ${env}`);
  }

  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  ctx.output.header(`Scale: ${module.name}`);

  const spinner = ctx.output.spinner(`Scaling to ${count} tasks`);
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would scale to ${count}`);
      return;
    }

    await exec(
      `aws ecs update-service --cluster ${deployConfig.cluster} --service ${deployConfig.service} --desired-count ${count} --region ${region} ${profile} --no-cli-pager`,
      { silent: true }
    );

    spinner.succeed(`Scaled to ${count} tasks`);
  } catch (error) {
    spinner.fail('Failed to scale service');
    throw new AwsError(`Failed to scale: ${error}`);
  }
}

// ============================================================================
// ECR Operations
// ============================================================================

async function ecrList(
  ctx: IExecutionContext,
  serviceRef: string | undefined,
  options: { limit?: string }
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;
  const limit = parseInt(options.limit ?? '10', 10);

  ctx.output.header(`ECR Images: ${env}`);

  const spinner = ctx.output.spinner('Fetching images');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would list ECR images');
      return;
    }

    // Get repositories
    const reposResult = await exec(
      `aws ecr describe-repositories --region ${region} ${profile} --output json`,
      { silent: true }
    );

    const parsed = JSON.parse(reposResult.stdout || '{}');
    const repos = (parsed.repositories ?? []) as Array<{
      repositoryName: string;
      repositoryUri: string;
    }>;

    spinner.succeed('Repositories retrieved');
    ctx.output.newline();

    if (repos.length === 0) {
      ctx.output.info('No ECR repositories found');
      return;
    }

    // Filter if service specified
    const filteredRepos = serviceRef
      ? repos.filter((r) => r.repositoryName.includes(serviceRef))
      : repos;

    if (filteredRepos.length === 0) {
      ctx.output.info(`No repositories matching '${serviceRef}'`);
      return;
    }

    ctx.output.info(`Found ${filteredRepos.length} repositories:`);
    ctx.output.newline();

    for (const repo of filteredRepos) {
      ctx.output.subheader(repo.repositoryName);

      try {
        // Get images
        const imagesResult = await exec(
          `aws ecr describe-images --repository-name ${repo.repositoryName} --region ${region} ${profile} --output json --max-items ${limit}`,
          { silent: true }
        );

        const imagesParsed = JSON.parse(imagesResult.stdout || '{}');
        const images = (imagesParsed.imageDetails ?? []) as Array<{
          imageTags?: string[];
          imagePushedAt: string;
          imageSizeInBytes: number;
        }>;

        if (images.length === 0) {
          ctx.output.info('  No images');
          ctx.output.newline();
          continue;
        }

        const rows: string[][] = [];

        for (const img of images.slice(0, limit)) {
          const tags = img.imageTags?.join(', ') ?? 'untagged';
          const size = `${Math.round(img.imageSizeInBytes / 1024 / 1024)}MB`;
          const pushed = new Date(img.imagePushedAt).toLocaleString();

          rows.push([tags, size, pushed]);
        }

        ctx.output.table(rows, {
          head: ['Tags', 'Size', 'Pushed'],
        });
      } catch (imageError) {
        ctx.output.warning(`  Failed to get images: ${imageError}`);
      }

      ctx.output.newline();
    }
  } catch (error) {
    spinner.fail('Failed to list images');
    throw new AwsError(`Failed to list ECR images: ${error}`);
  }
}

async function ecrLogin(
  ctx: IExecutionContext
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;
  const registry = awsConfig.ecrRegistry;

  if (!registry) {
    throw new AwsError(`No ECR registry configured for ${env}`);
  }

  const spinner = ctx.output.spinner('Logging in to ECR');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would login to ECR');
      return;
    }

    await exec(
      `aws ecr get-login-password --region ${region} ${profile} | docker login --username AWS --password-stdin ${registry}`,
      { silent: true }
    );

    spinner.succeed(`Logged in to ${registry}`);
  } catch (error) {
    spinner.fail('Login failed');
    throw new AwsError(`ECR login failed: ${error}`);
  }
}

// ============================================================================
// Lambda Operations
// ============================================================================

async function lambdaList(
  ctx: IExecutionContext
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  ctx.output.header(`Lambda Functions: ${env}`);

  const spinner = ctx.output.spinner('Fetching functions');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would list Lambda functions');
      return;
    }

    const result = await exec(
      `aws lambda list-functions --region ${region} ${profile} --output json`,
      { silent: true }
    );

    const functions = JSON.parse(result.stdout).Functions as Array<{
      FunctionName: string;
      Runtime: string;
      MemorySize: number;
      LastModified: string;
    }>;

    spinner.succeed('Functions retrieved');
    ctx.output.newline();

    // Get configured function names from the lambda-functions module
    const lambdaModule = ctx.getModule('aws-lambda-functions');
    const configuredFunctions = new Set(lambdaModule?.functions ?? []);

    // Filter to our functions - either configured or matching naming convention
    const ourFunctions = functions.filter((f) =>
      configuredFunctions.has(f.FunctionName) ||
      f.FunctionName.startsWith('jic-') ||
      f.FunctionName.startsWith('joyincloud-')
    );

    if (ourFunctions.length === 0) {
      ctx.output.info('No Lambda functions found');
      return;
    }

    const rows: string[][] = [];

    for (const fn of ourFunctions) {
      const isConfigured = configuredFunctions.has(fn.FunctionName);
      rows.push([
        isConfigured ? colors.primary(fn.FunctionName) : fn.FunctionName,
        fn.Runtime,
        `${fn.MemorySize}MB`,
        new Date(fn.LastModified).toLocaleString(),
      ]);
    }

    ctx.output.table(rows, {
      head: ['Function', 'Runtime', 'Memory', 'Last Modified'],
    });
  } catch (error) {
    spinner.fail('Failed to list functions');
    throw new AwsError(`Failed to list Lambda functions: ${error}`);
  }
}

async function lambdaInvoke(
  ctx: IExecutionContext,
  functionName: string,
  options: { payload?: string }
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  ctx.output.header(`Invoke: ${functionName}`);

  const spinner = ctx.output.spinner('Invoking function');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would invoke function');
      return;
    }

    const payload = options.payload ?? '{}';
    const outputFile = '/tmp/lambda-response.json';

    await exec(
      `aws lambda invoke --function-name ${functionName} --payload '${payload}' --region ${region} ${profile} ${outputFile}`,
      { silent: true }
    );

    const result = await exec(`cat ${outputFile}`, { silent: true });
    spinner.succeed('Function invoked');

    ctx.output.newline();
    ctx.output.subheader('Response');
    console.log(result.stdout);
  } catch (error) {
    spinner.fail('Invocation failed');
    throw new AwsError(`Lambda invocation failed: ${error}`);
  }
}

// ============================================================================
// AWS Identity
// ============================================================================

async function awsWhoami(
  ctx: IExecutionContext
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';

  ctx.output.header('AWS Identity');
  ctx.output.keyValue('Environment', env);
  ctx.output.keyValue('Profile', awsConfig.profile ?? 'default');
  ctx.output.newline();

  const spinner = ctx.output.spinner('Fetching identity');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would fetch identity');
      return;
    }

    const result = await exec(`aws sts get-caller-identity ${profile} --output json`, {
      silent: true,
    });

    const identity = JSON.parse(result.stdout) as {
      UserId: string;
      Account: string;
      Arn: string;
    };

    spinner.succeed('Identity retrieved');
    ctx.output.newline();

    ctx.output.keyValue('Account', identity.Account);
    ctx.output.keyValue('User ID', identity.UserId);
    ctx.output.keyValue('ARN', identity.Arn);
  } catch (error) {
    spinner.fail('Failed to get identity');
    throw new AwsError(`Failed to get AWS identity: ${error}`);
  }
}

// ============================================================================
// AWS Refresh - Sync Local State with AWS
// ============================================================================

async function awsRefresh(
  ctx: IExecutionContext
): Promise<void> {
  const env = ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = ctx.config.aws.region;

  ctx.output.header(`AWS Refresh: ${env}`);
  ctx.output.info('Syncing local state with current AWS deployment status...');
  ctx.output.newline();

  if (ctx.dryRun) {
    ctx.output.info('[dry-run] Would sync with AWS');
    return;
  }

  let updated = 0;
  let added = 0;
  let unchanged = 0;

  // Refresh ECS services
  const ecsSpinner = ctx.output.spinner('Fetching ECS service status');
  ecsSpinner.start();

  // Store task definitions to fetch ECR info later
  const taskDefinitionArns: string[] = [];
  const moduleTaskDefMap: Map<string, string> = new Map();

  try {
    const cluster = awsConfig.ecsCluster;
    if (cluster) {
      const ecsModules = Object.values(ctx.config.resolvedModules).filter(
        (m) => m.resolvedDeploy?.[env]?.type === 'ecs'
      );

      if (ecsModules.length > 0) {
        // List services
        const listResult = await exec(
          `aws ecs list-services --cluster ${cluster} --region ${region} ${profile} --output json`,
          { silent: true }
        );

        const listParsed = JSON.parse(listResult.stdout || '{}');
        const serviceArns = (listParsed.serviceArns ?? []) as string[];

        if (serviceArns.length > 0) {
          // Describe services
          const describeResult = await exec(
            `aws ecs describe-services --cluster ${cluster} --services ${serviceArns.join(' ')} --region ${region} ${profile} --output json`,
            { silent: true }
          );

          const describeParsed = JSON.parse(describeResult.stdout || '{}');
          const services = (describeParsed.services ?? []) as Array<{
            serviceName: string;
            taskDefinition: string;
            runningCount: number;
            desiredCount: number;
          }>;

          // Map service names to modules
          for (const module of ecsModules) {
            const deployConfig = module.resolvedDeploy?.[env];
            if (deployConfig?.type !== 'ecs') continue;

            const ecsService = services.find((s) => s.serviceName === deployConfig.service);
            if (!ecsService) continue;

            // Store task definition for ECR lookup
            taskDefinitionArns.push(ecsService.taskDefinition);
            moduleTaskDefMap.set(module.name, ecsService.taskDefinition);

            // Extract version from task definition (format: family:revision)
            const taskDefParts = ecsService.taskDefinition.split('/').pop()?.split(':') ?? [];
            const version = taskDefParts[1] ?? 'unknown';

            // Get local commit for comparison
            const localCommit = await getGitCommit(module.absolutePath);

            const existing = ctx.config.state.deployments[env]?.[module.name];
            const newRecord: DeploymentRecord = {
              moduleName: module.name,
              environment: env,
              version: existing?.version ?? version,
              commit: existing?.commit ?? localCommit?.substring(0, 7) ?? 'unknown',
              deployedAt: existing?.deployedAt ?? new Date().toISOString(),
              status: ecsService.runningCount === ecsService.desiredCount ? 'deployed' : 'deploying',
              ecsTaskDefinition: ecsService.taskDefinition,
            };

            if (!existing) {
              ctx.config.state.deployments[env][module.name] = newRecord;
              added++;
            } else if (existing.ecsTaskDefinition !== ecsService.taskDefinition) {
              ctx.config.state.deployments[env][module.name] = {
                ...existing,
                ...newRecord,
                deployedAt: new Date().toISOString(),
              };
              updated++;
            } else {
              unchanged++;
            }
          }
        }
      }
      ecsSpinner.succeed('ECS services synced');
    } else {
      ecsSpinner.info('No ECS cluster configured');
    }
  } catch (error) {
    ecsSpinner.fail('Failed to sync ECS services');
    ctx.output.warning(`  ${error}`);
  }

  // Refresh ECR container info from task definitions
  const ecrSpinner = ctx.output.spinner('Fetching ECR container info');
  ecrSpinner.start();

  try {
    if (taskDefinitionArns.length > 0) {
      // Fetch task definitions to get container images
      for (const [moduleName, taskDefArn] of moduleTaskDefMap.entries()) {
        try {
          const taskDefResult = await exec(
            `aws ecs describe-task-definition --task-definition ${taskDefArn} --region ${region} ${profile} --output json`,
            { silent: true }
          );

          const taskDefData = JSON.parse(taskDefResult.stdout);
          const containerDefs = (taskDefData.taskDefinition?.containerDefinitions ?? []) as Array<{
            name: string;
            image: string;
          }>;

          if (containerDefs.length > 0) {
            // Get the main container image (usually first one)
            const mainContainer = containerDefs[0];
            const imageUri = mainContainer.image;

            // Parse image URI: registry/repo:tag or registry/repo@sha256:digest
            let imageTag: string | undefined;
            let imageDigest: string | undefined;

            if (imageUri.includes('@sha256:')) {
              const parts = imageUri.split('@');
              imageDigest = parts[1];
            } else if (imageUri.includes(':')) {
              const parts = imageUri.split(':');
              imageTag = parts[parts.length - 1];
            }

            // Try to get more info from ECR
            const repoName = imageUri.split('/').pop()?.split(':')[0]?.split('@')[0];
            if (repoName) {
              try {
                const ecrResult = await exec(
                  `aws ecr describe-images --repository-name ${repoName} --image-ids imageTag=${imageTag || 'latest'} --region ${region} ${profile} --output json 2>/dev/null || echo '{}'`,
                  { silent: true }
                );

                const ecrData = JSON.parse(ecrResult.stdout || '{}');
                const imageDetails = ecrData.imageDetails?.[0];

                if (imageDetails) {
                  imageDigest = imageDetails.imageDigest;
                  // Get pushed date
                  const pushedAt = imageDetails.imagePushedAt;

                  // Update the deployment record with ECR info
                  const record = ctx.config.state.deployments[env][moduleName];
                  if (record) {
                    const hadEcrInfo = record.ecrImageTag || record.ecrImageDigest;
                    record.ecrImageTag = imageTag;
                    record.ecrImageDigest = imageDigest;
                    record.ecrImagePushedAt = pushedAt;

                    if (!hadEcrInfo) {
                      // Don't count as update if we just added ECR info to existing record
                    } else if (
                      record.ecrImageTag !== imageTag ||
                      record.ecrImageDigest !== imageDigest
                    ) {
                      // Image changed - this is already counted in ECS section
                    }
                  }
                }
              } catch {
                // ECR lookup failed, continue with what we have
              }
            }

            // Update record with basic image info even if ECR lookup failed
            const record = ctx.config.state.deployments[env][moduleName];
            if (record && !record.ecrImageTag) {
              record.ecrImageTag = imageTag;
              record.ecrImageDigest = imageDigest;
            }
          }
        } catch {
          // Task definition lookup failed for this module
        }
      }
      ecrSpinner.succeed('ECR container info synced');
    } else {
      ecrSpinner.info('No ECS services to fetch ECR info for');
    }
  } catch (error) {
    ecrSpinner.fail('Failed to sync ECR info');
    ctx.output.warning(`  ${error}`);
  }

  // Refresh Lambda functions
  const lambdaSpinner = ctx.output.spinner('Fetching Lambda function status');
  lambdaSpinner.start();

  try {
    const lambdaModule = ctx.getModule('aws-lambda-functions');
    if (lambdaModule?.functions) {
      const configuredFunctions = lambdaModule.functions;

      for (const funcName of configuredFunctions) {
        try {
          const result = await exec(
            `aws lambda get-function --function-name ${funcName} --region ${region} ${profile} --output json`,
            { silent: true }
          );

          const funcData = JSON.parse(result.stdout);
          const config = funcData.Configuration as {
            FunctionName: string;
            Version: string;
            LastModified: string;
            CodeSha256: string;
          };

          // Get versions to find the latest published version
          const versionsResult = await exec(
            `aws lambda list-versions-by-function --function-name ${funcName} --region ${region} ${profile} --output json`,
            { silent: true }
          );

          const versionsData = JSON.parse(versionsResult.stdout);
          const versions = (versionsData.Versions ?? []) as Array<{ Version: string }>;
          const latestVersion = versions
            .filter((v) => v.Version !== '$LATEST')
            .map((v) => parseInt(v.Version, 10))
            .sort((a, b) => b - a)[0];

          // Update state
          const existing = ctx.config.state.deployments[env]?.['aws-lambda-functions'];
          if (!existing) {
            ctx.config.state.deployments[env]['aws-lambda-functions'] = {
              moduleName: 'aws-lambda-functions',
              environment: env,
              version: '1.00',
              commit: 'unknown',
              deployedAt: config.LastModified,
              status: 'deployed',
              functions: {},
            };
            added++;
          }

          const record = ctx.config.state.deployments[env]['aws-lambda-functions'];
          if (!record.functions) record.functions = {};

          const existingFunc = record.functions[funcName];
          if (!existingFunc) {
            record.functions[funcName] = {
              version: '1.00',
              lambdaVersion: latestVersion?.toString() ?? '1',
              deployedAt: config.LastModified,
            };
          } else if (existingFunc.lambdaVersion !== latestVersion?.toString()) {
            record.functions[funcName] = {
              ...existingFunc,
              lambdaVersion: latestVersion?.toString() ?? existingFunc.lambdaVersion,
              deployedAt: config.LastModified,
            };
            updated++;
          } else {
            unchanged++;
          }
        } catch {
          // Function doesn't exist in AWS, skip
        }
      }
      lambdaSpinner.succeed('Lambda functions synced');
    } else {
      lambdaSpinner.info('No Lambda functions configured');
    }
  } catch (error) {
    lambdaSpinner.fail('Failed to sync Lambda functions');
    ctx.output.warning(`  ${error}`);
  }

  // Refresh Lambda layer
  const layerSpinner = ctx.output.spinner('Fetching Lambda layer status');
  layerSpinner.start();

  try {
    const layerModule = ctx.getModule('aws-lambda-layer');
    if (layerModule) {
      const layerConfig = layerModule.resolvedDeploy?.[env];
      if (layerConfig?.type === 'lambda-layer') {
        const result = await exec(
          `aws lambda list-layer-versions --layer-name ${layerConfig.layerName} --region ${region} ${profile} --output json`,
          { silent: true }
        );

        const layerData = JSON.parse(result.stdout);
        const versions = (layerData.LayerVersions ?? []) as Array<{
          Version: number;
          CreatedDate: string;
        }>;

        if (versions.length > 0) {
          const latestVersion = versions[0];
          const existing = ctx.config.state.deployments[env]?.['aws-lambda-layer'];

          if (!existing) {
            ctx.config.state.deployments[env]['aws-lambda-layer'] = {
              moduleName: 'aws-lambda-layer',
              environment: env,
              version: '1.00',
              commit: 'unknown',
              deployedAt: latestVersion.CreatedDate,
              status: 'deployed',
              lambdaVersion: latestVersion.Version.toString(),
            };
            added++;
          } else if (existing.lambdaVersion !== latestVersion.Version.toString()) {
            ctx.config.state.deployments[env]['aws-lambda-layer'] = {
              ...existing,
              lambdaVersion: latestVersion.Version.toString(),
              deployedAt: latestVersion.CreatedDate,
            };
            updated++;
          } else {
            unchanged++;
          }
        }
        layerSpinner.succeed('Lambda layer synced');
      } else {
        layerSpinner.info('No Lambda layer configured');
      }
    } else {
      layerSpinner.info('No Lambda layer module found');
    }
  } catch (error) {
    layerSpinner.fail('Failed to sync Lambda layer');
    ctx.output.warning(`  ${error}`);
  }

  // Save state
  await ctx.saveState();

  ctx.output.newline();
  ctx.output.success(`Refresh complete: ${added} added, ${updated} updated, ${unchanged} unchanged`);
}
