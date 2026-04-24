import { afterEach, describe, expect, test } from 'bun:test';
import {
  fetchCustomerFormFields,
  getFieldName,
  getFieldOptions,
  getFieldType,
  mapBcType,
} from './fetch-form-fields.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('mapBcType', () => {
  test('strips type_ prefix and _field suffix', () => {
    expect(mapBcType('type_text_field')).toBe('string');
    expect(mapBcType('type_password_field')).toBe('string');
    expect(mapBcType('type_radio_buttons_field')).toBe('string');
    expect(mapBcType('type_checkboxes_field')).toBe('boolean');
    expect(mapBcType('type_date_field')).toBe('date');
    expect(mapBcType('type_numberonly_field')).toBe('number');
  });

  test('handles bare type names', () => {
    expect(mapBcType('text')).toBe('string');
    expect(mapBcType('date')).toBe('date');
    expect(mapBcType('number_only')).toBe('number');
  });

  test('is case-insensitive', () => {
    expect(mapBcType('TYPE_TEXT_FIELD')).toBe('string');
  });

  test('falls back to string for unknown types', () => {
    expect(mapBcType('type_weird_field')).toBe('string');
    expect(mapBcType('')).toBe('string');
  });
});

describe('getFieldName', () => {
  test('prefers name over label', () => {
    expect(getFieldName({ name: 'A', label: 'B' })).toBe('A');
  });

  test('falls back to label', () => {
    expect(getFieldName({ label: 'B' })).toBe('B');
  });

  test('falls back to field_name then title', () => {
    expect(getFieldName({ field_name: 'C' })).toBe('C');
    expect(getFieldName({ title: 'D' })).toBe('D');
  });

  test('returns (unnamed) when nothing matches', () => {
    expect(getFieldName({})).toBe('(unnamed)');
  });
});

describe('getFieldType', () => {
  test('prefers type, then form_field_type, then field_type', () => {
    expect(getFieldType({ type: 'x' })).toBe('x');
    expect(getFieldType({ form_field_type: 'y' })).toBe('y');
    expect(getFieldType({ field_type: 'z' })).toBe('z');
  });

  test('returns empty string when no type fields present', () => {
    expect(getFieldType({})).toBe('');
  });
});

describe('getFieldOptions', () => {
  test('reads options from extra_info.options', () => {
    expect(
      getFieldOptions({ extra_info: { options: ['True', 'False'] } }),
    ).toEqual(['True', 'False']);
  });

  test('falls back to top-level options', () => {
    expect(getFieldOptions({ options: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  test('returns undefined when missing', () => {
    expect(getFieldOptions({})).toBeUndefined();
    expect(getFieldOptions({ extra_info: {} })).toBeUndefined();
  });

  test('returns undefined for empty array', () => {
    expect(getFieldOptions({ extra_info: { options: [] } })).toBeUndefined();
  });

  test('coerces non-string options to strings', () => {
    expect(
      getFieldOptions({ extra_info: { options: [1, true, 'x'] } }),
    ).toEqual(['1', 'true', 'x']);
  });
});

describe('fetchCustomerFormFields', () => {
  test('returns parsed data on 200', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ name: 'X', type: 'text' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const [err, result] = await fetchCustomerFormFields('hash', 'token');
    expect(err).toBeNull();
    expect(result?.data).toEqual([{ name: 'X', type: 'text' }]);
  });

  test('accepts array payload (legacy shape)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([{ name: 'Y' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const [, result] = await fetchCustomerFormFields('h', 't');
    expect(result?.data).toEqual([{ name: 'Y' }]);
  });

  test('returns error on non-OK response', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 403 })) as unknown as typeof fetch;
    const [err, result] = await fetchCustomerFormFields('h', 't');
    expect(result).toBeNull();
    expect(err?.message).toContain('403');
  });

  test('returns error on network failure', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const [err, result] = await fetchCustomerFormFields('h', 't');
    expect(result).toBeNull();
    expect(err?.message).toContain('Could not fetch');
  });

  test('defaults to [] when payload shape unknown', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const [, result] = await fetchCustomerFormFields('h', 't');
    expect(result?.data).toEqual([]);
  });
});
