import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Customer } from '../../../lib/bigcommerce/schemas.ts';
import {
  type FormField,
  isKnownFormField,
  loadFormFields,
} from '../../../lib/config/form-fields.ts';
import { loadColumnPlan } from '../../../lib/export/column-mapping.ts';
import {
  buildRow,
  type ColumnSpec,
  parseColumnSpec,
} from '../../../lib/export/column-spec.ts';
import {
  appendCsvRow,
  obscure,
  readCsvColumnValues,
} from '../../../lib/export/csv.ts';
import {
  type CustomerBatchExportDeps,
  type CustomerBatchExportResult,
  customerExportRunExists,
  runCustomerBatchExport,
} from '../../../lib/export/customer-export-run.ts';
import {
  exitWithError,
  exitWithInfo,
  runHandler,
} from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export type ExportCustomersArgs = { key: string };

export type ExportCustomersOptions = {
  field?: string;
  value?: string;
  columns?: string;
  columnsFile?: string;
  fullColumns?: string;
  outputPrefix?: string;
  resume: boolean;
  export: boolean;
  incremental: boolean;
  all?: boolean;
  batchSize?: number;
  limit?: number;
  requestDelayMs?: number;
};

export type ExportCustomersDeps = {
  loadFormFields: () => FormField[];
  cleanProgress: (path: string) => void;
  getCustomerIdsByFormField: (
    field: string,
    value: string,
    progressFile: string,
  ) => Promise<number[]>;
  getCustomersByIds: (
    ids: number[],
    progressFile: string,
    onCustomer: (customer: Customer) => void,
  ) => Promise<number>;
  existsSync: (path: string) => boolean;
  readCsvColumnValues: (file: string, column: string) => Promise<Set<string>>;
  appendCsvRow: (file: string, row: Record<string, string>) => void;
  today: () => string;
};

export type ExportCustomersResult = {
  customerIds: number[];
  written: number;
  baseFile: string;
  cleanFile: string;
  exported: boolean;
};

export type ExportAllCustomersDeps = CustomerBatchExportDeps & {
  loadFormFields: () => FormField[];
};

const requireOption = (value: string | undefined, name: string): string => {
  if (!value) {
    return exitWithError(`Missing required option --${name}.`);
  }
  return value;
};

export const validateField = (
  field: string,
  value: string,
  known: FormField[],
): void => {
  if (known.length > 0 && !isKnownFormField(field, known)) {
    exitWithError(
      `Field "${field}" is not registered in ~/.bcli/form-fields.json. Known: ${known.map((f) => f.name).join(', ')}`,
    );
  }
  const registered = known.find((f) => f.name === field);
  if (registered?.options && !registered.options.includes(value)) {
    exitWithError(
      `Value "${value}" is not allowed for "${field}". Allowed: ${registered.options.join(', ')}`,
    );
  }
};

export const exportCustomersHandler = async (
  args: ExportCustomersArgs,
  options: ExportCustomersOptions,
  deps: ExportCustomersDeps,
): Promise<ExportCustomersResult> => {
  if (!options.field || !options.value || !options.columns) {
    exitWithError(
      'Filtered exports require --field, --value, and --columns. Use --all for a complete customer export.',
    );
  }
  const field = requireOption(options.field, 'field');
  const value = requireOption(options.value, 'value');
  const columnSpec = requireOption(options.columns, 'columns');
  const known = deps.loadFormFields();
  validateField(field, value, known);

  const columns = parseColumnSpec(columnSpec);
  const fullColumns: ColumnSpec[] = options.fullColumns
    ? parseColumnSpec(options.fullColumns)
    : [{ name: 'Customer ID', source: 'id' }, ...columns];

  const prefix = options.outputPrefix ?? slugify(args.key);
  const progressFile = `.progress-${slugify(args.key)}.json`;
  const today = deps.today();
  const baseFile = `exports/${prefix}.csv`;
  const cleanSuffix = options.incremental ? '-incremental' : '';
  const cleanFile = `exports/${prefix}_${today}${cleanSuffix}.csv`;

  if (!options.resume) {
    deps.cleanProgress(progressFile);
  }

  logger.info(`[${args.key}] Fetching form field "${options.field}"...`);

  const customerIds = await deps.getCustomerIdsByFormField(
    field,
    value,
    progressFile,
  );

  logger.info(
    `Found ${customerIds.length} customers with ${options.field} = ${options.value}`,
  );

  if (customerIds.length === 0) {
    deps.cleanProgress(progressFile);
    exitWithInfo('No customers found. Exiting.', 0);
  }

  let idsToFetch = customerIds;

  if (options.incremental && deps.existsSync(baseFile)) {
    const existingIds = await deps.readCsvColumnValues(baseFile, 'Customer ID');
    idsToFetch = customerIds.filter((id) => !existingIds.has(String(id)));
    logger.info(
      `[Incremental] ${existingIds.size} already exported, ${idsToFetch.length} new customers to fetch`,
    );
  } else if (options.incremental) {
    logger.info(
      '[Incremental] No base export found, creating it with all customers',
    );
  }

  if (idsToFetch.length === 0) {
    deps.cleanProgress(progressFile);
    exitWithInfo('No new customers to fetch. Exiting.', 0);
  }

  if (options.export) {
    logger.info(`Fetching customer details → ${cleanFile}`);
  } else {
    logger.info('Fetching customer details...');
  }

  let total = 0;
  const count = await deps.getCustomersByIds(
    idsToFetch,
    progressFile,
    (customer) => {
      total++;
      logger.debug(
        `[${args.key} #${total}] ${obscure(customer.email)} | ${customer.id}`,
      );
      if (options.export) {
        deps.appendCsvRow(baseFile, buildRow(customer, fullColumns));
        deps.appendCsvRow(cleanFile, buildRow(customer, columns));
      }
    },
  );

  logger.info(`Found ${count} customers`);
  deps.cleanProgress(progressFile);

  if (options.export) {
    logger.info(
      `Done. ${total} customers written to: ${cleanFile} (for import), ${baseFile} (base, with Customer ID)`,
    );
  } else {
    logger.info(`Done. ${total} customers found.`);
  }

  return {
    customerIds,
    written: total,
    baseFile,
    cleanFile,
    exported: options.export,
  };
};

export const exportAllCustomersHandler = async (
  args: ExportCustomersArgs,
  options: ExportCustomersOptions,
  deps: ExportAllCustomersDeps,
): Promise<CustomerBatchExportResult> => {
  if (options.resume && !options.export) {
    exitWithError(
      'Resuming a batch export requires --export: bcli export customers <key> --resume --export',
    );
  }
  if (!options.resume) {
    if (!options.all) {
      exitWithError('Batch exports require --all.');
    }
    if (options.field || options.value) {
      exitWithError('--all cannot be combined with --field or --value.');
    }
    if (options.incremental) {
      exitWithError(
        '--incremental is not used with --all. Resume the saved run or start a new export key.',
      );
    }
    if (options.fullColumns) {
      exitWithError('--full-columns is not used with batched exports.');
    }
    if (Boolean(options.columns) === Boolean(options.columnsFile)) {
      exitWithError('Use exactly one of --columns or --columns-file.');
    }
  } else if (
    options.columns ||
    options.columnsFile ||
    options.field ||
    options.value ||
    options.incremental ||
    options.fullColumns ||
    options.outputPrefix ||
    options.limit ||
    options.requestDelayMs !== undefined
  ) {
    exitWithError(
      'Resume uses the saved selection, mapping, and batch settings. Run only: bcli export customers <key> --resume --export',
    );
  }

  const columns = options.resume
    ? undefined
    : loadColumnPlan(
        options.columnsFile
          ? { kind: 'file', path: options.columnsFile }
          : { kind: 'inline', value: options.columns as string },
      );

  if (columns) {
    const knownFormFields = deps.loadFormFields();
    if (knownFormFields.length > 0) {
      const knownNames = new Set(knownFormFields.map((field) => field.name));
      const unknownNames = columns.columns.flatMap((column) =>
        column.parsedSource.kind === 'formField' &&
        !knownNames.has(column.parsedSource.name)
          ? [column.parsedSource.name]
          : [],
      );
      if (unknownNames.length > 0) {
        exitWithError(
          `Column mapping uses unknown form fields: ${[...new Set(unknownNames)].join(', ')}`,
        );
      }
    }
  }

  const result = await runCustomerBatchExport(
    {
      key: args.key,
      resume: options.resume,
      export: options.export,
      batchSize: options.batchSize ?? 1_000,
      limit: options.limit,
      requestDelayMs: options.requestDelayMs ?? 0,
      outputPrefix: options.outputPrefix,
      columns,
    },
    deps,
  );

  if (result.exported) {
    logger.info(
      `Exported ${result.customerCount - result.missingCustomerIds.length} customers across ${result.completedBatches} batch files in ${result.runDirectory}`,
    );
  } else {
    logger.info(
      `Dry run: ${result.customerCount} customers across ${result.batchCount} batches`,
    );
  }
  if (result.missingCustomerIds.length > 0) {
    logger.warn(
      `${result.missingCustomerIds.length} customers disappeared before their batch was fetched. IDs are recorded in the manifest.`,
    );
  }
  return result;
};

export const registerExportCustomersSubcommand = (parent: Cli.Cli) => {
  parent.command('customers', {
    description:
      'Export filtered customers or every customer to retryable CSV batches',
    args: z.object({
      key: z
        .string()
        .describe(
          'Short identifier for this export (used for progress + output file naming)',
        ),
    }),
    options: z.object({
      field: z
        .string()
        .optional()
        .describe('Form field name to match (from ~/.bcli/form-fields.json)'),
      value: z
        .string()
        .optional()
        .describe('Form field value to match (e.g. "True")'),
      columns: z
        .string()
        .optional()
        .describe(
          'CSV-like column spec: "Name:source,Name:source". With --all, sources include id, email, addresses[N].<field>, addresses[last].<field>, form_field:<name>, and {uuidv4}',
        ),
      columnsFile: z
        .string()
        .optional()
        .describe('Path to a versioned JSON column mapping file'),
      fullColumns: z
        .string()
        .optional()
        .describe(
          'Full-row column spec (defaults to columns prefixed with Customer ID:id)',
        ),
      outputPrefix: z
        .string()
        .optional()
        .describe('Output file prefix (defaults to slugified key)'),
      resume: z
        .boolean()
        .default(false)
        .describe('Resume from last saved progress'),
      export: z.boolean().default(false).describe('Write results to CSV file'),
      incremental: z
        .boolean()
        .default(false)
        .describe('Only fetch customers not in the latest export'),
      all: z
        .boolean()
        .default(false)
        .describe('Export every customer in deterministic batch files'),
      batchSize: z.coerce
        .number()
        .int()
        .positive()
        .max(10_000)
        .default(1_000)
        .describe('Rows per output batch file (default: 1000)'),
      limit: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Export only the oldest N customers by date_created (only with --all)',
        ),
      requestDelayMs: z.coerce
        .number()
        .int()
        .nonnegative()
        .max(60_000)
        .optional()
        .describe(
          'Wait this many milliseconds between BigCommerce export requests',
        ),
    }),
    hint: [
      'Sample: bcli export customers customer-sample --all --limit 100 --columns-file mappings/customer-migration.json --export',
      'Start: bcli export customers customer-migration --all --columns-file mappings/customer-migration.json --batch-size 1000 --request-delay-ms 250 --export',
      'Resume: bcli export customers customer-migration --resume --export',
      'addresses[last] is the final saved address returned by the customer API, not an order billing address.',
    ].join('\n'),
    alias: { resume: 'r', export: 'e', incremental: 'i' },
    async run(c) {
      const bc = createBcClient();
      const batched =
        c.options.all ||
        c.options.columnsFile !== undefined ||
        c.options.limit !== undefined ||
        (c.options.resume && customerExportRunExists('exports', c.args.key));
      const result = batched
        ? await runHandler(() =>
            exportAllCustomersHandler(c.args, c.options, {
              loadFormFields,
              getAllCustomerIds: (limit, requestDelayMs) =>
                bc.getAllCustomerIds(limit, requestDelayMs),
              fetchCustomersByIds: (ids, requestDelayMs) =>
                bc.fetchCustomersByIds(ids, requestDelayMs),
              rootDir: 'exports',
              now: () => new Date().toISOString(),
              randomUUID,
            }),
          )
        : await runHandler(() =>
            exportCustomersHandler(c.args, c.options, {
              loadFormFields,
              cleanProgress: (p) => bc.cleanProgress(p),
              getCustomerIdsByFormField: (f, v, p) =>
                bc.getCustomerIdsByFormField(f, v, p),
              getCustomersByIds: (ids, p, cb) =>
                bc.getCustomersByIds(ids, p, cb),
              existsSync,
              readCsvColumnValues,
              appendCsvRow,
              today: () => new Date().toISOString().split('T')[0] as string,
            }),
          );
      return c.ok(result, {
        cta: {
          commands: batched
            ? [
                {
                  command: `export customers ${c.args.key} --resume --export`,
                  description: 'Resume from the first incomplete batch',
                },
              ]
            : [
                {
                  command: `clean progress ${c.args.key}`,
                  description: 'Remove the progress file for this export',
                },
                {
                  command: `get progress ${c.args.key}`,
                  description: 'Inspect in-flight progress state',
                },
              ],
        },
      });
    },
  });
};
