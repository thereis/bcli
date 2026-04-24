import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { testStoreConnection } from './test-store-connection.ts';

const originalFetch = globalThis.fetch;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;

const stubFetch = (impl: FetchStub) => {
  globalThis.fetch = impl as typeof fetch;
};

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('testStoreConnection', () => {
  test('returns error on network failure', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));
    const [err, info] = await testStoreConnection('hash', 'token');
    expect(info).toBeNull();
    expect(err?.message).toMatch(/Could not connect/);
  });

  test('returns auth error on 401', async () => {
    stubFetch(() => Promise.resolve(new Response('no', { status: 401 })));
    const [err, info] = await testStoreConnection('hash', 'token');
    expect(info).toBeNull();
    expect(err?.message).toMatch(/Authentication failed/);
  });

  test('returns store-not-found on 404', async () => {
    stubFetch(() => Promise.resolve(new Response('no', { status: 404 })));
    const [err, info] = await testStoreConnection('hash', 'token');
    expect(info).toBeNull();
    expect(err?.message).toMatch(/Store not found/);
  });

  test('returns generic API error on other non-ok status', async () => {
    stubFetch(() => Promise.resolve(new Response('boom', { status: 500 })));
    const [err, info] = await testStoreConnection('hash', 'token');
    expect(info).toBeNull();
    expect(err?.message).toMatch(/API error 500: boom/);
  });

  test('returns parsed store info on success', async () => {
    const store = { name: 'Acme', domain: 'acme.mybigcommerce.com' };
    stubFetch((url, init) => {
      expect(url).toBe('https://api.bigcommerce.com/stores/h/v2/store');
      expect((init?.headers as Record<string, string>)['X-Auth-Token']).toBe(
        't',
      );
      return Promise.resolve(Response.json(store));
    });
    const [err, info] = await testStoreConnection('h', 't');
    expect(err).toBeNull();
    expect(info).toEqual(store as never);
  });
});
