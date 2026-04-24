import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Customer } from '../../../lib/bigcommerce/schemas.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { exitWithInfo, runHandler } from '../../../lib/shared/handler-exit.ts';

export type GetCustomerArgs = { email: string };
export type GetCustomerDeps = {
  lookupCustomer: (email: string) => Promise<Customer | null>;
};

export type GetCustomerResult = {
  data: Customer;
  cta: Cta;
};

export const getCustomerHandler = async (
  args: GetCustomerArgs,
  deps: GetCustomerDeps,
): Promise<GetCustomerResult> => {
  const found = await deps.lookupCustomer(args.email);
  if (!found) {
    exitWithInfo(`No customer found with email "${args.email}"`, 1);
  }
  const customer = found as Customer;
  return {
    data: customer,
    cta: {
      commands: [
        {
          command: `get orders --email ${args.email}`,
          description: 'View recent orders for this customer',
        },
        {
          command: `get search --email ${args.email}`,
          description: 'Full search view with recent orders attached',
        },
      ],
    },
  };
};

export const registerGetCustomerSubcommand = (parent: Cli.Cli) => {
  parent.command('customer', {
    description: 'Look up a customer by email',
    args: z.object({
      email: z.string().describe('Customer email address'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        getCustomerHandler(c.args, {
          lookupCustomer: (email) => createBcClient().lookupCustomer(email),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
