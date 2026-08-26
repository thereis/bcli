import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCsvRow,
  appendCsvRows,
  mergeCsvFiles,
  obscure,
  readCsvColumnValues,
  writeCsvFileAtomic,
} from './csv.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'csv-'));
const paths: string[] = [];

afterEach(() => {
  for (const p of paths) rmSync(p, { recursive: true, force: true });
  paths.length = 0;
});

describe('obscure', () => {
  test('masks the local part and domain while keeping first 2 chars', () => {
    expect(obscure('alice@example.com')).toBe('al***@ex*********');
  });

  test('handles short emails', () => {
    expect(obscure('a@b')).toBe('a@b');
  });

  test('handles empty string', () => {
    expect(obscure('')).toBe('@');
  });
});

describe('appendCsvRow', () => {
  test('writes header then appends row', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'nested', 'out.csv');
    appendCsvRow(file, { Name: 'Alice', Age: '30' });
    appendCsvRow(file, { Name: 'Bob', Age: '25' });
    const content = readFileSync(file, 'utf-8');
    expect(content).toBe('"Name","Age"\n"Alice","30"\n"Bob","25"\n');
  });

  test('escapes quotes in values', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'q.csv');
    appendCsvRow(file, { Name: 'She said "hi"' });
    const content = readFileSync(file, 'utf-8');
    expect(content).toContain('"She said ""hi"""');
  });
});

describe('readCsvColumnValues', () => {
  test('returns set of values in a column', async () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'read.csv');
    appendCsvRow(file, { ID: '1', Email: 'a@b.c' });
    appendCsvRow(file, { ID: '2', Email: 'd@e.f' });
    appendCsvRow(file, { ID: '1', Email: 'dup@x.y' });
    const ids = await readCsvColumnValues(file, 'ID');
    expect(ids).toEqual(new Set(['1', '2']));
  });

  test('returns empty set when file missing', async () => {
    const ids = await readCsvColumnValues('/no-such/file.csv', 'ID');
    expect(ids.size).toBe(0);
  });

  test('ignores blank values', async () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'blank.csv');
    appendCsvRow(file, { ID: '1', Email: 'a@b.c' });
    appendCsvRow(file, { ID: '', Email: 'd@e.f' });
    const ids = await readCsvColumnValues(file, 'ID');
    expect(ids).toEqual(new Set(['1']));
  });
});

describe('writeCsvFileAtomic', () => {
  test('replaces a complete file and preserves header order', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'batches', 'part.csv');
    writeCsvFileAtomic(file, ['B', 'A'], [['2', '1']]);
    writeCsvFileAtomic(file, ['B', 'A'], [['4', '3']]);
    expect(readFileSync(file, 'utf-8')).toBe('"B","A"\n"4","3"\n');
  });

  test('rejects rows that do not match the header width', () => {
    const dir = tmp();
    paths.push(dir);
    expect(() =>
      writeCsvFileAtomic(join(dir, 'bad.csv'), ['A'], [['1', '2']]),
    ).toThrow(/expected 1/);
  });
});

describe('appendCsvRows and mergeCsvFiles', () => {
  test('writes the header once and appends afterwards', () => {
    const dir = tmp();
    paths.push(dir);
    const file = join(dir, 'parts', 'a.csv');
    appendCsvRows(file, ['A', 'B'], [['1', '2']]);
    appendCsvRows(file, ['A', 'B'], [['3', '4']]);
    appendCsvRows(file, ['A', 'B'], []);
    expect(readFileSync(file, 'utf-8')).toBe('"A","B"\n"1","2"\n"3","4"\n');
  });

  test('rejects rows that do not match the header width', () => {
    const dir = tmp();
    paths.push(dir);
    expect(() =>
      appendCsvRows(join(dir, 'bad.csv'), ['A'], [['1', '2']]),
    ).toThrow(/expected 1/);
  });

  test('merges parts keeping a single header', async () => {
    const dir = tmp();
    paths.push(dir);
    const one = join(dir, 'one.csv');
    const two = join(dir, 'two.csv');
    appendCsvRows(one, ['A', 'B'], [['1', 'x,y']]);
    appendCsvRows(two, ['A', 'B'], [['2', 'q"z']]);
    const out = join(dir, 'merged', 'all.csv');
    await mergeCsvFiles([one, two, join(dir, 'absent.csv')], out);
    expect(readFileSync(out, 'utf-8')).toBe('"A","B"\n"1","x,y"\n"2","q""z"\n');
  });

  test('throws when there is nothing to merge', async () => {
    const dir = tmp();
    paths.push(dir);
    await expect(
      mergeCsvFiles([join(dir, 'nope.csv')], join(dir, 'out.csv')),
    ).rejects.toThrow(/No CSV parts to merge/);
  });

  test('throws when a later part has no header line', async () => {
    const dir = tmp();
    paths.push(dir);
    const one = join(dir, 'one.csv');
    const broken = join(dir, 'broken.csv');
    appendCsvRows(one, ['A'], [['1']]);
    writeFileSync(broken, 'no-newline-anywhere');
    await expect(
      mergeCsvFiles([one, broken], join(dir, 'out.csv')),
    ).rejects.toThrow(/has no header line/);
  });

  test('merges many parts without leaking stream listeners', async () => {
    const dir = tmp();
    paths.push(dir);
    const warnings: string[] = [];
    const original = process.emitWarning;
    process.emitWarning = ((warning: string | Error) => {
      warnings.push(String(warning));
    }) as typeof process.emitWarning;

    const parts = Array.from({ length: 20 }, (_unused, index) => {
      const file = join(dir, `p-${index}.csv`);
      appendCsvRows(file, ['A'], [[String(index)]]);
      return file;
    });
    const out = join(dir, 'many.csv');
    await mergeCsvFiles(parts, out);
    process.emitWarning = original;

    expect(warnings.filter((w) => w.includes('MaxListeners'))).toEqual([]);
    expect(readFileSync(out, 'utf-8').trim().split('\n')).toHaveLength(21);
  });
});
