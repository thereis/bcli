import { Cli } from 'incur';
import { registerGetCartSubcommand } from './handlers/cart/get-cart.ts';
import { registerGetCustomerSubcommand } from './handlers/customer/get-customer.ts';
import { registerGetSearchSubcommand } from './handlers/customer/get-search.ts';
import { registerGetFeesSubcommand } from './handlers/order/get-fees.ts';
import { registerGetOrderSubcommand } from './handlers/order/get-order.ts';
import { registerGetOrdersSubcommand } from './handlers/order/get-orders.ts';
import { registerGetProgressSubcommand } from './handlers/progress/get-progress.ts';
import { registerGetFormFieldsSubcommand } from './handlers/store/get-form-fields.ts';

export const registerGetCommand = (cli: Cli.Cli) => {
  const getCli = Cli.create('get', {
    description: 'Read data from BigCommerce',
  });

  registerGetCustomerSubcommand(getCli);
  registerGetOrderSubcommand(getCli);
  registerGetOrdersSubcommand(getCli);
  registerGetCartSubcommand(getCli);
  registerGetFeesSubcommand(getCli);
  registerGetFormFieldsSubcommand(getCli);
  registerGetProgressSubcommand(getCli);
  registerGetSearchSubcommand(getCli);

  cli.command(getCli);
};
