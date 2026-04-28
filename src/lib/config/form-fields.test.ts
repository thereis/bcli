import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FormField,
  formFieldSchema,
  formFieldsFileSchema,
  getFormFieldsPath,
  isKnownFormField,
  loadFormFields,
  saveFormFields,
} from './form-fields.ts';

describe('formFieldSchema', () => {
  test('accepts name-only entry', () => {
    expect(formFieldSchema.parse({ name: 'Phone verified' })).toEqual({
      name: 'Phone verified',
    });
  });

  test('accepts full entry with options', () => {
    expect(
      formFieldSchema.parse({
        name: 'FDD',
        type: 'boolean',
        options: ['True', 'False'],
      }),
    ).toEqual({ name: 'FDD', type: 'boolean', options: ['True', 'False'] });
  });

  test('rejects empty name', () => {
    expect(() => formFieldSchema.parse({ name: '' })).toThrow();
  });

  test('rejects unknown type', () => {
    expect(() => formFieldSchema.parse({ name: 'x', type: 'bogus' })).toThrow();
  });
});

describe('formFieldsFileSchema', () => {
  test('defaults formFields to []', () => {
    expect(formFieldsFileSchema.parse({})).toEqual({ formFields: [] });
  });

  test('accepts a populated registry', () => {
    const data = {
      formFields: [
        { name: 'A', type: 'string' as const },
        { name: 'B', type: 'boolean' as const, options: ['True', 'False'] },
      ],
    };
    expect(formFieldsFileSchema.parse(data)).toEqual(data);
  });
});

describe('isKnownFormField', () => {
  const fields: FormField[] = [
    { name: 'FDD', type: 'boolean' },
    { name: 'Phone verified', type: 'string' },
  ];

  test('returns true for registered names', () => {
    expect(isKnownFormField('FDD', fields)).toBe(true);
    expect(isKnownFormField('Phone verified', fields)).toBe(true);
  });

  test('returns false for unknown names', () => {
    expect(isKnownFormField('Nonexistent', fields)).toBe(false);
  });

  test('is case-sensitive', () => {
    expect(isKnownFormField('fdd', fields)).toBe(false);
  });
});

describe('load/save form fields', () => {
  const originalCwd = process.cwd();
  const originalConfigDir = process.env.BCLI_CONFIG_DIR;
  let workDir = '';
  let configDir = '';

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ff-'));
    configDir = mkdtempSync(join(tmpdir(), 'ff-config-'));
    process.env.BCLI_CONFIG_DIR = configDir;
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalConfigDir === undefined) {
      delete process.env.BCLI_CONFIG_DIR;
    } else {
      process.env.BCLI_CONFIG_DIR = originalConfigDir;
    }
    rmSync(workDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('loadFormFields returns [] when file missing', () => {
    expect(loadFormFields()).toEqual([]);
  });

  test('saveFormFields creates global config dir and writes JSON', () => {
    const fields: FormField[] = [{ name: 'X', type: 'string' }];
    saveFormFields(fields);
    expect(getFormFieldsPath()).toBe(join(configDir, 'form-fields.json'));
    expect(existsSync(getFormFieldsPath())).toBe(true);
    const parsed = JSON.parse(readFileSync(getFormFieldsPath(), 'utf-8'));
    expect(parsed).toEqual({ formFields: fields });
  });

  test('save + load roundtrip', () => {
    const fields: FormField[] = [
      { name: 'A', type: 'boolean', options: ['Y', 'N'] },
    ];
    saveFormFields(fields);
    expect(loadFormFields()).toEqual(fields);
  });

  test('saveFormFields reuses existing config dir', () => {
    saveFormFields([{ name: 'A', type: 'string' }]);
    saveFormFields([{ name: 'B', type: 'string' }]);
    expect(loadFormFields()).toEqual([{ name: 'B', type: 'string' }]);
  });

  test('loadFormFields throws on invalid content', async () => {
    saveFormFields([]);
    await Bun.write(
      getFormFieldsPath(),
      JSON.stringify({ formFields: [{ name: '' }] }),
    );
    expect(() => loadFormFields()).toThrow(/Invalid/);
  });

  test('isKnownFormField without fields arg reads from disk', () => {
    saveFormFields([{ name: 'Trusted', type: 'boolean' }]);
    expect(isKnownFormField('Trusted')).toBe(true);
    expect(isKnownFormField('Missing')).toBe(false);
  });
});
