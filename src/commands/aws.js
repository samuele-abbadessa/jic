/**
 * AWS commands - wrapper for common AWS operations
 *
 * Commands:
 *   jic aws ecs list - List ECS services
 *   jic aws ecs status <service> - Service status
 *   jic aws ecs logs <service> - View logs
 *   jic aws ecs restart <service> - Force new deployment
 *   jic aws ecs scale <service> <count> - Scale service
 *   jic aws ecs start-all - Start all services
 *   jic aws ecs stop-all - Stop all services
 *   jic aws ecr list - List ECR images
 *   jic aws lambda list - List Lambda functions
 *   jic aws cf invalidate - Invalidate CloudFront
 */

import { withErrorHandling, AwsError } from '../utils/error.js';
import { exec, execWithSpinner } from '../utils/shell.js';
import { output, createSpinner } from '../utils/output.js';

/**
 * Register AWS commands
 */
export function registerAwsCommands(program, ctx) {
  const aws = program
    .command('aws')
    .description('AWS resource management');

  // ECS subcommands
  const ecs = aws
    .command('ecs')
    .description('ECS operations');

  ecs
    .command('list')
    .description('List ECS services')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (options) => {
      await ecsListServices(ctx, options);
    }));

  ecs
    .command('status [service]')
    .description('Show ECS service status')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (service, options) => {
      await ecsStatus(ctx, service, options);
    }));

  ecs
    .command('logs <service>')
    .description('View service logs')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines', '100')
    .action(withErrorHandling(async (service, options) => {
      await ecsLogs(ctx, service, options);
    }));

  ecs
    .command('restart <service>')
    .description('Force new deployment')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--wait', 'Wait for deployment to stabilize')
    .action(withErrorHandling(async (service, options) => {
      await ecsRestart(ctx, service, options);
    }));

  ecs
    .command('scale <service> <count>')
    .description('Scale service desired count')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (service, count, options) => {
      await ecsScale(ctx, service, parseInt(count), options);
    }));

  ecs
    .command('start-all')
    .description('Start all services (set desired count to 1)')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--exclude <services>', 'Comma-separated list of services to exclude')
    .action(withErrorHandling(async (options) => {
      await ecsStartAll(ctx, options);
    }));

  ecs
    .command('stop-all')
    .description('Stop all services (set desired count to 0)')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--exclude <services>', 'Comma-separated list of services to exclude')
    .action(withErrorHandling(async (options) => {
      await ecsStopAll(ctx, options);
    }));

  // ECR subcommands
  const ecr = aws
    .command('ecr')
    .description('ECR operations');

  ecr
    .command('list')
    .description('List ECR repositories')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (options) => {
      await ecrList(ctx, options);
    }));

  ecr
    .command('images <repo>')
    .description('List images in repository')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (repo, options) => {
      await ecrImages(ctx, repo, options);
    }));

  // Lambda subcommands
  const lambda = aws
    .command('lambda')
    .description('Lambda operations');

  lambda
    .command('list')
    .description('List Lambda functions')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (options) => {
      await lambdaList(ctx, options);
    }));

  lambda
    .command('invoke <function>')
    .description('Invoke Lambda function')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('-p, --payload <json>', 'JSON payload')
    .action(withErrorHandling(async (func, options) => {
      await lambdaInvoke(ctx, func, options);
    }));

  // CloudFront subcommands
  const cf = aws
    .command('cf')
    .description('CloudFront operations');

  cf
    .command('invalidate')
    .description('Invalidate CloudFront cache')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--paths <paths>', 'Paths to invalidate', '/*')
    .option('--wait', 'Wait for invalidation to complete')
    .action(withErrorHandling(async (options) => {
      await cfInvalidate(ctx, options);
    }));
}

/**
 * Get AWS CLI profile flag
 */
function getProfileFlag(awsConfig) {
  return awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
}

/**
 * List ECS services
 */
async function ecsListServices(ctx, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  output.header(`ECS Services (${env})`);

  const spinner = createSpinner('Fetching services');
  spinner.start();

  try {
    const result = await exec(
      `aws ecs list-services --cluster ${awsConfig.ecsCluster} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    spinner.stop();

    if (data.serviceArns.length === 0) {
      output.info('No services found');
      return;
    }

    // Get service details
    const serviceNames = data.serviceArns.map(arn => arn.split('/').pop());
    const describeResult = await exec(
      `aws ecs describe-services --cluster ${awsConfig.ecsCluster} --services ${serviceNames.join(' ')} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const services = JSON.parse(describeResult.stdout).services;

    const rows = services.map(s => [
      output.module(s.serviceName),
      s.status,
      `${s.runningCount}/${s.desiredCount}`,
      s.deployments?.[0]?.rolloutState || 'N/A'
    ]);

    output.table(rows, {
      head: ['Service', 'Status', 'Running', 'Deployment']
    });
  } catch (error) {
    spinner.fail('Failed to fetch services');
    throw new AwsError(error.message, 'ECS');
  }
}

/**
 * ECS service status
 */
async function ecsStatus(ctx, service, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  // If no service specified, show all
  if (!service) {
    return ecsListServices(ctx, options);
  }

  // Resolve service name from module alias
  const module = ctx.getModule(service);
  const serviceName = module?.deploy?.[env]?.service || service;

  output.header(`Service Status: ${serviceName}`);

  const spinner = createSpinner('Fetching status');
  spinner.start();

  try {
    const result = await exec(
      `aws ecs describe-services --cluster ${awsConfig.ecsCluster} --services ${serviceName} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    spinner.stop();

    if (data.services.length === 0) {
      output.error(`Service not found: ${serviceName}`);
      return;
    }

    const svc = data.services[0];

    output.keyValue('Service', svc.serviceName);
    output.keyValue('Status', svc.status);
    output.keyValue('Running', `${svc.runningCount}/${svc.desiredCount}`);
    output.keyValue('Pending', svc.pendingCount);
    output.keyValue('Task Definition', svc.taskDefinition.split('/').pop());

    if (svc.deployments && svc.deployments.length > 0) {
      output.newline();
      output.subheader('Deployments');

      const rows = svc.deployments.map(d => [
        d.id.substring(0, 12),
        d.status,
        d.rolloutState || 'N/A',
        `${d.runningCount}/${d.desiredCount}`,
        new Date(d.createdAt).toLocaleString()
      ]);

      output.table(rows, {
        head: ['ID', 'Status', 'Rollout', 'Tasks', 'Created']
      });
    }
  } catch (error) {
    spinner.fail('Failed to fetch status');
    throw new AwsError(error.message, 'ECS');
  }
}

/**
 * View ECS service logs
 */
async function ecsLogs(ctx, service, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  // Resolve service name from module alias
  const module = ctx.getModule(service);
  const serviceName = module?.deploy?.[env]?.service || service;

  output.header(`Logs: ${serviceName}`);

  // Get log group name (assuming standard naming)
  const logGroup = `/ecs/${serviceName}`;

  try {
    const followFlag = options.follow ? '--follow' : '';
    const cmd = `aws logs tail ${logGroup} --since 1h ${followFlag} --region ${awsConfig.region} ${profile}`;

    if (options.follow) {
      // Stream logs
      const { spawn } = await import('child_process');
      const args = ['logs', 'tail', logGroup, '--since', '1h', '--follow', '--region', awsConfig.region];
      if (awsConfig.profile) {
        args.push('--profile', awsConfig.profile);
      }

      const child = spawn('aws', args, { stdio: 'inherit' });

      child.on('error', (error) => {
        output.error(`Failed to stream logs: ${error.message}`);
      });
    } else {
      const result = await exec(cmd, { silent: true });
      console.log(result.stdout);
    }
  } catch (error) {
    throw new AwsError(`Failed to fetch logs: ${error.message}`, 'CloudWatch');
  }
}

/**
 * Restart ECS service
 */
async function ecsRestart(ctx, service, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  // Resolve service name
  const module = ctx.getModule(service);
  const serviceName = module?.deploy?.[env]?.service || service;

  output.header(`Restart: ${serviceName}`);

  const spinner = createSpinner('Forcing new deployment');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would restart ${serviceName}`);
      return;
    }

    await exec(
      `aws ecs update-service --cluster ${awsConfig.ecsCluster} --service ${serviceName} --force-new-deployment --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    spinner.succeed('Deployment initiated');

    if (options.wait) {
      const waitSpinner = createSpinner('Waiting for stabilization');
      waitSpinner.start();

      await exec(
        `aws ecs wait services-stable --cluster ${awsConfig.ecsCluster} --services ${serviceName} --region ${awsConfig.region} ${profile}`,
        { silent: true, timeout: 600000 }
      );

      waitSpinner.succeed('Service stabilized');
    }
  } catch (error) {
    spinner.fail('Restart failed');
    throw new AwsError(error.message, 'ECS');
  }
}

/**
 * Scale ECS service
 */
async function ecsScale(ctx, service, count, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  // Resolve service name
  const module = ctx.getModule(service);
  const serviceName = module?.deploy?.[env]?.service || service;

  output.header(`Scale: ${serviceName} → ${count}`);

  const spinner = createSpinner('Scaling service');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would scale ${serviceName} to ${count}`);
      return;
    }

    await exec(
      `aws ecs update-service --cluster ${awsConfig.ecsCluster} --service ${serviceName} --desired-count ${count} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    spinner.succeed(`Scaled ${serviceName} to ${count}`);
  } catch (error) {
    spinner.fail('Scale failed');
    throw new AwsError(error.message, 'ECS');
  }
}

/**
 * Start all ECS services
 */
async function ecsStartAll(ctx, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);
  const exclude = options.exclude ? options.exclude.split(',') : [];

  output.header(`Start All Services (${env})`);

  const spinner = createSpinner('Fetching services');
  spinner.start();

  try {
    const result = await exec(
      `aws ecs list-services --cluster ${awsConfig.ecsCluster} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    const services = data.serviceArns.map(arn => arn.split('/').pop()).filter(s => !exclude.includes(s));

    spinner.stop();

    for (const service of services) {
      const svcSpinner = createSpinner(`Starting ${service}`);
      svcSpinner.start();

      if (ctx.dryRun) {
        svcSpinner.info(`[dry-run] Would start ${service}`);
        continue;
      }

      await exec(
        `aws ecs update-service --cluster ${awsConfig.ecsCluster} --service ${service} --desired-count 1 --region ${awsConfig.region} ${profile}`,
        { silent: true }
      );

      svcSpinner.succeed(`Started ${service}`);
    }

    output.newline();
    output.success(`Started ${services.length} services`);
  } catch (error) {
    spinner.fail('Failed to start services');
    throw new AwsError(error.message, 'ECS');
  }
}

/**
 * Stop all ECS services
 */
async function ecsStopAll(ctx, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);
  const exclude = options.exclude ? options.exclude.split(',') : [];

  output.header(`Stop All Services (${env})`);

  const spinner = createSpinner('Fetching services');
  spinner.start();

  try {
    const result = await exec(
      `aws ecs list-services --cluster ${awsConfig.ecsCluster} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    const services = data.serviceArns.map(arn => arn.split('/').pop()).filter(s => !exclude.includes(s));

    spinner.stop();

    for (const service of services) {
      const svcSpinner = createSpinner(`Stopping ${service}`);
      svcSpinner.start();

      if (ctx.dryRun) {
        svcSpinner.info(`[dry-run] Would stop ${service}`);
        continue;
      }

      await exec(
        `aws ecs update-service --cluster ${awsConfig.ecsCluster} --service ${service} --desired-count 0 --region ${awsConfig.region} ${profile}`,
        { silent: true }
      );

      svcSpinner.succeed(`Stopped ${service}`);
    }

    output.newline();
    output.success(`Stopped ${services.length} services`);
  } catch (error) {
    spinner.fail('Failed to stop services');
    throw new AwsError(error.message, 'ECS');
  }
}

/**
 * List ECR repositories
 */
async function ecrList(ctx, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  output.header(`ECR Repositories (${env})`);

  const spinner = createSpinner('Fetching repositories');
  spinner.start();

  try {
    const result = await exec(
      `aws ecr describe-repositories --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    spinner.stop();

    const rows = data.repositories.map(r => [
      output.module(r.repositoryName),
      r.repositoryUri
    ]);

    output.table(rows, {
      head: ['Repository', 'URI']
    });
  } catch (error) {
    spinner.fail('Failed to fetch repositories');
    throw new AwsError(error.message, 'ECR');
  }
}

/**
 * List images in ECR repository
 */
async function ecrImages(ctx, repo, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  output.header(`Images: ${repo}`);

  const spinner = createSpinner('Fetching images');
  spinner.start();

  try {
    const result = await exec(
      `aws ecr describe-images --repository-name ${repo} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    spinner.stop();

    const rows = data.imageDetails
      .sort((a, b) => new Date(b.imagePushedAt) - new Date(a.imagePushedAt))
      .slice(0, 10)
      .map(img => [
        img.imageTags?.join(', ') || 'untagged',
        `${(img.imageSizeInBytes / 1024 / 1024).toFixed(1)} MB`,
        new Date(img.imagePushedAt).toLocaleString()
      ]);

    output.table(rows, {
      head: ['Tags', 'Size', 'Pushed']
    });
  } catch (error) {
    spinner.fail('Failed to fetch images');
    throw new AwsError(error.message, 'ECR');
  }
}

/**
 * List Lambda functions
 */
async function lambdaList(ctx, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  output.header(`Lambda Functions (${env})`);

  const spinner = createSpinner('Fetching functions');
  spinner.start();

  try {
    const result = await exec(
      `aws lambda list-functions --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    spinner.stop();

    const rows = data.Functions.map(f => [
      output.module(f.FunctionName),
      f.Runtime,
      `${f.MemorySize} MB`,
      new Date(f.LastModified).toLocaleString()
    ]);

    output.table(rows, {
      head: ['Function', 'Runtime', 'Memory', 'Last Modified']
    });
  } catch (error) {
    spinner.fail('Failed to fetch functions');
    throw new AwsError(error.message, 'Lambda');
  }
}

/**
 * Invoke Lambda function
 */
async function lambdaInvoke(ctx, func, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  output.header(`Invoke: ${func}`);

  const spinner = createSpinner('Invoking function');
  spinner.start();

  try {
    const payload = options.payload || '{}';
    const outputFile = `/tmp/lambda-${func}-response.json`;

    await exec(
      `aws lambda invoke --function-name ${func} --payload '${payload}' --region ${awsConfig.region} ${profile} ${outputFile}`,
      { silent: true }
    );

    const response = await exec(`cat ${outputFile}`, { silent: true });
    spinner.succeed('Function invoked');

    output.newline();
    output.subheader('Response');
    console.log(response.stdout);
  } catch (error) {
    spinner.fail('Invocation failed');
    throw new AwsError(error.message, 'Lambda');
  }
}

/**
 * Invalidate CloudFront
 */
async function cfInvalidate(ctx, options) {
  const env = options.env || ctx.env;
  const frontendModule = ctx.getModule('gwc') || ctx.getModule('frontend');

  if (!frontendModule) {
    throw new AwsError('Frontend module not found');
  }

  const deployConfig = frontendModule.deploy?.[env];
  if (!deployConfig?.distributionId) {
    throw new AwsError(`No CloudFront distribution configured for ${env}`);
  }

  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);
  const paths = options.paths || '/*';

  output.header('CloudFront Invalidation');
  output.keyValue('Distribution', deployConfig.distributionId);
  output.keyValue('Paths', paths);
  output.newline();

  const spinner = createSpinner('Creating invalidation');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would create invalidation');
      return;
    }

    const result = await exec(
      `aws cloudfront create-invalidation --distribution-id ${deployConfig.distributionId} --paths "${paths}" ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    const invalidationId = data.Invalidation.Id;

    if (options.wait) {
      spinner.text = `Waiting for invalidation ${invalidationId}`;

      await exec(
        `aws cloudfront wait invalidation-completed --distribution-id ${deployConfig.distributionId} --id "${invalidationId}" ${profile}`,
        { silent: true, timeout: 300000 }
      );

      spinner.succeed(`Invalidation completed: ${invalidationId}`);
    } else {
      spinner.succeed(`Invalidation created: ${invalidationId}`);
    }
  } catch (error) {
    spinner.fail('Invalidation failed');
    throw new AwsError(error.message, 'CloudFront');
  }
}

export default { registerAwsCommands };
