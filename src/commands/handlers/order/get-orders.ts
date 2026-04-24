import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import {
  exitWithError,
  exitWithInfo,
  runHandler,
} from '../../../lib/shared/handler-exit.ts';
import type { OrderWithProducts } from './get-order.ts';

export type GetOrdersOptions = {
  email: string;
  limit: number;
};
export type GetOrdersDeps = {
  getOrdersByEmail: (
    email: string,
    limit: number,
  ) => Promise<OrderWithProducts[]>;
};

export type GetOrdersResult = {
  data: OrderWithProducts[];
  cta: Cta;
};

export const getOrdersHandler = async (
  options: GetOrdersOptions,
  deps: GetOrdersDeps,
): Promise<GetOrdersResult> => {
  const [error, fetched] = await handlePromise(
    deps.getOrdersByEmail(options.email, options.limit),
  );
  if (error) {
    exitWithError(`Error: ${error.message}`);
  }
  const orders = fetched as OrderWithProducts[];
  if (orders.length === 0) {
    exitWithInfo(`No orders found for ${options.email}`, 0);
  }

  const commands: Cta['commands'] = orders.slice(0, 3).map((o) => ({
    command: `get order ${o.id}`,
    description: `View order ${o.id} in full`,
  }));
  commands.push({
    command: `get customer --email ${options.email}`,
    description: 'View the customer',
  });

  return { data: orders, cta: { commands } };
};

export const registerGetOrdersSubcommand = (parent: Cli.Cli) => {
  parent.command('orders', {
    description:
      'Query orders by customer email, sorted by date descending (most recent first)',
    options: z.object({
      email: z.string().describe('Customer email address'),
      limit: z
        .number()
        .default(10)
        .describe(
          'Maximum number of most recent orders to return (default 10)',
        ),
    }),
    async run(c) {
      const result = await runHandler(() =>
        getOrdersHandler(c.options, {
          getOrdersByEmail: (email, limit) =>
            createBcClient().getOrdersByEmail(email, limit) as Promise<
              OrderWithProducts[]
            >,
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
