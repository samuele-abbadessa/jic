/**
 * Dependency Graph Utilities for JIC CLI
 *
 * Provides dependency resolution, topological sorting, cycle detection,
 * and build level computation for multi-module builds.
 */

import type { ResolvedModule } from '../types/module.js';
import type { LoadedConfig } from '../config/loader.js';
import { BuildError } from '../errors/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A directed graph of module dependencies
 */
export interface DependencyGraph {
  /** All modules in the graph (name -> module) */
  nodes: Map<string, ResolvedModule>;
  /** Edges: module -> set of dependency names */
  edges: Map<string, Set<string>>;
  /** Reverse edges: module -> set of dependant names */
  reverseEdges: Map<string, Set<string>>;
}

/**
 * A build level represents modules that can be built in parallel
 * (all their dependencies have already been built in previous levels)
 */
export interface BuildLevel {
  /** Level number (0 = no dependencies, higher = more dependencies) */
  level: number;
  /** Modules in this level */
  modules: ResolvedModule[];
  /** Whether modules in this level can be built in parallel */
  canParallelize: boolean;
}

/**
 * Options for dependency resolution
 */
export interface DependencyResolutionOptions {
  /** Include transitive dependencies */
  transitive?: boolean;
  /** Include modules that depend on the specified modules */
  includeDependants?: boolean;
}

// ============================================================================
// Graph Building
// ============================================================================

/**
 * Build a dependency graph from modules
 *
 * @param modules - Modules to include in the graph
 * @param config - Full config for resolving dependency references
 * @returns The dependency graph
 */
export function buildDependencyGraph(
  modules: ResolvedModule[],
  config: LoadedConfig
): DependencyGraph {
  const nodes = new Map<string, ResolvedModule>();
  const edges = new Map<string, Set<string>>();
  const reverseEdges = new Map<string, Set<string>>();

  // Add all modules as nodes
  for (const module of modules) {
    nodes.set(module.name, module);
    edges.set(module.name, new Set());
    reverseEdges.set(module.name, new Set());
  }

  // Build edges from dependencies
  for (const module of modules) {
    const deps = module.dependencies ?? [];
    for (const depRef of deps) {
      // Resolve dependency reference (could be name or alias)
      const depModule = findModuleByRef(depRef, config);
      if (depModule && nodes.has(depModule.name)) {
        edges.get(module.name)!.add(depModule.name);
        reverseEdges.get(depModule.name)!.add(module.name);
      }
    }
  }

  return { nodes, edges, reverseEdges };
}

/**
 * Find a module by name or alias
 */
function findModuleByRef(ref: string, config: LoadedConfig): ResolvedModule | null {
  // Direct name match
  if (config.resolvedModules[ref]) {
    return config.resolvedModules[ref];
  }

  // Alias match
  for (const module of Object.values(config.resolvedModules)) {
    if (module.aliases?.includes(ref)) {
      return module;
    }
  }

  return null;
}

// ============================================================================
// Cycle Detection
// ============================================================================

/**
 * Detect cycles in the dependency graph using DFS
 *
 * @param graph - The dependency graph to check
 * @returns Array of cycles (each cycle is an array of module names), or empty array if no cycles
 */
export function detectCycles(graph: DependencyGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const deps = graph.edges.get(node) ?? new Set();
    for (const dep of deps) {
      if (!graph.nodes.has(dep)) {
        // Dependency not in graph (external), skip
        continue;
      }

      if (!visited.has(dep)) {
        dfs(dep);
      } else if (recursionStack.has(dep)) {
        // Found a cycle
        const cycleStart = path.indexOf(dep);
        const cycle = path.slice(cycleStart);
        cycle.push(dep); // Complete the cycle
        cycles.push(cycle);
      }
    }

    path.pop();
    recursionStack.delete(node);
  }

  for (const node of graph.nodes.keys()) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

/**
 * Format cycles for display
 */
export function formatCycles(cycles: string[][]): string {
  return cycles.map((cycle) => cycle.join(' -> ')).join('\n');
}

// ============================================================================
// Topological Sort
// ============================================================================

/**
 * Perform topological sort on the dependency graph
 * Returns modules grouped into build levels (modules in the same level can be built in parallel)
 *
 * @param graph - The dependency graph
 * @returns Array of build levels in dependency order (level 0 first)
 * @throws BuildError if cycles are detected
 */
export function topologicalSort(graph: DependencyGraph): BuildLevel[] {
  // Check for cycles first
  const cycles = detectCycles(graph);
  if (cycles.length > 0) {
    throw new BuildError(`Circular dependencies detected:\n${formatCycles(cycles)}`);
  }

  const levels: BuildLevel[] = [];
  const assigned = new Set<string>();
  const remaining = new Set(graph.nodes.keys());

  while (remaining.size > 0) {
    const level: ResolvedModule[] = [];

    // Find all modules whose dependencies are all assigned
    for (const nodeName of remaining) {
      const deps = graph.edges.get(nodeName) ?? new Set();
      const unmetDeps = [...deps].filter(
        (dep) => graph.nodes.has(dep) && !assigned.has(dep)
      );

      if (unmetDeps.length === 0) {
        level.push(graph.nodes.get(nodeName)!);
      }
    }

    if (level.length === 0 && remaining.size > 0) {
      // This shouldn't happen if cycle detection works, but just in case
      throw new BuildError(
        `Unable to resolve dependencies for: ${[...remaining].join(', ')}`
      );
    }

    // Mark these modules as assigned
    for (const module of level) {
      assigned.add(module.name);
      remaining.delete(module.name);
    }

    levels.push({
      level: levels.length,
      modules: level,
      canParallelize: level.length > 1,
    });
  }

  return levels;
}

// ============================================================================
// Dependency Expansion
// ============================================================================

/**
 * Expand module references to include their dependencies
 *
 * @param moduleRefs - Module names/aliases to expand
 * @param config - Full configuration
 * @param options - Resolution options
 * @returns Expanded array of modules including dependencies
 */
export function expandDependencies(
  modules: ResolvedModule[],
  config: LoadedConfig,
  options: DependencyResolutionOptions = {}
): ResolvedModule[] {
  const { transitive = true, includeDependants = false } = options;
  const result = new Map<string, ResolvedModule>();
  const queue = [...modules];

  // Add initial modules
  for (const module of modules) {
    result.set(module.name, module);
  }

  // Expand dependencies
  while (queue.length > 0) {
    const current = queue.shift()!;
    const deps = current.dependencies ?? [];

    for (const depRef of deps) {
      const depModule = findModuleByRef(depRef, config);
      if (depModule && !result.has(depModule.name)) {
        result.set(depModule.name, depModule);
        if (transitive) {
          queue.push(depModule);
        }
      }
    }
  }

  // Expand dependants if requested
  if (includeDependants) {
    const initialModules = [...modules];
    for (const module of initialModules) {
      const dependants = getDependants(module.name, config);
      for (const dependant of dependants) {
        if (!result.has(dependant.name)) {
          result.set(dependant.name, dependant);
        }
      }
    }
  }

  return Array.from(result.values());
}

/**
 * Get all modules that depend on the given module
 *
 * @param moduleName - Name of the module
 * @param config - Full configuration
 * @param transitive - Include transitive dependants
 * @returns Array of dependant modules
 */
export function getDependants(
  moduleName: string,
  config: LoadedConfig,
  transitive: boolean = true
): ResolvedModule[] {
  const result = new Map<string, ResolvedModule>();
  const queue = [moduleName];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // Find modules that have this module as a dependency
    for (const module of Object.values(config.resolvedModules)) {
      const deps = module.dependencies ?? [];
      const hasDep = deps.some((dep) => {
        const resolved = findModuleByRef(dep, config);
        return resolved?.name === current;
      });

      if (hasDep && !result.has(module.name)) {
        result.set(module.name, module);
        if (transitive) {
          queue.push(module.name);
        }
      }
    }
  }

  return Array.from(result.values());
}

// ============================================================================
// Dependency Tree Formatting
// ============================================================================

/**
 * Format dependency tree for display
 *
 * @param modules - Modules to show dependencies for
 * @param config - Full configuration
 * @param showDependants - Also show what depends on each module
 * @returns Formatted tree string
 */
export function formatDependencyTree(
  modules: ResolvedModule[],
  config: LoadedConfig,
  showDependants: boolean = false
): string {
  const lines: string[] = [];

  for (const module of modules) {
    lines.push(`${module.name} (${module.type})`);

    // Show dependencies
    const deps = module.dependencies ?? [];
    if (deps.length > 0) {
      for (let i = 0; i < deps.length; i++) {
        const isLast = i === deps.length - 1;
        const prefix = isLast ? '└── ' : '├── ';
        const resolved = findModuleByRef(deps[i], config);
        const status = resolved ? '' : ' (not found)';
        lines.push(`  ${prefix}depends on: ${deps[i]}${status}`);
      }
    }

    // Show dependants
    if (showDependants) {
      const dependants = getDependants(module.name, config, false);
      if (dependants.length > 0) {
        for (let i = 0; i < dependants.length; i++) {
          const isLast = i === dependants.length - 1;
          const prefix = isLast ? '└── ' : '├── ';
          lines.push(`  ${prefix}required by: ${dependants[i].name}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Build Order from Config
// ============================================================================

/**
 * Get modules sorted by the buildOrder config
 *
 * @param modules - Modules to sort
 * @param config - Full configuration with buildOrder
 * @returns Sorted modules respecting buildOrder groups
 */
export function sortByBuildOrderConfig(
  modules: ResolvedModule[],
  config: LoadedConfig
): BuildLevel[] {
  const buildOrder = config.buildOrder;
  if (!buildOrder || buildOrder.length === 0) {
    // No build order defined, use topological sort
    const graph = buildDependencyGraph(modules, config);
    return topologicalSort(graph);
  }

  const levels: BuildLevel[] = [];
  const assigned = new Set<string>();
  const moduleSet = new Set(modules.map((m) => m.name));

  // Process each group in buildOrder
  for (const entry of buildOrder) {
    const groupModules = resolveGroupModules(entry.group, config);
    const levelModules: ResolvedModule[] = [];

    for (const module of groupModules) {
      if (moduleSet.has(module.name) && !assigned.has(module.name)) {
        levelModules.push(module);
        assigned.add(module.name);
      }
    }

    if (levelModules.length > 0) {
      levels.push({
        level: levels.length,
        modules: levelModules,
        canParallelize: entry.parallel,
      });
    }
  }

  // Add any remaining modules not covered by buildOrder
  const remaining = modules.filter((m) => !assigned.has(m.name));
  if (remaining.length > 0) {
    levels.push({
      level: levels.length,
      modules: remaining,
      canParallelize: false,
    });
  }

  return levels;
}

/**
 * Resolve a group reference to modules
 */
function resolveGroupModules(groupName: string, config: LoadedConfig): ResolvedModule[] {
  const group = config.groups?.[groupName];
  if (!group) {
    return [];
  }

  const result: ResolvedModule[] = [];
  for (const ref of group) {
    if (ref === '*') {
      result.push(...Object.values(config.resolvedModules));
    } else if (ref.startsWith('@')) {
      result.push(...resolveGroupModules(ref, config));
    } else {
      const module = findModuleByRef(ref, config);
      if (module) {
        result.push(module);
      }
    }
  }

  return result;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get the build order for a set of modules respecting dependencies
 *
 * @param modules - Modules to build
 * @param config - Full configuration
 * @param includeDependencies - Whether to auto-include dependencies
 * @returns Build levels in correct order
 */
export function getBuildOrder(
  modules: ResolvedModule[],
  config: LoadedConfig,
  includeDependencies: boolean = false
): BuildLevel[] {
  let targetModules = modules;

  // Expand dependencies if requested
  if (includeDependencies) {
    targetModules = expandDependencies(modules, config);
  }

  // Build graph and perform topological sort
  const graph = buildDependencyGraph(targetModules, config);
  return topologicalSort(graph);
}

/**
 * Validate that all dependencies exist
 *
 * @param modules - Modules to validate
 * @param config - Full configuration
 * @returns Array of warnings about missing dependencies
 */
export function validateDependencies(
  modules: ResolvedModule[],
  config: LoadedConfig
): string[] {
  const warnings: string[] = [];

  for (const module of modules) {
    const deps = module.dependencies ?? [];
    for (const dep of deps) {
      const resolved = findModuleByRef(dep, config);
      if (!resolved) {
        warnings.push(`${module.name}: dependency '${dep}' not found in config`);
      }
    }
  }

  return warnings;
}
