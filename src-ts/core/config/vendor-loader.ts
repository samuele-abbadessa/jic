import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { VendorConfigSchema } from './vendor-schema.js';
import { VendorError } from '../errors/index.js';
import type { VendorConfig, LoadedVendorConfig } from '../types/vendor.js';

export const VENDORS_DIR = '.jic/vendors';
const CONFIG_PREFIX = 'jic.config.';
const CONFIG_SUFFIX = '.json';

export function vendorConfigFilename(vendorName: string): string {
  return `${CONFIG_PREFIX}${vendorName}${CONFIG_SUFFIX}`;
}

function vendorNameFromFilename(filename: string): string | null {
  if (!filename.startsWith(CONFIG_PREFIX) || !filename.endsWith(CONFIG_SUFFIX)) {
    return null;
  }
  const name = filename.slice(CONFIG_PREFIX.length, -CONFIG_SUFFIX.length);
  return name.length > 0 ? name : null;
}

export async function listVendors(projectRoot: string): Promise<string[]> {
  const vendorsPath = join(projectRoot, VENDORS_DIR);
  try {
    const files = await readdir(vendorsPath);
    return files
      .map(vendorNameFromFilename)
      .filter((name): name is string => name !== null)
      .sort();
  } catch {
    return [];
  }
}

export async function loadVendorConfig(
  projectRoot: string,
  vendorName: string
): Promise<LoadedVendorConfig> {
  const configPath = join(projectRoot, VENDORS_DIR, vendorConfigFilename(vendorName));

  try {
    await access(configPath);
  } catch {
    throw new VendorError(
      `Vendor config not found: ${configPath}`,
      vendorName
    );
  }

  const raw = await readFile(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new VendorError(
      `Invalid JSON in vendor config: ${configPath}`,
      vendorName,
      e instanceof Error ? e : undefined
    );
  }

  const result = VendorConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new VendorError(
      `Invalid vendor config for "${vendorName}": ${issues}`,
      vendorName
    );
  }

  return {
    ...result.data,
    name: vendorName,
    configPath,
  } as LoadedVendorConfig;
}

export async function saveVendorConfig(
  projectRoot: string,
  vendorName: string,
  config: VendorConfig
): Promise<void> {
  const vendorsPath = join(projectRoot, VENDORS_DIR);
  await mkdir(vendorsPath, { recursive: true });

  const configPath = join(vendorsPath, vendorConfigFilename(vendorName));
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function generateVendorConfig(
  vendorName: string,
  moduleNames: string[]
): VendorConfig {
  const isRoot = vendorName === 'root';
  return {
    description: isRoot ? 'Root vendor — all modules on default branches' : `Vendor: ${vendorName}`,
    modules: moduleNames,
    branches: {
      dev: isRoot ? 'dev' : `${vendorName}/dev`,
    },
  };
}
