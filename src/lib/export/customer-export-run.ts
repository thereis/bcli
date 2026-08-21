import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Customer } from '../bigcommerce/schemas.ts';
import {
  buildMappedRow,
  type ColumnPlan,
  compileColumnMapping,
} from './column-mapping.ts';
import { writeCsvFileAtomic } from './csv.ts';
import { loadOrCreateBatchGeneratedValues } from './generated-values.ts';

const manifestSchema = z
  .object({
    version: z.literal(1),
    key: z.string(),
    outputPrefix: z.string(),
    batchSize: z.number().int().positive(),
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
    customerIds: z.array(z.number().int().positive()),
    nextBatch: z.number().int().nonnegative(),
    missingCustomerIds: z.array(z.number().int().positive()),
    createdAt: z.string(),
  })
  .strict();

export type CustomerExportManifest = z.infer<typeof manifestSchema>;

export type CustomerBatchExportOptions = {
  key: string;
  resume: boolean;
  export: boolean;
  batchSize: number;
  limit?: number;
  outputPrefix?: string;
  columns?: ColumnPlan;
};

export type CustomerBatchExportDeps = {
  getAllCustomerIds: (limit?: number) => Promise<number[]>;
  fetchCustomersByIds: (ids: number[]) => Promise<Customer[]>;
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

export const customerExportRunExists = (rootDir: string, key: string) =>
  existsSync(customerExportManifestPath(rootDir, key));

const saveManifest = (path: string, manifest: CustomerExportManifest) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
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
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read export manifest "${path}": ${message}`);
  }
  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid export manifest "${path}": ${z.prettifyError(result.error)}`,
    );
  }
  const plan = compileColumnMapping(result.data.mapping);
  if (plan.fingerprint !== result.data.mappingFingerprint) {
    throw new Error(
      `Export manifest "${path}" has a mismatched column mapping.`,
    );
  }
  return result.data;
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

export const runCustomerBatchExport = async (
  options: CustomerBatchExportOptions,
  deps: CustomerBatchExportDeps,
): Promise<CustomerBatchExportResult> => {
  const runDirectory = customerExportRunDirectory(deps.rootDir, options.key);
  const manifestFile = customerExportManifestPath(deps.rootDir, options.key);

  let manifest: CustomerExportManifest;
  let plan: ColumnPlan;

  if (options.resume) {
    manifest = loadCustomerExportManifest(deps.rootDir, options.key);
    plan = compileColumnMapping(manifest.mapping);
  } else {
    if (!options.columns) {
      throw new Error('A new export requires --columns or --columns-file.');
    }
    if (existsSync(manifestFile)) {
      throw new Error(
        `Export "${options.key}" already exists. Use --resume or choose a new key.`,
      );
    }
    plan = options.columns;
    const allCustomerIds = uniqueSortedIds(
      await deps.getAllCustomerIds(options.limit),
    );
    const customerIds = options.limit
      ? allCustomerIds.slice(0, options.limit)
      : allCustomerIds;
    const outputPrefix = requireSlug(
      options.outputPrefix ?? options.key,
      'Output prefix',
    );
    manifest = {
      version: 1,
      key: options.key,
      outputPrefix,
      batchSize: options.batchSize,
      limit: options.limit,
      mapping: plan.mapping,
      mappingFingerprint: plan.fingerprint,
      customerIds,
      nextBatch: 0,
      missingCustomerIds: [],
      createdAt: deps.now(),
    };
    if (options.export) saveManifest(manifestFile, manifest);
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
    const customers = await deps.fetchCustomersByIds(ids);
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
    saveManifest(manifestFile, manifest);
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
