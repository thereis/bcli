import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';

export type GetCartArgs = { id?: string };
export type GetCartOptions = {
  orderId?: number;
};
export type GetCartDeps = {
  getCart: (id: string) => Promise<unknown>;
  getCartByOrderId: (orderId: number) => Promise<unknown>;
};

export type GetCartResult = {
  data: unknown;
  cta: Cta;
};

export const getCartHandler = async (
  args: GetCartArgs,
  options: GetCartOptions,
  deps: GetCartDeps,
): Promise<GetCartResult> => {
  if (!args.id && !options.orderId) {
    exitWithError(
      'Provide a cart ID as argument or use --order-id to look up by order.',
    );
  }

  const isOrderId = options.orderId || (args.id && /^\d+$/.test(args.id));
  const [error, cart] = await handlePromise(
    isOrderId
      ? deps.getCartByOrderId(Number(options.orderId ?? args.id))
      : deps.getCart(args.id as string),
  );

  if (error) {
    exitWithError(`Error: ${error.message}`);
  }

  const commands: Cta['commands'] = [];

  const resolvedOrderId = options.orderId ?? (isOrderId ? args.id : undefined);

  if (resolvedOrderId) {
    commands.push({
      command: `get order ${resolvedOrderId}`,
      description: 'View the order for this cart',
    });
  }

  return { data: cart, cta: { commands } };
};

export const registerGetCartSubcommand = (parent: Cli.Cli) => {
  parent.command('cart', {
    description: 'Inspect a cart by cart ID or order ID',
    args: z.object({
      id: z.string().optional().describe('Cart ID (UUID) or Order ID (number)'),
    }),
    options: z.object({
      orderId: z
        .number()
        .optional()
        .describe('Look up the cart associated with this order ID'),
    }),
    async run(c) {
      const bc = createBcClient();
      const result = await runHandler(() =>
        getCartHandler(c.args, c.options, {
          getCart: (id) => bc.getCart(id),
          getCartByOrderId: (orderId) => bc.getCartByOrderId(orderId),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
