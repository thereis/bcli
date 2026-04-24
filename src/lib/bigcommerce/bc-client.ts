import { env } from '../config/env.ts';
import { logger } from '../shared/logger.ts';
import {
  loadProgress,
  removeProgress,
  saveProgress,
} from '../shared/progress.ts';
import { BcHttpClient } from './bc-http.ts';
import {
  type Customer,
  customerSchema,
  formFieldValueSchema,
  type StoreInfo,
  storeInfoSchema,
} from './schemas.ts';

export type SearchFilters = {
  id?: number;
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
};

const LIMIT = 250;
const ID_BATCH_LIMIT = 50;

export const createBcClient = () => {
  const http = new BcHttpClient(env.BC_STORE_HASH, env.BC_ACCESS_TOKEN);

  const getStoreInfo = async (): Promise<StoreInfo> => {
    return http
      .getV2({ path: '/store', schema: storeInfoSchema })
      .catch((error) => {
        const res = (
          error as { response?: { statusCode: number; body: unknown } }
        )?.response;
        if (res?.statusCode === 401)
          throw new Error('Authentication failed. Check your BC_ACCESS_TOKEN.');
        if (res?.statusCode === 404)
          throw new Error('Store not found. Check your BC_STORE_HASH.');
        if (res) throw new Error(`API error ${res.statusCode}: ${res.body}`);
        const cause = (error as Error)?.message ?? String(error);
        throw new Error(`Could not connect to BigCommerce API: ${cause}`);
      });
  };

  const searchCustomers = async (
    filters: SearchFilters,
  ): Promise<Customer[]> => {
    const allCustomers: Customer[] = [];
    let page = 1;

    while (true) {
      const json = await http.getV3({
        path: '/customers',
        params: {
          limit: LIMIT,
          page,
          include: 'addresses,formfields',
          'id:in': filters.id,
          'email:in': filters.email,
          'name:in': filters.name,
          'name:like': filters.nameLike,
          'phone:in': filters.phone,
          'company:in': filters.company,
          'company:like': filters.companyLike,
          'customer_group_id:in': filters.customerGroupId,
          'date_created:min': filters.dateCreatedMin,
          'date_created:max': filters.dateCreatedMax,
          'date_modified:min': filters.dateModifiedMin,
          'date_modified:max': filters.dateModifiedMax,
          'registration_ip_address:in': filters.registrationIpAddress,
          sort: filters.sort,
        },
        schema: customerSchema,
      });

      allCustomers.push(...json.data);

      const totalPages = json.meta.pagination?.total_pages ?? 1;
      logger.debug(
        `Page ${page}/${totalPages} | ${allCustomers.length} customers found`,
      );

      if (page >= totalPages) break;
      page++;
    }

    return allCustomers;
  };

  const lookupCustomer = async (email: string): Promise<Customer | null> => {
    const json = await http.getV3({
      path: '/customers',
      params: { 'email:in': email, include: 'addresses,formfields' },
      schema: customerSchema,
    });
    return json.data[0] ?? null;
  };

  const getCustomerIdsByFormField = async (
    fieldName: string,
    value: string,
    progressFile: string,
  ): Promise<number[]> => {
    const prev = loadProgress(progressFile);
    const customerIds: number[] = prev?.collectedIds ?? [];
    let cursor: string | undefined = prev?.cursor;
    let pageNum = prev?.pageNum ?? 0;

    if (prev) {
      logger.debug(
        `Resuming from page ${pageNum} (${customerIds.length} IDs already collected)`,
      );
    }

    while (true) {
      saveProgress(progressFile, {
        cursor,
        pageNum,
        collectedIds: customerIds,
        processedIdIndex: 0,
      });

      const json = await http.getV3({
        path: '/customers/form-field-values',
        params: {
          field_name: fieldName,
          limit: LIMIT,
          after: cursor,
        },
        schema: formFieldValueSchema,
      });
      const { data, meta } = json;

      pageNum++;

      for (const entry of data) {
        if (entry.value === value && entry.customer_id > 0) {
          customerIds.push(entry.customer_id);
        }
      }

      const total = meta.pagination?.total ?? '?';
      const totalPages = meta.pagination?.total_pages ?? '?';
      if (typeof totalPages === 'number' && totalPages > 1) {
        const pct = Math.round((pageNum / totalPages) * 100);
        logger.info(
          `Page ${pageNum}/${totalPages} (${pct}%) | ${customerIds.length} matches so far`,
        );
      }
      logger.debug(
        `Page ${pageNum}/${totalPages} | ${customerIds.length} matches (${total} total entries)`,
      );

      const nextLink = meta.cursor_pagination?.links?.next;
      if (!nextLink || data.length < LIMIT) break;

      const nextParams = new URLSearchParams(nextLink.replace(/^\?/, ''));
      cursor = nextParams.get('after') ?? undefined;
    }

    saveProgress(progressFile, {
      pageNum,
      collectedIds: customerIds,
      processedIdIndex: 0,
    });

    return customerIds;
  };

  const getCustomersByIds = async (
    ids: number[],
    progressFile: string,
    onCustomer: (customer: Customer) => void,
  ): Promise<number> => {
    const prev = loadProgress(progressFile);
    const startIndex = prev?.processedIdIndex ?? 0;
    let count = 0;

    if (startIndex > 0) {
      logger.debug(
        `Resuming from index ${startIndex} (${startIndex} IDs already processed)`,
      );
    }

    for (let i = startIndex; i < ids.length; i += ID_BATCH_LIMIT) {
      saveProgress(progressFile, {
        ...(prev ?? { pageNum: 0, collectedIds: ids, processedIdIndex: 0 }),
        processedIdIndex: i,
      });

      const batch = ids.slice(i, i + ID_BATCH_LIMIT);
      const json = await http.getV3({
        path: '/customers',
        params: {
          'id:in': batch.join(','),
          include: 'addresses,formfields',
          limit: ID_BATCH_LIMIT,
        },
        schema: customerSchema,
      });

      for (const customer of json.data) {
        onCustomer(customer);
        count++;
      }

      const batchNum = Math.floor(i / ID_BATCH_LIMIT) + 1;
      const totalBatches = Math.ceil(ids.length / ID_BATCH_LIMIT);
      if (totalBatches > 1) {
        const pct = Math.round((batchNum / totalBatches) * 100);
        logger.info(
          `Batch ${batchNum}/${totalBatches} (${pct}%) | ${startIndex + count}/${ids.length} customers`,
        );
      }
      logger.debug(
        `Batch ${batchNum}/${totalBatches} (${startIndex + count} customers processed)`,
      );
    }

    return count;
  };

  const getOrder = async (orderId: number) => {
    const order = await http.getV2Raw<Record<string, unknown>>({
      path: `/orders/${orderId}`,
    });
    const products = await http.getV2Raw<Record<string, unknown>[]>({
      path: `/orders/${orderId}/products`,
    });
    return { ...order, products };
  };

  const getOrderFees = async (orderId: number) => {
    return http.getV2Raw<Record<string, unknown>[]>({
      path: `/orders/${orderId}/fees`,
    });
  };

  const getRecentOrders = async (customerId: number, limit = 10) => {
    const orders = await http
      .getV2Raw<Record<string, unknown>[]>({
        path: '/orders',
        params: {
          customer_id: customerId,
          limit,
          sort: 'date_created:desc',
        },
      })
      .catch(() => [] as Record<string, unknown>[]);

    const ordersWithProducts = await Promise.all(
      orders.map(async (order) => {
        const products = await http
          .getV2Raw<Record<string, unknown>[]>({
            path: `/orders/${order.id}/products`,
          })
          .catch(() => [] as Record<string, unknown>[]);
        return { ...order, products };
      }),
    );

    return ordersWithProducts;
  };

  const getOrdersByEmail = async (email: string, limit = 50) => {
    const orders = await http
      .getV2Raw<Record<string, unknown>[]>({
        path: '/orders',
        params: { email, limit, sort: 'date_created:desc' },
      })
      .catch(() => [] as Record<string, unknown>[]);

    const ordersWithProducts = await Promise.all(
      orders.map(async (order) => {
        const products = await http
          .getV2Raw<Record<string, unknown>[]>({
            path: `/orders/${order.id}/products`,
          })
          .catch(() => [] as Record<string, unknown>[]);
        return { ...order, products };
      }),
    );

    return ordersWithProducts;
  };

  const getCart = async (cartId: string) => {
    return http.getV3Raw({ path: `/carts/${cartId}` }).catch((err) => {
      const status = (err as { response?: { statusCode: number } })?.response
        ?.statusCode;
      if (status === 404)
        throw new Error(
          `Cart ${cartId} not found. Completed orders have their carts removed.`,
        );
      throw err;
    });
  };

  const getCartByOrderId = async (orderId: number) => {
    const order = await http.getV2Raw<Record<string, unknown>>({
      path: `/orders/${orderId}`,
    });
    const cartId = order.cart_id as string | undefined;
    if (!cartId) throw new Error(`Order ${orderId} has no associated cart_id`);
    return getCart(cartId);
  };

  const updateCustomerFormField = async (
    customerId: number,
    fieldName: string,
    value: string,
  ) => {
    return http.putV3Raw<{ data: unknown; meta: unknown }>({
      path: '/customers/form-field-values',
      body: [{ customer_id: customerId, name: fieldName, value }],
    });
  };

  const cleanProgress = (path: string) => removeProgress(path);

  return {
    http,
    getStoreInfo,
    searchCustomers,
    lookupCustomer,
    getCustomerIdsByFormField,
    getCustomersByIds,
    getOrder,
    getOrderFees,
    getRecentOrders,
    getOrdersByEmail,
    getCart,
    getCartByOrderId,
    updateCustomerFormField,
    cleanProgress,
  };
};
