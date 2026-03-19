import { describe, it, expect } from 'vitest';
import { VendorConfigSchema } from '@/core/config/vendor-schema.js';

describe('VendorConfigSchema', () => {
  it('should validate a complete vendor config', () => {
    const config = {
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
        THEME: 'acme',
      },
    };
    const result = VendorConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('should validate a minimal vendor config', () => {
    const config = {
      modules: ['service-a'],
      branches: {
        master: 'v/master',
        dev: 'v/dev',
        build: 'v/build',
      },
    };
    const result = VendorConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('should reject config without modules', () => {
    const config = {
      branches: {
        master: 'v/master',
        dev: 'v/dev',
        build: 'v/build',
      },
    };
    const result = VendorConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('should reject config without branches', () => {
    const config = {
      modules: ['service-a'],
    };
    const result = VendorConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('should reject branches with missing keys', () => {
    const config = {
      modules: ['service-a'],
      branches: {
        master: 'v/master',
        // missing dev and build
      },
    };
    const result = VendorConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('should reject empty modules array', () => {
    const config = {
      modules: [],
      branches: {
        master: 'v/master',
        dev: 'v/dev',
        build: 'v/build',
      },
    };
    const result = VendorConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('should default nonVendorBranch to undefined when not provided', () => {
    const config = {
      modules: ['service-a'],
      branches: {
        master: 'v/master',
        dev: 'v/dev',
        build: 'v/build',
      },
    };
    const result = VendorConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nonVendorBranch).toBeUndefined();
    }
  });
});
