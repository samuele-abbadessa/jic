/**
 * Search Command
 *
 * Cross-module code search using ripgrep or grep.
 *
 * Examples:
 *   jic search "ClassName"              # Search across all modules
 *   jic search "pattern" --type java    # Filter by file type
 *   jic search "TODO" @backend          # Search in module group
 *   jic search -r "regex.*pattern"      # Regex search
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import { withErrorHandling } from '../core/errors/index.js';
import { exec } from '../core/utils/shell.js';
import { colors } from '../core/utils/output.js';

// ============================================================================
// Search Command Registration
// ============================================================================

interface SearchOptions {
  type?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  context?: string;
  filesOnly?: boolean;
  count?: boolean;
}

export function registerSearchCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  program
    .command('search <pattern>')
    .description('Search across modules')
    .argument('[modules...]', 'Modules to search (default: all)')
    .option('-t, --type <type>', 'File type filter (java, ts, js, json, xml, etc.)')
    .option('-r, --regex', 'Treat pattern as regex')
    .option('-i, --ignore-case', 'Case-insensitive search')
    .option('-A, --context <lines>', 'Show context lines', '0')
    .option('-l, --files-only', 'Only show file names')
    .option('--count', 'Only show match counts per module')
    .action(
      withErrorHandling(async (pattern: string, modules: string[], options: SearchOptions) => {
        const ctx = await createContext();
        await searchModules(ctx, pattern, modules, options);
      })
    );
}

// ============================================================================
// Search Implementation
// ============================================================================

interface SearchResult {
  module: string;
  file: string;
  line: number;
  content: string;
}

interface ModuleSearchResult {
  module: string;
  matches: SearchResult[];
  fileCount: number;
  matchCount: number;
}

/**
 * Check if ripgrep is available
 */
async function hasRipgrep(): Promise<boolean> {
  try {
    await exec('which rg', { silent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * File type to glob pattern mapping
 */
const TYPE_GLOBS: Record<string, string[]> = {
  java: ['*.java'],
  ts: ['*.ts', '*.tsx'],
  js: ['*.js', '*.jsx'],
  json: ['*.json'],
  xml: ['*.xml'],
  yml: ['*.yml', '*.yaml'],
  yaml: ['*.yml', '*.yaml'],
  md: ['*.md'],
  html: ['*.html', '*.htm'],
  css: ['*.css', '*.scss', '*.less'],
  sql: ['*.sql'],
  sh: ['*.sh', '*.bash'],
  py: ['*.py'],
  go: ['*.go'],
  rs: ['*.rs'],
  properties: ['*.properties'],
  angular: ['*.ts', '*.html', '*.scss'],
};

/**
 * Directories to exclude from search
 */
const EXCLUDE_DIRS = [
  'node_modules',
  'target',
  'dist',
  'build',
  '.git',
  '.angular',
  '.idea',
  '.vscode',
  '__pycache__',
  '.m2',
  'coverage',
];

async function searchModules(
  ctx: IExecutionContext,
  pattern: string,
  moduleRefs: string[],
  options: SearchOptions
): Promise<void> {
  const modules = ctx.resolveModules(moduleRefs);
  const useRipgrep = await hasRipgrep();

  ctx.output.header('Search');
  ctx.output.keyValue('Pattern', pattern);
  ctx.output.keyValue('Modules', modules.length.toString());
  if (options.type) ctx.output.keyValue('Type', options.type);
  ctx.output.keyValue('Engine', useRipgrep ? 'ripgrep' : 'grep');
  ctx.output.newline();

  const results: ModuleSearchResult[] = [];
  let totalMatches = 0;
  let totalFiles = 0;

  for (const module of modules) {
    const spinner = ctx.output.spinner(`${module.name}: searching`);
    spinner.start();

    try {
      const moduleResult = await searchInModule(
        module.absolutePath,
        pattern,
        options,
        useRipgrep
      );

      if (moduleResult.matchCount > 0) {
        results.push({
          module: module.name,
          ...moduleResult,
        });
        totalMatches += moduleResult.matchCount;
        totalFiles += moduleResult.fileCount;
        spinner.succeed(`${module.name}: ${moduleResult.matchCount} matches in ${moduleResult.fileCount} files`);
      } else {
        spinner.info(`${module.name}: no matches`);
      }
    } catch (error) {
      spinner.warn(`${module.name}: search failed`);
    }
  }

  // Display results
  if (results.length === 0) {
    ctx.output.newline();
    ctx.output.warning('No matches found');
    return;
  }

  ctx.output.newline();

  if (options.count) {
    // Just show counts
    const rows = results.map((r) => [
      ctx.output.module(r.module),
      String(r.fileCount),
      String(r.matchCount),
    ]);

    ctx.output.table(rows, {
      head: ['Module', 'Files', 'Matches'],
    });
  } else if (options.filesOnly) {
    // Show file names grouped by module
    for (const result of results) {
      ctx.output.subheader(result.module);
      const uniqueFiles = [...new Set(result.matches.map((m) => m.file))];
      for (const file of uniqueFiles) {
        ctx.output.item(file);
      }
    }
  } else {
    // Show full results
    for (const result of results) {
      ctx.output.subheader(`${result.module} (${result.matchCount} matches)`);

      // Group by file
      const byFile: Record<string, SearchResult[]> = {};
      for (const match of result.matches) {
        if (!byFile[match.file]) byFile[match.file] = [];
        byFile[match.file].push(match);
      }

      for (const [file, matches] of Object.entries(byFile)) {
        console.log(colors.path(file));
        for (const match of matches.slice(0, 10)) {
          const lineNum = colors.muted(`${match.line}:`);
          const content = highlightMatch(match.content, pattern, options.ignoreCase);
          console.log(`  ${lineNum} ${content}`);
        }
        if (matches.length > 10) {
          console.log(colors.muted(`  ... and ${matches.length - 10} more matches`));
        }
      }
      ctx.output.newline();
    }
  }

  // Summary
  ctx.output.info(`Found ${totalMatches} matches in ${totalFiles} files across ${results.length} modules`);
}

async function searchInModule(
  modulePath: string,
  pattern: string,
  options: SearchOptions,
  useRipgrep: boolean
): Promise<{ matches: SearchResult[]; fileCount: number; matchCount: number }> {
  const matches: SearchResult[] = [];

  // Build command
  let cmd: string;

  if (useRipgrep) {
    cmd = buildRipgrepCommand(pattern, options);
  } else {
    cmd = buildGrepCommand(pattern, options);
  }

  try {
    const result = await exec(cmd, {
      cwd: modulePath,
      silent: true,
      timeout: 30000,
    });

    const output = result.stdout?.trim() || '';
    if (!output) {
      return { matches: [], fileCount: 0, matchCount: 0 };
    }

    // Parse results
    const lines = output.split('\n');
    const fileSet = new Set<string>();

    for (const line of lines) {
      // Format: file:line:content (ripgrep) or file:line:content (grep)
      const match = line.match(/^([^:]+):(\d+):(.*)$/);
      if (match) {
        const [, file, lineNum, content] = match;
        fileSet.add(file);
        matches.push({
          module: '',
          file,
          line: parseInt(lineNum, 10),
          content: content.trim(),
        });
      }
    }

    return {
      matches,
      fileCount: fileSet.size,
      matchCount: matches.length,
    };
  } catch {
    // No matches or error
    return { matches: [], fileCount: 0, matchCount: 0 };
  }
}

function buildRipgrepCommand(pattern: string, options: SearchOptions): string {
  const parts = ['rg', '--line-number', '--no-heading'];

  // Type filter
  if (options.type) {
    const globs = TYPE_GLOBS[options.type] ?? [`*.${options.type}`];
    for (const glob of globs) {
      parts.push(`--glob "${glob}"`);
    }
  }

  // Exclude directories
  for (const dir of EXCLUDE_DIRS) {
    parts.push(`--glob "!${dir}/**"`);
  }

  // Options
  if (options.ignoreCase) parts.push('-i');
  if (!options.regex) parts.push('-F');  // Fixed strings (literal)
  if (options.context && options.context !== '0') {
    parts.push(`-C ${options.context}`);
  }

  // Pattern
  parts.push(`"${pattern.replace(/"/g, '\\"')}"`);

  parts.push('2>/dev/null || true');

  return parts.join(' ');
}

function buildGrepCommand(pattern: string, options: SearchOptions): string {
  const parts = ['grep', '-rn'];

  // Options
  if (options.ignoreCase) parts.push('-i');
  if (!options.regex) parts.push('-F');
  if (options.context && options.context !== '0') {
    parts.push(`-C ${options.context}`);
  }

  // Exclude directories
  for (const dir of EXCLUDE_DIRS) {
    parts.push(`--exclude-dir="${dir}"`);
  }

  // Type filter (include patterns)
  if (options.type) {
    const globs = TYPE_GLOBS[options.type] ?? [`*.${options.type}`];
    for (const glob of globs) {
      parts.push(`--include="${glob}"`);
    }
  }

  // Pattern
  parts.push(`"${pattern.replace(/"/g, '\\"')}"`);
  parts.push('.');
  parts.push('2>/dev/null || true');

  return parts.join(' ');
}

function highlightMatch(content: string, pattern: string, ignoreCase?: boolean): string {
  try {
    const flags = ignoreCase ? 'gi' : 'g';
    const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedPattern})`, flags);
    return content.replace(regex, colors.highlight('$1'));
  } catch {
    return content;
  }
}
