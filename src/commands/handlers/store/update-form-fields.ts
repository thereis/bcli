import { createInterface } from 'node:readline';
import { type Cli, z } from 'incur';
import { env } from '../../../lib/config/env.ts';
import {
  type FormField,
  loadFormFields,
  saveFormFields,
} from '../../../lib/config/form-fields.ts';
import { collectFormFields } from '../../../lib/config/form-fields-wizard.ts';
import type { Cta } from '../../../lib/shared/cta.ts';
import { runHandler } from '../../../lib/shared/handler-exit.ts';
import { logger } from '../../../lib/shared/logger.ts';

export type UpdateFormFieldsOptions = { verbose: boolean };

export type UpdateFormFieldsDeps = {
  load: () => FormField[];
  collect: (existing: FormField[]) => Promise<FormField[]>;
  save: (fields: FormField[]) => void;
};

export type UpdateFormFieldsData = { formFields: FormField[] };
export type UpdateFormFieldsResult = {
  data: UpdateFormFieldsData;
  cta: Cta;
};

export const collectViaReadline = async (
  existing: FormField[],
  verbose: boolean,
): Promise<FormField[]> => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const fields = await collectFormFields(
    rl,
    existing,
    env.BC_STORE_HASH,
    env.BC_ACCESS_TOKEN,
    verbose,
  );
  rl.close();
  return fields;
};

const cta: Cta = {
  commands: [
    {
      command: 'get form-fields',
      description: 'View customer form fields defined on the store',
    },
  ],
};

export const updateFormFieldsHandler = async (
  deps: UpdateFormFieldsDeps,
): Promise<UpdateFormFieldsResult> => {
  const existing = deps.load();
  const fields = await deps.collect(existing);

  if (fields === existing) {
    logger.info('No changes made.');
    return { data: { formFields: existing }, cta };
  }

  deps.save(fields);
  logger.info(`Saved ${fields.length} form field(s) to .bc/form-fields.json.`);
  return { data: { formFields: fields }, cta };
};

export type RegisterUpdateFormFieldsDeps = {
  collect?: (existing: FormField[], verbose: boolean) => Promise<FormField[]>;
};

export const registerUpdateFormFieldsSubcommand = (
  parent: Cli.Cli,
  deps: RegisterUpdateFormFieldsDeps = {},
) => {
  const collect = deps.collect ?? collectViaReadline;
  parent.command('form-fields', {
    description:
      'Update the local form-fields registry (.bc/form-fields.json) — fetch from BigCommerce or edit manually',
    options: z.object({
      verbose: z
        .boolean()
        .default(false)
        .describe('Print raw API responses during form-field fetch'),
    }),
    alias: { verbose: 'v' },
    async run(c) {
      const result = await runHandler(() =>
        updateFormFieldsHandler({
          load: loadFormFields,
          save: saveFormFields,
          collect: (existing) => collect(existing, c.options.verbose),
        }),
      );
      return c.ok(result.data, { cta: result.cta });
    },
  });
};
