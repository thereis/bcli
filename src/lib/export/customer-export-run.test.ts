import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Customer } from '../bigcommerce/schemas.ts';
import { loadColumnPlan } from './column-mapping.ts';
import {
  customerExportRunExists,
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

  test('checkpoints roster pages so resume can continue after a collection failure', async () => {
    const rootDir = temporaryDirectory();
    const pages: number[] = [];
    await expect(
      runCustomerBatchExport(
        {
          key: 'roster-retry',
          resume: false,
          export: true,
          batchSize: 10,
          requestDelayMs: 200,
          columns,
        },
        {
          getAllCustomerIds: async (_limit, _delay, roster) => {
            pages.push(roster?.startPage ?? 1);
            await roster?.onPage?.({
              page: 1,
              totalPages: 2,
              ids: [2, 1],
              complete: false,
            });
            throw new Error('roster interrupted');
          },
          fetchCustomersByIds: async () => {
            throw new Error('must not fetch details before roster completes');
          },
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('roster interrupted');

    expect(pages).toEqual([1]);
    expect(existsSync(join(rootDir, 'roster-retry', 'manifest.json'))).toBe(
      false,
    );
    expect(
      readFileSync(join(rootDir, 'roster-retry', 'roster-ids.jsonl'), 'utf-8'),
    ).toBe('2\n1\n');
    expect(customerExportRunExists(rootDir, 'roster-retry')).toBe(true);

    const result = await runCustomerBatchExport(
      {
        key: 'roster-retry',
        resume: true,
        export: true,
        batchSize: 999,
      },
      {
        getAllCustomerIds: async (_limit, delay, roster) => {
          expect(delay).toBe(200);
          expect(roster?.startPage).toBe(2);
          expect(roster?.collectedCount).toBe(2);
          pages.push(roster?.startPage ?? 1);
          await roster?.onPage?.({
            page: 2,
            totalPages: 2,
            ids: [3],
            complete: true,
          });
          return [3];
        },
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => 'unused',
        randomUUID: fixedUuid,
      },
    );

    expect(pages).toEqual([1, 2]);
    expect(result.customerCount).toBe(3);
    expect(result.written).toBe(3);
    expect(
      loadCustomerExportManifest(rootDir, 'roster-retry').customerIds,
    ).toEqual([1, 2, 3]);
    expect(existsSync(join(rootDir, 'roster-retry', 'roster-ids.jsonl'))).toBe(
      false,
    );
    expect(
      existsSync(join(rootDir, 'roster-retry', 'roster-checkpoint.json')),
    ).toBe(false);
  });

  test('resume freezes a completed roster checkpoint without refetching IDs', async () => {
    const rootDir = temporaryDirectory();
    await expect(
      runCustomerBatchExport(
        {
          key: 'roster-complete',
          resume: false,
          export: true,
          batchSize: 10,
          columns,
        },
        {
          getAllCustomerIds: async (_limit, _delay, roster) => {
            await roster?.onPage?.({
              page: 1,
              totalPages: 1,
              ids: [5],
              complete: true,
            });
            throw new Error('crash after last roster page');
          },
          fetchCustomersByIds: async () => {
            throw new Error('must not fetch details before freeze');
          },
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('crash after last roster page');

    const result = await runCustomerBatchExport(
      {
        key: 'roster-complete',
        resume: true,
        export: true,
        batchSize: 999,
      },
      {
        getAllCustomerIds: async () => {
          throw new Error('must not refetch a completed roster');
        },
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => 'unused',
        randomUUID: fixedUuid,
      },
    );

    expect(result.customerCount).toBe(1);
    expect(result.written).toBe(1);
    expect(
      loadCustomerExportManifest(rootDir, 'roster-complete').customerIds,
    ).toEqual([5]);
  });

  test('refuses to start over when a roster checkpoint already exists', async () => {
    const rootDir = temporaryDirectory();
    await expect(
      runCustomerBatchExport(
        {
          key: 'existing',
          resume: false,
          export: true,
          batchSize: 10,
          columns,
        },
        {
          getAllCustomerIds: async (_limit, _delay, roster) => {
            await roster?.onPage?.({
              page: 1,
              totalPages: 2,
              ids: [1],
              complete: false,
            });
            throw new Error('roster interrupted');
          },
          fetchCustomersByIds: async () => [],
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('roster interrupted');

    await expect(
      runCustomerBatchExport(
        {
          key: 'existing',
          resume: false,
          export: true,
          batchSize: 10,
          columns,
        },
        {
          getAllCustomerIds: async () => {
            throw new Error('must not start a second roster');
          },
          fetchCustomersByIds: async () => [],
          rootDir,
          now: () => 'unused',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow(/already exists/);
  });

  test('resume without a saved run tells you to start with --all', async () => {
    const rootDir = temporaryDirectory();
    await expect(
      runCustomerBatchExport(
        {
          key: 'missing',
          resume: true,
          export: true,
          batchSize: 10,
        },
        {
          getAllCustomerIds: async () => [],
          fetchCustomersByIds: async () => [],
          rootDir,
          now: () => 'unused',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow(/No saved export found/);
  });

  test('resume rejects a roster checkpoint whose ID list is missing', async () => {
    const rootDir = temporaryDirectory();
    await expect(
      runCustomerBatchExport(
        {
          key: 'orphan',
          resume: false,
          export: true,
          batchSize: 10,
          columns,
        },
        {
          getAllCustomerIds: async (_limit, _delay, roster) => {
            await roster?.onPage?.({
              page: 1,
              totalPages: 2,
              ids: [1],
              complete: false,
            });
            throw new Error('roster interrupted');
          },
          fetchCustomersByIds: async () => [],
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('roster interrupted');

    rmSync(join(rootDir, 'orphan', 'roster-ids.jsonl'));

    await expect(
      runCustomerBatchExport(
        {
          key: 'orphan',
          resume: true,
          export: true,
          batchSize: 10,
        },
        {
          getAllCustomerIds: async () => [],
          fetchCustomersByIds: async () => [],
          rootDir,
          now: () => 'unused',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow(/missing roster ID list/);
  });

  test('dry run reports the plan without writing a manifest', async () => {
    const rootDir = temporaryDirectory();
    let sawOnPage = false;
    const result = await runCustomerBatchExport(
      {
        key: 'dry-run',
        resume: false,
        export: false,
        batchSize: 2,
        columns,
      },
      {
        getAllCustomerIds: async (_limit, _delay, roster) => {
          sawOnPage = roster?.onPage !== undefined;
          return [1, 2, 3];
        },
        fetchCustomersByIds: async () => {
          throw new Error('dry run must not fetch customer details');
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(sawOnPage).toBe(false);
    expect(result).toMatchObject({
      customerCount: 3,
      batchCount: 2,
      completedBatches: 0,
      exported: false,
    });
    expect(() => loadCustomerExportManifest(rootDir, 'dry-run')).toThrow(
      /No saved export/,
    );
    expect(customerExportRunExists(rootDir, 'dry-run')).toBe(false);
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

  test('threads concurrency into roster collection, detail fetches, and the manifest', async () => {
    const rootDir = temporaryDirectory();
    let rosterConcurrency: number | undefined;
    let detailConcurrency: number | undefined;
    await runCustomerBatchExport(
      {
        key: 'parallel',
        resume: false,
        export: true,
        batchSize: 10,
        requestDelayMs: 250,
        concurrency: 6,
        columns,
      },
      {
        getAllCustomerIds: async (_limit, _delay, roster) => {
          rosterConcurrency = roster?.concurrency;
          return [1, 2];
        },
        fetchCustomersByIds: async (ids, _delay, concurrency) => {
          detailConcurrency = concurrency;
          return ids.map(makeCustomer);
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(rosterConcurrency).toBe(6);
    expect(detailConcurrency).toBe(6);
    expect(loadCustomerExportManifest(rootDir, 'parallel')).toMatchObject({
      concurrency: 6,
    });
  });

  test('defaults concurrency to one when the option is omitted', async () => {
    const rootDir = temporaryDirectory();
    let rosterConcurrency: number | undefined;
    let detailConcurrency: number | undefined;
    await runCustomerBatchExport(
      {
        key: 'serial',
        resume: false,
        export: true,
        batchSize: 10,
        columns,
      },
      {
        getAllCustomerIds: async (_limit, _delay, roster) => {
          rosterConcurrency = roster?.concurrency;
          return [1];
        },
        fetchCustomersByIds: async (ids, _delay, concurrency) => {
          detailConcurrency = concurrency;
          return ids.map(makeCustomer);
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(rosterConcurrency).toBe(1);
    expect(detailConcurrency).toBe(1);
    expect(loadCustomerExportManifest(rootDir, 'serial')).toMatchObject({
      concurrency: 1,
    });
  });

  test('resumes a manifest written before concurrency existed', async () => {
    const rootDir = temporaryDirectory();
    const runDirectory = join(rootDir, 'legacy');
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, 'manifest.json'),
      JSON.stringify({
        version: 1,
        key: 'legacy',
        outputPrefix: 'legacy',
        batchSize: 2,
        requestDelayMs: 100,
        mapping: columns.mapping,
        mappingFingerprint: columns.fingerprint,
        customerIds: [1, 2],
        nextBatch: 0,
        missingCustomerIds: [],
        createdAt: '2026-08-21T12:00:00.000Z',
      }),
    );

    let detailConcurrency: number | undefined;
    const result = await runCustomerBatchExport(
      { key: 'legacy', resume: true, export: true, batchSize: 2 },
      {
        getAllCustomerIds: async () => {
          throw new Error('resume must not recollect the roster');
        },
        fetchCustomersByIds: async (ids, _delay, concurrency) => {
          detailConcurrency = concurrency;
          return ids.map(makeCustomer);
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(detailConcurrency).toBe(1);
    expect(result.written).toBe(2);
  });

  test('keeps the concurrency saved in a roster checkpoint when resuming', async () => {
    const rootDir = temporaryDirectory();
    await expect(
      runCustomerBatchExport(
        {
          key: 'checkpoint-concurrency',
          resume: false,
          export: true,
          batchSize: 10,
          concurrency: 5,
          columns,
        },
        {
          getAllCustomerIds: async (_limit, _delay, roster) => {
            await roster?.onPage?.({
              page: 1,
              totalPages: 2,
              ids: [1],
              complete: false,
            });
            throw new Error('roster interrupted');
          },
          fetchCustomersByIds: async () => [],
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('roster interrupted');

    let resumedConcurrency: number | undefined;
    await runCustomerBatchExport(
      {
        key: 'checkpoint-concurrency',
        resume: true,
        export: true,
        batchSize: 10,
      },
      {
        getAllCustomerIds: async (_limit, _delay, roster) => {
          resumedConcurrency = roster?.concurrency;
          await roster?.onPage?.({
            page: 2,
            totalPages: 2,
            ids: [2],
            complete: true,
          });
          return [2];
        },
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(resumedConcurrency).toBe(5);
    expect(
      loadCustomerExportManifest(rootDir, 'checkpoint-concurrency'),
    ).toMatchObject({ concurrency: 5 });
  });

  test('keeps the frozen ID list out of the manifest', async () => {
    const rootDir = temporaryDirectory();
    await runCustomerBatchExport(
      {
        key: 'split',
        resume: false,
        export: true,
        batchSize: 2,
        columns,
      },
      {
        getAllCustomerIds: async () => [3, 1, 2],
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    const runDirectory = join(rootDir, 'split');
    const manifest = JSON.parse(
      readFileSync(join(runDirectory, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.customerIds).toBeUndefined();
    expect(manifest.nextBatch).toBeUndefined();
    expect(manifest.missingCustomerIds).toBeUndefined();
    expect(manifest.customerCount).toBe(3);

    expect(
      readFileSync(join(runDirectory, 'customer-ids.jsonl'), 'utf-8'),
    ).toBe('1\n2\n3\n');
    expect(
      JSON.parse(readFileSync(join(runDirectory, 'progress.json'), 'utf-8')),
    ).toEqual({ version: 1, nextBatch: 2, missingCustomerIds: [] });

    expect(loadCustomerExportManifest(rootDir, 'split')).toMatchObject({
      customerIds: [1, 2, 3],
      nextBatch: 2,
      missingCustomerIds: [],
    });
  });

  test('never rewrites the manifest while batches are exported', async () => {
    const rootDir = temporaryDirectory();
    const ids = [1, 2, 3, 4, 5, 6];
    await expect(
      runCustomerBatchExport(
        {
          key: 'stable',
          resume: false,
          export: true,
          batchSize: 2,
          columns,
        },
        {
          getAllCustomerIds: async () => ids,
          fetchCustomersByIds: async (batch) => {
            if (batch.includes(3)) throw new Error('batch two failed');
            return batch.map(makeCustomer);
          },
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('batch two failed');

    const manifestFile = join(rootDir, 'stable', 'manifest.json');
    const progressFile = join(rootDir, 'stable', 'progress.json');
    const frozen = readFileSync(manifestFile, 'utf-8');
    expect(JSON.parse(readFileSync(progressFile, 'utf-8')).nextBatch).toBe(1);

    const result = await runCustomerBatchExport(
      { key: 'stable', resume: true, export: true, batchSize: 2 },
      {
        getAllCustomerIds: async () => {
          throw new Error('resume must not recollect the roster');
        },
        fetchCustomersByIds: async (batch) => batch.map(makeCustomer),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.completedBatches).toBe(3);
    expect(readFileSync(manifestFile, 'utf-8')).toBe(frozen);
    expect(JSON.parse(readFileSync(progressFile, 'utf-8')).nextBatch).toBe(3);
  });

  test('rejects a manifest whose ID list is missing', async () => {
    const rootDir = temporaryDirectory();
    await runCustomerBatchExport(
      { key: 'lost-ids', resume: false, export: true, batchSize: 2, columns },
      {
        getAllCustomerIds: async () => [1, 2],
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );
    rmSync(join(rootDir, 'lost-ids', 'customer-ids.jsonl'));

    expect(() => loadCustomerExportManifest(rootDir, 'lost-ids')).toThrow(
      /missing its ID list/,
    );
  });

  test('rejects a truncated ID list', async () => {
    const rootDir = temporaryDirectory();
    await runCustomerBatchExport(
      { key: 'short-ids', resume: false, export: true, batchSize: 5, columns },
      {
        getAllCustomerIds: async () => [1, 2, 3],
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );
    writeFileSync(join(rootDir, 'short-ids', 'customer-ids.jsonl'), '1\n2\n');

    expect(() => loadCustomerExportManifest(rootDir, 'short-ids')).toThrow(
      /holds 2 IDs but the manifest expects 3/,
    );
  });

  test('rejects an unreadable progress file', async () => {
    const rootDir = temporaryDirectory();
    await runCustomerBatchExport(
      {
        key: 'bad-progress',
        resume: false,
        export: true,
        batchSize: 5,
        columns,
      },
      {
        getAllCustomerIds: async () => [1],
        fetchCustomersByIds: async (ids) => ids.map(makeCustomer),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );
    writeFileSync(
      join(rootDir, 'bad-progress', 'progress.json'),
      JSON.stringify({ version: 1, nextBatch: -1, missingCustomerIds: [] }),
    );

    expect(() => loadCustomerExportManifest(rootDir, 'bad-progress')).toThrow(
      /Invalid export progress/,
    );
  });

  test('migrates a legacy manifest that still embeds every ID', async () => {
    const rootDir = temporaryDirectory();
    const runDirectory = join(rootDir, 'legacy-split');
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, 'manifest.json'),
      JSON.stringify({
        version: 1,
        key: 'legacy-split',
        outputPrefix: 'legacy-split',
        batchSize: 2,
        requestDelayMs: 0,
        mapping: columns.mapping,
        mappingFingerprint: columns.fingerprint,
        customerIds: [1, 2, 3],
        nextBatch: 1,
        missingCustomerIds: [9],
        createdAt: '2026-08-21T12:00:00.000Z',
      }),
    );

    expect(loadCustomerExportManifest(rootDir, 'legacy-split')).toMatchObject({
      customerIds: [1, 2, 3],
      nextBatch: 1,
      missingCustomerIds: [9],
    });

    const migrated = JSON.parse(
      readFileSync(join(runDirectory, 'manifest.json'), 'utf-8'),
    );
    expect(migrated.customerIds).toBeUndefined();
    expect(migrated.customerCount).toBe(3);
    expect(
      readFileSync(join(runDirectory, 'customer-ids.jsonl'), 'utf-8'),
    ).toBe('1\n2\n3\n');
    expect(
      JSON.parse(readFileSync(join(runDirectory, 'progress.json'), 'utf-8')),
    ).toEqual({ version: 1, nextBatch: 1, missingCustomerIds: [9] });
  });
});
