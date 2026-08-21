import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generatedValuesFilePath,
  loadOrCreateBatchGeneratedValues,
} from './generated-values.ts';

const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), 'generated-values-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.length = 0;
});

const uuids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
] as const;

const options = (runDirectory: string, randomUUID: () => string) => ({
  runDirectory,
  batchIndex: 0,
  mappingFingerprint: 'mapping-sha',
  customerIds: [10, 20],
  columns: [{ generator: 'uuidv4' as const, slot: 'column:0' as const }],
  batchFile: join(runDirectory, 'migration-000001.csv'),
  randomUUID,
});

describe('batch generated values', () => {
  test('persists real UUIDv4 values and reuses them on retry', () => {
    const runDirectory = temporaryDirectory();
    let generated = 0;
    const first = loadOrCreateBatchGeneratedValues(
      options(runDirectory, () => uuids[generated++] as string),
    );
    expect(first?.bindingsFor(10)).toEqual({ 'column:0': uuids[0] });
    expect(first?.bindingsFor(20)).toEqual({ 'column:0': uuids[1] });

    const resumed = loadOrCreateBatchGeneratedValues(
      options(runDirectory, () => {
        throw new Error('resume must not generate another UUID');
      }),
    );
    expect(resumed?.bindingsFor(10)).toEqual({ 'column:0': uuids[0] });
    expect(generated).toBe(2);
    expect(
      JSON.parse(
        readFileSync(generatedValuesFilePath(runDirectory, 0), 'utf-8'),
      ),
    ).toMatchObject({
      version: 1,
      generator: 'node-crypto-randomUUID-v1',
      customerIds: [10, 20],
    });
  });

  test('rejects invalid generator output before publishing state', () => {
    const runDirectory = temporaryDirectory();
    expect(() =>
      loadOrCreateBatchGeneratedValues(
        options(runDirectory, () => 'not-a-uuid'),
      ),
    ).toThrow(/UUID generator returned an invalid value/);
  });

  test('does not replace a published batch if its UUID state is missing', () => {
    const runDirectory = temporaryDirectory();
    writeFileSync(join(runDirectory, 'migration-000001.csv'), 'published\n');
    expect(() =>
      loadOrCreateBatchGeneratedValues(options(runDirectory, () => uuids[0])),
    ).toThrow(/Cannot safely retry/);
  });

  test('rejects state belonging to a different roster', () => {
    const runDirectory = temporaryDirectory();
    loadOrCreateBatchGeneratedValues(options(runDirectory, () => uuids[0]));
    expect(() =>
      loadOrCreateBatchGeneratedValues({
        ...options(runDirectory, () => uuids[1]),
        customerIds: [10, 30],
      }),
    ).toThrow(/does not match this export batch/);
  });
});
