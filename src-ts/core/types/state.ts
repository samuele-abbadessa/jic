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
export type SessionStatus = 'active' | 'paused' | 'ended' | 'merged';

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
  /** Vendor associated with this session */
  vendor?: string;
  /** Root repo branch for this session */
  rootBranch?: string;
  /** Root repo base branch for this session */
  rootBaseBranch?: string;
}

// ============================================================================
// Deployment Types
// ============================================================================

/**
 * Deployment status
 */
export type DeploymentStatus = 'deployed' | 'deploying' | 'failed' | 'rolled-back';

/**
 * Lambda function deployment info
 */
export interface LambdaFunctionDeployInfo {
  /** Function version */
  version: string;
  /** AWS Lambda version number */
  lambdaVersion?: string;
  /** When this function was deployed */
  deployedAt: string;
}

/**
 * Lambda version state (stored separately from main deployments)
 */
export interface LambdaVersionInfo {
  /** Our version string */
  version: string;
  /** AWS version number */
  awsVersion: string | null;
  /** When deployed */
  deployedAt: string;
  /** Git commit */
  commit: string;
  /** Layer name (for _layer entry) */
  layerName?: string;
}

/**
 * Lambda versions state per environment
 */
export type LambdaVersionsState = Record<string, LambdaVersionInfo>;

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

  // ECR-specific (for ECS deployments)
  /** ECR image tag */
  ecrImageTag?: string;
  /** ECR image digest (sha256:...) */
  ecrImageDigest?: string;
  /** When the image was pushed to ECR */
  ecrImagePushedAt?: string;

  // Lambda-specific
  /** Lambda version number (for layer or single function) */
  lambdaVersion?: string;
  /** Per-function deployment info (for lambda-functions module) */
  functions?: Record<string, LambdaFunctionDeployInfo>;

  // Kubernetes-specific
  /** Kubernetes namespace */
  k8sNamespace?: string;
  /** Kubernetes deployment name */
  k8sDeployment?: string;
  /** Container image tag */
  k8sImageTag?: string;

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
  /** Currently active vendor */
  activeVendor?: string;

  /** Deployment records per environment */
  deployments: {
    dev: DeploymentState;
    staging: DeploymentState;
    prod: DeploymentState;
  };

  /** Lambda-specific version tracking per environment */
  lambdaVersions?: {
    dev: LambdaVersionsState;
    staging: LambdaVersionsState;
    prod: LambdaVersionsState;
  };

  /** Serve state */
  serve: ServeState;

  /** Build cache */
  buildCache: Record<string, BuildCacheEntry>;
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
    activeVendor: undefined,
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
