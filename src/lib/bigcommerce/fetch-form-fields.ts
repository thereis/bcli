import { handlePromise } from '../shared/handle-promise.ts';

export type RemoteFormField = Record<string, unknown>;

const BC_TYPE_TO_LOCAL: Record<
  string,
  'string' | 'number' | 'date' | 'boolean'
> = {
  text: 'string',
  multiline: 'string',
  password: 'string',
  radiobuttons: 'string',
  radio_buttons: 'string',
  multipleselect: 'string',
  multiple_select: 'string',
  dropdown: 'string',
  numberonly: 'number',
  number_only: 'number',
  number: 'number',
  date: 'date',
  checkboxes: 'boolean',
};

const normalizeType = (raw: string) =>
  raw
    .toLowerCase()
    .replace(/^type_/, '')
    .replace(/_field$/, '');

export const mapBcType = (
  raw: string,
): 'string' | 'boolean' | 'number' | 'date' =>
  BC_TYPE_TO_LOCAL[normalizeType(raw)] ?? 'string';

export const getFieldName = (field: RemoteFormField): string =>
  (field.name as string) ||
  (field.label as string) ||
  (field.field_name as string) ||
  (field.title as string) ||
  '(unnamed)';

export const getFieldType = (field: RemoteFormField): string =>
  (field.type as string) ||
  (field.form_field_type as string) ||
  (field.field_type as string) ||
  '';

export const getFieldOptions = (
  field: RemoteFormField,
): string[] | undefined => {
  const extraInfo = field.extra_info as { options?: unknown[] } | undefined;
  const opts = extraInfo?.options ?? (field.options as unknown[] | undefined);
  if (!Array.isArray(opts) || opts.length === 0) return undefined;
  return opts.map(String);
};

export const fetchCustomerFormFields = async (
  storeHash: string,
  accessToken: string,
): Promise<
  [Error, null] | [null, { data: RemoteFormField[]; raw: unknown }]
> => {
  const url = `https://api.bigcommerce.com/stores/${storeHash}/v3/customers/form-fields`;
  const headers = {
    'X-Auth-Token': accessToken,
    Accept: 'application/json',
  };

  const [fetchError, res] = await handlePromise(fetch(url, { headers }));
  if (fetchError) {
    return [
      new Error('Could not fetch form fields. Check your network.'),
      null,
    ];
  }

  if (!res.ok) {
    const body = await res.text();
    return [new Error(`API error ${res.status}: ${body}`), null];
  }

  const raw = (await res.json()) as unknown;
  const data = Array.isArray(raw)
    ? (raw as RemoteFormField[])
    : ((raw as { data?: RemoteFormField[] }).data ?? []);
  return [null, { data, raw }];
};
