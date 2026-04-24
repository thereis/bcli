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
  getFormFieldsHandler,
  registerGetFormFieldsSubcommand,
} from './get-form-fields.ts';
import {
  collectViaReadline,
  registerUpdateFormFieldsSubcommand,
  updateFormFieldsHandler,
} from './update-form-fields.ts';

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
    expect(typeof registerGetFormFieldsSubcommand).toBe('function');
    expect(typeof registerUpdateFormFieldsSubcommand).toBe('function');
  });
});
