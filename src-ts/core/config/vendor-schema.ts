import { z } from 'zod';

export const VendorBranchConfigSchema = z.object({
  master: z.string().min(1),
  dev: z.string().min(1),
  build: z.string().min(1),
});

export const VendorConfigSchema = z.object({
  description: z.string().optional(),
  modules: z.array(z.string().min(1)).min(1),
  branches: VendorBranchConfigSchema,
  nonVendorBranch: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  aws: z.record(z.string(), z.unknown()).optional(),
  kubernetes: z.record(z.string(), z.unknown()).optional(),
});

export type ValidatedVendorConfig = z.infer<typeof VendorConfigSchema>;
