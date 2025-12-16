/**
 * Serve commands for running development services
 *
 * Commands:
 *   jic serve [services...] - Start services (native mode default)
 *   jic serve --docker - Start services via docker-compose
 *   jic serve --status - Show running services status
 *   jic serve --stop [services...] - Stop running services
 *   jic serve --logs [service] - Tail logs from services
 *   jic serve --restart [services...] - Restart services
 *   jic serve infra start/stop/status - Infrastructure management
 */

import { withErrorHandling, ServeError } from '../utils/error.js';
import { exec, execInModule } from '../utils/shell.js';
import { output, createSpinner, formatDuration } from '../utils/output.js';
import { saveState } from '../lib/config.js';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, writeSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import chalk from 'chalk';

// Service colors for log multiplexing
const SERVICE_COLORS = {
  'gws': chalk.cyan,
  'gateway': chalk.cyan,
  'ms': chalk.blue,
  'mainservice': chalk.blue,
  'tms': chalk.green,
  'tenant-main': chalk.green,
  'tas': chalk.yellow,
  'agenda': chalk.yellow,
  'tns': chalk.magenta,
  'notifications': chalk.magenta,
  'gwc': chalk.white,
  'frontend': chalk.white,
  'wa': chalk.red,
  'whatsapp': chalk.red
};

/**
 * Get color for a service based on its alias
 */
function getServiceColor(module) {
  const alias = module.aliases?.[0] || module.name;
  return SERVICE_COLORS[alias] || chalk.gray;
}

/**
 * Check if a module is servable
 */
function isServable(module) {
  const nonServableTypes = ['flux-client', 'lambda-layer', 'lambda-functions'];
  if (nonServableTypes.includes(module.type)) {
    return false;
  }
  return module.serve?.command || module.port;
}

/**
 * Get servable modules
 */
function getServableModules(config) {
  return Object.values(config.modules).filter(isServable);
}

/**
 * Get serve command for a module
 */
function getServeCommand(module) {
  if (module.serve?.command) {
    return module.serve.command;
  }

  // Fallback based on type
  switch (module.type) {
    case 'java-service':
      return 'mvn spring-boot:run -Dspring-boot.run.profiles=dev';
    case 'frontend':
      return 'npm start';
    case 'node-service':
      return 'npm run dev';
    default:
      return null;
  }
}

/**
 * Check if a process is running
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ensure logs directory exists
 */
function ensureLogsDir(ctx) {
  const logsDir = join(ctx.projectRoot, ctx.config.serve?.logsDir || '.jic/logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

/**
 * Initialize serve state if needed
 */
function initServeState(ctx) {
  if (!ctx.config.state.serve) {
    ctx.config.state.serve = {
      running: {},
      infrastructure: {
        running: false
      }
    };
  }
  return ctx.config.state.serve;
}

/**
 * Clean up stale processes from state
 */
async function cleanupStaleProcesses(ctx) {
  const serveState = initServeState(ctx);
  const running = serveState.running || {};
  let cleaned = false;

  for (const [name, info] of Object.entries(running)) {
    if (!isProcessRunning(info.pid)) {
      delete running[name];
      cleaned = true;
    }
  }

  if (cleaned) {
    await saveState(ctx.config);
  }

  return running;
}

// ==================== Infrastructure Management ====================

/**
 * Check infrastructure health
 */
async function checkInfrastructureHealth(ctx) {
  const infraConfig = ctx.config.serve?.infrastructure || {};
  const results = {};

  for (const [name, config] of Object.entries(infraConfig)) {
    try {
      await exec(config.healthCheck, { silent: true, timeout: 5000 });
      results[name] = { healthy: true, port: config.port, container: config.container };
    } catch {
      results[name] = { healthy: false, port: config.port, container: config.container };
    }
  }

  return results;
}

/**
 * Check if required infrastructure is running
 */
async function isInfrastructureRunning(ctx) {
  const health = await checkInfrastructureHealth(ctx);
  const requiredServices = ['mongodb', 'eureka'];

  return requiredServices.every(name => health[name]?.healthy);
}

/**
 * Start infrastructure
 */
async function startInfrastructure(ctx, options = {}) {
  const composeFile = ctx.config.serve?.infraComposeFile || 'docker-compose-infra.yml';
  const composePath = join(ctx.projectRoot, composeFile);

  if (!existsSync(composePath)) {
    throw new ServeError(`Infrastructure compose file not found: ${composeFile}`);
  }

  output.header('Starting Infrastructure');

  // Determine which services to start
  // Note: --no-localstack sets options.localstack to false (Commander.js convention)
  // When called from serveMain, options.noLocalstack is passed directly
  const services = ['mongodb', 'mongo-init', 'eureka-registry', 'registry'];
  const skipLocalstack = options.localstack === false || options.noLocalstack === true;
  if (!skipLocalstack) {
    services.push('localstack');
  }

  const spinner = createSpinner('Starting containers');
  spinner.start();

  try {
    await exec(`docker compose -f ${composePath} up -d ${services.join(' ')}`, {
      cwd: ctx.projectRoot,
      silent: true
    });
    spinner.succeed('Containers started');
  } catch (error) {
    spinner.fail('Failed to start containers');
    throw new ServeError(`Failed to start infrastructure: ${error.message}`);
  }

  // Wait for health checks
  const healthSpinner = createSpinner('Waiting for services to be healthy');
  healthSpinner.start();

  const maxWait = 90000; // 90 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (await isInfrastructureRunning(ctx)) {
      healthSpinner.succeed('Infrastructure ready');

      // Update state
      const serveState = initServeState(ctx);
      serveState.infrastructure = {
        running: true,
        startedAt: new Date().toISOString(),
        composeFile
      };
      await saveState(ctx.config);

      // Show status
      const health = await checkInfrastructureHealth(ctx);
      output.newline();
      for (const [name, info] of Object.entries(health)) {
        const status = info.healthy ? output.colors.success('running') : output.colors.error('stopped');
        output.keyValue(`  ${name}`, `${status} (port ${info.port})`);
      }

      return;
    }
    await sleep(2000);
  }

  healthSpinner.fail('Infrastructure health check timeout');
  throw new ServeError('Infrastructure did not become healthy within timeout');
}

/**
 * Stop infrastructure
 */
async function stopInfrastructure(ctx) {
  const composeFile = ctx.config.serve?.infraComposeFile || 'docker-compose-infra.yml';
  const composePath = join(ctx.projectRoot, composeFile);

  output.header('Stopping Infrastructure');

  const spinner = createSpinner('Stopping containers');
  spinner.start();

  try {
    await exec(`docker compose -f ${composePath} down`, {
      cwd: ctx.projectRoot,
      silent: true
    });

    // Update state
    const serveState = initServeState(ctx);
    serveState.infrastructure = {
      running: false
    };
    await saveState(ctx.config);

    spinner.succeed('Infrastructure stopped');
  } catch (error) {
    spinner.fail('Failed to stop infrastructure');
    throw new ServeError(`Failed to stop infrastructure: ${error.message}`);
  }
}

/**
 * Show infrastructure status
 */
async function infraStatus(ctx) {
  output.header('Infrastructure Status');

  const health = await checkInfrastructureHealth(ctx);
  const allHealthy = Object.values(health).every(h => h.healthy);

  output.newline();
  for (const [name, info] of Object.entries(health)) {
    const status = info.healthy
      ? output.colors.success('running')
      : output.colors.error('stopped');
    output.keyValue(`  ${name}`, `${status} (port ${info.port})`);
  }

  output.newline();
  if (allHealthy) {
    output.success('All infrastructure services are running');
  } else {
    output.warning('Some infrastructure services are not running');
    output.info('Start them with: jic serve infra start');
  }
}

// ==================== Native Mode ====================

/**
 * Spawn a service process
 */
async function spawnService(ctx, module, options) {
  const command = getServeCommand(module);
  if (!command) {
    throw new ServeError(`No serve command defined for ${module.name}`, module.name);
  }

  const env = { ...process.env, ...module.serve?.env };
  const logsDir = ensureLogsDir(ctx);
  const logFile = join(logsDir, `${module.name}.log`);

  if (options.detach) {
    // Background mode - write to log file using file descriptor
    const logFd = openSync(logFile, 'a');

    // Add timestamp header
    writeSync(logFd, `\n\n=== Started at ${new Date().toISOString()} ===\n`);
    writeSync(logFd, `Command: ${command}\n`);
    writeSync(logFd, `Directory: ${module.absolutePath}\n\n`);

    const child = spawn(command, [], {
      cwd: module.absolutePath,
      env,
      shell: true,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    });

    child.unref();
    // Don't close fd - child process inherits it

    return {
      pid: child.pid,
      logFile,
      startedAt: new Date().toISOString()
    };
  } else {
    // Foreground mode - pipe to process
    const child = spawn(command, [], {
      cwd: module.absolutePath,
      env,
      shell: true,
      stdio: ['inherit', 'pipe', 'pipe']
    });

    return {
      pid: child.pid,
      process: child,
      logFile
    };
  }
}

/**
 * Stop a service
 */
async function stopService(ctx, serviceName, options = {}) {
  const serveState = initServeState(ctx);
  const running = serveState.running || {};
  const serviceInfo = running[serviceName];

  if (!serviceInfo) {
    if (!options.quiet) {
      output.warning(`Service ${serviceName} is not running`);
    }
    return false;
  }

  const spinner = options.quiet ? null : createSpinner(`Stopping ${serviceName}`);
  spinner?.start();

  try {
    // Send SIGTERM first
    process.kill(serviceInfo.pid, 'SIGTERM');

    // Wait for graceful shutdown
    const timeout = options.timeout || 10000;
    const startTime = Date.now();

    while (isProcessRunning(serviceInfo.pid) && Date.now() - startTime < timeout) {
      await sleep(500);
    }

    // Force kill if still running
    if (isProcessRunning(serviceInfo.pid)) {
      process.kill(serviceInfo.pid, 'SIGKILL');
    }

    // Remove from state
    delete running[serviceName];
    await saveState(ctx.config);

    spinner?.succeed(`Stopped ${serviceName}`);
    return true;
  } catch (error) {
    // Process might already be dead
    delete running[serviceName];
    await saveState(ctx.config);
    spinner?.succeed(`Stopped ${serviceName}`);
    return true;
  }
}

/**
 * Wait for service to be healthy
 */
async function waitForHealthy(module, timeout = 120000) {
  const healthCheck = module.serve?.healthCheck;
  if (!healthCheck) return true;

  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      await exec(healthCheck, { silent: true, timeout: 5000 });
      return true;
    } catch {
      await sleep(2000);
    }
  }
  return false;
}

/**
 * Serve in native mode (foreground)
 */
async function serveNativeForeground(ctx, modules, options = {}) {
  const processes = new Map();
  let shuttingDown = false;
  const startupDelay = (parseInt(options.startupDelay) || 1) * 1000;
  const sequential = options.sequential || false;

  // Handle Ctrl+C gracefully
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    output.newline();
    output.info('Stopping all services...');

    for (const [name, info] of processes) {
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch { /* ignore */ }
    }

    // Wait a bit for graceful shutdown
    await sleep(2000);

    // Force kill remaining
    for (const [name, info] of processes) {
      if (isProcessRunning(info.pid)) {
        try {
          process.kill(info.pid, 'SIGKILL');
        } catch { /* ignore */ }
      }
    }

    output.success('All services stopped');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  output.header('Starting Services (Native Mode - Foreground)');
  output.info('Press Ctrl+C to stop all services');
  if (sequential) {
    output.info('Sequential mode: waiting for each service to be healthy before starting next');
  }
  output.newline();

  // Start services
  for (const module of modules) {
    const spinner = createSpinner(`Starting ${module.name} (port ${module.port})`);
    spinner.start();

    try {
      const info = await spawnService(ctx, module, { detach: false });
      processes.set(module.name, { ...info, module });
      spinner.succeed(`Started ${module.name} (PID: ${info.pid}, port ${module.port})`);

      // Set up log multiplexing
      const color = getServiceColor(module);
      const prefix = color(`[${(module.aliases?.[0] || module.name).padEnd(8)}]`);

      if (info.process.stdout) {
        const rl = createInterface({ input: info.process.stdout });
        rl.on('line', (line) => {
          console.log(`${prefix} ${line}`);
        });
      }

      if (info.process.stderr) {
        const rl = createInterface({ input: info.process.stderr });
        rl.on('line', (line) => {
          console.log(`${prefix} ${chalk.red(line)}`);
        });
      }

      // Handle process exit
      info.process.on('exit', (code) => {
        if (!shuttingDown) {
          output.warning(`${module.name} exited with code ${code}`);
          processes.delete(module.name);
        }
      });

      // In sequential mode, wait for service to be healthy before starting next
      if (sequential && modules.indexOf(module) < modules.length - 1) {
        const healthSpinner = createSpinner(`Waiting for ${module.name} to be healthy...`);
        healthSpinner.start();
        const healthy = await waitForHealthy(module, module.serve?.startupTimeout || 120000);
        if (healthy) {
          healthSpinner.succeed(`${module.name} is healthy`);
        } else {
          healthSpinner.warn(`${module.name} health check timeout, continuing anyway`);
        }
      } else {
        // Delay between service starts
        await sleep(startupDelay);
      }
    } catch (error) {
      spinner.fail(`Failed to start ${module.name}: ${error.message}`);
      // Continue with other services
    }
  }

  output.newline();
  output.success(`${processes.size} service(s) running`);
  output.info('Logs are multiplexed below. Press Ctrl+C to stop.');
  output.newline();

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Serve in native mode (background/detached)
 */
async function serveNativeBackground(ctx, modules) {
  output.header('Starting Services (Native Mode - Background)');

  const serveState = initServeState(ctx);
  let started = 0;
  let failed = 0;

  for (const module of modules) {
    const spinner = createSpinner(`Starting ${module.name}`);
    spinner.start();

    // Check if already running
    if (serveState.running[module.name]) {
      const existing = serveState.running[module.name];
      if (isProcessRunning(existing.pid)) {
        spinner.warn(`${module.name} is already running (PID: ${existing.pid})`);
        continue;
      }
    }

    try {
      const info = await spawnService(ctx, module, { detach: true });

      // Store in state
      serveState.running[module.name] = {
        pid: info.pid,
        port: module.port,
        mode: 'native',
        startedAt: info.startedAt,
        logFile: info.logFile
      };

      await saveState(ctx.config);

      spinner.succeed(`Started ${module.name} (PID: ${info.pid}, port ${module.port})`);
      started++;

      // Small delay between service starts
      await sleep(500);
    } catch (error) {
      spinner.fail(`Failed to start ${module.name}: ${error.message}`);
      failed++;
    }
  }

  output.newline();
  if (started > 0) {
    output.success(`Started ${started} service(s)`);
    output.info('View logs with: jic serve logs');
    output.info('Check status with: jic serve status');
    output.info('Stop services with: jic serve stop');
  }
  if (failed > 0) {
    output.warning(`Failed to start ${failed} service(s)`);
  }
}

// ==================== Docker Mode ====================

/**
 * Serve using docker-compose
 */
async function serveDocker(ctx, modules, options) {
  const composeFile = ctx.config.docker?.composeFile || 'docker-compose.yml';
  const serviceMapping = ctx.config.serve?.dockerServiceNames || {};

  output.header('Starting Services (Docker Mode)');

  // Map module names to docker-compose service names
  const dockerServices = modules
    .map(m => serviceMapping[m.name])
    .filter(Boolean);

  const serviceArg = dockerServices.length > 0 ? dockerServices.join(' ') : '';

  const spinner = createSpinner('Starting Docker services');
  spinner.start();

  try {
    if (options.detach) {
      await exec(`docker compose -f ${composeFile} up -d ${serviceArg}`, {
        cwd: ctx.projectRoot,
        silent: true
      });
      spinner.succeed('Docker services started in background');

      output.newline();
      output.info('View logs with: docker compose logs -f');
      output.info('Stop services with: docker compose down');
    } else {
      spinner.stop();
      output.info('Running docker compose up (press Ctrl+C to stop)');
      output.newline();

      // Run in foreground with logs
      const child = spawn('docker', ['compose', '-f', composeFile, 'up', ...dockerServices.split(' ').filter(Boolean)], {
        cwd: ctx.projectRoot,
        stdio: 'inherit'
      });

      await new Promise((resolve, reject) => {
        child.on('close', resolve);
        child.on('error', reject);
      });
    }
  } catch (error) {
    spinner?.fail('Failed to start Docker services');
    throw new ServeError(`Docker compose up failed: ${error.message}`);
  }
}

// ==================== Status, Stop, Logs Commands ====================

/**
 * Show status of running services
 */
async function serveStatus(ctx) {
  output.header('Service Status');

  // Clean up stale processes first
  const running = await cleanupStaleProcesses(ctx);

  const services = Object.entries(running);

  if (services.length === 0) {
    output.info('No services are currently running');
    output.newline();
    output.info('Start services with: jic serve [services...]');
    return;
  }

  output.newline();

  const tableData = services.map(([name, info]) => {
    const uptime = info.startedAt
      ? formatDuration(Date.now() - new Date(info.startedAt).getTime())
      : 'unknown';

    return {
      Service: name,
      PID: info.pid,
      Port: info.port || '-',
      Mode: info.mode || 'native',
      Uptime: uptime,
      Status: isProcessRunning(info.pid) ? output.colors.success('running') : output.colors.error('stopped')
    };
  });

  output.table(tableData);

  output.newline();
  output.info('View logs with: jic serve logs [service]');
  output.info('Stop services with: jic serve stop [services...]');
}

/**
 * Stop running services
 */
async function serveStop(ctx, serviceRefs) {
  output.header('Stopping Services');

  const serveState = initServeState(ctx);
  const running = serveState.running || {};

  // Determine which services to stop
  let toStop;
  if (serviceRefs && serviceRefs.length > 0) {
    // Resolve module references
    const modules = ctx.resolveModules(serviceRefs);
    toStop = modules.map(m => m.name).filter(name => running[name]);
  } else {
    // Stop all
    toStop = Object.keys(running);
  }

  if (toStop.length === 0) {
    output.info('No running services to stop');
    return;
  }

  let stopped = 0;
  for (const serviceName of toStop) {
    if (await stopService(ctx, serviceName)) {
      stopped++;
    }
  }

  output.newline();
  output.success(`Stopped ${stopped} service(s)`);
}

/**
 * Tail service logs
 */
async function serveLogs(ctx, serviceRef, options) {
  const serveState = initServeState(ctx);
  const running = serveState.running || {};

  if (Object.keys(running).length === 0) {
    output.info('No services are currently running');
    return;
  }

  if (serviceRef) {
    // Single service logs
    const module = ctx.getModule(serviceRef);
    if (!module) {
      throw new ServeError(`Unknown service: ${serviceRef}`);
    }

    const info = running[module.name];
    if (!info) {
      throw new ServeError(`Service ${module.name} is not running`);
    }

    if (!info.logFile || !existsSync(info.logFile)) {
      throw new ServeError(`Log file not found for ${module.name}`);
    }

    output.header(`Logs: ${module.name}`);
    output.info(`Log file: ${info.logFile}`);
    output.newline();

    // Tail the log file
    const tailProcess = spawn('tail', ['-f', '-n', options.lines || '100', info.logFile], {
      stdio: 'inherit'
    });

    await new Promise((resolve) => {
      tailProcess.on('close', resolve);
      process.on('SIGINT', () => {
        tailProcess.kill();
        resolve();
      });
    });
  } else {
    // All services - show instructions
    output.header('Service Logs');
    output.newline();
    output.info('Available service logs:');

    for (const [name, info] of Object.entries(running)) {
      if (info.logFile) {
        output.item(`${name}: ${info.logFile}`);
      }
    }

    output.newline();
    output.info('View specific service: jic serve logs <service>');
    output.info('Or use: tail -f .jic/logs/<service>.log');
  }
}

/**
 * Restart services
 */
async function serveRestart(ctx, serviceRefs, options) {
  output.header('Restarting Services');

  const serveState = initServeState(ctx);
  const running = serveState.running || {};

  // Determine which services to restart
  let toRestart;
  if (serviceRefs && serviceRefs.length > 0) {
    const modules = ctx.resolveModules(serviceRefs);
    toRestart = modules.filter(m => running[m.name]);
  } else {
    // Restart all running services
    toRestart = Object.keys(running)
      .map(name => ctx.getModule(name))
      .filter(Boolean);
  }

  if (toRestart.length === 0) {
    output.info('No running services to restart');
    return;
  }

  // Stop services
  for (const module of toRestart) {
    await stopService(ctx, module.name, { quiet: true });
  }

  await sleep(1000);

  // Start services
  await serveNativeBackground(ctx, toRestart);
}

// ==================== Main Serve Function ====================

/**
 * Main serve entry point
 */
async function serveMain(ctx, serviceRefs, options) {
  // Apply defaults from config
  const serveDefaults = ctx.config.serve?.defaults || {};
  const opts = {
    startInfra: options.startInfra ?? serveDefaults.startInfra ?? false,
    localstack: options.localstack ?? serveDefaults.localstack ?? true,
    sequential: options.sequential ?? serveDefaults.sequential ?? false,
    startupDelay: options.startupDelay ?? serveDefaults.startupDelay ?? 1,
    infraCheck: options.infraCheck,
    docker: options.docker,
    detach: options.detach,
    build: options.build
  };

  // Resolve services
  let modules;
  if (serviceRefs && serviceRefs.length > 0) {
    modules = ctx.resolveModules(serviceRefs);
  } else {
    modules = getServableModules(ctx.config);
  }

  // Filter to only servable modules
  modules = modules.filter(isServable);

  if (modules.length === 0) {
    throw new ServeError('No servable modules found');
  }

  // Check infrastructure unless explicitly skipped
  if (opts.infraCheck !== false) {
    const infraHealthy = await isInfrastructureRunning(ctx);

    if (!infraHealthy) {
      if (opts.startInfra) {
        await startInfrastructure(ctx, { noLocalstack: opts.localstack === false });
        output.newline();
      } else {
        output.error('Infrastructure is not running.');
        output.newline();
        output.info('Start it with: jic serve infra start');
        output.info('Or use: jic serve --start-infra');
        throw new ServeError('Infrastructure not running. Use --start-infra to auto-start.');
      }
    }
  }

  // Build if requested
  if (opts.build) {
    output.header('Building Services');
    for (const module of modules) {
      const spinner = createSpinner(`Building ${module.name}`);
      spinner.start();
      try {
        await execInModule(module, module.build?.command || 'echo "No build command"', { silent: true });
        spinner.succeed(`Built ${module.name}`);
      } catch (error) {
        spinner.fail(`Failed to build ${module.name}`);
        throw new ServeError(`Build failed for ${module.name}`, module.name);
      }
    }
    output.newline();
  }

  // Choose mode and run
  if (opts.docker) {
    await serveDocker(ctx, modules, opts);
  } else if (opts.detach) {
    await serveNativeBackground(ctx, modules);
  } else {
    await serveNativeForeground(ctx, modules, opts);
  }
}

// ==================== Command Registration ====================

export function registerServeCommands(program, ctx) {
  const serve = program
    .command('serve')
    .description('Run development services')
    .argument('[services...]', 'Services to start (aliases, names, or @groups)')
    .option('--native', 'Run services natively via mvn/npm (default)')
    .option('--docker', 'Run services via docker-compose')
    .option('--build', 'Build before serving')
    .option('-d, --detach', 'Run in background (detached mode)')
    .option('--start-infra', 'Auto-start infrastructure if not running')
    .option('--no-localstack', 'Skip LocalStack when starting infrastructure')
    .option('--no-infra-check', 'Skip infrastructure check')
    .option('--sequential', 'Start services one at a time, waiting for each to be healthy')
    .option('--startup-delay <seconds>', 'Delay between service starts in seconds', '1')
    .action(withErrorHandling(async (services, options) => {
      await serveMain(ctx, services, options);
    }));

  serve
    .command('status')
    .description('Show running services status')
    .action(withErrorHandling(async () => {
      await serveStatus(ctx);
    }));

  serve
    .command('stop')
    .description('Stop running services')
    .argument('[services...]', 'Services to stop (default: all)')
    .action(withErrorHandling(async (services) => {
      await serveStop(ctx, services);
    }));

  serve
    .command('logs')
    .description('Tail service logs')
    .argument('[service]', 'Service to show logs for (default: all)')
    .option('-n, --lines <n>', 'Number of lines to show', '100')
    .action(withErrorHandling(async (service, options) => {
      await serveLogs(ctx, service, options);
    }));

  serve
    .command('restart')
    .description('Restart services')
    .argument('[services...]', 'Services to restart (default: all running)')
    .action(withErrorHandling(async (services, options) => {
      await serveRestart(ctx, services, options);
    }));

  // Infrastructure sub-commands
  const infra = serve
    .command('infra')
    .description('Infrastructure management');

  infra
    .command('start')
    .description('Start infrastructure containers (MongoDB, Eureka, etc.)')
    .option('--no-localstack', 'Skip starting LocalStack (SQS/S3 emulation)')
    .action(withErrorHandling(async (options) => {
      await startInfrastructure(ctx, options);
    }));

  infra
    .command('stop')
    .description('Stop infrastructure containers')
    .action(withErrorHandling(async () => {
      await stopInfrastructure(ctx);
    }));

  infra
    .command('status')
    .description('Show infrastructure status')
    .action(withErrorHandling(async () => {
      await infraStatus(ctx);
    }));
}

export default { registerServeCommands };
