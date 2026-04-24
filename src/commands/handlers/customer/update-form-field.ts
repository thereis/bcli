import { type Cli, z } from 'incur';
import { createBcClient } from '../../../lib/bigcommerce/bc-client.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { handlePromise } from '../../../lib/shared/handle-promise.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';

export type UpdateFormFieldArgs = {
  customerId: string;
  fieldName: string;
  value: string;
};
export type UpdateFormFieldDeps = {
  updateCustomerFormField: (
    customerId: number,
    fieldName: string,
    value: string,
  ) => Promise<unknown>;
};

export type UpdateFormFieldResult = {
  data: unknown;
  cta: Cta;
};

export const updateFormFieldHandler = async (
  args: UpdateFormFieldArgs,
  deps: UpdateFormFieldDeps,
): Promise<UpdateFormFieldResult> => {
  const customerId = Number(args.customerId);
  if (!Number.isFinite(customerId) || customerId <= 0) {
    exitWithError(`Invalid customer ID: ${args.customerId}`);
  }

  const [error, result] = await handlePromise(
    deps.updateCustomerFormField(customerId, args.fieldName, args.value),
  );
  if (error) {
    exitWithError(`Error: ${error.message}`);
  }

  logger.info(
    `Updated "${args.fieldName}" for customer ${customerId} to "${args.value}"`,
  );

  return { data: result, cta: { commands: [] } };
};

export const registerUpdateFormFieldSubcommand = (parent: Cli.Cli) => {
  parent.command('form-field', {
    description: 'Update a single form field value for a customer',
    args: z.object({
      customerId: z.string().describe('Customer ID'),
      fieldName: z.string().describe('Form field name'),
      value: z.string().describe('New value for the form field'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        updateFormFieldHandler(c.args, {
          updateCustomerFormField: (id, name, value) =>
            createBcClient().updateCustomerFormField(id, name, value),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
