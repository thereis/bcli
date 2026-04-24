import { type Cli, z } from 'incur';
import {
  fetchCustomerFormFields,
  getFieldName,
  getFieldOptions,
  getFieldType,
  mapBcType,
  type RemoteFormField,
} from '../../../lib/bigcommerce/fetch-form-fields.ts';
import { env } from '../../../lib/config/env.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { exitWithError, runHandler } from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';

export type GetFormFieldsOptions = {
  all: boolean;
  raw: boolean;
};

export type GetFormFieldsDeps = {
  fetchFields: () => Promise<
    [Error, null] | [null, { data: RemoteFormField[]; raw: unknown }]
  >;
};

export type FormFieldSummary = {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'date';
  bcType: string;
  options: string[] | undefined;
  builtIn: boolean;
  required: boolean;
};

export type GetFormFieldsData =
  | { formFields: FormFieldSummary[] }
  | { raw: unknown };

export type GetFormFieldsResult = {
  data: GetFormFieldsData;
  cta: Cta;
};

const cta: Cta = {
  commands: [
    {
      command: 'update form-fields',
      description: 'Run the interactive wizard to edit local form-field config',
    },
  ],
};

export const getFormFieldsHandler = async (
  options: GetFormFieldsOptions,
  deps: GetFormFieldsDeps,
): Promise<GetFormFieldsResult> => {
  const [error, fetched] = await deps.fetchFields();
  if (error) {
    exitWithError(`✗ ${error.message}`);
  }
  const result = fetched as { data: RemoteFormField[]; raw: unknown };

  if (options.raw) {
    return { data: { raw: result.raw }, cta };
  }

  const visible = options.all
    ? result.data
    : result.data.filter((f) => !f.private_id);

  if (visible.length === 0) {
    logger.info(
      options.all
        ? 'No form fields found on this store.'
        : 'No custom form fields found. Use --all to include built-ins.',
    );
    return { data: { formFields: [] }, cta };
  }

  return {
    data: {
      formFields: visible.map((f) => ({
        name: getFieldName(f),
        type: mapBcType(getFieldType(f) || ''),
        bcType: getFieldType(f) || '',
        options: getFieldOptions(f),
        builtIn: Boolean(f.private_id),
        required: Boolean(f.required),
      })),
    },
    cta,
  };
};

export const registerGetFormFieldsSubcommand = (parent: Cli.Cli) => {
  parent.command('form-fields', {
    description: 'List customer form fields defined on the store',
    options: z.object({
      all: z
        .boolean()
        .default(false)
        .describe('Include BigCommerce built-in fields (EmailAddress, etc.)'),
      raw: z.boolean().default(false).describe('Print the raw API response'),
    }),
    async run(c) {
      const result = await runHandler(() =>
        getFormFieldsHandler(c.options, {
          fetchFields: () =>
            fetchCustomerFormFields(env.BC_STORE_HASH, env.BC_ACCESS_TOKEN),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
