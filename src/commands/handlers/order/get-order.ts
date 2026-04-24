import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { runHandler } from '../../../lib/shared/handler-exit.ts';

export type OrderWithProducts = Record<string, unknown> & {
  products: Record<string, unknown>[];
};

export type GetOrderArgs = { id: string };
export type GetOrderDeps = {
  getOrder: (orderId: number) => Promise<Record<string, unknown>>;
};

export type GetOrderResult = {
  data: OrderWithProducts;
  cta: Cta;
};

export const getOrderHandler = async (
  args: GetOrderArgs,
  deps: GetOrderDeps,
): Promise<GetOrderResult> => {
  const order = await deps.getOrder(Number(args.id));
  const products = (order.products ?? []) as Record<string, unknown>[];
  const data: OrderWithProducts = { ...order, products };

  const commands: Cta['commands'] = [
    { command: `get fees ${args.id}`, description: 'View fees for this order' },
    {
      command: `get cart --order-id ${args.id}`,
      description: 'View cart associated with this order',
    },
  ];
  const customerId = order.customer_id;
  if (typeof customerId === 'number' && customerId > 0) {
    commands.push({
      command: `get search --order ${args.id}`,
      description: 'Find the customer who placed this order',
    });
  }

  return { data, cta: { commands } };
};

export const registerGetOrderSubcommand = (parent: Cli.Cli) => {
  parent.command('order', {
    description: 'Get order details by ID',
    args: z.object({
      id: z.string().describe('Order ID'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        getOrderHandler(c.args, {
          getOrder: (orderId) => createBcClient().getOrder(orderId),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
