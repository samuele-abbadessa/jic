import type { AwsConfig, KubernetesConfig } from './config.js';

export interface VendorBranchConfig {
  master?: string;
  dev: string;
  build?: string;
}

export interface VendorConfig {
  description?: string;
  modules: string[];
  branches: VendorBranchConfig;
  nonVendorBranch?: string;
  env?: Record<string, string>;
  aws?: AwsConfig;
  kubernetes?: KubernetesConfig;
}

export interface LoadedVendorConfig extends VendorConfig {
  name: string;
  configPath: string;
}
