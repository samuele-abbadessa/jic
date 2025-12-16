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
import { exec, execWithSpinner, getGitCommit, execInModule } from '../utils/shell.js';
import { output, createSpinner, formatDuration } from '../utils/output.js';
import { getModulesByType, getNextDeployVersion, updateDeployVersion, saveState, getModule } from '../lib/config.js';
import { lambdaFunctionExists } from './aws.js';

/**
 * Register deploy commands
 */
export function registerDeployCommands(program, ctx) {
  const deploy = program
    .command('deploy')
    .description('Deployment operations');

  // Deploy backend service(s)
  deploy
    .command('backend <service> [moreServices...]')
    .description('Deploy backend service(s) to ECS')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('-v, --version <n>', 'Version number (auto-incremented if not specified)')
    .option('--no-build', 'Skip building before deploy')
    .option('--with-deps', 'Rebuild dependencies (flux clients) before deploy')
    .option('--wait', 'Wait for deployment to complete')
    .action(withErrorHandling(async (service, moreServices, options) => {
      const services = [service, ...moreServices];

      // Build dependencies if requested
      if (options.withDeps) {
        await buildDependencies(ctx, services);
      }

      for (const svc of services) {
        await deployBackend(ctx, svc, options);
      }
    }));

  // Deploy all backend services
  deploy
    .command('backend-all')
    .description('Deploy all backend services to ECS')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('-v, --version <n>', 'Base version number')
    .option('--no-build', 'Skip building before deploy')
    .option('--with-deps', 'Rebuild dependencies (flux clients) before deploy')
    .action(withErrorHandling(async (options) => {
      // Build all flux clients if --with-deps
      if (options.withDeps) {
        await buildAllFluxClients(ctx);
      }

      await deployBackendAll(ctx, options);
    }));

  // Deploy frontend
  deploy
    .command('frontend')
    .description('Deploy frontend to S3 and invalidate CloudFront')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--no-build', 'Skip building before deploy')
    .option('--no-invalidate', 'Skip CloudFront invalidation')
    .option('--with-deps', 'Rebuild backend services before deploy (for API changes)')
    .action(withErrorHandling(async (options) => {
      if (options.withDeps) {
        // Frontend might depend on backend API changes - rebuild and deploy backend first
        output.subheader('Building backend dependencies');
        await buildAllFluxClients(ctx);
      }
      await deployFrontend(ctx, options);
    }));

  // Deploy Lambda function(s)
  deploy
    .command('lambda <function> [moreFunctions...]')
    .description('Deploy one or more Lambda functions')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--with-deps', 'Rebuild and deploy Lambda layer before functions (only once)')
    .option('--create', 'Create function if it does not exist')
    .action(withErrorHandling(async (func, moreFunctions, options) => {
      const functions = [func, ...moreFunctions];

      // Build layer only once for all functions
      if (options.withDeps) {
        output.subheader('Deploying Lambda layer dependency');
        await deployLambdaLayer(ctx, options);
        output.newline();
      }

      // Deploy all specified functions
      for (const f of functions) {
        await deployLambda(ctx, f, options);
      }
    }));

  // Deploy all Lambda functions
  deploy
    .command('lambda-all')
    .description('Deploy all Lambda functions')
    .option('-e, --env <env>', 'Environment (dev/prod)', 'dev')
    .option('--with-deps', 'Rebuild and deploy Lambda layer before functions (only once)')
    .action(withErrorHandling(async (options) => {
      // Build layer only once for all functions
      if (options.withDeps) {
        output.subheader('Deploying Lambda layer dependency');
        await deployLambdaLayer(ctx, options);
        output.newline();
      }
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

  // Check Docker daemon is running
  try {
    await exec('docker info', { silent: true, timeout: 5000 });
  } catch (error) {
    throw new DeployError('Docker daemon is not running. Please start Docker and try again.');
  }

  // Build if needed
  if (options.build !== false) {
    const buildSpinner = createSpinner('Building Docker image');
    buildSpinner.start();

    try {
      // Use dockerCommand from config if available, otherwise fallback
      const dockerBuildCmd = module.build?.dockerCommand ||
        'mvn clean install jib:dockerBuild -amd -Pdev --batch-mode -DskipTests=true -Dmaven.test.skip=true';

      if (ctx.dryRun) {
        buildSpinner.info('[dry-run] Would build Docker image');
      } else {
        await exec(dockerBuildCmd, { cwd: module.absolutePath, silent: true });
        buildSpinner.succeed('Docker image built');
      }
    } catch (error) {
      buildSpinner.fail('Build failed');
      const deployError = new DeployError('Build failed', module.name);
      deployError.cause = error;
      throw deployError;
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
    const deployError = new DeployError('ECR login failed', module.name);
    deployError.cause = error;
    throw deployError;
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
    const deployError = new DeployError('Push to ECR failed', module.name);
    deployError.cause = error;
    throw deployError;
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
    const deployError = new DeployError('ECS update failed', module.name);
    deployError.cause = error;
    throw deployError;
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
      const deployError = new DeployError('Deployment did not stabilize', module.name);
      deployError.cause = error;
      throw deployError;
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
      const deployError = new DeployError('Frontend build failed');
      deployError.cause = error;
      throw deployError;
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
    const deployError = new DeployError('S3 sync failed');
    deployError.cause = error;
    throw deployError;
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
      const deployError = new DeployError('CloudFront invalidation failed');
      deployError.cause = error;
      throw deployError;
    }
  }

  output.newline();
  output.success(`Frontend deployed to ${env}`);
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
 * Deploy a Lambda function with versioning
 */
async function deployLambda(ctx, functionName, options) {
  const module = ctx.getModule('aws-lambda-functions');
  if (!module) {
    throw new DeployError('Lambda functions module not found');
  }

  const env = options.env || ctx.env;
  const awsConfig = ctx.getAwsConfig(env);
  const profile = awsConfig.profile ? `--profile ${awsConfig.profile}` : '';
  const deployConfig = module.deploy?.[env];

  // Check if function exists
  const exists = await lambdaFunctionExists(functionName, awsConfig.region, awsConfig.profile);

  if (!exists) {
    if (options.create) {
      // Create the function first
      output.header(`Creating Lambda: ${functionName} → ${env}`);

      if (!deployConfig?.role) {
        throw new DeployError(`No IAM role configured for Lambda in ${env} environment. Add 'role' to deploy.${env} in jic.config.json`);
      }

      const funcConfig = getLambdaFunctionConfig(module, functionName);
      output.keyValue('Runtime', funcConfig.runtime);
      output.keyValue('Handler', funcConfig.handler);
      output.keyValue('Timeout', `${funcConfig.timeout}s`);
      output.keyValue('Memory', `${funcConfig.memorySize} MB`);
      output.newline();

      const createSpinnerInst = createSpinner('Creating Lambda function');
      createSpinnerInst.start();

      try {
        if (ctx.dryRun) {
          createSpinnerInst.info(`[dry-run] Would create ${functionName}`);
        } else {
          const functionPath = `${module.absolutePath}/${functionName}`;
          const zipFile = `${module.absolutePath}/create-${functionName}.zip`;

          // Check if function directory exists
          const dirExists = await exec(`test -d ${functionPath} && echo "yes" || echo "no"`, { silent: true });

          if (dirExists.stdout.trim() === 'yes') {
            await exec(`cd ${functionPath} && [ -f package.json ] && npm install --production || true`, { silent: true });
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
              --runtime ${funcConfig.runtime} \
              --handler ${funcConfig.handler} \
              --role ${deployConfig.role} \
              --timeout ${funcConfig.timeout} \
              --memory-size ${funcConfig.memorySize} \
              --zip-file fileb://${zipFile} \
              --region ${awsConfig.region} ${profile}`,
            { silent: true }
          );

          await exec(`rm -f ${zipFile}`, { silent: true });
          createSpinnerInst.succeed(`Created ${functionName}`);

          // Wait for function to be active
          await exec(
            `aws lambda wait function-active --function-name ${functionName} --region ${awsConfig.region} ${profile}`,
            { silent: true, timeout: 60000 }
          );
        }
      } catch (error) {
        createSpinnerInst.fail('Creation failed');
        const deployError = new DeployError(`Failed to create Lambda function: ${functionName}`);
        deployError.cause = error;
        throw deployError;
      }

      output.newline();
    } else {
      throw new DeployError(
        `Lambda function '${functionName}' does not exist in ${env}. ` +
        `Use --create flag to create it, or run: jic aws lambda create ${functionName} -e ${env}`
      );
    }
  }

  // Get next version (use function name as the module identifier for versioning)
  const versionKey = `lambda:${functionName}`;
  const version = options.version || getNextDeployVersion(ctx.config, versionKey, env);

  output.header(`Deploy Lambda: ${functionName} → ${env}`);
  output.keyValue('Version', version);
  output.newline();

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
    const deployError = new DeployError(`Failed to create package for ${functionName}`);
    deployError.cause = error;
    throw deployError;
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
    const deployError = new DeployError(`Lambda update failed for ${functionName}`);
    deployError.cause = error;
    throw deployError;
  }

  // Publish new version
  const publishSpinner = createSpinner('Publishing Lambda version');
  publishSpinner.start();

  let publishedVersion = null;
  try {
    if (ctx.dryRun) {
      publishSpinner.info(`[dry-run] Would publish version ${version}`);
    } else {
      // Wait for function to be ready after update
      await exec(
        `aws lambda wait function-updated --function-name ${functionName} --region ${awsConfig.region} ${profile}`,
        { silent: true, timeout: 60000 }
      );

      // Publish version with description
      const result = await exec(
        `aws lambda publish-version --function-name ${functionName} --description "v${version}" --region ${awsConfig.region} ${profile}`,
        { silent: true }
      );

      const versionInfo = JSON.parse(result.stdout);
      publishedVersion = versionInfo.Version;
      publishSpinner.succeed(`Published version ${publishedVersion}`);
    }
  } catch (error) {
    publishSpinner.fail('Failed to publish version');
    const deployError = new DeployError(`Failed to publish version for ${functionName}`);
    deployError.cause = error;
    throw deployError;
  }

  // Update state
  if (!ctx.dryRun) {
    const commit = await getGitCommit(module.absolutePath);
    updateDeployVersion(ctx.config, versionKey, env, version, commit);

    // Also store the AWS Lambda version number
    if (!ctx.config.state.lambdaVersions) {
      ctx.config.state.lambdaVersions = { dev: {}, prod: {} };
    }
    if (!ctx.config.state.lambdaVersions[env]) {
      ctx.config.state.lambdaVersions[env] = {};
    }
    ctx.config.state.lambdaVersions[env][functionName] = {
      version,
      awsVersion: publishedVersion,
      deployedAt: new Date().toISOString(),
      commit
    };

    await saveState(ctx.config);
  }

  output.newline();
  output.success(`Lambda ${functionName} v${version} deployed to ${env}`);
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
 * Deploy Lambda layer with versioning
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

  // Get next version
  const versionKey = 'lambda-layer';
  const version = options.version || getNextDeployVersion(ctx.config, versionKey, env);

  output.header(`Deploy Lambda Layer → ${env}`);
  output.keyValue('Version', version);
  output.newline();

  // layerName is at module.deploy level, not environment-specific
  const layerName = module.deploy?.layerName || deployConfig?.layerName || 'jic-shared-layer';

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
    const deployError = new DeployError('Failed to install dependencies for layer');
    deployError.cause = error;
    throw deployError;
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
    const deployError = new DeployError('Failed to create layer package');
    deployError.cause = error;
    throw deployError;
  }

  // Publish layer
  const publishSpinner = createSpinner('Publishing layer');
  publishSpinner.start();

  let awsLayerVersion = null;
  try {
    if (ctx.dryRun) {
      publishSpinner.info(`[dry-run] Would publish ${layerName}`);
    } else {
      const result = await exec(
        `aws lambda publish-layer-version --layer-name ${layerName} --zip-file fileb://${module.absolutePath}/layer.zip --compatible-runtimes nodejs18.x nodejs20.x --description "v${version}" --region ${awsConfig.region} ${profile}`,
        { silent: true }
      );

      // Clean up
      await exec(`rm -f ${module.absolutePath}/layer.zip`, { silent: true });

      const layerData = JSON.parse(result.stdout);
      awsLayerVersion = layerData.Version;
      publishSpinner.succeed(`Published ${layerName} version ${awsLayerVersion}`);
    }
  } catch (error) {
    publishSpinner.fail('Layer publish failed');
    const deployError = new DeployError('Layer publish failed');
    deployError.cause = error;
    throw deployError;
  }

  // Update state
  if (!ctx.dryRun) {
    const commit = await getGitCommit(module.absolutePath);
    updateDeployVersion(ctx.config, versionKey, env, version, commit);

    // Also store the AWS layer version number
    if (!ctx.config.state.lambdaVersions) {
      ctx.config.state.lambdaVersions = { dev: {}, prod: {} };
    }
    if (!ctx.config.state.lambdaVersions[env]) {
      ctx.config.state.lambdaVersions[env] = {};
    }
    ctx.config.state.lambdaVersions[env]['_layer'] = {
      version,
      awsVersion: awsLayerVersion,
      layerName,
      deployedAt: new Date().toISOString(),
      commit
    };

    await saveState(ctx.config);
  }

  output.newline();
  output.success(`Lambda layer v${version} deployed to ${env}`);
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

/**
 * Build dependencies for specified services
 * Collects and builds all flux client dependencies
 */
async function buildDependencies(ctx, serviceNames) {
  output.subheader('Building Dependencies');

  // Collect all unique dependencies from the services
  const allDeps = new Set();

  for (const serviceName of serviceNames) {
    const module = ctx.getModule(serviceName);
    if (module?.dependencies) {
      for (const dep of module.dependencies) {
        allDeps.add(dep);
      }
    }
  }

  if (allDeps.size === 0) {
    output.info('No dependencies to build');
    return;
  }

  // Build each dependency
  for (const depName of allDeps) {
    const depModule = ctx.getModule(depName);
    if (!depModule) {
      output.warning(`Dependency not found: ${depName}`);
      continue;
    }

    const spinner = createSpinner(`Building ${depModule.name}`);
    spinner.start();

    try {
      const buildCmd = depModule.build?.command || 'mvn clean install';

      if (ctx.dryRun) {
        spinner.info(`${depModule.name}: [dry-run] ${buildCmd}`);
        continue;
      }

      await execInModule(depModule, buildCmd, { silent: true });
      spinner.succeed(`${depModule.name}: built`);
    } catch (error) {
      spinner.fail(`${depModule.name}: build failed`);
      const deployError = new DeployError(`Failed to build dependency ${depModule.name}`);
      deployError.cause = error;
      throw deployError;
    }
  }

  output.newline();
}

/**
 * Build all flux clients
 */
async function buildAllFluxClients(ctx) {
  output.subheader('Building Flux Clients');

  const fluxModules = getModulesByType(ctx.config, 'flux-client');

  if (fluxModules.length === 0) {
    output.info('No flux clients to build');
    return;
  }

  for (const module of fluxModules) {
    const spinner = createSpinner(`Building ${module.name}`);
    spinner.start();

    try {
      const buildCmd = module.build?.command || 'mvn clean install';

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${buildCmd}`);
        continue;
      }

      await execInModule(module, buildCmd, { silent: true });
      spinner.succeed(`${module.name}: built`);
    } catch (error) {
      spinner.fail(`${module.name}: build failed`);
      const deployError = new DeployError(`Failed to build flux client ${module.name}`);
      deployError.cause = error;
      throw deployError;
    }
  }

  output.newline();
}

export default { registerDeployCommands };
