import type { createInterface } from 'node:readline';
import {
  fetchCustomerFormFields,
  getFieldName,
  getFieldOptions,
  getFieldType,
  mapBcType,
} from '../bigcommerce/fetch-form-fields.ts';
import { logger, stdout } from '../shared/logger.ts';
import type { FormField } from './form-fields.ts';

type Readline = ReturnType<typeof createInterface>;

const FIELD_TYPES = ['string', 'boolean', 'number', 'date'] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const ask = (rl: Readline, question: string): Promise<string> =>
  new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });

const parseSelection = (input: string, max: number): number[] => {
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'all' || normalized === '*') {
    return Array.from({ length: max }, (_, i) => i);
  }
  const picks = new Set<number>();
  for (const part of normalized
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]) - 1;
      const hi = Number(rangeMatch[2]) - 1;
      for (let i = Math.max(0, lo); i <= Math.min(max - 1, hi); i++)
        picks.add(i);
    } else {
      const n = Number(part) - 1;
      if (n >= 0 && n < max) picks.add(n);
    }
  }
  return [...picks].sort((a, b) => a - b);
};

const fetchFromStore = async (
  rl: Readline,
  storeHash: string,
  accessToken: string,
  verbose: boolean,
): Promise<FormField[] | null> => {
  stdout('  Fetching customer form fields from BigCommerce...\n');
  const [error, result] = await fetchCustomerFormFields(storeHash, accessToken);
  if (error) {
    logger.error(`✗ ${error.message}`);
    return null;
  }

  const { data: all, raw } = result;

  if (verbose) {
    stdout('  --- Raw API response ---');
    stdout(JSON.stringify(raw, null, 2));
    stdout('  --- End raw response ---\n');
  }

  const custom = all.filter((f) => !f.private_id);
  const builtInCount = all.length - custom.length;

  let listed = custom;
  if (builtInCount > 0) {
    const includeBuiltins = await ask(
      rl,
      `  ${builtInCount} built-in field(s) hidden (EmailAddress, Password, etc.). Include them? (y/N) `,
    );
    if (includeBuiltins.toLowerCase() === 'y') {
      listed = all;
    }
  }

  if (listed.length === 0) {
    logger.info('  No custom form fields found on this store.');
    return [];
  }

  stdout(`  ${listed.length} field(s):`);
  listed.forEach((f, i) => {
    const marker = f.private_id ? ' [built-in]' : '';
    const options = getFieldOptions(f);
    const optHint = options ? ` → [${options.join(', ')}]` : '';
    stdout(
      `    ${i + 1}. ${getFieldName(f)} (${getFieldType(f) || 'unknown'})${marker}${optHint}`,
    );
  });
  stdout('');

  const picks = await ask(
    rl,
    '  Pick fields to register (e.g. "1,3,5" or "1-4" or "all") [all] ',
  );
  const indices = parseSelection(picks, listed.length);

  return indices.map((i) => {
    const rf = listed[i]!;
    const field: FormField = {
      name: getFieldName(rf),
      type: mapBcType(getFieldType(rf)),
    };
    const options = getFieldOptions(rf);
    if (options) field.options = options;
    return field;
  });
};

const collectManual = async (rl: Readline): Promise<FormField[]> => {
  const fields: FormField[] = [];
  while (true) {
    const name = await ask(rl, '  Form field name (blank to finish): ');
    if (!name) break;

    const typeInput = await ask(
      rl,
      `  Type (${FIELD_TYPES.join('/')}) [string]: `,
    );
    const type = (
      FIELD_TYPES.includes(typeInput as FieldType) ? typeInput : 'string'
    ) as FieldType;

    const optionsInput = await ask(
      rl,
      '  Allowed values (comma-separated, blank for none): ',
    );
    const options = optionsInput
      ? optionsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const field: FormField = { name, type };
    if (options && options.length > 0) field.options = options;
    fields.push(field);
    stdout(
      `  ✓ Added "${name}" (${type})${options ? ` [${options.join(', ')}]` : ''}`,
    );
    stdout('');
  }
  return fields;
};

export const collectFormFields = async (
  rl: Readline,
  existing: FormField[],
  storeHash: string,
  accessToken: string,
  verbose: boolean,
): Promise<FormField[]> => {
  stdout('\n  Custom form fields');
  stdout(
    '  These are the custom form_fields your BigCommerce store uses (e.g. for KYC, segmentation).',
  );
  stdout(
    '  The CLI uses this list to validate "bcli export customers --field <name>".',
  );
  stdout('');

  if (existing.length > 0) {
    stdout('  Current registry:');
    for (const f of existing) {
      const opts = f.options ? ` [${f.options.join(', ')}]` : '';
      stdout(`    - ${f.name}${f.type ? ` (${f.type})` : ''}${opts}`);
    }
    stdout('');
  }

  const prompt =
    existing.length > 0
      ? '  (k)eep, (f)etch from BigCommerce, (m)anual, or (s)kip? [k] '
      : '  (f)etch from BigCommerce, (m)anual, or (s)kip? [f] ';
  const action = (await ask(rl, prompt)).toLowerCase();

  const choice = action || (existing.length > 0 ? 'k' : 'f');

  if (choice === 'k' || choice === 's') return existing;

  if (choice === 'f') {
    const fetched = await fetchFromStore(rl, storeHash, accessToken, verbose);
    return fetched ?? existing;
  }

  if (choice === 'm') {
    return collectManual(rl);
  }

  return existing;
};
