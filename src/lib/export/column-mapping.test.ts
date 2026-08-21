import { describe, expect, test } from 'bun:test';
import type { Customer } from '../bigcommerce/schemas.ts';
import {
  buildMappedRow,
  compileColumnMapping,
  loadColumnMappingFile,
  loadColumnPlan,
} from './column-mapping.ts';

const customer: Customer = {
  id: 42,
  email: 'jane@example.com',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+31612345678',
  date_created: '2024-01-15T09:30:00Z',
  date_modified: '2026-08-21T12:00:00Z',
  addresses: [
    { country: 'Netherlands', country_code: 'NL' },
    { country: 'Germany', country_code: 'DE' },
  ],
  form_fields: [
    { name: 'Phone verified', value: 'True' },
    { name: 'Has valid customer data', value: 'True' },
    { name: 'Full due diligence is complete', value: 'False' },
    { name: 'Is trusted customer', value: 'True' },
  ],
};

describe('column mapping', () => {
  test('builds the requested migration schema in exact order', () => {
    const plan = compileColumnMapping(
      loadColumnMappingFile('mappings/customer-migration.json'),
    );

    expect(plan.headers).toEqual([
      'customerId',
      'bigcommerceId',
      'email',
      'firstName',
      'lastName',
      'phone',
      'countryCode',
      'phoneVerified',
      'hasValidCustomerData',
      'fullDueDiligenceComplete',
      'isTrustedCustomer',
      'createdAt',
      'updatedAt',
    ]);
    expect(
      buildMappedRow(customer, plan, {
        'column:0': 'c52b15ea-d7df-4c46-a7f4-c0bb2cdac308',
      }),
    ).toEqual([
      'c52b15ea-d7df-4c46-a7f4-c0bb2cdac308',
      '42',
      'jane@example.com',
      'Jane',
      'Doe',
      '+31612345678',
      'DE',
      'True',
      'True',
      'False',
      'True',
      '2024-01-15T09:30:00Z',
      '2026-08-21T12:00:00Z',
    ]);
  });

  test('last address selects the final saved address returned by the API', () => {
    const plan = loadColumnPlan({
      kind: 'inline',
      value: 'bigcommerceId:id,Country:addresses[last].country_code',
    });
    expect(buildMappedRow(customer, plan)).toEqual(['42', 'DE']);
  });

  test('uuid templates require a generated value binding', () => {
    const plan = loadColumnPlan({
      kind: 'inline',
      value: 'customerId:{uuidv4},bigcommerceId:id',
    });
    expect(() => buildMappedRow(customer, plan)).toThrow(
      /Missing generated value for column:0/,
    );
  });

  test('inline and file-shaped mappings compile through the same plan', () => {
    const plan = loadColumnPlan({
      kind: 'inline',
      value: 'customerId:id,Email:email,Country:addresses[0].country_code',
    });
    expect(plan.headers).toEqual(['customerId', 'Email', 'Country']);
    expect(buildMappedRow(customer, plan)).toEqual([
      '42',
      'jane@example.com',
      'NL',
    ]);
  });

  test('rejects duplicate output headers before rows are built', () => {
    expect(() =>
      compileColumnMapping({
        version: 1,
        columns: [
          { header: 'customerId', source: 'id' },
          { header: ' CustomerID ', source: 'id' },
        ],
      }),
    ).toThrow(/duplicates/);
  });

  test('requires a stable BigCommerce ID source', () => {
    expect(() =>
      compileColumnMapping({
        version: 1,
        columns: [{ header: 'email', source: 'email' }],
      }),
    ).toThrow(/at least one column must use source "id"/);
  });

  test('rejects unknown address fields before export starts', () => {
    expect(() =>
      compileColumnMapping({
        version: 1,
        columns: [
          { header: 'customerId', source: 'id' },
          { header: 'country', source: 'addresses[0].country_typo' },
        ],
      }),
    ).toThrow(/unknown address field/);
  });

  test('missing addresses and form fields become empty cells', () => {
    const plan = loadColumnPlan({
      kind: 'inline',
      value:
        'customerId:id,Country:addresses[2].country_code,Flag:form_field:Missing',
    });
    expect(buildMappedRow(customer, plan)).toEqual(['42', '', '']);
  });
});
