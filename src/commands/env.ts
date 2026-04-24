import { Cli, z } from 'incur';
import { testStoreConnection } from '../lib/bigcommerce/test-store-connection.ts';
import {
  activateEnv,
  getActiveEnv,
  getEnvPath,
  listEnvs,
  parseEnvFile,
  removeEnv,
} from '../lib/config/env-manager.ts';
import { logger } from '../lib/shared/logger.ts';

const maskToken = (token: string) => {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
};

export const registerEnvCommand = (cli: Cli.Cli) => {
  const envCli = Cli.create('env', {
    description: 'Manage environment configurations',
  });

  envCli.command('list', {
    description: 'List available environments',
    run() {
      const envs = listEnvs();

      if (envs.length === 0) {
        logger.info(
          'No environments found. Run "bc setup --env <name>" to create one.',
        );
        return { environments: [] };
      }

      return { environments: envs };
    },
  });

  envCli.command('use', {
    description: 'Switch to an environment',
    args: z.object({
      name: z.string().describe('Environment name'),
    }),
    async run({ args }) {
      activateEnv(args.name);
      logger.info(`Switched to "${args.name}" environment.`);

      const values = parseEnvFile(getEnvPath(args.name));
      const storeHash = values.BC_STORE_HASH;
      const accessToken = values.BC_ACCESS_TOKEN;

      if (storeHash && accessToken) {
        const [connError, store] = await testStoreConnection(
          storeHash,
          accessToken,
        );
        if (connError) {
          logger.warn(`✗ ${connError.message}`);
        } else {
          logger.info(`✓ Connected to "${store.name}" (${store.domain})`);
        }
      }

      return { switched: true, name: args.name };
    },
  });

  envCli.command('show', {
    description: 'Show current environment details',
    args: z.object({
      name: z
        .string()
        .optional()
        .describe('Environment name (defaults to active)'),
    }),
    run({ args }) {
      const target = args.name ?? getActiveEnv();
      if (!target) {
        logger.info(
          'No active environment. Run "bc env use <name>" to activate one.',
        );
        return { name: null, active: false, values: {} };
      }

      const values = parseEnvFile(getEnvPath(target));
      if (Object.keys(values).length === 0) {
        logger.error(`Environment "${target}" not found.`);
        process.exit(1);
      }

      const active = getActiveEnv();
      const maskedValues: Record<string, string> = {};
      for (const [key, val] of Object.entries(values)) {
        maskedValues[key] =
          key.includes('TOKEN') || key.includes('SECRET')
            ? maskToken(val)
            : val;
      }

      return { name: target, active: target === active, values: maskedValues };
    },
  });

  envCli.command('remove', {
    description: 'Remove an environment',
    args: z.object({
      name: z.string().describe('Environment name'),
    }),
    run({ args }) {
      removeEnv(args.name);
      logger.info(`Removed "${args.name}" environment.`);

      return { removed: true, name: args.name };
    },
  });

  cli.command(envCli);
};
