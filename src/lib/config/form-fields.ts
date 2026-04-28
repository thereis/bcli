import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { getConfigDir } from './paths.ts';

const formFieldsPath = () => resolve(getConfigDir(), 'form-fields.json');

export const formFieldSchema = z.object({
  name: z.string().min(1),
  type: z
    .enum(['string', 'boolean', 'number', 'date'])
    .optional()
    .describe('Expected value type (informational)'),
  options: z
    .array(z.string())
    .optional()
    .describe('Allowed values for radio/checkbox/select fields'),
});

export const formFieldsFileSchema = z.object({
  formFields: z.array(formFieldSchema).default([]),
});

export type FormField = z.infer<typeof formFieldSchema>;
export type FormFieldsFile = z.infer<typeof formFieldsFileSchema>;

export const getFormFieldsPath = () => formFieldsPath();

export const loadFormFields = (): FormField[] => {
  if (!existsSync(formFieldsPath())) return [];
  const raw = readFileSync(formFieldsPath(), 'utf-8');
  const result = formFieldsFileSchema.safeParse(JSON.parse(raw));
  if (!result.success) {
    throw new Error(`Invalid ${formFieldsPath()}: ${result.error.message}`);
  }
  return result.data.formFields;
};

export const saveFormFields = (fields: FormField[]) => {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const content = JSON.stringify({ formFields: fields }, null, 2);
  writeFileSync(formFieldsPath(), `${content}\n`);
};

export const isKnownFormField = (name: string, fields?: FormField[]) => {
  const list = fields ?? loadFormFields();
  return list.some((f) => f.name === name);
};
