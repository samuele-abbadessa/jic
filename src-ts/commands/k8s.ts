/**
 * Kubernetes Command
 *
 * Kubernetes operations for deployments, pods, logs, and scaling.
 *
 * Examples:
 *   jic k8s status                # Show deployment status
 *   jic k8s logs was -f           # Tail logs for a service
 *   jic k8s restart was           # Restart a deployment
 *   jic k8s scale was 2           # Scale to 2 replicas
 *   jic k8s pods                  # List pods
 *   jic k8s refresh               # Sync local state with K8s
 */

import type { Command } from 'commander';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type { DeploymentRecord } from '../core/types/state.js';
import { KubernetesError, withErrorHandling } from '../core/errors/index.js';
import { exec, getGitCommit } from '../core/utils/shell.js';
import { colors } from '../core/utils/output.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the base kubectl command with kubeconfig and context flags
 */
function buildKubectlBase(ctx: IExecutionContext): string {
  const k8sConfig = ctx.getK8sConfig();
  const kubeconfigFlag = k8sConfig.kubeconfig ? `--kubeconfig ${k8sConfig.kubeconfig}` : '';
  const contextFlag = k8sConfig.context ? `--context ${k8sConfig.context}` : '';
  return `kubectl ${kubeconfigFlag} ${contextFlag}`.trim();
}

/**
 * Get K8s deploy config for a module, throwing if not found
 */
function getK8sDeployConfig(ctx: IExecutionContext, serviceRef: string) {
  const module = ctx.getModule(serviceRef);
  if (!module) {
    throw new KubernetesError(`Service '${serviceRef}' not found`);
  }

  const deployConfig = module.resolvedDeploy?.[ctx.env];
  if (!deployConfig || deployConfig.type !== 'kubernetes') {
    throw new KubernetesError(`No Kubernetes config for ${module.name} in ${ctx.env}`);
  }

  const k8sConfig = ctx.getK8sConfig();
  const namespace = deployConfig.namespace ?? k8sConfig.namespace ?? 'default';

  return { module, deployConfig, namespace };
}

// ============================================================================
// Kubernetes Command Registration
// ============================================================================

export function registerKubernetesCommand(
  program: Command,
  createContext: () => Promise<IExecutionContext>
): void {
  const k8s = program.command('k8s').description('Kubernetes operations');

  // Status command
  k8s
    .command('status')
    .description('Show Kubernetes deployment status')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await k8sStatus(ctx);
      })
    );

  // Logs command
  k8s
    .command('logs <service>')
    .description('Tail logs for a Kubernetes service')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines to show', '100')
    .option('--since <time>', 'Show logs since (e.g., 1h, 30m, 2d)')
    .action(
      withErrorHandling(
        async (
          service: string,
          options: { follow?: boolean; lines?: string; since?: string }
        ) => {
          const ctx = await createContext();
          await k8sLogs(ctx, service, options);
        }
      )
    );

  // Restart command
  k8s
    .command('restart <service>')
    .description('Restart a Kubernetes deployment')
    .option('--wait', 'Wait for rollout to complete')
    .action(
      withErrorHandling(async (service: string, options: { wait?: boolean }) => {
        const ctx = await createContext();
        await k8sRestart(ctx, service, options);
      })
    );

  // Scale command
  k8s
    .command('scale <service> <count>')
    .description('Scale deployment to desired count')
    .action(
      withErrorHandling(async (service: string, count: string) => {
        const ctx = await createContext();
        await k8sScale(ctx, service, parseInt(count, 10));
      })
    );

  // Pods command
  k8s
    .command('pods [service]')
    .description('List pods')
    .action(
      withErrorHandling(async (service?: string) => {
        const ctx = await createContext();
        await k8sPods(ctx, service);
      })
    );

  // Refresh command
  k8s
    .command('refresh')
    .description('Sync local state with current Kubernetes deployment status')
    .action(
      withErrorHandling(async () => {
        const ctx = await createContext();
        await k8sRefresh(ctx);
      })
    );
}

// ============================================================================
// Kubernetes Status
// ============================================================================

async function k8sStatus(ctx: IExecutionContext): Promise<void> {
  const env = ctx.env;
  const kubectlBase = buildKubectlBase(ctx);

  ctx.output.header(`Kubernetes Status: ${env}`);
  ctx.output.newline();

  const spinner = ctx.output.spinner('Fetching deployment status');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would fetch K8s status');
      return;
    }

    // Get all K8s modules for this environment
    const k8sModules = Object.values(ctx.config.resolvedModules).filter(
      (m) => m.resolvedDeploy?.[env]?.type === 'kubernetes'
    );

    if (k8sModules.length === 0) {
      spinner.info('No Kubernetes modules configured');
      return;
    }

    // Collect unique namespaces
    const namespaces = new Set<string>();
    const k8sConfig = ctx.getK8sConfig();
    for (const module of k8sModules) {
      const deployConfig = module.resolvedDeploy?.[env];
      if (deployConfig?.type === 'kubernetes') {
        namespaces.add(deployConfig.namespace ?? k8sConfig.namespace ?? 'default');
      }
    }

    const rows: string[][] = [];

    for (const ns of namespaces) {
      const result = await exec(
        `${kubectlBase} -n ${ns} get deployments -o json`,
        { silent: true }
      );

      const parsed = JSON.parse(result.stdout || '{}');
      const deployments = (parsed.items ?? []) as Array<{
        metadata: { name: string; namespace: string };
        status: {
          readyReplicas?: number;
          replicas?: number;
          availableReplicas?: number;
        };
        spec: { replicas: number };
      }>;

      for (const deploy of deployments) {
        const ready = deploy.status.readyReplicas ?? 0;
        const desired = deploy.spec.replicas ?? 0;
        const healthy = ready === desired && desired > 0;

        let status: string;
        if (desired === 0) {
          status = colors.muted('scaled to 0');
        } else if (healthy) {
          status = colors.success('healthy');
        } else {
          status = colors.error(`${ready}/${desired} ready`);
        }

        rows.push([
          deploy.metadata.namespace,
          deploy.metadata.name,
          `${ready}/${desired}`,
          status,
        ]);
      }
    }

    spinner.succeed('Deployment status retrieved');
    ctx.output.newline();

    if (rows.length === 0) {
      ctx.output.info('No deployments found');
      return;
    }

    ctx.output.table(rows, {
      head: ['Namespace', 'Deployment', 'Ready', 'Status'],
    });
  } catch (error) {
    spinner.fail('Failed to fetch status');
    throw new KubernetesError(`Failed to get K8s status: ${error}`);
  }
}

// ============================================================================
// Kubernetes Logs
// ============================================================================

async function k8sLogs(
  ctx: IExecutionContext,
  serviceRef: string,
  options: { follow?: boolean; lines?: string; since?: string }
): Promise<void> {
  const { module, deployConfig, namespace } = getK8sDeployConfig(ctx, serviceRef);
  const kubectlBase = buildKubectlBase(ctx);

  ctx.output.header(`Logs: ${module.name}`);
  ctx.output.keyValue('Environment', ctx.env);
  ctx.output.keyValue('Namespace', namespace);
  ctx.output.keyValue('Deployment', deployConfig.deployment);
  ctx.output.newline();

  const lines = options.lines ?? '100';
  let cmd = `${kubectlBase} -n ${namespace} logs deployment/${deployConfig.deployment} --tail=${lines}`;

  if (options.follow) {
    cmd += ' -f';
  }

  if (options.since) {
    cmd += ` --since=${options.since}`;
  }

  if (ctx.dryRun) {
    ctx.output.info(`[dry-run] Would run: ${cmd}`);
    return;
  }

  ctx.output.info('Streaming logs... (Ctrl+C to stop)\n');

  try {
    await exec(cmd, { silent: false, timeout: 0 });
  } catch (error) {
    if (error instanceof Error && error.message.includes('SIGINT')) {
      return;
    }
    throw new KubernetesError(`Failed to tail logs: ${error}`);
  }
}

// ============================================================================
// Kubernetes Restart
// ============================================================================

async function k8sRestart(
  ctx: IExecutionContext,
  serviceRef: string,
  options: { wait?: boolean }
): Promise<void> {
  const { module, deployConfig, namespace } = getK8sDeployConfig(ctx, serviceRef);
  const kubectlBase = buildKubectlBase(ctx);

  ctx.output.header(`Restart: ${module.name}`);

  const spinner = ctx.output.spinner('Restarting deployment');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would restart deployment');
      return;
    }

    await exec(
      `${kubectlBase} -n ${namespace} rollout restart deployment/${deployConfig.deployment}`,
      { silent: true }
    );

    spinner.succeed('Rollout restart triggered');

    if (options.wait) {
      const waitSpinner = ctx.output.spinner('Waiting for rollout to complete');
      waitSpinner.start();

      await exec(
        `${kubectlBase} -n ${namespace} rollout status deployment/${deployConfig.deployment} --timeout=600s`,
        { silent: true, timeout: 660000 }
      );

      waitSpinner.succeed('Rollout complete');
    }
  } catch (error) {
    spinner.fail('Failed to restart deployment');
    throw new KubernetesError(`Failed to restart: ${error}`);
  }
}

// ============================================================================
// Kubernetes Scale
// ============================================================================

async function k8sScale(
  ctx: IExecutionContext,
  serviceRef: string,
  count: number
): Promise<void> {
  const { module, deployConfig, namespace } = getK8sDeployConfig(ctx, serviceRef);
  const kubectlBase = buildKubectlBase(ctx);

  ctx.output.header(`Scale: ${module.name}`);

  const spinner = ctx.output.spinner(`Scaling to ${count} replicas`);
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info(`[dry-run] Would scale to ${count}`);
      return;
    }

    await exec(
      `${kubectlBase} -n ${namespace} scale deployment/${deployConfig.deployment} --replicas=${count}`,
      { silent: true }
    );

    spinner.succeed(`Scaled to ${count} replicas`);
  } catch (error) {
    spinner.fail('Failed to scale deployment');
    throw new KubernetesError(`Failed to scale: ${error}`);
  }
}

// ============================================================================
// Kubernetes Pods
// ============================================================================

async function k8sPods(
  ctx: IExecutionContext,
  serviceRef?: string
): Promise<void> {
  const kubectlBase = buildKubectlBase(ctx);
  const env = ctx.env;

  ctx.output.header(`Pods: ${env}`);

  const spinner = ctx.output.spinner('Fetching pods');
  spinner.start();

  try {
    if (ctx.dryRun) {
      spinner.info('[dry-run] Would list pods');
      return;
    }

    let cmd: string;

    if (serviceRef) {
      const { deployConfig, namespace } = getK8sDeployConfig(ctx, serviceRef);
      cmd = `${kubectlBase} -n ${namespace} get pods -l app=${deployConfig.deployment} -o json`;
    } else {
      // Get pods from all K8s namespaces for configured modules
      const k8sModules = Object.values(ctx.config.resolvedModules).filter(
        (m) => m.resolvedDeploy?.[env]?.type === 'kubernetes'
      );

      const k8sConfig = ctx.getK8sConfig();
      const namespaces = new Set<string>();
      for (const module of k8sModules) {
        const deployConfig = module.resolvedDeploy?.[env];
        if (deployConfig?.type === 'kubernetes') {
          namespaces.add(deployConfig.namespace ?? k8sConfig.namespace ?? 'default');
        }
      }

      if (namespaces.size === 0) {
        spinner.info('No Kubernetes modules configured');
        return;
      }

      // Fetch pods from all relevant namespaces
      const allPods: Array<{
        name: string;
        namespace: string;
        status: string;
        ready: string;
        restarts: number;
        age: string;
      }> = [];

      for (const ns of namespaces) {
        const result = await exec(
          `${kubectlBase} -n ${ns} get pods -o json`,
          { silent: true }
        );

        const parsed = JSON.parse(result.stdout || '{}');
        const pods = (parsed.items ?? []) as Array<{
          metadata: { name: string; namespace: string; creationTimestamp: string };
          status: {
            phase: string;
            containerStatuses?: Array<{
              ready: boolean;
              restartCount: number;
            }>;
          };
        }>;

        for (const pod of pods) {
          const containers = pod.status.containerStatuses ?? [];
          const readyCount = containers.filter((c) => c.ready).length;
          const totalCount = containers.length;
          const restarts = containers.reduce((sum, c) => sum + c.restartCount, 0);

          // Calculate age
          const created = new Date(pod.metadata.creationTimestamp);
          const ageMs = Date.now() - created.getTime();
          const ageHours = Math.floor(ageMs / 3600000);
          const ageDays = Math.floor(ageHours / 24);
          const age = ageDays > 0 ? `${ageDays}d` : `${ageHours}h`;

          allPods.push({
            name: pod.metadata.name,
            namespace: pod.metadata.namespace,
            status: pod.status.phase,
            ready: `${readyCount}/${totalCount}`,
            restarts,
            age,
          });
        }
      }

      spinner.succeed('Pods retrieved');
      ctx.output.newline();

      if (allPods.length === 0) {
        ctx.output.info('No pods found');
        return;
      }

      const rows = allPods.map((p) => [
        p.namespace,
        p.name,
        p.ready,
        p.status === 'Running' ? colors.success(p.status) : colors.warning(p.status),
        String(p.restarts),
        p.age,
      ]);

      ctx.output.table(rows, {
        head: ['Namespace', 'Name', 'Ready', 'Status', 'Restarts', 'Age'],
      });
      return;
    }

    // Single service mode
    const result = await exec(cmd, { silent: true });
    const parsed = JSON.parse(result.stdout || '{}');
    const pods = (parsed.items ?? []) as Array<{
      metadata: { name: string; namespace: string; creationTimestamp: string };
      status: {
        phase: string;
        containerStatuses?: Array<{
          ready: boolean;
          restartCount: number;
        }>;
      };
    }>;

    spinner.succeed('Pods retrieved');
    ctx.output.newline();

    if (pods.length === 0) {
      ctx.output.info('No pods found');
      return;
    }

    const rows = pods.map((pod) => {
      const containers = pod.status.containerStatuses ?? [];
      const readyCount = containers.filter((c) => c.ready).length;
      const totalCount = containers.length;
      const restarts = containers.reduce((sum, c) => sum + c.restartCount, 0);

      const created = new Date(pod.metadata.creationTimestamp);
      const ageMs = Date.now() - created.getTime();
      const ageHours = Math.floor(ageMs / 3600000);
      const ageDays = Math.floor(ageHours / 24);
      const age = ageDays > 0 ? `${ageDays}d` : `${ageHours}h`;

      return [
        pod.metadata.name,
        `${readyCount}/${totalCount}`,
        pod.status.phase === 'Running' ? colors.success(pod.status.phase) : colors.warning(pod.status.phase),
        String(restarts),
        age,
      ];
    });

    ctx.output.table(rows, {
      head: ['Name', 'Ready', 'Status', 'Restarts', 'Age'],
    });
  } catch (error) {
    spinner.fail('Failed to list pods');
    throw new KubernetesError(`Failed to list pods: ${error}`);
  }
}

// ============================================================================
// Kubernetes Refresh
// ============================================================================

async function k8sRefresh(ctx: IExecutionContext): Promise<void> {
  const env = ctx.env;
  const kubectlBase = buildKubectlBase(ctx);

  ctx.output.header(`Kubernetes Refresh: ${env}`);
  ctx.output.info('Syncing local state with current Kubernetes deployment status...');
  ctx.output.newline();

  if (ctx.dryRun) {
    ctx.output.info('[dry-run] Would sync with Kubernetes');
    return;
  }

  let updated = 0;
  let added = 0;
  let unchanged = 0;

  const spinner = ctx.output.spinner('Fetching Kubernetes deployment status');
  spinner.start();

  try {
    const k8sModules = Object.values(ctx.config.resolvedModules).filter(
      (m) => m.resolvedDeploy?.[env]?.type === 'kubernetes'
    );

    if (k8sModules.length === 0) {
      spinner.info('No Kubernetes modules configured');
      return;
    }

    const k8sConfig = ctx.getK8sConfig();

    for (const module of k8sModules) {
      const deployConfig = module.resolvedDeploy?.[env];
      if (deployConfig?.type !== 'kubernetes') continue;

      const namespace = deployConfig.namespace ?? k8sConfig.namespace ?? 'default';

      try {
        const result = await exec(
          `${kubectlBase} -n ${namespace} get deployment/${deployConfig.deployment} -o json`,
          { silent: true }
        );

        const deploy = JSON.parse(result.stdout);
        const ready = deploy.status?.readyReplicas ?? 0;
        const desired = deploy.spec?.replicas ?? 0;

        // Extract image tag
        const containers = deploy.spec?.template?.spec?.containers ?? [];
        const mainContainer = containers[0];
        const imageTag = mainContainer?.image?.split(':').pop() ?? 'latest';

        const localCommit = await getGitCommit(module.absolutePath);

        const existing = ctx.config.state.deployments[env]?.[module.name];
        const newRecord: DeploymentRecord = {
          moduleName: module.name,
          environment: env,
          version: existing?.version ?? imageTag,
          commit: existing?.commit ?? localCommit?.substring(0, 7) ?? 'unknown',
          deployedAt: existing?.deployedAt ?? new Date().toISOString(),
          status: ready === desired && desired > 0 ? 'deployed' : 'deploying',
          k8sNamespace: namespace,
          k8sDeployment: deployConfig.deployment,
          k8sImageTag: imageTag,
        };

        if (!existing) {
          ctx.config.state.deployments[env][module.name] = newRecord;
          added++;
        } else if (existing.k8sImageTag !== imageTag) {
          ctx.config.state.deployments[env][module.name] = {
            ...existing,
            ...newRecord,
            deployedAt: new Date().toISOString(),
          };
          updated++;
        } else {
          unchanged++;
        }
      } catch {
        // Deployment doesn't exist in K8s, skip
      }
    }

    spinner.succeed('Kubernetes deployments synced');
  } catch (error) {
    spinner.fail('Failed to sync Kubernetes deployments');
    ctx.output.warning(`  ${error}`);
  }

  // Save state
  await ctx.saveState();

  ctx.output.newline();
  ctx.output.success(`Refresh complete: ${added} added, ${updated} updated, ${unchanged} unchanged`);
}
