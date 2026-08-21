import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { GeneratedSlot, RowBindings } from './column-mapping.ts';

const generatedValuesSchema = z
  .object({
    version: z.literal(1),
    generator: z.literal('node-crypto-randomUUID-v1'),
    batchIndex: z.number().int().nonnegative(),
    mappingFingerprint: z.string(),
    customerIds: z.array(z.number().int().positive()),
    slots: z.array(z.string()),
    values: z.array(
      z
        .object({
          customerId: z.number().int().positive(),
          cells: z.record(z.string(), z.uuidv4()),
        })
        .strict(),
    ),
  })
  .strict();

type GeneratedValuesFile = z.infer<typeof generatedValuesSchema>;

export type GeneratedColumn = {
  generator: 'uuidv4';
  slot: GeneratedSlot;
};

export type BatchGeneratedValues = {
  bindingsFor: (customerId: number) => RowBindings;
};

export type BatchGeneratedValuesOptions = {
  runDirectory: string;
  batchIndex: number;
  mappingFingerprint: string;
  customerIds: number[];
  columns: GeneratedColumn[];
  batchFile: string;
  randomUUID: () => string;
};

export const generatedValuesFilePath = (
  runDirectory: string,
  batchIndex: number,
) =>
  join(
    runDirectory,
    '.state',
    `batch-${String(batchIndex + 1).padStart(6, '0')}.generated.json`,
  );

const saveGeneratedValues = (path: string, value: GeneratedValuesFile) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
};

const sameValues = <T>(left: readonly T[], right: readonly T[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const validateIdentity = (
  path: string,
  value: GeneratedValuesFile,
  options: BatchGeneratedValuesOptions,
) => {
  const slots = options.columns.map((column) => column.slot);
  const valueIds = value.values.map((entry) => entry.customerId);
  const cellsMatch = value.values.every((entry) => {
    const cellSlots = Object.keys(entry.cells);
    return (
      sameValues(cellSlots, slots) &&
      cellSlots.every((slot) => typeof entry.cells[slot] === 'string')
    );
  });
  if (
    value.batchIndex !== options.batchIndex ||
    value.mappingFingerprint !== options.mappingFingerprint ||
    !sameValues(value.customerIds, options.customerIds) ||
    !sameValues(value.slots, slots) ||
    !sameValues(valueIds, options.customerIds) ||
    !cellsMatch
  ) {
    throw new Error(
      `Generated-value checkpoint "${path}" does not match this export batch.`,
    );
  }
};

const parseGeneratedValues = (path: string): GeneratedValuesFile => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read generated-value checkpoint "${path}": ${message}`,
    );
  }
  const result = generatedValuesSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid generated-value checkpoint "${path}": ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
};

const toBindings = (value: GeneratedValuesFile): BatchGeneratedValues => {
  const byCustomerId = new Map(
    value.values.map((entry) => [entry.customerId, entry.cells]),
  );
  return {
    bindingsFor(customerId) {
      const bindings = byCustomerId.get(customerId);
      if (!bindings) {
        throw new Error(
          `No generated values found for BigCommerce customer ${customerId}.`,
        );
      }
      return bindings as RowBindings;
    },
  };
};

export const loadOrCreateBatchGeneratedValues = (
  options: BatchGeneratedValuesOptions,
): BatchGeneratedValues | undefined => {
  if (options.columns.length === 0) return undefined;

  const path = generatedValuesFilePath(
    options.runDirectory,
    options.batchIndex,
  );
  if (existsSync(path)) {
    const value = parseGeneratedValues(path);
    validateIdentity(path, value, options);
    return toBindings(value);
  }
  if (existsSync(options.batchFile)) {
    throw new Error(
      `Cannot safely retry "${options.batchFile}": its generated-value checkpoint is missing.`,
    );
  }

  const slots = options.columns.map((column) => column.slot);
  const value: GeneratedValuesFile = {
    version: 1,
    generator: 'node-crypto-randomUUID-v1',
    batchIndex: options.batchIndex,
    mappingFingerprint: options.mappingFingerprint,
    customerIds: options.customerIds,
    slots,
    values: options.customerIds.map((customerId) => ({
      customerId,
      cells: Object.fromEntries(
        slots.map((slot) => [slot, options.randomUUID()]),
      ),
    })),
  };
  const result = generatedValuesSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `UUID generator returned an invalid value: ${z.prettifyError(result.error)}`,
    );
  }
  saveGeneratedValues(path, result.data);
  return toBindings(result.data);
};
