/**
 * JIC CLI - Multi-module project management CLI
 *
 * A comprehensive CLI tool for managing multi-module microservices projects.
 * Handles git operations, builds, deployments, and AWS resource management.
 *
 * Version 2.0 - TypeScript rewrite with:
 * - Configuration inheritance
 * - Unified command patterns
 * - Enhanced session management
 * - Robust process management
 */

import { Command } from 'commander';
import { createProgram, getGlobalOptions } from './cli.js';
import { loadConfig, createContext, handleError, Output, colors } from './core/index.js';
import type { IExecutionContext } from './core/context/ExecutionContext.js';
import {
  registerBuildCommand,
  registerGitCommand,
  registerDeployCommand,
  registerServeCommand,
  registerSessionCommand,
  registerAwsCommand,
  registerCleanCommand,
  registerSearchCommand,
  registerKubernetesCommand,
  registerVendorCommand,
} from './commands/index.js';
import { registerDashboardCommand } from './dashboard/index.js';

const VERSION = '2.0.0-alpha.1';

// ============================================================================
// Shell Completion Generators
// ============================================================================

/**
 * Extract commands and options from Commander program
 */
function extractCommands(cmd: Command, prefix = ''): { commands: string[]; options: string[] } {
  const commands: string[] = [];
  const options: string[] = [];

  // Get this command's options
  cmd.options.forEach((opt) => {
    if (opt.long) options.push(opt.long);
    if (opt.short) options.push(opt.short);
  });

  // Get subcommands
  cmd.commands.forEach((sub) => {
    const name = prefix ? `${prefix} ${sub.name()}` : sub.name();
    commands.push(name);
    const subResults = extractCommands(sub, name);
    commands.push(...subResults.commands);
  });

  return { commands, options };
}

/**
 * Generate bash completion script
 */
function generateBashCompletion(program: Command): string {
  const { commands } = extractCommands(program);
  const topLevel = [...new Set(commands.map(c => c.split(' ')[0]))];

  return `# Bash completion for jic
# Add to ~/.bashrc: eval "$(jic completion bash)"

_jic_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # Top-level commands
  local commands="${topLevel.join(' ')}"

  # Subcommands
  case "\${COMP_WORDS[1]}" in
    git)
      local git_cmds="status checkout search branch fetch pull push foreach"
      COMPREPLY=($(compgen -W "\${git_cmds}" -- "\${cur}"))
      return
      ;;
    aws)
      local aws_cmds="logs ecs ecr lambda whoami"
      COMPREPLY=($(compgen -W "\${aws_cmds}" -- "\${cur}"))
      return
      ;;
    k8s)
      local k8s_cmds="status logs restart scale pods refresh apply"
      COMPREPLY=($(compgen -W "\${k8s_cmds}" -- "\${cur}"))
      return
      ;;
    deploy)
      local deploy_cmds="run status"
      COMPREPLY=($(compgen -W "\${deploy_cmds}" -- "\${cur}"))
      return
      ;;
    build)
      local build_cmds="java frontend flux all"
      COMPREPLY=($(compgen -W "\${build_cmds}" -- "\${cur}"))
      return
      ;;
    session)
      local session_cmds="start list checkout status end merge"
      COMPREPLY=($(compgen -W "\${session_cmds}" -- "\${cur}"))
      return
      ;;
    serve)
      local serve_cmds="start stop status logs infra"
      COMPREPLY=($(compgen -W "\${serve_cmds}" -- "\${cur}"))
      return
      ;;
    completion)
      local completion_cmds="bash zsh fish install"
      COMPREPLY=($(compgen -W "\${completion_cmds}" -- "\${cur}"))
      return
      ;;
  esac

  # Module aliases for relevant commands
  case "\${prev}" in
    status|checkout|build|deploy|serve)
      local modules="@all @backend @frontend @flux @lambda gwc gws tms tas tns tmf taf"
      COMPREPLY=($(compgen -W "\${modules}" -- "\${cur}"))
      return
      ;;
  esac

  # Environment option
  case "\${prev}" in
    -e|--env)
      COMPREPLY=($(compgen -W "dev staging prod" -- "\${cur}"))
      return
      ;;
  esac

  # Default to commands
  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
  fi
}

complete -F _jic_completions jic
`;
}

/**
 * Generate zsh completion script
 */
function generateZshCompletion(_program: Command): string {
  return `#compdef jic
# Zsh completion for jic
# Add to ~/.zshrc: eval "$(jic completion zsh)"

_jic() {
  local -a commands
  local -a modules
  local -a environments

  commands=(
    'git:Git operations across submodules'
    'aws:AWS operations'
    'k8s:Kubernetes operations'
    'deploy:Deployment operations'
    'build:Build modules'
    'session:Session management'
    'serve:Start/stop services'
    'status:Show project status'
    'version:Show version'
    'completion:Generate shell completions'
  )

  modules=(
    '@all:All modules'
    '@backend:Backend services'
    '@frontend:Frontend'
    '@flux:Flux clients'
    '@lambda:Lambda functions'
    'gwc:Gateway client (frontend)'
    'gws:Gateway server'
    'tms:Tenant main service'
    'tas:Tenant agenda'
    'tns:Notification service'
  )

  environments=(
    'dev:Development environment'
    'staging:Staging environment'
    'prod:Production environment'
  )

  _arguments -C \\
    '1: :->command' \\
    '*:: :->args' && return 0

  case $state in
    command)
      _describe -t commands 'jic command' commands
      ;;
    args)
      case $words[1] in
        git)
          local -a git_cmds
          git_cmds=(
            'status:Show git status'
            'checkout:Checkout branch'
            'fetch:Fetch from remotes'
            'pull:Pull changes'
            'push:Push changes'
            'foreach:Run command in modules'
          )
          _describe -t git-commands 'git command' git_cmds
          ;;
        aws)
          local -a aws_cmds
          aws_cmds=(
            'logs:CloudWatch logs'
            'ecs:ECS operations'
            'ecr:ECR operations'
            'lambda:Lambda operations'
            'whoami:Show AWS identity'
          )
          _describe -t aws-commands 'aws command' aws_cmds
          ;;
        k8s)
          local -a k8s_cmds
          k8s_cmds=(
            'status:Show deployment status'
            'logs:View pod logs'
            'restart:Restart deployment'
            'scale:Scale deployment'
            'pods:List pods'
            'refresh:Sync local state'
            'apply:Apply manifests to cluster'
          )
          _describe -t k8s-commands 'k8s command' k8s_cmds
          ;;
        deploy)
          local -a deploy_cmds
          deploy_cmds=(
            'run:Deploy modules'
            'status:Show deploy status'
          )
          _describe -t deploy-commands 'deploy command' deploy_cmds
          ;;
        session)
          local -a session_cmds
          session_cmds=(
            'start:Start new session'
            'list:List sessions'
            'checkout:Checkout session'
            'status:Show session status'
            'end:End session'
          )
          _describe -t session-commands 'session command' session_cmds
          ;;
        serve)
          local -a serve_cmds
          serve_cmds=(
            'start:Start services'
            'stop:Stop services'
            'status:Show service status'
            'logs:View service logs'
            'infra:Infrastructure operations'
          )
          _describe -t serve-commands 'serve command' serve_cmds
          ;;
        completion)
          local -a completion_cmds
          completion_cmds=(
            'bash:Generate bash completion'
            'zsh:Generate zsh completion'
            'fish:Generate fish completion'
            'install:Installation instructions'
          )
          _describe -t completion-commands 'shell' completion_cmds
          ;;
        *)
          _describe -t modules 'module' modules
          ;;
      esac
      ;;
  esac
}

_jic "$@"
`;
}

/**
 * Generate fish completion script
 */
function generateFishCompletion(_program: Command): string {
  return `# Fish completion for jic
# Save to ~/.config/fish/completions/jic.fish

# Disable file completion
complete -c jic -f

# Top-level commands
complete -c jic -n "__fish_use_subcommand" -a "git" -d "Git operations"
complete -c jic -n "__fish_use_subcommand" -a "aws" -d "AWS operations"
complete -c jic -n "__fish_use_subcommand" -a "k8s" -d "Kubernetes operations"
complete -c jic -n "__fish_use_subcommand" -a "deploy" -d "Deployment"
complete -c jic -n "__fish_use_subcommand" -a "build" -d "Build modules"
complete -c jic -n "__fish_use_subcommand" -a "session" -d "Session management"
complete -c jic -n "__fish_use_subcommand" -a "serve" -d "Start/stop services"
complete -c jic -n "__fish_use_subcommand" -a "status" -d "Show status"
complete -c jic -n "__fish_use_subcommand" -a "version" -d "Show version"
complete -c jic -n "__fish_use_subcommand" -a "completion" -d "Shell completions"

# Git subcommands
complete -c jic -n "__fish_seen_subcommand_from git" -a "status" -d "Show git status"
complete -c jic -n "__fish_seen_subcommand_from git" -a "checkout" -d "Checkout branch"
complete -c jic -n "__fish_seen_subcommand_from git" -a "fetch" -d "Fetch from remotes"
complete -c jic -n "__fish_seen_subcommand_from git" -a "pull" -d "Pull changes"
complete -c jic -n "__fish_seen_subcommand_from git" -a "push" -d "Push changes"
complete -c jic -n "__fish_seen_subcommand_from git" -a "foreach" -d "Run in modules"

# AWS subcommands
complete -c jic -n "__fish_seen_subcommand_from aws" -a "logs" -d "CloudWatch logs"
complete -c jic -n "__fish_seen_subcommand_from aws" -a "ecs" -d "ECS operations"
complete -c jic -n "__fish_seen_subcommand_from aws" -a "ecr" -d "ECR operations"
complete -c jic -n "__fish_seen_subcommand_from aws" -a "lambda" -d "Lambda operations"
complete -c jic -n "__fish_seen_subcommand_from aws" -a "whoami" -d "Show identity"

# K8s subcommands
complete -c jic -n "__fish_seen_subcommand_from k8s" -a "status" -d "Deployment status"
complete -c jic -n "__fish_seen_subcommand_from k8s" -a "logs" -d "View pod logs"
complete -c jic -n "__fish_seen_subcommand_from k8s" -a "restart" -d "Restart deployment"
complete -c jic -n "__fish_seen_subcommand_from k8s" -a "scale" -d "Scale deployment"
complete -c jic -n "__fish_seen_subcommand_from k8s" -a "pods" -d "List pods"
complete -c jic -n "__fish_seen_subcommand_from k8s" -a "refresh" -d "Sync local state"
complete -c jic -n "__fish_seen_subcommand_from k8s" -a "apply" -d "Apply manifests"

# Deploy subcommands
complete -c jic -n "__fish_seen_subcommand_from deploy" -a "run" -d "Deploy modules"
complete -c jic -n "__fish_seen_subcommand_from deploy" -a "status" -d "Show status"

# Session subcommands
complete -c jic -n "__fish_seen_subcommand_from session" -a "start" -d "Start session"
complete -c jic -n "__fish_seen_subcommand_from session" -a "list" -d "List sessions"
complete -c jic -n "__fish_seen_subcommand_from session" -a "checkout" -d "Checkout session"
complete -c jic -n "__fish_seen_subcommand_from session" -a "status" -d "Show status"
complete -c jic -n "__fish_seen_subcommand_from session" -a "end" -d "End session"

# Serve subcommands
complete -c jic -n "__fish_seen_subcommand_from serve" -a "start" -d "Start services"
complete -c jic -n "__fish_seen_subcommand_from serve" -a "stop" -d "Stop services"
complete -c jic -n "__fish_seen_subcommand_from serve" -a "status" -d "Show status"
complete -c jic -n "__fish_seen_subcommand_from serve" -a "logs" -d "View logs"
complete -c jic -n "__fish_seen_subcommand_from serve" -a "infra" -d "Infrastructure"

# Completion subcommands
complete -c jic -n "__fish_seen_subcommand_from completion" -a "bash" -d "Bash script"
complete -c jic -n "__fish_seen_subcommand_from completion" -a "zsh" -d "Zsh script"
complete -c jic -n "__fish_seen_subcommand_from completion" -a "fish" -d "Fish script"
complete -c jic -n "__fish_seen_subcommand_from completion" -a "install" -d "Install instructions"

# Module completions
set -l modules "@all" "@backend" "@frontend" "@flux" "@lambda" "gwc" "gws" "tms" "tas" "tns" "tmf" "taf"
complete -c jic -n "__fish_seen_subcommand_from build deploy serve git" -a "$modules"

# Environment option
complete -c jic -l env -s e -x -a "dev staging prod" -d "Environment"

# Global options
complete -c jic -l dry-run -d "Preview without executing"
complete -c jic -l verbose -s V -d "Detailed output"
complete -c jic -l quiet -s q -d "Minimal output"
complete -c jic -l json -d "JSON output"
complete -c jic -l yes -s y -d "Skip confirmations"
complete -c jic -l help -s h -d "Show help"
`;
}

/**
 * Create execution context factory
 * This is passed to commands so they can lazily create the context
 */
function createContextFactory(program: ReturnType<typeof createProgram>): () => Promise<IExecutionContext> {
  return async () => {
    const options = getGlobalOptions(program);
    const config = await loadConfig({ configPath: options.config });
    return createContext(config, options);
  };
}

async function main(): Promise<void> {
  try {
    // Create CLI program
    const program = createProgram(VERSION);

    // Create context factory for commands
    const createCtx = createContextFactory(program);

    // Register commands
    registerBuildCommand(program, createCtx);
    registerGitCommand(program, createCtx);
    registerDeployCommand(program, createCtx);
    registerServeCommand(program, createCtx);
    registerSessionCommand(program, createCtx);
    registerAwsCommand(program, createCtx);
    registerCleanCommand(program, createCtx);
    registerSearchCommand(program, createCtx);
    registerKubernetesCommand(program, createCtx);
    registerVendorCommand(program, createCtx);
    registerDashboardCommand(program, createCtx);

    // Add status command
    program
      .command('status')
      .description('Show project status')
      .action(async () => {
        const ctx = await createCtx();

        ctx.output.header('JIC CLI v2.0');
        ctx.output.keyValue('Project', ctx.config.project.name || 'Not configured');
        ctx.output.keyValue('Root', ctx.projectRoot);
        ctx.output.keyValue('Environment', ctx.env);
        ctx.output.keyValue('Modules', String(Object.keys(ctx.config.resolvedModules).length));
        ctx.output.newline();

        if (ctx.activeSession) {
          ctx.output.info(`Active session: ${ctx.activeSession.name}`);
        }

        if (Object.keys(ctx.config.resolvedModules).length > 0) {
          ctx.output.subheader('Modules');

          const rows: string[][] = Object.values(ctx.config.resolvedModules).map((m) => [
            m.name,
            m.type,
            m.aliases?.join(', ') || '-',
            m.resolvedBuild ? 'Yes' : '-',
            m.resolvedServe ? 'Yes' : '-',
          ]);

          ctx.output.table(rows, {
            head: ['Name', 'Type', 'Aliases', 'Build', 'Serve'],
          });
        }
      });

    // Add version command
    program
      .command('version')
      .description('Show version information')
      .action(() => {
        const output = new Output();
        output.log(`jic version ${VERSION}`);
        output.log(colors.muted('TypeScript rewrite - alpha'));
      });

    // Add completion command for shell autocompletion
    const completion = program.command('completion').description('Generate shell completion scripts');

    completion
      .command('bash')
      .description('Generate bash completion script')
      .action(() => {
        console.log(generateBashCompletion(program));
      });

    completion
      .command('zsh')
      .description('Generate zsh completion script')
      .action(() => {
        console.log(generateZshCompletion(program));
      });

    completion
      .command('fish')
      .description('Generate fish completion script')
      .action(() => {
        console.log(generateFishCompletion(program));
      });

    completion
      .command('install')
      .description('Install completion script for current shell')
      .action(async () => {
        const output = new Output();
        const shell = process.env.SHELL?.split('/').pop() ?? 'bash';

        output.header('Installing Shell Completion');
        output.keyValue('Detected Shell', shell);
        output.newline();

        if (shell === 'bash') {
          output.log('Add to your ~/.bashrc:');
          output.log(colors.primary('  eval "$(jic completion bash)"'));
          output.newline();
          output.log('Or create a completion file:');
          output.log(colors.primary('  jic completion bash > ~/.local/share/bash-completion/completions/jic'));
        } else if (shell === 'zsh') {
          output.log('Add to your ~/.zshrc:');
          output.log(colors.primary('  eval "$(jic completion zsh)"'));
          output.newline();
          output.log('Or if using oh-my-zsh:');
          output.log(colors.primary('  jic completion zsh > ~/.oh-my-zsh/completions/_jic'));
        } else if (shell === 'fish') {
          output.log('Create a completion file:');
          output.log(colors.primary('  jic completion fish > ~/.config/fish/completions/jic.fish'));
        } else {
          output.warning(`Unknown shell: ${shell}`);
          output.log('Try: jic completion bash|zsh|fish');
        }
      });

    // Parse arguments
    await program.parseAsync(process.argv);

    // Show help if no command provided
    if (process.argv.length <= 2) {
      program.help();
    }
  } catch (error) {
    handleError(error, {
      verbose: process.env.JIC_VERBOSE === 'true',
      json: process.argv.includes('--json'),
    });
  }
}

main();
