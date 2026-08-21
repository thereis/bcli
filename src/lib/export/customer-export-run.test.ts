import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Customer } from '../bigcommerce/schemas.ts';
import { loadColumnPlan } from './column-mapping.ts';
import {
  loadCustomerExportManifest,
  runCustomerBatchExport,
} from './customer-export-run.ts';

const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'customer-export-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.length = 0;
});

const makeCustomer = (id: number): Customer => ({
  id,
  email: `user-${id}@example.com`,
  first_name: 'First',
  last_name: 'Last',
  phone: '',
  addresses: [],
  form_fields: [],
});

const columns = loadColumnPlan({
  kind: 'inline',
  value: 'customerId:id,email:email',
});

const fixedUuid = () => '00000000-0000-4000-8000-000000000001';

describe('runCustomerBatchExport', () => {
  test('passes the sample limit to roster collection and freezes the result', async () => {
    const rootDir = temporaryDirectory();
    let requestedLimit: number | undefined;
    let requestedDelay: number | undefined;
    let detailDelay: number | undefined;
    const result = await runCustomerBatchExport(
      {
        key: 'sample',
        resume: false,
        export: true,
        batchSize: 100,
        limit: 2,
        requestDelayMs: 250,
        columns,
      },
      {
        getAllCustomerIds: async (limit, requestDelayMs) => {
          requestedLimit = limit;
          requestedDelay = requestDelayMs;
          return [50, 3];
        },
        fetchCustomersByIds: async (ids, requestDelayMs) => {
          detailDelay = requestDelayMs;
          return ids.map(makeCustomer);
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.customerCount).toBe(2);
    expect(result.batchCount).toBe(1);
    expect(requestedLimit).toBe(2);
    expect(requestedDelay).toBe(250);
    expect(detailDelay).toBe(250);
    expect(loadCustomerExportManifest(rootDir, 'sample')).toMatchObject({
      customerIds: [3, 50],
      limit: 2,
      requestDelayMs: 250,
      nextBatch: 1,
    });
  });

  test('writes deterministic batches with a frozen sorted roster', async () => {
    const rootDir = temporaryDirectory();
    const result = await runCustomerBatchExport(
      {
        key: 'Production Migration',
        resume: false,
        export: true,
        batchSize: 2,
        columns,
      },
      {
        getAllCustomerIds: async () => [3, 1, 2, 2],
        fetchCustomersByIds: async (ids) =>
          [...ids].reverse().map(makeCustomer),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.customerCount).toBe(3);
    expect(result.batchCount).toBe(2);
    expect(result.completedBatches).toBe(2);
    expect(result.files.map((file) => file.split('/').at(-1))).toEqual([
      'production-migration-000001.csv',
      'production-migration-000002.csv',
    ]);
    expect(readFileSync(result.files[0] as string, 'utf-8')).toBe(
      '"customerId","email"\n"1","user-1@example.com"\n"2","user-2@example.com"\n',
    );
    expect(
      loadCustomerExportManifest(rootDir, 'Production Migration'),
    ).toMatchObject({
      customerIds: [1, 2, 3],
      nextBatch: 2,
      batchSize: 2,
    });
  });

  test('resume starts at the first incomplete batch', async () => {
    const rootDir = temporaryDirectory();
    let calls = 0;
    await expect(
      runCustomerBatchExport(
        {
          key: 'retry',
          resume: false,
          export: true,
          batchSize: 2,
          requestDelayMs: 250,
          columns,
        },
        {
          getAllCustomerIds: async () => [1, 2, 3],
          fetchCustomersByIds: async (ids) => {
            calls++;
            if (calls === 2) throw new Error('temporary API failure');
            return ids.map(makeCustomer);
          },
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('temporary API failure');

    expect(loadCustomerExportManifest(rootDir, 'retry').nextBatch).toBe(1);
    const result = await runCustomerBatchExport(
      {
        key: 'retry',
        resume: true,
        export: true,
        batchSize: 999,
      },
      {
        getAllCustomerIds: async () => {
          throw new Error('resume must use the saved roster');
        },
        fetchCustomersByIds: async (ids, requestDelayMs) => {
          expect(requestDelayMs).toBe(250);
          return ids.map(makeCustomer);
        },
        rootDir,
        now: () => 'unused',
        randomUUID: fixedUuid,
      },
    );

    expect(result.completedBatches).toBe(2);
    expect(result.written).toBe(1);
    expect(result.files).toHaveLength(2);
  });

  test('resume reuses UUIDs created before a failed customer fetch', async () => {
    const rootDir = temporaryDirectory();
    const uuid = 'c52b15ea-d7df-4c46-a7f4-c0bb2cdac308';
    const generatedColumns = loadColumnPlan({
      kind: 'inline',
      value: 'customerId:{uuidv4},bigcommerceId:id',
    });
    await expect(
      runCustomerBatchExport(
        {
          key: 'uuid-retry',
          resume: false,
          export: true,
          batchSize: 1,
          columns: generatedColumns,
        },
        {
          getAllCustomerIds: async () => [7],
          fetchCustomersByIds: async () => {
            throw new Error('temporary API failure');
          },
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: () => uuid,
        },
      ),
    ).rejects.toThrow('temporary API failure');

    const result = await runCustomerBatchExport(
      {
        key: 'uuid-retry',
        resume: true,
        export: true,
        batchSize: 999,
      },
      {
        getAllCustomerIds: async () => {
          throw new Error('resume must use the saved roster');
        },
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => 'unused',
        randomUUID: () => {
          throw new Error('resume must reuse the saved UUID');
        },
      },
    );

    expect(readFileSync(result.files[0] as string, 'utf-8')).toBe(
      `"customerId","bigcommerceId"\n"${uuid}","7"\n`,
    );
  });

  test('dry run reports the plan without writing a manifest', async () => {
    const rootDir = temporaryDirectory();
    const result = await runCustomerBatchExport(
      {
        key: 'dry-run',
        resume: false,
        export: false,
        batchSize: 2,
        columns,
      },
      {
        getAllCustomerIds: async () => [1, 2, 3],
        fetchCustomersByIds: async () => {
          throw new Error('dry run must not fetch customer details');
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result).toMatchObject({
      customerCount: 3,
      batchCount: 2,
      completedBatches: 0,
      exported: false,
    });
    expect(() => loadCustomerExportManifest(rootDir, 'dry-run')).toThrow(
      /No saved export/,
    );
  });

  test('records customers missing between roster and batch fetch', async () => {
    const rootDir = temporaryDirectory();
    const result = await runCustomerBatchExport(
      {
        key: 'missing',
        resume: false,
        export: true,
        batchSize: 2,
        columns,
      },
      {
        getAllCustomerIds: async () => [1, 2],
        fetchCustomersByIds: async () => [makeCustomer(1)],
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.missingCustomerIds).toEqual([2]);
    expect(
      loadCustomerExportManifest(rootDir, 'missing').missingCustomerIds,
    ).toEqual([2]);
  });
});
