import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
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
  customerStreamRunExists,
  loadCustomerStreamState,
  runCustomerStreamExport,
} from './customer-stream-export.ts';

const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'customer-stream-'));
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

const uuidColumns = loadColumnPlan({
  kind: 'inline',
  value: 'uuid:{uuidv4},customerId:id',
});

const fixedUuid = () => '00000000-0000-4000-8000-000000000001';

const pagedStore = (total: number, pageSize = 250) => {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requested: number[] = [];
  const fetchCustomerPage = async (page: number, _delay?: number) => {
    requested.push(page);
    const start = (page - 1) * pageSize;
    return {
      customers: Array.from(
        { length: Math.max(0, Math.min(pageSize, total - start)) },
        (_unused, index) => makeCustomer(start + index + 1),
      ),
      totalPages,
      total,
    };
  };
  return { fetchCustomerPage, requested };
};

const dataRows = (file: string) =>
  readFileSync(file, 'utf-8').trim().split('\n').slice(1);

describe('runCustomerStreamExport', () => {
  test('streams every page into one merged CSV', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(1_000);

    const result = await runCustomerStreamExport(
      {
        key: 'Stream Run',
        resume: false,
        export: true,
        concurrency: 4,
        columns,
      },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.total).toBe(1_000);
    expect(result.totalPages).toBe(4);
    expect(result.written).toBe(1_000);
    expect(result.outputFile).toBe(
      join(rootDir, 'stream-run', 'stream-run.csv'),
    );

    const rows = dataRows(result.outputFile);
    expect(rows).toHaveLength(1_000);
    expect(rows[0]).toBe('"1","user-1@example.com"');
    expect(rows.at(-1)).toBe('"1000","user-1000@example.com"');

    const merged = readFileSync(result.outputFile, 'utf-8');
    expect(merged.split('\n')[0]).toBe('"customerId","email"');
    expect(merged.match(/"customerId","email"/g)).toHaveLength(1);
  });

  test('fetches each page exactly once across parallel shards', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(2_500);

    await runCustomerStreamExport(
      { key: 'once', resume: false, export: true, concurrency: 5, columns },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    const pages = [...store.requested].sort((left, right) => left - right);
    expect(pages).toEqual([1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(pages.slice(1)).size).toBe(10);
  });

  test('never holds more than one page of customers per shard', async () => {
    const rootDir = temporaryDirectory();
    let live = 0;
    let peak = 0;

    await runCustomerStreamExport(
      { key: 'memory', resume: false, export: true, concurrency: 2, columns },
      {
        fetchCustomerPage: async (page) => {
          live++;
          peak = Math.max(peak, live);
          await Bun.sleep(1);
          live--;
          const start = (page - 1) * 250;
          return {
            customers: Array.from({ length: 250 }, (_unused, index) =>
              makeCustomer(start + index + 1),
            ),
            totalPages: 8,
            total: 2_000,
          };
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(peak).toBe(2);
  });

  test('resumes from the last completed page without refetching', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(1_000);

    await expect(
      runCustomerStreamExport(
        { key: 'retry', resume: false, export: true, concurrency: 1, columns },
        {
          fetchCustomerPage: async (page, delay) => {
            if (page === 3) throw new Error('page three failed');
            return store.fetchCustomerPage(page, delay);
          },
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('page three failed');

    expect(customerStreamRunExists(rootDir, 'retry')).toBe(true);
    const state = loadCustomerStreamState(rootDir, 'retry');
    expect(state.shards[0]?.nextPage).toBe(3);
    expect(state.shards[0]?.rows).toBe(500);

    const resumed: number[] = [];
    const result = await runCustomerStreamExport(
      { key: 'retry', resume: true, export: true },
      {
        fetchCustomerPage: async (page, delay) => {
          resumed.push(page);
          return store.fetchCustomerPage(page, delay);
        },
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(resumed).toEqual([3, 4]);
    expect(result.written).toBe(1_000);
    expect(dataRows(result.outputFile)).toHaveLength(1_000);
  });

  test('truncates a partially written part file before resuming', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(500);

    await expect(
      runCustomerStreamExport(
        { key: 'torn', resume: false, export: true, concurrency: 1, columns },
        {
          fetchCustomerPage: async (page, delay) => {
            if (page === 2) throw new Error('interrupted');
            return store.fetchCustomerPage(page, delay);
          },
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow('interrupted');

    const partFile = join(rootDir, 'torn', 'torn-part-001.csv');
    writeFileSync(partFile, `${readFileSync(partFile, 'utf-8')}"9","tor`);

    const result = await runCustomerStreamExport(
      { key: 'torn', resume: true, export: true },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    const rows = dataRows(result.outputFile);
    expect(rows).toHaveLength(500);
    expect(rows.some((row) => row.includes('tor'))).toBe(false);
  });

  test('generates a fresh uuid per row', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(10, 10);
    let counter = 0;

    const result = await runCustomerStreamExport(
      { key: 'uuids', resume: false, export: true, columns: uuidColumns },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: () =>
          `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
      },
    );

    const uuids = dataRows(result.outputFile).map(
      (row) => row.split(',')[0] ?? '',
    );
    expect(new Set(uuids).size).toBe(10);
  });

  test('caps a sample export at the requested limit', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(10_000);

    const result = await runCustomerStreamExport(
      { key: 'sample', resume: false, export: true, limit: 300, columns },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.written).toBe(300);
    expect(dataRows(result.outputFile)).toHaveLength(300);
  });

  test('dry run reports the plan without writing anything', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(1_000);

    const result = await runCustomerStreamExport(
      { key: 'dry', resume: false, export: false, columns },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.exported).toBe(false);
    expect(result.total).toBe(1_000);
    expect(result.totalPages).toBe(4);
    expect(store.requested).toEqual([1]);
    expect(existsSync(result.stateFile)).toBe(false);
    expect(customerStreamRunExists(rootDir, 'dry')).toBe(false);
  });

  test('rejects a new export that would overwrite a saved run', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(250);
    const start = {
      key: 'dupe',
      resume: false,
      export: true,
      columns,
    } as const;

    await runCustomerStreamExport(start, {
      fetchCustomerPage: store.fetchCustomerPage,
      rootDir,
      now: () => '2026-08-21T12:00:00.000Z',
      randomUUID: fixedUuid,
    });

    await expect(
      runCustomerStreamExport(start, {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      }),
    ).rejects.toThrow(/already exists/);
  });

  test('requires a column mapping for a new export', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(250);

    await expect(
      runCustomerStreamExport(
        { key: 'nocols', resume: false, export: true },
        {
          fetchCustomerPage: store.fetchCustomerPage,
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow(/requires --columns/);
  });

  test('rejects resuming an export that was never started', async () => {
    const rootDir = temporaryDirectory();
    expect(() => loadCustomerStreamState(rootDir, 'missing')).toThrow(
      /No saved stream export/,
    );
  });

  test('rejects a corrupt state file', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(250);
    await runCustomerStreamExport(
      { key: 'corrupt', resume: false, export: true, columns },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    const stateFile = join(rootDir, 'corrupt', 'stream-state.json');
    writeFileSync(stateFile, '{ not json');
    expect(() => loadCustomerStreamState(rootDir, 'corrupt')).toThrow(
      /Could not read stream export state/,
    );

    writeFileSync(stateFile, JSON.stringify({ version: 1 }));
    expect(() => loadCustomerStreamState(rootDir, 'corrupt')).toThrow(
      /Invalid stream export state/,
    );
  });

  test('rejects a state file whose mapping no longer matches', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(250);
    await runCustomerStreamExport(
      { key: 'drift', resume: false, export: true, columns },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    const stateFile = join(rootDir, 'drift', 'stream-state.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
    state.mappingFingerprint = 'not-the-real-fingerprint';
    writeFileSync(stateFile, JSON.stringify(state));

    expect(() => loadCustomerStreamState(rootDir, 'drift')).toThrow(
      /mismatched column mapping/,
    );
  });

  test('writes a header-only file for an empty store', async () => {
    const rootDir = temporaryDirectory();
    const result = await runCustomerStreamExport(
      { key: 'empty', resume: false, export: true, columns },
      {
        fetchCustomerPage: async () => ({
          customers: [],
          totalPages: 0,
          total: 0,
        }),
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(result.written).toBe(0);
    expect(readFileSync(result.outputFile, 'utf-8')).toBe(
      '"customerId","email"\n',
    );
  });

  test('ignores concurrency for a sample export', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(10_000);
    const result = await runCustomerStreamExport(
      {
        key: 'sample-serial',
        resume: false,
        export: true,
        limit: 300,
        concurrency: 16,
        columns,
      },
      {
        fetchCustomerPage: store.fetchCustomerPage,
        rootDir,
        now: () => '2026-08-21T12:00:00.000Z',
        randomUUID: fixedUuid,
      },
    );

    expect(loadCustomerStreamState(rootDir, 'sample-serial').concurrency).toBe(
      1,
    );
    expect(result.written).toBe(300);
  });

  test('rejects an export key with no usable slug', async () => {
    const rootDir = temporaryDirectory();
    const store = pagedStore(250);
    await expect(
      runCustomerStreamExport(
        { key: '///', resume: false, export: true, columns },
        {
          fetchCustomerPage: store.fetchCustomerPage,
          rootDir,
          now: () => '2026-08-21T12:00:00.000Z',
          randomUUID: fixedUuid,
        },
      ),
    ).rejects.toThrow(/at least one letter or number/);
  });
});
