import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { BcHttpClient } from './bc-http.ts';

const itemSchema = z.object({ id: z.number(), name: z.string() });

let server: ReturnType<typeof Bun.serve>;
let port: number;
let rateLimitAttempts = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === 'PUT' && path.endsWith('/v3/put-echo')) {
        const body = await req.json();
        return Response.json({ echoed: body });
      }

      if (path.endsWith('/v2/always-429')) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'x-rate-limit-time-reset-ms': '1' },
        });
      }

      if (path.endsWith('/v2/rate-limited')) {
        rateLimitAttempts++;
        if (rateLimitAttempts === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'x-rate-limit-time-reset-ms': '1' },
          });
        }
        return Response.json({ id: 1, name: 'Recovered' });
      }

      if (path.endsWith('/v3/widgets')) {
        return Response.json({
          data: [
            { id: 1, name: 'Widget A' },
            { id: 2, name: 'Widget B' },
          ],
          meta: {
            pagination: {
              total: 2,
              count: 2,
              per_page: 250,
              current_page: 1,
              total_pages: 1,
            },
          },
        });
      }

      if (path.endsWith('/v2/store')) {
        return Response.json({ id: 1, name: 'Test Store' });
      }

      if (path.endsWith('/v3/bad-schema')) {
        return Response.json({
          data: [{ wrong: 'shape' }],
          meta: {},
        });
      }

      if (path.endsWith('/v3/empty')) {
        return Response.json({ data: [], meta: {} });
      }

      if (path.endsWith('/v2/not-found')) {
        return new Response('Not Found', { status: 404 });
      }

      if (path.endsWith('/v3/with-params')) {
        const limit = url.searchParams.get('limit');
        const page = url.searchParams.get('page');
        return Response.json({
          data: [{ id: 1, name: `limit=${limit},page=${page}` }],
          meta: {},
        });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  port = server.port ?? 33113;
});

afterAll(() => {
  server.stop();
});

const createClient = () => {
  const client = new BcHttpClient('test-hash', 'test-token');
  Object.defineProperty(client, 'v3', {
    value: `http://localhost:${port}/stores/test-hash/v3`,
    writable: false,
  });
  Object.defineProperty(client, 'v2', {
    value: `http://localhost:${port}/stores/test-hash/v2`,
    writable: false,
  });
  return client;
};

describe('BcHttpClient', () => {
  describe('getV3', () => {
    test('parses paginated response with schema validation', async () => {
      const client = createClient();
      const result = await client.getV3({
        path: '/widgets',
        schema: itemSchema,
      });

      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toEqual({ id: 1, name: 'Widget A' });
      expect(result.meta.pagination?.total).toBe(2);
    });

    test('returns empty data array', async () => {
      const client = createClient();
      const result = await client.getV3({
        path: '/empty',
        schema: itemSchema,
      });

      expect(result.data).toHaveLength(0);
    });

    test('throws on schema mismatch', async () => {
      const client = createClient();

      expect(
        client.getV3({ path: '/bad-schema', schema: itemSchema }),
      ).rejects.toThrow();
    });

    test('passes query params as object', async () => {
      const client = createClient();
      const result = await client.getV3({
        path: '/with-params',
        params: { limit: 10, page: 2 },
        schema: itemSchema,
      });

      expect(result.data[0]?.name).toBe('limit=10,page=2');
    });

    test('skips undefined params', async () => {
      const client = createClient();
      const result = await client.getV3({
        path: '/with-params',
        params: { limit: 10, page: 2, unused: undefined },
        schema: itemSchema,
      });

      expect(result.data[0]?.name).toBe('limit=10,page=2');
    });
  });

  describe('getV2', () => {
    test('parses response with schema validation', async () => {
      const client = createClient();
      const storeSchema = z.object({ id: z.number(), name: z.string() });
      const result = await client.getV2({
        path: '/store',
        schema: storeSchema,
      });

      expect(result).toEqual({ id: 1, name: 'Test Store' });
    });

    test('throws on HTTP error', async () => {
      const client = createClient();
      const schema = z.object({ id: z.number() });

      expect(client.getV2({ path: '/not-found', schema })).rejects.toThrow();
    });
  });

  describe('getV3Raw', () => {
    test('returns raw JSON without schema validation', async () => {
      const client = createClient();
      const result = (await client.getV3Raw({ path: '/bad-schema' })) as {
        data: unknown[];
      };

      expect(result.data).toHaveLength(1);
    });
  });

  describe('putV3Raw', () => {
    test('PUTs JSON body and returns parsed response', async () => {
      const client = createClient();
      const result = await client.putV3Raw<{ echoed: unknown }>({
        path: '/put-echo',
        body: { hello: 'world' },
      });
      expect(result).toEqual({ echoed: { hello: 'world' } });
    });
  });

  describe('getV2Raw', () => {
    test('returns raw JSON', async () => {
      const client = createClient();
      const result = await client.getV2Raw<Record<string, unknown>>({
        path: '/store',
      });
      expect(result).toEqual({ id: 1, name: 'Test Store' });
    });
  });

  describe('getV2NoRetry', () => {
    test('parses on success', async () => {
      const client = createClient();
      const schema = z.object({ id: z.number(), name: z.string() });
      const result = await client.getV2NoRetry({ path: '/store', schema });
      expect(result.id).toBe(1);
    });

    test('does not retry 429 and surfaces error', async () => {
      const client = createClient();
      const schema = z.object({ id: z.number() });
      await expect(
        client.getV2NoRetry({ path: '/always-429', schema }),
      ).rejects.toThrow();
    });
  });

  describe('rate limit retry', () => {
    test('retries on 429 then succeeds', async () => {
      const client = createClient();
      const schema = z.object({ id: z.number(), name: z.string() });
      const result = await client.getV2({ path: '/rate-limited', schema });
      expect(result).toEqual({ id: 1, name: 'Recovered' });
    });
  });

  describe('constructor', () => {
    test('builds correct base URLs', () => {
      const client = new BcHttpClient('my-store', 'my-token');

      expect(client.v3).toBe('https://api.bigcommerce.com/stores/my-store/v3');
      expect(client.v2).toBe('https://api.bigcommerce.com/stores/my-store/v2');
    });
  });
});
