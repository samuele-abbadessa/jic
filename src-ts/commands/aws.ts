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
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { Environment } from '../core/types/config.js';
import { AwsError, withErrorHandling } from '../core/errors/index.js';
import { exec } from '../core/utils/shell.js';
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
    .option('-e, --env <env>', 'Environment', 'dev')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines to show', '100')
    .option('--since <time>', 'Show logs since (e.g., 1h, 30m, 2d)')
    .action(
      withErrorHandling(
        async (
          service: string,
          options: { env?: Environment; follow?: boolean; lines?: string; since?: string }
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
    .option('-e, --env <env>', 'Environment', 'dev')
    .action(
      withErrorHandling(async (options: { env?: Environment }) => {
        const ctx = await createContext();
        await ecsStatus(ctx, options);
      })
    );

  ecs
    .command('restart <service>')
    .description('Force new deployment for a service')
    .option('-e, --env <env>', 'Environment', 'dev')
    .option('--wait', 'Wait for deployment to stabilize')
    .action(
      withErrorHandling(async (service: string, options: { env?: Environment; wait?: boolean }) => {
        const ctx = await createContext();
        await ecsRestart(ctx, service, options);
      })
    );

  ecs
    .command('scale <service> <count>')
    .description('Scale service to desired count')
    .option('-e, --env <env>', 'Environment', 'dev')
    .action(
      withErrorHandling(async (service: string, count: string, options: { env?: Environment }) => {
        const ctx = await createContext();
        await ecsScale(ctx, service, parseInt(count, 10), options);
      })
    );

  // ECR subcommand
  const ecr = aws.command('ecr').description('ECR operations');

  ecr
    .command('list [service]')
    .description('List ECR images')
    .option('-e, --env <env>', 'Environment', 'dev')
    .option('-n, --limit <n>', 'Number of images to show', '10')
    .action(
      withErrorHandling(
        async (service: string | undefined, options: { env?: Environment; limit?: string }) => {
          const ctx = await createContext();
          await ecrList(ctx, service, options);
        }
      )
    );

  ecr
    .command('login')
    .description('Login to ECR')
    .option('-e, --env <env>', 'Environment', 'dev')
    .action(
      withErrorHandling(async (options: { env?: Environment }) => {
        const ctx = await createContext();
        await ecrLogin(ctx, options);
      })
    );

  // Lambda subcommand
  const lambda = aws.command('lambda').description('Lambda operations');

  lambda
    .command('list')
    .description('List Lambda functions')
    .option('-e, --env <env>', 'Environment', 'dev')
    .action(
      withErrorHandling(async (options: { env?: Environment }) => {
        const ctx = await createContext();
        await lambdaList(ctx, options);
      })
    );

  lambda
    .command('invoke <function>')
    .description('Invoke a Lambda function')
    .option('-e, --env <env>', 'Environment', 'dev')
    .option('-p, --payload <json>', 'JSON payload')
    .action(
      withErrorHandling(
        async (func: string, options: { env?: Environment; payload?: string }) => {
          const ctx = await createContext();
          await lambdaInvoke(ctx, func, options);
        }
      )
    );

  // Config/Profile command
  aws
    .command('whoami')
    .description('Show current AWS identity')
    .option('-e, --env <env>', 'Environment', 'dev')
    .action(
      withErrorHandling(async (options: { env?: Environment }) => {
        const ctx = await createContext();
        await awsWhoami(ctx, options);
      })
    );
}

// ============================================================================
// AWS Logs
// ============================================================================

async function awsLogs(
  ctx: IExecutionContext,
  serviceRef: string,
  options: { env?: Environment; follow?: boolean; lines?: string; since?: string }
): Promise<void> {
  const env = options.env ?? ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const module = ctx.getModule(serviceRef);

  if (!module) {
    throw new AwsError(`Service '${serviceRef}' not found`);
  }

  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = 'eu-west-1';
  const logGroup = awsConfig.logGroup ?? `jic-${env}-logs`;
  const logStream = module.name;

  ctx.output.header(`Logs: ${module.name}`);
  ctx.output.keyValue('Environment', env);
  ctx.output.keyValue('Log Group', logGroup);
  ctx.output.newline();

  // Build command
  let cmd = `aws logs tail ${logGroup} --region ${region} ${profile}`;

  if (options.follow) {
    cmd += ' --follow';
  }

  if (options.since) {
    cmd += ` --since ${options.since}`;
  }

  // Filter to specific service
  cmd += ` --log-stream-name-prefix ${logStream}`;

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
  ctx: IExecutionContext,
  options: { env?: Environment }
): Promise<void> {
  const env = options.env ?? ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = 'eu-west-1';
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

    const serviceArns = JSON.parse(listResult.stdout).serviceArns as string[];

    if (serviceArns.length === 0) {
      spinner.info('No services found');
      return;
    }

    // Describe services
    const describeResult = await exec(
      `aws ecs describe-services --cluster ${cluster} --services ${serviceArns.join(' ')} --region ${region} ${profile} --output json`,
      { silent: true }
    );

    const services = JSON.parse(describeResult.stdout).services as Array<{
      serviceName: string;
      status: string;
      runningCount: number;
      desiredCount: number;
      deployments: Array<{ status: string; runningCount: number }>;
    }>;

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
  options: { env?: Environment; wait?: boolean }
): Promise<void> {
  const env = options.env ?? ctx.env;
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
  const region = 'eu-west-1';

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
  count: number,
  options: { env?: Environment }
): Promise<void> {
  const env = options.env ?? ctx.env;
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
  const region = 'eu-west-1';

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
  options: { env?: Environment; limit?: string }
): Promise<void> {
  const env = options.env ?? ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = 'eu-west-1';
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

    const repos = JSON.parse(reposResult.stdout).repositories as Array<{
      repositoryName: string;
      repositoryUri: string;
    }>;

    spinner.succeed('Images retrieved');
    ctx.output.newline();

    // Filter if service specified
    const filteredRepos = serviceRef
      ? repos.filter((r) => r.repositoryName.includes(serviceRef))
      : repos;

    for (const repo of filteredRepos) {
      ctx.output.subheader(repo.repositoryName);

      // Get images
      const imagesResult = await exec(
        `aws ecr describe-images --repository-name ${repo.repositoryName} --region ${region} ${profile} --output json --max-items ${limit}`,
        { silent: true }
      );

      const images = JSON.parse(imagesResult.stdout).imageDetails as Array<{
        imageTags?: string[];
        imagePushedAt: string;
        imageSizeInBytes: number;
      }>;

      const rows: string[][] = [];

      for (const img of images.slice(0, limit)) {
        const tags = img.imageTags?.join(', ') ?? 'untagged';
        const size = `${Math.round(img.imageSizeInBytes / 1024 / 1024)}MB`;
        const pushed = new Date(img.imagePushedAt).toLocaleString();

        rows.push([tags, size, pushed]);
      }

      if (rows.length > 0) {
        ctx.output.table(rows, {
          head: ['Tags', 'Size', 'Pushed'],
        });
      } else {
        ctx.output.info('  No images');
      }

      ctx.output.newline();
    }
  } catch (error) {
    spinner.fail('Failed to list images');
    throw new AwsError(`Failed to list ECR images: ${error}`);
  }
}

async function ecrLogin(
  ctx: IExecutionContext,
  options: { env?: Environment }
): Promise<void> {
  const env = options.env ?? ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = 'eu-west-1';
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
  ctx: IExecutionContext,
  options: { env?: Environment }
): Promise<void> {
  const env = options.env ?? ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = 'eu-west-1';

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

    // Filter to our functions (by naming convention)
    const ourFunctions = functions.filter((f) =>
      f.FunctionName.startsWith('jic-') || f.FunctionName.startsWith('joyincloud-')
    );

    if (ourFunctions.length === 0) {
      ctx.output.info('No Lambda functions found');
      return;
    }

    const rows: string[][] = [];

    for (const fn of ourFunctions) {
      rows.push([
        fn.FunctionName,
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
  options: { env?: Environment; payload?: string }
): Promise<void> {
  const env = options.env ?? ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const region = 'eu-west-1';

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
  ctx: IExecutionContext,
  options: { env?: Environment }
): Promise<void> {
  const env = options.env ?? ctx.env;
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
