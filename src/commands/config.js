/**
 * Configuration management commands
 *
 * Commands:
 *   jic config init - Initialize configuration
 *   jic config validate - Validate configuration
 *   jic config show [key] - Show configuration
 *   jic config set <key> <value> - Set configuration value
 *   jic config get <key> - Get configuration value
 */

import { writeFile, access } from 'fs/promises';
import { join } from 'path';
import { withErrorHandling, ConfigError } from '../utils/error.js';
import { output } from '../utils/output.js';
import inquirer from 'inquirer';

/**
 * Register config commands
 */
export function registerConfigCommands(program, ctx) {
  const config = program
    .command('config')
    .description('Configuration management');

  config
    .command('init')
    .description('Initialize jic configuration in current directory')
    .option('-f, --force', 'Overwrite existing configuration')
    .action(withErrorHandling(async (options) => {
      await configInit(ctx, options);
    }));

  config
    .command('validate')
    .description('Validate configuration files')
    .action(withErrorHandling(async () => {
      await configValidate(ctx);
    }));

  config
    .command('show')
    .argument('[key]', 'Configuration key to show (dot notation)')
    .description('Show configuration')
    .action(withErrorHandling(async (key) => {
      await configShow(ctx, key);
    }));

  config
    .command('get <key>')
    .description('Get a configuration value')
    .action(withErrorHandling(async (key) => {
      await configGet(ctx, key);
    }));

  config
    .command('set <key> <value>')
    .description('Set a configuration value (in local config)')
    .action(withErrorHandling(async (key, value) => {
      await configSet(ctx, key, value);
    }));

  config
    .command('path')
    .description('Show configuration file paths')
    .action(withErrorHandling(async () => {
      await configPath(ctx);
    }));
}

/**
 * Initialize configuration
 */
async function configInit(ctx, options) {
  const cwd = process.cwd();
  const configPath = join(cwd, 'jic.config.json');

  // Check if config exists
  try {
    await access(configPath);
    if (!options.force) {
      throw new ConfigError('Configuration file already exists. Use --force to overwrite.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  output.header('Initialize JIC Configuration');

  // Gather project info
  const { projectName, projectDescription } = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectName',
      message: 'Project name:',
      default: cwd.split('/').pop()
    },
    {
      type: 'input',
      name: 'projectDescription',
      message: 'Project description:',
      default: ''
    }
  ]);

  // Create initial config
  const initialConfig = {
    "$schema": "./node_modules/jic-cli/schema/jic.config.schema.json",
    "version": "1.0.0",
    "project": {
      "name": projectName,
      "description": projectDescription,
      "rootDir": "."
    },
    "modules": {},
    "groups": {
      "@all": ["*"]
    },
    "buildOrder": [],
    "aws": {
      "region": "eu-south-1",
      "dev": {
        "profile": "default"
      },
      "prod": {
        "profile": "prod"
      }
    },
    "defaults": {
      "branch": "main",
      "environment": "dev",
      "failStrategy": "fail-fast"
    }
  };

  if (ctx.dryRun) {
    output.info('[dry-run] Would create jic.config.json');
    console.log(JSON.stringify(initialConfig, null, 2));
    return;
  }

  await writeFile(configPath, JSON.stringify(initialConfig, null, 2));

  // Create .gitignore entries
  const gitignorePath = join(cwd, '.gitignore');
  const gitignoreEntries = '\n# JIC CLI\njic.local.json\njic.state.json\n';

  try {
    const { appendFile } = await import('fs/promises');
    await appendFile(gitignorePath, gitignoreEntries);
    output.success('Added jic files to .gitignore');
  } catch {
    output.warn('Could not update .gitignore - please add jic.local.json and jic.state.json manually');
  }

  output.newline();
  output.success('Configuration initialized');
  output.info(`Edit ${configPath} to add your modules`);
}

/**
 * Validate configuration
 */
async function configValidate(ctx) {
  output.header('Validate Configuration');

  const errors = [];
  const warnings = [];

  // Check if initialized
  if (!ctx.isInitialized) {
    errors.push('Project not initialized. Run `jic config init` first.');
    output.error(`Found ${errors.length} error(s)`);
    return;
  }

  // Validate modules
  for (const [name, module] of Object.entries(ctx.config.modules || {})) {
    // Check directory exists
    try {
      await access(module.absolutePath);
    } catch {
      errors.push(`Module '${name}': directory '${module.directory}' not found`);
    }

    // Check required fields
    if (!module.type) {
      errors.push(`Module '${name}': missing 'type' field`);
    }

    if (!module.directory) {
      errors.push(`Module '${name}': missing 'directory' field`);
    }

    // Check build config
    if (!module.build?.command) {
      warnings.push(`Module '${name}': no build command configured`);
    }

    // Check deploy config for deployable modules
    if (['java-service', 'frontend'].includes(module.type)) {
      if (!module.deploy) {
        warnings.push(`Module '${name}': no deploy configuration`);
      }
    }
  }

  // Validate groups
  for (const [groupName, refs] of Object.entries(ctx.config.groups || {})) {
    for (const ref of refs) {
      if (ref !== '*' && !ref.startsWith('@') && !ref.includes('*')) {
        const module = ctx.getModule(ref);
        if (!module) {
          warnings.push(`Group '${groupName}': unknown module reference '${ref}'`);
        }
      }
    }
  }

  // Validate AWS config
  if (!ctx.config.aws?.region) {
    warnings.push('AWS region not configured');
  }

  // Output results
  if (errors.length > 0) {
    output.subheader('Errors');
    errors.forEach(e => output.error(e));
  }

  if (warnings.length > 0) {
    output.subheader('Warnings');
    warnings.forEach(w => output.warning(w));
  }

  if (errors.length === 0 && warnings.length === 0) {
    output.success('Configuration is valid');
  } else {
    output.newline();
    output.info(`${errors.length} error(s), ${warnings.length} warning(s)`);
  }

  if (errors.length > 0) {
    process.exit(2);
  }
}

/**
 * Show configuration
 */
async function configShow(ctx, key) {
  if (!ctx.isInitialized) {
    throw new ConfigError('Project not initialized');
  }

  let value = ctx.config;

  if (key) {
    const parts = key.split('.');
    for (const part of parts) {
      value = value?.[part];
      if (value === undefined) {
        throw new ConfigError(`Configuration key not found: ${key}`);
      }
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify(value, null, 2));
  } else if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

/**
 * Get configuration value
 */
async function configGet(ctx, key) {
  if (!ctx.isInitialized) {
    throw new ConfigError('Project not initialized');
  }

  const parts = key.split('.');
  let value = ctx.config;

  for (const part of parts) {
    value = value?.[part];
    if (value === undefined) {
      throw new ConfigError(`Configuration key not found: ${key}`);
    }
  }

  if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(value);
  }
}

/**
 * Set configuration value (in local config)
 */
async function configSet(ctx, key, value) {
  if (!ctx.isInitialized) {
    throw new ConfigError('Project not initialized');
  }

  const { readFile, writeFile } = await import('fs/promises');

  // Load local config
  let localConfig = {};
  try {
    const content = await readFile(ctx.config.paths.localConfig, 'utf-8');
    localConfig = JSON.parse(content);
  } catch {
    // File doesn't exist, start fresh
  }

  // Set value using dot notation
  const parts = key.split('.');
  let current = localConfig;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }

  // Try to parse value as JSON, otherwise use as string
  let parsedValue;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    parsedValue = value;
  }

  current[parts[parts.length - 1]] = parsedValue;

  if (ctx.dryRun) {
    output.info('[dry-run] Would set configuration');
    console.log(JSON.stringify(localConfig, null, 2));
    return;
  }

  await writeFile(ctx.config.paths.localConfig, JSON.stringify(localConfig, null, 2));
  output.success(`Set ${key} = ${JSON.stringify(parsedValue)}`);
}

/**
 * Show configuration file paths
 */
async function configPath(ctx) {
  output.header('Configuration Paths');

  output.keyValue('Project Root', ctx.config.projectRoot || 'Not initialized');
  output.keyValue('Project Config', ctx.config.paths?.config || 'N/A');
  output.keyValue('Local Config', ctx.config.paths?.localConfig || 'N/A');
  output.keyValue('State File', ctx.config.paths?.state || 'N/A');
}

export default { registerConfigCommands };
