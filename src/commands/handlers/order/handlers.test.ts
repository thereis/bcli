import { describe, expect, test } from 'bun:test';
import type { HandlerExitError } from '../../../lib/shared/handler-exit.ts';
import { getFeesHandler, registerGetFeesSubcommand } from './get-fees.ts';
import {
  getOrderHandler,
  type OrderWithProducts,
  registerGetOrderSubcommand,
} from './get-order.ts';
import { getOrdersHandler, registerGetOrdersSubcommand } from './get-orders.ts';

describe('getOrderHandler', () => {
  test('fetches and returns the order with products', async () => {
    const order = { id: 1, status: 'complete', products: [{ sku: 'X' }] };
    const result = await getOrderHandler(
      { id: '1' },
      { getOrder: async () => order },
    );
    expect(result.data).toEqual(order);
    expect(result.cta.commands.length).toBeGreaterThan(0);
  });

  test('defaults products to [] when missing', async () => {
    const order = { id: 1, status: 'ok' } as Record<string, unknown>;
    const result = await getOrderHandler(
      { id: '1' },
      { getOrder: async () => order },
    );
    expect(result.data).toEqual({ ...order, products: [] });
  });

  test('CTA includes customer search when order has customer_id', async () => {
    const order = { id: 1, customer_id: 99, products: [] };
    const result = await getOrderHandler(
      { id: '1' },
      { getOrder: async () => order },
    );
    const kinds = result.cta.commands.map((c) => c.command);
    expect(kinds.some((k) => k.startsWith('get search'))).toBe(true);
  });
});

describe('getFeesHandler', () => {
  test('returns fees when they exist', async () => {
    const fees = [{ name: 'Tip', type: 'custom', amount: '5', tax: '0' }];
    const result = await getFeesHandler(
      { id: '10' },
      { getOrderFees: async () => fees },
    );
    expect(result.data).toEqual(fees);
    expect(result.cta.commands[0]?.command).toBe('get order 10');
  });

  test('returns empty array when no fees', async () => {
    const result = await getFeesHandler(
      { id: '10' },
      { getOrderFees: async () => [] },
    );
    expect(result.data).toEqual([]);
  });

  test('throws on lookup failure', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getFeesHandler(
        { id: '10' },
        {
          getOrderFees: async () => {
            throw new Error('404');
          },
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('404');
  });
});

describe('getOrdersHandler', () => {
  const orders: OrderWithProducts[] = [
    {
      id: 1,
      status: 'complete',
      date_created: '2026-01-01',
      products: [{ sku: 'A' }],
    },
  ];

  test('returns list when matches', async () => {
    const result = await getOrdersHandler(
      { email: 'a@b.c', limit: 10 },
      { getOrdersByEmail: async () => orders },
    );
    expect(result.data).toEqual(orders);
    expect(result.cta.commands.length).toBeGreaterThan(0);
  });

  test('exits 0 when no orders (info)', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getOrdersHandler(
        { email: 'none@x.y', limit: 10 },
        { getOrdersByEmail: async () => [] },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.code).toBe(0);
    expect(caught?.kind).toBe('info');
  });

  test('throws on fetch error', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getOrdersHandler(
        { email: 'a@b.c', limit: 10 },
        {
          getOrdersByEmail: async () => {
            throw new Error('boom');
          },
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('boom');
  });
});

describe('registrars', () => {
  test('each subcommand registers against parent', () => {
    const calls: string[] = [];
    const fakeParent = {
      command: (name: string) => {
        calls.push(name);
      },
    } as unknown as Parameters<typeof registerGetOrderSubcommand>[0];
    registerGetOrderSubcommand(fakeParent);
    registerGetOrdersSubcommand(fakeParent);
    registerGetFeesSubcommand(fakeParent);
    expect(calls).toEqual(['order', 'orders', 'fees']);
  });
});
