/**
 * Serve Command
 *
 * Run development services with process management.
 *
 * Examples:
 *   jic serve                    # Start all servable modules
 *   jic serve gws tms            # Start specific services
 *   jic serve @minServe          # Start minimal service set
 *   jic serve --stop             # Stop all services
 *   jic serve --status           # Show running services
 *   jic serve infra start        # Start infrastructure
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { ResolvedModule } from '../core/types/module.js';
import type { ManagedProcess } from '../core/types/execution.js';
import { ServeError, withErrorHandling } from '../core/errors/index.js';
import { exec, isProcessRunning, killProcess } from '../core/utils/shell.js';
import { colors } from '../core/utils/output.js';
import { isServable } from '../core/types/module.js';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, writeSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

// ============================================================================
// Types
// ============================================================================

interface ServeOptions {
  detach?: boolean;
  stop?: boolean;
  status?: boolean;
  restart?: boolean;
  logs?: boolean;
}

// Service colors for log multiplexing
const SERVICE_COLORS: Record<string, typeof chalk> = {
  gws: chalk.cyan,
  gateway: chalk.cyan,
  ms: chalk.blue,
  mainservice: chalk.blue,
  tms: chalk.green,
  'tenant-main': chalk.green,
  tas: chalk.yellow,
  agenda: chalk.yellow,
  tns: chalk.magenta,
  notifications: chalk.magenta,
  gwc: chalk.white,
  frontend: chalk.white,
  wa: chalk.red,
  whatsapp: chalk.red,
};

// ============================================================================
// Serve Command Registration
// ============================================================================

export function registerServeCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const serve = program.command('serve').description('Run development services');

  // Main serve command
  serve
    .argument('[modules...]', 'Modules to serve (names, aliases, or @groups)')
    .option('-d, --detach', 'Run in background')
    .option('--stop', 'Stop running services')
    .option('--status', 'Show running services status')
    .option('--restart', 'Restart services')
    .option('--logs', 'Tail logs from services')
    .action(
      withErrorHandling(async (modules: string[], options: ServeOptions) => {
        const ctx = await createContext();

        if (options.status) {
          await serveStatus(ctx);
        } else if (options.stop) {
          await serveStop(ctx, modules);
        } else if (options.restart) {
          await serveStop(ctx, modules);
          await serveStart(ctx, modules, options);
        } else if (options.logs) {
          await serveLogs(ctx, modules);
        } else {
          await serveStart(ctx, modules, options);
        }
      })
    );

  // Infrastructure subcommand
  const infra = serve.command('infra').description('Infrastructure management');

  infra
    .command('start')
    .description('Start infrastructure (MongoDB, Eureka)')
    .option('--localstack', 'Also start LocalStack')
    .action(
      withErrorHandling(async (options: { localstack?: boolean }) => {
        const ctx = await createContext();
        await infraStart(ctx, options);
      })
    );

  infra
    .command('stop')
    .description('Stop infrastructure')
    .option('--localstack', 'Also stop LocalStack')
    .action(
      withErrorHandling(async (options: { localstack?: boolean }) => {
        const ctx = await createContext();
        await infraStop(ctx, options);
      })
    );

  infra
    .command('status')
    .description('Show infrastructure status (all services including LocalStack)')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await infraStatus(ctx);
      })
    );
}

// ============================================================================
// Serve Start
// ============================================================================

async function serveStart(
  ctx: IExecutionContext,
  moduleRefs: string[],
  options: ServeOptions
): Promise<void> {
  // Resolve modules
  let modules = ctx.resolveModules(moduleRefs);

  // Filter to servable modules
  modules = modules.filter(isServable);

  if (modules.length === 0) {
    ctx.output.warning('No servable modules found');
    return;
  }

  ctx.output.header('Starting Services');

  // Check infrastructure
  const infraRunning = await isInfrastructureRunning(ctx);
  if (!infraRunning) {
    ctx.output.warning('Infrastructure is not running. Start it with: jic serve infra start');
    ctx.output.newline();
  }

  // Clean up stale processes
  await cleanupStaleProcesses(ctx);

  // Start each service
  for (const module of modules) {
    await startService(ctx, module, options);
  }

  ctx.output.newline();

  if (options.detach) {
    ctx.output.success(`Started ${modules.length} service(s) in background`);
    ctx.output.info('Use "jic serve --status" to see running services');
    ctx.output.info('Use "jic serve --stop" to stop services');
  }
}

async function startService(
  ctx: IExecutionContext,
  module: ResolvedModule,
  options: ServeOptions
): Promise<void> {
  const command = getServeCommand(module);
  if (!command) {
    ctx.output.warning(`No serve command for ${module.name}`);
    return;
  }

  // Check if already running
  const running = getRunningProcess(ctx, module.name);
  if (running && isProcessRunning(running.pid)) {
    ctx.output.info(`${module.name} already running (PID ${running.pid})`);
    return;
  }

  const spinner = ctx.output.spinner(`Starting ${module.name}`);
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would start: ${command}`);
      return;
    }

    const env = { ...process.env, ...module.resolvedServe?.env };
    const logsDir = ensureLogsDir(ctx);
    const logFile = join(logsDir, `${module.name}.log`);

    if (options.detach) {
      // Background mode
      const logFd = openSync(logFile, 'a');
      writeSync(logFd, `\n=== Started at ${new Date().toISOString()} ===\n`);
      writeSync(logFd, `Command: ${command}\n\n`);

      const child = spawn(command, [], {
        cwd: module.absolutePath,
        env,
        shell: true,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });

      child.unref();

      // Save process info
      await saveProcessInfo(ctx, module.name, {
        pid: child.pid!,
        pgid: child.pid!,
        moduleName: module.name,
        startedAt: new Date().toISOString(),
        command,
        status: 'running',
        restartCount: 0,
        logFile,
        port: module.port,
      });

      // Wait briefly and check if process started
      await sleep(1000);

      if (isProcessRunning(child.pid!)) {
        spinner.succeed(`${module.name} started (PID ${child.pid})`);
      } else {
        spinner.fail(`${module.name} failed to start`);
        throw new ServeError(`Service failed to start`, module.name);
      }
    } else {
      // Foreground mode with log multiplexing
      const color = getServiceColor(module);
      const prefix = `[${module.aliases?.[0] ?? module.name}]`.padEnd(8);

      const child = spawn(command, [], {
        cwd: module.absolutePath,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Stream output with colored prefix
      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            console.log(color(`${prefix} ${line}`));
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          if (line.trim()) {
            console.error(color(`${prefix} ${line}`));
          }
        }
      });

      // Save process info
      await saveProcessInfo(ctx, module.name, {
        pid: child.pid!,
        pgid: child.pid!,
        moduleName: module.name,
        startedAt: new Date().toISOString(),
        command,
        status: 'running',
        restartCount: 0,
        port: module.port,
      });

      spinner.succeed(`${module.name} started (PID ${child.pid})`);

      // Handle process exit
      child.on('exit', (code) => {
        console.log(color(`${prefix} Process exited with code ${code}`));
        removeProcessInfo(ctx, module.name);
      });
    }
  } catch (error) {
    spinner.fail(`Failed to start ${module.name}`);
    if (error instanceof Error) {
      ctx.output.error(`  ${error.message}`);
    }
  }
}

// ============================================================================
// Serve Stop
// ============================================================================

async function serveStop(ctx: IExecutionContext, moduleRefs: string[]): Promise<void> {
  ctx.output.header('Stopping Services');

  const processes = ctx.state.serve?.processes ?? {};
  let toStop: string[];

  if (moduleRefs.length > 0) {
    const modules = ctx.resolveModules(moduleRefs);
    toStop = modules.map((m) => m.name).filter((name) => processes[name]);
  } else {
    toStop = Object.keys(processes);
  }

  if (toStop.length === 0) {
    ctx.output.info('No services to stop');
    return;
  }

  for (const name of toStop) {
    const info = processes[name];
    if (!info) continue;

    const spinner = ctx.output.spinner(`Stopping ${name}`);
    spinner.start();

    try {
      if (ctx.dryRun) {
        spinner.info(`[dry-run] Would stop PID ${info.pid}`);
        continue;
      }

      if (isProcessRunning(info.pid)) {
        await killProcess(info.pid);
        spinner.succeed(`${name} stopped`);
      } else {
        spinner.info(`${name} was not running`);
      }

      await removeProcessInfo(ctx, name);
    } catch (error) {
      spinner.fail(`Failed to stop ${name}`);
      if (error instanceof Error) {
        ctx.output.error(`  ${error.message}`);
      }
    }
  }
}

// ============================================================================
// Serve Status
// ============================================================================

async function serveStatus(ctx: IExecutionContext): Promise<void> {
  ctx.output.header('Service Status');

  // Clean up stale processes first
  await cleanupStaleProcesses(ctx);

  const processes = ctx.state.serve?.processes ?? {};
  const servableModules = Object.values(ctx.config.resolvedModules).filter(isServable);

  if (servableModules.length === 0) {
    ctx.output.info('No servable modules configured');
    return;
  }

  const rows: string[][] = [];

  for (const module of servableModules) {
    const info = processes[module.name];
    const running = info && isProcessRunning(info.pid);

    rows.push([
      ctx.output.module(module.name),
      module.port?.toString() ?? '-',
      running ? colors.success(`running (${info.pid})`) : colors.muted('stopped'),
      running && info.startedAt
        ? new Date(info.startedAt).toLocaleTimeString()
        : '-',
    ]);
  }

  ctx.output.table(rows, {
    head: ['Service', 'Port', 'Status', 'Started'],
  });

  const runningCount = Object.keys(processes).filter((n) =>
    processes[n] && isProcessRunning(processes[n].pid)
  ).length;

  ctx.output.newline();
  ctx.output.info(`${runningCount} of ${servableModules.length} services running`);
}

// ============================================================================
// Serve Logs
// ============================================================================

async function serveLogs(ctx: IExecutionContext, moduleRefs: string[]): Promise<void> {
  const logsDir = ensureLogsDir(ctx);

  let modules: ResolvedModule[];
  if (moduleRefs.length > 0) {
    modules = ctx.resolveModules(moduleRefs);
  } else {
    // Show logs for running services
    const processes = ctx.state.serve?.processes ?? {};
    modules = Object.keys(processes)
      .map((name) => ctx.getModule(name))
      .filter((m): m is ResolvedModule => m !== null);
  }

  if (modules.length === 0) {
    ctx.output.warning('No services to show logs for');
    return;
  }

  ctx.output.header('Service Logs');

  // Use tail -f on log files
  const logFiles = modules.map((m) => join(logsDir, `${m.name}.log`)).filter(existsSync);

  if (logFiles.length === 0) {
    ctx.output.warning('No log files found');
    return;
  }

  ctx.output.info(`Tailing logs for: ${modules.map((m) => m.name).join(', ')}`);
  ctx.output.info('Press Ctrl+C to exit\n');

  // Spawn tail -f
  const child = spawn('tail', ['-f', ...logFiles], {
    stdio: 'inherit',
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    child.kill();
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    child.on('exit', resolve);
  });
}

// ============================================================================
// Infrastructure Management
// ============================================================================

async function infraStart(
  ctx: IExecutionContext,
  options: { localstack?: boolean }
): Promise<void> {
  const composeFile = 'docker-compose-infra.yml';
  const composePath = join(ctx.projectRoot, composeFile);

  if (!existsSync(composePath)) {
    throw new ServeError(`Infrastructure compose file not found: ${composeFile}`);
  }

  ctx.output.header('Starting Infrastructure');

  // Core services - always started
  const services = ['mongodb', 'mongo-init', 'eureka-registry', 'registry'];

  // Optional services
  if (options.localstack) {
    services.push('localstack');
    ctx.output.info('Including LocalStack');
  }

  ctx.output.keyValue('Services', services.join(', '));
  ctx.output.newline();

  const spinner = ctx.output.spinner('Starting containers');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would start infrastructure');
      return;
    }

    await exec(`docker compose -f ${composePath} up -d ${services.join(' ')}`, {
      cwd: ctx.projectRoot,
      silent: true,
    });
    spinner.succeed('Containers started');
  } catch (error) {
    spinner.fail('Failed to start containers');
    throw new ServeError('Failed to start infrastructure');
  }

  // Wait for health checks
  const healthSpinner = ctx.output.spinner('Waiting for services to be healthy');
  healthSpinner.start();

  const maxWait = 90000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    if (await isInfrastructureRunning(ctx)) {
      healthSpinner.succeed('Infrastructure ready');
      await showInfraStatus(ctx);
      return;
    }
    await sleep(2000);
  }

  healthSpinner.fail('Infrastructure health check timeout');
  throw new ServeError('Infrastructure did not become healthy');
}

async function infraStop(
  ctx: IExecutionContext,
  options: { localstack?: boolean } = {}
): Promise<void> {
  const composeFile = 'docker-compose-infra.yml';
  const composePath = join(ctx.projectRoot, composeFile);

  ctx.output.header('Stopping Infrastructure');

  // Determine which services to stop
  // Core services only by default, unless --localstack is specified
  const services = ['mongodb', 'mongo-init', 'eureka-registry', 'registry'];
  if (options.localstack) {
    services.push('localstack');
    ctx.output.info('Including LocalStack');
  }

  ctx.output.keyValue('Services', services.join(', '));
  ctx.output.newline();

  const spinner = ctx.output.spinner('Stopping containers');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would stop infrastructure');
      return;
    }

    // Stop specific services instead of all
    await exec(`docker compose -f ${composePath} stop ${services.join(' ')}`, {
      cwd: ctx.projectRoot,
      silent: true,
    });
    spinner.succeed('Infrastructure stopped');
  } catch (error) {
    spinner.fail('Failed to stop infrastructure');
    throw new ServeError('Failed to stop infrastructure');
  }
}

async function infraStatus(ctx: IExecutionContext): Promise<void> {
  ctx.output.header('Infrastructure Status');
  await showInfraStatus(ctx);

  const running = await isInfrastructureRunning(ctx);
  ctx.output.newline();

  if (running) {
    ctx.output.success('Infrastructure is ready');
  } else {
    ctx.output.warning('Infrastructure is not fully running');
    ctx.output.info('Start it with: jic serve infra start');
  }
}

async function showInfraStatus(ctx: IExecutionContext): Promise<void> {
  const services = [
    { name: 'MongoDB', port: 27017, check: 'docker exec joyincloud_mongodb mongosh --eval "db.runCommand({ping:1})"', core: true },
    { name: 'Eureka', port: 8761, check: 'curl -sf http://localhost:8761/actuator/health', core: true },
    { name: 'LocalStack', port: 4566, check: 'curl -sf http://localhost:4566/_localstack/health', core: false },
  ];

  const rows: string[][] = [];

  for (const svc of services) {
    let healthy = false;
    try {
      await exec(svc.check, { silent: true, timeout: 5000 });
      healthy = true;
    } catch {
      // Not healthy
    }

    const nameDisplay = svc.core ? svc.name : colors.muted(svc.name);
    rows.push([
      nameDisplay,
      svc.port.toString(),
      healthy ? colors.success('running') : colors.error('stopped'),
      svc.core ? 'core' : 'optional',
    ]);
  }

  ctx.output.table(rows, {
    head: ['Service', 'Port', 'Status', 'Type'],
  });
}

async function isInfrastructureRunning(_ctx: IExecutionContext): Promise<boolean> {
  try {
    await exec('curl -sf http://localhost:8761/actuator/health', { silent: true, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function getServeCommand(module: ResolvedModule): string | null {
  if (module.resolvedServe?.command) {
    return module.resolvedServe.command;
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

function getServiceColor(module: ResolvedModule): typeof chalk {
  const alias = module.aliases?.[0] ?? module.name;
  return SERVICE_COLORS[alias] ?? chalk.gray;
}

function ensureLogsDir(ctx: IExecutionContext): string {
  const logsDir = join(ctx.projectRoot, '.jic', 'logs');
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

function getRunningProcess(ctx: IExecutionContext, name: string): ManagedProcess | undefined {
  return ctx.state.serve?.processes?.[name];
}

async function saveProcessInfo(
  ctx: IExecutionContext,
  name: string,
  info: ManagedProcess
): Promise<void> {
  if (!ctx.state.serve) {
    ctx.state.serve = { processes: {}, infrastructure: { running: false } };
  }
  if (!ctx.state.serve.processes) {
    ctx.state.serve.processes = {};
  }
  ctx.state.serve.processes[name] = info;
  await ctx.saveState();
}

async function removeProcessInfo(ctx: IExecutionContext, name: string): Promise<void> {
  if (ctx.state.serve?.processes) {
    delete ctx.state.serve.processes[name];
    await ctx.saveState();
  }
}

async function cleanupStaleProcesses(ctx: IExecutionContext): Promise<void> {
  const processes = ctx.state.serve?.processes ?? {};
  let cleaned = false;

  for (const [name, info] of Object.entries(processes)) {
    if (!isProcessRunning(info.pid)) {
      delete processes[name];
      cleaned = true;
    }
  }

  if (cleaned) {
    await ctx.saveState();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
