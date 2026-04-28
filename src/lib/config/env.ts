import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { loadActiveEnv } from './env-manager.ts';

loadActiveEnv();

export const env = createEnv({
  server: {
    BC_STORE_HASH: z.string().optional().default(''),
    BC_ACCESS_TOKEN: z.string().optional().default(''),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
