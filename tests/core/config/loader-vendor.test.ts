import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '@/core/config/loader.js';
import { VENDORS_DIR } from '@/core/config/vendor-loader.js';

describe('loadConfig with vendor support', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'jic-loader-vendor-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeRootConfig(config: Record<string, unknown>) {
    writeFileSync(join(testDir, 'jic.config.json'), JSON.stringify(config));
  }

  function writeVendorConfig(vendorName: string, config: Record<string, unknown>) {
    const vendorsDir = join(testDir, VENDORS_DIR);
    mkdirSync(vendorsDir, { recursive: true });
    writeFileSync(
      join(vendorsDir, `jic.config.${vendorName}.json`),
      JSON.stringify(config)
    );
  }

  function writeState(state: Record<string, unknown>) {
    writeFileSync(join(testDir, 'jic.state.json'), JSON.stringify(state));
  }

  it('should load without vendor when project.type is independent', async () => {
    writeRootConfig({
      version: '2.0.0',
      project: { name: 'test', rootDir: '.' },
      modules: {
        'svc-a': { type: 'java-service', directory: 'svc-a' },
      },
      defaults: {},
    });

    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    expect(config.resolvedModules['svc-a']).toBeDefined();
    expect(config.vendorConfig).toBeUndefined();
  });

  it('should load vendor config when project.type is submodules', async () => {
    writeRootConfig({
      version: '2.0.0',
      project: { name: 'test', type: 'submodules', rootDir: '.' },
      modules: {
        'svc-a': { type: 'java-service', directory: 'svc-a' },
        'svc-b': { type: 'java-service', directory: 'svc-b' },
      },
      defaults: {},
    });
    writeVendorConfig('acme', {
      modules: ['svc-a'],
      branches: { master: 'acme/master', dev: 'acme/dev', build: 'acme/build' },
      env: { VENDOR_KEY: 'acme-value' },
    });
    writeState({
      version: '2.0.0',
      lastUpdated: new Date().toISOString(),
      activeVendor: 'acme',
      sessions: {},
      deployments: { dev: {}, staging: {}, prod: {} },
      serve: { processes: {}, infrastructure: {} },
      buildCache: {},
    });

    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    expect(config.state.activeVendor).toBe('acme');
    expect(config.vendorConfig).toBeDefined();
    expect(config.vendorConfig?.name).toBe('acme');
    expect(config.vendorConfig?.modules).toEqual(['svc-a']);
  });

  it('should default activeVendor to root when type is submodules but no state', async () => {
    writeRootConfig({
      version: '2.0.0',
      project: { name: 'test', type: 'submodules', rootDir: '.' },
      modules: {
        'svc-a': { type: 'java-service', directory: 'svc-a' },
      },
      defaults: {},
    });
    writeVendorConfig('root', {
      modules: ['svc-a'],
      branches: { master: 'master', dev: 'dev', build: 'build' },
    });

    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    expect(config.state.activeVendor).toBe('root');
    expect(config.vendorConfig?.name).toBe('root');
  });

  it('should not fail when submodules project has no vendor config files', async () => {
    writeRootConfig({
      version: '2.0.0',
      project: { name: 'test', type: 'submodules', rootDir: '.' },
      modules: {
        'svc-a': { type: 'java-service', directory: 'svc-a' },
      },
      defaults: {},
    });

    const config = await loadConfig({ configPath: join(testDir, 'jic.config.json') });
    expect(config.state.activeVendor).toBe('root');
    expect(config.vendorConfig).toBeUndefined();
    expect(config.resolvedModules['svc-a']).toBeDefined();
  });
});
