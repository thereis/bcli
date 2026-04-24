import { describe, expect, test } from 'bun:test';
import {
  customerSchema,
  formFieldValueSchema,
  paginatedResponseSchema,
  progressStateSchema,
  storeInfoSchema,
} from './schemas.ts';

describe('schemas', () => {
  describe('customerSchema', () => {
    test('parses valid customer', () => {
      const result = customerSchema.parse({
        id: 1,
        email: 'test@example.com',
        first_name: 'John',
        last_name: 'Doe',
        phone: '555-1234',
        addresses: [{ country: 'US' }],
        form_fields: [{ name: 'field1', value: 'val1' }],
      });

      expect(result.id).toBe(1);
      expect(result.email).toBe('test@example.com');
      expect(result.addresses[0]?.country).toBe('US');
    });

    test('accepts form fields with string array values', () => {
      const result = customerSchema.parse({
        id: 1,
        email: 'test@example.com',
        first_name: 'John',
        last_name: 'Doe',
        phone: '',
        addresses: [],
        form_fields: [{ name: 'multi', value: ['a', 'b'] }],
      });

      expect(result.form_fields[0]?.value).toEqual(['a', 'b']);
    });

    test('rejects missing required fields', () => {
      expect(() => customerSchema.parse({ id: 1 })).toThrow();
    });
  });

  describe('storeInfoSchema', () => {
    test('parses valid store info', () => {
      const result = storeInfoSchema.parse({
        id: 'test-hash',
        name: 'Test Store',
        domain: 'test.mybigcommerce.com',
        plan_name: 'Standard',
        plan_level: 'standard',
        status: 'live',
      });

      expect(result.name).toBe('Test Store');
    });
  });

  describe('formFieldValueSchema', () => {
    test('parses valid form field value', () => {
      const result = formFieldValueSchema.parse({
        name: 'Phone verified',
        value: 'True',
        customer_id: 42,
      });

      expect(result.customer_id).toBe(42);
    });
  });

  describe('paginatedResponseSchema', () => {
    test('parses response with pagination', () => {
      const schema = paginatedResponseSchema(formFieldValueSchema);
      const result = schema.parse({
        data: [{ name: 'field', value: 'val', customer_id: 1 }],
        meta: {
          pagination: {
            total: 100,
            count: 1,
            per_page: 250,
            current_page: 1,
            total_pages: 1,
          },
        },
      });

      expect(result.data).toHaveLength(1);
      expect(result.meta.pagination?.total).toBe(100);
    });

    test('parses response with cursor pagination', () => {
      const schema = paginatedResponseSchema(formFieldValueSchema);
      const result = schema.parse({
        data: [],
        meta: {
          cursor_pagination: {
            count: 0,
            per_page: 250,
            end_cursor: 'abc',
            links: { next: '?after=abc' },
          },
        },
      });

      expect(result.meta.cursor_pagination?.end_cursor).toBe('abc');
    });

    test('parses response with empty meta', () => {
      const schema = paginatedResponseSchema(formFieldValueSchema);
      const result = schema.parse({ data: [], meta: {} });

      expect(result.data).toHaveLength(0);
    });
  });

  describe('progressStateSchema', () => {
    test('parses full progress state', () => {
      const result = progressStateSchema.parse({
        cursor: 'abc',
        pageNum: 5,
        collectedIds: [1, 2, 3],
        processedIdIndex: 2,
      });

      expect(result.pageNum).toBe(5);
      expect(result.collectedIds).toEqual([1, 2, 3]);
    });

    test('parses without optional cursor', () => {
      const result = progressStateSchema.parse({
        pageNum: 0,
        collectedIds: [],
        processedIdIndex: 0,
      });

      expect(result.cursor).toBeUndefined();
    });
  });
});
