import { describe, expect, test } from 'bun:test';
import type { Customer } from '../bigcommerce/schemas.ts';
import { buildRow, parseColumnSpec, resolveSource } from './column-spec.ts';

const customer: Customer = {
  id: 42,
  email: 'test@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '555-1234',
  addresses: [{ country: 'United States' }, { country: 'Canada' }],
  form_fields: [
    { name: 'Phone verified', value: 'True' },
    { name: 'Tags', value: ['a', 'b'] },
  ],
};

describe('parseColumnSpec', () => {
  test('parses a single column', () => {
    expect(parseColumnSpec('Email:email')).toEqual([
      { name: 'Email', source: 'email' },
    ]);
  });

  test('parses multiple columns', () => {
    expect(parseColumnSpec('ID:id,Email:email')).toEqual([
      { name: 'ID', source: 'id' },
      { name: 'Email', source: 'email' },
    ]);
  });

  test('trims whitespace', () => {
    expect(parseColumnSpec('  Name : email ,  Phone : phone ')).toEqual([
      { name: 'Name', source: 'email' },
      { name: 'Phone', source: 'phone' },
    ]);
  });

  test('supports form_field: source with name containing spaces', () => {
    expect(parseColumnSpec('Verified:form_field:Phone verified')).toEqual([
      { name: 'Verified', source: 'form_field:Phone verified' },
    ]);
  });

  test('throws on missing colon', () => {
    expect(() => parseColumnSpec('Email')).toThrow(/Expected "Name:source"/);
  });

  test('throws on empty name or source', () => {
    expect(() => parseColumnSpec(':email')).toThrow(/both name and source/i);
    expect(() => parseColumnSpec('Email:')).toThrow(/both name and source/i);
  });
});

describe('resolveSource', () => {
  test('resolves top-level sources', () => {
    expect(resolveSource(customer, 'id')).toBe('42');
    expect(resolveSource(customer, 'email')).toBe('test@example.com');
    expect(resolveSource(customer, 'phone')).toBe('555-1234');
    expect(resolveSource(customer, 'first_name')).toBe('Jane');
  });

  test('resolves address fields by index', () => {
    expect(resolveSource(customer, 'addresses[0].country')).toBe(
      'United States',
    );
    expect(resolveSource(customer, 'addresses[1].country')).toBe('Canada');
  });

  test('returns empty string for missing address index', () => {
    expect(resolveSource(customer, 'addresses[9].country')).toBe('');
  });

  test('resolves form_field values by name', () => {
    expect(resolveSource(customer, 'form_field:Phone verified')).toBe('True');
  });

  test('joins array form_field values with commas', () => {
    expect(resolveSource(customer, 'form_field:Tags')).toBe('a, b');
  });

  test('returns empty string for missing form_field', () => {
    expect(resolveSource(customer, 'form_field:Nonexistent')).toBe('');
  });

  test('throws on unknown source', () => {
    expect(() => resolveSource(customer, 'nonexistent_field')).toThrow(
      /Unknown column source/,
    );
  });
});

describe('buildRow', () => {
  test('builds a row from multiple columns', () => {
    const columns = parseColumnSpec(
      'ID:id,Email:email,Country:addresses[0].country',
    );
    expect(buildRow(customer, columns)).toEqual({
      ID: '42',
      Email: 'test@example.com',
      Country: 'United States',
    });
  });
});
