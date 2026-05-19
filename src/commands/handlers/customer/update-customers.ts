import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Customer } from '../../../lib/bigcommerce/schemas.ts';
import { readCsvRows } from '../../../lib/export/csv.ts';
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
};

export type UpdateCustomersDeps = {
  readCsvRows: (path: string) => Promise<Record<string, string>[]>;
  lookupCustomersByEmails: (emails: string[]) => Promise<Customer[]>;
  updateCustomersFormField: (
    updates: { customerId: number; fieldName: string; value: string }[],
  ) => Promise<unknown>;
};

const BATCH_SIZE = 10;

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

  const rows = await deps.readCsvRows(args.csvPath);
  if (rows.length === 0) {
    logger.info('CSV file is empty or not found.');
    return { total: 0, updated: 0, skipped: 0, invalid: 0, failed: 0 };
  }

  let total = 0;
  let updated = 0;
  let skipped = 0;
  let invalid = 0;
  let failed = 0;

  type WorkItem = {
    rowNumber: number;
    email: string;
    value: string;
  };

  const workItems: WorkItem[] = [];

  for (const row of rows) {
    total++;
    const email = row[options.emailColumn]?.trim();

    if (!email) {
      invalid++;
      logger.warn(
        `Row ${total}: Missing email in column "${options.emailColumn}"`,
      );
      continue;
    }

    const value = options.valueColumn
      ? row[options.valueColumn]?.trim()
      : options.value;

    if (!value) {
      invalid++;
      logger.warn(
        `Row ${total}: Missing value${options.valueColumn ? ` in column "${options.valueColumn}"` : ''}`,
      );
      continue;
    }

    workItems.push({ rowNumber: total, email, value });
  }

  for (let i = 0; i < workItems.length; i += BATCH_SIZE) {
    const batch = workItems.slice(i, i + BATCH_SIZE);
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
    }[] = [];

    for (const item of batch) {
      const customer = customersByEmail.get(item.email.toLowerCase());

      if (!customer) {
        skipped++;
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
          logger.error(
            `Row ${update.rowNumber}: Failed to update "${update.email}" (ID: ${update.customerId}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  const summary = { total, updated, skipped, invalid, failed };
  logger.info('\nUpdate Summary:');
  logger.info(`  Total rows:          ${total}`);
  logger.info(
    `  ${options.dryRun ? 'Would update' : 'Updated'}:          ${updated}`,
  );
  logger.info(`  Skipped (not found): ${skipped}`);
  logger.info(`  Invalid (no email):  ${invalid}`);
  if (failed > 0) {
    logger.info(`  Failed:              ${failed}`);
  }

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
    }),
    alias: { dryRun: 'd' },
    async run(c) {
      const bc = createBcClient();
      const result = await runHandler(() =>
        updateCustomersHandler(c.args, c.options, {
          readCsvRows,
          lookupCustomersByEmails: (emails) =>
            bc.lookupCustomersByEmails(emails),
          updateCustomersFormField: (updates) =>
            bc.updateCustomersFormField(updates),
        }),
      );
      return c.ok(result);
    },
  });
};
