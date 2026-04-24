import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';
import { loadActiveEnv } from './env-manager.ts';

loadActiveEnv();

export const env = createEnv({
  server: {
    BC_STORE_HASH: z.string().min(1),
    BC_ACCESS_TOKEN: z.string().min(1),

    LOG_PRETTY: z.string().default('false'),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
