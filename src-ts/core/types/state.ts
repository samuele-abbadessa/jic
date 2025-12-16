/**
 * State management types for JIC CLI
 *
 * These types define the structure of jic.state.json which persists:
 * - Session information
 * - Deployment history
 * - Running processes
 * - Build cache
 */

import type { Environment } from './config.js';
import type { ManagedProcess } from './execution.js';

// ============================================================================
// Session Types
// ============================================================================

/**
 * Session status
 */
export type SessionStatus = 'active' | 'ended' | 'merged';

/**
 * Session module state
 */
export interface SessionModuleState {
  /** Branch name for this module in the session */
  branch: string;
  /** Base branch this was created from */
  baseBranch?: string;
  /** Branches that have been merged into this session */
  mergedBranches?: string[];
  /** Current commit hash */
  currentCommit?: string;
  /** Starting commit when added to session */
  commit?: string;
  /** Whether module has uncommitted changes */
  hasChanges?: boolean;
}

/**
 * Merged branch record
 */
export interface MergedBranchRecord {
  /** Branch that was merged */
  branch: string;
  /** When it was merged */
  mergedAt: string;
  /** Commit hash after merge */
  commit: string;
  /** Modules affected by this merge */
  modules: string[];
}

/**
 * Session template definition
 */
export interface SessionTemplate {
  /** Template name */
  name: string;
  /** Description */
  description: string;
  /** Module groups to include */
  moduleGroups: string[];
  /** Base branch */
  baseBranch: string;
  /** Branch prefix for session branches */
  branchPrefix: string;
}

/**
 * Session state
 */
export interface Session {
  /** Session name */
  name: string;
  /** Session description */
  description?: string;
  /** When session was created */
  createdAt: string;
  /** When session was ended */
  endedAt?: string;
  /** Current status */
  status: SessionStatus;
  /** Base branch for the session */
  baseBranch: string;
  /** Session branch pattern (e.g., feature/sessionName) */
  sessionBranch: string;
  /** Template used to create this session */
  template?: string;
  /** Per-module state */
  modules: Record<string, SessionModuleState>;
  /** Branches merged into this session */
  mergedBranches: MergedBranchRecord[];
  /** Session-specific config overrides */
  configOverrides?: Record<string, unknown>;
}

// ============================================================================
// Deployment Types
// ============================================================================

/**
 * Deployment status
 */
export type DeploymentStatus = 'deployed' | 'deploying' | 'failed' | 'rolled-back';

/**
 * Deployment record
 */
export interface DeploymentRecord {
  /** Module name */
  moduleName: string;
  /** Environment */
  environment: Environment;
  /** Version string */
  version: string;
  /** Git commit hash */
  commit: string;
  /** When deployed */
  deployedAt: string;
  /** Who deployed (optional) */
  deployedBy?: string;
  /** Deployment status */
  status: DeploymentStatus;

  // ECS-specific
  /** ECS task definition ARN */
  ecsTaskDefinition?: string;

  // Lambda-specific
  /** Lambda version number */
  lambdaVersion?: string;

  // S3-specific
  /** S3 ETag for tracking */
  s3Etag?: string;

  // Health check
  healthCheck?: {
    /** Last health check time */
    lastChecked: string;
    /** Whether service is healthy */
    healthy: boolean;
  };
}

/**
 * Deployment state per environment
 */
export type DeploymentState = Record<string, DeploymentRecord>;

// ============================================================================
// Serve State
// ============================================================================

/**
 * Infrastructure state
 */
export interface InfrastructureState {
  /** Whether infrastructure is running */
  running: boolean;
  /** When it was started */
  startedAt?: string;
  /** Compose file used */
  composeFile?: string;
}

/**
 * Serve state
 */
export interface ServeState {
  /** Running processes by module name */
  processes: Record<string, ManagedProcess>;
  /** Infrastructure state */
  infrastructure: InfrastructureState;
}

// ============================================================================
// Build Cache
// ============================================================================

/**
 * Build cache entry
 */
export interface BuildCacheEntry {
  /** Module name */
  moduleName: string;
  /** Last build time */
  builtAt: string;
  /** Source hash (for change detection) */
  sourceHash?: string;
  /** Build output hash */
  outputHash?: string;
  /** Build duration in ms */
  duration: number;
  /** Whether build succeeded */
  success: boolean;
}

// ============================================================================
// Main State Interface
// ============================================================================

/**
 * Complete JIC state file structure
 * This is the root type for jic.state.json
 */
export interface JicState {
  /** State file version */
  version: string;
  /** Last updated timestamp */
  lastUpdated: string;

  /** All sessions */
  sessions: Record<string, Session>;
  /** Currently active session name */
  activeSession?: string;

  /** Deployment records per environment */
  deployments: {
    dev: DeploymentState;
    staging: DeploymentState;
    prod: DeploymentState;
  };

  /** Serve state */
  serve: ServeState;

  /** Build cache */
  buildCache: Record<string, BuildCacheEntry>;

  /** Session templates (user-defined) */
  templates?: Record<string, SessionTemplate>;
}

// ============================================================================
// State Helpers
// ============================================================================

/**
 * Create empty state
 */
export function createEmptyState(): JicState {
  return {
    version: '2.0.0',
    lastUpdated: new Date().toISOString(),
    sessions: {},
    activeSession: undefined,
    deployments: {
      dev: {},
      staging: {},
      prod: {},
    },
    serve: {
      processes: {},
      infrastructure: {
        running: false,
      },
    },
    buildCache: {},
  };
}

/**
 * Check if a session is active
 */
export function isSessionActive(session: Session): boolean {
  return session.status === 'active';
}

/**
 * Get active session from state
 */
export function getActiveSession(state: JicState): Session | undefined {
  if (!state.activeSession) return undefined;
  return state.sessions[state.activeSession];
}
