import { describe, it, expect } from 'vitest';
import type { VendorConfig, VendorBranchConfig } from '@/core/types/vendor.js';

describe('VendorConfig types', () => {
  it('should accept a valid VendorConfig', () => {
    const config: VendorConfig = {
      description: 'Acme Corp',
      modules: ['service-a', 'frontend'],
      branches: {
        master: 'acme/master',
        dev: 'acme/dev',
        build: 'acme/build',
      },
      nonVendorBranch: 'master',
      env: {
        API_URL: 'https://acme.example.com/api',
      },
    };
    expect(config.modules).toHaveLength(2);
    expect(config.branches.master).toBe('acme/master');
    expect(config.nonVendorBranch).toBe('master');
  });

  it('should accept a minimal VendorConfig', () => {
    const config: VendorConfig = {
      modules: ['service-a'],
      branches: {
        master: 'acme/master',
        dev: 'acme/dev',
        build: 'acme/build',
      },
    };
    expect(config.modules).toHaveLength(1);
    expect(config.nonVendorBranch).toBeUndefined();
  });

  it('should accept VendorBranchConfig', () => {
    const branches: VendorBranchConfig = {
      master: 'vendor/master',
      dev: 'vendor/dev',
      build: 'vendor/build',
    };
    expect(branches.master).toBe('vendor/master');
  });
});
