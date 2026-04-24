import { describe, expect, test } from 'bun:test';
import { HandlerExitError } from '../../../lib/shared/handler-exit.ts';
import { getCartHandler, registerGetCartSubcommand } from './get-cart.ts';

const sampleCart = {
  data: {
    id: 'abc-123',
    customer_id: 42,
    created_time: '2026-01-01',
    updated_time: '2026-01-02',
    line_items: {
      physical_items: [{ name: 'Widget', quantity: 2, sku: 'W-1' }],
    },
  },
};

describe('getCartHandler', () => {
  test('looks up by cart ID (UUID)', async () => {
    const calls: { kind: string; value: unknown }[] = [];
    const result = await getCartHandler(
      { id: 'abc-def-123' },
      {},
      {
        getCart: async (id) => {
          calls.push({ kind: 'cart', value: id });
          return sampleCart;
        },
        getCartByOrderId: async () => {
          throw new Error('should not call');
        },
      },
    );
    expect(calls).toEqual([{ kind: 'cart', value: 'abc-def-123' }]);
    expect(result.data).toEqual(sampleCart);
    expect(result.cta.commands).toEqual([]);
  });

  test('looks up by numeric id (treated as order ID) and emits CTA', async () => {
    const calls: { kind: string; value: unknown }[] = [];
    const result = await getCartHandler(
      { id: '12345' },
      {},
      {
        getCart: async () => {
          throw new Error('should not call');
        },
        getCartByOrderId: async (id) => {
          calls.push({ kind: 'order', value: id });
          return sampleCart;
        },
      },
    );
    expect(calls).toEqual([{ kind: 'order', value: 12345 }]);
    expect(result.cta.commands[0]?.command).toBe('get order 12345');
  });

  test('looks up by --order-id option', async () => {
    const calls: { kind: string; value: unknown }[] = [];
    const result = await getCartHandler(
      {},
      { orderId: 777 },
      {
        getCart: async () => {
          throw new Error('should not call');
        },
        getCartByOrderId: async (id) => {
          calls.push({ kind: 'order', value: id });
          return sampleCart;
        },
      },
    );
    expect(calls).toEqual([{ kind: 'order', value: 777 }]);
    expect(result.cta.commands[0]?.command).toBe('get order 777');
  });

  test('throws when no id or orderId provided', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getCartHandler(
        {},
        {},
        {
          getCart: async () => ({}),
          getCartByOrderId: async () => ({}),
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught).toBeInstanceOf(HandlerExitError);
    expect(caught?.message).toContain('Provide a cart ID');
  });

  test('throws on lookup failure', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getCartHandler(
        { id: 'abc' },
        {},
        {
          getCart: async () => {
            throw new Error('cart not found');
          },
          getCartByOrderId: async () => ({}),
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('cart not found');
  });
});

test('cart handler registrar is a function', () => {
  expect(typeof registerGetCartSubcommand).toBe('function');
});
