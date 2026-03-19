import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '@/core/config/loader.js';
import { createContext } from '@/core/context/ExecutionContext.js';
import { VENDORS_DIR } from '@/core/config/vendor-loader.js';

describe('resolveModules with vendor filtering', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'jic-resolve-vendor-'));
    // Create root config with 3 modules
    writeFileSync(join(testDir, 'jic.config.json'), JSON.stringify({
      version: '2.0.0',
      project: { name: 'test', type: 'submodules', rootDir: '.' },
      modules: {
        'svc-a': { type: 'java-service', directory: 'svc-a' },
        'svc-b': { type: 'java-service', directory: 'svc-b' },
        'frontend': { type: 'frontend', directory: 'frontend' },
      },
      groups: { '@backend': ['svc-a', 'svc-b'] },
      defaults: {},
    }));
    // Create vendor config for "acme" with only svc-a and frontend
    const vendorsDir = join(testDir, VENDORS_DIR);
    mkdirSync(vendorsDir, { recursive: true });
    writeFileSync(join(vendorsDir, 'jic.config.acme.json'), JSON.stringify({
      modules: ['svc-a', 'frontend'],
      branches: { master: 'acme/master', dev: 'acme/dev', build: 'acme/build' },
    }));
    // Create state
    writeFileSync(join(testDir, 'jic.state.json'), JSON.stringify({
      version: '2.0.0', lastUpdated: new Date().toISOString(),
      activeVendor: 'acme', sessions: {},
      deployments: { dev: {}, staging: {}, prod: {} },
      serve: { processes: {}, infrastructure: {} }, buildCache: {},
    }));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const defaultOptions = {
    env: 'dev' as const,
    dryRun: false,
    yes: false,
    json: false,
    quiet: false,
    verbose: false,
    noColor: false,
    failFast: false,
    continueOnError: false,
  };

  it('should return only vendor modules when no refs provided', async () => {
    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    const ctx = createContext(config, defaultOptions);
    const modules = ctx.resolveModules([]);
    const names = modules.map((m) => m.name);
    expect(names).toContain('svc-a');
    expect(names).toContain('frontend');
    expect(names).not.toContain('svc-b');
  });

  it('should error when explicitly requesting module outside vendor', async () => {
    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    const ctx = createContext(config, defaultOptions);
    expect(() => ctx.resolveModules(['svc-b'])).toThrow(/not in vendor/);
  });

  it('should intersect group with vendor modules silently', async () => {
    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    const ctx = createContext(config, defaultOptions);
    // @backend has svc-a and svc-b, but vendor only has svc-a
    const modules = ctx.resolveModules(['@backend']);
    const names = modules.map((m) => m.name);
    expect(names).toContain('svc-a');
    expect(names).not.toContain('svc-b');
  });

  it('should support implicit @vendor group', async () => {
    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    const ctx = createContext(config, defaultOptions);
    const modules = ctx.resolveModules(['@acme']);
    const names = modules.map((m) => m.name);
    expect(names).toContain('svc-a');
    expect(names).toContain('frontend');
    expect(names).not.toContain('svc-b');
  });
});
