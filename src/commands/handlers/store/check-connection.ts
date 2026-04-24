import type { Cli } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { StoreInfo } from '../../../lib/bigcommerce/schemas.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';

export type CheckConnectionDeps = {
  getStoreInfo: () => Promise<StoreInfo>;
};

export type CheckConnectionResult = {
  data: StoreInfo;
  cta: Cta;
};

export const checkConnectionHandler = async (
  deps: CheckConnectionDeps,
): Promise<CheckConnectionResult> => {
  const [error, store] = await handlePromise(deps.getStoreInfo());
  if (error) {
    exitWithError(`✗ ${error.message}`);
  }
  const info = store as StoreInfo;

  logger.info(`✓ Connected to BigCommerce`);
  logger.info(`Store name: ${info.name}`);
  logger.info(`Store domain: ${info.domain}`);
  logger.info(`Store plan: ${info.plan_name}`);
  logger.info(`Store status: ${info.status}`);

  return {
    data: info,
    cta: {
      commands: [
        { command: 'env list', description: 'List available environments' },
        {
          command: 'get form-fields',
          description: 'View customer form fields defined on the store',
        },
      ],
    },
  };
};

export const registerCheckConnectionSubcommand = (parent: Cli.Cli) => {
  parent.command('connection', {
    description: 'Test API connection and show store info',
    async run(c) {
      const result = await runHandler(() =>
        checkConnectionHandler({
          getStoreInfo: () => createBcClient().getStoreInfo(),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
