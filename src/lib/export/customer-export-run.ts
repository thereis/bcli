import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
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
} from './column-mapping.ts';
import { writeCsvFileAtomic } from './csv.ts';
import { loadOrCreateBatchGeneratedValues } from './generated-values.ts';

const settingsShape = {
  version: z.literal(1),
  key: z.string(),
  outputPrefix: z.string(),
  batchSize: z.number().int().positive(),
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
  createdAt: z.string(),
};

const frozenManifestSchema = z
  .object({
    ...settingsShape,
    customerCount: z.number().int().nonnegative(),
  })
  .strict();

const legacyManifestSchema = z
  .object({
    ...settingsShape,
    customerIds: z.array(z.number().int().positive()),
    nextBatch: z.number().int().nonnegative(),
    missingCustomerIds: z.array(z.number().int().positive()),
  })
  .strict();

const progressSchema = z
  .object({
    version: z.literal(1),
    nextBatch: z.number().int().nonnegative(),
    missingCustomerIds: z.array(z.number().int().positive()),
  })
  .strict();

export type CustomerExportManifest = z.infer<typeof legacyManifestSchema>;

const mappingSchema = frozenManifestSchema.shape.mapping;

const rosterCheckpointSchema = z
  .object({
    version: z.literal(1),
    key: z.string(),
    outputPrefix: z.string(),
    batchSize: z.number().int().positive(),
    requestDelayMs: z.number().int().nonnegative().default(0),
    concurrency: z.number().int().positive().default(1),
    limit: z.number().int().positive().optional(),
    mapping: mappingSchema,
    mappingFingerprint: z.string(),
    nextPage: z.number().int().positive(),
    totalPages: z.number().int().positive(),
    complete: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

export type CustomerExportRosterCheckpoint = z.infer<
  typeof rosterCheckpointSchema
>;

export type CustomerRosterPage = {
  page: number;
  totalPages: number;
  ids: number[];
  complete: boolean;
};

export type GetAllCustomerIdsOptions = {
  startPage?: number;
  collectedCount?: number;
  concurrency?: number;
  onPage?: (page: CustomerRosterPage) => void | Promise<void>;
};

export type CustomerBatchExportOptions = {
  key: string;
  resume: boolean;
  export: boolean;
  batchSize: number;
  requestDelayMs?: number;
  concurrency?: number;
  limit?: number;
  outputPrefix?: string;
  columns?: ColumnPlan;
};

export type CustomerBatchExportDeps = {
  getAllCustomerIds: (
    limit?: number,
    requestDelayMs?: number,
    options?: GetAllCustomerIdsOptions,
  ) => Promise<number[]>;
  fetchCustomersByIds: (
    ids: number[],
    requestDelayMs?: number,
    concurrency?: number,
  ) => Promise<Customer[]>;
  rootDir: string;
  now: () => string;
  randomUUID: () => string;
};

export type CustomerBatchExportResult = {
  runDirectory: string;
  manifestFile: string;
  customerCount: number;
  batchCount: number;
  completedBatches: number;
  written: number;
  missingCustomerIds: number[];
  files: string[];
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

export const customerExportRunDirectory = (rootDir: string, key: string) =>
  join(rootDir, requireSlug(key, 'Export key'));

export const customerExportManifestPath = (rootDir: string, key: string) =>
  join(customerExportRunDirectory(rootDir, key), 'manifest.json');

const customerExportRosterCheckpointPath = (rootDir: string, key: string) =>
  join(customerExportRunDirectory(rootDir, key), 'roster-checkpoint.json');

const customerExportRosterIdsPath = (rootDir: string, key: string) =>
  join(customerExportRunDirectory(rootDir, key), 'roster-ids.jsonl');

const customerExportIdsPath = (rootDir: string, key: string) =>
  join(customerExportRunDirectory(rootDir, key), 'customer-ids.jsonl');

const customerExportProgressPath = (rootDir: string, key: string) =>
  join(customerExportRunDirectory(rootDir, key), 'progress.json');

export const customerExportRunExists = (rootDir: string, key: string) =>
  existsSync(customerExportManifestPath(rootDir, key)) ||
  existsSync(customerExportRosterCheckpointPath(rootDir, key));

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

const writeIdsFile = (path: string, ids: number[]) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, ids.length === 0 ? '' : `${ids.join('\n')}\n`);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
};

const saveProgress = (
  path: string,
  progress: { nextBatch: number; missingCustomerIds: number[] },
) => {
  writeJsonAtomic(path, {
    version: 1,
    nextBatch: progress.nextBatch,
    missingCustomerIds: progress.missingCustomerIds,
  } satisfies z.infer<typeof progressSchema>);
};

const freezeManifest = (
  rootDir: string,
  key: string,
  manifest: CustomerExportManifest,
) => {
  const { customerIds, nextBatch, missingCustomerIds, ...settings } = manifest;
  writeIdsFile(customerExportIdsPath(rootDir, key), customerIds);
  writeJsonAtomic(customerExportManifestPath(rootDir, key), {
    ...settings,
    customerCount: customerIds.length,
  } satisfies z.infer<typeof frozenManifestSchema>);
  saveProgress(customerExportProgressPath(rootDir, key), {
    nextBatch,
    missingCustomerIds,
  });
};

const parseJsonFile = (path: string, label: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${label} "${path}": ${message}`);
  }
};

const appendRosterIds = (path: string, ids: number[]) => {
  if (ids.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${ids.join('\n')}\n`);
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

const loadRosterIds = (path: string): number[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const id = Number(line);
      return Number.isInteger(id) && id > 0 ? [id] : [];
    });
};

const loadRosterCheckpoint = (
  rootDir: string,
  key: string,
): CustomerExportRosterCheckpoint => {
  const path = customerExportRosterCheckpointPath(rootDir, key);
  if (!existsSync(path)) {
    throw new Error(
      `No saved export found for "${key}". Start it with --all before using --resume.`,
    );
  }
  const result = rosterCheckpointSchema.safeParse(
    parseJsonFile(path, 'export roster checkpoint'),
  );
  if (!result.success) {
    throw new Error(
      `Invalid export roster checkpoint "${path}": ${z.prettifyError(result.error)}`,
    );
  }
  const plan = compileColumnMapping(result.data.mapping);
  if (plan.fingerprint !== result.data.mappingFingerprint) {
    throw new Error(
      `Export roster checkpoint "${path}" has a mismatched column mapping.`,
    );
  }
  return result.data;
};

const removeRosterFiles = (rootDir: string, key: string) => {
  for (const path of [
    customerExportRosterIdsPath(rootDir, key),
    customerExportRosterCheckpointPath(rootDir, key),
  ]) {
    if (existsSync(path)) unlinkSync(path);
  }
};

const verifyMappingFingerprint = (
  path: string,
  data: { mapping: z.infer<typeof mappingSchema>; mappingFingerprint: string },
) => {
  const plan = compileColumnMapping(data.mapping);
  if (plan.fingerprint !== data.mappingFingerprint) {
    throw new Error(
      `Export manifest "${path}" has a mismatched column mapping.`,
    );
  }
};

export const loadCustomerExportManifest = (
  rootDir: string,
  key: string,
): CustomerExportManifest => {
  const path = customerExportManifestPath(rootDir, key);
  if (!existsSync(path)) {
    throw new Error(
      `No saved export found for "${key}". Start it with --all before using --resume.`,
    );
  }
  const raw = parseJsonFile(path, 'export manifest');
  const frozen = frozenManifestSchema.safeParse(raw);

  if (!frozen.success) {
    const legacy = legacyManifestSchema.safeParse(raw);
    if (!legacy.success) {
      throw new Error(
        `Invalid export manifest "${path}": ${z.prettifyError(frozen.error)}`,
      );
    }
    verifyMappingFingerprint(path, legacy.data);
    logger.info(
      `Splitting the saved ID list out of "${path}" so each batch no longer rewrites it.`,
    );
    freezeManifest(rootDir, key, legacy.data);
    return legacy.data;
  }

  verifyMappingFingerprint(path, frozen.data);

  const idsFile = customerExportIdsPath(rootDir, key);
  if (!existsSync(idsFile)) {
    throw new Error(`Export manifest "${path}" is missing its ID list.`);
  }
  const customerIds = loadRosterIds(idsFile);
  if (customerIds.length !== frozen.data.customerCount) {
    throw new Error(
      `Export ID list "${idsFile}" holds ${customerIds.length} IDs but the manifest expects ${frozen.data.customerCount}.`,
    );
  }

  const progressFile = customerExportProgressPath(rootDir, key);
  const progress = existsSync(progressFile)
    ? progressSchema.safeParse(parseJsonFile(progressFile, 'export progress'))
    : undefined;
  if (progress && !progress.success) {
    throw new Error(
      `Invalid export progress "${progressFile}": ${z.prettifyError(progress.error)}`,
    );
  }

  const { customerCount: _customerCount, ...settings } = frozen.data;
  return {
    ...settings,
    customerIds,
    nextBatch: progress?.data.nextBatch ?? 0,
    missingCustomerIds: progress?.data.missingCustomerIds ?? [],
  };
};

const batchFilePath = (
  runDirectory: string,
  outputPrefix: string,
  batchIndex: number,
) =>
  join(
    runDirectory,
    `${outputPrefix}-${String(batchIndex + 1).padStart(6, '0')}.csv`,
  );

const uniqueSortedIds = (ids: number[]) =>
  [...new Set(ids)].filter((id) => id > 0).sort((left, right) => left - right);

const collectAndFreezeRoster = async (
  options: CustomerBatchExportOptions,
  deps: CustomerBatchExportDeps,
  plan: ColumnPlan,
  existing?: CustomerExportRosterCheckpoint,
): Promise<CustomerExportManifest> => {
  const checkpointFile = customerExportRosterCheckpointPath(
    deps.rootDir,
    options.key,
  );
  const idsFile = customerExportRosterIdsPath(deps.rootDir, options.key);
  const outputPrefix =
    existing?.outputPrefix ??
    requireSlug(options.outputPrefix ?? options.key, 'Output prefix');
  const batchSize = existing?.batchSize ?? options.batchSize;
  const requestDelayMs =
    existing?.requestDelayMs ?? options.requestDelayMs ?? 0;
  const concurrency = options.concurrency ?? existing?.concurrency ?? 1;
  const limit = existing?.limit ?? options.limit;
  const createdAt = existing?.createdAt ?? deps.now();

  if (existing && existing.nextPage > 1 && !existsSync(idsFile)) {
    throw new Error(
      `Incomplete roster checkpoint "${checkpointFile}": missing roster ID list.`,
    );
  }

  if (existing && !existing.complete) {
    logger.info(
      `Resuming roster from page ${existing.nextPage} (${loadRosterIds(idsFile).length} IDs already collected)`,
    );
  }

  const persistPage = async (page: CustomerRosterPage) => {
    appendRosterIds(idsFile, page.ids);
    writeJsonAtomic(checkpointFile, {
      version: 1,
      key: options.key,
      outputPrefix,
      batchSize,
      requestDelayMs,
      concurrency,
      ...(limit === undefined ? {} : { limit }),
      mapping: plan.mapping,
      mappingFingerprint: plan.fingerprint,
      nextPage: page.page + 1,
      totalPages: page.totalPages,
      complete: page.complete,
      createdAt,
    } satisfies CustomerExportRosterCheckpoint);
  };

  let fetched: number[] = [];
  if (!existing?.complete) {
    fetched = await deps.getAllCustomerIds(limit, requestDelayMs, {
      startPage: existing?.nextPage ?? 1,
      collectedCount: loadRosterIds(idsFile).length,
      concurrency,
      onPage: options.export ? persistPage : undefined,
    });
  }

  const diskIds = loadRosterIds(idsFile);
  const merged = uniqueSortedIds(
    diskIds.length > 0 ? [...diskIds, ...fetched] : fetched,
  );
  const customerIds = limit ? merged.slice(0, limit) : merged;
  const manifest: CustomerExportManifest = {
    version: 1,
    key: options.key,
    outputPrefix,
    batchSize,
    requestDelayMs,
    concurrency,
    limit,
    mapping: plan.mapping,
    mappingFingerprint: plan.fingerprint,
    customerIds,
    nextBatch: 0,
    missingCustomerIds: [],
    createdAt,
  };
  if (options.export) {
    freezeManifest(deps.rootDir, options.key, manifest);
    removeRosterFiles(deps.rootDir, options.key);
  }
  return manifest;
};

export const runCustomerBatchExport = async (
  options: CustomerBatchExportOptions,
  deps: CustomerBatchExportDeps,
): Promise<CustomerBatchExportResult> => {
  const runDirectory = customerExportRunDirectory(deps.rootDir, options.key);
  const manifestFile = customerExportManifestPath(deps.rootDir, options.key);
  const progressFile = customerExportProgressPath(deps.rootDir, options.key);
  const checkpointFile = customerExportRosterCheckpointPath(
    deps.rootDir,
    options.key,
  );

  let manifest: CustomerExportManifest;
  let plan: ColumnPlan;

  if (options.resume) {
    if (existsSync(manifestFile)) {
      manifest = loadCustomerExportManifest(deps.rootDir, options.key);
      plan = compileColumnMapping(manifest.mapping);
      removeRosterFiles(deps.rootDir, options.key);
    } else if (existsSync(checkpointFile)) {
      const checkpoint = loadRosterCheckpoint(deps.rootDir, options.key);
      plan = compileColumnMapping(checkpoint.mapping);
      manifest = await collectAndFreezeRoster(options, deps, plan, checkpoint);
    } else {
      throw new Error(
        `No saved export found for "${options.key}". Start it with --all before using --resume.`,
      );
    }
  } else {
    if (!options.columns) {
      throw new Error('A new export requires --columns or --columns-file.');
    }
    if (existsSync(manifestFile) || existsSync(checkpointFile)) {
      throw new Error(
        `Export "${options.key}" already exists. Use --resume or choose a new key.`,
      );
    }
    plan = options.columns;
    manifest = await collectAndFreezeRoster(options, deps, plan);
  }

  const batchCount = Math.ceil(
    manifest.customerIds.length / manifest.batchSize,
  );
  if (!options.export) {
    return {
      runDirectory,
      manifestFile,
      customerCount: manifest.customerIds.length,
      batchCount,
      completedBatches: 0,
      written: 0,
      missingCustomerIds: [],
      files: [],
      exported: false,
    };
  }

  let written = 0;
  for (
    let batchIndex = manifest.nextBatch;
    batchIndex < batchCount;
    batchIndex++
  ) {
    const start = batchIndex * manifest.batchSize;
    const ids = manifest.customerIds.slice(start, start + manifest.batchSize);
    const file = batchFilePath(runDirectory, manifest.outputPrefix, batchIndex);
    const generatedValues = loadOrCreateBatchGeneratedValues({
      runDirectory,
      batchIndex,
      mappingFingerprint: manifest.mappingFingerprint,
      customerIds: ids,
      columns: plan.generatedColumns,
      batchFile: file,
      randomUUID: deps.randomUUID,
    });
    const customers = await deps.fetchCustomersByIds(
      ids,
      manifest.requestDelayMs,
      options.concurrency ?? manifest.concurrency,
    );
    const byId = new Map(customers.map((customer) => [customer.id, customer]));
    const orderedCustomers = ids.flatMap((id) => {
      const customer = byId.get(id);
      return customer ? [customer] : [];
    });
    const missingIds = ids.filter((id) => !byId.has(id));
    writeCsvFileAtomic(
      file,
      plan.headers,
      orderedCustomers.map((customer) =>
        buildMappedRow(
          customer,
          plan,
          generatedValues?.bindingsFor(customer.id),
        ),
      ),
    );

    written += orderedCustomers.length;
    manifest = {
      ...manifest,
      nextBatch: batchIndex + 1,
      missingCustomerIds: uniqueSortedIds([
        ...manifest.missingCustomerIds,
        ...missingIds,
      ]),
    };
    saveProgress(progressFile, manifest);
  }

  return {
    runDirectory,
    manifestFile,
    customerCount: manifest.customerIds.length,
    batchCount,
    completedBatches: manifest.nextBatch,
    written,
    missingCustomerIds: manifest.missingCustomerIds,
    files: Array.from({ length: manifest.nextBatch }, (_, batchIndex) =>
      batchFilePath(runDirectory, manifest.outputPrefix, batchIndex),
    ),
    exported: true,
  };
};
