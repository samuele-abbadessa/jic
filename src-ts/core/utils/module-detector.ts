import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleType } from '../types/config.js';

const FRONTEND_PACKAGES = [
  '@angular/core',
  'react',
  'vue',
  '@tanstack/react-start',
  '@tanstack/start',
];

export async function detectModuleType(dirPath: string): Promise<ModuleType> {
  // 1. Check for pom.xml (Java)
  const pomType = await detectJavaType(dirPath);
  if (pomType) return pomType;

  // 2. Check for .csproj / .sln (C#/.NET)
  if (await hasDotnetFiles(dirPath)) return 'dotnet-service';

  // 3. Check for package.json (Node.js / Frontend)
  const nodeType = await detectNodeType(dirPath);
  if (nodeType) return nodeType;

  return 'unknown';
}

async function detectJavaType(dirPath: string): Promise<ModuleType | null> {
  const pomPath = join(dirPath, 'pom.xml');
  try {
    const content = await readFile(pomPath, 'utf-8');
    if (content.includes('spring-boot')) {
      return 'java-service';
    }
    return 'flux-client';
  } catch {
    return null;
  }
}

async function hasDotnetFiles(dirPath: string): Promise<boolean> {
  try {
    const files = await readdir(dirPath);
    return files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'));
  } catch {
    return false;
  }
}

async function detectNodeType(dirPath: string): Promise<ModuleType | null> {
  const pkgPath = join(dirPath, 'package.json');
  try {
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    for (const pkgName of FRONTEND_PACKAGES) {
      if (pkgName in allDeps) {
        return 'frontend';
      }
    }

    return 'node-service';
  } catch {
    return null;
  }
}
