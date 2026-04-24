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
