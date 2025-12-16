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

import inquirer from 'inquirer';
import { withErrorHandling, AwsError } from '../utils/error.js';
import { exec, execWithSpinner } from '../utils/shell.js';
import { output, createSpinner } from '../utils/output.js';
import { saveConfig } from '../lib/config.js';

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

  lambda
    .command('create <function>')
    .description('Create a new Lambda function')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--runtime <runtime>', 'Runtime (e.g., nodejs18.x, python3.11)')
    .option('--handler <handler>', 'Handler (e.g., index.handler)')
    .option('--role <arn>', 'IAM role ARN')
    .option('--timeout <seconds>', 'Timeout in seconds')
    .option('--memory <mb>', 'Memory size in MB')
    .action(withErrorHandling(async (func, options) => {
      await lambdaCreate(ctx, func, options);
    }));

  lambda
    .command('exists <function>')
    .description('Check if Lambda function exists')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (func, options) => {
      await lambdaCheckExists(ctx, func, options);
    }));

  lambda
    .command('init-all')
    .description('Fetch Lambda configurations from AWS and update jic.config.json')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--show-only', 'Only show what would be changed, do not apply')
    .action(withErrorHandling(async (options) => {
      await lambdaInitAll(ctx, options);
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
 * Check if a Lambda function exists
 * @param {string} functionName - Function name
 * @param {string} region - AWS region
 * @param {string} profile - AWS profile (optional)
 * @returns {Promise<boolean>} - True if function exists
 */
export async function lambdaFunctionExists(functionName, region, profile = '') {
  try {
    const profileFlag = profile ? `--profile ${profile}` : '';
    await exec(
      `aws lambda get-function --function-name ${functionName} --region ${region} ${profileFlag}`,
      { silent: true }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Lambda function configuration from module config
 */
function getLambdaFunctionConfig(module, functionName) {
  const defaults = module.lambdaDefaults || {
    runtime: 'nodejs18.x',
    handler: 'index.handler',
    timeout: 30,
    memorySize: 256
  };

  const functionConfig = module.functionConfig?.[functionName] || {};

  return {
    ...defaults,
    ...functionConfig
  };
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

  // Get log group and stream prefix from config
  // Default pattern: log group "jic-dev-logs" with stream prefix "gws-dev/"
  const logGroup = awsConfig.logGroup || `jic-${env}-logs`;
  // Stream prefix is the service name without "-service" suffix (e.g., "gws-dev" from "gws-dev-service")
  const streamPrefix = serviceName.replace(/-service$/, '');

  output.keyValue('Log Group', logGroup);
  output.keyValue('Stream Prefix', streamPrefix);
  output.newline();

  try {
    const followFlag = options.follow ? '--follow' : '';
    const streamFilter = `--log-stream-name-prefix ${streamPrefix}/`;

    if (options.follow) {
      // Stream logs
      const { spawn } = await import('child_process');
      const args = ['logs', 'tail', logGroup, '--since', '1h', '--follow', '--log-stream-name-prefix', `${streamPrefix}/`, '--region', awsConfig.region];
      if (awsConfig.profile) {
        args.push('--profile', awsConfig.profile);
      }

      const child = spawn('aws', args, { stdio: 'inherit' });

      child.on('error', (error) => {
        output.error(`Failed to stream logs: ${error.message}`);
      });
    } else {
      const cmd = `aws logs tail ${logGroup} --since 1h ${streamFilter} --region ${awsConfig.region} ${profile}`;
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
 * Create a new Lambda function
 */
async function lambdaCreate(ctx, functionName, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  // Get Lambda module for config
  const module = ctx.getModule('aws-lambda-functions');
  if (!module) {
    throw new AwsError('Lambda functions module not found');
  }

  const deployConfig = module.deploy?.[env];
  if (!deployConfig?.role) {
    throw new AwsError(`No IAM role configured for Lambda in ${env} environment. Add 'role' to deploy.${env} in jic.config.json`);
  }

  // Get function config (from module config or CLI options)
  const funcConfig = getLambdaFunctionConfig(module, functionName);
  const runtime = options.runtime || funcConfig.runtime;
  const handler = options.handler || funcConfig.handler;
  const timeout = options.timeout || funcConfig.timeout;
  const memorySize = options.memory || funcConfig.memorySize;
  const role = options.role || deployConfig.role;

  output.header(`Create Lambda: ${functionName}`);
  output.keyValue('Environment', env);
  output.keyValue('Runtime', runtime);
  output.keyValue('Handler', handler);
  output.keyValue('Timeout', `${timeout}s`);
  output.keyValue('Memory', `${memorySize} MB`);
  output.keyValue('Role', role);
  output.newline();

  // Check if function already exists
  const exists = await lambdaFunctionExists(functionName, awsConfig.region, awsConfig.profile);
  if (exists) {
    output.warning(`Function '${functionName}' already exists in ${env}`);
    return;
  }

  const spinner = createSpinner('Creating Lambda function');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would create ${functionName}`);
      return;
    }

    // Create a minimal deployment package (placeholder)
    const functionPath = `${module.absolutePath}/${functionName}`;
    const zipFile = `${module.absolutePath}/create-${functionName}.zip`;

    // Check if function directory exists
    const dirExists = await exec(`test -d ${functionPath} && echo "yes" || echo "no"`, { silent: true });

    if (dirExists.stdout.trim() === 'yes') {
      // Install dependencies if package.json exists
      await exec(`cd ${functionPath} && [ -f package.json ] && npm install --production || true`, { silent: true });
      // Create zip from existing code
      await exec(`cd ${functionPath} && zip -r ${zipFile} .`, { silent: true });
    } else {
      // Create minimal placeholder
      await exec(`mkdir -p ${functionPath}`, { silent: true });
      await exec(`echo "exports.handler = async (event) => { return { statusCode: 200, body: 'Hello from ${functionName}' }; };" > ${functionPath}/index.js`, { silent: true });
      await exec(`cd ${functionPath} && zip -r ${zipFile} .`, { silent: true });
    }

    // Create the Lambda function
    await exec(
      `aws lambda create-function \
        --function-name ${functionName} \
        --runtime ${runtime} \
        --handler ${handler} \
        --role ${role} \
        --timeout ${timeout} \
        --memory-size ${memorySize} \
        --zip-file fileb://${zipFile} \
        --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    // Clean up zip file
    await exec(`rm -f ${zipFile}`, { silent: true });

    spinner.succeed(`Created ${functionName}`);

    // Add to functions list if not already there
    if (!module.functions.includes(functionName)) {
      output.info(`Remember to add '${functionName}' to the functions list in jic.config.json`);
    }
  } catch (error) {
    spinner.fail('Creation failed');
    const awsError = new AwsError(`Failed to create Lambda function: ${error.message}`, 'Lambda');
    awsError.cause = error;
    throw awsError;
  }
}

/**
 * Check if Lambda function exists
 */
async function lambdaCheckExists(ctx, functionName, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  output.header(`Check Lambda: ${functionName}`);

  const spinner = createSpinner('Checking function');
  spinner.start();

  try {
    const result = await exec(
      `aws lambda get-function --function-name ${functionName} --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    const config = data.Configuration;
    spinner.stop();

    output.success(`Function '${functionName}' exists`);
    output.newline();
    output.keyValue('Runtime', config.Runtime);
    output.keyValue('Handler', config.Handler);
    output.keyValue('Timeout', `${config.Timeout}s`);
    output.keyValue('Memory', `${config.MemorySize} MB`);
    output.keyValue('Last Modified', new Date(config.LastModified).toLocaleString());
    output.keyValue('Code Size', `${(config.CodeSize / 1024).toFixed(1)} KB`);
    output.keyValue('State', config.State);
  } catch (error) {
    spinner.stop();
    output.error(`Function '${functionName}' does not exist in ${env}`);
  }
}

/**
 * Fetch Lambda configurations from AWS and update jic.config.json
 */
async function lambdaInitAll(ctx, options) {
  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = getProfileFlag(awsConfig);

  output.header(`Initialize Lambda Config from AWS (${env})`);

  const spinner = createSpinner('Fetching functions from AWS');
  spinner.start();

  try {
    const result = await exec(
      `aws lambda list-functions --region ${awsConfig.region} ${profile}`,
      { silent: true }
    );

    const data = JSON.parse(result.stdout);
    spinner.stop();

    if (data.Functions.length === 0) {
      output.info('No Lambda functions found in AWS');
      return;
    }

    output.info(`Found ${data.Functions.length} function(s) in AWS`);
    output.newline();

    // Get Lambda module
    const module = ctx.getModule('aws-lambda-functions');
    if (!module) {
      throw new AwsError('Lambda functions module not found in jic.config.json');
    }

    // Find most common runtime for defaults
    const runtimeCounts = {};
    data.Functions.forEach(f => {
      if (f.Runtime) {
        runtimeCounts[f.Runtime] = (runtimeCounts[f.Runtime] || 0) + 1;
      }
    });
    const mostCommonRuntime = Object.entries(runtimeCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'nodejs18.x';

    // Find most common handler pattern
    const handlerCounts = {};
    data.Functions.forEach(f => {
      if (f.Handler) {
        handlerCounts[f.Handler] = (handlerCounts[f.Handler] || 0) + 1;
      }
    });
    const mostCommonHandler = Object.entries(handlerCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'index.handler';

    // Build new config values
    const newDefaults = {
      runtime: mostCommonRuntime,
      handler: mostCommonHandler,
      timeout: 30,
      memorySize: 256
    };

    const newFunctions = data.Functions.map(f => f.FunctionName).sort();

    const newFunctionConfig = {};
    for (const func of data.Functions) {
      const needsCustomConfig =
        func.Runtime !== mostCommonRuntime ||
        func.Handler !== mostCommonHandler ||
        func.Timeout !== 30 ||
        func.MemorySize !== 256;

      if (needsCustomConfig) {
        newFunctionConfig[func.FunctionName] = {};
        if (func.Runtime !== mostCommonRuntime) {
          newFunctionConfig[func.FunctionName].runtime = func.Runtime;
        }
        if (func.Handler !== mostCommonHandler) {
          newFunctionConfig[func.FunctionName].handler = func.Handler;
        }
        if (func.Timeout !== 30) {
          newFunctionConfig[func.FunctionName].timeout = func.Timeout;
        }
        if (func.MemorySize !== 256) {
          newFunctionConfig[func.FunctionName].memorySize = func.MemorySize;
        }
      }
    }

    // Show what will be changed
    output.subheader('Changes to apply:');
    output.newline();

    output.info('lambdaDefaults:');
    console.log(JSON.stringify(newDefaults, null, 2));
    output.newline();

    output.info(`functions: [${newFunctions.length} functions]`);
    console.log(JSON.stringify(newFunctions, null, 2));
    output.newline();

    if (Object.keys(newFunctionConfig).length > 0) {
      output.info(`functionConfig: [${Object.keys(newFunctionConfig).length} custom configs]`);
      console.log(JSON.stringify(newFunctionConfig, null, 2));
      output.newline();
    }

    // Show table of all functions
    output.subheader('Function Details:');
    const rows = data.Functions.map(f => [
      output.module(f.FunctionName),
      f.Runtime || 'N/A',
      f.Handler || 'N/A',
      `${f.Timeout}s`,
      `${f.MemorySize} MB`
    ]);

    output.table(rows, {
      head: ['Function', 'Runtime', 'Handler', 'Timeout', 'Memory']
    });
    output.newline();

    // Show only mode - don't apply
    if (options.showOnly) {
      output.info('--show-only mode: changes not applied');
      return;
    }

    // Dry run mode
    if (ctx.dryRun) {
      output.info('[dry-run] Would update jic.config.json');
      return;
    }

    // Confirm before applying
    if (!options.yes) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: 'Apply these changes to jic.config.json?',
        default: true
      }]);

      if (!confirm) {
        output.info('Aborted');
        return;
      }
    }

    // Apply changes to config
    const saveSpinner = createSpinner('Updating jic.config.json');
    saveSpinner.start();

    // Update the module in config
    module.lambdaDefaults = newDefaults;
    module.functions = newFunctions;
    module.functionConfig = Object.keys(newFunctionConfig).length > 0 ? newFunctionConfig : undefined;

    // Save config
    await saveConfig(ctx.config);

    saveSpinner.succeed('Updated jic.config.json');
    output.newline();
    output.success(`Synced ${newFunctions.length} Lambda function(s) from AWS`);

  } catch (error) {
    if (error instanceof AwsError) throw error;
    const awsError = new AwsError(error.message, 'Lambda');
    awsError.cause = error;
    throw awsError;
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
