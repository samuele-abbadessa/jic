import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadVendorConfig,
  listVendors,
  saveVendorConfig,
  generateVendorConfig,
  VENDORS_DIR,
  vendorConfigFilename,
} from '@/core/config/vendor-loader.js';

describe('vendor-loader', () => {
  let testDir: string;
  let vendorsDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'jic-vendor-test-'));
    vendorsDir = join(testDir, VENDORS_DIR);
    mkdirSync(vendorsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('vendorConfigFilename', () => {
    it('should return correct filename for a vendor', () => {
      expect(vendorConfigFilename('acme')).toBe('jic.config.acme.json');
    });
  });

  describe('listVendors', () => {
    it('should return empty array when no vendor configs exist', async () => {
      const vendors = await listVendors(testDir);
      expect(vendors).toEqual([]);
    });

    it('should list vendors from config files', async () => {
      const acmeConfig = {
        modules: ['svc-a'],
        branches: { master: 'acme/master', dev: 'acme/dev', build: 'acme/build' },
      };
      writeFileSync(
        join(vendorsDir, 'jic.config.acme.json'),
        JSON.stringify(acmeConfig)
      );
      writeFileSync(
        join(vendorsDir, 'jic.config.root.json'),
        JSON.stringify({
          modules: ['svc-a', 'svc-b'],
          branches: { master: 'master', dev: 'dev', build: 'build' },
        })
      );

      const vendors = await listVendors(testDir);
      expect(vendors).toContain('acme');
      expect(vendors).toContain('root');
      expect(vendors).toHaveLength(2);
    });

    it('should ignore non-matching files', async () => {
      writeFileSync(join(vendorsDir, 'random.json'), '{}');
      const vendors = await listVendors(testDir);
      expect(vendors).toEqual([]);
    });
  });

  describe('loadVendorConfig', () => {
    it('should load and validate a vendor config', async () => {
      const config = {
        description: 'Acme',
        modules: ['svc-a'],
        branches: { master: 'acme/master', dev: 'acme/dev', build: 'acme/build' },
        env: { KEY: 'value' },
      };
      writeFileSync(
        join(vendorsDir, 'jic.config.acme.json'),
        JSON.stringify(config)
      );

      const loaded = await loadVendorConfig(testDir, 'acme');
      expect(loaded.name).toBe('acme');
      expect(loaded.modules).toEqual(['svc-a']);
      expect(loaded.branches.master).toBe('acme/master');
      expect(loaded.env).toEqual({ KEY: 'value' });
    });

    it('should throw VendorError if config file not found', async () => {
      await expect(loadVendorConfig(testDir, 'nonexistent')).rejects.toThrow(
        /not found/
      );
    });

    it('should throw VendorError if config is invalid', async () => {
      writeFileSync(
        join(vendorsDir, 'jic.config.bad.json'),
        JSON.stringify({ modules: [] }) // empty modules, missing branches
      );
      await expect(loadVendorConfig(testDir, 'bad')).rejects.toThrow();
    });
  });

  describe('saveVendorConfig', () => {
    it('should write vendor config to disk', async () => {
      const config = {
        modules: ['svc-a'],
        branches: { master: 'v/master', dev: 'v/dev', build: 'v/build' },
      };
      await saveVendorConfig(testDir, 'newvendor', config);

      const loaded = await loadVendorConfig(testDir, 'newvendor');
      expect(loaded.modules).toEqual(['svc-a']);
    });

    it('should create vendors directory if it does not exist', async () => {
      rmSync(vendorsDir, { recursive: true, force: true });
      const config = {
        modules: ['svc-a'],
        branches: { master: 'v/master', dev: 'v/dev', build: 'v/build' },
      };
      await saveVendorConfig(testDir, 'newvendor', config);

      const loaded = await loadVendorConfig(testDir, 'newvendor');
      expect(loaded.modules).toEqual(['svc-a']);
    });
  });

  describe('generateVendorConfig', () => {
    it('should generate vendor config with renamed branches', () => {
      const moduleNames = ['service-a', 'frontend', 'service-b'];
      const config = generateVendorConfig('acme', moduleNames);

      expect(config.modules).toEqual(moduleNames);
      expect(config.branches.master).toBe('acme/master');
      expect(config.branches.dev).toBe('acme/dev');
      expect(config.branches.build).toBe('acme/build');
      expect(config.description).toContain('acme');
    });

    it('should generate root vendor config with default branches', () => {
      const moduleNames = ['service-a', 'frontend'];
      const config = generateVendorConfig('root', moduleNames);

      expect(config.modules).toEqual(moduleNames);
      expect(config.branches.master).toBe('master');
      expect(config.branches.dev).toBe('dev');
      expect(config.branches.build).toBe('build');
    });
  });
});
