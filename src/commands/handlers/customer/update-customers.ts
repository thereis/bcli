import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Customer } from '../../../lib/bigcommerce/schemas.ts';
import { appendCsvRow, readCsvRows } from '../../../lib/export/csv.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';

export type UpdateCustomersArgs = {
  csvPath: string;
};

export type UpdateCustomersOptions = {
  emailColumn: string;
  field: string;
  value?: string;
  valueColumn?: string;
  dryRun: boolean;
  resume: boolean;
};

export type UpdateCustomersDeps = {
  readCsvRows: (path: string) => Promise<Record<string, string>[]>;
  lookupCustomersByEmails: (emails: string[]) => Promise<Customer[]>;
  updateCustomersFormField: (
    updates: { customerId: number; fieldName: string; value: string }[],
  ) => Promise<unknown>;
  loadProgress?: (path: string) => UpdateCustomersProgressState | null;
  saveProgress?: (path: string, state: UpdateCustomersProgressState) => void;
  cleanProgress?: (path: string) => void;
  appendCsvRow?: (file: string, row: Record<string, string>) => void;
  cleanErrorCsv?: (path: string) => void;
};

const BATCH_SIZE = 10;

export type UpdateCustomersProgressState = {
  processedRows: number;
};

type UpdateCustomersSummary = {
  total: number;
  updated: number;
  skipped: number;
  invalid: number;
  failed: number;
};

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

export const updateCustomersProgressFilePath = (
  args: UpdateCustomersArgs,
  options: UpdateCustomersOptions,
) => {
  const key = [
    args.csvPath,
    options.emailColumn,
    options.field,
    options.value ?? '',
    options.valueColumn ?? '',
    String(options.dryRun),
  ].join('\0');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
  const label = slugify(basename(args.csvPath)) || 'customers';
  return `.update-customers-${label}-${digest}.json`;
};

const loadUpdateCustomersProgress = (
  path: string,
): UpdateCustomersProgressState | null => {
  if (!existsSync(path)) return null;
  return JSON.parse(
    readFileSync(path, 'utf-8'),
  ) as UpdateCustomersProgressState;
};

const saveUpdateCustomersProgress = (
  path: string,
  state: UpdateCustomersProgressState,
) => {
  writeFileSync(path, JSON.stringify(state));
};

const cleanUpdateCustomersProgress = (path: string) => {
  if (existsSync(path)) unlinkSync(path);
};

export const updateCustomersErrorCsvPath = (args: UpdateCustomersArgs) => {
  const ext = extname(args.csvPath);
  const fileName = basename(args.csvPath, ext) || 'customers';
  const outputName = `${fileName}-errors.csv`;
  const dir = dirname(args.csvPath);
  return dir === '.' ? outputName : join(dir, outputName);
};

const cleanUpdateCustomersErrorCsv = (path: string) => {
  if (existsSync(path)) unlinkSync(path);
};

const getUniqueColumnName = (
  rows: Record<string, string>[],
  preferredName: string,
) => {
  const existingColumns = new Set(rows.flatMap((row) => Object.keys(row)));
  let columnName = preferredName;
  let suffix = 2;
  while (existingColumns.has(columnName)) {
    columnName = `${preferredName} ${suffix}`;
    suffix++;
  }
  return columnName;
};

const logSummary = (
  summary: UpdateCustomersSummary,
  options: Pick<UpdateCustomersOptions, 'dryRun'>,
) => {
  logger.info('\nUpdate Summary:');
  logger.info(`  Total rows:          ${summary.total}`);
  logger.info(
    `  ${options.dryRun ? 'Would update' : 'Updated'}:          ${summary.updated}`,
  );
  logger.info(`  Skipped (not found): ${summary.skipped}`);
  logger.info(`  Invalid (no email):  ${summary.invalid}`);
  if (summary.failed > 0) {
    logger.info(`  Failed:              ${summary.failed}`);
  }
};

export const updateCustomersHandler = async (
  args: UpdateCustomersArgs,
  options: UpdateCustomersOptions,
  deps: UpdateCustomersDeps,
) => {
  if (!options.value && !options.valueColumn) {
    exitWithError('Provide either --value or --value-column.');
  }
  if (options.value && options.valueColumn) {
    exitWithError('Provide only one of --value or --value-column.');
  }

  const progressFile = updateCustomersProgressFilePath(args, options);
  const loadProgress = deps.loadProgress ?? (() => null);
  const saveProgress = deps.saveProgress ?? (() => {});
  const cleanProgress = deps.cleanProgress ?? (() => {});
  const writeErrorRow = deps.appendCsvRow ?? (() => {});
  const cleanErrorCsv = deps.cleanErrorCsv ?? (() => {});
  const errorCsvPath = updateCustomersErrorCsvPath(args);

  if (!options.resume) {
    cleanProgress(progressFile);
    cleanErrorCsv(errorCsvPath);
  }

  const previousProgress = options.resume ? loadProgress(progressFile) : null;
  const startAfterRow = previousProgress?.processedRows ?? 0;
  let processedRowCheckpoint = startAfterRow;
  if (startAfterRow > 0) {
    logger.info(
      `Resuming update from row ${startAfterRow + 1} (${startAfterRow} rows already processed)`,
    );
  }

  const saveCheckpoint = (processedRows: number) => {
    processedRowCheckpoint = processedRows;
    saveProgress(progressFile, { processedRows });
  };

  const rows = await deps.readCsvRows(args.csvPath);
  if (rows.length === 0) {
    logger.info('CSV file is empty or not found.');
    cleanProgress(progressFile);
    return { total: 0, updated: 0, skipped: 0, invalid: 0, failed: 0 };
  }

  const total = rows.length;
  const statusColumn = getUniqueColumnName(rows, 'Status');
  let updated = 0;
  let skipped = 0;
  let invalid = 0;
  let failed = 0;

  const appendErrorRow = (
    row: Record<string, string>,
    status: 'skipped' | 'invalid' | 'failed',
  ) => {
    writeErrorRow(errorCsvPath, { ...row, [statusColumn]: status });
  };

  const logErrorCsv = () => {
    if (skipped + invalid + failed > 0) {
      logger.info(`  Error CSV:           ${errorCsvPath}`);
    }
  };

  type WorkItem = {
    rowNumber: number;
    email: string;
    value: string;
    row: Record<string, string>;
  };

  const workItems: WorkItem[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    if (rowNumber <= startAfterRow) continue;

    const email = row[options.emailColumn]?.trim();

    if (!email) {
      invalid++;
      appendErrorRow(row, 'invalid');
      logger.warn(
        `Row ${rowNumber}: Missing email in column "${options.emailColumn}"`,
      );
      saveCheckpoint(rowNumber);
      continue;
    }

    const value = options.valueColumn
      ? row[options.valueColumn]?.trim()
      : options.value;

    if (!value) {
      invalid++;
      appendErrorRow(row, 'invalid');
      logger.warn(
        `Row ${rowNumber}: Missing value${options.valueColumn ? ` in column "${options.valueColumn}"` : ''}`,
      );
      saveCheckpoint(rowNumber);
      continue;
    }

    workItems.push({ rowNumber, email, value, row });
  }

  for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
    const batch = workItems.slice(i, i + BATCH_SIZE);
    const lastBatchRow = batch.at(-1)?.rowNumber ?? startAfterRow;
    const emails = batch.map((item) => item.email);
    const customers = await deps.lookupCustomersByEmails(emails);
    const customersByEmail = new Map(
      customers.map((c) => [c.email.toLowerCase(), c]),
    );

    const updates: {
      customerId: number;
      fieldName: string;
      value: string;
      email: string;
      rowNumber: number;
      row: Record<string, string>;
    }[] = [];

    for (const item of batch) {
      const customer = customersByEmail.get(item.email.toLowerCase());

      if (!customer) {
        skipped++;
        appendErrorRow(item.row, 'skipped');
        logger.info(
          `Row ${item.rowNumber}: Customer not found for email "${item.email}". Skipping.`,
        );
        continue;
      }

      if (options.dryRun) {
        updated++;
        logger.info(
          `[Dry Run] Row ${item.rowNumber}: Would update "${item.email}" (ID: ${customer.id})`,
        );
        continue;
      }

      updates.push({
        customerId: customer.id,
        fieldName: options.field,
        value: item.value,
        email: item.email,
        rowNumber: item.rowNumber,
        row: item.row,
      });
    }

    if (updates.length > 0) {
      try {
        await deps.updateCustomersFormField(
          updates.map(({ customerId, fieldName, value }) => ({
            customerId,
            fieldName,
            value,
          })),
        );
        updated += updates.length;
        for (const update of updates) {
          logger.info(
            `Row ${update.rowNumber}: Updated "${update.email}" (ID: ${update.customerId})`,
          );
        }
      } catch (error) {
        failed += updates.length;
        for (const update of updates) {
          appendErrorRow(update.row, 'failed');
          logger.error(
            `Row ${update.rowNumber}: Failed to update "${update.email}" (ID: ${update.customerId}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        logSummary({ total, updated, skipped, invalid, failed }, options);
        logErrorCsv();
        exitWithError(
          `Failed to update batch ending at row ${lastBatchRow}. Re-run with --resume to retry from row ${processedRowCheckpoint + 1}.`,
        );
      }
    }

    saveCheckpoint(lastBatchRow);
  }

  const summary = { total, updated, skipped, invalid, failed };
  logSummary(summary, options);
  logErrorCsv();
  cleanProgress(progressFile);
  return summary;
};

export const registerUpdateCustomersSubcommand = (parent: Cli.Cli) => {
  parent.command('customers', {
    description:
      'Batch update customer form fields from CSV (existing customers only)',
    args: z.object({
      csvPath: z.string().describe('Path to the CSV file'),
    }),
    options: z.object({
      emailColumn: z
        .string()
        .default('Email')
        .describe('Name of the column containing customer emails'),
      field: z.string().describe('Name of the form field to update'),
      value: z
        .string()
        .optional()
        .describe('Value to set for every matching customer'),
      valueColumn: z
        .string()
        .optional()
        .describe('CSV column containing the value to set per row'),
      dryRun: z
        .boolean()
        .default(false)
        .describe('Show what would happen without making changes'),
      resume: z
        .boolean()
        .default(false)
        .describe('Resume from the last saved row checkpoint'),
    }),
    alias: { dryRun: 'd', resume: 'r' },
    async run(c) {
      const bc = createBcClient();
      const result = await runHandler(() =>
        updateCustomersHandler(c.args, c.options, {
          readCsvRows,
          lookupCustomersByEmails: (emails) =>
            bc.lookupCustomersByEmails(emails),
          updateCustomersFormField: (updates) =>
            bc.updateCustomersFormField(updates),
          loadProgress: loadUpdateCustomersProgress,
          saveProgress: saveUpdateCustomersProgress,
          cleanProgress: cleanUpdateCustomersProgress,
          appendCsvRow,
          cleanErrorCsv: cleanUpdateCustomersErrorCsv,
        }),
      );
      return c.ok(result);
    },
  });
};
