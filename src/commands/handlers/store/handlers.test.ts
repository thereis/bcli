import { describe, expect, mock, test } from 'bun:test';
import type { StoreInfo } from '../../../lib/bigcommerce/schemas.ts';
import type { FormField } from '../../../lib/config/form-fields.ts';
import { HandlerExitError } from '../../../lib/shared/handler-exit.ts';

mock.module('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(''),
    close: () => {},
  }),
}));
mock.module('../../../lib/config/form-fields-wizard.ts', () => ({
  collectFormFields: async (
    _rl: unknown,
    existing: unknown,
    _hash: string,
    _token: string,
    _verbose: boolean,
  ) => existing,
}));

import {
  checkConnectionHandler,
  registerCheckConnectionSubcommand,
} from './check-connection.ts';
import {
  deleteWebhookHandler,
  registerDeleteWebhookSubcommand,
} from './delete-webhook.ts';
import {
  getFormFieldsHandler,
  registerGetFormFieldsSubcommand,
} from './get-form-fields.ts';
import {
  getWebhooksHandler,
  registerGetWebhooksSubcommand,
} from './get-webhooks.ts';
import {
  collectViaReadline,
  registerUpdateFormFieldsSubcommand,
  updateFormFieldsHandler,
} from './update-form-fields.ts';
import {
  registerUpdateWebhookSubcommand,
  updateWebhookHandler,
} from './update-webhook.ts';

const store: StoreInfo = {
  id: 'acme-hash',
  name: 'Acme',
  domain: 'acme.mybigcommerce.com',
  plan_name: 'Standard',
  plan_level: '1',
  status: 'active',
};

describe('checkConnectionHandler', () => {
  test('returns store info on success', async () => {
    const result = await checkConnectionHandler({
      getStoreInfo: async () => store,
    });
    expect(result.data).toEqual(store);
    expect(result.cta.commands.length).toBeGreaterThan(0);
  });

  test('throws HandlerExitError on 401', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await checkConnectionHandler({
        getStoreInfo: async () => {
          throw new Error('Authentication failed. Check your BC_ACCESS_TOKEN.');
        },
      });
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught).toBeInstanceOf(HandlerExitError);
    expect(caught?.code).toBe(1);
    expect(caught?.message).toContain('Authentication failed');
  });

  test('throws HandlerExitError on network error', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await checkConnectionHandler({
        getStoreInfo: async () => {
          throw new Error('Could not connect to BigCommerce API.');
        },
      });
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught).toBeInstanceOf(HandlerExitError);
    expect(caught?.message).toContain('Could not connect');
  });
});

describe('getFormFieldsHandler', () => {
  const sampleFields = [
    { name: 'EmailAddress', type: 'text', private_id: 1, required: true },
    { name: 'Phone Verified', type: 'radiobuttons', required: false },
  ];

  test('filters built-in fields when all=false', async () => {
    const result = await getFormFieldsHandler(
      { all: false, raw: false },
      { fetchFields: async () => [null, { data: sampleFields, raw: {} }] },
    );
    expect(result.data).toEqual({
      formFields: [
        {
          name: 'Phone Verified',
          type: 'string',
          bcType: 'radiobuttons',
          options: undefined,
          builtIn: false,
          required: false,
        },
      ],
    });
  });

  test('includes built-ins when all=true', async () => {
    const result = await getFormFieldsHandler(
      { all: true, raw: false },
      { fetchFields: async () => [null, { data: sampleFields, raw: {} }] },
    );
    expect((result.data as { formFields: unknown[] }).formFields).toHaveLength(
      2,
    );
  });

  test('returns raw payload when raw=true', async () => {
    const raw = { hello: 'world' };
    const result = await getFormFieldsHandler(
      { all: false, raw: true },
      { fetchFields: async () => [null, { data: sampleFields, raw }] },
    );
    expect(result.data).toEqual({ raw });
  });

  test('returns empty array when no fields visible', async () => {
    const result = await getFormFieldsHandler(
      { all: false, raw: false },
      { fetchFields: async () => [null, { data: [], raw: [] }] },
    );
    expect(result.data).toEqual({ formFields: [] });
  });

  test('throws HandlerExitError when fetch fails', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getFormFieldsHandler(
        { all: false, raw: false },
        { fetchFields: async () => [new Error('boom'), null] },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught).toBeInstanceOf(HandlerExitError);
    expect(caught?.message).toContain('boom');
  });
});

describe('updateWebhookHandler', () => {
  const sampleWebhook = {
    id: 1,
    client_id: 'abc',
    store_hash: 'xyz',
    scope: 'store/order/created',
    destination: 'https://example.com/hook',
    is_active: false,
    created_at: 1700000000,
    updated_at: 1700000002,
  };

  test('sets is_active to false', async () => {
    const patches: unknown[] = [];
    const result = await updateWebhookHandler(
      { id: '1' },
      { is_active: 'false' },
      {
        updateWebhook: async (_id, patch) => {
          patches.push(patch);
          return sampleWebhook;
        },
      },
    );
    expect(patches).toEqual([{ is_active: false }]);
    expect(result.data.is_active).toBe(false);
    expect(result.cta.commands).toHaveLength(1);
  });

  test('sets is_active to true', async () => {
    const result = await updateWebhookHandler(
      { id: '1' },
      { is_active: 'true' },
      { updateWebhook: async () => ({ ...sampleWebhook, is_active: true }) },
    );
    expect(result.data.is_active).toBe(true);
  });

  test('throws on invalid id', async () => {
    await expect(
      updateWebhookHandler(
        { id: 'bad' },
        { is_active: 'false' },
        { updateWebhook: async () => sampleWebhook },
      ),
    ).rejects.toThrow('Invalid webhook ID');
  });

  test('throws on invalid --active value', async () => {
    await expect(
      updateWebhookHandler(
        { id: '1' },
        { is_active: 'maybe' },
        { updateWebhook: async () => sampleWebhook },
      ),
    ).rejects.toThrow('--is_active must be');
  });

  test('propagates API errors', async () => {
    await expect(
      updateWebhookHandler(
        { id: '1' },
        { is_active: 'false' },
        {
          updateWebhook: async () => {
            throw new Error('API error');
          },
        },
      ),
    ).rejects.toThrow('API error');
  });
});

describe('deleteWebhookHandler', () => {
  test('returns deleted=true with the id', async () => {
    const deleted: number[] = [];
    const result = await deleteWebhookHandler(
      { id: '42' },
      {
        deleteWebhook: async (id) => {
          deleted.push(id);
        },
      },
    );
    expect(result.data).toEqual({ deleted: true, id: 42 });
    expect(deleted).toEqual([42]);
    expect(result.cta.commands).toHaveLength(1);
  });

  test('propagates errors from dep', async () => {
    await expect(
      deleteWebhookHandler(
        { id: '1' },
        {
          deleteWebhook: async () => {
            throw new Error('not found');
          },
        },
      ),
    ).rejects.toThrow('not found');
  });
});

describe('getWebhooksHandler', () => {
  const sampleWebhook = {
    id: 1,
    client_id: 'abc',
    store_hash: 'xyz',
    scope: 'store/order/created',
    destination: 'https://example.com/hook',
    is_active: true,
    created_at: 1700000000,
    updated_at: 1700000001,
  };

  test('returns webhooks from dep', async () => {
    const result = await getWebhooksHandler(
      {},
      { getWebhooks: async () => [sampleWebhook] },
    );
    expect(result.data).toEqual([sampleWebhook]);
    expect(result.cta.commands).toEqual([]);
  });

  test('returns empty array when no webhooks', async () => {
    const result = await getWebhooksHandler(
      {},
      { getWebhooks: async () => [] },
    );
    expect(result.data).toEqual([]);
  });

  test('propagates errors from dep', async () => {
    await expect(
      getWebhooksHandler(
        {},
        {
          getWebhooks: async () => {
            throw new Error('API down');
          },
        },
      ),
    ).rejects.toThrow('API down');
  });
});

describe('updateFormFieldsHandler', () => {
  const existing: FormField[] = [{ name: 'A', type: 'string' }];

  test('no changes when collect returns the same reference', async () => {
    const saves: FormField[][] = [];
    const result = await updateFormFieldsHandler({
      load: () => existing,
      collect: async (e) => e,
      save: (f) => saves.push(f),
    });
    expect(saves).toEqual([]);
    expect(result.data.formFields).toBe(existing);
  });

  test('persists when collect returns new fields', async () => {
    const saves: FormField[][] = [];
    const next: FormField[] = [
      { name: 'B', type: 'boolean', options: ['Y', 'N'] },
    ];
    const result = await updateFormFieldsHandler({
      load: () => existing,
      collect: async () => next,
      save: (f) => saves.push(f),
    });
    expect(saves).toEqual([next]);
    expect(result.data.formFields).toEqual(next);
  });
});

describe('collectViaReadline', () => {
  test('creates readline, calls collectFormFields, returns result', async () => {
    const existing: FormField[] = [{ name: 'A', type: 'string' }];
    const result = await collectViaReadline(existing, false);
    expect(result).toBe(existing);
  });

  test('passes verbose flag', async () => {
    const result = await collectViaReadline([], true);
    expect(result).toEqual([]);
  });
});

describe('registrars', () => {
  test('are functions', () => {
    expect(typeof registerCheckConnectionSubcommand).toBe('function');
    expect(typeof registerDeleteWebhookSubcommand).toBe('function');
    expect(typeof registerGetFormFieldsSubcommand).toBe('function');
    expect(typeof registerGetWebhooksSubcommand).toBe('function');
    expect(typeof registerUpdateWebhookSubcommand).toBe('function');
    expect(typeof registerUpdateFormFieldsSubcommand).toBe('function');
  });
});
