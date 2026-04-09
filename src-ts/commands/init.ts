import { Command } from 'commander';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { ConfigError, withErrorHandling } from '../core/errors/index.js';
import { createEmptyState } from '../core/types/state.js';

const CONFIG_FILENAME = 'jic.config.json';
const STATE_FILENAME = 'jic.state.json';
const GITIGNORE_ENTRIES = ['jic.state.json', 'jic.local.json'];

export function registerInitCommand(
  program: Command,
  _createContext: () => Promise<IExecutionContext>
): void {
  program
    .command('init')
    .description('Initialize a new JIC project in the current directory')
    .option('--name <name>', 'Project name (default: current directory name)')
    .option('--type <type>', 'Project type: independent or submodules')
    .option(
      '--submodules-dir <dir>',
      'Directory containing submodules, relative to project root (only for type "submodules")'
    )
    .option('-f, --force', 'Overwrite existing configuration')
    .option('-y, --yes', 'Skip prompts (uses directory name + submodules type)')
    .action(
      withErrorHandling(async (options: {
        name?: string;
        type?: string;
        submodulesDir?: string;
        force?: boolean;
        yes?: boolean;
      }) => {
        const cwd = process.cwd();
        await initProject(cwd, options);
      })
    );
}

async function initProject(
  cwd: string,
  options: {
    name?: string;
    type?: string;
    submodulesDir?: string;
    force?: boolean;
    yes?: boolean;
  }
): Promise<void> {
  const configPath = join(cwd, CONFIG_FILENAME);

  // Guard: check if already initialized
  if (!options.force) {
    try {
      await access(configPath);
      throw new ConfigError(
        `Project already initialized (${CONFIG_FILENAME} exists). Use --force to overwrite.`
      );
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      // File doesn't exist — proceed
    }
  }

  // Resolve project name
  let projectName = options.name;
  if (!projectName) {
    if (options.yes) {
      projectName = basename(cwd);
    } else {
      projectName = await promptInput(`Project name (${basename(cwd)}): `) || basename(cwd);
    }
  }

  // Resolve project type
  let projectType: 'independent' | 'submodules';
  if (options.type) {
    if (options.type !== 'independent' && options.type !== 'submodules') {
      throw new ConfigError(`Invalid project type: "${options.type}". Must be "independent" or "submodules".`);
    }
    projectType = options.type;
  } else if (options.yes) {
    projectType = 'submodules';
  } else {
    const typeInput = await promptInput('Project type (independent/submodules) [submodules]: ') || 'submodules';
    if (typeInput !== 'independent' && typeInput !== 'submodules') {
      throw new ConfigError(`Invalid project type: "${typeInput}". Must be "independent" or "submodules".`);
    }
    projectType = typeInput;
  }

  // Validate --submodules-dir if provided
  if (options.submodulesDir !== undefined) {
    if (projectType !== 'submodules') {
      throw new ConfigError(
        '--submodules-dir is only valid for projects of type "submodules".'
      );
    }
    const sd = options.submodulesDir;
    if (sd.length === 0 || /^[/\\]/.test(sd) || /^[A-Za-z]:/.test(sd)) {
      throw new ConfigError(`--submodules-dir must be a relative path: "${sd}"`);
    }
    if (sd.split(/[\\/]/).includes('..')) {
      throw new ConfigError(`--submodules-dir must not escape the project root: "${sd}"`);
    }
  }
  const submodulesDir = options.submodulesDir?.replace(/\\/g, '/');

  // Build config object
  const config: Record<string, unknown> = {
    version: '2.0.0',
    project: {
      name: projectName,
      rootDir: '.',
      ...(projectType === 'submodules' ? { type: 'submodules' } : {}),
      ...(submodulesDir && submodulesDir !== '.' ? { submodulesDir } : {}),
    },
    modules: {},
    groups: {},
    defaults: {
      environment: 'dev',
      failStrategy: 'fail-fast',
    },
  };

  // Write jic.config.json
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`  Created ${CONFIG_FILENAME}`);

  // Write jic.state.json
  const statePath = join(cwd, STATE_FILENAME);
  const state = createEmptyState();
  if (projectType === 'submodules') {
    state.activeVendor = 'root';
  }
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  console.log(`  Created ${STATE_FILENAME}`);

  // Create .jic directory
  const jicDir = join(cwd, '.jic');
  await mkdir(jicDir, { recursive: true });
  console.log('  Created .jic/');

  // Create vendors directory for submodules projects
  // Note: root vendor config is not created here because the Zod schema
  // requires at least 1 module. It will be generated when modules are added.
  if (projectType === 'submodules') {
    const vendorsDir = join(jicDir, 'vendors');
    await mkdir(vendorsDir, { recursive: true });
    console.log('  Created .jic/vendors/');
  }

  // Update .gitignore
  await updateGitignore(cwd);

  console.log('');
  console.log(`Project "${projectName}" initialized (${projectType}).`);
  if (projectType === 'submodules') {
    console.log('Use "jic vendor create <name>" to add vendors.');
  }
  console.log('Add modules to jic.config.json to get started.');
}

async function promptInput(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function updateGitignore(cwd: string): Promise<void> {
  const gitignorePath = join(cwd, '.gitignore');
  let content = '';

  try {
    content = await readFile(gitignorePath, 'utf-8');
  } catch {
    // .gitignore doesn't exist
  }

  const lines = content.split('\n');
  const toAdd: string[] = [];

  for (const entry of GITIGNORE_ENTRIES) {
    if (!lines.some((line) => line.trim() === entry)) {
      toAdd.push(entry);
    }
  }

  if (toAdd.length > 0) {
    const suffix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const addition = suffix + toAdd.join('\n') + '\n';
    await writeFile(gitignorePath, content + addition, 'utf-8');
    console.log(`  Updated .gitignore (added ${toAdd.join(', ')})`);
  }
}
