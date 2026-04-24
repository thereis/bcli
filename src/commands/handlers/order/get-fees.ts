import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';

export type GetFeesArgs = { id: string };
export type GetFeesDeps = {
  getOrderFees: (orderId: number) => Promise<Record<string, unknown>[]>;
};

export type GetFeesResult = {
  data: Record<string, unknown>[];
  cta: Cta;
};

export const getFeesHandler = async (
  args: GetFeesArgs,
  deps: GetFeesDeps,
): Promise<GetFeesResult> => {
  const [error, fetched] = await handlePromise(
    deps.getOrderFees(Number(args.id)),
  );
  if (error) {
    exitWithError(`Error: ${error.message}`);
  }
  const fees = (fetched as Record<string, unknown>[]) ?? [];

  return {
    data: fees,
    cta: {
      commands: [
        {
          command: `get order ${args.id}`,
          description: 'Back to order details',
        },
      ],
    },
  };
};

export const registerGetFeesSubcommand = (parent: Cli.Cli) => {
  parent.command('fees', {
    description: 'Get fees for an order by order ID',
    args: z.object({
      id: z.string().describe('Order ID'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        getFeesHandler(c.args, {
          getOrderFees: (orderId) => createBcClient().getOrderFees(orderId),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
