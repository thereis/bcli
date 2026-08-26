import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Customer } from '../bigcommerce/schemas.ts';
import { logger } from '../shared/logger.ts';
import {
  buildMappedRow,
  type ColumnPlan,
  compileColumnMapping,
  type RowBindings,
} from './column-mapping.ts';
import { appendCsvRows, mergeCsvFiles } from './csv.ts';

const PAGE_SIZE = 250;

const shardSchema = z
  .object({
    firstPage: z.number().int().positive(),
    lastPage: z.number().int().nonnegative(),
    nextPage: z.number().int().positive(),
    bytes: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
  })
  .strict();

const streamStateSchema = z
  .object({
    version: z.literal(1),
    key: z.string(),
    outputPrefix: z.string(),
    pageSize: z.number().int().positive(),
    requestDelayMs: z.number().int().nonnegative().default(0),
    concurrency: z.number().int().positive().default(1),
    limit: z.number().int().positive().optional(),
    mapping: z
      .object({
        version: z.literal(1),
        columns: z.array(
          z.object({ header: z.string(), source: z.string() }).strict(),
        ),
      })
      .strict(),
    mappingFingerprint: z.string(),
    totalPages: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    shards: z.array(shardSchema),
    createdAt: z.string(),
  })
  .strict();

export type CustomerStreamState = z.infer<typeof streamStateSchema>;

export type CustomerStreamExportOptions = {
  key: string;
  resume: boolean;
  export: boolean;
  concurrency?: number;
  requestDelayMs?: number;
  limit?: number;
  outputPrefix?: string;
  columns?: ColumnPlan;
};

export type CustomerPage = {
  customers: Customer[];
  totalPages: number;
  total: number;
};

export type CustomerStreamExportDeps = {
  fetchCustomerPage: (
    page: number,
    requestDelayMs?: number,
    pageSize?: number,
  ) => Promise<CustomerPage>;
  rootDir: string;
  now: () => string;
  randomUUID: () => string;
};

export type CustomerStreamExportResult = {
  runDirectory: string;
  stateFile: string;
  outputFile: string;
  total: number;
  totalPages: number;
  completedPages: number;
  written: number;
  parts: string[];
  exported: boolean;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const requireSlug = (value: string, label: string) => {
  const slug = slugify(value);
  if (!slug)
    throw new Error(`${label} must contain at least one letter or number.`);
  return slug;
};

export const customerStreamRunDirectory = (rootDir: string, key: string) =>
  join(rootDir, requireSlug(key, 'Export key'));

export const customerStreamStatePath = (rootDir: string, key: string) =>
  join(customerStreamRunDirectory(rootDir, key), 'stream-state.json');

export const customerStreamRunExists = (rootDir: string, key: string) =>
  existsSync(customerStreamStatePath(rootDir, key));

const partFilePath = (
  runDirectory: string,
  outputPrefix: string,
  shardIndex: number,
) =>
  join(
    runDirectory,
    `${outputPrefix}-part-${String(shardIndex + 1).padStart(3, '0')}.csv`,
  );

const writeJsonAtomic = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
};

export const loadCustomerStreamState = (
  rootDir: string,
  key: string,
): CustomerStreamState => {
  const path = customerStreamStatePath(rootDir, key);
  if (!existsSync(path)) {
    throw new Error(
      `No saved stream export found for "${key}". Start it with --all --stream before using --resume.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read stream export state "${path}": ${message}`);
  }
  const result = streamStateSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid stream export state "${path}": ${z.prettifyError(result.error)}`,
    );
  }
  const plan = compileColumnMapping(result.data.mapping);
  if (plan.fingerprint !== result.data.mappingFingerprint) {
    throw new Error(
      `Stream export state "${path}" has a mismatched column mapping.`,
    );
  }
  return result.data;
};

const planShards = (totalPages: number, concurrency: number) => {
  const workers = Math.min(Math.max(1, concurrency), Math.max(1, totalPages));
  const perWorker = Math.ceil(totalPages / workers);
  return Array.from({ length: workers }, (_unused, index) => {
    const firstPage = index * perWorker + 1;
    const lastPage = Math.min(totalPages, firstPage + perWorker - 1);
    return { firstPage, lastPage, nextPage: firstPage, bytes: 0, rows: 0 };
  }).filter((shard) => shard.firstPage <= totalPages);
};

export const runCustomerStreamExport = async (
  options: CustomerStreamExportOptions,
  deps: CustomerStreamExportDeps,
): Promise<CustomerStreamExportResult> => {
  const runDirectory = customerStreamRunDirectory(deps.rootDir, options.key);
  const stateFile = customerStreamStatePath(deps.rootDir, options.key);

  let state: CustomerStreamState;
  let plan: ColumnPlan;

  if (options.resume) {
    state = loadCustomerStreamState(deps.rootDir, options.key);
    plan = compileColumnMapping(state.mapping);
  } else {
    if (!options.columns) {
      throw new Error('A new export requires --columns or --columns-file.');
    }
    if (existsSync(stateFile)) {
      throw new Error(
        `Export "${options.key}" already exists. Use --resume or choose a new key.`,
      );
    }
    plan = options.columns;
    const requestDelayMs = options.requestDelayMs ?? 0;
    const limit = options.limit;
    const pageSize = limit ? Math.min(PAGE_SIZE, limit) : PAGE_SIZE;
    if (limit && options.concurrency !== undefined && options.concurrency > 1) {
      logger.warn(
        '--limit samples the oldest pages sequentially; ignoring --concurrency.',
      );
    }
    const concurrency = limit ? 1 : Math.max(1, options.concurrency ?? 1);

    const probe = await deps.fetchCustomerPage(1, requestDelayMs, pageSize);
    const totalPages = limit
      ? Math.min(probe.totalPages, Math.ceil(limit / pageSize))
      : probe.totalPages;

    state = {
      version: 1,
      key: options.key,
      outputPrefix: requireSlug(
        options.outputPrefix ?? options.key,
        'Output prefix',
      ),
      pageSize,
      requestDelayMs,
      concurrency,
      limit,
      mapping: plan.mapping,
      mappingFingerprint: plan.fingerprint,
      totalPages,
      total: limit ? Math.min(probe.total, limit) : probe.total,
      shards: planShards(totalPages, concurrency),
      createdAt: deps.now(),
    };

    logger.info(
      `${state.total.toLocaleString('en-US')} customers across ${totalPages.toLocaleString('en-US')} pages, ${state.shards.length} parallel writer(s)`,
    );
  }

  const outputFile = join(runDirectory, `${state.outputPrefix}.csv`);
  const parts = state.shards.map((_shard, index) =>
    partFilePath(runDirectory, state.outputPrefix, index),
  );

  if (!options.export) {
    return {
      runDirectory,
      stateFile,
      outputFile,
      total: state.total,
      totalPages: state.totalPages,
      completedPages: 0,
      written: 0,
      parts: [],
      exported: false,
    };
  }

  writeJsonAtomic(stateFile, state);

  let stateWrite = Promise.resolve();
  const saveState = () => {
    const snapshot = JSON.parse(JSON.stringify(state));
    stateWrite = stateWrite.then(() => {
      writeJsonAtomic(stateFile, snapshot);
    });
    return stateWrite;
  };

  const bindings = (): RowBindings =>
    Object.fromEntries(
      plan.generatedColumns.map((column) => [column.slot, deps.randomUUID()]),
    ) as RowBindings;

  const startedRows = state.shards.reduce((sum, shard) => sum + shard.rows, 0);
  let completedPages = state.shards.reduce(
    (sum, shard) => sum + (shard.nextPage - shard.firstPage),
    0,
  );
  if (completedPages > 0) {
    logger.info(
      `Resuming at ${completedPages.toLocaleString('en-US')}/${state.totalPages.toLocaleString('en-US')} pages (${startedRows.toLocaleString('en-US')} rows already written)`,
    );
  }

  await Promise.all(
    state.shards.map(async (shard, index) => {
      const partFile = parts[index];
      if (partFile === undefined) return;
      if (existsSync(partFile) && statSync(partFile).size !== shard.bytes) {
        truncateSync(partFile, shard.bytes);
      }
      while (shard.nextPage <= shard.lastPage) {
        const page = await deps.fetchCustomerPage(
          shard.nextPage,
          state.requestDelayMs,
          state.pageSize,
        );
        const remaining =
          state.limit === undefined
            ? page.customers.length
            : Math.max(
                0,
                state.limit -
                  state.shards.reduce((sum, entry) => sum + entry.rows, 0),
              );
        const rows = page.customers
          .slice(0, remaining)
          .map((customer) => buildMappedRow(customer, plan, bindings()));
        appendCsvRows(partFile, plan.headers, rows);
        shard.nextPage++;
        shard.rows += rows.length;
        shard.bytes = statSync(partFile).size;
        completedPages++;
        if (rows.length < page.customers.length) {
          shard.nextPage = shard.lastPage + 1;
        }
        if (completedPages % 25 === 0 || completedPages === state.totalPages) {
          logger.info(
            `${completedPages.toLocaleString('en-US')}/${state.totalPages.toLocaleString('en-US')} pages`,
          );
        }
        await saveState();
      }
    }),
  );

  await stateWrite;

  const written = state.shards.reduce((sum, shard) => sum + shard.rows, 0);
  if (parts.length === 0) {
    appendCsvRows(outputFile, plan.headers, []);
  } else {
    await mergeCsvFiles(parts, outputFile);
  }
  logger.info(
    `Merged ${parts.length} part file(s) into ${outputFile} (${written.toLocaleString('en-US')} rows)`,
  );

  return {
    runDirectory,
    stateFile,
    outputFile,
    total: state.total,
    totalPages: state.totalPages,
    completedPages,
    written,
    parts,
    exported: true,
  };
};
