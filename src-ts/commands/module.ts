import { Command } from 'commander';
import { readdir, access, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { ModuleType, ModuleConfig } from '../core/types/config.js';
import { ConfigError, withErrorHandling } from '../core/errors/index.js';
import { saveConfig } from '../core/config/loader.js';
import { detectModuleType } from '../core/utils/module-detector.js';

/** Normalize a path to POSIX separators for config persistence & cross-platform portability. */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Validate a submodules directory: must be relative, must not escape projectRoot,
 * and must exist as a directory.
 */
async function validateSubmodulesDir(dir: string, projectRoot: string): Promise<void> {
  if (isAbsolute(dir)) {
    throw new ConfigError(`Submodules path must be relative to the project root: "${dir}"`);
  }
  const normalized = normalize(dir);
  const segments = normalized.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.');
  if (segments.includes('..')) {
    throw new ConfigError(`Submodules path must stay inside the project root: "${dir}"`);
  }
  const abs = join(projectRoot, normalized);
  try {
    const st = await stat(abs);
    if (!st.isDirectory()) {
      throw new ConfigError(`Submodules path is not a directory: "${dir}"`);
    }
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Submodules path does not exist: "${dir}"`);
  }
}

export function registerModuleCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const mod = program
    .command('module')
    .description('Module management and configuration');

  // --- module discovery ---
  mod
    .command('discovery')
    .description('Discover modules in subdirectories and add to config')
    .option(
      '--path <dir>',
      'Directory to scan for submodules, relative to project root (overrides project.submodulesDir)'
    )
    .action(
      withErrorHandling(async (options: { path?: string }) => {
        const ctx = await createContext();
        await moduleDiscovery(ctx, options.path);
      })
    );

  // --- module config <module> get|set <key> [value] ---
  mod
    .command('config <module> <action> <key> [value]')
    .description('Get or set module configuration (action: get|set)')
    .action(
      withErrorHandling(async (moduleName: string, action: string, key: string, value: string | undefined) => {
        const ctx = await createContext();

        if (action === 'get') {
          moduleConfigGet(ctx, moduleName, key);
        } else if (action === 'set') {
          if (value === undefined) {
            throw new ConfigError('Missing value for config set. Usage: jic module config <module> set <key> <value>');
          }
          await moduleConfigSet(ctx, moduleName, key, value);
        } else {
          throw new ConfigError(`Unknown action "${action}". Use "get" or "set".`);
        }
      })
    );
}

// ============================================================================
// Module Discovery
// ============================================================================

async function moduleDiscovery(ctx: IExecutionContext, pathFlag?: string): Promise<void> {
  const projectRoot = ctx.projectRoot;

  // Resolve submodules directory: CLI flag > project.submodulesDir > "."
  const rawSubmodulesDir = pathFlag ?? ctx.config.project.submodulesDir ?? '.';
  await validateSubmodulesDir(rawSubmodulesDir, projectRoot);
  const normalizedSubmodulesDir = toPosixPath(normalize(rawSubmodulesDir));
  const isRootScan = normalizedSubmodulesDir === '.' || normalizedSubmodulesDir === '';
  const scanDir = isRootScan ? projectRoot : join(projectRoot, normalizedSubmodulesDir);

  ctx.output.header('Module Discovery');
  ctx.output.info(`Scanning ${scanDir}...`);
  ctx.output.newline();

  const entries = await readdir(scanDir, { withFileTypes: true });

  // Dedup against full directory path (relative to projectRoot, POSIX)
  const existingDirectories = new Set(
    Object.values(ctx.config.modules).map((m) => toPosixPath(m.directory))
  );

  const discovered: Array<{ name: string; type: ModuleType; directory: string }> = [];
  const skipped: string[] = [];
  const collisions: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip hidden directories and known non-module directories
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const moduleDirectory = isRootScan
      ? entry.name
      : toPosixPath(join(normalizedSubmodulesDir, entry.name));
    const absoluteModulePath = join(projectRoot, moduleDirectory);

    // Check if it has a .git entry (directory for a regular repo, file for a submodule)
    const gitDir = join(absoluteModulePath, '.git');
    try {
      await access(gitDir);
    } catch {
      continue; // No .git, skip
    }

    // Check if already in config (by full directory path)
    if (existingDirectories.has(moduleDirectory)) {
      skipped.push(moduleDirectory);
      continue;
    }

    // Module-name collision: a module with this basename already exists but points elsewhere
    if (ctx.config.modules[entry.name]) {
      collisions.push(moduleDirectory);
      continue;
    }

    // Detect module type
    try {
      const type = await detectModuleType(absoluteModulePath);

      // Add to config
      const moduleConfig: ModuleConfig = {
        type,
        directory: moduleDirectory,
      };

      ctx.config.modules[entry.name] = moduleConfig;
      ctx.config.resolvedModules[entry.name] = {
        ...moduleConfig,
        name: entry.name,
        absolutePath: absoluteModulePath,
        originalConfig: moduleConfig,
        resolvedBuild: undefined,
        resolvedServe: undefined,
        resolvedDeploy: undefined,
      };

      discovered.push({ name: entry.name, type, directory: moduleDirectory });
      existingDirectories.add(moduleDirectory);
    } catch (error) {
      ctx.output.warn(`  ${entry.name}: detection failed, skipping`);
      if (ctx.verbose && error instanceof Error) {
        ctx.output.error(`    ${error.message}`);
      }
    }
  }

  // Persist project.submodulesDir when discovery was invoked with --path and
  // the config does not yet specify one. This makes the choice sticky so
  // subsequent commands (and future discovery runs) see the same layout.
  const shouldPersistSubmodulesDir =
    !!pathFlag &&
    !isRootScan &&
    ctx.config.project.submodulesDir === undefined;
  if (shouldPersistSubmodulesDir) {
    ctx.config.project.submodulesDir = normalizedSubmodulesDir;
  }

  // Save config
  if (discovered.length > 0 || shouldPersistSubmodulesDir) {
    await saveConfig(ctx.config);
  }

  // Output results
  if (discovered.length > 0) {
    ctx.output.success('Discovered modules:');
    for (const mod of discovered) {
      ctx.output.log(`  ${mod.name.padEnd(30)} ${mod.type.padEnd(20)} ${mod.directory}`);
    }
  } else {
    ctx.output.info('No new modules discovered.');
  }

  if (skipped.length > 0) {
    ctx.output.newline();
    ctx.output.info(`Skipped (already in config): ${skipped.join(', ')}`);
  }

  if (collisions.length > 0) {
    ctx.output.newline();
    ctx.output.warn(
      `Skipped due to name collision (basename already used by another module): ${collisions.join(', ')}`
    );
  }

  if (shouldPersistSubmodulesDir) {
    ctx.output.newline();
    ctx.output.info(`Saved project.submodulesDir = "${normalizedSubmodulesDir}"`);
  }

  ctx.output.newline();
  ctx.output.info(
    `Total: ${discovered.length} added, ${skipped.length} skipped, ${collisions.length} collisions`
  );
}

// ============================================================================
// Module Config Get
// ============================================================================

function moduleConfigGet(ctx: IExecutionContext, moduleName: string, key: string): void {
  const mod = ctx.getModule(moduleName);
  if (!mod) {
    throw new ConfigError(`Module "${moduleName}" not found.`);
  }

  const value = getNestedValue(mod.originalConfig as unknown as Record<string, unknown>, key);
  if (value === undefined) {
    throw new ConfigError(`Key "${key}" not found in module "${mod.name}".`);
  }

  if (typeof value === 'object') {
    ctx.output.log(JSON.stringify(value, null, 2));
  } else {
    ctx.output.log(String(value));
  }
}

// ============================================================================
// Module Config Set
// ============================================================================

async function moduleConfigSet(
  ctx: IExecutionContext,
  moduleName: string,
  key: string,
  rawValue: string
): Promise<void> {
  const mod = ctx.getModule(moduleName);
  if (!mod) {
    throw new ConfigError(`Module "${moduleName}" not found.`);
  }

  const value = parseValue(rawValue);
  setNestedValue(mod.originalConfig as unknown as Record<string, unknown>, key, value);

  await saveConfig(ctx.config);
  ctx.output.success(`${mod.name}.${key} = ${JSON.stringify(value)}`);
}

// ============================================================================
// Helpers
// ============================================================================

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;
}

function parseValue(raw: string): unknown {
  // Try JSON (objects, arrays)
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ConfigError(`Invalid JSON value: ${raw}`);
    }
  }

  // Booleans
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  // String
  return raw;
}
