/**
 * Build commands for multi-module projects
 *
 * Commands:
 *   jic build all - Build all modules in dependency order
 *   jic build flux [clients...] - Build flux clients
 *   jic build java [services...] - Build Java services
 *   jic build docker [services...] - Build Docker images
 *   jic build node [services...] - Build Node.js services
 *   jic build frontend - Build Angular frontend
 *   jic build service <name> - Build service with dependencies
 */

import { withErrorHandling, BuildError } from '../utils/error.js';
import { exec, execInModule, execWithSpinner } from '../utils/shell.js';
import { output, createSpinner, formatDuration } from '../utils/output.js';
import { getModulesByType } from '../lib/config.js';

/**
 * Register build commands
 */
export function registerBuildCommands(program, ctx) {
  const build = program
    .command('build')
    .description('Build operations');

  // Build all
  build
    .command('all')
    .description('Build all modules in dependency order')
    .option('--skip-tests', 'Skip test execution')
    .option('--parallel', 'Build independent modules in parallel')
    .option('--skip-flux', 'Skip flux client builds')
    .option('--skip-java', 'Skip Java service builds')
    .option('--skip-node', 'Skip Node.js service builds')
    .option('--skip-frontend', 'Skip frontend build')
    .action(withErrorHandling(async (options) => {
      await buildAll(ctx, options);
    }));

  // Build flux clients
  build
    .command('flux')
    .description('Build flux clients')
    .argument('[clients...]', 'Specific clients to build')
    .option('--skip-tests', 'Skip test execution')
    .action(withErrorHandling(async (clients, options) => {
      await buildFlux(ctx, clients, options);
    }));

  // Build Java services
  build
    .command('java')
    .description('Build Java services with Maven')
    .argument('[services...]', 'Specific services to build')
    .option('--skip-tests', 'Skip test execution')
    .option('--docker', 'Also build Docker images')
    .option('--parallel', 'Build in parallel')
    .action(withErrorHandling(async (services, options) => {
      await buildJava(ctx, services, options);
    }));

  // Build Docker images
  build
    .command('docker')
    .description('Build Docker images')
    .argument('[services...]', 'Specific services to build')
    .action(withErrorHandling(async (services, options) => {
      await buildDocker(ctx, services, options);
    }));

  // Build Node.js services
  build
    .command('node')
    .description('Build Node.js services')
    .argument('[services...]', 'Specific services to build')
    .action(withErrorHandling(async (services, options) => {
      await buildNode(ctx, services, options);
    }));

  // Build frontend
  build
    .command('frontend')
    .description('Build Angular frontend')
    .option('--prod', 'Production build')
    .option('--no-clean', 'Skip cleaning cache before build')
    .action(withErrorHandling(async (options) => {
      await buildFrontend(ctx, options);
    }));

  // Build specific service(s) with dependencies
  build
    .command('service <name> [moreNames...]')
    .description('Build service(s) with their dependencies')
    .option('--skip-tests', 'Skip test execution')
    .option('--docker', 'Also build Docker image')
    .action(withErrorHandling(async (name, moreNames, options) => {
      const names = [name, ...moreNames];
      for (const n of names) {
        await buildService(ctx, n, options);
      }
    }));
}

/**
 * Build all modules in dependency order
 */
async function buildAll(ctx, options) {
  const startTime = Date.now();
  output.header('Building All Modules');

  const results = {
    flux: { success: 0, failed: 0 },
    java: { success: 0, failed: 0 },
    node: { success: 0, failed: 0 },
    frontend: { success: false, skipped: false }
  };

  // 1. Build flux clients first
  if (!options.skipFlux) {
    output.subheader('Phase 1: Flux Clients');
    const fluxModules = getModulesByType(ctx.config, 'flux-client');

    if (fluxModules.length > 0) {
      for (const module of fluxModules) {
        const success = await buildModule(ctx, module, options);
        if (success) results.flux.success++;
        else results.flux.failed++;
      }
    } else {
      output.info('No flux clients to build');
    }
  }

  // 2. Build Java services
  if (!options.skipJava) {
    output.subheader('Phase 2: Java Services');
    const javaModules = getModulesByType(ctx.config, 'java-service');

    if (javaModules.length > 0) {
      if (options.parallel) {
        const buildResults = await Promise.all(
          javaModules.map(m => buildModule(ctx, m, options))
        );
        results.java.success = buildResults.filter(r => r).length;
        results.java.failed = buildResults.filter(r => !r).length;
      } else {
        for (const module of javaModules) {
          const success = await buildModule(ctx, module, options);
          if (success) results.java.success++;
          else results.java.failed++;
        }
      }
    } else {
      output.info('No Java services to build');
    }
  }

  // 3. Build Node.js services
  if (!options.skipNode) {
    output.subheader('Phase 3: Node.js Services');
    const nodeModules = getModulesByType(ctx.config, 'node-service');

    if (nodeModules.length > 0) {
      for (const module of nodeModules) {
        const success = await buildModule(ctx, module, options);
        if (success) results.node.success++;
        else results.node.failed++;
      }
    } else {
      output.info('No Node.js services to build');
    }
  }

  // 4. Build frontend
  if (!options.skipFrontend) {
    output.subheader('Phase 4: Frontend');
    const frontendModules = getModulesByType(ctx.config, 'frontend');

    if (frontendModules.length > 0) {
      results.frontend.success = await buildModule(ctx, frontendModules[0], options);
    } else {
      output.info('No frontend to build');
      results.frontend.skipped = true;
    }
  }

  // Summary
  const duration = Date.now() - startTime;
  output.newline();
  output.header('Build Summary');

  const totalSuccess = results.flux.success + results.java.success + results.node.success + (results.frontend.success ? 1 : 0);
  const totalFailed = results.flux.failed + results.java.failed + results.node.failed + (results.frontend.success === false && !results.frontend.skipped ? 1 : 0);

  output.table([
    ['Flux Clients', results.flux.success, results.flux.failed],
    ['Java Services', results.java.success, results.java.failed],
    ['Node Services', results.node.success, results.node.failed],
    ['Frontend', results.frontend.success ? 1 : 0, results.frontend.success === false && !results.frontend.skipped ? 1 : 0],
    ['─────────────', '───────', '──────'],
    ['Total', totalSuccess, totalFailed]
  ], {
    head: ['Type', 'Success', 'Failed']
  });

  output.newline();
  output.info(`Total time: ${formatDuration(duration)}`);

  if (totalFailed > 0) {
    throw new BuildError(`${totalFailed} module(s) failed to build`);
  }
}

/**
 * Build a single module
 */
async function buildModule(ctx, module, options) {
  const spinner = createSpinner(`Building ${module.name}`);
  spinner.start();

  try {
    const buildConfig = module.build || {};
    let command = buildConfig.command;

    if (!command) {
      spinner.warn(`${module.name}: No build command configured`);
      return true;
    }

    // Add skip tests flag for Maven
    if (options.skipTests && command.includes('mvn')) {
      if (!command.includes('-DskipTests')) {
        command += ' -DskipTests=true -Dmaven.test.skip=true';
      }
    }

    // Show command in verbose mode
    if (ctx.verbose) {
      output.info(`${module.name}: ${command}`);
    }

    // Run pre-build command if configured
    if (buildConfig.preBuild) {
      if (ctx.verbose) {
        output.info(`${module.name} pre-build: ${buildConfig.preBuild}`);
      }
      await execInModule(module, buildConfig.preBuild, {
        silent: !ctx.verbose,
        verbose: ctx.verbose,
        dryRun: ctx.dryRun,
        env: buildConfig.env
      });
    }

    if (ctx.dryRun) {
      spinner.info(`${module.name}: [dry-run] ${command}`);
      return true;
    }

    const startTime = Date.now();
    await execInModule(module, command, {
      silent: !ctx.verbose,
      verbose: ctx.verbose,
      env: buildConfig.env
    });
    const duration = Date.now() - startTime;

    spinner.succeed(`${module.name} ${output.colors.muted(`(${formatDuration(duration)})`)}`);
    return true;
  } catch (error) {
    spinner.fail(`${module.name}: Build failed`);

    // Always show error details
    if (error.stderr) {
      output.error(`\n${error.stderr}`);
    } else if (error.message) {
      output.error(`\n${error.message}`);
    }

    // Show additional info in verbose mode
    if (ctx.verbose) {
      if (error.stdout) {
        output.info('\nBuild output:');
        console.log(error.stdout);
      }
      if (error.command) {
        output.info(`\nFailed command: ${error.command}`);
      }
    }

    if (ctx.failStrategy === 'fail-fast') {
      const buildError = new BuildError(`Build failed for ${module.name}`, module.name);
      buildError.cause = error;
      throw buildError;
    }

    return false;
  }
}

/**
 * Build flux clients
 */
async function buildFlux(ctx, clientRefs, options) {
  output.header('Building Flux Clients');

  let modules;
  if (clientRefs && clientRefs.length > 0) {
    modules = ctx.resolveModules(clientRefs);
  } else {
    modules = getModulesByType(ctx.config, 'flux-client');
  }

  if (modules.length === 0) {
    output.info('No flux clients to build');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const module of modules) {
    const result = await buildModule(ctx, module, options);
    if (result) success++;
    else failed++;
  }

  output.newline();
  output.info(`Built ${success} flux client(s)${failed > 0 ? `, ${failed} failed` : ''}`);
}

/**
 * Build Java services
 */
async function buildJava(ctx, serviceRefs, options) {
  output.header('Building Java Services');

  let modules;
  if (serviceRefs && serviceRefs.length > 0) {
    modules = ctx.resolveModules(serviceRefs);
  } else {
    modules = getModulesByType(ctx.config, 'java-service');
  }

  if (modules.length === 0) {
    output.info('No Java services to build');
    return;
  }

  let success = 0;
  let failed = 0;

  const buildFn = async (module) => {
    // Use dockerCommand if --docker is requested and it's available
    const moduleForBuild = options.docker && module.build?.dockerCommand ? {
      ...module,
      build: {
        ...module.build,
        command: module.build.dockerCommand
      }
    } : module;

    return buildModule(ctx, moduleForBuild, options);
  };

  if (options.parallel) {
    const results = await Promise.all(modules.map(buildFn));
    success = results.filter(r => r).length;
    failed = results.filter(r => !r).length;
  } else {
    for (const module of modules) {
      const result = await buildFn(module);
      if (result) success++;
      else failed++;
    }
  }

  output.newline();
  output.info(`Built ${success} Java service(s)${failed > 0 ? `, ${failed} failed` : ''}`);
}

/**
 * Build Docker images
 */
async function buildDocker(ctx, serviceRefs, options) {
  output.header('Building Docker Images');

  // Check Docker daemon is running
  try {
    await exec('docker info', { silent: true, timeout: 5000 });
  } catch (error) {
    throw new BuildError('Docker daemon is not running. Please start Docker and try again.');
  }

  let modules;
  if (serviceRefs && serviceRefs.length > 0) {
    modules = ctx.resolveModules(serviceRefs);
  } else {
    modules = getModulesByType(ctx.config, 'java-service');
  }

  for (const module of modules) {
    const spinner = createSpinner(`Building Docker image for ${module.name}`);
    spinner.start();

    try {
      const dockerImage = module.build?.dockerImage;
      if (!dockerImage) {
        spinner.warn(`${module.name}: No Docker image configured`);
        continue;
      }

      // Use dockerCommand from config if available, otherwise fallback
      const command = module.build?.dockerCommand || 'mvn jib:dockerBuild -DskipTests=true -Dmaven.test.skip=true';

      if (ctx.dryRun) {
        spinner.info(`${module.name}: [dry-run] ${command}`);
        continue;
      }

      await execInModule(module, command, { silent: true });
      spinner.succeed(`${module.name}: ${dockerImage}`);
    } catch (error) {
      spinner.fail(`${module.name}: Docker build failed`);
      if (ctx.failStrategy === 'fail-fast') {
        throw new BuildError(`Docker build failed for ${module.name}`, module.name);
      }
    }
  }
}

/**
 * Build Node.js services
 */
async function buildNode(ctx, serviceRefs, options) {
  output.header('Building Node.js Services');

  let modules;
  if (serviceRefs && serviceRefs.length > 0) {
    modules = ctx.resolveModules(serviceRefs);
  } else {
    modules = getModulesByType(ctx.config, 'node-service');
  }

  if (modules.length === 0) {
    output.info('No Node.js services to build');
    return;
  }

  for (const module of modules) {
    await buildModule(ctx, module, options);
  }
}

/**
 * Build Angular frontend
 * Always cleans cache before building (like original deploy scripts)
 */
async function buildFrontend(ctx, options) {
  output.header('Building Frontend');

  const modules = getModulesByType(ctx.config, 'frontend');

  if (modules.length === 0) {
    output.info('No frontend to build');
    return;
  }

  const module = modules[0];

  // Always clean cache before building (unless --no-clean is passed)
  if (options.clean !== false) {
    const spinner = createSpinner('Cleaning build cache');
    spinner.start();

    try {
      await execInModule(module, 'rm -rf node_modules/.cache .angular/cache target/angular target/classes/static', { silent: true });
      spinner.succeed('Build cache cleaned');
    } catch {
      spinner.warn('Could not clean cache');
    }
  }

  await buildModule(ctx, module, options);
}

/**
 * Build a service with its dependencies
 */
async function buildService(ctx, name, options) {
  const module = ctx.getModule(name);
  if (!module) {
    throw new BuildError(`Unknown module: ${name}`);
  }

  output.header(`Building ${module.name} with dependencies`);

  // Build dependencies first
  const dependencies = module.dependencies || [];
  if (dependencies.length > 0) {
    output.subheader('Building Dependencies');

    for (const depName of dependencies) {
      const depModule = ctx.getModule(depName);
      if (depModule) {
        await buildModule(ctx, depModule, options);
      }
    }
  }

  // Build the main module
  output.subheader('Building Target');
  await buildModule(ctx, module, options);

  // Build Docker if requested
  if (options.docker && module.build?.dockerImage) {
    output.subheader('Building Docker Image');
    const spinner = createSpinner(`Building Docker image`);
    spinner.start();

    try {
      // Use dockerCommand from config if available, otherwise fallback
      const dockerCommand = module.build?.dockerCommand || 'mvn jib:dockerBuild -DskipTests=true';
      await execInModule(module, dockerCommand, { silent: true });
      spinner.succeed(`Docker image: ${module.build.dockerImage}`);
    } catch (error) {
      spinner.fail('Docker build failed');
      throw new BuildError('Docker build failed', module.name);
    }
  }
}

export default { registerBuildCommands };
