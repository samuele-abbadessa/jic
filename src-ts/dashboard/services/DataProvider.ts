/**
 * Data Provider Service
 *
 * Provides data for dashboard panels by reading from context and state.
 */

import { exec, isProcessRunning, getGitBranch } from '../../core/utils/shell.js';
import type { IExecutionContext } from '../../core/context/ExecutionContext.js';
import type {
  ServiceStatus,
  InfraStatus,
  ModuleTreeNode,
  BranchTreeNode,
} from '../types.js';

// ============================================================================
// DataProvider Class
// ============================================================================

export class DataProvider {
  private ctx: IExecutionContext;

  constructor(ctx: IExecutionContext) {
    this.ctx = ctx;
  }

  /**
   * Get service status for all servable modules
   */
  async getServiceStatus(): Promise<ServiceStatus[]> {
    const processes = this.ctx.state.serve?.processes ?? {};
    const modules = Object.values(this.ctx.config.resolvedModules);

    const services: ServiceStatus[] = [];

    for (const module of modules) {
      if (!module.resolvedServe) continue;

      const processInfo = processes[module.name];
      const isRunning = processInfo && isProcessRunning(processInfo.pid);

      let uptime: string | undefined;
      if (isRunning && processInfo?.startedAt) {
        const startTime = new Date(processInfo.startedAt).getTime();
        const elapsed = Date.now() - startTime;
        uptime = this.formatUptime(elapsed);
      }

      services.push({
        name: module.aliases?.[0] ?? module.name,
        port: module.port,
        pid: isRunning ? processInfo.pid : undefined,
        status: isRunning ? 'running' : 'stopped',
        uptime,
      });
    }

    return services;
  }

  /**
   * Get infrastructure status
   */
  async getInfraStatus(): Promise<InfraStatus[]> {
    const results: InfraStatus[] = [];

    // Check MongoDB
    const mongoStatus = await this.checkMongo();
    results.push(mongoStatus);

    // Check Eureka
    const eurekaStatus = await this.checkEureka();
    results.push(eurekaStatus);

    return results;
  }

  /**
   * Check MongoDB status
   */
  private async checkMongo(): Promise<InfraStatus> {
    try {
      const start = Date.now();
      await exec(
        'docker exec joyincloud_mongodb mongosh --eval "db.runCommand({ping:1})" --quiet',
        { silent: true, timeout: 5000 }
      );
      const latency = Date.now() - start;

      return {
        name: 'MongoDB',
        status: 'healthy',
        latency,
      };
    } catch {
      return {
        name: 'MongoDB',
        status: 'unhealthy',
        message: 'Connection failed',
      };
    }
  }

  /**
   * Check Eureka status
   */
  private async checkEureka(): Promise<InfraStatus> {
    try {
      const start = Date.now();
      await exec('curl -sf http://localhost:8761/actuator/health', {
        silent: true,
        timeout: 5000,
      });
      const latency = Date.now() - start;

      return {
        name: 'Eureka',
        status: 'healthy',
        latency,
      };
    } catch {
      return {
        name: 'Eureka',
        status: 'unhealthy',
        message: 'Connection failed',
      };
    }
  }

  /**
   * Get module tree data
   */
  async getModuleTree(): Promise<ModuleTreeNode> {
    const processes = this.ctx.state.serve?.processes ?? {};
    const modules = Object.values(this.ctx.config.resolvedModules);

    const children: Record<string, ModuleTreeNode> = {};

    // Group by type
    const byType: Record<string, typeof modules> = {};
    for (const module of modules) {
      const type = module.type ?? 'other';
      if (!byType[type]) byType[type] = [];
      byType[type].push(module);
    }

    for (const [type, typeModules] of Object.entries(byType)) {
      const typeChildren: Record<string, ModuleTreeNode> = {};

      for (const module of typeModules) {
        const processInfo = processes[module.name];
        const isRunning = processInfo && isProcessRunning(processInfo.pid);

        typeChildren[module.name] = {
          name: module.aliases?.[0] ?? module.name,
          type: module.type,
          status: isRunning ? 'running' : 'stopped',
        };
      }

      children[type] = {
        name: type,
        children: typeChildren,
        extended: true,
      };
    }

    return {
      name: 'Modules',
      children,
      extended: true,
    };
  }

  /**
   * Get branch tree data
   */
  async getBranchTree(): Promise<BranchTreeNode> {
    const modules = Object.values(this.ctx.config.resolvedModules);
    const children: Record<string, BranchTreeNode> = {};

    for (const module of modules) {
      try {
        const branch = await getGitBranch(module.absolutePath);
        children[module.name] = {
          name: `${module.aliases?.[0] ?? module.name}: ${branch ?? 'unknown'}`,
          branch: branch ?? undefined,
        };
      } catch {
        children[module.name] = {
          name: `${module.aliases?.[0] ?? module.name}: error`,
        };
      }
    }

    return {
      name: 'Branches',
      children,
      extended: true,
    };
  }

  /**
   * Get session data for tree display
   */
  getSessionTree(): Record<string, unknown> {
    const session = this.ctx.activeSession;

    if (!session) {
      return {
        'No Active Session': {
          name: 'Start a session with: jic session start <name>',
        },
      };
    }

    const moduleChildren: Record<string, { name: string }> = {};
    for (const [name, moduleState] of Object.entries(session.modules)) {
      moduleChildren[name] = {
        name: `${name} (${moduleState.branch})`,
      };
    }

    return {
      [session.name]: {
        name: session.name,
        extended: true,
        children: {
          Status: { name: `Status: ${session.status}` },
          Branch: { name: `Branch: ${session.sessionBranch}` },
          Base: { name: `Base: ${session.baseBranch}` },
          Modules: {
            name: `Modules (${Object.keys(session.modules).length})`,
            extended: true,
            children: moduleChildren,
          },
        },
      },
    };
  }

  /**
   * Format uptime duration
   */
  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }
}
