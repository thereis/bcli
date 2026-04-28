import { existsSync } from 'node:fs';
import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Customer } from '../../../lib/bigcommerce/schemas.ts';
import {
  type FormField,
  isKnownFormField,
  loadFormFields,
} from '../../../lib/config/form-fields.ts';
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
  field: string;
  value: string;
  columns: string;
  fullColumns?: string;
  outputPrefix?: string;
  resume: boolean;
  export: boolean;
  incremental: boolean;
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
  const known = deps.loadFormFields();
  validateField(options.field, options.value, known);

  const columns = parseColumnSpec(options.columns);
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
    options.field,
    options.value,
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

export const registerExportCustomersSubcommand = (parent: Cli.Cli) => {
  parent.command('customers', {
    description:
      'Fetch customers matching a form-field value, optionally write to CSV',
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
        .describe('Form field name to match (from ~/.bcli/form-fields.json)'),
      value: z.string().describe('Form field value to match (e.g. "True")'),
      columns: z
        .string()
        .describe(
          'CSV-like column spec: "Name:source,Name:source". Sources: id, email, phone, first_name, last_name, addresses[N].<field>, form_field:<name>',
        ),
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
    }),
    alias: { resume: 'r', export: 'e', incremental: 'i' },
    async run(c) {
      const bc = createBcClient();
      const result = await runHandler(() =>
        exportCustomersHandler(c.args, c.options, {
          loadFormFields,
          cleanProgress: (p) => bc.cleanProgress(p),
          getCustomerIdsByFormField: (f, v, p) =>
            bc.getCustomerIdsByFormField(f, v, p),
          getCustomersByIds: (ids, p, cb) => bc.getCustomersByIds(ids, p, cb),
          existsSync,
          readCsvColumnValues,
          appendCsvRow,
          today: () => new Date().toISOString().split('T')[0] as string,
        }),
      );
      return c.ok(result, {
        cta: {
          commands: [
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
