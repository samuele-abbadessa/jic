import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectModuleType } from '@/core/utils/module-detector.js';

describe('detectModuleType', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'jic-detector-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect java-service from pom.xml with spring-boot', async () => {
    writeFileSync(join(testDir, 'pom.xml'), '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>');
    const type = await detectModuleType(testDir);
    expect(type).toBe('java-service');
  });

  it('should detect flux-client from pom.xml without spring-boot', async () => {
    writeFileSync(join(testDir, 'pom.xml'), '<project><artifactId>my-client</artifactId></project>');
    const type = await detectModuleType(testDir);
    expect(type).toBe('flux-client');
  });

  it('should detect dotnet-service from .csproj file', async () => {
    writeFileSync(join(testDir, 'MyService.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
    const type = await detectModuleType(testDir);
    expect(type).toBe('dotnet-service');
  });

  it('should detect dotnet-service from .sln file', async () => {
    writeFileSync(join(testDir, 'Solution.sln'), 'Microsoft Visual Studio Solution File');
    const type = await detectModuleType(testDir);
    expect(type).toBe('dotnet-service');
  });

  it('should detect frontend from package.json with @angular/core', async () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { '@angular/core': '^14.0.0' }
    }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('frontend');
  });

  it('should detect frontend from package.json with react', async () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { 'react': '^18.0.0' }
    }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('frontend');
  });

  it('should detect frontend from package.json with vue', async () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { 'vue': '^3.0.0' }
    }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('frontend');
  });

  it('should detect frontend from package.json with @tanstack/react-start', async () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { '@tanstack/react-start': '^1.0.0' }
    }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('frontend');
  });

  it('should detect frontend from package.json with @tanstack/start', async () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      devDependencies: { '@tanstack/start': '^1.0.0' }
    }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('frontend');
  });

  it('should detect node-service from package.json without frontend framework', async () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      dependencies: { 'express': '^4.0.0' }
    }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('node-service');
  });

  it('should return unknown when no marker files found', async () => {
    const type = await detectModuleType(testDir);
    expect(type).toBe('unknown');
  });

  it('should prioritize pom.xml over package.json', async () => {
    writeFileSync(join(testDir, 'pom.xml'), '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>');
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({ dependencies: { 'react': '^18.0.0' } }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('java-service');
  });

  it('should detect frontend from react in devDependencies', async () => {
    writeFileSync(join(testDir, 'package.json'), JSON.stringify({
      devDependencies: { 'react': '^18.0.0' }
    }));
    const type = await detectModuleType(testDir);
    expect(type).toBe('frontend');
  });
});
