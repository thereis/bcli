import type { Customer } from '../bigcommerce/schemas.ts';

export type ColumnSpec = { name: string; source: string };

export const parseColumnSpec = (spec: string): ColumnSpec[] => {
  const parts = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((part) => {
    const idx = part.indexOf(':');
    if (idx === -1) {
      throw new Error(
        `Invalid column "${part}". Expected "Name:source" (e.g. "Email:email").`,
      );
    }
    const name = part.slice(0, idx).trim();
    const source = part.slice(idx + 1).trim();
    if (!name || !source) {
      throw new Error(
        `Invalid column "${part}". Both name and source are required.`,
      );
    }
    return { name, source };
  });
};

const resolveAddressField = (
  customer: Customer,
  index: number,
  field: string,
): string => {
  const address = customer.addresses?.[index];
  if (!address) return '';
  const value = (address as unknown as Record<string, unknown>)[field];
  return value == null ? '' : String(value);
};

const resolveFormField = (customer: Customer, fieldName: string): string => {
  const match = customer.form_fields?.find((f) => f.name === fieldName);
  if (!match) return '';
  const val = match.value;
  return Array.isArray(val) ? val.join(', ') : String(val ?? '');
};

const TOP_LEVEL_SOURCES = new Set([
  'id',
  'email',
  'phone',
  'first_name',
  'last_name',
  'date_created',
  'date_modified',
  'company',
]);

export const resolveSource = (customer: Customer, source: string): string => {
  if (source.startsWith('form_field:')) {
    return resolveFormField(customer, source.slice('form_field:'.length));
  }

  const addrMatch = source.match(/^addresses\[(\d+)\]\.(.+)$/);
  if (addrMatch) {
    return resolveAddressField(
      customer,
      Number(addrMatch[1]),
      addrMatch[2] as string,
    );
  }

  if (TOP_LEVEL_SOURCES.has(source)) {
    const value = (customer as unknown as Record<string, unknown>)[source];
    return value == null ? '' : String(value);
  }

  throw new Error(
    `Unknown column source "${source}". Supported: ${[...TOP_LEVEL_SOURCES].join(', ')}, addresses[N].<field>, form_field:<name>.`,
  );
};

export const buildRow = (
  customer: Customer,
  columns: ColumnSpec[],
): Record<string, string> => {
  const row: Record<string, string> = {};
  for (const col of columns) {
    row[col.name] = resolveSource(customer, col.source);
  }
  return row;
};
