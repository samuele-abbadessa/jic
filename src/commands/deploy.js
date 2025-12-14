/**
 * Deploy commands for AWS deployment operations
 *
 * Commands:
 *   jic deploy backend <service> - Deploy Java service to ECS
 *   jic deploy frontend - Deploy frontend to S3/CloudFront
 *   jic deploy lambda <function> - Deploy Lambda function
 *   jic deploy release <version> - Full release deployment
 */

import { withErrorHandling, DeployError } from '../utils/error.js';
import { exec, execWithSpinner, getGitCommit } from '../utils/shell.js';
import { output, createSpinner, formatDuration } from '../utils/output.js';
import { getModulesByType, getNextDeployVersion, updateDeployVersion, saveState } from '../lib/config.js';

/**
 * Register deploy commands
 */
export function registerDeployCommands(program, ctx) {
  const deploy = program
    .command('deploy')
    .description('Deployment operations');

  // Deploy backend service
  deploy
    .command('backend <service>')
    .description('Deploy a backend service to ECS')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('-v, --version <n>', 'Version number (auto-incremented if not specified)')
    .option('--no-build', 'Skip building before deploy')
    .option('--wait', 'Wait for deployment to complete')
    .action(withErrorHandling(async (service, options) => {
      await deployBackend(ctx, service, options);
    }));

  // Deploy all backend services
  deploy
    .command('backend-all')
    .description('Deploy all backend services to ECS')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('-v, --version <n>', 'Base version number')
    .option('--no-build', 'Skip building before deploy')
    .action(withErrorHandling(async (options) => {
      await deployBackendAll(ctx, options);
    }));

  // Deploy frontend
  deploy
    .command('frontend')
    .description('Deploy frontend to S3 and invalidate CloudFront')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--no-build', 'Skip building before deploy')
    .option('--no-invalidate', 'Skip CloudFront invalidation')
    .action(withErrorHandling(async (options) => {
      await deployFrontend(ctx, options);
    }));

  // Deploy Lambda function
  deploy
    .command('lambda <function>')
    .description('Deploy a Lambda function')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (func, options) => {
      await deployLambda(ctx, func, options);
    }));

  // Deploy all Lambda functions
  deploy
    .command('lambda-all')
    .description('Deploy all Lambda functions')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (options) => {
      await deployLambdaAll(ctx, options);
    }));

  // Deploy Lambda layer
  deploy
    .command('lambda-layer')
    .description('Deploy Lambda layer')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .action(withErrorHandling(async (options) => {
      await deployLambdaLayer(ctx, options);
    }));

  // Full release deployment
  deploy
    .command('release <version>')
    .description('Full release deployment')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--skip-backend', 'Skip backend deployment')
    .option('--skip-frontend', 'Skip frontend deployment')
    .option('--skip-lambda', 'Skip Lambda deployment')
    .action(withErrorHandling(async (version, options) => {
      await deployRelease(ctx, version, options);
    }));

  // Show deployment status
  deploy
    .command('status')
    .description('Show deployment status')
    .option('-e, --env <env>', 'Environment (dev/prod)')
    .action(withErrorHandling(async (options) => {
      await deployStatus(ctx, options);
    }));
}

/**
 * Deploy a backend service to ECS
 */
async function deployBackend(ctx, serviceName, options) {
  const module = ctx.getModule(serviceName);
  if (!module) {
    throw new DeployError(`Unknown service: ${serviceName}`);
  }

  if (module.type !== 'java-service') {
    throw new DeployError(`${serviceName} is not a Java service`);
  }

  const env = options.env || ctx.env;
  const deployConfig = module.deploy?.[env];
  const awsConfig = ctx.getAwsConfig(env);

  if (!deployConfig) {
    throw new DeployError(`No deployment configuration for ${serviceName} in ${env} environment`);
  }

  output.header(`Deploy: ${module.name} → ${env}`);

  // Determine version
  const version = options.version || getNextDeployVersion(ctx.config, module.name, env);
  output.keyValue('Version', version);
  output.keyValue('Cluster', deployConfig.cluster);
  output.keyValue('Service', deployConfig.service);
  output.keyValue('Registry', deployConfig.ecrRegistry);
  output.newline();

  const localImage = module.build?.dockerImage;
  const remoteImage = `${deployConfig.ecrRegistry}/${deployConfig.ecrRepo}`;
  const profile = deployConfig.profile ? `--profile ${deployConfig.profile}` : '';

  // Build if needed
  if (options.build !== false) {
    const buildSpinner = createSpinner('Building Docker image');
    buildSpinner.start();

    try {
      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build Docker image');
      } else {
        await exec(
          `mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true`,
          { cwd: module.absolutePath, silent: true }
        );
        buildSpinner.succeed('Docker image built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      throw new DeployError('Build failed', module.name);
    }
  }

  // Login to ECR
  const loginSpinner = createSpinner('Logging in to ECR');
  loginSpinner.start();

  try {
    if (ctx.dryRun) {
      loginSpinner.info('[dry-run] Would login to ECR');
    } else {
      await exec(
        `aws ecr get-login-password --region ${awsConfig.region} ${profile} | docker login --username AWS --password-stdin ${deployConfig.ecrRegistry}`,
        { silent: true }
      );
      loginSpinner.succeed('Logged in to ECR');
    }
  } catch (error) {
    loginSpinner.fail('ECR login failed');
    throw new DeployError('ECR login failed', module.name);
  }

  // Tag and push image
  const pushSpinner = createSpinner('Pushing image to ECR');
  pushSpinner.start();

  try {
    if (ctx.dryRun) {
      pushSpinner.info(`[dry-run] Would push ${remoteImage}:${version}`);
    } else {
      // Tag with version
      await exec(`docker tag ${localImage} ${remoteImage}:${version}`, { silent: true });
      // Tag as latest
      await exec(`docker tag ${localImage} ${remoteImage}:latest`, { silent: true });
      // Push version tag
      await exec(`docker push ${remoteImage}:${version}`, { silent: true });
      // Push latest tag
      await exec(`docker push ${remoteImage}:latest`, { silent: true });

      pushSpinner.succeed(`Pushed ${remoteImage}:${version}`);
    }
  } catch (error) {
    pushSpinner.fail('Push failed');
    throw new DeployError('Push to ECR failed', module.name);
  }

  // Update ECS service
  const deploySpinner = createSpinner('Updating ECS service');
  deploySpinner.start();

  try {
    if (ctx.dryRun) {
      deploySpinner.info(`[dry-run] Would update ${deployConfig.service}`);
    } else {
      await exec(
        `aws ecs update-service --no-cli-pager --region ${awsConfig.region} --cluster ${deployConfig.cluster} --service ${deployConfig.service} --force-new-deployment ${profile}`,
        { silent: true }
      );
      deploySpinner.succeed(`Updated ${deployConfig.service}`);
    }
  } catch (error) {
    deploySpinner.fail('ECS update failed');
    throw new DeployError('ECS update failed', module.name);
  }

  // Wait for deployment if requested
  if (options.wait && !ctx.dryRun) {
    const waitSpinner = createSpinner('Waiting for deployment to stabilize');
    waitSpinner.start();

    try {
      await exec(
        `aws ecs wait services-stable --region ${awsConfig.region} --cluster ${deployConfig.cluster} --services ${deployConfig.service} ${profile}`,
        { silent: true, timeout: 600000 } // 10 min timeout
      );
      waitSpinner.succeed('Deployment stabilized');
    } catch (error) {
      waitSpinner.fail('Deployment did not stabilize');
      throw new DeployError('Deployment did not stabilize', module.name);
    }
  }

  // Update state
  if (!ctx.dryRun) {
    const commit = await getGitCommit(module.absolutePath);
    updateDeployVersion(ctx.config, module.name, env, version, commit);
    await saveState(ctx.config);
  }

  output.newline();
  output.success(`Deployed ${module.name} v${version} to ${env}`);
}

/**
 * Deploy all backend services
 */
async function deployBackendAll(ctx, options) {
  const modules = getModulesByType(ctx.config, 'java-service');

  output.header('Deploy All Backend Services');

  for (const module of modules) {
    try {
      await deployBackend(ctx, module.name, {
        ...options,
        version: options.version ? parseInt(options.version) + modules.indexOf(module) : undefined
      });
    } catch (error) {
      if (ctx.failStrategy === 'fail-fast') throw error;
      output.error(`Failed to deploy ${module.name}: ${error.message}`);
    }
  }
}

/**
 * Deploy frontend to S3/CloudFront
 */
async function deployFrontend(ctx, options) {
  const modules = getModulesByType(ctx.config, 'frontend');

  if (modules.length === 0) {
    throw new DeployError('No frontend module configured');
  }

  const module = modules[0];
  const env = options.env || ctx.env;
  const deployConfig = module.deploy?.[env];

  if (!deployConfig) {
    throw new DeployError(`No deployment configuration for frontend in ${env} environment`);
  }

  output.header(`Deploy Frontend → ${env}`);
  output.keyValue('Bucket', deployConfig.bucket);
  output.keyValue('Distribution', deployConfig.distributionId);
  output.newline();

  const profile = deployConfig.profile ? `--profile ${deployConfig.profile}` : '';
  const outputDir = module.build?.outputDir || 'target/classes/static';

  // Build if needed
  if (options.build !== false) {
    const buildSpinner = createSpinner('Building frontend');
    buildSpinner.start();

    try {
      // Clean cache
      await exec('rm -rf node_modules/.cache .angular/cache target/angular target/classes/static', {
        cwd: module.absolutePath,
        silent: true
      });

      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build frontend');
      } else {
        await exec('npm run build', {
          cwd: module.absolutePath,
          silent: true,
          env: { NODE_OPTIONS: '--max_old_space_size=4096' }
        });
        buildSpinner.succeed('Frontend built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      throw new DeployError('Frontend build failed');
    }
  }

  // Sync to S3
  const syncSpinner = createSpinner('Syncing to S3');
  syncSpinner.start();

  try {
    if (ctx.dryRun) {
      syncSpinner.info(`[dry-run] Would sync to s3://${deployConfig.bucket}`);
    } else {
      await exec(
        `aws s3 sync ./${outputDir} s3://${deployConfig.bucket} --delete --cache-control "max-age=0, no-cache, no-store, must-revalidate" --metadata-directive REPLACE ${profile}`,
        { cwd: module.absolutePath, silent: true }
      );
      syncSpinner.succeed(`Synced to s3://${deployConfig.bucket}`);
    }
  } catch (error) {
    syncSpinner.fail('S3 sync failed');
    throw new DeployError('S3 sync failed');
  }

  // Invalidate CloudFront
  if (options.invalidate !== false) {
    const invalidateSpinner = createSpinner('Invalidating CloudFront cache');
    invalidateSpinner.start();

    try {
      if (ctx.dryRun) {
        invalidateSpinner.info(`[dry-run] Would invalidate ${deployConfig.distributionId}`);
      } else {
        const result = await exec(
          `aws cloudfront create-invalidation --distribution-id ${deployConfig.distributionId} --paths "/*" ${profile}`,
          { silent: true }
        );

        // Extract invalidation ID
        const invalidationData = JSON.parse(result.stdout);
        const invalidationId = invalidationData.Invalidation.Id;

        invalidateSpinner.text = `Waiting for invalidation ${invalidationId}`;

        await exec(
          `aws cloudfront wait invalidation-completed --distribution-id ${deployConfig.distributionId} --id "${invalidationId}" ${profile}`,
          { silent: true, timeout: 300000 } // 5 min timeout
        );

        invalidateSpinner.succeed(`Invalidation completed: ${invalidationId}`);
      }
    } catch (error) {
      invalidateSpinner.fail('CloudFront invalidation failed');
      throw new DeployError('CloudFront invalidation failed');
    }
  }

  output.newline();
  output.success(`Frontend deployed to ${env}`);
}

/**
 * Deploy a Lambda function
 */
async function deployLambda(ctx, functionName, options) {
  const module = ctx.getModule('aws-lambda-functions');
  if (!module) {
    throw new DeployError('Lambda functions module not found');
  }

  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';

  output.header(`Deploy Lambda: ${functionName} → ${env}`);

  const functionPath = `${module.absolutePath}/${functionName}`;

  // Create zip file
  const zipSpinner = createSpinner('Creating deployment package');
  zipSpinner.start();

  try {
    if (ctx.dryRun) {
      zipSpinner.info('[dry-run] Would create zip package');
    } else {
      // Install dependencies if package.json exists
      await exec(`cd ${functionPath} && [ -f package.json ] && npm install --production || true`, { silent: true });

      // Create zip
      await exec(`cd ${functionPath} && zip -r ../deploy-${functionName}.zip .`, { silent: true });
      zipSpinner.succeed('Deployment package created');
    }
  } catch (error) {
    zipSpinner.fail('Failed to create package');
    throw new DeployError(`Failed to create package for ${functionName}`);
  }

  // Deploy to Lambda
  const deploySpinner = createSpinner('Updating Lambda function');
  deploySpinner.start();

  try {
    if (ctx.dryRun) {
      deploySpinner.info(`[dry-run] Would update ${functionName}`);
    } else {
      await exec(
        `aws lambda update-function-code --function-name ${functionName} --zip-file fileb://${module.absolutePath}/deploy-${functionName}.zip --region ${awsConfig.region} ${profile}`,
        { silent: true }
      );

      // Clean up zip
      await exec(`rm -f ${module.absolutePath}/deploy-${functionName}.zip`, { silent: true });

      deploySpinner.succeed(`Updated ${functionName}`);
    }
  } catch (error) {
    deploySpinner.fail('Lambda update failed');
    throw new DeployError(`Lambda update failed for ${functionName}`);
  }

  output.newline();
  output.success(`Lambda ${functionName} deployed to ${env}`);
}

/**
 * Deploy all Lambda functions
 */
async function deployLambdaAll(ctx, options) {
  const module = ctx.getModule('aws-lambda-functions');
  if (!module) {
    throw new DeployError('Lambda functions module not found');
  }

  const functions = module.functions || [];

  output.header('Deploy All Lambda Functions');

  for (const func of functions) {
    try {
      await deployLambda(ctx, func, options);
    } catch (error) {
      if (ctx.failStrategy === 'fail-fast') throw error;
      output.error(`Failed to deploy ${func}: ${error.message}`);
    }
  }
}

/**
 * Deploy Lambda layer
 */
async function deployLambdaLayer(ctx, options) {
  const module = ctx.getModule('aws-lambda-layer');
  if (!module) {
    throw new DeployError('Lambda layer module not found');
  }

  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const deployConfig = module.deploy?.[env] || module.deploy;
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';

  output.header(`Deploy Lambda Layer → ${env}`);

  const layerName = deployConfig?.layerName || 'jic-shared-layer';

  // Install dependencies
  const installSpinner = createSpinner('Installing dependencies');
  installSpinner.start();

  try {
    if (ctx.dryRun) {
      installSpinner.info('[dry-run] Would install dependencies');
    } else {
      await exec('npm install --production', {
        cwd: `${module.absolutePath}/nodejs`,
        silent: true
      });
      installSpinner.succeed('Dependencies installed');
    }
  } catch (error) {
    installSpinner.fail('Failed to install dependencies');
    throw new DeployError('Failed to install dependencies for layer');
  }

  // Create zip
  const zipSpinner = createSpinner('Creating layer package');
  zipSpinner.start();

  try {
    if (ctx.dryRun) {
      zipSpinner.info('[dry-run] Would create layer zip');
    } else {
      await exec(`cd ${module.absolutePath} && zip -r layer.zip nodejs`, { silent: true });
      zipSpinner.succeed('Layer package created');
    }
  } catch (error) {
    zipSpinner.fail('Failed to create package');
    throw new DeployError('Failed to create layer package');
  }

  // Publish layer
  const publishSpinner = createSpinner('Publishing layer');
  publishSpinner.start();

  try {
    if (ctx.dryRun) {
      publishSpinner.info(`[dry-run] Would publish ${layerName}`);
    } else {
      const result = await exec(
        `aws lambda publish-layer-version --layer-name ${layerName} --zip-file fileb://${module.absolutePath}/layer.zip --compatible-runtimes nodejs18.x nodejs20.x --region ${awsConfig.region} ${profile}`,
        { silent: true }
      );

      // Clean up
      await exec(`rm -f ${module.absolutePath}/layer.zip`, { silent: true });

      const layerData = JSON.parse(result.stdout);
      publishSpinner.succeed(`Published ${layerName} version ${layerData.Version}`);
    }
  } catch (error) {
    publishSpinner.fail('Layer publish failed');
    throw new DeployError('Layer publish failed');
  }

  output.newline();
  output.success(`Lambda layer deployed to ${env}`);
}

/**
 * Full release deployment
 */
async function deployRelease(ctx, version, options) {
  output.header(`Release Deployment: v${version}`);

  const env = options.env || ctx.env;

  if (!options.skipBackend) {
    output.subheader('Deploying Backend Services');
    await deployBackendAll(ctx, { ...options, version });
  }

  if (!options.skipFrontend) {
    output.subheader('Deploying Frontend');
    await deployFrontend(ctx, options);
  }

  if (!options.skipLambda) {
    output.subheader('Deploying Lambda Functions');
    await deployLambdaLayer(ctx, options);
    await deployLambdaAll(ctx, options);
  }

  output.newline();
  output.success(`Release v${version} deployed to ${env}`);
}

/**
 * Show deployment status
 */
async function deployStatus(ctx, options) {
  const env = options.env;

  output.header('Deployment Status');

  const versions = ctx.config.state.deployVersions || {};

  if (env) {
    const envVersions = versions[env] || {};
    output.subheader(env.toUpperCase());

    if (Object.keys(envVersions).length === 0) {
      output.info('No deployments recorded');
      return;
    }

    const rows = Object.entries(envVersions).map(([name, info]) => [
      output.module(name),
      info.version,
      info.commit || 'N/A',
      info.deployedAt ? new Date(info.deployedAt).toLocaleString() : 'N/A'
    ]);

    output.table(rows, {
      head: ['Service', 'Version', 'Commit', 'Deployed At']
    });
  } else {
    // Show both environments
    for (const environment of ['dev', 'prod']) {
      const envVersions = versions[environment] || {};
      output.subheader(environment.toUpperCase());

      if (Object.keys(envVersions).length === 0) {
        output.info('No deployments recorded');
        continue;
      }

      const rows = Object.entries(envVersions).map(([name, info]) => [
        output.module(name),
        info.version,
        info.commit || 'N/A',
        info.deployedAt ? new Date(info.deployedAt).toLocaleString() : 'N/A'
      ]);

      output.table(rows, {
        head: ['Service', 'Version', 'Commit', 'Deployed At']
      });
    }
  }
}

export default { registerDeployCommands };
