import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Customer } from '../../../lib/bigcommerce/schemas.ts';
import type { FormField } from '../../../lib/config/form-fields.ts';
import { HandlerExitError } from '../../../lib/shared/handler-exit.ts';
import {
  type ExportCustomersDeps,
  exportAllCustomersHandler,
  exportCustomersHandler,
  registerExportCustomersSubcommand,
  validateField,
} from './export-customers.ts';
import {
  getCustomerHandler,
  registerGetCustomerSubcommand,
} from './get-customer.ts';
import {
  getSearchHandler,
  hasAnySearchFilter,
  registerGetSearchSubcommand,
} from './get-search.ts';
import {
  registerUpdateCustomersSubcommand,
  updateCustomersErrorCsvPath,
  updateCustomersHandler,
  updateCustomersProgressFilePath,
} from './update-customers.ts';
import {
  registerUpdateFormFieldSubcommand,
  updateFormFieldHandler,
} from './update-form-field.ts';

const customer: Customer = {
  id: 99,
  email: 'a@b.c',
  first_name: 'A',
  last_name: 'B',
  phone: '555',
  addresses: [{ country: 'US' }],
  form_fields: [],
};

describe('getCustomerHandler', () => {
  test('returns customer when found', async () => {
    const result = await getCustomerHandler(
      { email: 'a@b.c' },
      { lookupCustomer: async () => customer },
    );
    expect(result.data).toEqual(customer);
    expect(result.cta.commands.length).toBeGreaterThan(0);
  });

  test('throws info when not found', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getCustomerHandler(
        { email: 'nope@x.y' },
        { lookupCustomer: async () => null },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.kind).toBe('info');
    expect(caught?.code).toBe(1);
    expect(caught?.message).toContain('nope@x.y');
  });
});

describe('updateFormFieldHandler', () => {
  test('calls bc.updateCustomerFormField with parsed ID', async () => {
    const calls: [number, string, string][] = [];
    await updateFormFieldHandler(
      { customerId: '42', fieldName: 'Trusted', value: 'True' },
      {
        updateCustomerFormField: async (id, n, v) => {
          calls.push([id, n, v]);
          return { data: {} };
        },
      },
    );
    expect(calls).toEqual([[42, 'Trusted', 'True']]);
  });

  test('rejects invalid customer ID', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await updateFormFieldHandler(
        { customerId: 'abc', fieldName: 'F', value: 'V' },
        { updateCustomerFormField: async () => ({}) },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('Invalid customer ID');
  });

  test('rejects non-positive customer ID', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await updateFormFieldHandler(
        { customerId: '0', fieldName: 'F', value: 'V' },
        { updateCustomerFormField: async () => ({}) },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('Invalid customer ID');
  });

  test('throws on update failure', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await updateFormFieldHandler(
        { customerId: '1', fieldName: 'F', value: 'V' },
        {
          updateCustomerFormField: async () => {
            throw new Error('API fail');
          },
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('API fail');
  });
});

describe('hasAnySearchFilter', () => {
  test('false with empty options', () => {
    expect(hasAnySearchFilter({})).toBe(false);
  });
  test('true with email', () => {
    expect(hasAnySearchFilter({ email: 'a@b.c' })).toBe(true);
  });
  test('true with order', () => {
    expect(hasAnySearchFilter({ order: '1' })).toBe(true);
  });
});

describe('getSearchHandler', () => {
  test('throws when no filter provided', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getSearchHandler(
        {},
        {
          searchCustomers: async () => [],
          getOrder: async () => ({}),
          getRecentOrders: async () => [],
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('At least one filter is required');
  });

  test('passes filters to searchCustomers and returns enriched customers', async () => {
    const calls: unknown[] = [];
    const result = await getSearchHandler(
      { email: 'a@b.c', nameLike: 'Jo' },
      {
        searchCustomers: async (filters) => {
          calls.push(filters);
          return [customer];
        },
        getOrder: async () => ({}),
        getRecentOrders: async () => [],
      },
    );
    expect(calls).toEqual([
      expect.objectContaining({ email: 'a@b.c', nameLike: 'Jo' }),
    ]);
    expect(result.data).toEqual([{ ...customer, recent_orders: [] }]);
  });

  test('--order path looks up customer via order', async () => {
    const searchCalls: unknown[] = [];
    const result = await getSearchHandler(
      { order: '500' },
      {
        searchCustomers: async (filters) => {
          searchCalls.push(filters);
          return [customer];
        },
        getOrder: async () => ({ customer_id: 99 }),
        getRecentOrders: async () => [],
      },
    );
    expect(searchCalls).toEqual([{ id: 99 }]);
    expect(result.data).toHaveLength(1);
  });

  test('--order with no customer_id exits info', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getSearchHandler(
        { order: '500' },
        {
          searchCustomers: async () => [],
          getOrder: async () => ({}),
          getRecentOrders: async () => [],
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.kind).toBe('info');
    expect(caught?.message).toContain('no associated customer');
  });

  test('order lookup error surfaces', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getSearchHandler(
        { order: '1' },
        {
          searchCustomers: async () => [],
          getOrder: async () => {
            throw new Error('order boom');
          },
          getRecentOrders: async () => [],
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('order boom');
  });

  test('order path: searchCustomers error surfaces', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getSearchHandler(
        { order: '1' },
        {
          searchCustomers: async () => {
            throw new Error('search boom');
          },
          getOrder: async () => ({ customer_id: 5 }),
          getRecentOrders: async () => [],
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('search boom');
  });

  test('search-by-filter error surfaces', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getSearchHandler(
        { email: 'a@b.c' },
        {
          searchCustomers: async () => {
            throw new Error('filter boom');
          },
          getOrder: async () => ({}),
          getRecentOrders: async () => [],
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('filter boom');
  });

  test('outputs table by default with customer + orders', async () => {
    const result = await getSearchHandler(
      { email: 'a@b.c' },
      {
        searchCustomers: async () => [customer],
        getOrder: async () => ({}),
        getRecentOrders: async () => [
          {
            id: 1,
            status: 'complete',
            date_created: '2026-01-01',
            products: [{ sku: 'A' }],
          },
        ],
      },
    );
    expect(result.data).toHaveLength(1);
  });

  test('outputs csv with orders', async () => {
    const result = await getSearchHandler(
      { email: 'a@b.c' },
      {
        searchCustomers: async () => [customer],
        getOrder: async () => ({}),
        getRecentOrders: async () => [
          {
            id: 1,
            status: 'complete',
            date_created: '2026-01-01',
            products: [{ sku: 'A' }],
          },
        ],
      },
    );
    expect(result.data).toHaveLength(1);
  });

  test('csv output with no orders still renders row', async () => {
    const result = await getSearchHandler(
      { email: 'a@b.c' },
      {
        searchCustomers: async () => [
          {
            ...customer,
            form_fields: [
              { name: 'F', value: 'V' },
              { name: 'Tags', value: ['a', 'b'] },
            ],
          },
        ],
        getOrder: async () => ({}),
        getRecentOrders: async () => [],
      },
    );
    expect(result.data).toHaveLength(1);
  });

  test('getRecentOrders failure does not break output', async () => {
    const result = await getSearchHandler(
      { email: 'a@b.c' },
      {
        searchCustomers: async () => [customer],
        getOrder: async () => ({}),
        getRecentOrders: async () => {
          throw new Error('orders boom');
        },
      },
    );
    expect(result.data).toHaveLength(1);
  });

  test('table output with no orders', async () => {
    await getSearchHandler(
      { email: 'a@b.c' },
      {
        searchCustomers: async () => [customer],
        getOrder: async () => ({}),
        getRecentOrders: async () => [],
      },
    );
  });

  test('no matches triggers info exit', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await getSearchHandler(
        { email: 'none@x.y' },
        {
          searchCustomers: async () => [],
          getOrder: async () => ({}),
          getRecentOrders: async () => [],
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.kind).toBe('info');
    expect(caught?.message).toContain('No customers found');
  });
});

describe('updateCustomersHandler', () => {
  const baseOptions = {
    emailColumn: 'Email',
    field: 'Marketing opt-in',
    value: 'Yes',
    dryRun: false,
    resume: false,
  };

  test('updates existing customers found by email', async () => {
    const updateCalls: {
      customerId: number;
      fieldName: string;
      value: string;
    }[][] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      baseOptions,
      {
        readCsvRows: async () => [{ Email: 'a@b.c' }, { Email: 'd@e.f' }],
        lookupCustomersByEmails: async (emails) =>
          emails.map((email) => ({
            ...customer,
            email,
            id: email === 'a@b.c' ? 1 : 2,
          })),
        updateCustomersFormField: async (updates) => {
          updateCalls.push(updates);
          return {};
        },
      },
    );

    expect(result.updated).toBe(2);
    expect(updateCalls).toEqual([
      [
        { customerId: 1, fieldName: 'Marketing opt-in', value: 'Yes' },
        { customerId: 2, fieldName: 'Marketing opt-in', value: 'Yes' },
      ],
    ]);
  });

  test('skips missing customers', async () => {
    const updateCalls: {
      customerId: number;
      fieldName: string;
      value: string;
    }[][] = [];
    const errorRows: { file: string; row: Record<string, string> }[] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      baseOptions,
      {
        readCsvRows: async () => [
          { Email: 'found@x.y', Name: 'Found' },
          { Email: 'missing@x.y', Name: 'Missing' },
        ],
        lookupCustomersByEmails: async () => [
          { ...customer, id: 1, email: 'found@x.y' },
        ],
        updateCustomersFormField: async (updates) => {
          updateCalls.push(updates);
          return {};
        },
        appendCsvRow: (file, row) => errorRows.push({ file, row }),
      },
    );

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(updateCalls).toEqual([
      [{ customerId: 1, fieldName: 'Marketing opt-in', value: 'Yes' }],
    ]);
    expect(errorRows).toEqual([
      {
        file: 'test-errors.csv',
        row: { Email: 'missing@x.y', Name: 'Missing', Status: 'skipped' },
      },
    ]);
  });

  test('dry run performs no updates', async () => {
    const updateCalls: string[] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      { ...baseOptions, dryRun: true },
      {
        readCsvRows: async () => [{ Email: 'a@b.c' }],
        lookupCustomersByEmails: async () => [{ ...customer, id: 1 }],
        updateCustomersFormField: async () => {
          updateCalls.push('boom');
          return {};
        },
      },
    );

    expect(result.updated).toBe(1);
    expect(updateCalls).toEqual([]);
  });

  test('uses per-row values from valueColumn', async () => {
    const updateCalls: {
      customerId: number;
      fieldName: string;
      value: string;
    }[][] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      { ...baseOptions, value: undefined, valueColumn: 'Opt In' },
      {
        readCsvRows: async () => [
          { Email: 'yes@x.y', 'Opt In': 'Yes' },
          { Email: 'no@x.y', 'Opt In': 'No' },
        ],
        lookupCustomersByEmails: async (emails) =>
          emails.map((email) => ({
            ...customer,
            email,
            id: email === 'yes@x.y' ? 1 : 2,
          })),
        updateCustomersFormField: async (updates) => {
          updateCalls.push(updates);
          return {};
        },
      },
    );

    expect(result.updated).toBe(2);
    expect(updateCalls).toEqual([
      [
        { customerId: 1, fieldName: 'Marketing opt-in', value: 'Yes' },
        { customerId: 2, fieldName: 'Marketing opt-in', value: 'No' },
      ],
    ]);
  });

  test('skips rows with missing email column', async () => {
    const errorRows: Record<string, string>[] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      baseOptions,
      {
        readCsvRows: async () => [
          { Email: '', Name: 'No Email' },
          { Email: 'a@b.c', Name: 'Valid' },
        ],
        lookupCustomersByEmails: async () => [{ ...customer, id: 1 }],
        updateCustomersFormField: async () => ({}),
        appendCsvRow: (_file, row) => errorRows.push(row),
      },
    );

    expect(result.total).toBe(2);
    expect(result.invalid).toBe(1);
    expect(result.updated).toBe(1);
    expect(errorRows).toEqual([
      { Email: '', Name: 'No Email', Status: 'invalid' },
    ]);
  });

  test('skips rows with missing value column', async () => {
    const errorRows: Record<string, string>[] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      { ...baseOptions, value: undefined, valueColumn: 'Opt In' },
      {
        readCsvRows: async () => [
          { Email: 'missing@x.y', 'Opt In': '', Name: 'Missing Value' },
          { Email: 'a@b.c', 'Opt In': 'Yes', Name: 'Valid' },
        ],
        lookupCustomersByEmails: async () => [{ ...customer, id: 1 }],
        updateCustomersFormField: async () => ({}),
        appendCsvRow: (_file, row) => errorRows.push(row),
      },
    );

    expect(result.total).toBe(2);
    expect(result.invalid).toBe(1);
    expect(result.updated).toBe(1);
    expect(errorRows).toEqual([
      {
        Email: 'missing@x.y',
        'Opt In': '',
        Name: 'Missing Value',
        Status: 'invalid',
      },
    ]);
  });

  test('requires exactly one value source', async () => {
    await expect(
      updateCustomersHandler(
        { csvPath: 'test.csv' },
        { ...baseOptions, value: undefined },
        {
          readCsvRows: async () => [],
          lookupCustomersByEmails: async () => [],
          updateCustomersFormField: async () => ({}),
        },
      ),
    ).rejects.toThrow(HandlerExitError);

    await expect(
      updateCustomersHandler(
        { csvPath: 'test.csv' },
        { ...baseOptions, valueColumn: 'Opt In' },
        {
          readCsvRows: async () => [],
          lookupCustomersByEmails: async () => [],
          updateCustomersFormField: async () => ({}),
        },
      ),
    ).rejects.toThrow(HandlerExitError);
  });

  test('stops on update failure so resume can retry the failed batch', async () => {
    let savedProgress = -1;
    const errorRows: Record<string, string>[] = [];
    let caught: HandlerExitError | null = null;
    try {
      await updateCustomersHandler({ csvPath: 'test.csv' }, baseOptions, {
        readCsvRows: async () => [
          { Email: 'done@x.y', Name: 'Done' },
          { Email: 'fail@x.y', Name: 'Fail' },
        ],
        lookupCustomersByEmails: async (emails) =>
          emails.map((email, index) => ({
            ...customer,
            id: index + 1,
            email,
          })),
        updateCustomersFormField: async () => {
          throw new Error('API fail');
        },
        saveProgress: (_path, state) => {
          savedProgress = state.processedRows;
        },
        appendCsvRow: (_file, row) => errorRows.push(row),
      });
    } catch (e) {
      caught = e as HandlerExitError;
    }

    expect(caught?.message).toContain('Re-run with --resume');
    expect(savedProgress).toBe(-1);
    expect(errorRows).toEqual([
      { Email: 'done@x.y', Name: 'Done', Status: 'failed' },
      { Email: 'fail@x.y', Name: 'Fail', Status: 'failed' },
    ]);
  });

  test('resume skips rows before the saved checkpoint', async () => {
    const lookedUp: string[][] = [];
    const saved: number[] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      { ...baseOptions, resume: true },
      {
        readCsvRows: async () => [
          { Email: 'old@x.y' },
          { Email: 'next@x.y' },
          { Email: 'last@x.y' },
        ],
        lookupCustomersByEmails: async (emails) => {
          lookedUp.push(emails);
          return emails.map((email, index) => ({
            ...customer,
            id: index + 10,
            email,
          }));
        },
        updateCustomersFormField: async () => ({}),
        loadProgress: () => ({
          processedRows: 1,
        }),
        saveProgress: (_path, state) => {
          saved.push(state.processedRows);
        },
      },
    );

    expect(result.updated).toBe(2);
    expect(lookedUp).toEqual([['next@x.y', 'last@x.y']]);
    expect(saved).toEqual([3]);
  });

  test('progress file path changes when update options change', () => {
    const fixed = updateCustomersProgressFilePath(
      { csvPath: 'test.csv' },
      baseOptions,
    );
    const changedValue = updateCustomersProgressFilePath(
      { csvPath: 'test.csv' },
      { ...baseOptions, value: 'No' },
    );

    expect(fixed).toStartWith('.update-customers-test-csv-');
    expect(changedValue).not.toBe(fixed);
  });

  test('error csv path is written next to the source csv', () => {
    expect(updateCustomersErrorCsvPath({ csvPath: 'customers.csv' })).toBe(
      'customers-errors.csv',
    );
    expect(
      updateCustomersErrorCsvPath({ csvPath: 'imports/customers.csv' }),
    ).toBe('imports/customers-errors.csv');
  });

  test('uses a unique status column when the csv already has Status', async () => {
    const errorRows: Record<string, string>[] = [];
    const result = await updateCustomersHandler(
      { csvPath: 'test.csv' },
      baseOptions,
      {
        readCsvRows: async () => [
          { Email: '', Status: 'Existing', 'Status 2': 'Also Existing' },
        ],
        lookupCustomersByEmails: async () => [],
        updateCustomersFormField: async () => ({}),
        appendCsvRow: (_file, row) => errorRows.push(row),
      },
    );

    expect(result.invalid).toBe(1);
    expect(errorRows).toEqual([
      {
        Email: '',
        Status: 'Existing',
        'Status 2': 'Also Existing',
        'Status 3': 'invalid',
      },
    ]);
  });
});

describe('validateField', () => {
  const known: FormField[] = [
    { name: 'Trusted', type: 'boolean', options: ['True', 'False'] },
  ];

  test('passes when known list is empty (no registry)', () => {
    expect(() => validateField('anything', 'value', [])).not.toThrow();
  });

  test('accepts known field and allowed value', () => {
    expect(() => validateField('Trusted', 'True', known)).not.toThrow();
  });

  test('rejects unknown field', () => {
    expect(() => validateField('Unknown', 'True', known)).toThrow(
      HandlerExitError,
    );
  });

  test('rejects disallowed value', () => {
    expect(() => validateField('Trusted', 'Maybe', known)).toThrow(
      HandlerExitError,
    );
  });
});

describe('exportCustomersHandler', () => {
  const baseDeps = (): ExportCustomersDeps => ({
    loadFormFields: () => [],
    cleanProgress: () => {},
    getCustomerIdsByFormField: async () => [],
    getCustomersByIds: async () => 0,
    existsSync: () => false,
    readCsvColumnValues: async () => new Set<string>(),
    appendCsvRow: () => {},
    today: () => '2026-04-24',
  });

  const baseOptions = {
    field: 'Trusted',
    value: 'True',
    columns: 'Email:email,Phone:phone',
    resume: false,
    export: false,
    incremental: false,
  };

  test('exits info when no customers match', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await exportCustomersHandler({ key: 'k' }, baseOptions, {
        ...baseDeps(),
        getCustomerIdsByFormField: async () => [],
      });
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.kind).toBe('info');
    expect(caught?.code).toBe(0);
  });

  test('dry run does not write CSVs', async () => {
    const appended: string[] = [];
    const result = await exportCustomersHandler({ key: 'k' }, baseOptions, {
      ...baseDeps(),
      getCustomerIdsByFormField: async () => [1, 2, 3],
      getCustomersByIds: async (ids, _p, cb) => {
        for (const id of ids) {
          cb({
            id,
            email: `u${id}@x.y`,
            first_name: 'A',
            last_name: 'B',
            phone: '1',
            addresses: [],
            form_fields: [],
          });
        }
        return ids.length;
      },
      appendCsvRow: (f) => appended.push(f),
    });
    expect(appended).toEqual([]);
    expect(result).toEqual({
      customerIds: [1, 2, 3],
      written: 3,
      baseFile: 'exports/k.csv',
      cleanFile: 'exports/k_2026-04-24.csv',
      exported: false,
    });
  });

  test('export writes both base and clean CSVs', async () => {
    const appended: { file: string; row: Record<string, string> }[] = [];
    const result = await exportCustomersHandler(
      { key: 'k' },
      { ...baseOptions, export: true },
      {
        ...baseDeps(),
        getCustomerIdsByFormField: async () => [1],
        getCustomersByIds: async (ids, _p, cb) => {
          cb({
            id: 1,
            email: 'a@b.c',
            first_name: 'F',
            last_name: 'L',
            phone: '5',
            addresses: [],
            form_fields: [],
          });
          return ids.length;
        },
        appendCsvRow: (file, row) => appended.push({ file, row }),
      },
    );
    expect(appended.map((a) => a.file)).toEqual([
      'exports/k.csv',
      'exports/k_2026-04-24.csv',
    ]);
    expect(appended[0]?.row).toHaveProperty('Customer ID', '1');
    expect(result.exported).toBe(true);
  });

  test('resume skips clean on start', async () => {
    const cleanCalls: string[] = [];
    await exportCustomersHandler(
      { key: 'k' },
      { ...baseOptions, resume: true },
      {
        ...baseDeps(),
        cleanProgress: (p) => cleanCalls.push(p),
        getCustomerIdsByFormField: async () => [1],
        getCustomersByIds: async () => 1,
      },
    );
    expect(cleanCalls).toEqual(['.progress-k.json']);
  });

  test('non-resume cleans before and after', async () => {
    const cleanCalls: string[] = [];
    await exportCustomersHandler({ key: 'k' }, baseOptions, {
      ...baseDeps(),
      cleanProgress: (p) => cleanCalls.push(p),
      getCustomerIdsByFormField: async () => [1],
      getCustomersByIds: async () => 1,
    });
    expect(cleanCalls).toEqual(['.progress-k.json', '.progress-k.json']);
  });

  test('incremental filters out existing IDs', async () => {
    let fetchedIds: number[] = [];
    const result = await exportCustomersHandler(
      { key: 'k' },
      { ...baseOptions, incremental: true },
      {
        ...baseDeps(),
        getCustomerIdsByFormField: async () => [1, 2, 3],
        existsSync: () => true,
        readCsvColumnValues: async () => new Set(['1', '2']),
        getCustomersByIds: async (ids, _p, cb) => {
          fetchedIds = ids;
          for (const id of ids) {
            cb({
              id,
              email: 'x@y.z',
              first_name: 'F',
              last_name: 'L',
              phone: '1',
              addresses: [],
              form_fields: [],
            });
          }
          return ids.length;
        },
      },
    );
    expect(fetchedIds).toEqual([3]);
    expect(result.written).toBe(1);
    expect(result.cleanFile).toBe('exports/k_2026-04-24-incremental.csv');
  });

  test('incremental with no base file still runs (creates base)', async () => {
    const appended: string[] = [];
    const result = await exportCustomersHandler(
      { key: 'k' },
      { ...baseOptions, incremental: true, export: true },
      {
        ...baseDeps(),
        getCustomerIdsByFormField: async () => [1],
        existsSync: () => false,
        getCustomersByIds: async (ids, _p, cb) => {
          for (const id of ids) {
            cb({
              id,
              email: 'x@y.z',
              first_name: 'F',
              last_name: 'L',
              phone: '1',
              addresses: [],
              form_fields: [],
            });
          }
          return ids.length;
        },
        appendCsvRow: (f) => appended.push(f),
      },
    );
    expect(result.exported).toBe(true);
    expect(appended.length).toBeGreaterThan(0);
  });

  test('custom outputPrefix and fullColumns', async () => {
    const result = await exportCustomersHandler(
      { key: 'k' },
      {
        ...baseOptions,
        outputPrefix: 'my-prefix',
        fullColumns: 'ID:id,Email:email',
      },
      {
        ...baseDeps(),
        getCustomerIdsByFormField: async () => [1],
        getCustomersByIds: async () => 0,
      },
    );
    expect(result.baseFile).toBe('exports/my-prefix.csv');
  });

  test('incremental with zero new IDs exits info', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await exportCustomersHandler(
        { key: 'k' },
        { ...baseOptions, incremental: true },
        {
          ...baseDeps(),
          getCustomerIdsByFormField: async () => [1],
          existsSync: () => true,
          readCsvColumnValues: async () => new Set(['1']),
        },
      );
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.kind).toBe('info');
  });

  test('invalid field throws', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await exportCustomersHandler({ key: 'k' }, baseOptions, {
        ...baseDeps(),
        loadFormFields: () => [{ name: 'Other', type: 'string' }],
      });
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('not registered');
  });

  test('invalid value throws', async () => {
    let caught: HandlerExitError | null = null;
    try {
      await exportCustomersHandler({ key: 'k' }, baseOptions, {
        ...baseDeps(),
        loadFormFields: () => [
          { name: 'Trusted', type: 'boolean', options: ['Yes', 'No'] },
        ],
      });
    } catch (e) {
      caught = e as HandlerExitError;
    }
    expect(caught?.message).toContain('not allowed');
  });
});

describe('exportAllCustomersHandler', () => {
  test('writes a complete all-customer run', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'all-customers-handler-'));
    try {
      const result = await exportAllCustomersHandler(
        { key: 'migration' },
        {
          all: true,
          columns: 'customerId:id,email:email',
          resume: false,
          export: true,
          incremental: false,
          batchSize: 1000,
        },
        {
          loadFormFields: () => [],
          getAllCustomerIds: async () => [99],
          fetchCustomersByIds: async () => [customer],
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: () => '00000000-0000-4000-8000-000000000001',
        },
      );

      expect(result).toMatchObject({
        customerCount: 1,
        completedBatches: 1,
        written: 1,
        exported: true,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test('rejects conflicting selection modes before API calls', async () => {
    let requested = false;
    await expect(
      exportAllCustomersHandler(
        { key: 'migration' },
        {
          all: true,
          field: 'Trusted',
          value: 'True',
          columns: 'customerId:id',
          resume: false,
          export: true,
          incremental: false,
          batchSize: 1000,
        },
        {
          loadFormFields: () => [],
          getAllCustomerIds: async () => {
            requested = true;
            return [];
          },
          fetchCustomersByIds: async () => [],
          rootDir: 'unused',
          now: () => 'unused',
          randomUUID: () => '00000000-0000-4000-8000-000000000001',
        },
      ),
    ).rejects.toThrow(/cannot be combined/);
    expect(requested).toBe(false);
  });
});

describe('registrars', () => {
  test('each subcommand registers against parent', () => {
    const calls: string[] = [];
    const fakeParent = {
      command: (name: string) => {
        calls.push(name);
      },
    } as unknown as Parameters<typeof registerGetCustomerSubcommand>[0];
    registerExportCustomersSubcommand(fakeParent);
    registerGetCustomerSubcommand(fakeParent);
    registerGetSearchSubcommand(fakeParent);
    registerUpdateFormFieldSubcommand(fakeParent);
    registerUpdateCustomersSubcommand(fakeParent);
    expect(calls).toEqual([
      'customers',
      'customer',
      'search',
      'form-field',
      'customers',
    ]);
  });
});
