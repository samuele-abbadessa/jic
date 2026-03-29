/**
 * GitLab API utilities for JIC CLI
 *
 * Handles merge request creation and listing via GitLab REST API v4.
 */

import { execa } from 'execa';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitlabError } from '../errors/index.js';
import type { IExecutionContext } from '../context/ExecutionContext.js';

// ============================================================================
// Types
// ============================================================================

export interface CreateMrOptions {
  baseUrl: string;
  projectPath: string;
  token: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  draft: boolean;
}

export interface MergeRequestResult {
  iid: number;
  web_url: string;
  title: string;
}

export interface ListMrOptions {
  baseUrl: string;
  projectPath: string;
  token: string;
  sourceBranch?: string;
}

export interface MergeRequestInfo {
  iid: number;
  title: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: { name: string };
}

export interface PrCreateOptions {
  target: string;
  title?: string;
  draft: boolean;
  sourceBranch?: string;
}

// ============================================================================
// Token Resolution
// ============================================================================

export async function getGitlabToken(projectRoot: string): Promise<string> {
  // Environment variable takes precedence
  if (process.env.GITLAB_TOKEN) {
    return process.env.GITLAB_TOKEN;
  }

  // Try jic.local.json
  try {
    const localPath = join(projectRoot, 'jic.local.json');
    const raw = await readFile(localPath, 'utf-8');
    const local = JSON.parse(raw) as Record<string, unknown>;
    const gitlab = local.gitlab as Record<string, unknown> | undefined;
    if (gitlab?.token && typeof gitlab.token === 'string') {
      return gitlab.token;
    }
  } catch {
    // File doesn't exist or parse error — fall through
  }

  throw new GitlabError(
    'No GitLab token configured. Set GITLAB_TOKEN env var or add gitlab.token to jic.local.json'
  );
}

// ============================================================================
// URL Parsing
// ============================================================================

export function extractGitlabBaseUrl(remoteUrl: string): string {
  // HTTPS: https://gitlab.x3solutions.it/group/repo.git
  const httpsMatch = remoteUrl.match(/^(https?:\/\/[^/]+)/);
  if (httpsMatch) {
    return httpsMatch[1];
  }

  // SSH: git@gitlab.x3solutions.it:group/repo.git
  const sshMatch = remoteUrl.match(/^git@([^:]+):/);
  if (sshMatch) {
    return `https://${sshMatch[1]}`;
  }

  throw new GitlabError(`Cannot parse GitLab base URL from: ${remoteUrl}`);
}

export function extractProjectPath(remoteUrl: string): string {
  // HTTPS: https://gitlab.x3solutions.it/group/subgroup/repo.git → group/subgroup/repo
  const httpsMatch = remoteUrl.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return encodeURIComponent(httpsMatch[1]);
  }

  // SSH: git@gitlab.x3solutions.it:group/subgroup/repo.git → group/subgroup/repo
  const sshMatch = remoteUrl.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return encodeURIComponent(sshMatch[1]);
  }

  throw new GitlabError(`Cannot parse project path from: ${remoteUrl}`);
}

// ============================================================================
// Git Helpers
// ============================================================================

export async function getModuleRemoteUrl(absolutePath: string): Promise<string> {
  const { stdout } = await execa('git', ['remote', 'get-url', 'origin'], { cwd: absolutePath });
  return stdout.trim();
}

export async function getCommitsAhead(
  absolutePath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<number> {
  try {
    const { stdout } = await execa(
      'git',
      ['rev-list', '--count', `${targetBranch}..${sourceBranch}`],
      { cwd: absolutePath }
    );
    return parseInt(stdout.trim(), 10);
  } catch {
    return 0;
  }
}

export async function getCurrentBranch(absolutePath: string): Promise<string> {
  const { stdout } = await execa('git', ['branch', '--show-current'], { cwd: absolutePath });
  return stdout.trim();
}

// ============================================================================
// GitLab API
// ============================================================================

export async function createMergeRequest(options: CreateMrOptions): Promise<MergeRequestResult> {
  const title = options.draft ? `Draft: ${options.title}` : options.title;

  const url = `${options.baseUrl}/api/v4/projects/${options.projectPath}/merge_requests`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': options.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_branch: options.sourceBranch,
      target_branch: options.targetBranch,
      title,
      remove_source_branch: false,
    }),
  });

  const body = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const errors = body.message ?? body.error ?? response.statusText;
    throw new GitlabError(
      `GitLab API error (${response.status}): ${JSON.stringify(errors)}`
    );
  }

  return {
    iid: body.iid as number,
    web_url: body.web_url as string,
    title: body.title as string,
  };
}

export async function listOpenMergeRequests(options: ListMrOptions): Promise<MergeRequestInfo[]> {
  let url = `${options.baseUrl}/api/v4/projects/${options.projectPath}/merge_requests?state=opened`;
  if (options.sourceBranch) {
    url += `&source_branch=${encodeURIComponent(options.sourceBranch)}`;
  }

  const response = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': options.token },
  });

  if (!response.ok) {
    const body = await response.json() as Record<string, unknown>;
    const errors = body.message ?? body.error ?? response.statusText;
    throw new GitlabError(
      `GitLab API error (${response.status}): ${JSON.stringify(errors)}`
    );
  }

  return await response.json() as MergeRequestInfo[];
}

// ============================================================================
// High-level Operations
// ============================================================================

export async function createMergeRequestsForModules(
  ctx: IExecutionContext,
  options: PrCreateOptions
): Promise<void> {
  const vendorName = ctx.activeVendor;
  if (!vendorName) {
    throw new GitlabError('No active vendor. Use "jic vendor checkout <name>" first.');
  }

  const vendorConfig = ctx.vendorConfig;
  if (!vendorConfig) {
    throw new GitlabError(`Vendor config not loaded for "${vendorName}"`);
  }

  const token = await getGitlabToken(ctx.projectRoot);
  const sourceBranch = options.sourceBranch ?? vendorConfig.branches.dev;
  const targetBranch = options.target;
  const defaultTitle = options.title ?? `Merge ${sourceBranch} into ${targetBranch}`;

  ctx.output.info(`Creating merge requests: ${sourceBranch} → ${targetBranch}`);
  ctx.output.newline();

  const results: Array<{ module: string; status: string; url?: string }> = [];

  for (const modName of vendorConfig.modules) {
    const mod = ctx.config.resolvedModules[modName];
    if (!mod) continue;

    try {
      // Check if source branch has commits ahead of target
      const ahead = await getCommitsAhead(mod.absolutePath, sourceBranch, targetBranch);

      if (ahead === 0) {
        ctx.output.log(`  ${modName}: already aligned, skipping`);
        results.push({ module: modName, status: 'skipped' });
        continue;
      }

      if (ctx.dryRun) {
        ctx.output.log(`  ${modName}: [dry-run] would create MR (+${ahead} commits)`);
        results.push({ module: modName, status: 'dry-run' });
        continue;
      }

      const remoteUrl = await getModuleRemoteUrl(mod.absolutePath);
      const baseUrl = extractGitlabBaseUrl(remoteUrl);
      const projectPath = extractProjectPath(remoteUrl);

      const mr = await createMergeRequest({
        baseUrl,
        projectPath,
        token,
        sourceBranch,
        targetBranch,
        title: defaultTitle,
        draft: options.draft,
      });

      ctx.output.success(`  ${modName}: MR !${mr.iid} created (+${ahead} commits)`);
      ctx.output.log(`    ${mr.web_url}`);
      results.push({ module: modName, status: 'created', url: mr.web_url });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If MR already exists, it's not a failure
      if (msg.includes('already exists')) {
        ctx.output.warn(`  ${modName}: MR already exists`);
        results.push({ module: modName, status: 'exists' });
      } else {
        ctx.output.error(`  ${modName}: ${msg}`);
        results.push({ module: modName, status: 'error' });
      }
    }
  }

  ctx.output.newline();
  const created = results.filter((r) => r.status === 'created').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const errors = results.filter((r) => r.status === 'error').length;
  ctx.output.info(`Done: ${created} created, ${skipped} skipped, ${errors} errors`);
}

export async function listMergeRequestsForModules(ctx: IExecutionContext): Promise<void> {
  const vendorName = ctx.activeVendor;
  if (!vendorName) {
    throw new GitlabError('No active vendor. Use "jic vendor checkout <name>" first.');
  }

  const vendorConfig = ctx.vendorConfig;
  if (!vendorConfig) {
    throw new GitlabError(`Vendor config not loaded for "${vendorName}"`);
  }

  const token = await getGitlabToken(ctx.projectRoot);
  const sourceBranch = vendorConfig.branches.dev;

  ctx.output.info(`Open merge requests for vendor "${vendorName}" (${sourceBranch})`);
  ctx.output.newline();

  let totalMrs = 0;

  for (const modName of vendorConfig.modules) {
    const mod = ctx.config.resolvedModules[modName];
    if (!mod) continue;

    try {
      const remoteUrl = await getModuleRemoteUrl(mod.absolutePath);
      const baseUrl = extractGitlabBaseUrl(remoteUrl);
      const projectPath = extractProjectPath(remoteUrl);

      const mrs = await listOpenMergeRequests({
        baseUrl,
        projectPath,
        token,
        sourceBranch,
      });

      if (mrs.length > 0) {
        ctx.output.log(`  ${modName}:`);
        for (const mr of mrs) {
          ctx.output.log(`    !${mr.iid} ${mr.title} (${mr.source_branch} → ${mr.target_branch})`);
          ctx.output.log(`      ${mr.web_url}`);
          totalMrs++;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.output.warn(`  ${modName}: ${msg}`);
    }
  }

  ctx.output.newline();
  if (totalMrs === 0) {
    ctx.output.info('No open merge requests found.');
  } else {
    ctx.output.info(`Total: ${totalMrs} open merge request(s)`);
  }
}
