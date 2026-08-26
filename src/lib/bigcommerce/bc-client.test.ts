import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBcClient } from './bc-client.ts';

let server: ReturnType<typeof Bun.serve>;
let port: number;
let routes: Record<
  string,
  (req: Request, url: URL) => Response | Promise<Response>
> = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      const handler = routes[key] ?? routes[url.pathname];
      if (handler) return handler(req, url);
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port ?? 0;
});

afterAll(() => {
  server.stop();
});

afterEach(() => {
  routes = {};
});

const makeClient = () => {
  const bc = createBcClient();
  const base = `http://localhost:${port}/stores/x`;
  (bc.http as unknown as { v3: string; v2: string }).v3 = `${base}/v3`;
  (bc.http as unknown as { v3: string; v2: string }).v2 = `${base}/v2`;
  return bc;
};

const pagination = (
  overrides: Partial<{
    total: number;
    count: number;
    per_page: number;
    current_page: number;
    total_pages: number;
  }> = {},
) => ({
  total: 1,
  count: 1,
  per_page: 250,
  current_page: 1,
  total_pages: 1,
  ...overrides,
});

const customerResp = (customers: unknown[]) =>
  Response.json({
    data: customers,
    meta: {
      pagination: pagination({
        total: customers.length,
        count: customers.length,
      }),
    },
  });

const sampleCustomer = {
  id: 1,
  email: 'a@b.c',
  first_name: 'A',
  last_name: 'B',
  phone: '1',
  addresses: [{ country: 'US' }],
  form_fields: [],
};

describe('getStoreInfo', () => {
  test('returns parsed store info', async () => {
    routes['/stores/x/v2/store'] = () =>
      Response.json({
        id: 'store-1',
        name: 'N',
        domain: 'd',
        plan_name: 'P',
        plan_level: 'L',
        status: 'active',
      });
    const bc = makeClient();
    const info = await bc.getStoreInfo();
    expect(info.name).toBe('N');
  });

  test('401 throws auth error', async () => {
    routes['/stores/x/v2/store'] = () => new Response('nope', { status: 401 });
    const bc = makeClient();
    await expect(bc.getStoreInfo()).rejects.toThrow(/Authentication failed/);
  });

  test('404 throws store-not-found', async () => {
    routes['/stores/x/v2/store'] = () => new Response('nope', { status: 404 });
    const bc = makeClient();
    await expect(bc.getStoreInfo()).rejects.toThrow(/Store not found/);
  });

  test('network failure throws connect error', async () => {
    const bc = createBcClient();
    (bc.http as unknown as { v2: string }).v2 = 'http://127.0.0.1:1/x';
    await expect(bc.getStoreInfo()).rejects.toThrow(/Could not connect/);
  }, 30000);

  test('other HTTP error throws generic API error', async () => {
    routes['/stores/x/v2/store'] = () =>
      new Response('kaboom', { status: 500 });
    const bc = makeClient();
    await expect(bc.getStoreInfo()).rejects.toThrow(/API error 500/);
  });

  test('schema mismatch surfaces the underlying parse error', async () => {
    routes['/stores/x/v2/store'] = () =>
      Response.json({
        id: 42,
        name: 'N',
        domain: 'd',
        plan_name: 'P',
        plan_level: 'L',
        status: 'active',
      });
    const bc = makeClient();
    await expect(bc.getStoreInfo()).rejects.toThrow(
      /Could not connect to BigCommerce API: .+/,
    );
    await expect(bc.getStoreInfo()).rejects.not.toThrow(
      /Check your network\.$/,
    );
  });
});

describe('searchCustomers', () => {
  test('paginates through all pages', async () => {
    let page = 0;
    routes['/stores/x/v3/customers'] = () => {
      page++;
      return Response.json({
        data: [{ ...sampleCustomer, id: page }],
        meta: {
          pagination: pagination({
            total: 2,
            count: 1,
            total_pages: 2,
            current_page: page,
          }),
        },
      });
    };
    const bc = makeClient();
    const customers = await bc.searchCustomers({ email: 'a@b.c' });
    expect(customers).toHaveLength(2);
  });

  test('returns empty when no matches', async () => {
    routes['/stores/x/v3/customers'] = () => customerResp([]);
    const bc = makeClient();
    expect(await bc.searchCustomers({ email: 'x' })).toEqual([]);
  });
});

describe('lookupCustomer', () => {
  test('returns first customer or null', async () => {
    routes['/stores/x/v3/customers'] = () => customerResp([sampleCustomer]);
    const bc = makeClient();
    const c = await bc.lookupCustomer('a@b.c');
    expect(c?.id).toBe(1);
  });

  test('returns null when empty', async () => {
    routes['/stores/x/v3/customers'] = () => customerResp([]);
    const bc = makeClient();
    expect(await bc.lookupCustomer('none')).toBeNull();
  });
});

describe('lookupCustomersByEmails', () => {
  test('GETs /customers with email:in and returns data', async () => {
    routes['/stores/x/v3/customers'] = () => {
      return customerResp([
        sampleCustomer,
        { ...sampleCustomer, id: 2, email: 'd@e.f' },
      ]);
    };
    const bc = makeClient();
    const customers = await bc.lookupCustomersByEmails(['a@b.c', 'd@e.f']);

    expect(customers).toHaveLength(2);
  });

  test('returns empty array for empty input', async () => {
    const bc = makeClient();
    expect(await bc.lookupCustomersByEmails([])).toEqual([]);
  });
});

describe('all-customer export reads', () => {
  test('paces roster and detail requests with one shared delay', async () => {
    const delays: number[] = [];
    const requests: string[] = [];
    routes['/stores/x/v3/customers'] = (_request, url) => {
      const requestedIds = url.searchParams.get('id:in');
      if (requestedIds) {
        requests.push(`details:${requestedIds}`);
        return customerResp(
          requestedIds
            .split(',')
            .map((id) => ({ ...sampleCustomer, id: Number(id) })),
        );
      }

      const page = Number(url.searchParams.get('page'));
      requests.push(`roster:${page}`);
      return Response.json({
        data: [{ id: page }],
        meta: {
          pagination: pagination({
            total: 2,
            count: 1,
            current_page: page,
            total_pages: 2,
          }),
        },
      });
    };

    const bc = createBcClient({
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    const base = `http://localhost:${port}/stores/x`;
    (bc.http as unknown as { v3: string }).v3 = `${base}/v3`;

    const ids = await bc.getAllCustomerIds(undefined, 250);
    await bc.fetchCustomersByIds(ids, 250);

    expect(requests).toEqual(['roster:1', 'roster:2', 'details:1,2']);
    expect(delays).toEqual([250, 250]);
  });

  test('getAllCustomerIds paginates without loading related records', async () => {
    const includes: Array<string | null> = [];
    routes['/stores/x/v3/customers'] = (_request, url) => {
      const page = Number(url.searchParams.get('page'));
      includes.push(url.searchParams.get('include'));
      return Response.json({
        data: [{ id: page }],
        meta: {
          pagination: pagination({
            total: 2,
            count: 1,
            current_page: page,
            total_pages: 2,
          }),
        },
      });
    };

    const bc = makeClient();
    expect(await bc.getAllCustomerIds()).toEqual([1, 2]);
    expect(includes).toEqual([null, null]);
  });

  test('getAllCustomerIds stops after one page for a 100-customer sample', async () => {
    let requests = 0;
    routes['/stores/x/v3/customers'] = (_request, url) => {
      requests++;
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('page')).toBe('1');
      expect(url.searchParams.get('sort')).toBe('date_created:asc');
      return Response.json({
        data: Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })),
        meta: {
          pagination: pagination({
            total: 451_250,
            count: 100,
            per_page: 100,
            current_page: 1,
            total_pages: 4_513,
          }),
        },
      });
    };

    const bc = makeClient();
    expect(await bc.getAllCustomerIds(100)).toHaveLength(100);
    expect(requests).toBe(1);
  });

  test('getAllCustomerIds keeps a stable page size for larger limits', async () => {
    const requests: Array<{ limit: string | null; page: string | null }> = [];
    routes['/stores/x/v3/customers'] = (_request, url) => {
      requests.push({
        limit: url.searchParams.get('limit'),
        page: url.searchParams.get('page'),
      });
      const page = Number(url.searchParams.get('page'));
      return Response.json({
        data: Array.from({ length: 250 }, (_, index) => ({
          id: (page - 1) * 250 + index + 1,
        })),
        meta: {
          pagination: pagination({
            total: 1_000,
            count: 250,
            current_page: page,
            total_pages: 4,
          }),
        },
      });
    };

    const bc = makeClient();
    expect(await bc.getAllCustomerIds(300)).toHaveLength(300);
    expect(requests).toEqual([
      { limit: '250', page: '1' },
      { limit: '250', page: '2' },
    ]);
  });

  test('getAllCustomerIds notifies onPage after each roster page', async () => {
    routes['/stores/x/v3/customers'] = (_request, url) => {
      const page = Number(url.searchParams.get('page'));
      return Response.json({
        data: [{ id: page }],
        meta: {
          pagination: pagination({
            total: 2,
            count: 1,
            current_page: page,
            total_pages: 2,
          }),
        },
      });
    };

    const bc = makeClient();
    const events: Array<{
      page: number;
      totalPages: number;
      ids: number[];
      complete: boolean;
    }> = [];
    expect(
      await bc.getAllCustomerIds(undefined, 0, {
        onPage: (event) => {
          events.push(event);
        },
      }),
    ).toEqual([1, 2]);
    expect(events).toEqual([
      { page: 1, totalPages: 2, ids: [1], complete: false },
      { page: 2, totalPages: 2, ids: [2], complete: true },
    ]);
  });

  test('getAllCustomerIds resumes from startPage with collectedCount', async () => {
    const requested: string[] = [];
    routes['/stores/x/v3/customers'] = (_request, url) => {
      const page = Number(url.searchParams.get('page'));
      requested.push(String(page));
      return Response.json({
        data: [{ id: page }],
        meta: {
          pagination: pagination({
            total: 3,
            count: 1,
            current_page: page,
            total_pages: 3,
          }),
        },
      });
    };

    const bc = makeClient();
    expect(
      await bc.getAllCustomerIds(undefined, 0, {
        startPage: 2,
        collectedCount: 1,
      }),
    ).toEqual([2, 3]);
    expect(requested).toEqual(['2', '3']);
  });

  test('getAllCustomerIds stops a sample using collectedCount', async () => {
    let requests = 0;
    routes['/stores/x/v3/customers'] = (_request, url) => {
      requests++;
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('page')).toBe('2');
      return Response.json({
        data: Array.from({ length: 100 }, (_, index) => ({ id: index + 51 })),
        meta: {
          pagination: pagination({
            total: 451_250,
            count: 100,
            per_page: 100,
            current_page: 2,
            total_pages: 4_513,
          }),
        },
      });
    };

    const bc = makeClient();
    expect(
      await bc.getAllCustomerIds(100, 0, { startPage: 2, collectedCount: 50 }),
    ).toEqual(Array.from({ length: 50 }, (_, index) => index + 51));
    expect(requests).toBe(1);
  });

  test('fetchCustomersByIds splits API requests into groups of 50', async () => {
    const batches: string[] = [];
    routes['/stores/x/v3/customers'] = (_request, url) => {
      const ids = url.searchParams.get('id:in') ?? '';
      batches.push(ids);
      return customerResp(
        ids.split(',').map((id) => ({ ...sampleCustomer, id: Number(id) })),
      );
    };

    const bc = makeClient();
    const ids = Array.from({ length: 60 }, (_, index) => index + 1);
    expect(await bc.fetchCustomersByIds(ids)).toHaveLength(60);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.split(',')).toHaveLength(50);
    expect(batches[1]?.split(',')).toHaveLength(10);
  });

  test('fetchCustomersByIds runs chunks concurrently up to the cap', async () => {
    let inFlight = 0;
    let peak = 0;
    routes['/stores/x/v3/customers'] = async (_request, url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(10);
      inFlight--;
      const ids = url.searchParams.get('id:in') ?? '';
      return customerResp(
        ids.split(',').map((id) => ({ ...sampleCustomer, id: Number(id) })),
      );
    };

    const bc = makeClient();
    const ids = Array.from({ length: 400 }, (_, index) => index + 1);
    const customers = await bc.fetchCustomersByIds(ids, 0, 4);
    expect(customers).toHaveLength(400);
    expect(peak).toBe(4);
  });

  test('fetchCustomerPage requests one hydrated page sorted by id', async () => {
    let seen: URLSearchParams | undefined;
    routes['/stores/x/v3/customers'] = (_request, url) => {
      seen = url.searchParams;
      return Response.json({
        data: [sampleCustomer, { ...sampleCustomer, id: 2 }],
        meta: {
          pagination: pagination({
            total: 3_224_828,
            count: 2,
            current_page: 7,
            total_pages: 12_900,
          }),
        },
      });
    };

    const bc = makeClient();
    const page = await bc.fetchCustomerPage(7);

    expect(page.customers.map((customer) => customer.id)).toEqual([1, 2]);
    expect(page.totalPages).toBe(12_900);
    expect(page.total).toBe(3_224_828);
    expect(seen?.get('page')).toBe('7');
    expect(seen?.get('limit')).toBe('250');
    expect(seen?.get('sort')).toBe('id:asc');
    expect(seen?.get('include')).toBe('addresses,formfields');
  });

  test('fetchCustomerPage honours a smaller page size and paces requests', async () => {
    routes['/stores/x/v3/customers'] = (_request, url) => {
      expect(url.searchParams.get('limit')).toBe('40');
      return Response.json({
        data: [sampleCustomer],
        meta: { pagination: pagination() },
      });
    };

    const delays: number[] = [];
    const bc = createBcClient({
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    (bc.http as unknown as { v3: string }).v3 =
      `http://localhost:${port}/stores/x/v3`;

    await bc.fetchCustomerPage(1, 100, 40);
    await bc.fetchCustomerPage(2, 100, 40);
    expect(delays).toEqual([100]);
  });

  test('fetchCustomerPage falls back when pagination metadata is absent', async () => {
    routes['/stores/x/v3/customers'] = () =>
      Response.json({ data: [sampleCustomer], meta: {} });

    const bc = makeClient();
    const page = await bc.fetchCustomerPage(1);
    expect(page.totalPages).toBe(1);
    expect(page.total).toBe(1);
  });

  test('fetchCustomersByIds stops issuing requests once a chunk fails', async () => {
    let requests = 0;
    routes['/stores/x/v3/customers'] = async (_request, url) => {
      requests++;
      const ids = url.searchParams.get('id:in') ?? '';
      await Bun.sleep(5);
      if (ids.startsWith('101,')) return new Response('boom', { status: 500 });
      return customerResp(
        ids.split(',').map((id) => ({ ...sampleCustomer, id: Number(id) })),
      );
    };

    const bc = makeClient();
    const ids = Array.from({ length: 1_000 }, (_, index) => index + 1);
    await expect(bc.fetchCustomersByIds(ids, 0, 4)).rejects.toThrow();
    expect(requests).toBeLessThan(12);
  });

  test('fetchCustomersByIds keeps chunk order when later chunks finish first', async () => {
    routes['/stores/x/v3/customers'] = async (_request, url) => {
      const ids = url.searchParams.get('id:in') ?? '';
      const first = Number(ids.split(',')[0]);
      await Bun.sleep(first === 1 ? 30 : 1);
      return customerResp(
        ids.split(',').map((id) => ({ ...sampleCustomer, id: Number(id) })),
      );
    };

    const bc = makeClient();
    const ids = Array.from({ length: 150 }, (_, index) => index + 1);
    const customers = await bc.fetchCustomersByIds(ids, 0, 3);
    expect(customers.map((customer) => customer.id)).toEqual(ids);
  });

  test('fetchCustomersByIds defaults to one request at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    routes['/stores/x/v3/customers'] = async (_request, url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      const ids = url.searchParams.get('id:in') ?? '';
      return customerResp(
        ids.split(',').map((id) => ({ ...sampleCustomer, id: Number(id) })),
      );
    };

    const bc = makeClient();
    await bc.fetchCustomersByIds(
      Array.from({ length: 150 }, (_, index) => index + 1),
    );
    expect(peak).toBe(1);
  });

  test('request pacing stays a global rate cap under concurrency', async () => {
    routes['/stores/x/v3/customers'] = async (_request, url) => {
      await Bun.sleep(5);
      const ids = url.searchParams.get('id:in') ?? '';
      return customerResp(
        ids.split(',').map((id) => ({ ...sampleCustomer, id: Number(id) })),
      );
    };

    const delays: number[] = [];
    let sleeping = 0;
    let peakSleeping = 0;
    const bc = createBcClient({
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        sleeping++;
        peakSleeping = Math.max(peakSleeping, sleeping);
        await Bun.sleep(1);
        sleeping--;
      },
    });
    (bc.http as unknown as { v3: string }).v3 =
      `http://localhost:${port}/stores/x/v3`;

    await bc.fetchCustomersByIds(
      Array.from({ length: 400 }, (_, index) => index + 1),
      250,
      4,
    );

    expect(delays).toEqual(Array.from({ length: 7 }, () => 250));
    expect(peakSleeping).toBe(1);
  });

  test('getAllCustomerIds fetches roster pages concurrently after the first', async () => {
    let inFlight = 0;
    let peak = 0;
    routes['/stores/x/v3/customers'] = async (_request, url) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(10);
      inFlight--;
      const page = Number(url.searchParams.get('page'));
      return Response.json({
        data: [{ id: page }],
        meta: {
          pagination: pagination({
            total: 5,
            count: 1,
            current_page: page,
            total_pages: 5,
          }),
        },
      });
    };

    const bc = makeClient();
    const pages: number[] = [];
    const ids = await bc.getAllCustomerIds(undefined, 0, {
      concurrency: 4,
      onPage: (event) => {
        pages.push(event.page);
      },
    });

    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(4);
  });

  test('getAllCustomerIds never over-fetches pages beyond a sample limit', async () => {
    const requested: number[] = [];
    routes['/stores/x/v3/customers'] = (_request, url) => {
      const page = Number(url.searchParams.get('page'));
      requested.push(page);
      return Response.json({
        data: Array.from({ length: 250 }, (_, index) => ({
          id: (page - 1) * 250 + index + 1,
        })),
        meta: {
          pagination: pagination({
            total: 10_000,
            count: 250,
            current_page: page,
            total_pages: 40,
          }),
        },
      });
    };

    const bc = makeClient();
    const ids = await bc.getAllCustomerIds(600, 0, { concurrency: 8 });
    expect(ids).toHaveLength(600);
    expect(requested.sort((left, right) => left - right)).toEqual([1, 2, 3]);
  });

  test('getAllCustomerIds skips fetching when the sample is already collected', async () => {
    let requests = 0;
    routes['/stores/x/v3/customers'] = () => {
      requests++;
      return Response.json({
        data: [{ id: 1 }],
        meta: { pagination: pagination() },
      });
    };

    const bc = makeClient();
    expect(
      await bc.getAllCustomerIds(50, 0, { startPage: 2, collectedCount: 50 }),
    ).toEqual([]);
    expect(requests).toBe(0);
  });

  test('getAllCustomerIds stops a concurrent wave at the last page', async () => {
    const requested: number[] = [];
    routes['/stores/x/v3/customers'] = (_request, url) => {
      const page = Number(url.searchParams.get('page'));
      requested.push(page);
      return Response.json({
        data: [{ id: page }],
        meta: {
          pagination: pagination({
            total: 3,
            count: 1,
            current_page: page,
            total_pages: 3,
          }),
        },
      });
    };

    const bc = makeClient();
    expect(
      await bc.getAllCustomerIds(undefined, 0, { concurrency: 8 }),
    ).toEqual([1, 2, 3]);
    expect(requested.sort((left, right) => left - right)).toEqual([1, 2, 3]);
  });
});

describe('getOrder, getOrderFees, getRecentOrders, getOrdersByEmail', () => {
  test('getOrder combines order + products', async () => {
    routes['/stores/x/v2/orders/100'] = () =>
      Response.json({ id: 100, status: 'complete' });
    routes['/stores/x/v2/orders/100/products'] = () =>
      Response.json([{ sku: 'A' }]);
    const bc = makeClient();
    const order = await bc.getOrder(100);
    expect(order as unknown).toEqual({
      id: 100,
      status: 'complete',
      products: [{ sku: 'A' }],
    });
  });

  test('getOrderFees returns array', async () => {
    routes['/stores/x/v2/orders/1/fees'] = () =>
      Response.json([{ name: 'Tip', amount: '5' }]);
    const bc = makeClient();
    const fees = await bc.getOrderFees(1);
    expect(fees).toHaveLength(1);
  });

  test('getRecentOrders catches errors and returns []', async () => {
    const bc = makeClient();
    const orders = await bc.getRecentOrders(999);
    expect(orders).toEqual([]);
  });

  test('getRecentOrders attaches products per order', async () => {
    routes['/stores/x/v2/orders'] = () =>
      Response.json([{ id: 10 }, { id: 11 }]);
    routes['/stores/x/v2/orders/10/products'] = () =>
      Response.json([{ sku: 'A' }]);
    routes['/stores/x/v2/orders/11/products'] = () =>
      new Response('oops', { status: 500 });
    const bc = makeClient();
    const orders = await bc.getRecentOrders(1);
    expect(orders).toHaveLength(2);
    expect((orders[0] as { products: unknown[] }).products).toHaveLength(1);
    expect((orders[1] as { products: unknown[] }).products).toEqual([]);
  });

  test('getOrdersByEmail handles empty/error', async () => {
    const bc = makeClient();
    expect(await bc.getOrdersByEmail('x@y.z')).toEqual([]);
  });

  test('getOrdersByEmail attaches products', async () => {
    routes['/stores/x/v2/orders'] = () => Response.json([{ id: 20 }]);
    routes['/stores/x/v2/orders/20/products'] = () => Response.json([]);
    const bc = makeClient();
    const orders = await bc.getOrdersByEmail('x@y.z');
    expect(orders).toHaveLength(1);
  });

  test('getOrdersByEmail swallows per-order product errors', async () => {
    routes['/stores/x/v2/orders'] = () => Response.json([{ id: 21 }]);
    routes['/stores/x/v2/orders/21/products'] = () =>
      new Response('boom', { status: 500 });
    const bc = makeClient();
    const orders = await bc.getOrdersByEmail('x@y.z');
    expect(orders).toHaveLength(1);
    expect((orders[0] as { products: unknown[] }).products).toEqual([]);
  });
});

describe('getCart', () => {
  test('returns cart json', async () => {
    routes['/stores/x/v3/carts/abc'] = () =>
      Response.json({ data: { id: 'abc' } });
    const bc = makeClient();
    const cart = await bc.getCart('abc');
    expect(cart).toEqual({ data: { id: 'abc' } });
  });

  test('404 throws specific message', async () => {
    routes['/stores/x/v3/carts/gone'] = () =>
      new Response('no', { status: 404 });
    const bc = makeClient();
    await expect(bc.getCart('gone')).rejects.toThrow(/not found/);
  });

  test('other errors rethrow', async () => {
    routes['/stores/x/v3/carts/bad'] = () =>
      new Response('no', { status: 500 });
    const bc = makeClient();
    await expect(bc.getCart('bad')).rejects.toThrow();
  });

  test('getCartByOrderId resolves cart via order', async () => {
    routes['/stores/x/v2/orders/77'] = () => Response.json({ cart_id: 'c-77' });
    routes['/stores/x/v3/carts/c-77'] = () =>
      Response.json({ data: { id: 'c-77' } });
    const bc = makeClient();
    const cart = await bc.getCartByOrderId(77);
    expect(cart).toEqual({ data: { id: 'c-77' } });
  });

  test('getCartByOrderId throws when order has no cart_id', async () => {
    routes['/stores/x/v2/orders/78'] = () => Response.json({});
    const bc = makeClient();
    await expect(bc.getCartByOrderId(78)).rejects.toThrow(
      /no associated cart_id/,
    );
  });
});

describe('updateWebhook', () => {
  test('PUTs patch to /hooks/:id and returns updated webhook', async () => {
    const updated = {
      id: 5,
      client_id: 'c',
      store_hash: 'h',
      scope: 'store/order/created',
      destination: 'https://example.com',
      is_active: false,
      created_at: 0,
      updated_at: 1,
    };
    routes['PUT /stores/x/v3/hooks/5'] = async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      return Response.json({ data: { ...updated, ...body } });
    };
    const bc = makeClient();
    const result = await bc.updateWebhook(5, { is_active: false });
    expect(result.is_active).toBe(false);
  });
});

describe('deleteWebhook', () => {
  test('sends DELETE to /hooks/:id', async () => {
    let deletedPath = '';
    routes['DELETE /stores/x/v3/hooks/99'] = (_req, url) => {
      deletedPath = url.pathname;
      return new Response(null, { status: 204 });
    };
    const bc = makeClient();
    await bc.deleteWebhook(99);
    expect(deletedPath).toBe('/stores/x/v3/hooks/99');
  });
});

describe('getWebhooks', () => {
  test('returns array of webhooks', async () => {
    routes['/stores/x/v3/hooks'] = () =>
      Response.json({
        data: [
          {
            id: 1,
            client_id: 'abc',
            store_hash: 'xyz',
            scope: 'store/order/created',
            destination: 'https://example.com/hook',
            is_active: true,
            created_at: 1700000000,
            updated_at: 1700000001,
          },
        ],
        meta: { pagination: pagination({ total: 1, count: 1 }) },
      });
    const bc = makeClient();
    const webhooks = await bc.getWebhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.scope).toBe('store/order/created');
  });

  test('returns empty array when no webhooks', async () => {
    routes['/stores/x/v3/hooks'] = () =>
      Response.json({
        data: [],
        meta: { pagination: pagination({ total: 0, count: 0 }) },
      });
    const bc = makeClient();
    expect(await bc.getWebhooks()).toEqual([]);
  });
});

describe('updateCustomerFormField', () => {
  test('PUTs form-field-values', async () => {
    routes['PUT /stores/x/v3/customers/form-field-values'] = async (req) => {
      const body = await req.json();
      return Response.json({ data: body, meta: {} });
    };
    const bc = makeClient();
    const res = (await bc.updateCustomerFormField(1, 'F', 'V')) as {
      data: unknown[];
    };
    expect(res.data).toEqual([{ customer_id: 1, name: 'F', value: 'V' }]);
  });
});

describe('updateCustomerFormFields', () => {
  test('PUTs multiple form-field-values', async () => {
    let capturedBody: unknown = null;
    routes['PUT /stores/x/v3/customers/form-field-values'] = async (req) => {
      capturedBody = await req.json();
      return Response.json({ data: capturedBody, meta: {} });
    };
    const bc = makeClient();
    const updates = [
      { customerId: 1, fieldName: 'F1', value: 'V1' },
      { customerId: 2, fieldName: 'F2', value: 'V2' },
    ];
    await bc.updateCustomersFormField(updates);
    expect(capturedBody).toEqual([
      { customer_id: 1, name: 'F1', value: 'V1' },
      { customer_id: 2, name: 'F2', value: 'V2' },
    ]);
  });

  test('returns empty response for empty updates', async () => {
    const bc = makeClient();
    const res = await bc.updateCustomersFormField([]);
    expect(res).toEqual({ data: [], meta: {} });
  });
});

describe('progress helpers', () => {
  test('cleanProgress deletes the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-'));
    const file = join(dir, 'p.json');
    Bun.write(file, '{}');
    const bc = makeClient();
    bc.cleanProgress(file);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('getCustomerIdsByFormField', () => {
  test('filters matches and paginates via cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-ids-'));
    const progressFile = join(dir, 'prog.json');
    let pass = 0;
    routes['/stores/x/v3/customers/form-field-values'] = () => {
      pass++;
      if (pass === 1) {
        return Response.json({
          data: [
            { name: 'F', value: 'Y', customer_id: 1 },
            { name: 'F', value: 'N', customer_id: 2 },
          ],
          meta: {
            cursor_pagination: {
              count: 2,
              per_page: 250,
              end_cursor: 'xyz',
              links: { next: '?after=xyz' },
            },
            pagination: pagination({ total: 4, count: 2, total_pages: 2 }),
          },
        });
      }
      return Response.json({
        data: [{ name: 'F', value: 'Y', customer_id: 3 }],
        meta: {
          pagination: pagination({ total: 4, count: 1, total_pages: 2 }),
        },
      });
    };
    const bc = makeClient();
    const ids = await bc.getCustomerIdsByFormField('F', 'Y', progressFile);
    expect(ids).toEqual([1]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('follows cursor when page is full', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-cursor-'));
    const progressFile = join(dir, 'p.json');
    let pass = 0;
    const entries = Array.from({ length: 250 }, (_, i) => ({
      name: 'F',
      value: 'Y',
      customer_id: i + 1,
    }));
    routes['/stores/x/v3/customers/form-field-values'] = () => {
      pass++;
      if (pass === 1) {
        return Response.json({
          data: entries,
          meta: {
            cursor_pagination: {
              count: 250,
              per_page: 250,
              end_cursor: 'abc',
              links: { next: '?after=abc' },
            },
            pagination: pagination({ total: 250, count: 250 }),
          },
        });
      }
      return Response.json({
        data: [],
        meta: { pagination: pagination({ total: 250, count: 0 }) },
      });
    };
    const bc = makeClient();
    const ids = await bc.getCustomerIdsByFormField('F', 'Y', progressFile);
    expect(ids).toHaveLength(250);
    rmSync(dir, { recursive: true, force: true });
  });

  test('resumes from saved progress', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-ids2-'));
    const progressFile = join(dir, 'prog.json');
    Bun.write(
      progressFile,
      JSON.stringify({
        pageNum: 1,
        collectedIds: [9],
        processedIdIndex: 0,
      }),
    );
    await Bun.sleep(5);
    routes['/stores/x/v3/customers/form-field-values'] = () =>
      Response.json({
        data: [{ name: 'F', value: 'Y', customer_id: 10 }],
        meta: { pagination: pagination({ total: 1, count: 1 }) },
      });
    const bc = makeClient();
    const ids = await bc.getCustomerIdsByFormField('F', 'Y', progressFile);
    expect(ids).toEqual([9, 10]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('getCustomersByIds', () => {
  test('batches and invokes callback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-byids-'));
    const progressFile = join(dir, 'p.json');
    routes['/stores/x/v3/customers'] = () =>
      customerResp([sampleCustomer, { ...sampleCustomer, id: 2 }]);
    const bc = makeClient();
    const collected: number[] = [];
    const count = await bc.getCustomersByIds([1, 2], progressFile, (c) =>
      collected.push(c.id),
    );
    expect(count).toBe(2);
    expect(collected).toEqual([1, 2]);
    rmSync(dir, { recursive: true, force: true });
  });

  test('resumes from processedIdIndex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bc-byids2-'));
    const progressFile = join(dir, 'p.json');
    Bun.write(
      progressFile,
      JSON.stringify({
        pageNum: 0,
        collectedIds: [1, 2],
        processedIdIndex: 50,
      }),
    );
    await Bun.sleep(5);
    routes['/stores/x/v3/customers'] = () =>
      customerResp([{ ...sampleCustomer, id: 51 }]);
    const bc = makeClient();
    const ids = Array.from({ length: 60 }, (_, i) => i + 1);
    const collected: number[] = [];
    await bc.getCustomersByIds(ids, progressFile, (c) => collected.push(c.id));
    expect(collected).toContain(51);
    rmSync(dir, { recursive: true, force: true });
  });
});
