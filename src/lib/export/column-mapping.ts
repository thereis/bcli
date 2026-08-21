import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Customer } from '../bigcommerce/schemas.ts';

const mappingColumnSchema = z
  .object({
    header: z.string().trim().min(1),
    source: z.string().trim().min(1),
  })
  .strict();

const columnMappingFileSchema = z
  .object({
    version: z.literal(1),
    columns: z.array(mappingColumnSchema).min(1),
  })
  .strict();

const CUSTOMER_FIELDS = [
  'id',
  'email',
  'phone',
  'first_name',
  'last_name',
  'date_created',
  'date_modified',
  'company',
] as const;

const ADDRESS_FIELDS = [
  'id',
  'customer_id',
  'first_name',
  'last_name',
  'email',
  'company',
  'address1',
  'address2',
  'city',
  'state_or_province',
  'state_or_province_code',
  'country',
  'country_code',
  'postal_code',
  'phone',
  'address_type',
] as const;

type CustomerField = (typeof CUSTOMER_FIELDS)[number];
type AddressField = (typeof ADDRESS_FIELDS)[number];
type AddressSelector = number | 'last';

export type GeneratedSlot = `column:${number}`;
export type RowBindings = Readonly<Record<GeneratedSlot, string>>;

export type MappingColumn = z.infer<typeof mappingColumnSchema>;
export type ColumnMappingFile = z.infer<typeof columnMappingFileSchema>;

export type ColumnSource =
  | { kind: 'customer'; field: CustomerField }
  | { kind: 'address'; selector: AddressSelector; field: AddressField }
  | { kind: 'formField'; name: string }
  | { kind: 'generated'; generator: 'uuidv4'; slot: GeneratedSlot };

export type CompiledColumn = MappingColumn & { parsedSource: ColumnSource };

export type ColumnPlan = {
  columns: CompiledColumn[];
  generatedColumns: Array<{
    generator: 'uuidv4';
    slot: GeneratedSlot;
  }>;
  headers: string[];
  fingerprint: string;
  mapping: ColumnMappingFile;
};

export type ColumnMappingInput =
  | { kind: 'inline'; value: string }
  | { kind: 'file'; path: string };

const normalizeHeader = (header: string) =>
  header.trim().normalize('NFKC').toLocaleLowerCase('en-US');

const parseSource = (source: string, columnIndex: number): ColumnSource => {
  if (source === '{uuidv4}') {
    return {
      kind: 'generated',
      generator: 'uuidv4',
      slot: `column:${columnIndex}`,
    };
  }

  if (source.startsWith('form_field:')) {
    const name = source.slice('form_field:'.length).trim();
    if (!name) {
      throw new Error('form_field sources require a field name');
    }
    return { kind: 'formField', name };
  }

  const addressMatch = source.match(/^addresses\[(last|\d+)\]\.([a-z_]+)$/);
  if (addressMatch) {
    const field = addressMatch[2] as AddressField;
    if (!ADDRESS_FIELDS.includes(field)) {
      throw new Error(
        `unknown address field "${field}". Supported: ${ADDRESS_FIELDS.join(', ')}`,
      );
    }
    return {
      kind: 'address',
      selector: addressMatch[1] === 'last' ? 'last' : Number(addressMatch[1]),
      field,
    };
  }

  if ((CUSTOMER_FIELDS as readonly string[]).includes(source)) {
    return { kind: 'customer', field: source as CustomerField };
  }

  throw new Error(
    `unknown source "${source}". Supported: ${CUSTOMER_FIELDS.join(', ')}, addresses[N].<field>, addresses[last].<field>, form_field:<name>, {uuidv4}`,
  );
};

export const parseInlineColumns = (spec: string): MappingColumn[] => {
  const parts = spec.split(',').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new Error('Column mappings cannot contain empty entries.');
  }

  return parts.map((part) => {
    const separator = part.indexOf(':');
    if (separator === -1) {
      throw new Error(`Invalid column "${part}". Expected "Header:source".`);
    }
    return {
      header: part.slice(0, separator).trim(),
      source: part.slice(separator + 1).trim(),
    };
  });
};

export const loadColumnMappingFile = (path: string): ColumnMappingFile => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read column mapping "${path}": ${message}`);
  }

  const result = columnMappingFileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid column mapping "${path}": ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
};

export const compileColumnMapping = (
  mapping: ColumnMappingFile,
): ColumnPlan => {
  const result = columnMappingFileSchema.safeParse(mapping);
  if (!result.success) {
    throw new Error(`Invalid column mapping: ${z.prettifyError(result.error)}`);
  }

  const problems: string[] = [];
  const headers = new Map<string, number>();
  const columns = result.data.columns.map((column, index): CompiledColumn => {
    const headerKey = normalizeHeader(column.header);
    const previous = headers.get(headerKey);
    if (previous !== undefined) {
      problems.push(
        `columns[${index}].header duplicates columns[${previous}].header`,
      );
    } else {
      headers.set(headerKey, index);
    }
    if (/\r|\n/.test(column.header)) {
      problems.push(`columns[${index}].header cannot contain a newline`);
    }

    let parsedSource: ColumnSource = { kind: 'customer', field: 'id' };
    try {
      parsedSource = parseSource(column.source, index);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`columns[${index}].source: ${message}`);
    }
    return { ...column, parsedSource };
  });

  if (
    !columns.some(
      (column) =>
        column.parsedSource.kind === 'customer' &&
        column.parsedSource.field === 'id',
    )
  ) {
    problems.push(
      'at least one column must use source "id" so retries can be deduplicated',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid column mapping:\n- ${problems.join('\n- ')}`);
  }

  const canonical = columns.map(({ header, source }) => ({ header, source }));
  return {
    columns,
    generatedColumns: columns.flatMap((column) =>
      column.parsedSource.kind === 'generated'
        ? [
            {
              generator: column.parsedSource.generator,
              slot: column.parsedSource.slot,
            },
          ]
        : [],
    ),
    headers: columns.map((column) => column.header),
    fingerprint: createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex'),
    mapping: { version: 1, columns: canonical },
  };
};

export const loadColumnPlan = (input: ColumnMappingInput): ColumnPlan => {
  const mapping =
    input.kind === 'file'
      ? loadColumnMappingFile(input.path)
      : { version: 1 as const, columns: parseInlineColumns(input.value) };
  return compileColumnMapping(mapping);
};

const stringifyCell = (value: unknown): string => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
};

const resolveColumn = (
  customer: Customer,
  source: ColumnSource,
  bindings: RowBindings,
): string => {
  if (source.kind === 'customer') {
    return stringifyCell(
      (customer as unknown as Record<string, unknown>)[source.field],
    );
  }
  if (source.kind === 'address') {
    const address = (
      source.selector === 'last'
        ? customer.addresses.at(-1)
        : customer.addresses[source.selector]
    ) as Record<string, unknown> | undefined;
    return stringifyCell(address?.[source.field]);
  }
  if (source.kind === 'generated') {
    const value = bindings[source.slot];
    if (!value) {
      throw new Error(`Missing generated value for ${source.slot}.`);
    }
    return value;
  }
  const field = customer.form_fields.find(
    (candidate) => candidate.name === source.name,
  );
  return stringifyCell(field?.value);
};

export const buildMappedRow = (
  customer: Customer,
  plan: ColumnPlan,
  bindings: RowBindings = {},
): string[] =>
  plan.columns.map((column) =>
    resolveColumn(customer, column.parsedSource, bindings),
  );
