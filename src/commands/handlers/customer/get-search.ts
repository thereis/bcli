import { type Cli, z } from 'incur';
import {
  createBcClient,
  type SearchFilters,
} from '../../../lib/bigcommerce/bc-client.ts';
import type { Customer } from '../../../lib/bigcommerce/schemas.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import {
  exitWithError,
  exitWithInfo,
  runHandler,
} from '../../../lib/shared/handler-exit.ts';

type OrderWithProducts = Record<string, unknown> & {
  products: Record<string, unknown>[];
};

export type GetSearchOptions = {
  email?: string;
  name?: string;
  nameLike?: string;
  phone?: string;
  company?: string;
  companyLike?: string;
  customerGroupId?: number;
  dateCreatedMin?: string;
  dateCreatedMax?: string;
  dateModifiedMin?: string;
  dateModifiedMax?: string;
  registrationIpAddress?: string;
  sort?: string;
  order?: string;
};

export type GetSearchDeps = {
  searchCustomers: (filters: SearchFilters) => Promise<Customer[]>;
  getOrder: (orderId: number) => Promise<Record<string, unknown>>;
  getRecentOrders: (customerId: number) => Promise<OrderWithProducts[]>;
};

export const hasAnySearchFilter = (options: GetSearchOptions): boolean =>
  Boolean(
    options.email ||
      options.name ||
      options.nameLike ||
      options.phone ||
      options.company ||
      options.companyLike ||
      options.customerGroupId ||
      options.dateCreatedMin ||
      options.dateCreatedMax ||
      options.dateModifiedMin ||
      options.dateModifiedMax ||
      options.registrationIpAddress ||
      options.order,
  );

export type SearchResult = Customer & { recent_orders: OrderWithProducts[] };

export type GetSearchResult = {
  data: SearchResult[];
  cta: Cta;
};

export const getSearchHandler = async (
  options: GetSearchOptions,
  deps: GetSearchDeps,
): Promise<GetSearchResult> => {
  if (!hasAnySearchFilter(options)) {
    exitWithError(
      'At least one filter is required (--email, --name, --name-like, --phone, --company, --company-like, --customer-group-id, --date-created-min, --date-created-max, --date-modified-min, --date-modified-max, --registration-ip-address, or --order).',
    );
  }

  let customers: Customer[];

  if (options.order) {
    const [orderError, order] = await handlePromise(
      deps.getOrder(Number(options.order)),
    );
    if (orderError) {
      exitWithError(`Error: ${orderError.message}`);
    }
    const customerId = (order as Record<string, unknown>).customer_id as number;
    if (!customerId) {
      exitWithInfo('Order has no associated customer.', 0);
    }
    const [custError, custResult] = await handlePromise(
      deps.searchCustomers({ id: customerId }),
    );
    if (custError) {
      exitWithError(`Error: ${custError.message}`);
    }
    customers = custResult as Customer[];
  } else {
    const [error, result] = await handlePromise(
      deps.searchCustomers({
        email: options.email,
        name: options.name,
        nameLike: options.nameLike,
        phone: options.phone,
        company: options.company,
        companyLike: options.companyLike,
        customerGroupId: options.customerGroupId,
        dateCreatedMin: options.dateCreatedMin,
        dateCreatedMax: options.dateCreatedMax,
        dateModifiedMin: options.dateModifiedMin,
        dateModifiedMax: options.dateModifiedMax,
        registrationIpAddress: options.registrationIpAddress,
        sort: options.sort,
      }),
    );
    if (error) {
      exitWithError(`Error: ${error.message}`);
    }
    customers = result as Customer[];
  }

  if (customers.length === 0) {
    exitWithInfo('No customers found matching the given filters.', 0);
  }

  const orders = new Map<number, OrderWithProducts[]>();
  for (const customer of customers) {
    const [, customerOrders] = await handlePromise(
      deps.getRecentOrders(customer.id),
    );
    if (customerOrders) {
      orders.set(customer.id, customerOrders);
    }
  }

  const data: SearchResult[] = customers.map((c) => ({
    ...c,
    recent_orders: orders.get(c.id) ?? [],
  }));

  const commands: Cta['commands'] = data.slice(0, 3).map((c) => ({
    command: `get customer --email ${c.email}`,
    description: `View ${c.email} in detail`,
  }));
  const firstOrder = data[0]?.recent_orders[0];
  if (firstOrder?.id) {
    commands.push({
      command: `get order ${firstOrder.id}`,
      description: 'View the most recent order',
    });
  }

  return { data, cta: { commands } };
};

export const registerGetSearchSubcommand = (parent: Cli.Cli) => {
  parent.command('search', {
    description:
      'Search customers with filters (email, name, phone, company, group, dates, IP, or order ID)',
    options: z.object({
      email: z.string().optional().describe('Filter by email (exact match)'),
      name: z
        .string()
        .optional()
        .describe('Filter by name (exact match on "first last")'),
      nameLike: z
        .string()
        .optional()
        .describe('Filter by name (partial match)'),
      phone: z.string().optional().describe('Filter by phone (exact match)'),
      company: z
        .string()
        .optional()
        .describe('Filter by company (exact match)'),
      companyLike: z
        .string()
        .optional()
        .describe('Filter by company (partial match)'),
      customerGroupId: z.coerce
        .number()
        .optional()
        .describe('Filter by customer group ID'),
      dateCreatedMin: z
        .string()
        .optional()
        .describe(
          'Customers created after this date (RFC 3339, e.g. 2025-01-01T00:00:00Z)',
        ),
      dateCreatedMax: z
        .string()
        .optional()
        .describe('Customers created before this date (RFC 3339)'),
      dateModifiedMin: z
        .string()
        .optional()
        .describe('Customers modified after this date (RFC 3339)'),
      dateModifiedMax: z
        .string()
        .optional()
        .describe('Customers modified before this date (RFC 3339)'),
      registrationIpAddress: z
        .string()
        .optional()
        .describe('Filter by registration IP address'),
      sort: z
        .string()
        .optional()
        .describe(
          'Sort field: date_created:asc, date_created:desc, date_modified:asc, date_modified:desc, last_name:asc, last_name:desc',
        ),
      order: z.string().optional().describe('Find customer by order ID'),
    }),
    async run(c) {
      const bc = createBcClient();
      const result = await runHandler(() =>
        getSearchHandler(c.options, {
          searchCustomers: (filters) => bc.searchCustomers(filters),
          getOrder: (id) => bc.getOrder(id),
          getRecentOrders: (id) =>
            bc.getRecentOrders(id) as Promise<OrderWithProducts[]>,
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
